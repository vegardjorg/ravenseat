// =============================================================
// queueAttempt.test.ts: the attempt model through real queue.mjs and hook-time.mjs processes, against a temporary repo
// and a temporary queue (QUEUE_FOLDER, QUEUE_GIT). The pure rules are in lib/__tests__/attempt.test.ts.
//
// Locks: start, fill and resume reserve an attempt under the lock and print nothing new; two concurrent starts give
// one attempt; the hook row turns reserved into running without the hook touching queue.json; running blocks until
// closed, a reservation never does; receive records sha, outcome and evidence; agents cannot edit attempts; an old
// queue.json reads as before and a queue.json with attempts reads everywhere.
// =============================================================
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type Attempt = Record<string, unknown> & { id: string; state: string; round: number };
type Task = Record<string, unknown> & { id: string; status: string; attempts?: Attempt[] };
type Run = { code: number | null; out: string; error: string };

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPTS = path.join(ROOT, 'scripts', 'orchestrator');
const ID = ['-c', 'user.name=queue-test', '-c', 'user.email=queue-test@example.invalid', '-c', 'core.autocrlf=false'];
const temporary: string[] = [];
afterAll(() => {
  for (const m of temporary) {
    try {
      fs.rmSync(m, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    } catch {
      /* left for the OS */
    }
  }
  // Many real repos to remove, and Windows is slow at it under load.
}, 120_000);

const task = (id: string, over: Record<string, unknown> = {}): Task => ({
  id,
  title: `Task ${id}`,
  domain: `domain-${id}`,
  class: 'K',
  status: 'waiting',
  mission: `Mission text for ${id}.`,
  value: 5,
  owned_files: [`src/${id}.ts`],
  ...over,
});

function project(tasks: Task[], config: Record<string, unknown> = {}) {
  const folder = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'queue-at-')));
  temporary.push(folder);
  const repo = path.join(folder, 'repo');
  const scratch = path.join(folder, 'scratch');
  fs.mkdirSync(repo);
  const g = (args: string[], cwd = repo) =>
    execFileSync('git', ['-C', cwd, ...ID, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  g(['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(repo, 'README.md'), 'start\n');
  g(['add', '--', 'README.md']);
  g(['commit', '-q', '-m', 'start']);
  const file = path.join(folder, 'queue.json');
  fs.writeFileSync(
    file,
    JSON.stringify({ tasks, limits: { maxConcurrent: 5, maxDPlus: 1, maxPerDomain: 7, maxDb: 6 }, next_migr: 100, resolved: [] }),
  );
  const configFile = path.join(folder, 'queue.config.json');
  fs.writeFileSync(configFile, JSON.stringify({ baseBranch: 'main', ...config }));
  fs.mkdirSync(path.join(folder, 'docs'));
  fs.copyFileSync(path.join(ROOT, 'docs', 'mission-template.md'), path.join(folder, 'docs', 'mission-template.md'));
  const timeLog = path.join(folder, 'times.jsonl');
  const transcripts = path.join(folder, 'transcripts');
  const env = {
    ...process.env,
    QUEUE_FOLDER: folder,
    QUEUE_CONFIG: configFile,
    QUEUE_ROOT: folder,
    QUEUE_GIT: repo,
    QUEUE_TIME_LOG: timeLog,
    QUEUE_TRANSCRIPTS: transcripts,
    QUEUE_SCRATCHPAD: scratch,
    QUEUE_LOAD: 'free=100',
  } as NodeJS.ProcessEnv;
  delete env.QUEUE_SESSION;
  const queueArgs = (args: string[]) => [path.join(SCRIPTS, 'queue.mjs'), ...args];
  const run = (args: string[], cwd = folder): Run => {
    const r = spawnSync(process.execPath, queueArgs(args), { encoding: 'utf8', env, cwd });
    return { code: r.status, out: r.stdout ?? '', error: r.stderr ?? '' };
  };
  /** Several queue.mjs processes at the same time (real concurrency, not one after the other). */
  const concurrent = (list: string[][]) =>
    Promise.all(
      list.map(
        (args) =>
          new Promise<Run>((resolve) => {
            const c = spawn(process.execPath, queueArgs(args), { env, cwd: folder });
            let out = '';
            let error = '';
            c.stdout.on('data', (d) => (out += d));
            c.stderr.on('data', (d) => (error += d));
            c.on('close', (code) => resolve({ code, out, error }));
          }),
      ),
    );
  /** The real SubagentStart/SubagentStop hook with a hook payload on stdin. */
  const hook = (event: 'SubagentStart' | 'SubagentStop', payload: Record<string, unknown>) =>
    spawnSync(process.execPath, [path.join(SCRIPTS, 'hook-time.mjs')], {
      input: JSON.stringify({ hook_event_name: event, ...payload }),
      encoding: 'utf8',
      env,
      cwd: folder,
    });
  /** A transcript whose first message is the agent message for a prompt file (what hook-time reads the label from). */
  const transcript = (agent: string, trackId: string, at = 'fixed') => {
    const dir = at === 'fixed' ? path.join(transcripts, 'session', 'subagents') : at;
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, `agent-${agent}.jsonl`);
    const text = `Read ${path.join(scratch, `prompt-${trackId}.md`)} and follow it.`;
    fs.writeFileSync(
      p,
      JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: text } }) + '\n',
    );
    return p;
  };
  const queue = () => JSON.parse(fs.readFileSync(file, 'utf8')) as { tasks: Task[]; changed?: string };
  const find = (id: string) => queue().tasks.find((x) => x.id === id) as Task;
  /** Edits queue.json directly (a test's way of aging a reservation). */
  const patch = (id: string, fn: (o: Task) => void) => {
    const q = queue();
    fn(q.tasks.find((x) => x.id === id) as Task);
    fs.writeFileSync(file, JSON.stringify(q));
  };
  /** A branch for the task, one commit ahead of main (what a track leaves). */
  const branch = (id: string) => {
    g(['branch', `queue/${id}`]);
    g(['checkout', '-q', `queue/${id}`]);
    fs.writeFileSync(path.join(repo, `${id}.txt`), 'work\n');
    g(['add', '--', `${id}.txt`]);
    g(['commit', '-q', '-m', `work on ${id}`]);
    g(['checkout', '-q', 'main']);
    return g(['rev-parse', `queue/${id}`]);
  };
  /** A worktree with the task's branch checked out (where receive runs the gates). */
  const worktree = (id: string) => {
    const wt = path.join(folder, `wt-${id}`);
    g(['worktree', 'add', '-q', wt, `queue/${id}`]);
    return wt;
  };
  const report = (dir: string, text: string) => {
    fs.mkdirSync(path.join(scratch, dir), { recursive: true });
    fs.writeFileSync(path.join(scratch, dir, 'track-result.md'), `${text}\n`);
  };
  return { folder, repo, scratch, file, timeLog, env, run, concurrent, hook, transcript, queue, find, patch, branch, worktree, report, g };
}

const RESULT = (id: string, status = 'DONE') => `RESULT status=${status} branch=queue/${id} commits=1 migr=- gates=OK probe=- ownerQuestions=0 edge=-`;
const startPayload = (agent: string, transcriptPath: string | null) => ({
  agent_id: agent,
  agent_type: 'cq:track',
  ...(transcriptPath ? { agent_transcript_path: transcriptPath } : {}),
});

describe('reservation', () => {
  it('start reserves one attempt, with the base sha and the guard, and prints no attempt id', () => {
    const p = project([task('A')]);
    const r = p.run(['start', 'A']);
    expect(r.code, r.error).toBe(0);
    expect(r.out).not.toMatch(/attempt|\ba1\b/i);
    const [x, ...rest] = p.find('A').attempts as Attempt[];
    expect(rest).toEqual([]);
    expect(x).toMatchObject({
      id: 'a1',
      client: 'claude',
      role: 'track',
      round: 0,
      state: 'reserved',
      base_sha: p.g(['rev-parse', 'main']),
      guard: { sandbox: false, network: 'hook', hooks: true },
      artifacts: { report: null, handover: null },
    });
    expect(Number.isNaN(Date.parse(String(x.reserved)))).toBe(false);
  });

  it('fill reserves too, and keeps the attempt out of queue-fill.json and stdout', () => {
    const p = project([task('A'), task('B')]);
    const r = p.run(['fill']);
    expect(r.code, r.error).toBe(0);
    expect(r.out).not.toMatch(/attempt/i);
    expect(p.find('A').attempts?.map((x) => x.id)).toEqual(['a1']);
    expect(p.find('B').attempts?.map((x) => x.id)).toEqual(['a1']);
    expect(fs.readFileSync(path.join(p.scratch, 'queue-fill.json'), 'utf8')).not.toMatch(/attempt/i);
    expect(fs.readFileSync(path.join(p.scratch, 'prompt-A.md'), 'utf8')).not.toMatch(/attempt_id/);
  });

  it('fill --ids on a running task keeps a fresh reservation (new prompt files, no new attempt)', () => {
    const p = project([task('A')]);
    p.run(['fill']);
    const r = p.run(['fill', '--ids', 'A']);
    expect(r.code, r.error).toBe(0);
    expect(p.find('A').attempts?.map((x) => x.id)).toEqual(['a1']);
  });

  it('resume reserves an attempt for the round', () => {
    const p = project([task('A')]);
    p.run(['start', 'A']);
    p.branch('A');
    p.report('A', RESULT('A'));
    expect(p.run(['receive', 'A']).code).toBe(0);
    const r = p.run(['resume', 'A', '--reason', 'fix']);
    expect(r.code, r.error).toBe(0);
    expect(r.out).not.toMatch(/attempt/i);
    expect(p.find('A').attempts?.map((x) => [x.id, x.state, x.round])).toEqual([
      ['a1', 'ended', 0],
      ['a2', 'reserved', 1],
    ]);
  });

  it('two concurrent starts of a task give one attempt (real processes)', async () => {
    const p = project([task('A')]);
    const runs = await p.concurrent([
      ['start', 'A'],
      ['start', 'A'],
      ['start', 'A'],
      ['start', 'A'],
    ]);
    // One wins the lock; for the rest the task is running already, so the existing status check refuses them.
    expect(runs.filter((r) => r.code === 0)).toHaveLength(1);
    for (const r of runs.filter((x) => x.code !== 0)) expect(r.error).toMatch(/status running/);
    expect(p.find('A').attempts?.map((x) => x.id)).toEqual(['a1']);
    expect(fs.readdirSync(p.folder)).not.toContain('.lockState');
  });

  it('two concurrent fills of a task share one attempt (real processes)', async () => {
    const p = project([task('A')]);
    const runs = await p.concurrent([
      ['fill', '--ids', 'A'],
      ['fill', '--ids', 'A'],
    ]);
    for (const r of runs) expect(r.code, r.error).toBe(0);
    expect(p.find('A').attempts?.map((x) => x.id)).toEqual(['a1']);
    expect(fs.readdirSync(p.folder)).not.toContain('.lockState');
  });

  it('two concurrent resumes of the same round give one new attempt (real processes)', async () => {
    const p = project([task('A')]);
    p.run(['start', 'A']);
    p.branch('A');
    const runs = await p.concurrent([
      ['resume', 'A', '--reason', 'context', '--round', '1'],
      ['resume', 'A', '--reason', 'context', '--round', '1'],
    ]);
    for (const r of runs) expect(r.code, r.error).toBe(0);
    expect(p.find('A').attempts?.map((x) => [x.id, x.state, x.outcome ?? null])).toEqual([
      ['a1', 'ended', 'superseded'],
      ['a2', 'reserved', null],
    ]);
  });
});

describe('a reservation does not block', () => {
  it('after the TTL it reads as expired, and the next start takes a new attempt', () => {
    const p = project([task('A')], { attempts: { reservationTtlMin: 5 } });
    p.run(['fill']);
    p.patch('A', (o) => {
      o.attempts![0].reserved = new Date(Date.now() - 6 * 60_000).toISOString();
    });
    const list = p.run(['attempt', 'list', 'A']);
    expect(list.code, list.error).toBe(0);
    expect(list.out).toMatch(/a1\s+expired/);
    // The stored state stays `reserved`: expiry is a reading.
    expect(p.find('A').attempts![0].state).toBe('reserved');
    const r = p.run(['fill', '--ids', 'A']);
    expect(r.code, r.error).toBe(0);
    expect(p.find('A').attempts?.map((x) => [x.id, x.state, x.outcome ?? null])).toEqual([
      ['a1', 'ended', 'expired'],
      ['a2', 'reserved', null],
    ]);
  });

  it('nor before the TTL: resume supersedes it', () => {
    const p = project([task('A')]);
    p.run(['start', 'A']);
    p.branch('A');
    const r = p.run(['resume', 'A', '--reason', 'context']);
    expect(r.code, r.error).toBe(0);
    expect(p.find('A').attempts?.map((x) => x.state)).toEqual(['ended', 'reserved']);
  });
});

describe('running, from the hook row', () => {
  it('the hook row turns reserved into running when the queue next reads it, and the hook leaves queue.json alone', () => {
    const p = project([task('A')]);
    p.run(['start', 'A']);
    const before = fs.readFileSync(p.file, 'utf8');
    const statBefore = fs.statSync(p.file).mtimeMs;
    const h = p.hook('SubagentStart', startPayload('agent1', p.transcript('agent1', 'A')));
    expect(h.status).toBe(0);
    expect(fs.readFileSync(p.file, 'utf8')).toBe(before);
    expect(fs.statSync(p.file).mtimeMs).toBe(statBefore);
    const list = p.run(['attempt', 'list', 'A']);
    expect(list.code, list.error).toBe(0);
    expect(list.out).toMatch(/a1\s+running/);
    expect(p.find('A').attempts![0]).toMatchObject({ state: 'running', session_id: 'agent1' });
    expect(p.find('A').attempts![0].started).toBeTruthy();
  });

  it('the hook does not wait for the queue lock either', () => {
    const p = project([task('A')]);
    p.run(['start', 'A']);
    const lock = path.join(p.folder, '.lockState');
    fs.mkdirSync(lock); // somebody holds the lock
    const before = fs.readFileSync(p.file, 'utf8');
    const t0 = Date.now();
    const h = p.hook('SubagentStart', startPayload('agent1', p.transcript('agent1', 'A')));
    expect(h.status).toBe(0);
    expect(Date.now() - t0).toBeLessThan(10_000); // withLock would have waited 15 s
    expect(fs.readFileSync(p.file, 'utf8')).toBe(before);
    expect(fs.readFileSync(p.timeLog, 'utf8')).toContain('"track":"A"');
    fs.rmdirSync(lock);
  });

  it('a start row without a label gets it from the transcript the agent has written since', () => {
    const p = project([task('A')]);
    p.run(['start', 'A']);
    // The hook fired before the transcript existed: the row's label is the agent id.
    p.hook('SubagentStart', startPayload('agent1', null));
    const row = fs.readFileSync(p.timeLog, 'utf8').split('\n').filter(Boolean).map((x) => JSON.parse(x)).find((x) => x.agent_id === 'agent1');
    expect(row.track).not.toBe('A');
    expect(p.run(['attempt', 'list', 'A']).out).toMatch(/a1\s+expired|a1\s+reserved/);
    p.transcript('agent1', 'A');
    expect(p.run(['attempt', 'list', 'A']).out).toMatch(/a1\s+running/);
  });

  it('a reviewer with the task as its label does not count', () => {
    const p = project([task('A')]);
    p.run(['start', 'A']);
    const t = p.transcript('rev1', 'A');
    p.hook('SubagentStart', { agent_id: 'rev1', agent_type: 'cq:reviewer', agent_transcript_path: t });
    expect(p.run(['attempt', 'list', 'A']).out).toMatch(/a1\s+reserved/);
  });

  it('running blocks a new attempt until it is closed, without writing any round files', () => {
    const p = project([task('A')]);
    p.run(['start', 'A']);
    p.branch('A');
    p.hook('SubagentStart', startPayload('agent1', p.transcript('agent1', 'A')));
    const blocked = p.run(['resume', 'A', '--reason', 'context']);
    expect(blocked.code).toBe(1);
    expect(blocked.error).toMatch(/a1 is running/);
    expect(blocked.error).toMatch(/attempt close A --outcome/);
    expect(fs.existsSync(path.join(p.scratch, 'prompt-A-r1.md'))).toBe(false);
    expect(p.find('A').resumed).toBeUndefined();
    // fill --ids on the running task says the same, and nothing changes.
    const again = p.run(['fill', '--ids', 'A']);
    expect(again.code).toBe(1);
    expect(again.error).toMatch(/a1 is running/);
    const closed = p.run(['attempt', 'close', 'A', '--outcome', 'interrupted']);
    expect(closed.code, closed.error).toBe(0);
    expect(p.find('A').attempts![0]).toMatchObject({ state: 'ended', outcome: 'interrupted' });
    const r = p.run(['resume', 'A', '--reason', 'context']);
    expect(r.code, r.error).toBe(0);
    expect(p.find('A').attempts?.map((x) => [x.id, x.state, x.round])).toEqual([
      ['a1', 'ended', 0],
      ['a2', 'reserved', 1],
    ]);
  });

  it('the stop row ends the attempt, so a continuation after PARTIAL works as it does today', () => {
    const p = project([task('A')]);
    p.run(['start', 'A']);
    p.branch('A');
    const t = p.transcript('agent1', 'A');
    p.hook('SubagentStart', startPayload('agent1', t));
    p.hook('SubagentStop', startPayload('agent1', t));
    const r = p.run(['resume', 'A', '--reason', 'context']);
    expect(r.code, r.error).toBe(0);
    expect(p.find('A').attempts![0]).toMatchObject({ state: 'ended', outcome: 'stopped' });
  });

  it('a waiting task with a running attempt: start refuses, and fill skips it and starts the rest', () => {
    const p = project([task('A'), task('B')]);
    p.run(['start', 'A']);
    p.hook('SubagentStart', startPayload('agent1', p.transcript('agent1', 'A')));
    p.run(['set', 'A', 'waiting']);
    const started = p.run(['start', 'A', '--force']);
    expect(started.code).toBe(1);
    expect(started.error).toMatch(/a1 is running/);
    expect(p.find('A').status).toBe('waiting');
    const r = p.run(['fill']);
    expect(r.code, r.error).toBe(0);
    expect(r.error).toMatch(/A: .*a1 is running/);
    expect(p.find('A').status).toBe('waiting');
    expect(p.find('B').status).toBe('running');
  });
});

describe('cq takeover: the warning about another orchestrator', () => {
  const takeover = (p: ReturnType<typeof project>) =>
    JSON.parse(
      spawnSync(process.execPath, [path.join(SCRIPTS, 'queue-takeover.mjs'), '--json'], { encoding: 'utf8', env: p.env, cwd: p.folder }).stdout,
    );

  it('a queue that was only just changed: no warning; a running task or a cursor: the warning', () => {
    const p = project([task('A'), task('B')]);
    expect(p.run(['add', '--json', JSON.stringify(task('C'))]).code).toBe(0);
    expect(takeover(p).possible_live_orchestrator).toBe(false);
    expect(p.run(['orchestrator', 'pulse', '--session', 'one']).code).toBe(0);
    expect(takeover(p).possible_live_orchestrator).toBe(true);
    const q = project([task('A')]);
    expect(q.run(['start', 'A']).code).toBe(0);
    expect(takeover(q).possible_live_orchestrator).toBe(true);
  });
  it('a cursor whose time ran out, after someone ran cq set: no warning (test round 2: M10)', () => {
    const p = project([task('A'), task('B')]);
    const old = new Date(Date.now() - 5 * 3_600_000).toISOString();
    fs.writeFileSync(path.join(p.folder, 'orchestrator.json'), JSON.stringify({ session: 'gone', updated: old, event: 'pulse' }));
    expect(p.run(['set', 'A', 'cancelled']).code).toBe(0);
    expect(takeover(p).possible_live_orchestrator).toBe(false);
  });
});

describe('cq add: owning a protected path', () => {
  it('warns and still adds; an ordinary file gives no warning', () => {
    const p = project([task('A')]);
    const r = p.run(['add', '--json', JSON.stringify({ ...task('B'), owned_files: ['.claude/settings.json'] })]);
    expect(r.code, r.error).toBe(0);
    expect(r.out).toContain('WARNING: B owns the protected path .claude/settings.json');
    expect(p.find('B')).toBeTruthy();
    const plain = p.run(['add', '--json', JSON.stringify({ ...task('C'), owned_files: ['src/c.ts'] })]);
    expect(plain.out).not.toContain('protected path');
  });
});

describe('cq receive: the merge line', () => {
  it('names --scratchpad only when merge would not find the folder itself', () => {
    const p = project([task('A')]);
    p.run(['start', 'A']);
    p.branch('A');
    p.report('A', RESULT('A'));
    expect(p.run(['receive', 'A']).out).not.toContain('merge A --scratchpad');
    p.patch('A', (o) => {
      delete o.scratchpad;
    });
    const scratch = p.env.QUEUE_SCRATCHPAD as string;
    delete p.env.QUEUE_SCRATCHPAD;
    const r = p.run(['receive', 'A', '--scratchpad', scratch]);
    expect(r.code, r.error).toBe(0);
    expect(r.out).toContain('merge A --scratchpad');
  });
});

describe('cq receive without commits', () => {
  it('refuses, leaves the task as it was and names the next steps; --force still makes the package', () => {
    const p = project([task('A')]);
    p.run(['start', 'A']);
    if (!p.g(['branch', '--list', 'queue/A'])) p.g(['branch', 'queue/A']);
    const r = p.run(['receive', 'A']);
    expect(r.code).toBe(1);
    expect(r.error).toContain('Nothing to receive');
    expect(r.error).toContain('A stays running');
    expect(r.error).toContain('git worktree list');
    expect(r.error).toContain('resume A --reason context');
    expect(r.error).toContain('set A cancelled');
    expect(r.error).not.toContain('already merged?');
    expect(p.find('A').status).toBe('running');
    expect(p.run(['receive', 'A', '--force']).error).not.toContain('Nothing to receive');
  });
});

describe('cq attempt', () => {
  it('list: --json, and a task without attempts or an unknown task', () => {
    const p = project([task('A'), task('B')]);
    p.run(['start', 'A']);
    const j = JSON.parse(p.run(['attempt', 'list', 'A', '--json']).out);
    expect(j.id).toBe('A');
    expect(j.attempts[0]).toMatchObject({ id: 'a1', state: 'reserved', shown_state: 'reserved' });
    expect(p.run(['attempt', 'list', 'B']).out).toMatch(/no attempts/);
    expect(p.run(['attempt', 'list', 'Z']).code).toBe(1);
    expect(p.run(['attempt']).code).toBe(1);
    expect(p.run(['attempt', 'nope', 'A']).code).toBe(1);
  });

  it('list never moves queue.changed when nothing changed (the board\'s --expect-changed stays valid)', () => {
    const p = project([task('A')]);
    p.run(['start', 'A']);
    const before = fs.readFileSync(p.file, 'utf8');
    p.run(['attempt', 'list', 'A']);
    expect(fs.readFileSync(p.file, 'utf8')).toBe(before);
  });

  it('close: needs a known outcome and an open attempt, and is logged for undo', () => {
    const p = project([task('A')]);
    p.run(['start', 'A']);
    expect(p.run(['attempt', 'close', 'A']).code).toBe(1);
    expect(p.run(['attempt', 'close', 'A', '--outcome', 'nope']).error).toMatch(/--outcome/);
    expect(p.find('A').attempts![0].state).toBe('reserved');
    const r = p.run(['attempt', 'close', 'A', '--outcome', 'abandoned', '--by', 'owner']);
    expect(r.code, r.error).toBe(0);
    expect(r.out).toMatch(/undo/);
    expect(p.run(['attempt', 'close', 'A', '--outcome', 'abandoned']).error).toMatch(/no open attempt/);
    expect(p.queue().changelog).toBeDefined();
  });

  it('close is refused from inside a track worktree, whatever --by says', () => {
    const p = project([task('A')]);
    p.run(['start', 'A']);
    p.branch('A');
    const wt = p.worktree('A');
    const r = p.run(['attempt', 'close', 'A', '--outcome', 'abandoned', '--by', 'owner'], wt);
    expect(r.code).toBe(1);
    expect(r.error).toMatch(/track worktree/);
    expect(p.find('A').attempts![0].state).toBe('reserved');
  });
});

describe('receive records on the attempt', () => {
  const GREEN = { gates: { quick: ['node -e "process.exit(0)"'] } };

  it('delivered sha, outcome, end and the evidence id of gate_check', () => {
    const p = project([task('A')], GREEN);
    p.run(['start', 'A']);
    const tip = p.branch('A');
    p.worktree('A');
    p.report('A', RESULT('A'));
    const t = p.transcript('agent1', 'A');
    p.hook('SubagentStart', startPayload('agent1', t));
    const r = p.run(['receive', 'A']);
    expect(r.code, r.error + r.out).toBe(0);
    const o = p.find('A');
    const evidenceId = (o.gate_check as { evidence_id: string }).evidence_id;
    expect(evidenceId).toBeTruthy();
    expect(o.attempts).toHaveLength(1);
    expect(o.attempts![0]).toMatchObject({
      state: 'ended',
      session_id: 'agent1',
      delivered_sha: tip,
      outcome: 'delivered',
      evidence: [evidenceId],
    });
    expect(o.attempts![0].started).toBeTruthy();
    expect(o.attempts![0].ended).toBeTruthy();
    expect(o.attempts![0].artifacts).toMatchObject({ report: path.join(p.scratch, 'A', 'track-result.md') });
    expect(r.out).not.toMatch(/attempt/i);
  });

  it('a red gate closes the attempt as gate-red, and the fix round receive starts gets its own', () => {
    const p = project([task('A')], { gates: { quick: ['node -e "process.exit(3)"'] } });
    p.run(['start', 'A']);
    const tip = p.branch('A');
    p.worktree('A');
    p.report('A', RESULT('A'));
    const r = p.run(['receive', 'A']);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/RESUME A-r1/);
    expect(p.find('A').attempts?.map((x) => [x.id, x.state, x.outcome ?? null, x.round, x.delivered_sha ?? null])).toEqual([
      ['a1', 'ended', 'gate-red', 0, tip],
      ['a2', 'reserved', null, 1, null],
    ]);
  });

  it('a red done command closes it as done-red', () => {
    const p = project([task('A', { done_when: 'node -e "process.exit(4)"' })], GREEN);
    p.run(['start', 'A']);
    p.branch('A');
    p.worktree('A');
    p.report('A', RESULT('A'));
    expect(p.run(['receive', 'A']).code).toBe(1);
    const list = p.find('A').attempts as Attempt[];
    expect(list[0]).toMatchObject({ state: 'ended', outcome: 'done-red' });
    expect(list[0].evidence).toHaveLength(1);
    expect(list[1]).toMatchObject({ state: 'reserved', round: 1 });
  });

  it('a PARTIAL track: outcome partial, no gate run, so no evidence', () => {
    const p = project([task('A')], GREEN);
    p.run(['start', 'A']);
    const tip = p.branch('A');
    p.report('A', RESULT('A', 'PARTIAL'));
    expect(p.run(['receive', 'A']).code).toBe(0);
    const x = p.find('A').attempts![0];
    expect(x).toMatchObject({ state: 'ended', outcome: 'partial', delivered_sha: tip });
    expect(x).not.toHaveProperty('evidence');
  });

  it('the Claude flow with the mtime fallback: the report where the mission says is read as before', () => {
    const p = project([task('A')]);
    p.run(['start', 'A']);
    p.branch('A');
    p.report('A', RESULT('A'));
    const r = p.run(['receive', 'A']);
    expect(r.code, r.error).toBe(0);
    expect(r.out).toContain(RESULT('A'));
    expect(p.find('A').result).toMatchObject({ status: 'DONE' });
  });
});

describe('agents cannot edit attempts', () => {
  it('edit and add drop the field', () => {
    const p = project([task('A')]);
    p.run(['start', 'A']);
    const before = p.find('A').attempts;
    const fake = [{ id: 'a9', state: 'ended' }];
    expect(p.run(['edit', 'A', '--json', JSON.stringify({ attempts: fake, value: 7 }), '--by', 'owner']).code).toBe(0);
    expect(p.find('A').attempts).toEqual(before);
    expect(p.find('A').value).toBe(7);
    const add = p.run(['add', '--json', JSON.stringify(task('N', { attempts: [{ id: 'a1', state: 'running' }], content_min: 120 }))]);
    expect(add.code, add.error).toBe(0);
    expect(p.find('N')).not.toHaveProperty('attempts');
  });

  it('edit-many refuses it', () => {
    const p = project([task('A')]);
    const f = path.join(p.folder, 'many.json');
    fs.writeFileSync(f, JSON.stringify([{ id: 'A', attempts: [] }]));
    const r = p.run(['edit-many', '--file', f]);
    expect(r.code).toBe(1);
    expect(r.error).toMatch(/unknown field attempts/);
  });

  it('the push guard denies a queue agent cq attempt, list and close alike', () => {
    /* eslint-disable-next-line @typescript-eslint/no-require-imports */
    const G = require('../lib/pushGuard.js') as {
      assess: (command: string, o: Record<string, unknown>) => { decision?: string; reason?: string } | null;
    };
    for (const command of ['cq attempt close A --outcome abandoned', 'cq attempt list A', 'node scripts/orchestrator/queue.mjs attempt close A']) {
      const v = G.assess(command, {
        baseBranch: 'main',
        migrations: {},
        deployCommands: [],
        guardedTypes: new Set(['track']),
        knownPackage: () => true,
        agentType: 'track',
        branch: 'queue/A',
      });
      expect(v?.decision, command).toBe('deny');
      expect(v?.reason).toMatch(/not for queue agents/);
    }
  });

  it('the mission text does not mention attempts', () => {
    const p = project([task('A')]);
    p.run(['fill']);
    expect(fs.readFileSync(path.join(p.scratch, 'prompt-A.md'), 'utf8')).not.toMatch(/attempts\b/);
  });
});

describe('compatibility', () => {
  const VIEWS = [['show'], ['show', '--full'], ['state'], ['info', 'A'], ['activeOnes'], ['diagnose'], ['next'], ['deliveries'], ['blockers']];

  it('an old queue.json without attempts reads as before, and nothing writes the field until a start', () => {
    const old = task('A', { status: 'running', started: '2026-01-01T00:00:00.000Z', branch: 'queue/A', migr_block: null });
    const p = project([old, task('B')]);
    for (const v of VIEWS) expect(p.run(v).code, v.join(' ')).toBe(0);
    expect(p.find('A')).not.toHaveProperty('attempts');
    expect(p.find('B')).not.toHaveProperty('attempts');
    expect(p.run(['attempt', 'list', 'A']).out).toMatch(/no attempts/);
    // An old running task delivers: receive works and writes no attempts.
    p.branch('A');
    p.report('A', RESULT('A'));
    expect(p.run(['receive', 'A']).code).toBe(0);
    expect(p.find('A')).not.toHaveProperty('attempts');
    expect(p.find('A').status).toBe('review');
  });

  it('an old running task can still be resumed; the new round is its first attempt', () => {
    const old = task('A', { status: 'running', started: '2026-01-01T00:00:00.000Z', branch: 'queue/A', migr_block: null });
    const p = project([old]);
    p.branch('A');
    const r = p.run(['resume', 'A', '--reason', 'context']);
    expect(r.code, r.error).toBe(0);
    expect(p.find('A').attempts?.map((x) => [x.id, x.round])).toEqual([['a1', 1]]);
  });

  it('a queue.json with attempts reads in every status view and on the board', () => {
    const p = project([task('A'), task('B')]);
    p.run(['fill']);
    p.hook('SubagentStart', startPayload('agent1', p.transcript('agent1', 'A')));
    p.run(['attempt', 'list', 'A']);
    p.run(['attempt', 'close', 'B', '--outcome', 'abandoned']);
    for (const v of VIEWS) {
      const r = p.run(v);
      expect(r.code, `${v.join(' ')}: ${r.error}`).toBe(0);
      expect(r.out).not.toMatch(/undefined|\[object Object\]/);
    }
    /* eslint-disable-next-line @typescript-eslint/no-require-imports */
    const B = require('../lib/queueBoard.js') as { board: (q: unknown, o?: unknown) => unknown };
    expect(() => JSON.stringify(B.board(p.queue()))).not.toThrow();
    const takeover = spawnSync(process.execPath, [path.join(SCRIPTS, 'queue-takeover.mjs')], {
      encoding: 'utf8',
      env: p.env,
      cwd: p.folder,
    });
    expect(takeover.status, takeover.stderr).toBe(0);
  });
});

describe('what the track says reaches the owner (test round 2: M20, M21)', () => {
  const asks = (id: string, commits = 0, status = 'PARTIAL') =>
    [
      `RESULT status=${status} branch=queue/${id} commits=${commits} migr=- gates=- probe=- ownerQuestions=1 edge=-`,
      '',
      '## Owner questions',
      '',
      '- The mission needs .claude/settings.json, which the task does not own. Add it to the task? Recommended: yes.',
      '',
      '## Assumptions',
      '',
      '- none',
    ].join('\n');

  it('no commits: the status and the question are printed, and the question opens a card in cq decide', () => {
    const p = project([task('A')]);
    p.run(['start', 'A']);
    if (!p.g(['branch', '--list', 'queue/A'])) p.g(['branch', 'queue/A']);
    p.report('A', asks('A'));
    const r = p.run(['receive', 'A']);
    expect(r.code).toBe(1);
    expect(r.error).toContain('Nothing to receive');
    expect(r.out).toContain('status=PARTIAL');
    expect(r.out).toContain('Add it to the task?');
    expect(r.out).not.toContain('## Assumptions');
    expect(p.find('A').status).toBe('running');
    const decide = JSON.parse(p.run(['decide', '--json']).out);
    const card = decide.items.find((x: { id: string }) => x.id === 'A');
    expect(card.kind).toBe('stopped');
    expect(card.context.join(' ')).toContain('Add it to the task?');
    expect(card.context.join(' ')).toContain('track-result.md');
    expect(card.context.join(' ')).toContain('resume A --reason context');
  });
  it('the card goes when the task is resumed, and an old report does not bring it back', () => {
    const p = project([task('A')]);
    p.run(['start', 'A']);
    if (!p.g(['branch', '--list', 'queue/A'])) p.g(['branch', 'queue/A']);
    p.report('A', asks('A'));
    p.run(['receive', 'A']);
    expect(p.run(['resume', 'A', '--reason', 'context']).code).toBe(0);
    const open = () => JSON.parse(p.run(['decide', '--json']).out).items.filter((x: { kind: string }) => x.kind === 'stopped');
    expect(open()).toEqual([]);
    p.run(['receive', 'A']);
    expect(open()).toEqual([]);
  });
  it('no commits and no question: the same refusal as before, and no card', () => {
    const p = project([task('A')]);
    p.run(['start', 'A']);
    if (!p.g(['branch', '--list', 'queue/A'])) p.g(['branch', 'queue/A']);
    p.report('A', RESULT('A', 'PARTIAL').replace('commits=1', 'commits=0'));
    expect(p.run(['receive', 'A']).error).toContain('Nothing to receive');
    expect(JSON.parse(p.run(['decide', '--json']).out).items.filter((x: { kind: string }) => x.kind === 'stopped')).toEqual([]);
  });
  it('a PARTIAL delivery with commits: says it is unfinished and that nothing ran, shows the question, and the wrong commit count', () => {
    const p = project([task('A')]);
    p.run(['start', 'A']);
    p.branch('A');
    p.report('A', asks('A'));
    const r = p.run(['receive', 'A']);
    expect(r.code, r.error).toBe(0);
    expect(r.out).toMatch(/PARTIAL: unfinished/);
    expect(r.out).toContain('resume A --reason context');
    expect(r.out).toContain('Add it to the task?');
    expect(r.out).toMatch(/commits=0.*branch has/);
    expect(p.find('A').status).toBe('review');
    expect(JSON.parse(p.run(['decide', '--json']).out).items.find((x: { id: string }) => x.id === 'A').kind).toBe('stopped');
  });
  it('a DONE delivery without questions gets none of these lines', () => {
    const p = project([task('A')]);
    p.run(['start', 'A']);
    p.branch('A');
    p.report('A', RESULT('A'));
    const r = p.run(['receive', 'A']);
    expect(r.code, r.error).toBe(0);
    expect(r.out).not.toMatch(/PARTIAL: unfinished|Owner question/);
    expect(r.out).not.toMatch(/branch has/);
  });
  it('no report file and a mission template older than the plugin: the warning points at cq doctor', () => {
    const p = project([task('A')]);
    p.run(['start', 'A']);
    p.branch('A');
    // The harness's project root is the folder (QUEUE_ROOT), not the repo.
    fs.mkdirSync(path.join(p.folder, 'docs', 'queue'), { recursive: true });
    fs.writeFileSync(path.join(p.folder, 'docs', 'queue', 'mission-template.md'), 'old\n');
    const r = p.run(['receive', 'A']);
    expect(r.out).toContain('has no track-result.md');
    expect(r.out).toMatch(/mission-template\.md differs.*cq doctor/);
  });
});

describe('cq add warns about a protected path in the mission (test round 2: M22)', () => {
  it('names it, and points at --files', () => {
    const p = project([], { mode: 'lite' });
    const r = p.run(['add', 'Change the settings', '--mission', 'Set autoCompactWindow in .claude/settings.json']);
    expect(r.code, r.error).toBe(0);
    expect(r.out).toMatch(/names the protected path \.claude\/ without owning it/);
    expect(r.out).toContain('--files');
    const owned = p.run(['add', 'Change them again', '--mission', 'Set a key in .claude/settings.json', '--files', '.claude/settings.json']);
    expect(owned.out).not.toMatch(/names the protected path/);
    expect(owned.out).toMatch(/owns the protected path/);
  });
});

describe('long lines outside a terminal (test round 2: L1)', () => {
  it('cq decide keeps the whole title and command when the output is piped', () => {
    const title = `Long title ${'x'.repeat(200)} the end`;
    const p = project([task('A', { status: 'proposed', title, added_by: 'agent' })]);
    const r = p.run(['decide']);
    expect(r.out).toContain(`${title}`);
    expect(r.out).not.toContain('…');
  });
});

describe('the first run (test round 2: M5, M6, M7)', () => {
  it('takeover without a queue says what to do, with no stack trace', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-empty-'));
    temporary.push(empty);
    const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'queue-takeover.mjs')], {
      encoding: 'utf8',
      env: { ...process.env, QUEUE_FOLDER: empty, QUEUE_ROOT: empty, QUEUE_GIT: empty },
      cwd: empty,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/The queue does not exist\. Run: .* init/);
    expect(r.stderr).not.toContain('    at ');
  });
  it('a task that owns an uncommitted file: fill, show and decide say so', () => {
    const p = project([task('A', { owned_files: ['README.md'] })]);
    fs.writeFileSync(path.join(p.repo, 'README.md'), 'changed\n');
    const fill = p.run(['fill']);
    expect(fill.out).toContain('Held back 1');
    expect(fill.out).toContain('A  file README.md');
    const show = p.run(['show']);
    expect(show.out).not.toContain('OUT OF WORK');
    expect(show.out).toContain('NOTHING CAN START');
    const decide = p.run(['decide']);
    expect(decide.out).toContain('Held back 1');
    expect(decide.out).toContain('Nothing waiting on you.');
  });
  it('an empty queue is still out of work', () => {
    expect(project([]).run(['show']).out).toContain('OUT OF WORK');
  });
  it('setup says what is uncommitted and that the queue comes next', () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-setup-'));
    temporary.push(folder);
    execFileSync('git', ['-C', folder, 'init', '-q', '-b', 'main']);
    execFileSync('git', ['-C', folder, ...ID, 'commit', '-q', '--allow-empty', '-m', 'start']);
    const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'setup.mjs'), '--target', folder], { encoding: 'utf8', cwd: folder });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/path\(s\) are uncommitted here/);
    expect(r.stdout).toContain('Next: cq init');
  });
});

describe('the fix round after a red gate (test round 2: M11, M12)', () => {
  const red = { gates: { quick: ['node -e "console.log(\'the gate says no\');process.exit(3)"'] } };
  it('resume after receive is the same round, counts once, and the brief names the gate', () => {
    const p = project([task('A')], red);
    p.run(['start', 'A']);
    p.branch('A');
    p.worktree('A');
    p.report('A', RESULT('A'));
    const received = p.run(['receive', 'A']);
    expect(received.out).toContain('RESUME A-r1');
    const r = p.run(['resume', 'A', '--reason', 'fix']);
    expect(r.code, r.error).toBe(0);
    expect(r.out).toContain('RESUME A-r1');
    expect(r.out).toContain('never started');
    expect(p.find('A').resumed.length).toBe(1);
    const brief = fs.readFileSync(path.join(p.scratch, 'prompt-A-r1.md'), 'utf8');
    expect(brief).toContain('quick gates are RED');
    expect(brief).toContain('the gate says no');
    expect(brief).not.toContain('Fix the review findings');
  });
  it('a resume with reviewers behind it still says to fix their findings', () => {
    const p = project([task('A', { status: 'review', branch: 'queue/A', started: new Date().toISOString() })]);
    p.branch('A');
    expect(p.run(['resume', 'A', '--reason', 'fix']).code).toBe(0);
    expect(fs.readFileSync(path.join(p.scratch, 'prompt-A-r1.md'), 'utf8')).toContain('Fix the review findings');
  });
  it('resume warns about a merge left open in the main tree (M13)', () => {
    const p = project([task('A', { status: 'review', branch: 'queue/A', started: new Date().toISOString() })]);
    p.branch('A');
    fs.writeFileSync(path.join(p.repo, '.git', 'MERGE_HEAD'), `${p.g(['rev-parse', 'HEAD'])}\n`);
    expect(p.run(['resume', 'A', '--reason', 'fix']).out).toMatch(/unfinished merge.*git merge --abort/);
  });
});

describe('cq decide gives the advice that fits (test round 2: M16, M17)', () => {
  const items = (p: ReturnType<typeof project>) => JSON.parse(p.run(['decide', '--json']).out).items;
  it('a task started without an agent is put back in the queue, not flagged', () => {
    const started = new Date(Date.now() - 3_600_000).toISOString();
    const p = project([task('A', { status: 'running', branch: 'queue/A', started })]);
    const item = items(p).find((x: { id: string }) => x.id === 'A');
    expect(item.kind).toBe('stuck-no-agent');
    expect(item.options[0].cli).toMatch(/set A waiting$/);
  });
  it('a gate task with no file and line recommends declining; one with a place recommends approving', () => {
    const gate = (id: string, seen: string) =>
      task(id, { status: 'proposed', labels: ['gate'], added_by: 'gate agent', mission: `Stop it.\nSeen in: ${seen}.` });
    const list = items(project([gate('G1', 'task T-1'), gate('G2', 'task T-1: src/api.js:42')]));
    const of = (id: string) => list.find((x: { id: string }) => x.id === id);
    expect(of('G1').options[0].label).toBe('Decline');
    expect(of('G1').options[0].recommended).toBe(true);
    expect(of('G1').context.join(' ')).toContain('No file and line');
    expect(of('G2').options[0].label).toBe('Approve');
    expect(of('G2').options[0].recommended).toBe(true);
  });
  it('a GATE line can carry its place, and the class stays the class', () => {
    const KB = require('../lib/knownBugGate.js');
    expect(KB.parseGate('GATE a fetch result unchecked @ src/api.js:42')).toEqual({ title: 'a fetch result unchecked', where: 'src/api.js:42' });
    expect(KB.parseGate('GATE a fetch result unchecked')).toEqual({ title: 'a fetch result unchecked', where: null });
    expect(KB.parseGateLine('GATE a fetch result unchecked @ src/api.js:42')).toBe('a fetch result unchecked');
    expect(KB.parseGate('GATE none')).toBeNull();
  });
});

describe('what is left behind (test round 2: M2, M4, M8, L3)', () => {
  it('merge --resume on a done task removes the merged branches an earlier cleanup left', () => {
    const p = project([task('A', { status: 'done', branch: 'queue/A' })]);
    p.g(['branch', 'queue/A']);
    p.g(['branch', 'worktree-agent-x']);
    const r = p.run(['merge', 'A', '--resume']);
    expect(r.code, r.error).toBe(0);
    expect(r.out).toContain('nothing to resume');
    expect(r.out).toContain('Branch: queue/A deleted');
    expect(r.out).toContain('Agent branches: 1 merged');
    expect(p.g(['branch', '--list', 'worktree-agent-x'])).toBe('');
  });
  it('an agent branch with its own work stays', () => {
    const p = project([task('A', { status: 'done', branch: 'queue/A' })]);
    p.g(['branch', 'queue/A']);
    p.g(['switch', '-q', '-c', 'worktree-agent-y']);
    p.g(['commit', '-q', '--allow-empty', '-m', 'work']);
    p.g(['switch', '-q', 'main']);
    p.run(['merge', 'A', '--resume']);
    expect(p.g(['branch', '--list', 'worktree-agent-y'])).toContain('worktree-agent-y');
  });
  it('cancelling says what stays and how to drop it, and deletes nothing', () => {
    const p = project([task('A', { status: 'running', branch: 'queue/A', started: new Date().toISOString() })]);
    p.branch('A');
    const r = p.run(['set', 'A', 'cancelled']);
    expect(r.out).toMatch(/Left behind: branch queue\/A with 1 commit/);
    expect(r.out).toContain('git branch -D queue/A');
    expect(p.g(['branch', '--list', 'queue/A'])).toContain('queue/A');
  });
  it('cancelling a task with no branch says nothing about it', () => {
    const p = project([task('A')]);
    expect(p.run(['set', 'A', 'cancelled']).out).not.toContain('Left behind');
  });
  it('cleanup-worktree --abandon removes the worktree of unmerged work and keeps the branch', () => {
    const p = project([task('A')]);
    p.branch('A');
    const wt = path.join(p.repo, '.claude', 'worktrees', 'agent-a');
    p.g(['worktree', 'add', '-q', wt, 'queue/A']);
    const cleanup = (...args: string[]) =>
      spawnSync(process.execPath, [path.join(SCRIPTS, 'cleanup-worktree.mjs'), 'queue/A', '--execute', '--against', 'main', ...args], { encoding: 'utf8', cwd: p.repo });
    expect(cleanup().stdout).toContain('not merged');
    expect(fs.existsSync(wt)).toBe(true);
    cleanup('--abandon');
    expect(fs.existsSync(wt)).toBe(false);
    expect(p.g(['branch', '--list', 'queue/A'])).toContain('queue/A');
  });
  it('doctor names every branch in its advice, and treats one with a worktree differently', () => {
    const ids = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
    const p = project(ids.map((id) => task(id, { status: 'done', branch: `queue/${id}` })));
    for (const id of ids) p.g(['branch', `queue/${id}`]);
    const wt = path.join(p.repo, '.claude', 'worktrees', 'agent-a');
    p.g(['worktree', 'add', '-q', wt, 'queue/A']);
    const out = p.run(['doctor']).out;
    expect(out).toMatch(/1 branch\(es\) of done or cancelled tasks still have a worktree: queue\/A/);
    expect(out).toContain('cq cleanup-worktree --all --execute');
    expect(out).toContain('git branch -d queue/B queue/C queue/D queue/E queue/F queue/G');
  });
});

describe('cq edit --files (test round 3: N11, N14)', () => {
  it('sets the files, takes backslashes, and an empty list empties it', () => {
    const p = project([task('A')]);
    expect(p.run(['edit', 'A', '--files', 'a.js, b\\c.js']).code).toBe(0);
    expect(p.find('A').owned_files).toEqual(['a.js', 'b/c.js']);
    expect(p.run(['edit', 'A', '--files', '']).code).toBe(0);
    expect(p.find('A').owned_files).toEqual([]);
  });
  it('an edit with nothing to write is an error, not "changed:"', () => {
    const p = project([task('A')]);
    const r = p.run(['edit', 'A', '--filez', 'a.js']);
    expect(r.code).not.toBe(0);
    expect(r.error).toContain('Nothing changed');
  });
  it('after the start the error says how the owner does it, and --by owner does', () => {
    const p = project([task('A', { status: 'running', branch: 'queue/A', started: new Date().toISOString() })]);
    const r = p.run(['edit', 'A', '--files', 'a.js']);
    expect(r.code).not.toBe(0);
    expect(r.error).toContain('--by owner');
    expect(p.run(['edit', 'A', '--files', 'a.js', '--by', 'owner']).code).toBe(0);
    expect(p.find('A').owned_files).toEqual(['a.js']);
  });
  it('the card for a track question gives the command that works', () => {
    const p = project([task('A', { status: 'running', branch: 'queue/A', started: new Date().toISOString() })]);
    p.branch('A');
    p.report('A', 'RESULT status=PARTIAL branch=queue/A commits=0 migr=- gates=- probe=- ownerQuestions=1 edge=-\n\nOwner questions:\n1. May I change a file?');
    p.run(['receive', 'A']);
    expect(p.run(['decide']).out).toContain('--files <files> --by owner');
  });
});

describe('a PARTIAL delivery is not merged by mistake (test round 3: N17)', () => {
  const delivered = () => {
    const p = project([task('A')], { gates: { quick: ['node -e "process.exit(0)"'] } });
    p.run(['start', 'A']);
    p.branch('A');
    p.worktree('A');
    p.report('A', RESULT('A', 'PARTIAL'));
    return { p, received: p.run(['receive', 'A']) };
  };
  it('receive no longer shows the way to merge, and merge stops', () => {
    const { p, received } = delivered();
    expect(received.out).toContain('Do not merge it');
    expect(received.out).not.toContain('Merge (after');
    expect(received.out).not.toContain('receive checks the tip itself');
    const r = p.run(['merge', 'A']);
    expect(r.code).not.toBe(0);
    expect(r.error).toContain('PARTIAL');
    expect(r.error).toContain('--allow-partial');
    expect(p.find('A').status).toBe('review');
  });
  it('the next round delivering DONE clears the stop', () => {
    const { p } = delivered();
    p.report('A', RESULT('A'));
    const again = p.run(['receive', 'A']);
    expect(again.out).toContain('Merge (after');
    expect(p.find('A').delivered_partial).toBeUndefined();
  });
});

describe('a worktree the agent detached when it delivered (test round 3: N18, N2, N4)', () => {
  const started = (id: string, extra = {}) => task(id, { status: 'running', branch: `queue/${id}`, started: new Date().toISOString(), ...extra });
  const detached = (p: ReturnType<typeof project>, name: string, at: string) => {
    const wt = path.join(p.repo, '.claude', 'worktrees', name);
    p.g(['worktree', 'add', '-q', '--detach', wt, at]);
    return wt;
  };
  const cleanup = (p: ReturnType<typeof project>, ...args: string[]) =>
    spawnSync(process.execPath, [path.join(SCRIPTS, 'cleanup-worktree.mjs'), ...args, '--against', 'main'], { encoding: 'utf8', cwd: p.repo });

  it('cancelling names it, and --abandon finds and removes it without calling it merged', () => {
    const p = project([started('A')]);
    p.branch('A');
    const wt = detached(p, 'agent-a', 'queue/A');
    const cancelled = p.run(['set', 'A', 'cancelled']);
    expect(cancelled.out).toContain('agent-a');
    expect(cancelled.out).toContain('--abandon --execute');
    const dry = cleanup(p, 'queue/A', '--abandon');
    expect(dry.stdout).toContain('would remove');
    expect(dry.stdout).not.toContain('merged, clean');
    cleanup(p, 'queue/A', '--abandon', '--execute');
    expect(fs.existsSync(wt)).toBe(false);
    expect(p.g(['branch', '--list', 'queue/A'])).toContain('queue/A');
  });
  it('a detached worktree on a commit the base has is not the branch\'s', () => {
    const p = project([started('A')]);
    p.branch('A');
    const wt = detached(p, 'agent-b', 'main');
    const dry = cleanup(p, 'queue/A', '--abandon');
    expect(dry.stdout).toContain('no worktree for queue/A');
    expect(dry.stdout).toContain('kept: 1 × no worktree for queue/A');
    expect(fs.existsSync(wt)).toBe(true);
  });
  it('merge --resume removes the merged worktrees of the task and leaves the others', () => {
    const p = project([task('A', { status: 'done', branch: 'queue/A' })]);
    const start = p.g(['rev-parse', 'HEAD']);
    p.patch('A', (o) => { (o as Record<string, unknown>).head_start = start; });
    p.branch('A');
    const own = detached(p, 'agent-c', 'queue/A');
    const other = detached(p, 'agent-d', start);
    p.g(['merge', '-q', '--no-ff', '-m', 'merge A', 'queue/A']);
    const r = p.run(['merge', 'A', '--resume']);
    expect(r.code, r.error).toBe(0);
    expect(r.out).toContain('Worktree: removed');
    expect(fs.existsSync(own)).toBe(false);
    expect(fs.existsSync(other)).toBe(true);
  });
  it('doctor names both kinds, and leaves a task still in work alone', () => {
    const p = project([task('A', { status: 'cancelled', branch: 'queue/A' }), started('B')]);
    p.branch('A');
    p.branch('B');
    detached(p, 'agent-e', 'queue/A');
    detached(p, 'agent-f', 'queue/B');
    detached(p, 'agent-g', 'main');
    const out = p.run(['doctor']).out;
    expect(out).toMatch(/1 detached worktree\(s\) hold nothing the base lacks: agent-g/);
    expect(out).toMatch(/still hold the work of finished or cancelled: queue\/A/);
    expect(out).not.toContain('agent-f');
  });
});

describe('a long failure class (test round 3: N9)', () => {
  const long = `a failure class ${'that goes on '.repeat(20)}and ends here`;
  it('cq gate cuts the title and keeps the whole class in the mission', () => {
    const p = project([]);
    p.run(['gate', long]);
    const o = p.queue().tasks[0];
    expect(o.title.length).toBeLessThan(110);
    expect(o.mission).toContain('and ends here');
  });
  it('a GATE line keeps its whole class too', () => {
    const KB = require('../lib/knownBugGate.js');
    expect(KB.parseGate(`GATE ${long} @ src/a.js:1`)).toEqual({ title: long.trim(), where: 'src/a.js:1' });
  });
});

describe('answering what a track asked (test round 3: N12, N22)', () => {
  const asked = () => {
    const p = project([task('A', { status: 'running', branch: 'queue/A', started: new Date().toISOString() })]);
    p.branch('A');
    p.report('A', 'RESULT status=PARTIAL branch=queue/A commits=1 migr=- gates=- probe=- ownerQuestions=1 edge=-\n\nOwner questions:\n1. Which name?');
    p.run(['receive', 'A']);
    return p;
  };
  it('the card recommends answering, under its own heading', () => {
    const p = asked();
    const item = JSON.parse(p.run(['decide', '--json']).out).items.find((x: { id: string }) => x.id === 'A');
    expect(item.options[0].label).toContain('Answer');
    expect(item.options[0].recommended).toBe(true);
    expect(item.options[0].cli).toContain('--answer');
    expect(item.options[1].recommended).toBe(false);
    expect(p.run(['decide']).out).toMatch(/ANSWER {2}A /);
  });
  it('resume --answer puts it first in the brief, keeps it for later rounds and closes the card', () => {
    const p = asked();
    const r = p.run(['resume', 'A', '--reason', 'context', '--answer', 'Call it halv2']);
    expect(r.code, r.error).toBe(0);
    const brief = fs.readFileSync(path.join(p.scratch, 'prompt-A-r1.md'), 'utf8');
    expect(brief).toContain("The owner answers the track's question:** Call it halv2");
    expect(JSON.stringify(p.find('A').bonus)).toContain('Call it halv2');
    expect(JSON.parse(p.run(['decide', '--json']).out).items.find((x: { id: string }) => x.id === 'A')).toBeUndefined();
  });
  it('the same round written again keeps the answer first, once (test round 4: P6)', () => {
    const p = asked();
    expect(p.run(['resume', 'A', '--reason', 'context', '--answer', 'Call it halv2']).code).toBe(0);
    const again = p.run(['resume', 'A', '--reason', 'context']);
    expect(again.code, again.error).toBe(0);
    expect(again.out).toContain('this is the same round');
    const brief = () => fs.readFileSync(path.join(p.scratch, 'prompt-A-r1.md'), 'utf8');
    expect(brief()).toContain("The owner answers the track's question:** Call it halv2");
    expect(p.find('A').resumed).toHaveLength(1);
    expect(JSON.stringify(p.find('A').bonus).split('Call it halv2')).toHaveLength(2);
    // A new answer replaces it.
    expect(p.run(['resume', 'A', '--reason', 'context', '--answer', 'Call it halv3']).code).toBe(0);
    expect(brief()).toContain("The owner answers the track's question:** Call it halv3");
    expect(brief()).not.toContain("question:** Call it halv2");
    expect(p.run(['resume', 'A', '--reason', 'context']).code).toBe(0);
    expect(brief()).toContain("The owner answers the track's question:** Call it halv3");
  });
  it('an open question makes the next step carry --answer (test round 4: P7)', () => {
    const p = project([task('A', { status: 'running', branch: 'queue/A', started: new Date().toISOString() })]);
    p.branch('A');
    p.report('A', 'RESULT status=PARTIAL branch=queue/A commits=1 migr=- gates=- probe=- ownerQuestions=1 edge=-\n\nOwner questions:\n1. Which name?');
    expect(p.run(['receive', 'A']).out).toContain('resume A --reason context --answer "<text>".');
    const stop = p.run(['merge', 'A']);
    expect(stop.code).not.toBe(0);
    expect(stop.out + stop.error).toContain('resume A --reason context --answer "<text>", then');
  });
  it('without commits, the question still makes the next step carry --answer (test round 4: P7)', () => {
    const p = project([task('A', { status: 'running', branch: 'queue/A', started: new Date().toISOString() })]);
    p.g(['branch', 'queue/A']);
    p.report('A', 'RESULT status=PARTIAL branch=queue/A commits=0 migr=- gates=- probe=- ownerQuestions=1 edge=-\n\nOwner questions:\n1. Which name?');
    const r = p.run(['receive', 'A']);
    expect(r.code).toBe(1);
    expect(r.out + r.error).toContain('resume A --reason context --answer "<text>" for a new round');
  });
  it('a PARTIAL with no question has no answer to carry', () => {
    const p = project([task('A', { status: 'running', branch: 'queue/A', started: new Date().toISOString() })]);
    p.branch('A');
    p.report('A', 'RESULT status=PARTIAL branch=queue/A commits=1 migr=- gates=- probe=- ownerQuestions=0 edge=-');
    const r = p.run(['receive', 'A']);
    expect(r.out).toContain('resume A --reason context.');
    expect(r.out).not.toContain('--answer');
  });
  it('an empty answer stops before any round is made', () => {
    const p = asked();
    expect(p.run(['resume', 'A', '--reason', 'context', '--answer', '']).code).not.toBe(0);
    expect(p.find('A').resumed).toBeUndefined();
  });
  it('another stop still says Seen', () => {
    const p = project([task('A', { status: 'review', branch: 'queue/A', started: new Date().toISOString() })]);
    p.g(['branch', 'queue/A']);
    p.patch('A', (o) => { (o as Record<string, unknown>).blocks = [{ code: 'merge-guard', from: new Date().toISOString() }]; });
    const item = JSON.parse(p.run(['decide', '--json']).out).items.find((x: { id: string }) => x.id === 'A');
    expect(item.options[0].label).toBe('Seen');
  });
});

describe('when nothing can start (test round 3: N6, N7, N23)', () => {
  const dirty = () => {
    const p = project([task('A', { owned_files: ['new/deep.txt'] })]);
    fs.mkdirSync(path.join(p.repo, 'new'));
    fs.writeFileSync(path.join(p.repo, 'new', 'deep.txt'), 'x\n');
    return p;
  };
  it('names the file the task owns, not the folder git shows', () => {
    const r = dirty().run(['fill']);
    expect(r.out).toContain('A  file new/deep.txt');
  });
  it('a full machine does not hide what is held back', () => {
    const p = dirty();
    const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'queue.mjs'), 'fill', '--scratchpad', p.scratch], { encoding: 'utf8', env: { ...p.env, QUEUE_LOAD: 'free=1' }, cwd: p.folder });
    expect(r.status).toBe(7);
    expect(r.stdout).toContain('Held back 1');
    expect(r.stderr).toContain('THE MACHINE IS FULL');
  });
  it('with few slots it says a task in review holds one', () => {
    const p = project([task('A', { status: 'review', branch: 'queue/A', started: new Date().toISOString() }), task('B')]);
    p.g(['branch', 'queue/A']);
    const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'queue.mjs'), 'fill', '--scratchpad', p.scratch], { encoding: 'utf8', env: { ...p.env, QUEUE_LOAD: 'free=11' }, cwd: p.folder });
    expect(r.stdout).toContain('Nothing can start');
    expect(r.stdout).toContain('The slots are held by: A (review)');
  });
});

describe('rounds and briefs (test round 3: N15, N20)', () => {
  it('a continuation made twice with no agent between is one round', () => {
    const p = project([task('A', { status: 'running', branch: 'queue/A', started: new Date().toISOString() })]);
    p.branch('A');
    expect(p.run(['resume', 'A', '--reason', 'context']).out).toContain('RESUME A-r1');
    const again = p.run(['resume', 'A', '--reason', 'context']);
    expect(again.out).toContain('RESUME A-r1');
    expect(again.out).toContain('never started');
    expect(p.find('A').resumed).toHaveLength(1);
  });
  it('after a red gate at receive the brief points at no package', () => {
    const p = project([task('A')], { gates: { quick: ['node -e "process.exit(3)"'] } });
    p.run(['start', 'A']);
    p.branch('A');
    p.worktree('A');
    p.report('A', RESULT('A'));
    p.run(['receive', 'A']);
    p.run(['resume', 'A', '--reason', 'fix']);
    expect(fs.readFileSync(path.join(p.scratch, 'prompt-A-r1.md'), 'utf8')).not.toContain('00-package.md first');
  });
});

describe('false signals (test round 3: N1, N31, N32)', () => {
  it('setup --settings leaves settings.json as it was when nothing in it changes', () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-setup-'));
    temporary.push(folder);
    execFileSync('git', ['-C', folder, 'init', '-q', '-b', 'main']);
    const setup = () => spawnSync(process.execPath, [path.join(SCRIPTS, 'setup.mjs'), '--target', folder, '--settings'], { encoding: 'utf8', cwd: folder });
    expect(setup().status).toBe(0);
    const file = path.join(folder, '.claude', 'settings.json');
    const crlf = fs.readFileSync(file, 'utf8').replace(/\n/g, '\r\n');
    fs.writeFileSync(file, crlf);
    setup();
    expect(fs.readFileSync(file, 'utf8')).toBe(crlf);
  });
  it('setup names what is uncommitted', () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-setup-'));
    temporary.push(folder);
    execFileSync('git', ['-C', folder, 'init', '-q', '-b', 'main']);
    execFileSync('git', ['-C', folder, ...ID, 'commit', '-q', '--allow-empty', '-m', 'start']);
    const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'setup.mjs'), '--target', folder], { encoding: 'utf8', cwd: folder });
    expect(r.stdout).toMatch(/uncommitted here \(.*queue\.config\.json/);
  });
  it('a block left open on a cancelled task is not open and does not grow', () => {
    const L = require('../lib/queueLogic.js');
    const from = new Date(Date.now() - 3_600_000).toISOString();
    const [row] = L.blockerSummary({ tasks: [{ id: 'A', status: 'cancelled', blocks: [{ code: 'gate-red', from }] }] });
    expect(row).toMatchObject({ code: 'gate-red', count: 1, open: 0, ms: 0 });
  });
  it('cq <command> --help is the help, and runs nothing', () => {
    const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'cq.mjs'), 'decide', '--help'], { encoding: 'utf8', cwd: os.tmpdir() });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('cq decide');
    expect(r.stdout).not.toContain('Waiting on you');
    expect(r.stdout).not.toContain('Nothing waiting');
  });
});

describe('the board answers a track through the same command (test round 3: N12)', () => {
  it('POST /api/action { type: track-answer } starts the new round; an empty answer gives 400', async () => {
    const { spawn } = require('node:child_process');
    const p = project([task('A', { status: 'running', branch: 'queue/A', started: new Date().toISOString() })]);
    p.branch('A');
    p.report('A', 'RESULT status=PARTIAL branch=queue/A commits=1 migr=- gates=- probe=- ownerQuestions=1 edge=-\n\nOwner questions:\n1. Which name?');
    p.run(['receive', 'A']);
    const net = require('node:net');
    const port = await new Promise<number>((done) => {
      const s = net.createServer().listen(0, '127.0.0.1', () => {
        const free = s.address().port;
        s.close(() => done(free));
      });
    });
    const board = spawn(process.execPath, [path.join(SCRIPTS, 'queue-board.mjs'), '--port', String(port)], { cwd: p.folder, env: p.env });
    let said = '';
    board.stderr.on('data', (d: Buffer) => (said += String(d)));
    try {
      const open = await new Promise<RegExpExecArray>((done, fail) => {
        let out = '';
        const timer = setTimeout(() => fail(new Error(`no start line: ${out} ${said}`)), 60_000);
        board.stdout.on('data', (d: Buffer) => {
          out += String(d);
          const m = /Open: (http:\/\/[^/\s]+)\/#key=(\S+)/.exec(out);
          if (m) { clearTimeout(timer); done(m); }
        });
      });
      const post = (text: string) =>
        fetch(`${open[1]}/api/action`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-queue-key': open[2] },
          body: JSON.stringify({ type: 'track-answer', id: 'A', text }),
        });
      const empty = await post('  ');
      expect(empty.status).toBe(400);
      expect(p.find('A').resumed).toBeUndefined();
      const ok = await post('Call it halv2');
      expect(ok.status, await ok.clone().text()).toBe(200);
      expect(JSON.stringify(p.find('A').bonus)).toContain('Call it halv2');
      expect(p.find('A').resumed).toHaveLength(1);
      // Marked as the owner's, which is what wakes cq wait.
      expect(p.find('A').resumed[0]).toMatchObject({ by: 'owner', answer: 'Call it halv2' });
    } finally {
      const gone = new Promise((done) => board.once('exit', done));
      board.kill();
      await gone;
    }
  }, 120_000);
});

describe('test round 3, P2', () => {
  it('M3: cq show <id> shows that task, and an unknown id says so', () => {
    const p = project([task('A', { title: 'the first one' }), task('B', { title: 'the other one' })]);
    const r = p.run(['show', 'A']);
    expect(r.code, r.error).toBe(0);
    expect(r.out).toContain('the first one');
    expect(r.out).not.toContain('the other one');
    expect(p.run(['show', 'NOPE']).code).not.toBe(0);
    expect(p.run(['show', '--all']).code).toBe(0);
  });
  it('M9: the board text says BLOCKED and why, as push-check does', () => {
    const PB = require('../lib/pushBatch.js');
    const batch = { taskCount: 3, firstParent: 3, tip: 'abcdef0', oldestAt: new Date().toISOString() };
    const setup = { mode: 'owner', minTasks: 10, warnTasks: 0, maxAgeHours: null };
    expect(PB.boardBatch({ batch, setup }).text).toBe('3 of 10 tasks, NOT YET');
    const blocked = PB.blockedTexts({ external: 1 });
    const board = PB.boardBatch({ batch, setup, blocked });
    expect(board.verdict).toBe(PB.batchVerdict({ batch, setup, blocked }).verdict);
    expect(board.text).toBe('3 of 10 tasks, BLOCKED (1 external commit(s): ask the owner first)');
    expect(PB.boardBatch({ batch, setup, fullGate: 'missing' }).verdict).toBe('BLOCKED');
  });
  it('M10: cq set does not revive an orchestrator whose time ran out, and keeps a live one fresh', () => {
    const file = (p: ReturnType<typeof project>) => path.join(p.folder, 'orchestrator.json');
    const old = new Date(Date.now() - 5 * 3_600_000).toISOString();
    const stale = project([task('A')]);
    fs.writeFileSync(file(stale), JSON.stringify({ session: 'gone', updated: old, event: 'pulse' }));
    expect(stale.run(['set', 'A', 'cancelled']).code).toBe(0);
    expect(JSON.parse(fs.readFileSync(file(stale), 'utf8')).updated).toBe(old);
    const live = project([task('A')]);
    const recent = new Date(Date.now() - 60_000).toISOString();
    fs.writeFileSync(file(live), JSON.stringify({ session: 'here', updated: recent, event: 'pulse' }));
    expect(live.run(['set', 'A', 'cancelled']).code).toBe(0);
    expect(JSON.parse(fs.readFileSync(file(live), 'utf8')).event).toBe('set A cancelled');
  });
  describe('L8: text in a heredoc', () => {
    const SC = require('../lib/shellCommands.js');
    const PG = require('../lib/pushGuard.js');
    const denied = (command: string) => PG.assess(command, { branch: 'main', baseBranch: 'main', environment: null })?.decision === 'deny';
    const FORCE = ['git', 'push', '--force', 'origin', 'main'].join(' ');
    it('written to a file or a commit message, it is not a command', () => {
      expect(denied(`cat >> report.md <<'EOF'\n${FORCE}\nEOF`)).toBe(false);
      expect(denied(`cd docs && cat > report.md <<'EOF'\n${FORCE}\nEOF`)).toBe(false);
      expect(denied(`git commit -F - <<'EOF'\n${FORCE}\nEOF`)).toBe(false);
      expect(denied(`cat <<-'EOF' > a.md\n	${FORCE}\n	EOF`)).toBe(false);
    });
    it('anything that could run it still stops', () => {
      expect(denied(FORCE)).toBe(true);
      expect(denied(`cat > a.md <<'EOF'\ntext\nEOF\n${FORCE}`)).toBe(true);
      expect(denied(`${FORCE} && cat > a.md <<'EOF'\ntext\nEOF`)).toBe(true);
      // Unquoted delimiter (substitutions run), a pipe, no redirect, no end: the text stays visible to the guard.
      expect(denied(`cat > a.md <<EOF\n${FORCE}\nEOF`)).toBe(true);
      expect(denied(`cat <<'EOF' | bash\n${FORCE}\nEOF`)).toBe(true);
      expect(denied(`cat <<'EOF'\n${FORCE}\nEOF`)).toBe(true);
      expect(denied(`bash <<'EOF'\n${FORCE}\nEOF`)).toBe(true);
      expect(denied(`cat > a.md <<'EOF'\n${FORCE}`)).toBe(true);
    });
    it('reading the list still works', () => {
      expect(SC.commandList(`cat > a.md <<'EOF'\nrm -rf x\nEOF`).commands).toHaveLength(1);
    });
  });
});

describe('test round 4, P1', () => {
  const ASKS = 'RESULT status=PARTIAL branch=queue/A commits=1 migr=- gates=- probe=- ownerQuestions=1 edge=-\n\nOwner questions:\n1. Which name?';
  const inWorktree = () => {
    const p = project([task('A', { status: 'running', branch: 'queue/A', started: new Date().toISOString() })]);
    p.branch('A');
    return { p, wt: p.worktree('A') };
  };
  const onBranch = (p: ReturnType<typeof project>, wt: string) => p.g(['branch', '--show-current'], wt);

  it('resume frees the branch when the old agent reported and its worktree is clean', () => {
    const { p, wt } = inWorktree();
    const tip = p.g(['rev-parse', 'queue/A']);
    p.report('A', ASKS);
    p.run(['receive', 'A']);
    const r = p.run(['resume', 'A', '--reason', 'context', '--answer', 'Call it halv2']);
    expect(r.code, r.error).toBe(0);
    expect(r.out).toContain('freed for the new agent');
    expect(r.out).not.toContain('NOTE: queue/A is checked out');
    expect(onBranch(p, wt)).toBe('');
    expect(p.g(['rev-parse', 'queue/A'])).toBe(tip);
  });
  it('resume leaves a worktree with uncommitted work alone', () => {
    const { p, wt } = inWorktree();
    p.report('A', ASKS);
    p.run(['receive', 'A']);
    fs.writeFileSync(path.join(wt, 'half.txt'), 'half\n');
    const r = p.run(['resume', 'A', '--reason', 'context']);
    expect(r.out).toContain('NOTE: queue/A is checked out');
    expect(onBranch(p, wt)).toBe('queue/A');
    expect(fs.existsSync(path.join(wt, 'half.txt'))).toBe(true);
  });
  it('resume leaves the branch where it is when no report says the old agent is done', () => {
    const { p, wt } = inWorktree();
    const r = p.run(['resume', 'A', '--reason', 'context']);
    expect(r.out).toContain('NOTE: queue/A is checked out');
    expect(onBranch(p, wt)).toBe('queue/A');
  });
  it('a fix round leaves the worktree on the branch: it may be fixed right there', () => {
    const { p, wt } = inWorktree();
    p.report('A', RESULT('A'));
    p.run(['receive', 'A']);
    const r = p.run(['resume', 'A', '--reason', 'fix']);
    expect(r.code, r.error).toBe(0);
    expect(r.out).toContain('NOTE: queue/A is checked out');
    expect(onBranch(p, wt)).toBe('queue/A');
  });
  it('resume never detaches the main checkout', () => {
    const p = project([task('A', { status: 'running', branch: 'queue/A', started: new Date().toISOString() })]);
    p.branch('A');
    p.report('A', ASKS);
    p.run(['receive', 'A']);
    p.g(['checkout', '-q', 'queue/A']);
    const r = p.run(['resume', 'A', '--reason', 'context']);
    expect(r.out).toContain('NOTE: queue/A is checked out');
    expect(onBranch(p, p.repo)).toBe('queue/A');
  });
  it('the takeover warning says what it saw (F9), and the expiry is in English (F3)', () => {
    const p = project([task('A')]);
    expect(p.run(['start', 'A']).code).toBe(0);
    const text = () => spawnSync(process.execPath, [path.join(SCRIPTS, 'queue-takeover.mjs')], { encoding: 'utf8', env: p.env, cwd: p.folder }).stdout;
    expect(text()).toContain('another orchestrator may be alive (seen: start A, session "orchestrator"; if that was you, carry on)');
    p.patch('A', (o) => { (o as Record<string, unknown>).status = 'running'; });
    fs.writeFileSync(path.join(p.folder, 'orchestrator.json'), JSON.stringify({ session: 'gone', updated: new Date(Date.now() - 5 * 3_600_000).toISOString(), event: 'pulse' }));
    expect(text()).toContain('(seen: running: A; if that was you, carry on)');
    expect(text()).toContain('expired (over 2 h)');
  });
  it('an answer to a track counts as decided today (F11)', () => {
    const p = project([task('A', { status: 'running', branch: 'queue/A', started: new Date().toISOString() })]);
    p.branch('A');
    p.report('A', ASKS);
    p.run(['receive', 'A']);
    expect(p.run(['decide', '--today']).out).not.toContain('Call it halv2');
    expect(p.run(['resume', 'A', '--reason', 'context', '--answer', 'Call it halv2']).code).toBe(0);
    expect(p.run(['decide', '--today']).out).toContain('Call it halv2');
  });
  it('a continuation without a handover does not point at one (F12)', () => {
    const p = project([task('A', { status: 'running', branch: 'queue/A', started: new Date().toISOString() })]);
    p.branch('A');
    p.report('A', ASKS);
    p.run(['receive', 'A']);
    expect(p.run(['resume', 'A', '--reason', 'context', '--answer', 'Call it halv2']).code).toBe(0);
    const brief = fs.readFileSync(path.join(p.scratch, 'prompt-A-r1.md'), 'utf8');
    expect(brief).toContain('its report and commits show what is left');
    expect(brief).not.toContain('from the handover, with');
  });
  it('the merge line mentions a review only when one starts (F14)', () => {
    const receive = (helperOff: boolean) => {
      const p = project([task('A', { status: 'running', branch: 'queue/A', started: new Date().toISOString() })]);
      p.branch('A');
      p.report('A', RESULT('A'));
      if (helperOff) expect(p.run(['helpers', 'off', 'reviewer-light']).code).toBe(0);
      return p.run(['receive', 'A']).out;
    };
    const none = receive(true);
    expect(none).toContain('no review');
    expect(none).toContain('Merge (from Bash): ');
    expect(none).not.toContain('after an approved review');
    expect(receive(false)).toContain('Merge (after an approved review, from Bash): ');
  });
  it('cq add names a field the queue does not read (F4)', () => {
    const p = project([task('A')]);
    const wrong = p.run(['add', '--json', JSON.stringify(task('B', { minutes: 10 }))]);
    expect(wrong.code, wrong.error).toBe(0);
    expect(wrong.out).toContain('WARNING: B: the queue does not read "minutes"; the field is content_min.');
    expect(p.run(['add', '--json', JSON.stringify(task('C', { content_min: 40 }))]).out).not.toContain('does not read');
  });
  it('cq edit names the flag it did not understand (F5)', () => {
    const p = project([task('A')]);
    const r = p.run(['edit', 'A', '--filez', 'x']);
    expect(r.code).toBe(1);
    expect(r.out + r.error).toContain('Nothing changed: edit does not know --filez. edit A needs');
    expect(p.run(['edit', 'A']).error + p.run(['edit', 'A']).out).toContain('Nothing changed: edit A needs');
  });
});
