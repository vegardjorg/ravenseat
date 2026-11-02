// =============================================================
// queueCiWatch.test.ts: `push-check.mjs --watch-ci <sha>` (cli/ciWatch.mjs), the optional CI safety net after a push.
//
// Locks: (1) a red CI check gives ONE fix task CI-<sha7> (value 10, waiting, the redacted log tail only in the report
// file) and marks the base red at that tip with the task as its fix task (exit 9); a second watch of the same sha (a
// rerun that is red again) adds no second task; (2) an infrastructure failure (a cancelled run) gives an owner
// question and no task, and the base stays as it was; a second watch adds no second question; (3) pending runs are
// polled until they are done, and green exits 0; (4) off by default: nothing is polled; (5) runs that never finish
// give TIMEOUT, exit 10 (as cq wait).
// gh is replaced by a module (QUEUE_CI_GH) that answers from a JSON file the test writes and logs every call. Runs
// against a temporary queue (QUEUE_FOLDER) and git repo (QUEUE_GIT); never the main repo, the real queue or GitHub.
// =============================================================
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type Task = Record<string, unknown> & { id: string; status: string };

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PUSH_CHECK = path.join(ROOT, 'scripts', 'orchestrator', 'push-check.mjs');
const ID = ['-c', 'user.name=queue-test', '-c', 'user.email=queue-test@example.invalid'];

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

const run = (over: Record<string, unknown> = {}) => ({
  databaseId: 101,
  name: 'CI',
  workflowName: 'CI',
  status: 'completed',
  conclusion: 'failure',
  url: 'https://github.com/o/r/actions/runs/101',
  attempt: 1,
  event: 'push',
  ...over,
});

function project(config: Record<string, unknown>) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-ciwatch-'));
  temporary.push(folder);
  const repo = path.join(folder, 'repo');
  fs.mkdirSync(repo);
  const g = (args: string[]) =>
    execFileSync('git', ['-C', repo, ...ID, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  g(['init', '-q', '-b', 'develop']);
  fs.writeFileSync(path.join(repo, 'README.md'), 'start\n');
  g(['add', '--', 'README.md']);
  g(['commit', '-q', '-m', 'start']);
  fs.writeFileSync(
    path.join(folder, 'queue.json'),
    JSON.stringify({
      created: '2026-01-01T00:00:00.000Z',
      limits: {},
      next_migr: 3600,
      resolved: [],
      projects: { app: { title: 'App', prefixes: ['A-'] } },
      tasks: [],
    }),
  );
  const configFile = path.join(folder, 'queue.config.json');
  fs.writeFileSync(configFile, JSON.stringify({ baseBranch: 'develop', gates: { quick: ['node -e "process.exit(0)"'] }, ...config }));
  const state = path.join(folder, 'gh-state.json');
  const calls = path.join(folder, 'gh-calls.log');
  const gh = path.join(folder, 'gh.mjs');
  // The fake gh: `run list` answers the next entry of `lists` (the last one again when they run out), `run view
  // --log-failed` the log, `run view --json jobs` the jobs. Every call is logged.
  fs.writeFileSync(
    gh,
    [
      "import fs from 'node:fs';",
      'export default (args) => {',
      `  fs.appendFileSync(${JSON.stringify(calls)}, args.join(' ') + '\\n');`,
      `  const s = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, 'utf8'));`,
      "  if (args[0] === 'run' && args[1] === 'list') {",
      `    const n = fs.readFileSync(${JSON.stringify(calls)}, 'utf8').split('\\n').filter((l) => l.startsWith('run list')).length;`,
      '    const list = s.lists[Math.min(n - 1, s.lists.length - 1)];',
      '    return { code: 0, out: JSON.stringify(list) };',
      '  }',
      "  if (args.includes('--log-failed')) return { code: 0, out: s.log ?? '' };",
      "  if (args.includes('--json')) return { code: 0, out: JSON.stringify({ jobs: s.jobs ?? [] }) };",
      "  return { code: 1, out: 'unknown gh call' };",
      '};',
      '',
    ].join('\n'),
  );
  const env = {
    ...process.env,
    QUEUE_FOLDER: folder,
    QUEUE_CONFIG: configFile,
    QUEUE_ROOT: folder,
    QUEUE_GIT: repo,
    QUEUE_TIME_LOG: path.join(folder, 'times.jsonl'),
    QUEUE_CI_GH: gh,
  } as NodeJS.ProcessEnv;
  delete env.QUEUE_SCRATCHPAD;
  delete env.QUEUE_SESSION;
  const setGh = (s: { lists: unknown[][]; log?: string; jobs?: unknown[] }) => fs.writeFileSync(state, JSON.stringify(s));
  const watch = (sha: string, ...extra: string[]) => {
    const r = spawnSync(process.execPath, [PUSH_CHECK, '--watch-ci', sha, '--interval', '0.05', ...extra], {
      encoding: 'utf8',
      env,
      timeout: 60_000,
    });
    return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  const queue = () => JSON.parse(fs.readFileSync(path.join(folder, 'queue.json'), 'utf8')) as { tasks: Task[]; question?: Record<string, Record<string, unknown>> };
  const health = () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(folder, 'base-health.json'), 'utf8'));
    } catch {
      return { current: null };
    }
  };
  const ghCalls = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean) : []);
  const tip = () => g(['rev-parse', 'develop']);
  const commit = (file: string) => {
    fs.writeFileSync(path.join(repo, file), `${file}\n`);
    g(['add', '--', file]);
    g(['commit', '-q', '-m', `add ${file}`]);
    return tip();
  };
  return { folder, setGh, watch, queue, health, ghCalls, tip, commit };
}

describe('push-check --watch-ci', () => {
  it('a red check gives one CI task and a red base; a rerun that is red again adds nothing', () => {
    const p = project({ push: { ciWatch: 'github' } });
    const sha = p.tip();
    const secret = `ghp_${'b'.repeat(40)}`;
    p.setGh({
      lists: [[run({ status: 'in_progress', conclusion: '' })], [run()]],
      log: `test\tRun tests\tFAIL src/a.test.ts\ntest\tRun tests\tAssertionError: expected 1 to be 2\ntest\tRun tests\tTOKEN=${secret}`,
      jobs: [{ name: 'test', conclusion: 'failure', steps: [{ name: 'Run tests', conclusion: 'failure' }] }],
    });
    const w = p.watch(sha);
    expect(w.out).toContain('CI RED');
    expect(w.code).toBe(9);
    const id = `CI-${sha.slice(0, 7)}`;
    const ci = p.queue().tasks.filter((t) => t.id.startsWith('CI-'));
    expect(ci.map((t) => t.id)).toEqual([id]);
    expect(ci[0]).toMatchObject({ status: 'waiting', value: 10, class: 'K', added_by: 'ci watch' });
    expect(String(ci[0].mission)).not.toContain('AssertionError');
    const report = path.join(p.folder, `ci-${sha.slice(0, 7)}.md`);
    const text = fs.readFileSync(report, 'utf8');
    expect(text).toContain('AssertionError: expected 1 to be 2');
    expect(text).not.toContain(secret);
    expect(String(ci[0].mission)).toContain(report);
    expect(p.health().current).toMatchObject({ tip: sha, status: 'red', fix_task: id });
    // Only the failed run's log was fetched (one --log-failed call for the one red run).
    expect(p.ghCalls().filter((c) => c.includes('--log-failed'))).toHaveLength(1);

    // The same sha again (a rerun, red again): no second task, no second fix task in the base health.
    const again = p.watch(sha);
    expect(again.code).toBe(9);
    expect(again.out).toContain(`${id} already exists`);
    expect(p.queue().tasks.filter((t) => t.id.startsWith('CI-') || t.id.startsWith('BASE-'))).toHaveLength(1);
    expect(p.health().current).toMatchObject({ status: 'red', fix_task: id });
  });

  it('an infrastructure failure asks the owner once and freezes nothing', () => {
    const p = project({ push: { ciWatch: 'github' } });
    const sha = p.tip();
    p.setGh({ lists: [[run({ conclusion: 'cancelled' })]], log: '' });
    const w = p.watch(sha);
    expect(w.code).toBe(0);
    expect(w.out).toContain('CI INFRA');
    const qid = `ci-${sha.slice(0, 7)}-infra`;
    const q = p.queue();
    expect(q.question?.[qid]).toMatchObject({ type: 'question', source: 'ci watch' });
    expect(q.tasks).toHaveLength(0);
    expect(p.health().current).toBeNull();
    const added = q.question?.[qid]?.added_at;
    expect(p.watch(sha).out).toContain(`${qid} is already asked`);
    expect(Object.keys(p.queue().question ?? {})).toEqual([qid]);
    expect(p.queue().question?.[qid]?.added_at).toBe(added);
  });

  it('polls pending runs until they are done; green exits 0', () => {
    const p = project({ push: { ciWatch: 'github' } });
    const sha = p.commit('b.txt');
    p.setGh({
      lists: [[], [run({ status: 'queued', conclusion: '' })], [run({ conclusion: 'success' })]],
    });
    const w = p.watch(sha);
    expect(w.code).toBe(0);
    expect(w.out).toContain('CI GREEN');
    expect(p.ghCalls().filter((c) => c.startsWith('run list')).length).toBeGreaterThanOrEqual(3);
    expect(p.queue().tasks).toHaveLength(0);
  });

  it('off by default: nothing is polled', () => {
    const p = project({});
    p.setGh({ lists: [[run()]] });
    const w = p.watch(p.tip());
    expect(w.code).toBe(0);
    expect(w.out).toContain('push.ciWatch is off');
    expect(p.ghCalls()).toEqual([]);
  });

  it('runs that never finish give TIMEOUT, exit 10', () => {
    const p = project({ push: { ciWatch: 'github' } });
    p.setGh({ lists: [[run({ status: 'in_progress', conclusion: '' })]] });
    const w = p.watch(p.tip(), '--timeout', '0.005');
    expect(w.out).toContain('TIMEOUT');
    expect(w.code).toBe(10);
  });
});
