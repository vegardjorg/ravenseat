// =============================================================
// boardKeyHidden.test.ts: the board key never reaches the output Claude reads (0l bolk 5, board.hideKey).
//
// The key gives every owner action on the board. Claude starts the board in the background and reads its stdout and
// stderr, so neither may carry it: the board opens the browser itself (never under a test runner) and prints the link
// without the key. `board open` asks the running board to open it again, without a key. A write without the board's
// Origin is refused. The key file (--key-file) is how a test knows the key; with board.hideKey false the start line
// carries the key again, which also proves this test would see a key that is printed.
// The key is never put into an assertion message or a log line here: a failing check says only that it was found.
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

/** Runs a script to its end; resolves with the exit code and everything it wrote. */
const run = (env: NodeJS.ProcessEnv, cwd: string, script: string, ...args: string[]) =>
  new Promise<{ code: number | null; out: string }>((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(SCRIPTS, script), ...args], { cwd, env });
    let out = '';
    p.stdout.on('data', (d) => (out += String(d)));
    p.stderr.on('data', (d) => (out += String(d)));
    p.on('error', reject);
    p.on('close', (code) => resolve({ code, out }));
  });

type Board = { proc: ChildProcess; port: number; base: string; key: string | null; output: () => string; keyFile: string | null };

/** Starts the board and waits for the start line; with a key file also for the key. */
async function startBoard(env: NodeJS.ProcessEnv, cwd: string, { keyFile = true } = {}): Promise<Board> {
  const port = await freePort();
  const kf = keyFile ? keyFileArgs() : null;
  const proc = spawn(process.execPath, [path.join(SCRIPTS, 'queue-board.mjs'), '--port', String(port), ...(kf?.args ?? [])], { cwd, env });
  let all = '';
  proc.stdout!.on('data', (d) => (all += String(d)));
  proc.stderr!.on('data', (d) => (all += String(d)));
  const found = await new Promise<{ base: string; key: string | null }>((done, fail) => {
    const t = setTimeout(() => fail(new Error('the board printed no start line')), 60_000);
    const check = () => {
      if (kf) {
        const m = boardOpen(all, kf.file);
        if (m) return (clearTimeout(t), done({ base: m[1], key: m[2] }));
      } else {
        const m = /Open: (http:\/\/[^/\s]+)\//.exec(all);
        if (m && /Queue: /.test(all)) return (clearTimeout(t), done({ base: m[1], key: null }));
      }
      setTimeout(check, 50);
    };
    check();
  });
  return { proc, port, ...found, output: () => all, keyFile: kf?.file ?? null };
}

async function stop(b: Board | null) {
  if (!b || b.proc.exitCode != null) return;
  const gone = new Promise((done) => b.proc.once('exit', done));
  b.proc.kill();
  await gone;
}

let root = '';
let env: NodeJS.ProcessEnv = {};
const configFile = () => path.join(root, 'queue.config.json');

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ravenseat-board-key-'));
  const folder = path.join(root, 'q');
  fs.mkdirSync(folder);
  env = {
    ...process.env,
    QUEUE_ROOT: root,
    QUEUE_FOLDER: folder,
    QUEUE_CONFIG: configFile(),
    QUEUE_TIME_LOG: path.join(root, 'times.jsonl'),
    QUEUE_GIT: root,
    DISABLE_UPDATES: '1',
  };
  fs.writeFileSync(configFile(), '{}\n');
  const init = await run(env, root, 'queue.mjs', 'init');
  expect(init.code).toBe(0);
}, 60_000);

afterAll(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe('board.hideKey on (the default)', () => {
  let b: Board | null = null;
  beforeAll(async () => {
    b = await startBoard(env, root);
  }, 90_000);
  afterAll(() => stop(b));

  it('the start line has the link without the key; the key is only in the key file', () => {
    const out = b!.output();
    expect(out).toMatch(/Open: http:\/\/127\.0\.0\.1:\d+\/ \(/);
    expect(out).not.toMatch(/#key=/);
    expect(out.includes(b!.key!), 'the key was printed by the board').toBe(false);
    expect(fs.readFileSync(b!.keyFile!, 'utf8')).toContain(`#key=${b!.key}`);
  });

  it('the key works for a read, and a write without the Origin of the board is refused (403)', async () => {
    const state = await fetch(`${b!.base}/api/state`, { headers: { 'x-queue-key': b!.key! } });
    expect(state.status).toBe(200);
    const write = await fetch(`${b!.base}/api/guidance`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-queue-key': b!.key! },
      body: JSON.stringify({ mode: 'quiet' }),
    });
    expect(write.status).toBe(403);
    const own = await fetch(`${b!.base}/api/guidance`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: b!.base, 'x-queue-key': b!.key! },
      body: JSON.stringify({ mode: 'quiet' }),
    });
    expect(own.status).toBe(200);
  });

  it('board open needs no key and prints none; the key file is written again', async () => {
    fs.rmSync(b!.keyFile!);
    const r = await run(env, root, 'queue-board.mjs', 'open', '--port', String(b!.port));
    expect(r.code).toBe(0);
    expect(r.out.includes(b!.key!), 'board open printed the key').toBe(false);
    expect(r.out).not.toMatch(/#key=/);
    expect(fs.readFileSync(b!.keyFile!, 'utf8')).toContain(`#key=${b!.key}`);
    // Through the CLI name too (ravenseat board open).
    await new Promise((done) => setTimeout(done, 2100)); // one open per 2 s
    const cli = await run(env, root, 'ravenseat.mjs', 'board', 'open', '--port', String(b!.port));
    expect(cli.code).toBe(0);
    expect(cli.out.includes(b!.key!), 'ravenseat board open printed the key').toBe(false);
  }, 30_000);

  it('a web page cannot use /open (a request with Origin is refused), and nothing on the board side printed the key', async () => {
    const page = await fetch(`${b!.base}/open`, { method: 'POST', headers: { origin: 'http://evil.example' } });
    expect(page.status).toBe(403);
    const body = await page.text();
    expect(body.includes(b!.key!)).toBe(false);
    // An error answer must not carry the key either.
    const bad = await fetch(`${b!.base}/api/state`, { headers: { 'x-queue-key': 'wrong' } });
    expect((await bad.text()).includes(b!.key!)).toBe(false);
    expect(b!.output().includes(b!.key!), 'the board printed the key later').toBe(false);
  });

  it('board open with no board on the port says so, and exits 1', async () => {
    const r = await run(env, root, 'queue-board.mjs', 'open', '--port', String(await freePort()));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/No board answers on port/);
  }, 30_000);
});

describe('without --key-file (the way Claude starts it)', () => {
  it('prints no key at all, and says the board opens in the browser (no browser under the test runner)', async () => {
    const b = await startBoard(env, root, { keyFile: false });
    try {
      const out = b.output();
      expect(out).not.toMatch(/key=/);
      expect(out).toMatch(/it opens in your browser; .* board open opens it again/);
    } finally {
      await stop(b);
    }
  }, 90_000);
});

describe('board.hideKey false (a weakened guard): the old start line', () => {
  it('prints the link with the key, so this test would see a printed key', async () => {
    fs.writeFileSync(configFile(), JSON.stringify({ board: { hideKey: false } }));
    const b = await startBoard(env, root);
    try {
      expect(b.output().includes(`#key=${b.key}`), 'the key is not in the start line').toBe(true);
    } finally {
      await stop(b);
      fs.writeFileSync(configFile(), '{}\n');
    }
  }, 90_000);
});
