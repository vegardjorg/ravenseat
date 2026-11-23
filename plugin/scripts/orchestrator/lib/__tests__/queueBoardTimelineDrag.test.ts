// =============================================================
// queueBoardTimelineDrag.test.ts: the server side of the Timeline's drag for order (roadmap TIDSLINJE T-B).
//
// Starts the real board on a small queue in a temporary folder (never the real queue) and drives what a drop sends:
//   - a task moved in its step: POST /api/bulk { action: 'rank', dry, plan_effect: true } answers with the dry run's changes
//     and the plan in words (the schedule played on a copy), and writes nothing; the save with a stale version gets the
//     outdated answer (409, outdated: true); the save with the preview's version writes with --by theBoard and gives a
//     changelog number, and POST /api/undo { nr } puts the old priority back;
//   - a step row moved: POST /api/focus { plan, dry, plan_effect } the same, and the focus save now has a changelog
//     number, so Undo takes the order back.
// =============================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { boardOpen, keyFileArgs } from './boardKey';

const SCRIPTS = path.resolve(__dirname, '..', '..');
const H = 3_600_000;
const NOW = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();

const freePort = () =>
  new Promise<number>((done) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => done(p));
    });
  });

const run = (env: NodeJS.ProcessEnv, cwd: string, script: string, ...args: string[]) =>
  new Promise<{ code: number | null; out: string }>((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(SCRIPTS, script), ...args], { cwd, env });
    let out = '';
    p.stdout.on('data', (d) => (out += String(d)));
    p.stderr.on('data', (d) => (out += String(d)));
    p.on('error', reject);
    p.on('close', (code) => resolve({ code, out }));
  });

let root = '';
let folder = '';
let proc: ChildProcess | null = null;
let base = '';
let key = '';

/* eslint-disable @typescript-eslint/no-explicit-any */
const get = async (route: string) => {
  const r = await fetch(`${base}${route}`, { headers: { 'x-queue-key': key } });
  return { status: r.status, body: (await r.json()) as any };
};
const post = async (route: string, body: object) => {
  const r = await fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'x-queue-key': key, 'content-type': 'application/json', origin: base },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as any };
};
const queueFile = () => path.join(folder, 'queue.json');
const readQueue = () => JSON.parse(fs.readFileSync(queueFile(), 'utf8')) as any;
const snapshot = () => ({ text: fs.readFileSync(queueFile(), 'utf8'), mtime: fs.statSync(queueFile()).mtimeMs });
const taskOf = (id: string) => readQueue().tasks.find((o: any) => o.id === id);
/* eslint-enable @typescript-eslint/no-explicit-any */

const task = (id: string, extra: object = {}) => ({
  id,
  title: `Task ${id}`,
  domain: id.toLowerCase(),
  class: 'K',
  value: 5,
  content_min: 60,
  status: 'waiting',
  depends_on: [],
  waiting_on: [],
  owned_files: [`f/${id}.ts`],
  added_by: 'test',
  added_at: iso(NOW - 48 * H),
});

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ravenseat-board-tldrag-'));
  folder = path.join(root, 'q');
  fs.mkdirSync(folder);
  const env = {
    ...process.env,
    QUEUE_ROOT: root,
    QUEUE_FOLDER: folder,
    QUEUE_CONFIG: path.join(root, 'queue.config.json'),
    QUEUE_TIME_LOG: path.join(root, 'times.jsonl'),
    QUEUE_GIT: root,
    DISABLE_UPDATES: '1',
  };
  fs.writeFileSync(path.join(root, 'queue.config.json'), '{ "mode": "full" }\n');
  expect((await run(env, root, 'queue.mjs', 'init')).code).toBe(0);
  const q = readQueue();
  q.limits = { ...(q.limits ?? {}), maxConcurrent: 1 };
  q.projects = { a: { title: 'Alpha', prefixes: ['A-'] }, b: { title: 'Beta', prefixes: ['B-'] } };
  q.tasks = [{ ...task('A-1'), value: 8 }, { ...task('A-2'), value: 3 }, task('B-1')];
  q.focus = { order: ['project:a', 'project:b'], rest: 'wait', from: iso(NOW - 24 * H), now_count: 1 };
  q.changed = iso(NOW - H);
  fs.writeFileSync(queueFile(), JSON.stringify(q, null, 2));
  const port = await freePort();
  const kf = keyFileArgs();
  proc = spawn(process.execPath, [path.join(SCRIPTS, 'queue-board.mjs'), '--port', String(port), ...kf.args], { cwd: root, env });
  let all = '';
  proc.stdout!.on('data', (d) => (all += String(d)));
  proc.stderr!.on('data', (d) => (all += String(d)));
  await new Promise<void>((done, fail) => {
    const t = setTimeout(() => fail(new Error(`the board did not start: ${all.slice(-400)}`)), 60_000);
    const check = () => {
      const m = boardOpen(all, kf.file);
      if (m) {
        base = m[1];
        key = m[2];
        clearTimeout(t);
        done();
      } else setTimeout(check, 50);
    };
    check();
  });
}, 90_000);

afterAll(async () => {
  if (proc && proc.exitCode == null) {
    const gone = new Promise((done) => proc!.once('exit', done));
    proc.kill();
    await gone;
  }
  if (root) fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe('a task moved in its step (rank)', () => {
  const body = { action: 'rank', ids: ['A-2'], val: { space: 'over', ref: 'A-1' } };
  let changed = '';

  it('the timeline settings reach the board: drag and preview on by default in full', async () => {
    const d = (await get('/api/state')).body.data;
    expect(d.boardTimeline).toMatchObject({ on: true, drag: true, dragPreview: true });
  });

  it('the dry run says what happens to the plan, in words, and writes nothing', async () => {
    const before = snapshot();
    const r = await post('/api/bulk', { ...body, dry: true, plan_effect: true });
    expect(r.status, r.body.message).toBe(200);
    expect(r.body.dry).toBe(true);
    expect(r.body.can).toBe(true);
    expect(r.body.lines.join('\n')).toContain('priority_bonus');
    expect(r.body.plan.sentence).toContain('A-2 starts first in step 1 (Alpha)');
    expect(r.body.plan.sentence).not.toMatch(/\d\d:\d\d/);
    changed = r.body.changed;
    expect(snapshot()).toEqual(before);
  });

  it('without plan_effect the dry run is as before (no schedule played)', async () => {
    const r = await post('/api/bulk', { ...body, dry: true });
    expect(r.status).toBe(200);
    expect(r.body.plan).toBeUndefined();
  });

  it('a save on a stale version gets the outdated answer and writes nothing', async () => {
    const before = snapshot();
    const r = await post('/api/bulk', { ...body, expect: iso(NOW - 10 * 24 * H) });
    expect(r.status).toBe(409);
    expect(r.body.outdated).toBe(true);
    expect(snapshot().text).toBe(before.text);
  });

  it('the save writes by theBoard with a changelog number; Undo puts the old priority back', async () => {
    const r = await post('/api/bulk', { ...body, expect: changed });
    expect(r.status, r.body.message).toBe(200);
    expect(Number.isInteger(r.body.log)).toBe(true);
    const q = readQueue();
    const entry = q.changelog.find((e: { nr: number }) => e.nr === r.body.log);
    expect(entry).toMatchObject({ action: 'rank', by: 'theBoard' });
    expect(typeof taskOf('A-2').priority_bonus).toBe('number');
    const u = await post('/api/undo', { nr: r.body.log });
    expect(u.status, u.body.message).toBe(200);
    expect(taskOf('A-2').priority_bonus ?? null).toBeNull();
  });
});

describe('a step row moved (focus save)', () => {
  const plan = { order: ['project:b', 'project:a'], now_count: 1, rest: 'wait', to: null, name: null, drag_with_dependencies: true, pause: [], continue: [] };

  it('the dry run says what happens to the plan and writes nothing', async () => {
    const before = snapshot();
    const r = await post('/api/focus', { plan, dry: true, plan_effect: true });
    expect(r.status, r.body.message).toBe(200);
    expect(r.body.can).toBe(true);
    expect(r.body.plan.sentence).toMatch(/^Step 1 \(Beta\) done about [\d.]+ (h|min) earlier/);
    expect(snapshot()).toEqual(before);
  });

  it('the save has a changelog number, and Undo takes the old order back', async () => {
    const dry = await post('/api/focus', { plan, dry: true });
    const r = await post('/api/focus', { plan, expect: dry.body.changed });
    expect(r.status, r.body.message).toBe(200);
    expect(Number.isInteger(r.body.log)).toBe(true);
    expect(readQueue().focus.order).toEqual(['project:b', 'project:a']);
    const u = await post('/api/undo', { nr: r.body.log });
    expect(u.status, u.body.message).toBe(200);
    expect(readQueue().focus.order).toEqual(['project:a', 'project:b']);
  });

  it('a save on a stale version gets the outdated answer', async () => {
    const r = await post('/api/focus', { plan, expect: iso(NOW - 10 * 24 * H) });
    expect(r.status).toBe(409);
    expect(r.body.outdated).toBe(true);
    expect(readQueue().focus.order).toEqual(['project:a', 'project:b']);
  });
});
