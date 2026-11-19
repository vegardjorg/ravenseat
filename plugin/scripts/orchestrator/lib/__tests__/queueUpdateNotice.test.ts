// =============================================================
// queueUpdateNotice.test.ts: the update notice end to end (roadmap 0u3). Runs the real queue.mjs show, doctor and
// update dismiss in a temporary project. The "published manifest" is a local http server on 127.0.0.1
// (QUEUE_UPDATE_URL, honoured only for a loopback address), so no test goes on the network.
// =============================================================
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

const PLUGIN = path.resolve(__dirname, '..', '..', '..', '..');
const QUEUE = path.join(PLUGIN, 'scripts', 'orchestrator', 'queue.mjs');
const INSTALLED = JSON.parse(fs.readFileSync(path.join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8')).version as string;
const NEWER = `${Number(INSTALLED.split('.')[0]) + 1}.0.0`;
const temporary: string[] = [];

// The local "GitHub": answers the manifest with NEWER, and counts the requests.
let requests = 0;
let server: http.Server;
let url = '';
beforeAll(async () => {
  server = http.createServer((_req, res) => {
    requests += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ name: 'ravenseat', version: NEWER }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/plugin.json`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  for (const m of temporary) fs.rmSync(m, { recursive: true, force: true });
});

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-update-notice-'));
  temporary.push(root);
  const g = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: root, stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(root, 'README.md'), 'x\n');
  g('add', 'README.md');
  g('commit', '-q', '-m', 'start');
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, 'queue.json'), JSON.stringify({ tasks: [{ id: 'A-1', status: 'waiting', class: 'K' }], projects: {} }));
  const configFile = path.join(root, 'queue.config.json');
  fs.writeFileSync(configFile, '{}');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    QUEUE_ROOT: root,
    QUEUE_FOLDER: data,
    QUEUE_CONFIG: configFile,
    QUEUE_GIT: root,
    QUEUE_HOOKS: path.join(PLUGIN, 'hooks', 'hooks.json'),
    QUEUE_TIME_LOG: path.join(data, 'times.jsonl'),
    QUEUE_TRANSCRIPTS: path.join(data, 'transcripts'),
    QUEUE_UPDATE_URL: url,
  };
  delete env.CI;
  delete env.QUEUE_AGENT_ROLE;
  delete env.QUEUE_ROLE;
  delete env.QUEUE_HOOK;
  delete env.DISABLE_UPDATES;
  delete env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
  const cache = path.join(data, 'update-check.json');
  /** Sync run (fine where the server need not answer during the run). */
  const run = (args: string[], extra: NodeJS.ProcessEnv = {}) => {
    const r = spawnSync(process.execPath, [QUEUE, ...args], { encoding: 'utf8', env: { ...env, ...extra }, cwd: root });
    return { code: r.status, out: r.stdout ?? '', error: r.stderr ?? '' };
  };
  /** Async run, so the local server can answer while the command waits on it (doctor). */
  const runAsync = (args: string[], extra: NodeJS.ProcessEnv = {}) =>
    new Promise<{ code: number; out: string }>((resolve) => {
      execFile(process.execPath, [QUEUE, ...args], { encoding: 'utf8', env: { ...env, ...extra }, cwd: root }, (e, out) =>
        resolve({ code: e ? Number((e as { code?: number }).code ?? 1) : 0, out: String(out ?? '') }),
      );
    });
  const writeCache = (o: object) => fs.writeFileSync(cache, JSON.stringify(o));
  const readCache = () => JSON.parse(fs.readFileSync(cache, 'utf8'));
  return { root, data, cache, run, runAsync, writeCache, readCache, configFile };
}

const LINE = `ravenseat ${NEWER} is out (you have ${INSTALLED}): claude plugin update ravenseat@ravenseat, then ravenseat setup --settings`;

describe('ravenseat show', () => {
  it('prints the line from a fresh cache once a day, without starting a refresh', () => {
    const p = project();
    p.writeCache({ checkedAt: Date.now(), latest: NEWER });
    const first = p.run(['show']);
    expect(first.code).toBe(0);
    expect(first.out).toContain(LINE);
    expect(p.readCache().refreshStartedAt).toBeUndefined();
    // Shown once: the next show the same day is quiet.
    expect(p.run(['show']).out).not.toContain('is out (you have');
  });

  it('a cache older than 24 h starts a background refresh; the answer is there next time', async () => {
    const p = project();
    p.writeCache({ checkedAt: Date.now() - 25 * 3_600_000, latest: INSTALLED });
    const before = requests;
    const r = p.run(['show']);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain('is out (you have');
    // The detached refresh writes the cache by itself after show has exited.
    const until = Date.now() + 15_000;
    while (Date.now() < until && !(fs.existsSync(p.cache) && p.readCache().latest === NEWER))
      await new Promise((ok) => setTimeout(ok, 100));
    expect(p.readCache().latest).toBe(NEWER);
    expect(requests).toBeGreaterThan(before);
    expect(p.run(['show']).out).toContain(LINE);
  }, 30_000);

  it('is silent for an agent role, in CI and in a hook, and starts no refresh there', () => {
    const p = project();
    p.writeCache({ checkedAt: Date.now() - 25 * 3_600_000, latest: NEWER });
    for (const extra of [{ QUEUE_AGENT_ROLE: 'track' }, { CI: 'true' }, { QUEUE_HOOK: '1' }]) {
      const r = p.run(['show'], extra);
      expect(r.code).toBe(0);
      expect(r.out).not.toContain('is out (you have');
    }
    expect(p.readCache().refreshStartedAt).toBeUndefined();
  });

  it('off with updates.check false and with the old board.updateCheck false', () => {
    for (const config of [{ updates: { check: false } }, { board: { updateCheck: false } }]) {
      const p = project();
      fs.writeFileSync(p.configFile, JSON.stringify(config));
      p.writeCache({ checkedAt: Date.now(), latest: NEWER });
      expect(p.run(['show']).out).not.toContain('is out (you have');
    }
  });

  it('ordinary commands never print it', () => {
    const p = project();
    p.writeCache({ checkedAt: Date.now(), latest: NEWER });
    expect(p.run(['next']).out).not.toContain('is out (you have');
    expect(p.run(['state']).out).not.toContain('is out (you have');
  });
});

describe('ravenseat update dismiss', () => {
  it('hides the version in show and doctor, stored where the board reads it', async () => {
    const p = project();
    p.writeCache({ checkedAt: Date.now(), latest: NEWER });
    const d = p.run(['update', 'dismiss']);
    expect(d.code).toBe(0);
    expect(d.out).toContain(NEWER);
    expect(p.readCache().dismissed).toBe(NEWER);
    expect(p.run(['show']).out).not.toContain('is out (you have');
    expect((await p.runAsync(['doctor'])).out).not.toContain('is out (you have');
  }, 30_000);

  it('with nothing known it says so and exits 0', () => {
    const p = project();
    const d = p.run(['update', 'dismiss']);
    expect(d.code).toBe(0);
    expect(d.out).toMatch(/no newer version/i);
    expect(fs.existsSync(p.cache)).toBe(false);
  });
});

describe('ravenseat doctor', () => {
  it('an INFO row every time (not once a day), never WARN or FAIL', async () => {
    const p = project();
    p.writeCache({ checkedAt: Date.now(), latest: NEWER, shown: { version: NEWER, at: Date.now() } });
    const r = await p.runAsync(['doctor']);
    const row = r.out.split('\n').find((l) => l.includes('is out (you have'));
    expect(row).toMatch(/^INFO\s+update\s+/);
    expect(row).toContain(LINE);
    expect((await p.runAsync(['doctor'])).out).toContain(LINE);
  }, 30_000);

  it('checks directly when the cache is old (3 s timeout) and writes the cache', async () => {
    const p = project();
    const before = requests;
    const r = await p.runAsync(['doctor']);
    expect(requests).toBe(before + 1);
    expect(r.out).toContain(LINE);
    expect(p.readCache().latest).toBe(NEWER);
  }, 30_000);

  it('--json has no update row and does not go on the network', async () => {
    const p = project();
    const before = requests;
    const r = await p.runAsync(['doctor', '--json']);
    const j = JSON.parse(r.out) as { checks: { name: string }[] };
    expect(j.checks.some((c) => c.name === 'update')).toBe(false);
    expect(requests).toBe(before);
  }, 30_000);
});
