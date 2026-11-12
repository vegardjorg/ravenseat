// =============================================================
// historyFlow.test.ts: owner decision B5 through the CLI, against a temporary queue (lib/queueArchive.js,
// lib/timeLogArchive.js, history in queue.config.json).
//
//   - a queue write moves the old done and cancelled tasks to queue-archive.json and keeps their ids in queue.archived;
//   - info and explain find an archived task read-only and say so; undo says a change to one cannot be undone;
//   - a new task that depends on an archived task brings it back, and its dependency counts as done;
//   - an archived id is never given out again, and an explicit one is refused;
//   - the owner log stays consistent: archiving records nothing and nothing it moved makes a check stop;
//   - `ravenseat cost` prints the same before and after the time log rotates;
//   - doctor: turning either setting off is an INFO line, never a WARN.
// =============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const OL = require('../lib/ownerLog.js') as any;
const TA = require('../lib/timeLogArchive.js') as any;
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

const QUEUE = path.resolve(__dirname, '..', 'queue.mjs');
const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
let root = '';
let env: NodeJS.ProcessEnv = {};
const folder = () => path.join(root, 'q');
const configFile = () => path.join(root, 'queue.config.json');
const timeLog = () => path.join(root, 'times.jsonl');
const queueFile = () => path.join(folder(), 'queue.json');
const archiveFile = () => path.join(folder(), 'queue-archive.json');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const queue = (): any => JSON.parse(fs.readFileSync(queueFile(), 'utf8'));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ids = (q: any) => q.tasks.map((t: any) => t.id);

/** Runs queue.mjs async (spawnSync blocks the vitest worker on a loaded machine). */
const ravenseat = (args: string[]) =>
  new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
    const p = spawn(process.execPath, [QUEUE, ...args], { cwd: root, env });
    let out = '';
    let err = '';
    p.stdout.setEncoding('utf8').on('data', (d: string) => (out += d));
    p.stderr.setEncoding('utf8').on('data', (d: string) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => resolve({ code, out, err }));
  });

const done = (id: string, o: Record<string, unknown> = {}) => ({
  id, title: `Task ${id}`, class: 'K', domain: 'general', status: 'done', value: 5, content_min: 30,
  added_at: ago(120), started: ago(101), done: ago(100), depends_on: [], ...o,
});

/** The queue after init, with these tasks; every finished one first seen finished 90 days ago. */
function seed(tasks: object[], extra: Record<string, unknown> = {}) {
  const q = queue();
  q.tasks = tasks;
  q.terminal_since = Object.fromEntries(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tasks.filter((t: any) => ['done', 'cancelled'].includes(t.status)).map((t: any) => [t.id, ago(90)]),
  );
  Object.assign(q, extra);
  fs.writeFileSync(queueFile(), JSON.stringify(q, null, 2));
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ravenseat-history-'));
  env = {
    ...process.env,
    QUEUE_ROOT: root,
    QUEUE_FOLDER: folder(),
    QUEUE_CONFIG: configFile(),
    QUEUE_TIME_LOG: timeLog(),
    QUEUE_GIT: root,
    DISABLE_UPDATES: '1',
  };
  delete env.QUEUE_SESSION;
  fs.writeFileSync(configFile(), '{\n  "mode": "lite"\n}\n');
  expect((await ravenseat(['init'])).code).toBe(0);
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe('the archive of done tasks through the CLI', () => {
  it('a write archives the old finished tasks; info and explain find them read-only; a dependency brings one back', async () => {
    seed([done('OLD', { added_by: 'owner' }), done('GONE', { status: 'cancelled' }), done('NEW', { done: ago(2) })]);
    const add = await ravenseat(['add', 'Trigger a write', '--id', 'T-001']);
    expect(add.code, add.err).toBe(0);
    let q = queue();
    expect(ids(q)).toEqual(['NEW', 'T-001']);
    expect(q.archived).toEqual({ OLD: 'done', GONE: 'cancelled' });
    expect(JSON.parse(fs.readFileSync(archiveFile(), 'utf8')).tasks.map((t: { id: string }) => t.id)).toEqual(['OLD', 'GONE']);

    const info = await ravenseat(['info', 'OLD']);
    expect(info.code, info.err).toBe(0);
    expect(info.out).toMatch(/^ARCHIVED \(read-only\): OLD is done/);
    expect(info.out).toContain('Task OLD');
    expect((await ravenseat(['info', 'OLD', '--field', 'status'])).out.trim()).toBe('done');
    const explain = await ravenseat(['explain', 'GONE']);
    expect(explain.code, explain.err).toBe(0);
    expect(explain.out).toContain('GONE (cancelled): archived (read-only)');
    expect((await ravenseat(['info', 'NOPE'])).err).toContain('Unknown task NOPE');

    // The owner log: the archiving write recorded nothing for the moved tasks, and no check stops on them.
    expect(OL.check(folder(), q, 'T-001').missing).toEqual([]);
    expect(OL.check(folder(), q, 'NEW').missing).toEqual([]);

    // A new task that depends on OLD: OLD comes back, the dependency counts as done.
    const dep = await ravenseat(['add', 'After the old one', '--id', 'T-002', '--depends', 'OLD']);
    expect(dep.code, dep.err).toBe(0);
    q = queue();
    expect(ids(q)).toContain('OLD');
    expect(q.archived).toEqual({ GONE: 'cancelled' });
    const why = await ravenseat(['explain', 'T-002']);
    expect(why.out).not.toMatch(/unknown OLD|waiting on OLD/);
    // Restoring records no owner row for it as new (its rows were never written by this write).
    expect(OL.check(folder(), q, 'T-002').missing).toEqual([]);
  });

  it('an archived id is never given out again, and an explicit one is refused', async () => {
    seed([done('T-001'), done('T-002', { status: 'cancelled' })]);
    expect((await ravenseat(['add', 'First write'])).code).toBe(0);
    let q = queue();
    expect(Object.keys(q.archived)).toEqual(['T-001', 'T-002']);
    expect(ids(q)).toEqual(['T-003']);
    const dup = await ravenseat(['add', 'Same id', '--id', 'T-002']);
    expect(dup.code).not.toBe(0);
    expect(dup.err).toContain('T-002: the id belongs to an archived task (cancelled');
    q = queue();
    expect(ids(q)).toEqual(['T-003']);
  });

  it('undo of a change to an archived task says it is archived, not gone', async () => {
    const old = done('OLD');
    seed([done('KEEP', { done: ago(1) })], {
      archived: { OLD: 'done' },
      changelog: [{ nr: 1, at: ago(95), by: 'owner', action: 'edit', changes: [{ id: 'OLD', field: 'value', before: 3, after: 5 }] }],
    });
    fs.writeFileSync(archiveFile(), JSON.stringify({ version: 1, tasks: [{ ...old, archived_at: ago(10) }] }));
    const r = await ravenseat(['undo', '--by', 'owner']);
    expect(r.code).not.toBe(0);
    expect(`${r.out}${r.err}`).toContain('OLD: archived (done, read-only), so this change cannot be undone');
  });

  it('resume writes through the same path: the resumed task stays, the old done task it depends on stays, others move', async () => {
    seed([
      done('DEP'),
      done('OLD'),
      done('R-1', { status: 'running', done: undefined, started: ago(0.1), depends_on: ['DEP'] }),
    ]);
    // resume continues a branch that exists.
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
    git('init', '-q', '-b', 'main', '.');
    git('-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
    git('branch', 'queue/R-1');
    const scratch = path.join(root, 'scratch');
    fs.mkdirSync(scratch);
    const r = await ravenseat(['resume', 'R-1', '--reason', 'context', '--scratchpad', scratch]);
    expect(r.out).toContain('RESUME R-1-r1 (context)');
    expect(r.code, `${r.out}${r.err}`).toBe(0);
    expect(r.err).not.toMatch(/ReferenceError|keepArchiveConsistent/);
    const q = queue();
    expect(ids(q)).toEqual(['DEP', 'R-1']);
    expect(q.archived).toEqual({ OLD: 'done' });
  });

  it('archiveDoneAfterDays null: nothing moves', async () => {
    fs.writeFileSync(configFile(), '{\n  "mode": "lite",\n  "history": { "archiveDoneAfterDays": null }\n}\n');
    seed([done('OLD')]);
    expect((await ravenseat(['add', 'A write'])).code).toBe(0);
    expect(ids(queue())).toContain('OLD');
    expect(fs.existsSync(archiveFile())).toBe(false);
  });
});

describe('the time log rotation through the CLI', () => {
  it('`ravenseat cost` prints the same before and after the log rotates', async () => {
    seed([done('T-001', { done: ago(3), t_merge: ago(3), merge_commit: 'abc1234' })]);
    const rows = [1, 2, 3].map((n) => ({
      time: ago(3 + n / 10), wave: 'w', track: 'T-001', event: 'done', agent_id: `a${n}`, agent_type: 'track',
      model: 'claude-opus-4-1', input_tokens: 1000 * n, output_tokens: 500 * n, cache_read_tokens: 0, cache_creation_tokens: 0,
    }));
    fs.writeFileSync(timeLog(), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const before = await ravenseat(['cost']);
    expect(before.code, before.err).toBe(0);
    // Last written last month: the next write rotates it.
    const lastMonth = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1) - DAY);
    fs.utimesSync(timeLog(), lastMonth, lastMonth);
    expect(TA.rotateIfDue(timeLog(), { mode: 'monthly' }).rotated).toBe(true);
    expect(fs.existsSync(timeLog())).toBe(false);
    expect(TA.archives(timeLog())).toHaveLength(1);
    const after = await ravenseat(['cost']);
    expect(after.code, after.err).toBe(0);
    expect(after.out).toBe(before.out);
  });
});

describe('doctor', () => {
  it('turning either setting off is an INFO line on the history row, never a WARN', async () => {
    fs.writeFileSync(
      configFile(),
      '{\n  "mode": "lite",\n  "history": { "rotateTimeLog": "off", "archiveDoneAfterDays": null }\n}\n',
    );
    const r = await ravenseat(['doctor']);
    const lines = r.out.split('\n').filter((l) => /history/i.test(l));
    expect(lines.join('\n')).toContain('TIME LOG ROTATION OFF');
    expect(lines.join('\n')).toContain('DONE TASKS STAY IN queue.json');
    expect(lines.some((l) => /WARN|FAIL/.test(l))).toBe(false);
  });

  it('a wrong value is named in the config row', async () => {
    fs.writeFileSync(configFile(), '{\n  "mode": "lite",\n  "history": { "rotateTimeLog": "weekly" }\n}\n');
    const r = await ravenseat(['doctor']);
    expect(r.out).toContain('history.rotateTimeLog must be "monthly" or "off"');
  });
});
