// =============================================================
// queueBoardDemo.test.ts: demo mode on a running board (owner decision 22.11; lib/demoMode.js, docs/board.md "Demo mode").
//
// Starts the real board on an empty queue in a temporary folder and clicks through the demo the way a curious user
// would: the offer, entering, answering, approving, QA, editing, and then every class of action that must be refused
// (start work, settings, gates, project files, unknown). The real queue.json keeps its bytes and its mtime through it
// all, nothing new appears in the real data folder but the demo folder, and a CLI run on the real queue never sees the
// demo. Then Reset demo, Back to my board, "Don't show again" and the first real task ending the offer.
// =============================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { boardOpen, keyFileArgs } from './boardKey';

const SCRIPTS = path.resolve(__dirname, '..', '..');

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
let env: NodeJS.ProcessEnv = {};
let proc: ChildProcess | null = null;
let base = '';
let key = '';

const get = async (route: string) => {
  const r = await fetch(`${base}${route}`, { headers: { 'x-queue-key': key } });
  return { status: r.status, body: (await r.json()) as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
};
const post = async (route: string, body: object) => {
  const r = await fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'x-queue-key': key, 'content-type': 'application/json', origin: base },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
};
const state = async () => (await get('/api/state')).body.data;

/** Every file in the real data folder (not the demo folder) with its bytes and mtime. */
function realFiles() {
  const out: Record<string, { text: string; mtime: number }> = {};
  for (const name of fs.readdirSync(folder)) {
    const f = path.join(folder, name);
    // checks-report.json is the real board's own background check (real mode, before and after the demo), not a demo write.
    if (name === 'demo' || name === 'checks-report.json' || !fs.statSync(f).isFile()) continue;
    out[name] = { text: fs.readFileSync(f, 'utf8'), mtime: fs.statSync(f).mtimeMs };
  }
  return out;
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ravenseat-board-demo-'));
  folder = path.join(root, 'q');
  fs.mkdirSync(folder);
  env = {
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

describe('demo mode on the board', () => {
  let before: ReturnType<typeof realFiles> = {};
  const has = (data: unknown, id: string) => JSON.stringify(data).includes(`"${id}"`);

  it('an empty queue that never had a task offers the demo', async () => {
    const d = await state();
    expect(d.demo).toMatchObject({ on: false, offer: true, setting: true });
    expect(has(d, 'AUTH-7')).toBe(false);
  });

  it('"Show me a demo board" points the board at the demo folder, with Pebble data and dates around now', async () => {
    before = realFiles();
    expect(before['queue.json']).toBeTruthy();
    const r = await post('/api/demo', { action: 'enter' });
    expect(r.status, r.body.message).toBe(200);
    const d = await state();
    expect(d.demo.on).toBe(true);
    expect(d.demo.offer).toBe(false);
    expect(has(d, 'AUTH-7')).toBe(true);
    expect(fs.existsSync(path.join(folder, 'demo', 'data', 'queue.json'))).toBe(true);
    // The read views follow: the statistics and the timeline read the demo too.
    expect((await get('/api/statistics')).status).toBe(200);
    expect((await get('/api/schedule')).status).toBe(200);
    expect((await get('/api/settings')).status).toBe(200);
  });

  it('the safe actions work and write only into the demo folder', async () => {
    const answers = [
      await post('/api/action', { type: 'resolve', sp: 'Q-TRIAL', choice: 2 }),
      await post('/api/action', { type: 'approve', id: 'AUTH-7' }),
      await post('/api/action', { type: 'qa-ok', id: 'UI-1' }),
      await post('/api/action', { type: 'qa-deviation', id: 'UI-3', text: 'The dark card is too dark on the Today screen' }),
      await post('/api/task-edit', { type: 'cancel', id: 'UI-5', reason: 'not needed in the demo' }),
      await post('/api/seen', {}),
    ];
    for (const a of answers) expect(a.status, a.body.message).toBe(200);
    const demoQueue = JSON.parse(fs.readFileSync(path.join(folder, 'demo', 'data', 'queue.json'), 'utf8'));
    expect(demoQueue.tasks.find((o: { id: string }) => o.id === 'AUTH-7').status).toBe('waiting');
    expect(demoQueue.tasks.find((o: { id: string }) => o.id === 'UI-5').status).toBe('cancelled');
  });

  it('every other class is refused with "Not in demo mode" and writes nothing', async () => {
    const refused = [
      await post('/api/action', { type: 'pick', id: 'UI-6', by: 'someone' }),
      await post('/api/action', { type: 'release', id: 'UI-7' }),
      await post('/api/action', { type: 'requeue', id: 'BILL-2' }),
      await post('/api/action', { type: 'track-answer', id: 'BILL-2', text: 'go on' }),
      await post('/api/action', { type: 'board-switch', name: 'showCloud', on: true }),
      await post('/api/action', { type: 'resolve', sp: 'Q-VAT', answer: 'EU only', keep: true }),
      await post('/api/limit', { name: 'maxConcurrent', val: 9 }),
      await post('/api/setting', { key: 'board.titleCount', value: false }),
      await post('/api/guidance', { mode: 'quiet' }),
      await post('/api/checks', { action: 'gates' }),
      await post('/api/plan-new', { path: 'docs/plans/x.md' }),
      await post('/api/plan-capture', { title: 'A new plan' }),
      await post('/api/lawyerPackage', {}),
      await post('/api/update-dismiss', { version: '9.9.9' }),
      await post('/api/no-such-thing', {}),
      await get('/api/checks'),
      await get('/api/plan-check'),
      await get('/api/cloud-bundles'),
    ];
    for (const r of refused) {
      expect(r.status).toBe(409);
      expect(r.body.demo).toBe(true);
      expect(r.body.message).toMatch(/^Not in demo mode/);
    }
    const demoQueue = JSON.parse(fs.readFileSync(path.join(folder, 'demo', 'data', 'queue.json'), 'utf8'));
    expect(demoQueue.tasks.find((o: { id: string }) => o.id === 'UI-6').status).toBe('waiting');
  });

  it('the real queue keeps its bytes and mtime, and nothing new is in the real data folder but the demo folder', () => {
    expect(realFiles()).toEqual(before);
  });

  it('a CLI run on the real queue never sees the demo', async () => {
    const r = await run(env, root, 'queue.mjs', 'show');
    expect(r.code).toBe(0);
    expect(r.out).not.toMatch(/AUTH-|SYNC-|BILL-|Pebble/);
  });

  it('"Reset demo" makes the demo folder again from the snapshot', async () => {
    const r = await post('/api/demo', { action: 'reset' });
    expect(r.status, r.body.message).toBe(200);
    const demoQueue = JSON.parse(fs.readFileSync(path.join(folder, 'demo', 'data', 'queue.json'), 'utf8'));
    expect(demoQueue.tasks.find((o: { id: string }) => o.id === 'AUTH-7').status).toBe('proposed');
    expect((await state()).demo.on).toBe(true);
  });

  it('"Back to my board" shows the real queue again and deletes nothing real', async () => {
    const r = await post('/api/demo', { action: 'leave' });
    expect(r.status, r.body.message).toBe(200);
    const d = await state();
    expect(d.demo.on).toBe(false);
    expect(has(d, 'AUTH-7')).toBe(false);
    expect(realFiles()).toEqual(before);
    // A write after leaving goes to the real queue again, through the normal rules (an unknown task is refused there).
    const after = await post('/api/action', { type: 'approve', id: 'AUTH-7' });
    expect(after.body.demo).toBeUndefined();
  });

  it('"Don\'t show again" is stored per project and hides the offer', async () => {
    const r = await post('/api/demo', { action: 'dismiss' });
    expect(r.status).toBe(200);
    expect(JSON.parse(fs.readFileSync(path.join(folder, 'demo-offer.json'), 'utf8')).dismissed).toBe(true);
    expect((await state()).demo.offer).toBe(false);
  });

  it('the first real task ends the offer', async () => {
    fs.rmSync(path.join(folder, 'demo-offer.json'));
    expect((await state()).demo.offer).toBe(true);
    const add = await run(env, root, 'queue.mjs', 'add', '--json', JSON.stringify({ id: 'EX-1', title: 'A real task', class: 'K', domain: 'example', project: 'example', value: 5, content_min: 30, mission: 'Do it.', owned_files: ['a.ts'], batched: true }));
    expect(add.code, add.out).toBe(0);
    expect((await state()).demo.offer).toBe(false);
  });
});
