// =============================================================
// catalogChecksFlow.test.ts: the check rules of the design choices at receive and merge, through the real CLI
// (lib/catalogChecks.js, cli/catalog.mjs catalogRules, cli/merge.mjs; bolk B6 of the scope drift plan, V4).
//
// Locks: (1) receive prints one CATALOG line for an accepted choice whose rule an added line breaks, records the hit on
// the task (catalog_checks) and puts the rule in the review package; a proposed choice gives a NOTE only; (2) a rule in
// mode stop does not stop the merge while catalog.checkStop is off (the default); (3) with catalog.checkStop on the
// merge stops (exit 1, nothing merged) and --allow-catalog goes past it, logged as "catalog-overridden"; (4) with
// learning.proposals on, the third separate task that breaks the same rule gets a proposed gate task for the project's
// own lint, and with it off nothing is proposed; (5) catalog check names a broken rule (a miss example that hits) as an
// error.
// Runs queue.mjs against a temporary queue (QUEUE_FOLDER), a temporary git repo (QUEUE_GIT) with a worktree for the track
// branch and an injected merge runner (QUEUE_MERGE_RUNNING), as wiringFlow.test.ts. Never the main repo or queue.
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
const CAT = path.join('docs', 'queue', 'catalog', 'decisions');

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const C = require('../lib/catalog.js') as any;
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

const temporary: string[] = [];
afterAll(() => {
  for (const m of temporary) fs.rmSync(m, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
});

/** A design choice with a check rule: app/ never imports the database client. */
const decisionText = ({ status = 'proposed', mode = 'warn', miss = "import { save } from '@/services/factory'" } = {}) =>
  [
    '---',
    'id: D-0007',
    'title: Client code goes through the service layer',
    `status: ${status}`,
    'paths: ["app/**"]',
    'invariant: Files under app/ never import the database client directly.',
    'check:',
    '  forbid: "@db/client"',
    '  hit: ["import { db } from \'@db/client\'"]',
    `  miss: [${JSON.stringify(miss)}]`,
    `  mode: ${mode}`,
    '---',
    'Why: one way to the data.',
    '',
  ].join('\n');

/**
 * A temporary project: a repo on develop, a track branch queue/A that adds app/page.ts importing the database client,
 * the catalog in the main tree (QUEUE_ROOT) and, for an accepted choice, the owner's record in the data folder.
 */
function project(config: object = {}, { status = 'accepted', mode = 'warn', others = [] as Task[] } = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-catalog-checks-'));
  temporary.push(folder);
  const repo = path.join(folder, 'repo');
  const worktree = path.join(folder, 'wt-A');
  const scratch = path.join(folder, 'scratch');
  fs.mkdirSync(path.join(repo, 'app'), { recursive: true });
  fs.mkdirSync(scratch);
  const g = (args: string[], cwd = repo) =>
    execFileSync('git', ['-C', cwd, ...ID, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  g(['init', '-q', '-b', 'develop']);
  fs.writeFileSync(path.join(repo, 'app', 'home.ts'), 'export const home = 1;\n');
  g(['add', '--', 'app/home.ts']);
  g(['commit', '-q', '-m', 'start']);
  g(['branch', 'queue/A']);
  g(['worktree', 'add', '-q', worktree, 'queue/A']);
  fs.writeFileSync(path.join(worktree, 'app', 'page.ts'), "import { db } from '@db/client';\nexport const page = db;\n");
  g(['add', '--', 'app/page.ts'], worktree);
  g(['commit', '-q', '-m', 'feat: page'], worktree);
  // The catalog lives in the main tree (QUEUE_ROOT = folder here, as in the other flow tests).
  fs.mkdirSync(path.join(folder, CAT), { recursive: true });
  const decisionFile = path.join(folder, CAT, 'D-0007-service-layer.md');
  let text = decisionText({ status: 'proposed', mode });
  if (status === 'accepted') {
    text = C.acceptText(text, { by: 'owner', now: '2026-11-16T10:00:00.000Z' }).text;
    const d = C.parseDecision('D-0007-service-layer.md', text).decision;
    fs.writeFileSync(path.join(folder, C.LEDGER_FILE), JSON.stringify(C.recordAccept(C.emptyLedger(), d, { by: 'owner' })));
  }
  fs.writeFileSync(decisionFile, text);
  const task: Task = {
    id: 'A',
    title: 'Task A',
    domain: 'dom-A',
    class: 'K',
    status: 'running',
    mission: 'The mission for A.',
    value: 5,
    content_min: 60,
    depends_on: [],
    waiting_on: [],
    owned_files: ['app/page.ts'],
    started: '2026-01-01T00:00:00.000Z',
    branch: 'queue/A',
    migr_block: null,
    scratchpad: scratch,
  };
  fs.writeFileSync(
    path.join(folder, 'queue.json'),
    JSON.stringify({ created: task.started, limits: {}, next_migr: 3600, resolved: [], tasks: [task, ...others] }),
  );
  const configFile = path.join(folder, 'queue.config.json');
  fs.writeFileSync(configFile, JSON.stringify({ baseBranch: 'develop', mode: 'lite', ...config }));
  fs.mkdirSync(path.join(folder, 'docs'), { recursive: true });
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
    QUEUE_TIME_LOG: path.join(folder, 'times.jsonl'),
    QUEUE_TRANSCRIPTS: path.join(folder, 'transcripts'),
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
    return { code: r.status, out: r.stdout ?? '', error: r.stderr ?? '', all: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  const tasks = () => (JSON.parse(fs.readFileSync(path.join(folder, 'queue.json'), 'utf8')) as { tasks: Task[] }).tasks;
  const find = (id = 'A') => tasks().find((t) => t.id === id) as Task;
  fs.mkdirSync(path.join(scratch, 'A'), { recursive: true });
  const report = path.join(scratch, 'A', 'track-result.md');
  fs.writeFileSync(report, `${RES}\n\n# Report A\n`);
  const later = Date.now() / 1000 + 60;
  fs.utimesSync(report, later, later);
  const timeLog = () => {
    try {
      return fs.readFileSync(path.join(folder, 'times.jsonl'), 'utf8');
    } catch {
      return '';
    }
  };
  return { folder, repo, run, find, tasks, decisionFile, timeLog };
}

/** Another task that broke the rule earlier (its record as receive writes it). */
const brokeBefore = (id: string): Task => ({
  id,
  title: `Task ${id}`,
  domain: `dom-${id}`,
  class: 'K',
  status: 'done',
  value: 5,
  content_min: 30,
  depends_on: [],
  waiting_on: [],
  catalog_checks: { at: '2026-11-10T10:00:00.000Z', hits: [], ever: ['D-0007'] },
});

describe('the check rules at receive', () => {
  it('an accepted choice: one CATALOG line, the record on the task and the rule in the package', () => {
    const p = project();
    const r = p.run(['receive', 'A']);
    expect(r.code, r.all).toBe(0);
    expect(r.out).toMatch(/CATALOG A: 1 added line\(s\) break D-0007/);
    expect(r.out).toContain('app/page.ts:1');
    expect(p.find().catalog_checks).toMatchObject({ hits: [{ id: 'D-0007', level: 'warn', count: 1 }], ever: ['D-0007'] });
    const pkg = fs.readFileSync(path.join(p.find().review_package as string, '00-package.md'), 'utf8');
    expect(pkg).toContain('## Catalog rules');
    expect(pkg).toMatch(/D-0007 \(holds, warn\)/);
  });

  it('a proposed choice: a NOTE only, nothing counted', () => {
    const p = project({}, { status: 'proposed' });
    const r = p.run(['receive', 'A']);
    expect(r.code, r.all).toBe(0);
    expect(r.out).toMatch(/NOTE catalog A: 1 added line\(s\) match the check of D-0007, a proposed choice/);
    expect(r.out).not.toMatch(/^CATALOG A/m);
    expect(p.find().catalog_checks).toMatchObject({ ever: [] });
  });
});

describe('mode stop at merge', () => {
  it('with catalog.checkStop off (the default) the merge goes on', () => {
    const p = project({}, { mode: 'stop' });
    expect(p.run(['receive', 'A']).out).toMatch(/mode is stop, but catalog\.checkStop is off/);
    const m = p.run(['merge', 'A', '--without-fill']);
    expect(m.all).not.toMatch(/STOP: A is not merged.*D-0007/);
    expect(p.find().merge_commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it('with catalog.checkStop on the merge stops, and --allow-catalog goes past it, logged', () => {
    const p = project({ catalog: { checkStop: true } }, { mode: 'stop' });
    expect(p.run(['receive', 'A']).out).toMatch(/The merge stops on it/);
    const m = p.run(['merge', 'A', '--without-fill']);
    expect(m.code).toBe(1);
    expect(m.all).toMatch(/STOP: A is not merged/);
    expect(m.all).toContain('--allow-catalog');
    expect(p.find().merge_commit).toBeUndefined();
    const ok = p.run(['merge', 'A', '--without-fill', '--allow-catalog']);
    expect(ok.all).toMatch(/--allow-catalog: merging A/);
    expect(p.find().merge_commit).toMatch(/^[0-9a-f]{40}$/);
    expect(p.timeLog()).toContain('catalog-overridden');
  });
});

describe('a rule broken again and again', () => {
  it('the third separate task gets a proposed gate task with learning.proposals on', () => {
    const p = project({ learning: { proposals: true } }, { others: [brokeBefore('B'), brokeBefore('C')] });
    const r = p.run(['receive', 'A']);
    expect(r.code, r.all).toBe(0);
    const gate = p.tasks().find((t) => (t.labels as string[] | undefined)?.includes('catalog-rule'));
    expect(gate, r.all).toBeDefined();
    expect(gate).toMatchObject({ status: 'proposed', source: 'catalog-rule D-0007' });
    expect(String(gate?.title)).toContain('Lint rule for D-0007');
    expect(r.out).toMatch(/proposed GATE-\d+/);
    // The same rule again extends it instead of adding a second one.
    p.run(['receive', 'A']);
    expect(p.tasks().filter((t) => (t.labels as string[] | undefined)?.includes('catalog-rule'))).toHaveLength(1);
  });

  it('nothing is proposed with learning.proposals off (the default)', () => {
    const p = project({}, { others: [brokeBefore('B'), brokeBefore('C')] });
    expect(p.run(['receive', 'A']).code).toBe(0);
    expect(p.tasks().some((t) => (t.labels as string[] | undefined)?.includes('catalog-rule'))).toBe(false);
  });
});

describe('catalog check', () => {
  it('names a rule whose miss example hits as an error', () => {
    const p = project({}, { status: 'proposed' });
    fs.writeFileSync(p.decisionFile, decisionText({ miss: "import x from '@db/client'" }));
    const r = p.run(['catalog', 'check']);
    expect(r.code).toBe(1);
    expect(r.all).toMatch(/miss example hits/);
  });
});
