// =============================================================
// findingSourcesFlow.test.ts: the commands that catch a defect outside a gate write to the finding log
// (lib/findingSources.js, step 4 of the finding format contract), through the real CLI.
//
// Locks: (1) `ravenseat finding` writes one `finding` row with the task, the files and the cause, and --dry writes
// none; (2) `add` of a task with `fixes` writes one `post-merge` row per fixed task, and `edit` writes a row only for an
// id that was not in `fixes` before; (3) `qa deviation` writes one `qa` row built from the ids, never the owner's
// text; (4) a log that cannot be written gives one WARNING and the command still succeeds with its own output.
// The gate, CI, base gate, done command, red on base, secret scan and GATE line sources are locked in the flow tests of
// those features (trackFlakyGate, queueCiWatch, queueBaseGate, queueDoneCheck, redteam/redOnBase-cli,
// redteam/secretAtReceive-cli, controlsFlow).
// Runs queue.mjs against a temporary queue (QUEUE_FOLDER) and a temporary git repo (QUEUE_GIT). Never the real queue.
// =============================================================
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const ID = ['-c', 'user.name=queue-test', '-c', 'user.email=queue-test@example.invalid'];

const temporary: string[] = [];
afterAll(() => {
  for (const m of temporary) fs.rmSync(m, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
});

const task = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `Task ${id}`,
  domain: `dom-${id}`,
  class: 'K',
  mission: `The mission for ${id}.`,
  value: 6,
  content_min: 100,
  ...extra,
});

/** A project with one done task D (merged earlier) in project app. */
function setup() {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-finding-sources-'));
  temporary.push(folder);
  const repo = path.join(folder, 'repo');
  fs.mkdirSync(repo);
  const g = (args: string[]) =>
    execFileSync('git', ['-C', repo, ...ID, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  g(['init', '-q', '-b', 'develop']);
  fs.writeFileSync(path.join(repo, 'README.md'), 'start\n');
  g(['add', '--', 'README.md']);
  g(['commit', '-q', '-m', 'start']);
  const done = { ...task('D', { project: 'app', feature: 'Core' }), status: 'done', depends_on: [], waiting_on: [], owned_files: [] };
  fs.writeFileSync(
    path.join(folder, 'queue.json'),
    JSON.stringify({
      created: '2026-01-01T00:00:00.000Z',
      limits: {},
      next_migr: 3600,
      resolved: ['D'],
      projects: { app: { title: 'App', prefixes: ['D', 'F'] } },
      tasks: [done],
    }),
  );
  const configFile = path.join(folder, 'queue.config.json');
  fs.writeFileSync(configFile, JSON.stringify({ baseBranch: 'develop' }));
  const env = {
    ...process.env,
    QUEUE_FOLDER: folder,
    QUEUE_CONFIG: configFile,
    QUEUE_ROOT: folder,
    QUEUE_GIT: repo,
    QUEUE_TIME_LOG: path.join(folder, 'times.jsonl'),
    QUEUE_TRANSCRIPTS: path.join(folder, 'transcripts'),
  } as NodeJS.ProcessEnv;
  delete env.QUEUE_SCRATCHPAD;
  delete env.QUEUE_SESSION;
  const run = (...args: string[]) => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'orchestrator', 'queue.mjs'), ...args], {
      encoding: 'utf8',
      env,
      cwd: folder,
    });
    return { code: r.status, out: r.stdout ?? '', error: r.stderr ?? '' };
  };
  const logFile = path.join(folder, 'findings.jsonl');
  const rows = () =>
    fs.existsSync(logFile) && fs.statSync(logFile).isFile()
      ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
      : [];
  return { run, rows, logFile };
}

describe('the finding log from the commands', () => {
  it('ravenseat finding writes one finding row; --dry writes none', () => {
    const p = setup();
    expect(p.run('finding', 'The cache is never cleared', '--files', 'src/cache.ts', '--cause', 'D', '--project', 'app', '--dry').code).toBe(0);
    expect(p.rows()).toEqual([]);
    const r = p.run('finding', 'The cache is never cleared', '--files', 'src/cache.ts', '--cause', 'D', '--project', 'app');
    expect(r.code, r.error).toBe(0);
    expect(r.out).toContain('FINDING PL-FINDING-1');
    expect(p.rows()).toMatchObject([
      { id: 'F-1', caught_by: 'finding', severity: 'M', class: 'other', cause_task: 'D', excerpt: 'The cache is never cleared', where: { files: ['src/cache.ts'] } },
    ]);
  });

  it('add and edit with fixes: one post-merge row per newly fixed task', () => {
    const p = setup();
    const r = p.run('add', '--json', JSON.stringify(task('F1', { fixes: 'D' })));
    expect(r.code, r.error).toBe(0);
    expect(p.rows()).toMatchObject([{ caught_by: 'post-merge', task: 'F1', cause_task: 'D', excerpt: 'fix task F1 fixes D, a defect after merge' }]);
    // No fixes: no row. The same link again in an edit: no row either.
    expect(p.run('add', '--json', JSON.stringify(task('F2'))).code).toBe(0);
    expect(p.run('edit', 'F1', '--json', JSON.stringify({ fixes: ['D'] })).code).toBe(0);
    expect(p.rows()).toHaveLength(1);
    // A new link in an edit is a new defect after merge.
    expect(p.run('edit', 'F2', '--json', JSON.stringify({ fixes: ['D'] })).code).toBe(0);
    expect(p.rows().map((x) => x.task)).toEqual(['F1', 'F2']);
  });

  it('qa deviation writes one qa row from the ids, never the owner text', () => {
    const p = setup();
    const r = p.run('qa', 'deviation', 'D', 'The button for Kari Nordmann is the wrong colour');
    expect(r.code, r.error).toBe(0);
    expect(p.rows()).toMatchObject([{ caught_by: 'qa', task: 'D-QA1', cause_task: 'D', excerpt: 'QA deviation on D, fix task D-QA1' }]);
    expect(fs.readFileSync(p.logFile, 'utf8')).not.toContain('Kari');
  });

  it('a log that cannot be written gives one WARNING; the command goes on', () => {
    const p = setup();
    // A folder where the file should be: every append fails.
    fs.mkdirSync(p.logFile);
    const r = p.run('finding', 'The cache is never cleared', '--project', 'app');
    expect(r.code, r.error).toBe(0);
    expect(r.out).toContain('FINDING PL-FINDING-1');
    expect(r.out.match(/WARNING: the finding log did not get 1 row\(s\)/g)).toHaveLength(1);
  });
});
