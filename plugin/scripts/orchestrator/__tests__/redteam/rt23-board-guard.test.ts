// =============================================================
// redteam/rt23-board-guard.test.ts: RT-23 "a web page I visit, or another program on my machine, cannot read or change
// my board".
//
// Why: the board (queue-board.mjs) is a small web server on 127.0.0.1 that can change the queue. Listening on
// 127.0.0.1 alone does not protect it: every web page open in the same browser can send requests to 127.0.0.1, and a
// page on an attacker's domain can point that domain at 127.0.0.1 (DNS rebinding) and then read the answers as if they
// were its own. So the board has guards of its own, in this order:
//   1. Host must be 127.0.0.1:<port> or localhost:<port>, otherwise 421 (this is what stops DNS rebinding: the
//      browser then sends the attacker's name as Host).
//   2. Every /api/ call needs the key from the link the board printed (X-Queue-Key), otherwise 401.
//   3. A write with an Origin header must come from the board itself, otherwise 403.
//   4. A write must have Content-Type application/json, otherwise 415 (a plain HTML form cannot send that).
//   5. A body over 16 KB is refused before anything is parsed.
// And GET /api/task shows a task's mission file: that file must not be a symlink or junction that leads outside the
// project, the same rule as /api/doc (else the board would read any file the link points to).
//
// The test starts the real board as a process on a free port against a temporary project (project.ts), makes real
// HTTP requests with node:http (fetch does not let us set the Host header), and checks for every refused write that
// queue.json is byte for byte unchanged. One request with the right key, Host and Origin must work, so the test proves
// the guards and not a dead server. The board's key is never printed: no assertion message or error text carries it.
// =============================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { project, SCRIPTS, task, tmp } from './project';

/** A free port on 127.0.0.1: the OS picks one, we close it again and hand the number to the board. */
const freePort = () =>
  new Promise<number>((done) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => done(port));
    });
  });

type Answer = { status: number | null; body: string; error?: string };

/**
 * One HTTP request to the board with exactly the headers we give. Resolves with the status and body, or with
 * `error` when the server dropped the connection (that also counts as refused). It never rejects.
 */
function call(port: number, o: { method?: string; path: string; headers?: Record<string, string>; body?: string | Buffer }) {
  return new Promise<Answer>((done) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: o.method ?? 'GET', path: o.path, headers: o.headers ?? {}, agent: false },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d) => (body += d));
        res.on('end', () => done({ status: res.statusCode ?? null, body }));
        res.on('error', (e) => done({ status: res.statusCode ?? null, body, error: e.message }));
      },
    );
    req.on('error', (e) => done({ status: null, body: '', error: e.message }));
    if (o.body != null) req.write(o.body);
    req.end();
  });
}

describe('RT-23: a web page I visit, or another program on my machine, cannot read or change my board', () => {
  // The secret a symlinked mission must never reveal, in a folder outside the project.
  const SECRET = 'outside-secret-6f1c';
  const outside = tmp('rt23-outside-');
  fs.writeFileSync(path.join(outside, 'secret.md'), `${SECRET}\n`);

  // Task A has a mission file inside the project (the normal case). M1 and M2 point at mission paths that will be a
  // symlinked file and a junctioned folder (made in beforeAll; created links that the OS refuses are skipped).
  const p = project({
    tasks: [
      task('A', { mission: 'missions/A.md' }),
      task('B'),
      task('M1', { mission: 'missions/link-file.md', domain: 'm1' }),
      task('M2', { mission: 'linked-dir/secret.md', domain: 'm2' }),
    ],
  });
  const queueFile = path.join(p.folder, 'queue.json');
  const queueNow = () => fs.readFileSync(queueFile, 'utf8');

  let board: ChildProcess;
  let port = 0;
  // Kept in a closure variable only. Never put into an assertion message, a log line or an error text.
  let key = '';
  let linkFile = false;
  let linkDir = false;

  beforeAll(async () => {
    fs.mkdirSync(path.join(p.repo, 'missions'), { recursive: true });
    fs.writeFileSync(path.join(p.repo, 'missions', 'A.md'), 'The real mission of A.\n');
    // A file symlink needs a privilege on Windows (developer mode or admin); without it we skip that case.
    try {
      fs.symlinkSync(path.join(outside, 'secret.md'), path.join(p.repo, 'missions', 'link-file.md'), 'file');
      linkFile = true;
    } catch {
      /* the OS refused: the file-symlink case is skipped */
    }
    // A folder junction works on Windows without a privilege ('junction' is ignored elsewhere: a normal symlink).
    try {
      fs.symlinkSync(outside, path.join(p.repo, 'linked-dir'), 'junction');
      linkDir = true;
    } catch {
      /* the OS refused: the junction case is skipped */
    }

    port = await freePort();
    board = spawn(process.execPath, [path.join(SCRIPTS, 'queue-board.mjs'), '--port', String(port)], {
      cwd: p.folder,
      // No update check against GitHub from a test.
      env: { ...p.env, DISABLE_UPDATES: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
    });
    let err = '';
    board.stderr!.on('data', (d: Buffer) => (err += String(d)));
    key = await new Promise<string>((done, fail) => {
      let out = '';
      // The error text says only that the line did not come, never what stdout had (it would carry the key).
      const timer = setTimeout(() => fail(new Error(`the board printed no start line (stderr: ${err.slice(0, 500)})`)), 60_000);
      board.stdout!.on('data', (d: Buffer) => {
        out += String(d);
        const m = /Open: http:\/\/[^/\s]+\/#key=(\S+)/.exec(out);
        if (m) {
          clearTimeout(timer);
          done(m[1]);
        }
      });
      board.once('exit', (code) => fail(new Error(`the board stopped at start (code ${code}, stderr: ${err.slice(0, 500)})`)));
    });
  }, 90_000);

  afterAll(async () => {
    if (!board || board.exitCode != null) return;
    const gone = new Promise((done) => board.once('exit', done));
    board.kill();
    await gone;
  });

  // The headers a request from the board's own page carries.
  const host = () => `127.0.0.1:${port}`;
  const own = (extra: Record<string, string> = {}) => ({
    Host: host(),
    Origin: `http://${host()}`,
    'Content-Type': 'application/json',
    'X-Queue-Key': key,
    ...extra,
  });
  // A real write: `ravenseat guidance quiet` through the board changes queue.json.
  const write = (headers: Record<string, string>, body: string | Buffer = JSON.stringify({ mode: 'quiet' })) =>
    call(port, { method: 'POST', path: '/api/guidance', headers, body });

  it('without the key, or with a wrong one, nothing is read and nothing is changed (401)', async () => {
    const before = queueNow();
    const { 'X-Queue-Key': _drop, ...noKey } = own();
    expect((await call(port, { path: '/api/state', headers: { Host: host() } })).status).toBe(401);
    expect((await call(port, { path: '/api/task?id=A', headers: { Host: host() } })).status).toBe(401);
    expect((await write(noKey)).status).toBe(401);
    // Same length as the real key, so the length check alone does not decide; and an empty and a short one.
    for (const wrong of ['x'.repeat(key.length), '', 'abc'])
      expect((await write(own({ 'X-Queue-Key': wrong }))).status).toBe(401);
    expect(queueNow() === before, 'queue.json changed after refused writes').toBe(true);
  });

  it('a foreign Host is refused before anything else (421), also with the right key', async () => {
    const before = queueNow();
    for (const h of ['evil.example', `evil.example:${port}`, `127.0.0.1:${port + 1}`, 'localhost', '[::1]:' + port]) {
      expect((await call(port, { path: '/', headers: { Host: h } })).status, h).toBe(421);
      expect((await call(port, { path: '/api/state', headers: { Host: h, 'X-Queue-Key': key } })).status, h).toBe(421);
      expect((await write(own({ Host: h }))).status, h).toBe(421);
    }
    expect(queueNow() === before, 'queue.json changed after refused writes').toBe(true);
  });

  it('DNS rebinding: an attacker domain that resolves to 127.0.0.1 is still a foreign Host (421)', async () => {
    // The browser connects to 127.0.0.1 (the attacker's DNS said so), but sends the attacker's name as Host and as
    // Origin. That is exactly this request: the TCP connection goes to the board, the names are the attacker's.
    const before = queueNow();
    const rebound = `rebind.attacker.example:${port}`;
    expect((await call(port, { path: '/', headers: { Host: rebound } })).status).toBe(421);
    expect((await call(port, { path: '/api/state', headers: { Host: rebound } })).status).toBe(421);
    expect((await write(own({ Host: rebound, Origin: `http://${rebound}` }))).status).toBe(421);
    expect(queueNow() === before, 'queue.json changed after a rebinding write').toBe(true);
  });

  it('a write from a foreign Origin is refused (403), even with the right key and Host', async () => {
    const before = queueNow();
    for (const o of ['http://evil.example', 'null', `http://localhost:${port + 1}`, `https://${host()}`])
      expect((await write(own({ Origin: o }))).status, o).toBe(403);
    expect(queueNow() === before, 'queue.json changed after a foreign-origin write').toBe(true);
  });

  it('a write that is not JSON is refused (415): what a plain HTML form or a "simple" request can send', async () => {
    const before = queueNow();
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x'])
      expect((await write(own({ 'Content-Type': type }), 'mode=quiet')).status, type).toBe(415);
    const { 'Content-Type': _drop, ...noType } = own();
    expect((await write(noType)).status, 'no content type').toBe(415);
    expect(queueNow() === before, 'queue.json changed after a non-JSON write').toBe(true);
  });

  it('a body over 16 KB is refused, and nothing is changed', async () => {
    const before = queueNow();
    // Valid JSON, so only the size can be the reason: { mode: 'quiet', pad: 'xxxx...' } of about 20 KB.
    const big = JSON.stringify({ mode: 'quiet', pad: 'x'.repeat(20_000) });
    const r = await write(own(), big);
    // Refused means: the connection is dropped, or an error status. Never a 2xx.
    const refused = r.error != null || (r.status != null && r.status >= 400);
    expect(refused, `status ${r.status}`).toBe(true);
    expect(queueNow() === before, 'queue.json changed after an oversized write').toBe(true);
  });

  it("GET /api/task shows a mission file inside the project, but never one a symlink or junction leads outside", async (ctx) => {
    const show = async (id: string) => {
      const r = await call(port, { path: `/api/task?id=${id}`, headers: { Host: host(), 'X-Queue-Key': key } });
      expect(r.status, id).toBe(200);
      return JSON.parse(r.body).mission as { text: string; path: string | null };
    };
    // The normal case works: the file is read and its path is given.
    expect(await show('A')).toEqual({ text: 'The real mission of A.\n', path: 'missions/A.md' });
    if (!linkFile && !linkDir) ctx.skip();
    if (linkFile) {
      const m = await show('M1');
      expect(m.text.includes(SECRET), 'a symlinked mission file was read').toBe(false);
      expect(m.path).toBeNull();
    }
    if (linkDir) {
      const m = await show('M2');
      expect(m.text.includes(SECRET), 'a mission under a junction was read').toBe(false);
      expect(m.path).toBeNull();
    }
  });

  // Last, because it changes queue.json: proves the server is alive and the guards are what refused the rest.
  it('with the right key, Host and Origin the same write works', async () => {
    const before = queueNow();
    const r = await write(own());
    expect(r.status, r.body.slice(0, 300)).toBe(200);
    expect(queueNow() === before, 'queue.json did not change after an accepted write').toBe(false);
    // localhost:<port> is the other valid Host, and a write without Origin (a script, not a browser) is allowed.
    const { Origin: _drop, ...noOrigin } = own({ Host: `localhost:${port}` });
    expect((await write(noOrigin, JSON.stringify({ mode: 'guided' }))).status).toBe(200);
  });
});
