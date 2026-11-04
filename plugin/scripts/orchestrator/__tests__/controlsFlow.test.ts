// =============================================================
// controlsFlow.test.ts: a project with no gates or no CI, through the real hook and real receive and merge.
//
// Locks: (1) the push guard asks on a first push, with what is missing and the commit count, never denies, and goes quiet
// with the setting off or with both controls there; (2) receive says no checks ran and writes the light review's prompt;
// (3) merge records verification: unverified with nothing, audited with a reviewer's FINDINGS line, verified with a passed
// gate; (4) the board row carries it. The merge step itself is injected, the gates and the queue are real.
// =============================================================
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ORCH = path.resolve(__dirname, '..');
const QUEUE = path.join(ORCH, 'queue.mjs');
const HOOK = path.join(ORCH, 'hook-push-guard.mjs');
const ID = ['-c', 'user.name=queue-test', '-c', 'user.email=queue-test@example.invalid'];
const RES = 'RESULT status=DONE branch=queue/A commits=1 migr=- gates=OK probe=- ownerQuestions=0 edge=-';
const OK_GATE = 'node -e "process.exit(0)"';
/* eslint-disable-next-line @typescript-eslint/no-require-imports */
const BOARD = require('../lib/queueBoard.js');

const temporary: string[] = [];
afterAll(() => {
  for (const m of temporary) {
    try {
      fs.rmSync(m, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    } catch {
      /* left for the OS */
    }
  }
});

/** A temporary project: repo on develop, queue/A in a worktree with one commit, task A running. */
function project(config: Record<string, unknown> = {}, { ci = false } = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-controls-flow-'));
  temporary.push(folder);
  const repo = path.join(folder, 'repo');
  const worktree = path.join(folder, 'wt-A');
  const scratch = path.join(folder, 'scratch');
  fs.mkdirSync(repo);
  fs.mkdirSync(path.join(scratch, 'A'), { recursive: true });
  fs.writeFileSync(path.join(scratch, 'A', 'report.md'), `${RES}\n`);
  const globalConfig = path.join(folder, 'global-gitconfig');
  fs.writeFileSync(globalConfig, '');
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    QUEUE_FOLDER: folder,
    QUEUE_CONFIG: path.join(folder, 'queue.config.json'),
    QUEUE_ROOT: folder,
    QUEUE_GIT: repo,
    QUEUE_TIME_LOG: path.join(folder, 'times.jsonl'),
    QUEUE_TRANSCRIPTS: path.join(folder, 'transcripts'),
  } as NodeJS.ProcessEnv;
  delete env.QUEUE_SCRATCHPAD;
  delete env.QUEUE_SESSION;
  const g = (args: string[], cwd = repo) =>
    execFileSync('git', ['-C', cwd, ...ID, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  g(['init', '-q', '-b', 'develop']);
  fs.writeFileSync(path.join(repo, 'README.md'), 'start\n');
  g(['add', '--', 'README.md']);
  g(['commit', '-q', '-m', 'start']);
  g(['branch', 'queue/A']);
  g(['worktree', 'add', '-q', worktree, 'queue/A']);
  fs.writeFileSync(path.join(worktree, 'a.txt'), 'a\n');
  g(['add', '--', 'a.txt'], worktree);
  g(['commit', '-q', '-m', 'feat: A'], worktree);
  if (ci) {
    fs.mkdirSync(path.join(folder, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(folder, '.github', 'workflows', 'ci.yml'), 'on: push\n');
  }
  fs.writeFileSync(env.QUEUE_CONFIG as string, JSON.stringify({ baseBranch: 'develop', maxFixRounds: 3, ...config }));
  const started = '2026-01-01T00:00:00.000Z';
  fs.writeFileSync(
    path.join(folder, 'queue.json'),
    JSON.stringify({
      created: started,
      limits: {},
      next_migr: 3600,
      resolved: [],
      tasks: [
        {
          id: 'A', title: 'Task A', domain: 'dom-A', class: 'K', status: 'running', mission: 'The mission.', value: 5,
          content_min: 60, depends_on: [], waiting_on: [], owned_files: ['a.txt'], started, branch: 'queue/A',
          migr_block: null, scratchpad: scratch,
        },
      ],
    }),
  );
  // The merge step is injected (a plain git merge); the gates step runs the real gates.mjs.
  const runner = path.join(folder, 'runner.mjs');
  fs.writeFileSync(
    runner,
    [
      "import { spawnSync } from 'node:child_process';",
      `const ID = ${JSON.stringify(ID)};`,
      'export default ({ step, cmd, args }) => {',
      '  const repo = process.env.QUEUE_GIT;',
      "  const r = step === 'merge'",
      "    ? spawnSync('git', ['-C', repo, ...ID, 'merge', '--no-ff', '--no-edit', args[1]], { encoding: 'utf8' })",
      "    : spawnSync(cmd, args, { cwd: repo, encoding: 'utf8', env: process.env });",
      "  return { code: r.status ?? 1, out: (r.stdout ?? '') + (r.stderr ?? '') };",
      '};',
      '',
    ].join('\n'),
  );
  const run = (...args: string[]) => {
    const r = spawnSync(process.execPath, [QUEUE, ...args], { encoding: 'utf8', env: { ...env, QUEUE_MERGE_RUNNING: runner }, cwd: folder });
    return { code: r.status, all: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  /** The push guard's answer to a plain push of the base branch: { decision, reason } or null. */
  const push = (command = 'git push origin develop') => {
    const r = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ tool_input: { command }, cwd: repo }),
      encoding: 'utf8',
      env,
      cwd: folder,
    });
    if (!r.stdout.trim()) return null;
    const h = JSON.parse(r.stdout).hookSpecificOutput;
    return { decision: h.permissionDecision as string, reason: h.permissionDecisionReason as string };
  };
  const queue = () => JSON.parse(fs.readFileSync(path.join(folder, 'queue.json'), 'utf8'));
  const task = () => queue().tasks[0];
  /** The card the board builds for task A, from the queue file the real merge wrote. */
  const card = () => {
    const q = queue();
    const columns = BOARD.board(q, q.tasks).columns as Record<string, { id: string }[]>;
    return Object.values(columns).flat().find((c) => c.id === 'A') as unknown as Record<string, unknown>;
  };
  /** A reviewer that answered with a FINDINGS line, the way the time log and the transcripts show it. */
  const reviewerAnswered = () => {
    const session = path.join(folder, 'transcripts', 'session1', 'subagents');
    fs.mkdirSync(session, { recursive: true });
    const time = new Date().toISOString();
    fs.writeFileSync(
      path.join(session, 'agent-revA.jsonl'),
      [
        JSON.stringify({ type: 'user', timestamp: time, message: { content: `Review rev-A\\reviewer-reviewer-light.md for A` } }),
        JSON.stringify({
          type: 'assistant',
          timestamp: time,
          message: { id: 'r1', role: 'assistant', content: [{ type: 'text', text: 'FINDINGS H=0 M=0 L=0 deferrable=0' }], usage: { input_tokens: 1, output_tokens: 1 } },
        }),
      ].join('\n'),
    );
    fs.appendFileSync(
      env.QUEUE_TIME_LOG as string,
      `${JSON.stringify({ time, wave: 'queue', track: 'A', event: 'done', agent_id: 'revA', agent_type: 'reviewer-light', tokens: { input: 1 }, model: 'claude-opus-5-5' })}\n`,
    );
  };
  return { folder, run, push, task, card, reviewerAnswered };
}

describe('the push guard with a missing control', () => {
  it('asks on a first push, says what is missing and how many commits, and never denies', () => {
    const p = project();
    const a = p.push();
    expect(a?.decision).toBe('ask');
    expect(a?.reason).toContain('1 commit(s) with no CI config and no gates');
    expect(a?.reason).toContain('/cq:kickstart');
  });
  it('names only what is missing', () => {
    expect(project({ gates: { quick: [OK_GATE] } }).push()?.reason).toContain('with no CI config, so');
    expect(project({}, { ci: true }).push()?.reason).toContain('with no gates, so');
  });
  it('is quiet with both controls there, and with the setting off', () => {
    expect(project({ gates: { quick: [OK_GATE] } }, { ci: true }).push()).toBeNull();
    expect(project({ push: { controlsWarning: false } }).push()).toBeNull();
  });
  it('does not soften a forced push', () => {
    expect(project().push('git push --force origin develop')?.decision).toBe('deny');
  });
});

describe('receive and merge with no checks', () => {
  it('receive warns and prepares the light review, merge records unverified, and the board row shows it', () => {
    const p = project();
    const r = p.run('receive', 'A');
    expect(r.code).toBe(0);
    expect(r.all).toContain('NO CHECKS RAN');
    expect(r.all).toContain('Light review: no CI config, no gates');
    expect(fs.existsSync(path.join(p.folder, 'scratch', 'rev-A', 'reviewer-reviewer-light.md'))).toBe(true);
    const m = p.run('merge', 'A', '--without-fill');
    expect(m.code).toBe(0);
    expect(m.all).toContain('MERGED, NOT VERIFIED');
    expect(p.task().verification.status).toBe('unverified');
    expect(p.task().verification.sha).toBeTruthy();
    expect(p.card()).toMatchObject({ verification: 'unverified', verification_checks: [] });
  });
  it('a reviewer that answered makes it audited, not verified', () => {
    const p = project();
    expect(p.run('receive', 'A').code).toBe(0);
    p.reviewerAnswered();
    const m = p.run('merge', 'A', '--without-fill');
    expect(m.code).toBe(0);
    expect(m.all).toContain('AUDITED, not verified');
    expect(p.task().verification).toMatchObject({ status: 'audited', checks: ['agent review'] });
  });
  it('the switch leaves the warning but no light review', () => {
    const p = project({ helpers: { 'reviewer-light': { enabled: false } } });
    const r = p.run('receive', 'A');
    expect(r.all).toContain('NO CHECKS RAN');
    expect(r.all).not.toContain('Light review');
  });
});

describe('receive and a known bug', () => {
  const report = (p: { folder: string }, text: string) => fs.writeFileSync(path.join(p.folder, 'scratch', 'A', 'report.md'), `${RES}\n${text}\n`);
  const gateTasks = (p: { folder: string }) =>
    JSON.parse(fs.readFileSync(path.join(p.folder, 'queue.json'), 'utf8')).tasks.filter((o: { labels?: string[] }) => o.labels?.includes('gate'));

  it('a GATE line in the report becomes a proposed gate task naming the task, once', () => {
    const p = project();
    report(p, 'GATE a fetch result used without its error');
    const r = p.run('receive', 'A');
    expect(r.code).toBe(0);
    expect(r.all).toContain('GATE-1 proposed');
    expect(gateTasks(p)).toMatchObject([{ id: 'GATE-1', status: 'proposed' }]);
    expect(gateTasks(p)[0].mission).toContain('task A');
    expect(p.run('receive', 'A').code).toBe(0);
    expect(gateTasks(p)).toHaveLength(1);
  });
  it('with the setting off the line does nothing, and the delivery goes on', () => {
    const p = project({ gates: { fromKnownBugs: 'off' } });
    report(p, 'GATE a fetch result used without its error');
    expect(p.run('receive', 'A').code).toBe(0);
    expect(gateTasks(p)).toEqual([]);
  });
});

describe('receive and merge with checks', () => {
  it('no warning and no light review with gates and CI, and merge records verified', () => {
    const p = project({ gates: { quick: [OK_GATE] } }, { ci: true });
    const r = p.run('receive', 'A');
    expect(r.code).toBe(0);
    expect(r.all).not.toContain('NO CHECKS RAN');
    expect(r.all).not.toContain('Light review');
    const m = p.run('merge', 'A', '--without-fill');
    expect(m.code).toBe(0);
    expect(m.all).toContain('Verified: your checks passed (quick gates)');
    expect(p.task().verification).toMatchObject({ status: 'verified', checks: ['quick gates'] });
  });
  it('gates without CI get the light review, but no "no checks" warning', () => {
    const r = project({ gates: { quick: [OK_GATE] } }).run('receive', 'A');
    expect(r.all).not.toContain('NO CHECKS RAN');
    expect(r.all).toContain('Light review: no CI config');
  });
});
