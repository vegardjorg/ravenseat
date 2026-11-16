// =============================================================
// reviewItemsFlow.test.ts: reviewer findings as items that stop `done`, and the merge gate (lib/reviewItems.js,
// cli/reviewItem.mjs), through the real CLI.
//
// Locks: (1) merge stops when a reviewer receive chose has no FINDINGS report after that receive, and when the newest
// report has H>0, with nothing merged; (2) `--allow-unreviewed` merges past it and logs "unreviewed-overridden";
// (3) merge records every FINDING line as an item keyed <reviewer>#<round>:<code>, and the done step refuses while one
// is open, naming the commands; (4) `review-item` refuses a mechanical item placed in a task and a rejection without a
// sentence, closes one with a commit on the base, one with a rejection and the deferrable LOWs with --defer-all-L into
// one new batch task; (5) `merge --resume` then sets the task done; (6) every close writes one finding log row with the
// disposition, and an L row does not count; (7) `set <id> done` refuses with an open item, and reviewItems.stop false
// lets it pass and says so; (8) a track worktree cannot close items.
// Runs queue.mjs against a temporary queue (QUEUE_FOLDER), a temporary git repo (QUEUE_GIT) with a worktree for the track
// branch, reviewer transcripts in QUEUE_TRANSCRIPTS and an injected merge runner (QUEUE_MERGE_RUNNING), as
// wiringFlow.test.ts. Never the main repo or queue.
// =============================================================
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type Item = {
  key: string;
  status: string;
  mark: string | null;
  disposition: { kind: string; ref: string; note?: string } | null;
};
type Task = Record<string, unknown> & {
  id: string;
  status: string;
  review_items?: Item[];
  review_at?: string;
};

const ROOT = path.resolve(__dirname, '..', '..', '..');
const ID = ['-c', 'user.name=queue-test', '-c', 'user.email=queue-test@example.invalid'];
const RES = 'RESULT status=DONE branch=queue/A commits=1 migr=- gates=OK probe=- ownerQuestions=0 edge=-';

const temporary: string[] = [];
afterAll(() => {
  for (const m of temporary)
    fs.rmSync(m, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 300,
    });
});

/** A temporary project: a repo on develop, a class D track branch queue/A in a worktree that adds lib/A.ts. */
function project(config: object = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-review-items-'));
  temporary.push(folder);
  const repo = path.join(folder, 'repo');
  const worktree = path.join(folder, 'wt-A');
  const scratch = path.join(folder, 'scratch');
  const transcripts = path.join(folder, 'transcripts');
  const timeLog = path.join(folder, 'times.jsonl');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.mkdirSync(scratch);
  const g = (args: string[], cwd = repo) =>
    execFileSync('git', ['-C', cwd, ...ID, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  g(['init', '-q', '-b', 'develop']);
  fs.writeFileSync(path.join(repo, 'src', 'routes.ts'), 'export const routes = [];\n');
  g(['add', '--', 'src/routes.ts']);
  g(['commit', '-q', '-m', 'start']);
  g(['branch', 'queue/A']);
  g(['worktree', 'add', '-q', worktree, 'queue/A']);
  fs.mkdirSync(path.join(worktree, 'lib'));
  fs.writeFileSync(path.join(worktree, 'lib', 'A.ts'), 'export const a = 1;\n');
  g(['add', '--', 'lib/A.ts'], worktree);
  g(['commit', '-q', '-m', 'feat: A'], worktree);
  const task: Task = {
    id: 'A',
    title: 'Task A',
    domain: 'dom-A',
    class: 'D',
    status: 'running',
    mission: 'The mission for A.',
    value: 5,
    content_min: 60,
    depends_on: [],
    waiting_on: [],
    owned_files: ['lib/A.ts'],
    started: '2026-01-01T00:00:00.000Z',
    branch: 'queue/A',
    migr_block: null,
    scratchpad: scratch,
  };
  fs.writeFileSync(
    path.join(folder, 'queue.json'),
    JSON.stringify({
      created: task.started,
      limits: {},
      next_migr: 3600,
      resolved: [],
      tasks: [task],
    }),
  );
  const configFile = path.join(folder, 'queue.config.json');
  fs.writeFileSync(configFile, JSON.stringify({ baseBranch: 'develop', ...config }));
  fs.mkdirSync(path.join(folder, 'docs'));
  fs.copyFileSync(path.join(ROOT, 'docs', 'mission-template.md'), path.join(folder, 'docs', 'mission-template.md'));
  const runner = path.join(folder, 'runner.mjs');
  fs.writeFileSync(
    runner,
    [
      "import { spawnSync } from 'node:child_process';",
      'export default (x) => {',
      "  if (x.step === 'merge') spawnSync('git', ['-C', process.env.QUEUE_GIT, '-c', 'user.name=queue-test', '-c', 'user.email=queue-test@example.invalid', 'merge', '--no-ff', '--no-edit', x.args[1]], { encoding: 'utf8' });",
      "  if (x.step === 'done') { const r = spawnSync(x.cmd, x.args, { encoding: 'utf8', env: process.env }); return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }; }",
      "  return { code: 0, out: '' };",
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
    QUEUE_TIME_LOG: timeLog,
    QUEUE_TRANSCRIPTS: transcripts,
    QUEUE_MERGE_RUNNING: runner,
  } as NodeJS.ProcessEnv;
  delete env.QUEUE_SCRATCHPAD;
  delete env.QUEUE_SESSION;
  const run = (args: string[], cwd = folder) => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'orchestrator', 'queue.mjs'), ...args], {
      encoding: 'utf8',
      env,
      cwd,
    });
    return {
      code: r.status,
      out: r.stdout ?? '',
      error: r.stderr ?? '',
      all: `${r.stdout ?? ''}${r.stderr ?? ''}`,
    };
  };
  const queue = () =>
    JSON.parse(fs.readFileSync(path.join(folder, 'queue.json'), 'utf8')) as {
      tasks: Task[];
    };
  const find = (id = 'A') => queue().tasks.find((x) => x.id === id) as Task;
  const report = (text: string) => {
    fs.mkdirSync(path.join(scratch, 'A'), { recursive: true });
    const f = path.join(scratch, 'A', 'track-result.md');
    fs.writeFileSync(f, text);
    const later = Date.now() / 1000 + 60;
    fs.utimesSync(f, later, later);
  };
  /** A reviewer that answered: its done row in the time log and its transcript with the answer. */
  const reviewer = (agent: string, type: string, answer: string, time: string) => {
    fs.appendFileSync(
      timeLog,
      `${JSON.stringify({ time, wave: 'queue', track: 'A', event: 'done', agent_id: agent, agent_type: type, tokens: { input: 1, output: 1 }, model: 'claude-opus-5-5' })}\n`,
    );
    const dir = path.join(transcripts, 'sess-1', 'subagents');
    fs.mkdirSync(dir, { recursive: true });
    const row = {
      type: 'assistant',
      message: { content: [{ type: 'text', text: answer }] },
    };
    fs.writeFileSync(path.join(dir, `agent-${agent}.jsonl`), `${JSON.stringify(row)}\n`);
  };
  const findingRows = () => {
    const f = path.join(folder, 'findings.jsonl');
    return fs.existsSync(f)
      ? fs
          .readFileSync(f, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];
  };
  return {
    folder,
    repo,
    worktree,
    timeLog,
    g,
    run,
    find,
    report,
    reviewer,
    findingRows,
  };
}

const after = (iso: string | undefined, min: number) => new Date(Date.parse(iso ?? '') + min * 60_000).toISOString();

const REVIEW = [
  'FINDINGS H=0 M=1 L=2',
  'FINDING M1 M mechanical unchecked-error @ lib/A.ts:1 | the value is exported without a check',
  'FINDING L1 L defer time-zone @ lib/A.ts:1 | the day boundary uses local time',
  'FINDING L2 L before-merge - @ - | the new setting is missing from the docs table',
].join('\n');

describe('the merge gate and the review items', () => {
  it('stops without the chosen review and on H>0, then records items, refuses done, closes each, and done passes', () => {
    const p = project();
    p.report(`${RES}\n\n# Report A\n`);
    const rec = p.run(['receive', 'A']);
    expect(rec.code, rec.all).toBe(0);
    const at = p.find().review_at;
    expect(p.find().review_reviewers).toEqual(['reviewer']);

    // (1) No report from the chosen reviewer: nothing merged.
    const tip = p.g(['rev-parse', 'develop']);
    const m0 = p.run(['merge', 'A', '--without-fill']);
    expect(m0.code).not.toBe(0);
    expect(m0.all).toMatch(/STOP: A is not merged: no FINDINGS report after the last receive from reviewer/);
    expect(p.g(['rev-parse', 'develop'])).toBe(tip);

    // A HIGH in the newest review stops too.
    p.reviewer(
      'rev1',
      'reviewer',
      'FINDINGS H=1 M=0 L=0\nFINDING H1 H fix-round access-control @ lib/A.ts:1 | no check',
      after(at, 1),
    );
    const m1 = p.run(['merge', 'A', '--without-fill']);
    expect(m1.code).not.toBe(0);
    expect(m1.all).toMatch(/HIGH finding\(s\) in the newest review: reviewer H=1/);
    expect(p.g(['rev-parse', 'develop'])).toBe(tip);

    // A newer review without H: the merge goes in, the items are recorded, and the done step refuses.
    p.reviewer('rev2', 'reviewer', REVIEW, after(at, 2));
    const m2 = p.run(['merge', 'A', '--without-fill']);
    expect(m2.all).toMatch(/NOT DONE: A has \d+ open review item/);
    expect(m2.all).toContain('review-item A reviewer#1:M1 --commit <sha>');
    expect(m2.all).toContain('review-item A --defer-all-L');
    expect(p.find().status).toBe('review');
    const keys = (p.find().review_items ?? []).map((x) => x.key);
    expect(keys).toEqual(expect.arrayContaining(['reviewer#1:H1', 'reviewer#1:M1', 'reviewer#1:L1', 'reviewer#1:L2']));
    // Registered again on the next merge call: nothing new.
    const mergeSha = p.g(['rev-parse', 'develop']);

    // (4) The mechanical one cannot go to a task; a rejection needs a sentence.
    expect(p.run(['review-item', 'A', 'reviewer#1:M1', '--task', 'A']).all).toMatch(/mechanical.*--commit or --reject/);
    expect(p.run(['review-item', 'A', 'reviewer#1:L2', '--reject', 'false-positive']).all).toMatch(/--note/);
    // A track worktree cannot close one.
    expect(p.run(['review-item', 'A', 'reviewer#1:L2', '--reject', 'wont-fix', '--note', 'x'], p.worktree).all).toMatch(
      /track worktree/,
    );

    const c1 = p.run(['review-item', 'A', 'reviewer#1:M1', '--commit', mergeSha]);
    expect(c1.code, c1.all).toBe(0);
    const c0 = p.run(['review-item', 'A', 'reviewer#1:H1', '--commit', mergeSha]);
    expect(c0.code, c0.all).toBe(0);
    const c2 = p.run(['review-item', 'A', 'L2', '--reject', 'false-positive', '--note', 'the table has it already']);
    expect(c2.code, c2.all).toBe(0);
    const c3 = p.run(['review-item', 'A', '--defer-all-L']);
    expect(c3.code, c3.all).toBe(0);
    expect(c3.all).toMatch(/placed in A-RV1 \(new review-rest task\)/);
    const rest = p.find('A-RV1');
    expect(rest).toMatchObject({ batched: true, labels: ['review-rest'] });
    expect(String(rest.mission)).toContain('reviewer#1:L1 lib/A.ts:1: the day boundary uses local time');

    const items = p.find().review_items ?? [];
    expect(items.every((x) => x.status === 'closed')).toBe(true);
    expect(items.find((x) => x.key === 'reviewer#1:L1')?.disposition).toEqual({
      kind: 'batch',
      ref: 'A-RV1',
    });

    // (6) One finding log row per close; L does not count.
    const rows = p.findingRows();
    expect(rows.map((r) => r.item).sort()).toEqual([
      'reviewer#1:H1',
      'reviewer#1:L1',
      'reviewer#1:L2',
      'reviewer#1:M1',
    ]);
    expect(rows.find((r) => r.item === 'reviewer#1:M1')).toMatchObject({
      caught_by: 'review:reviewer',
      counts: true,
      disposition: { kind: 'fixed' },
    });
    expect(rows.find((r) => r.item === 'reviewer#1:L2')).toMatchObject({
      counts: false,
      disposition: { kind: 'rejected', ref: 'false-positive' },
    });

    // (5) merge --resume runs done now.
    const m3 = p.run(['merge', 'A', '--resume', '--without-fill']);
    expect(m3.code, m3.all).toBe(0);
    expect(p.find().status).toBe('done');
  });

  it('--allow-unreviewed merges past a missing review and logs it', () => {
    const p = project();
    p.report(`${RES}\n\n# Report A\n`);
    expect(p.run(['receive', 'A']).code).toBe(0);
    const m = p.run(['merge', 'A', '--without-fill', '--allow-unreviewed']);
    expect(m.code, m.all).toBe(0);
    expect(m.all).toMatch(/unreviewed-overridden/);
    expect(fs.readFileSync(p.timeLog, 'utf8')).toMatch(/"event":"unreviewed-overridden"/);
    expect(p.find().status).toBe('done');
  });

  it('review.requireFindings false turns the gate off', () => {
    const p = project({ review: { requireFindings: false } });
    p.report(`${RES}\n\n# Report A\n`);
    expect(p.run(['receive', 'A']).code).toBe(0);
    const m = p.run(['merge', 'A', '--without-fill']);
    expect(m.code, m.all).toBe(0);
    expect(p.find().status).toBe('done');
  });
});

describe('set done and the stop switch', () => {
  it('set done refuses with an open item; reviewItems.stop false lets it pass and says so', () => {
    for (const stop of [true, false]) {
      const p = project(stop ? {} : { reviewItems: { stop: false } });
      p.report(`${RES}\n\n# Report A\n`);
      expect(p.run(['receive', 'A']).code).toBe(0);
      p.reviewer('rev1', 'reviewer', REVIEW, after(p.find().review_at, 1));
      // resume --reason fix records the items too (before any merge).
      p.run(['resume', 'A', '--reason', 'fix']);
      expect((p.find().review_items ?? []).length).toBe(3);
      const s = p.run(['set', 'A', 'done']);
      if (stop) {
        expect(s.code).not.toBe(0);
        expect(s.all).toMatch(/NOT DONE: A has 3 open review item/);
      } else {
        expect(s.code, s.all).toBe(0);
        expect(s.all).toMatch(/REVIEW ITEM STOP OFF/);
      }
    }
  });
});
