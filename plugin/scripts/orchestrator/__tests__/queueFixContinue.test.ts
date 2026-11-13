// =============================================================
// queueFixContinue.test.ts: the fix round as a continuation, the short fix mission and the delta review, end to end.
//
// Locks, against a temporary queue and git repo (as queueAdopt.test.ts; never the main repo or the real queue):
//   1. `resume --reason fix` continues the agent that delivered when it is still addressable (its transcript in the
//      bound orchestrator session, its worktree still there, last active within fixRound.continueWithinMin): a fix
//      brief and the exact message, no new prompt and no attempt; `resumed` records mode continue and the agent.
//   2. The next receive makes a delta package: only the commits since the last review, the previous findings, and the
//      whole diff as a context file. The reviewers are the same as before.
//   3. `resume --reason fix --new-agent` writes a short mission: the fix list, the ownership, the gates, and a pointer
//      to the original mission instead of its text.
// =============================================================
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type Task = Record<string, unknown> & { id: string; status: string };

const ROOT = path.resolve(__dirname, '..', '..', '..');
const ID = ['-c', 'user.name=queue-test', '-c', 'user.email=queue-test@example.invalid'];
const RES = 'RESULT status=DONE branch=queue/A commits=1 migr=- gates=OK probe=- ownerQuestions=0 edge=-';
const temporary: string[] = [];
afterAll(() => {
  for (const m of temporary) fs.rmSync(m, { recursive: true, force: true });
});

describe('queue.mjs: fix round as continuation, short mission and delta review', () => {
  it('continues the agent, then reviews only the new commits, then writes a short mission for a new agent', () => {
    // The long form: on a CI runner os.tmpdir() is an 8.3 short path (RUNNER~1), and git prints the long one.
    const folder = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'queue-fixcont-')));
    temporary.push(folder);
    const repo = path.join(folder, 'repo');
    const scratch = path.join(folder, 'scratch');
    const wt = path.join(folder, 'wt-A');
    fs.mkdirSync(repo);
    fs.mkdirSync(scratch);
    const g = (args: string[], cwd = repo) =>
      execFileSync('git', ['-C', cwd, ...ID, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    g(['init', '-q', '-b', 'develop']);
    fs.writeFileSync(path.join(repo, 'README.md'), 'start\n');
    g(['add', '--', 'README.md']);
    g(['commit', '-q', '-m', 'start']);
    g(['branch', 'queue/A']);
    // The track's worktree, still there after it delivered (the agent's own checkout of the branch).
    g(['worktree', 'add', '-q', wt, 'queue/A']);
    fs.mkdirSync(path.join(wt, 'src'));
    fs.writeFileSync(path.join(wt, 'src', 'a.ts'), 'export const a = 1;\n');
    g(['add', '--', 'src/a.ts'], wt);
    g(['commit', '-q', '-m', 'feat: A'], wt);
    const task: Task = {
      id: 'A',
      title: 'Task A',
      domain: 'dom-A',
      class: 'K',
      status: 'running',
      mission: 'The long original mission text for A.',
      value: 5,
      content_min: 60,
      migr_tens: 0,
      depends_on: [],
      waiting_on: [],
      owned_files: ['src/a.ts', 'src/b.ts'],
      started: new Date(Date.now() - 3_600_000).toISOString(),
      branch: 'queue/A',
      migr_block: null,
      scratchpad: scratch,
    };
    fs.writeFileSync(
      path.join(folder, 'queue.json'),
      JSON.stringify({ created: task.started, limits: {}, next_migr: 3600, resolved: [], tasks: [task] }),
    );
    const configFile = path.join(folder, 'queue.config.json');
    fs.writeFileSync(configFile, JSON.stringify({ baseBranch: 'develop', reviewers: { K: ['reviewer'] } }));
    fs.mkdirSync(path.join(folder, 'docs'));
    fs.copyFileSync(path.join(ROOT, 'docs', 'mission-template.md'), path.join(folder, 'docs', 'mission-template.md'));
    const transcripts = path.join(folder, 'transcripts');
    const timeLog = path.join(folder, 'times.jsonl');
    const env = {
      ...process.env,
      QUEUE_FOLDER: folder,
      QUEUE_CONFIG: configFile,
      QUEUE_ROOT: folder,
      QUEUE_GIT: repo,
      QUEUE_TIME_LOG: timeLog,
      QUEUE_TRANSCRIPTS: transcripts,
    } as NodeJS.ProcessEnv;
    delete env.QUEUE_SCRATCHPAD;
    delete env.QUEUE_SESSION;
    const run = (...args: string[]) => {
      const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'orchestrator', 'queue.mjs'), ...args], {
        encoding: 'utf8',
        env,
      });
      return { code: r.status, out: r.stdout, error: r.stderr };
    };
    const find = () => (JSON.parse(fs.readFileSync(path.join(folder, 'queue.json'), 'utf8')) as { tasks: Task[] }).tasks[0];

    // The track delivers, and receive makes the first (whole) package.
    fs.mkdirSync(path.join(scratch, 'A'));
    fs.writeFileSync(path.join(scratch, 'A', 'track-result.md'), `${RES}\n\n# Report A\n`);
    const m1 = run('receive', 'A');
    expect(m1.error).toBe('');
    expect(m1.code).toBe(0);
    const first = find();
    const tip1 = g(['rev-parse', 'queue/A']);
    expect(first.review_sha).toBe(tip1);
    expect(first.review_base).toBe(g(['merge-base', 'develop', 'queue/A']));
    expect(fs.readFileSync(path.join(scratch, 'rev-A', '00-package.md'), 'utf8')).not.toContain('Delta review');

    // The agent that delivered: a done row a few minutes ago, its transcript in the bound orchestrator session.
    const agent = 'agentA0';
    const doneAt = new Date(Date.now() - 5 * 60_000).toISOString();
    fs.writeFileSync(
      timeLog,
      [
        { time: task.started, wave: 'w', track: 'A', event: 'start', agent_id: agent, agent_type: 'track' },
        { time: doneAt, wave: 'w', track: 'A', event: 'done', agent_id: agent, agent_type: 'track', context: { start: 20_000, median: 60_000, end: 90_000 } },
      ]
        .map((r) => JSON.stringify(r))
        .join('\n') + '\n',
    );
    fs.mkdirSync(path.join(transcripts, 'sess-1', 'subagents'), { recursive: true });
    const transcript = path.join(transcripts, 'sess-1', 'subagents', `agent-${agent}.jsonl`);
    fs.writeFileSync(transcript, '{}\n');
    const quiet = (Date.now() - 5 * 60_000) / 1000;
    fs.utimesSync(transcript, quiet, quiet);
    fs.writeFileSync(
      path.join(folder, 'orchestrator.json'),
      JSON.stringify({ session: 'orchestrator', updated: new Date().toISOString(), event: 'x', session_id: 'sess-1' }),
    );

    // 1. resume --reason fix: continuation of the same agent.
    fs.writeFileSync(path.join(scratch, 'findings.md'), 'FINDINGS H=1 M=0 L=0\n- H1 src/a.ts:1 the value');
    const res = run('resume', 'A', '--reason', 'fix', '--findings-file', path.join(scratch, 'findings.md'), '--from', 'reviewer');
    expect(res.error).toBe('');
    expect(res.code).toBe(0);
    expect(res.out).toContain('CONTINUE A (fix round 1)');
    expect(res.out).toContain(agent);
    expect(res.out).toMatch(/SendMessage/);
    expect(res.out).toContain('last active 5 min ago, context about 90k');
    expect(res.out).toContain('--new-agent');
    const brief = path.join(scratch, 'fix-A-r1.md');
    expect(res.out).toContain(brief);
    const briefText = fs.readFileSync(brief, 'utf8');
    expect(briefText).toContain('# Fix round 1 for A (continuation of the same agent)');
    expect(briefText).toContain(path.join(scratch, 'findings-A-r1.md'));
    expect(briefText).toContain(wt);
    expect(briefText).not.toContain('The long original mission text for A.');
    expect(fs.readFileSync(path.join(scratch, 'findings-A-r1.md'), 'utf8')).toContain('H1 src/a.ts:1');
    expect(fs.existsSync(path.join(scratch, 'prompt-A-r1.md'))).toBe(false);
    const cont = find();
    expect(cont.resumed).toMatchObject([
      { round: 1, reason: 'fix', mode: 'continue', agent, from: ['reviewer'], findings: path.join(scratch, 'findings-A-r1.md') },
    ]);
    expect(cont.attempts ?? []).toEqual([]);

    // 2. The agent fixes in its worktree and reports again: the next receive reviews only the new commit.
    fs.writeFileSync(path.join(wt, 'src', 'b.ts'), 'export const b = 2;\n');
    g(['add', '--', 'src/b.ts'], wt);
    g(['commit', '-q', '-m', 'fix: A finding H1'], wt);
    const r1 = path.join(scratch, 'A', 'track-result.md');
    fs.writeFileSync(r1, `${RES.replace('commits=1', 'commits=2')}\n\n# Report A, fix round 1\n`);
    const later = Date.now() / 1000 + 120;
    fs.utimesSync(r1, later, later);
    const m2 = run('receive', 'A');
    expect(m2.error).toBe('');
    expect(m2.code).toBe(0);
    expect(m2.out).toMatch(/Delta review/);
    const pkg = path.join(scratch, 'rev-A');
    const index = fs.readFileSync(path.join(pkg, '00-package.md'), 'utf8');
    expect(index).toContain('## Delta review (after fix round 1)');
    const patch = fs.readFileSync(path.join(pkg, 'diff.patch'), 'utf8');
    expect(patch).toContain('src/b.ts');
    expect(patch).not.toContain('src/a.ts');
    expect(fs.existsSync(path.join(pkg, 'files', 'src', 'b.ts'))).toBe(true);
    expect(fs.existsSync(path.join(pkg, 'files', 'src', 'a.ts'))).toBe(false);
    expect(fs.readFileSync(path.join(pkg, 'diff-full.patch'), 'utf8')).toContain('src/a.ts');
    expect(fs.readFileSync(path.join(pkg, 'previous-findings.md'), 'utf8')).toContain('H1 src/a.ts:1');
    // The same reviewers, told it is a delta.
    expect(fs.readFileSync(path.join(pkg, 'reviewer-reviewer.md'), 'utf8')).toMatch(/delta review after fix round 1/i);
    expect(find().review_sha).toBe(g(['rev-parse', 'queue/A']));
    // --full-review gives the whole package again.
    fs.utimesSync(r1, later + 60, later + 60);
    const m3 = run('receive', 'A', '--full-review');
    expect(m3.code).toBe(0);
    expect(fs.readFileSync(path.join(pkg, '00-package.md'), 'utf8')).not.toContain('Delta review');
    expect(fs.readFileSync(path.join(pkg, 'diff.patch'), 'utf8')).toContain('src/a.ts');

    // 3. A new agent (asked for): a short mission with a pointer to the original one, not its text.
    fs.writeFileSync(path.join(scratch, 'findings2.md'), 'FINDINGS H=1 M=0 L=0\n- H2 src/b.ts:1 another');
    const res2 = run('resume', 'A', '--reason', 'fix', '--findings-file', path.join(scratch, 'findings2.md'), '--new-agent');
    expect(res2.error).toBe('');
    expect(res2.code).toBe(0);
    expect(res2.out).toContain('RESUME A-r2 (fix)');
    expect(res2.out).toContain('new agent: asked for a new agent (--new-agent)');
    const prompt = fs.readFileSync(path.join(scratch, 'prompt-A-r2.md'), 'utf8');
    expect(prompt).toContain('## Fix round 2 for A');
    expect(prompt).toContain('prepare-track A-r2 --branch queue/A --continue');
    expect(prompt).toContain('**Ownership in the queue:** files src/a.ts, src/b.ts');
    expect(prompt).toContain(path.join(scratch, 'findings-A-r2.md'));
    expect(prompt).not.toContain('The long original mission text for A.');
    const original = path.join(scratch, 'mission-A.md');
    expect(prompt).toContain(original);
    expect(fs.readFileSync(original, 'utf8')).toContain('The long original mission text for A.');
    expect(find().resumed).toMatchObject([{ round: 1, mode: 'continue' }, { round: 2, reason: 'fix', mode: 'new' }]);
  });
});
