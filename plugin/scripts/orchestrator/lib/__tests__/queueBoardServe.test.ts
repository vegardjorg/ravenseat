// =============================================================
// queueBoardServe.test.ts: the board server serves the board's client scripts (queue-board/board/, see docs/board.md).
//
// The board's own client is classic scripts in queue-board/board/ that index.html loads in order. This test starts
// queue-board.mjs on a temporary queue and proves that:
//   - every script and stylesheet index.html points to is served (200) with the right content type and the file's
//     bytes, so a module that is missing from the server's allow list shows up here and not as a blank board,
//   - the board's scripts in index.html are exactly the files in queue-board/board/ (none left out, none extra),
//   - the Content-Security-Policy and the other security headers are the same strict ones as before the split,
//   - only allow-listed paths are served: the old /board.js and an unknown file under /board/ give 404,
//   - an answer from a choice button (POST /api/action { type: 'resolve', choice }) goes through queue.mjs resolve --choice.
// =============================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { CLIENT, boardScripts } from './boardClient';

// The policy is written out in full on purpose: a change to it must be a change to this test too.
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; " +
  "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

let root = '';
let board: ChildProcess | null = null;
let base = '';
let key = '';

/** Runs queue.mjs async (spawnSync blocks the test worker; see helperCustom.test.ts). */
const ravenseat = (env: NodeJS.ProcessEnv, ...args: string[]) =>
  new Promise<number | null>((resolve, reject) => {
    const p = spawn(process.execPath, [path.resolve(__dirname, '..', '..', 'queue.mjs'), ...args], { cwd: root, env });
    p.on('error', reject);
    p.on('close', resolve);
  });

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ravenseat-board-serve-'));
  const folder = path.join(root, 'q');
  fs.mkdirSync(folder);
  const env = {
    ...process.env,
    QUEUE_ROOT: root,
    QUEUE_FOLDER: folder,
    QUEUE_CONFIG: path.join(root, 'no-config.json'),
    QUEUE_TIME_LOG: path.join(root, 'times.jsonl'),
    QUEUE_GIT: root,
    DISABLE_UPDATES: '1',
  };
  expect(await ravenseat(env, 'init')).toBe(0);
  const port = await new Promise<number>((done) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => done(p));
    });
  });
  board = spawn(process.execPath, [path.resolve(__dirname, '..', '..', 'queue-board.mjs'), '--port', String(port)], {
    cwd: root,
    env,
  });
  await new Promise<void>((done, fail) => {
    let out = '';
    let err = '';
    board!.stderr!.on('data', (d) => (err += String(d)));
    const t = setTimeout(() => fail(new Error(`no start line: ${out} ${err}`)), 60_000);
    board!.stdout!.on('data', (d) => {
      out += String(d);
      const m = /Open: (http:\/\/[^/\s]+)\/#key=(\S+)/.exec(out);
      if (m) {
        clearTimeout(t);
        base = m[1];
        key = m[2];
        done();
      }
    });
  });
}, 120_000);

afterAll(async () => {
  // Wait for the process to end: Windows will not delete the folder it runs in before that.
  if (board && board.exitCode == null) {
    const gone = new Promise((done) => board!.once('exit', done));
    board.kill();
    await gone;
  }
  if (root) fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe('the board server and the client scripts', () => {
  it('index.html loads every file in queue-board/board/, and nothing else from there', () => {
    const onDisk = fs
      .readdirSync(path.join(CLIENT, 'board'))
      .filter((f) => f.endsWith('.js'))
      .map((f) => `board/${f}`)
      .sort();
    const loaded = boardScripts();
    expect(loaded.length).toBeGreaterThan(10);
    expect([...loaded].sort()).toEqual(onDisk);
    expect(new Set(loaded).size).toBe(loaded.length);
    expect(loaded[0]).toBe('board/core.js');
    expect(loaded.at(-1)).toBe('board/start.js');
  });

  it('serves the page and every script and stylesheet it points to, with the right type and the strict CSP', async () => {
    const page = await fetch(`${base}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toBe(CSP);
    const html = await page.text();
    const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
    const styles = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((m) => m[1]);
    for (const f of boardScripts()) expect(scripts).toContain(`/${f}`);
    for (const [list, type] of [
      [scripts, 'text/javascript; charset=utf-8'],
      [styles, 'text/css; charset=utf-8'],
    ] as const) {
      for (const src of list) {
        const r = await fetch(`${base}${src}`);
        expect(r.status, src).toBe(200);
        expect(r.headers.get('content-type'), src).toBe(type);
        expect(r.headers.get('content-security-policy'), src).toBe(CSP);
        expect(r.headers.get('x-content-type-options'), src).toBe('nosniff');
        expect(r.headers.get('cross-origin-resource-policy'), src).toBe('same-origin');
        expect(r.headers.get('cache-control'), src).toBe('no-cache');
        const body = Buffer.from(await r.arrayBuffer());
        if (src.startsWith('/board/')) expect(body.equals(fs.readFileSync(path.join(CLIENT, src.slice(1)))), src).toBe(true);
      }
    }
  }, 60_000);

  it('serves only the allow-listed files: the old /board.js and an unknown file under /board/ give 404', async () => {
    for (const p of ['/board.js', '/board/unknown.js', '/board/', '/board']) {
      const r = await fetch(`${base}${p}`);
      expect(r.status, p).toBe(404);
      await r.arrayBuffer();
    }
  }, 30_000);
});

describe('the board server: an owner question answered with a choice button', () => {
  it('POST /api/action { type: resolve, choice } stores the choice text with the note; an unknown choice gives 400', async () => {
    // The same environment as the server (beforeAll), so the question lands in the queue the board reads.
    const env = {
      ...process.env,
      QUEUE_ROOT: root,
      QUEUE_FOLDER: path.join(root, 'q'),
      QUEUE_CONFIG: path.join(root, 'no-config.json'),
      QUEUE_TIME_LOG: path.join(root, 'times.jsonl'),
      QUEUE_GIT: root,
      DISABLE_UPDATES: '1',
    };
    expect(
      await ravenseat(env, 'question', 'PICK-1', '--text', 'Which vendor?', '--choice', 'Vendor A', '--choice', 'Vendor B'),
    ).toBe(0);
    const post = async (body: object) => {
      const r = await fetch(`${base}/api/action`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-queue-key': key },
        body: JSON.stringify(body),
      });
      return { status: r.status, body: (await r.json()) as { ok: boolean; message?: string } };
    };
    const unknown = await post({ type: 'resolve', sp: 'PICK-1', choice: 3 });
    expect(unknown.status).toBe(400);
    expect(unknown.body.message).toBe('unknown choice');
    const queueFile = path.join(root, 'q', 'queue.json');
    expect(JSON.parse(fs.readFileSync(queueFile, 'utf8')).resolutions?.['PICK-1']).toBeUndefined();

    const ok = await post({ type: 'resolve', sp: 'PICK-1', choice: 2, answer: 'from March' });
    expect(ok.status, ok.body.message).toBe(200);
    const queue = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
    expect(queue.resolved).toContain('PICK-1');
    expect(queue.resolutions['PICK-1']).toMatchObject({ answer: 'Vendor B (note: from March)', by: 'owner' });
  }, 60_000);
});
