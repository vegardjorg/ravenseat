// =============================================================
// redteam/rt24-cold-restart.test.ts: RT-24 "the orchestrator dies cold in the middle, and a new one finishes the work
// from what is on disk" (map rows 3 and 10).
//
// Why: rt07 kills a merge and rt21 fakes a crashed write, but the orchestrator itself had always ended cleanly. Here it
// does not: no handover note, no clean shutdown, its background `ravenseat wait` and the agent it started are killed
// without warning (taskkill /F, SIGKILL: no handler runs). A NEW orchestrator then has only the disk: queue.json, the
// worktrees and branches, the attempt record and the time log, the track folders, and the locks of dead processes. It
// must bring the task to done exactly once, with the user's things and the dead agent's work intact.
//
// What the real CLI offers for this, and what the scenarios use (nothing else):
//   - `ravenseat takeover` (queue-takeover.mjs): the picture a new session starts from.
//   - The attempt record: an agent with a start row and no stop row stays `running`, so `resume` and `fill` refuse a
//     second agent until `ravenseat attempt close <id> --outcome interrupted`.
//   - `ravenseat resume <id> --reason context`: the mission for a new agent on the same branch (prepare-track --continue).
//   - `ravenseat deliveries`: a report that was never received, found without the agent's notification.
//   - `receive` and `merge`, and the locks they and the loop leave: the queue lock, the gate evidence lock, wait.lock.
// Only the agents are fake (scripts that commit and write their RESULT line); git, the CLI, prepare-track and the time
// hook (hook-time.mjs, fed the payload Claude Code sends) are the real ones.
// =============================================================
import { describe, it, expect } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expectUserThingsIntact, snapshot, userMess } from './lab';
import { project, SCRIPTS, task, tmp } from './project';

type P = ReturnType<typeof project>;
/** The text with LF line ends: a checkout with core.autocrlf=true writes CRLF. */
const lf = (s: string) => s.replace(/\r\n/g, '\n');
type Run = { code: number | null; out: string; ms: number };
type Attempt = { id: string; state: string; outcome?: string; round: number; session_id?: string };

/** Kills a process and everything it started, without warning: no signal handler and no exit handler runs. */
function killTree(pid: number) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
  else process.kill(-pid, 'SIGKILL');
}

async function waitFor(file: string, ms = 60_000) {
  const until = Date.now() + ms;
  while (!fs.existsSync(file)) {
    if (Date.now() > until) throw new Error(`waited ${ms} ms for ${file}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** A process of its own (its own group on POSIX, so killTree reaches what it starts). */
function background(p: P, args: string[], cwd = p.repo, env = p.env) {
  const child = spawn(process.execPath, args, { cwd, env, detached: process.platform !== 'win32', stdio: 'ignore' });
  const exited = new Promise((r) => child.on('exit', r));
  return { pid: child.pid!, exited };
}

/** A CLI run with its own time limit, so a lock that is never released fails the test on the time, not on vitest's. */
function runWithin(p: P, ms: number, ...args: string[]): Run {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'queue.mjs'), ...args], { encoding: 'utf8', env: p.env, cwd: p.repo, timeout: ms });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, ms: Date.now() - t0 };
}

/**
 * The project the orchestrator works on, with the user's mess, a scratchpad and a transcript folder. The time log and the
 * transcripts are what the attempt record is derived from.
 */
function lab(opts: Parameters<typeof project>[0] = {}) {
  const p = project(opts);
  userMess(p.repo);
  const scratch = path.join(p.folder, 'scratch');
  const transcripts = path.join(p.folder, 'transcripts');
  p.env.QUEUE_TRANSCRIPTS = transcripts;
  /** The time hook as Claude Code runs it at SubagentStart and SubagentStop, with a transcript that names the prompt. */
  const hook = (event: 'SubagentStart' | 'SubagentStop', agent: string, trackId: string) => {
    const dir = path.join(transcripts, 'session', 'subagents');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `agent-${agent}.jsonl`);
    if (!fs.existsSync(file))
      fs.writeFileSync(
        file,
        JSON.stringify({
          type: 'user',
          timestamp: new Date().toISOString(),
          message: { role: 'user', content: `Read ${path.join(scratch, `prompt-${trackId}.md`)} and follow it.` },
        }) + '\n',
      );
    const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'hook-time.mjs')], {
      input: JSON.stringify({ hook_event_name: event, agent_id: agent, agent_type: 'ravenseat:track', agent_transcript_path: file }),
      encoding: 'utf8',
      env: p.env,
      cwd: p.repo,
    });
    expect(r.status, r.stderr).toBe(0);
  };
  /** What the Agent tool and the mission's first step do: a worktree under .claude/worktrees, then prepare-track. */
  const agentWorktree = (name: string, trackId: string, extra: string[] = []) => {
    const wt = path.join(p.repo, '.claude', 'worktrees', name);
    p.g(['worktree', 'add', '-q', '--detach', wt, 'main']);
    const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'prepare-track.mjs'), trackId, '--scratchpad', scratch, ...extra], {
      cwd: wt,
      env: p.env,
      encoding: 'utf8',
    });
    expect(r.stdout, r.stderr).toMatch(new RegExp(`^READY ${trackId}:`, 'm'));
    return wt;
  };
  const report = (trackId: string, id = 'A') => {
    fs.mkdirSync(path.join(scratch, trackId), { recursive: true });
    fs.writeFileSync(
      path.join(scratch, trackId, 'track-result.md'),
      `RESULT status=DONE branch=queue/${id} commits=1 migr=- gates=OK probe=- ownerQuestions=0 edge=-\n`,
    );
  };
  /** The attempts as the CLI derives them from the time log (attempt list), not as queue.json last stored them. */
  const attempts = (id = 'A') => {
    const r = p.run('attempt', 'list', id, '--json');
    expect(r.code, r.out).toBe(0);
    return JSON.parse(r.out).attempts as Attempt[];
  };
  const merges = (id = 'A') => p.g(['log', '--merges', '--format=%s', 'main']).split('\n').filter((s) => s.includes(`queue/${id}`));
  return { ...p, scratch, hook, agentWorktree, report, attempts, merges };
}

/** A fake agent: runs `body` (plain JS, cwd = its worktree), writes a marker, then works on for ever until it is killed. */
function agentScript(body: string) {
  const dir = tmp('rt24-agent-');
  const marker = path.join(dir, 'working');
  const file = path.join(dir, 'agent.cjs');
  fs.writeFileSync(
    file,
    `const { execFileSync } = require('child_process'); const fs = require('fs');\n` +
      `const git = (...a) => execFileSync('git', a, { stdio: 'ignore' });\n` +
      `${body}\nfs.writeFileSync(${JSON.stringify(marker)}, 'x');\nsetInterval(() => {}, 1000);\n`,
  );
  return { file, marker };
}

describe('RT-24: the orchestrator dies cold in the middle, and a new one finishes the work from the disk', () => {
  it('agent killed mid-work with the orchestrator: the new one closes the attempt, continues the branch, and merges once', async () => {
    const p = lab();
    const before = snapshot(p.repo, p.folder);

    // ---- The first orchestrator: fills A, waits for the owner in the background, and its agent starts working. ----
    const fill = p.run('fill', '--ids', 'A', '--scratchpad', p.scratch);
    expect(fill.code, fill.out).toBe(0);
    const waiter = background(p, [path.join(SCRIPTS, 'queue.mjs'), 'wait', '--check-min', '0']);
    await waitFor(path.join(p.folder, 'wait.lock'));
    const wt1 = p.agentWorktree('agent-A', 'A');
    p.hook('SubagentStart', 'dead1', 'A');
    const work = agentScript(
      `fs.mkdirSync('lib', { recursive: true });\n` +
        `fs.writeFileSync('lib/A.ts', 'part 1\\n'); git('add', '--', 'lib/A.ts'); git('commit', '-q', '-m', 'wip: A part 1');\n` +
        `fs.appendFileSync('lib/A.ts', 'part 2, never committed\\n');\n` +
        `fs.writeFileSync('lib/A.helper.ts', 'a new file, never added\\n');`,
    );
    const agent = background(p, [work.file], wt1);
    await waitFor(work.marker);

    // ---- Cold death: the agent and the orchestrator's waiter are killed. No handover note, no stop row, no RESULT. ----
    killTree(agent.pid);
    killTree(waiter.pid);
    await Promise.all([agent.exited, waiter.exited]);
    expect(JSON.parse(fs.readFileSync(path.join(p.folder, 'wait.lock'), 'utf8')).pid).toBe(waiter.pid);
    const deadWork = { 'lib/A.ts': fs.readFileSync(path.join(wt1, 'lib/A.ts'), 'utf8'), 'lib/A.helper.ts': fs.readFileSync(path.join(wt1, 'lib/A.helper.ts'), 'utf8') };

    // ---- A new orchestrator, with only the disk. ----
    // The picture it starts from: A running, one commit on its branch, two uncommitted changes in the old worktree, no
    // delivery and no handover note.
    const take = spawnSync(process.execPath, [path.join(SCRIPTS, 'queue-takeover.mjs'), '--json'], { cwd: p.repo, env: p.env, encoding: 'utf8' });
    const picture = JSON.parse(take.stdout);
    expect(picture.handoverNote).toBeNull();
    expect(picture.activeOnes).toMatchObject([{ id: 'A', status: 'running', commits: 1, uncommitted: 2, report: null }]);
    expect(picture.activeOnes[0].assessment).not.toMatch(/DELIVERED/);
    // The dead orchestrator's waiter is not taken for a live one: the new waiter takes its lock over (not ALREADY WAITING).
    const wait = runWithin(p, 60_000, 'wait', '--check-min', '0', '--timeout', '0.0005');
    expect(wait.out).not.toMatch(/ALREADY WAITING/);
    expect(wait.code, wait.out).toBe(10);
    expect(fs.existsSync(path.join(p.folder, 'wait.lock'))).toBe(false);

    // SAFETY: the dead agent's attempt is still running on record, so no second agent is started on its branch, by any
    // path, until someone says it is gone. Neither refusal writes a new attempt.
    expect(p.attempts().map((x) => [x.id, x.state])).toEqual([['a1', 'running']]);
    const resumeEarly = p.run('resume', 'A', '--reason', 'context', '--scratchpad', p.scratch);
    expect(resumeEarly.code).not.toBe(0);
    expect(resumeEarly.out).toMatch(/A: attempt a1 is running \(agent dead1\), so a new one cannot start\. If that agent is gone: ravenseat attempt close A --outcome interrupted/);
    const fillEarly = p.run('fill', '--ids', 'A', '--scratchpad', p.scratch);
    expect(fillEarly.code).not.toBe(0);
    expect(fillEarly.out).toMatch(/attempt a1 is running/);
    expect(p.attempts().map((x) => x.id)).toEqual(['a1']);
    expect(fs.existsSync(path.join(p.scratch, 'prompt-A-r1.md'))).toBe(false);

    // The documented way on: close the attempt, then a continuation on the same branch.
    expect(p.run('attempt', 'close', 'A', '--outcome', 'interrupted').code).toBe(0);
    const resume = p.run('resume', 'A', '--reason', 'context', '--scratchpad', p.scratch);
    expect(resume.code, resume.out).toBe(0);
    expect(resume.out).toMatch(/RESUME A-r1 \(context\)/);
    expect(resume.out).toMatch(/NOTE: queue\/A is checked out in .*agent-A\. If the old agent is done: git -C ".*agent-A" switch --detach/);
    // SAFETY (finding 12): the work the dead agent never committed is named, with how to keep it. Before the fix the new
    // agent started without it and nothing said it was there.
    expect(resume.out).toMatch(/WARNING: .*agent-A has 2 uncommitted change\(s\) the old agent left; the new agent will not see them/);
    // Nothing was touched by resume: the dead agent's files are as it left them.
    for (const [f, text] of Object.entries(deadWork)) expect(fs.readFileSync(path.join(wt1, f), 'utf8')).toBe(text);

    // The orchestrator does what the lines say: keeps the work on the branch, frees the branch.
    p.g(['add', '-A'], wt1);
    p.g(['commit', '-q', '-m', 'wip: A (interrupted agent)'], wt1);
    p.g(['switch', '-q', '--detach'], wt1);

    // The new agent continues the branch in a worktree of its own, and delivers.
    const wt2 = p.agentWorktree('agent-A-r1', 'A-r1', ['--branch', 'queue/A', '--continue']);
    p.hook('SubagentStart', 'live2', 'A-r1');
    expect(lf(fs.readFileSync(path.join(wt2, 'lib/A.ts'), 'utf8'))).toBe(deadWork['lib/A.ts']);
    fs.appendFileSync(path.join(wt2, 'lib/A.ts'), 'part 3, by the new agent\n');
    p.g(['add', '--', 'lib/A.ts'], wt2);
    p.g(['commit', '-q', '-m', 'feat: A done'], wt2);
    p.report('A-r1');
    p.hook('SubagentStop', 'live2', 'A-r1');
    expect(p.attempts().map((x) => [x.id, x.state, x.outcome])).toEqual([
      ['a1', 'ended', 'interrupted'],
      ['a2', 'ended', 'stopped'],
    ]);

    const recv = p.run('receive', 'A', '--scratchpad', p.scratch);
    expect(recv.code, recv.out).toBe(0);
    expect(p.taskOf('A')?.status).toBe('review');
    const merge = p.run('merge', 'A', '--scratchpad', p.scratch);
    expect(merge.code, merge.out).toBe(0);
    expect(p.taskOf('A')?.status).toBe('done');
    // A merge started again (a second session, or the orchestrator not sure it ran) merges nothing.
    const again = p.run('merge', 'A', '--scratchpad', p.scratch);
    expect(again.code).not.toBe(0);
    expect(again.out).toMatch(/A has status done/);

    // Done once, merged once, and every line of work is in main: the dead agent's commit, its uncommitted work, the new one.
    expect(p.merges()).toHaveLength(1);
    expect(p.g(['show', 'main:lib/A.ts'])).toBe('part 1\npart 2, never committed\npart 3, by the new agent');
    expect(p.g(['show', 'main:lib/A.helper.ts'])).toBe('a new file, never added');
    expectUserThingsIntact(before, {
      untracked: ['.claude/'],
      branches: ['queue/A', 'queue/B'],
      done: ['A'],
      files: ['lib/A.ts', 'lib/A.helper.ts'],
    });
  }, 300_000);

  it('the orchestrator dies in the middle of receive, after the agent delivered: a new one receives and merges once', async () => {
    // A gate that holds while the hold file exists, so receive can be killed in the middle of it.
    const dir = tmp('rt24-gate-');
    const hold = path.join(dir, 'hold');
    const started = path.join(dir, 'started');
    const gate = path.join(dir, 'gate.cjs');
    fs.writeFileSync(
      gate,
      `const fs = require('fs');\nif (fs.existsSync(${JSON.stringify(hold)})) { fs.writeFileSync(${JSON.stringify(started)}, 'x'); setInterval(() => {}, 1000); }\n`,
    );
    const p = lab({ gates: [`node "${gate}"`] });
    const before = snapshot(p.repo, p.folder);

    // The agent runs and delivers; its stop row is written, so the attempt has ended.
    expect(p.run('fill', '--ids', 'A', '--scratchpad', p.scratch).code).toBe(0);
    const wt = p.agentWorktree('agent-A', 'A');
    p.hook('SubagentStart', 'agent1', 'A');
    fs.mkdirSync(path.join(wt, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(wt, 'lib/A.ts'), 'from the track\n');
    p.g(['add', '--', 'lib/A.ts'], wt);
    p.g(['commit', '-q', '-m', 'feat: A'], wt);
    p.report('A');
    p.hook('SubagentStop', 'agent1', 'A');

    // The orchestrator starts receive, and dies with it in the middle of the gate (receive is its own process tree here,
    // as when the session's Bash call is killed with it).
    fs.writeFileSync(hold, 'x');
    const recv1 = background(p, [path.join(SCRIPTS, 'queue.mjs'), 'receive', 'A', '--scratchpad', p.scratch]);
    await waitFor(started);
    killTree(recv1.pid);
    await recv1.exited;
    fs.rmSync(hold);
    // What it leaves: the task not received, and the gate evidence lock held by a process that is gone.
    expect(p.taskOf('A')?.status).toBe('running');
    const lockDirs = fs.readdirSync(p.folder).filter((n) => n.endsWith('.lock') && fs.statSync(path.join(p.folder, n)).isDirectory());
    expect(lockDirs.length, fs.readdirSync(p.folder).join(', ')).toBe(1);
    const holder = JSON.parse(fs.readFileSync(path.join(p.folder, lockDirs[0], 'slot-0', 'holder.json'), 'utf8'));
    expect(() => process.kill(holder.pid, 0)).toThrow();

    // ---- A new orchestrator. It finds the delivery without the agent's notification. ----
    const deliveries = p.run('deliveries', '--json');
    expect(deliveries.code, deliveries.out).toBe(0);
    expect(JSON.parse(deliveries.out).map((x: { id: string }) => x.id)).toEqual(['A']);
    // SAFETY: the dead receive's evidence lock does not hold the new one (it would wait for ever: no time budget applies
    // to the wait for the lock).
    const recv2 = runWithin(p, 60_000, 'receive', 'A', '--scratchpad', p.scratch);
    expect(recv2.code, recv2.out).toBe(0);
    expect(recv2.out).not.toMatch(/EVIDENCE: another gate run/);
    expect(p.taskOf('A')?.status).toBe('review');
    expect(JSON.parse(p.run('deliveries', '--json').out)).toEqual([]);

    // And that orchestrator dies too, between receive and merge (nothing runs then, so nothing to kill). The next one merges.
    const merge = p.run('merge', 'A', '--scratchpad', p.scratch);
    expect(merge.code, merge.out).toBe(0);
    expect(p.taskOf('A')?.status).toBe('done');
    expect(p.run('merge', 'A', '--scratchpad', p.scratch).out).toMatch(/A has status done/);
    expect(p.merges()).toHaveLength(1);
    expectUserThingsIntact(before, { untracked: ['.claude/'], branches: ['queue/A', 'queue/B'], done: ['A'], files: ['lib/A.ts'] });
  }, 300_000);

  it('locks: one left by a dead process never blocks the new orchestrator, one held by a live process always does', async () => {
    const p = lab({ tasks: [task('A'), task('B'), task('C')] });
    // Only shortens the wait for the queue lock (lib/queueLock.js waitMsFrom), so a refusal comes in seconds.
    p.env.QUEUE_LOCK_WAIT_MS = '1500';
    const before = snapshot(p.repo, p.folder);
    const queueFile = path.join(p.folder, 'queue.json');

    /** A process that takes the queue lock with the lock module every CLI command uses, and keeps it until killed. */
    const holder = () => {
      const d = tmp('rt24-holder-');
      const marker = path.join(d, 'holding');
      const file = path.join(d, 'hold.cjs');
      fs.writeFileSync(
        file,
        `const QL = require(${JSON.stringify(path.join(SCRIPTS, 'lib', 'queueLock.js'))});\n` +
          `QL.acquire(${JSON.stringify(path.join(p.folder, '.lockState'))});\n` +
          `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x');\nsetInterval(() => {}, 1000);\n`,
      );
      return { proc: background(p, [file]), marker };
    };

    // The queue lock of a process that died holding it (the orchestrator's command killed in the middle of a write).
    const dead = holder();
    await waitFor(dead.marker);
    killTree(dead.proc.pid);
    await dead.proc.exited;
    expect(fs.readdirSync(path.join(p.folder, '.lockState'))).toEqual(['owner-1.json']);
    const start = runWithin(p, 60_000, 'start', 'A');
    expect(start.code, start.out).toBe(0);
    expect(p.taskOf('A')?.status).toBe('running');
    expect(fs.existsSync(path.join(p.folder, '.lockState'))).toBe(false);

    // The queue lock of a live process (an old session that is still running): refused, with who holds it, and nothing
    // written. The new orchestrator does not decide that the old one is dead.
    const live = holder();
    await waitFor(live.marker);
    const was = fs.readFileSync(queueFile, 'utf8');
    const refused = runWithin(p, 60_000, 'start', 'B');
    expect(refused.code).not.toBe(0);
    expect(refused.out).toMatch(new RegExp(`pid ${live.proc.pid}`));
    expect(refused.out).toMatch(/ravenseat unlock/);
    expect(fs.readFileSync(queueFile, 'utf8')).toBe(was);
    // Once that process is gone, its lock is taken over like any dead one.
    killTree(live.proc.pid);
    await live.proc.exited;
    const after = runWithin(p, 60_000, 'start', 'B');
    expect(after.code, after.out).toBe(0);

    // The waiter: a live one is never replaced (the second says ALREADY WAITING with its pid); a dead one's lock is taken.
    const w1 = background(p, [path.join(SCRIPTS, 'queue.mjs'), 'wait', '--check-min', '0']);
    await waitFor(path.join(p.folder, 'wait.lock'));
    const second = runWithin(p, 60_000, 'wait', '--check-min', '0', '--timeout', '0.0005');
    expect(second.code).toBe(0);
    expect(second.out).toMatch(new RegExp(`ALREADY WAITING \\(pid ${w1.pid}\\)`));
    killTree(w1.pid);
    await w1.exited;
    const third = runWithin(p, 60_000, 'wait', '--check-min', '0', '--timeout', '0.0005');
    expect(third.out).not.toMatch(/ALREADY WAITING/);
    expect(third.code, third.out).toBe(10);

    expect(p.taskOf('C')?.status).toBe('waiting');
    expectUserThingsIntact(before, { untracked: ['.claude/'] });
  }, 300_000);
});
