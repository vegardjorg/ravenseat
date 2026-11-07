// =============================================================
// queueCloudTracks.test.ts: cloud tracks on a normal subscription.
//
// What this file proves, where it is enforced:
//   - the limit on sessions comes from the config, and the package needs nothing from the plugin (lib/logic/cloud.js),
//   - the finish marker on a pushed branch is what `cloud check` reads (one read, no loop),
//   - a routine fire is never retried and says whether a session may exist (lib/cloudFire.js),
//   - cloud starts obey the usage limit pause, and receive records the evidence at home (queue.mjs, cloud-start.mjs).
//
// Everything outward is a fake: a temporary bare origin, a local HTTP server for the routine endpoint and a small script
// for `claude`. No real session starts here. What the real service does is not proven by this file.
// =============================================================
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

const CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-cloudtracks-config-'));
const CONFIG_FILE = path.join(CONFIG_DIR, 'queue.config.json');
fs.writeFileSync(
  CONFIG_FILE,
  JSON.stringify({ features: { cloud: true }, cloud: { maxSessions: 2 }, gates: { quick: ['npm run lint', 'npm test'] } }),
);
process.env.QUEUE_CONFIG = CONFIG_FILE;

type Task = Record<string, unknown> & { id: string; status: string; cloud?: Record<string, string> };
type Queue = { tasks: Task[]; resolved?: string[]; projects?: object };

/* eslint-disable @typescript-eslint/no-require-imports */
const L = require('../queueLogic') as {
  resetConfig: () => void;
  CLOUD_MAX: number;
  cloudMax: () => number;
  cloudMarker: (message: string, id: string) => { kind: 'done' | 'stop'; reason: string | null } | null;
  cloudBranches: (id: string) => string[];
  cloudPackage: (o: Task, queue: Queue, v: { text: string }) => string;
  cloudBundlePackage: (parts: { o: Task; text: string }[], queue: Queue) => string;
  cloudStart: (queue: Queue, ids: string | string[], v?: object) => { error?: string };
};
const KC = require('../queueConfig') as { config: (o?: { fresh?: boolean }) => object };
const F = require('../cloudFire') as {
  FIRE_TEXT_MAX: number;
  validFireUrl: (url: unknown, v?: { allowLoopback?: boolean }) => boolean;
  fireRoutine: (v: {
    url: string;
    token: string;
    text: string;
    fetchImpl: (url: string, init: { headers: Record<string, string>; body: string }) => Promise<unknown>;
  }) => Promise<{ ok: boolean; created?: boolean | null; sessionUrl?: string; retryAfter?: string | null; message?: string }>;
};
const S = require('../cloudSetup') as {
  cloudSetupRows: (facts: object) => { status: string; name: string; message: string; fix: string | null }[];
};
/* eslint-enable @typescript-eslint/no-require-imports */

const NOW = '2026-11-07T10:00:00.000Z';
const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const SCRIPTS = path.join(ROOT, 'scripts', 'orchestrator');
const ID = ['-c', 'user.email=t@example.com', '-c', 'user.name=Test', '-c', 'commit.gpgsign=false'];

const o = (id: string, extra: object = {}): Task => ({
  id,
  title: `Task ${id}`,
  domain: 'app',
  class: 'K',
  status: 'waiting',
  mission: `Mission for ${id}.`,
  value: 5,
  content_min: 30,
  migr_tens: 0,
  depends_on: [],
  waiting_on: [],
  owned_files: [`lib/${id}.ts`],
  owner_db: [],
  shared_patch: [],
  project: 'app',
  feature: 'x',
  ...extra,
});

describe('the session limit', () => {
  it('comes from cloud.maxSessions, and the default stays 3', () => {
    L.resetConfig();
    expect(L.CLOUD_MAX).toBe(3);
    expect(L.cloudMax()).toBe(2);
    const running = (id: string) => o(id, { status: 'picked', picked_by: 'cloud', cloud: { started: NOW } });
    const q = { tasks: [running('A'), running('B'), o('C')] };
    expect(L.cloudStart(q, 'C').error).toMatch(/2 cloud sessions are already running \(at most 2\)/);
  });

  it('falls back to the default on a value that is not a whole number above 0', () => {
    for (const bad of [0, -1, 1.5, 'many']) {
      fs.writeFileSync(CONFIG_FILE, JSON.stringify({ cloud: { maxSessions: bad } }));
      KC.config({ fresh: true });
      L.resetConfig();
      expect(L.cloudMax()).toBe(3);
    }
    fs.writeFileSync(
      CONFIG_FILE,
      JSON.stringify({ features: { cloud: true }, cloud: { maxSessions: 2 }, gates: { quick: ['npm run lint', 'npm test'] } }),
    );
    KC.config({ fresh: true });
    L.resetConfig();
  });
});

describe('the package is self-contained', () => {
  const a = o('A');
  const single = () => L.cloudPackage(a, { tasks: [a] }, { text: 'Do A.' });
  const bundle = () => {
    const b = o('B');
    return L.cloudBundlePackage([{ o: a, text: 'Do A.' }, { o: b, text: 'Do B.' }], { tasks: [a, b] });
  };

  it('names the literal gate commands, because the plugin is not installed in a cloud session', () => {
    L.resetConfig();
    for (const p of [single(), bundle()]) {
      expect(p).not.toMatch(/ravenseat gates|gates --quick/);
      expect(p).toContain('`npm run lint`');
      expect(p).toContain('`npm test`');
      expect(p).toMatch(/not installed/);
      expect(p).toMatch(/evidence/);
    }
  });

  it('tells the session how to mark the end on the branch, since nothing at home can read its transcript', () => {
    const p = single();
    expect(p).toContain('git commit --allow-empty -m "CLOUD-DONE A"');
    expect(p).toContain('git commit --allow-empty -m "CLOUD-STOP A <reason>"');
    const b = bundle();
    expect(b).toContain('git commit --allow-empty -m "CLOUD-DONE <id>"');
  });

  it('gives one fixed fallback branch, and warns about what the GitHub proxy rejects', () => {
    expect(L.cloudBranches('A')).toEqual(['queue/A', 'claude/A']);
    const p = single();
    expect(p).toContain('claude/A');
    expect(p).not.toContain('for example claude/...');
    expect(p).toMatch(/gh pr/);
    expect(p).toMatch(/tag/);
  });
});

describe('cloudMarker', () => {
  it('reads the marker for this id only', () => {
    expect(L.cloudMarker('CLOUD-DONE A', 'A')).toEqual({ kind: 'done', reason: null });
    expect(L.cloudMarker('feat: x\n\nCLOUD-DONE A abc123\n', 'A')).toEqual({ kind: 'done', reason: null });
    expect(L.cloudMarker('CLOUD-STOP A needs the database', 'A')).toEqual({ kind: 'stop', reason: 'needs the database' });
    expect(L.cloudMarker('CLOUD-DONE A-2', 'A')).toBeNull();
    expect(L.cloudMarker('CLOUD-DONE B', 'A')).toBeNull();
    expect(L.cloudMarker('feat: mention of CLOUD-DONE A in a sentence', 'A')).toBeNull();
  });

  it('cleans the reason, since it comes from outside and is printed at home', () => {
    const r = L.cloudMarker(`CLOUD-STOP A bad\u001b[31mcolour ${'x'.repeat(500)}`, 'A');
    expect(r?.reason).not.toContain('\u001b');
    expect(String(r?.reason).length).toBeLessThanOrEqual(200);
  });

  it('a stop outranks a done in the same message, so a stopped task is never merged by accident', () => {
    expect(L.cloudMarker('CLOUD-DONE A\nCLOUD-STOP A second thoughts', 'A')?.kind).toBe('stop');
  });
});

describe('validFireUrl', () => {
  const GOOD = 'https://api.anthropic.com/v1/claude_code/routines/trig_01ABC-x/fire';
  it('takes the documented endpoint only, so the token never goes anywhere else', () => {
    expect(F.validFireUrl(GOOD)).toBe(true);
    for (const bad of [
      null,
      'http://api.anthropic.com/v1/claude_code/routines/trig_1/fire',
      'https://api.anthropic.com.evil.test/v1/claude_code/routines/trig_1/fire',
      'https://evil.test/https://api.anthropic.com/v1/claude_code/routines/trig_1/fire',
      'https://api.anthropic.com/v1/claude_code/routines/trig_1/fire?x=1',
      'http://127.0.0.1:9/fire',
    ])
      expect(F.validFireUrl(bad)).toBe(false);
    expect(F.validFireUrl('http://127.0.0.1:9/fire', { allowLoopback: true })).toBe(true);
  });
});

describe('fireRoutine', () => {
  const URL_ = 'https://api.anthropic.com/v1/claude_code/routines/trig_1/fire';
  const reply = (status: number, body: unknown, retry: string | null = null) => ({
    status,
    headers: { get: (k: string) => (k.toLowerCase() === 'retry-after' ? retry : null) },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  const fire = (fetchImpl: Parameters<typeof F.fireRoutine>[0]['fetchImpl']) =>
    F.fireRoutine({ url: URL_, token: 'sk-ant-oat01-SECRET', text: 'the package', fetchImpl });

  it('sends the documented request and returns the session link', async () => {
    let seen: { url: string; headers: Record<string, string>; body: string } | null = null;
    const r = await fire(async (url, init) => {
      seen = { url, headers: init.headers, body: init.body };
      return reply(200, {
        type: 'routine_fire',
        claude_code_session_id: 'session_1',
        claude_code_session_url: 'https://claude.ai/code/session_1',
      });
    });
    expect(r).toMatchObject({ ok: true, sessionUrl: 'https://claude.ai/code/session_1' });
    expect(seen!.url).toBe(URL_);
    expect(seen!.headers.Authorization).toBe('Bearer sk-ant-oat01-SECRET');
    expect(seen!.headers['anthropic-version']).toBeTruthy();
    expect(JSON.parse(seen!.body)).toEqual({ text: 'the package' });
  });

  it('a refusal means no session: created false, with the wait the service asks for', async () => {
    for (const status of [400, 401, 403, 404])
      expect(await fire(async () => reply(status, { error: { message: 'no' } }))).toMatchObject({ ok: false, created: false });
    expect(await fire(async () => reply(429, {}, '120'))).toMatchObject({ ok: false, created: false, retryAfter: '120' });
  });

  it('anything uncertain means a session may exist: created null, and no second call', async () => {
    let calls = 0;
    const count = (x: unknown) => async () => {
      calls += 1;
      if (x instanceof Error) throw x;
      return x;
    };
    expect(await fire(count(reply(500, 'oops')))).toMatchObject({ ok: false, created: null });
    expect(await fire(count(reply(503, 'oops')))).toMatchObject({ ok: false, created: null });
    expect(await fire(count(reply(200, 'not json')))).toMatchObject({ ok: false, created: null });
    expect(await fire(count(new Error('socket hang up')))).toMatchObject({ ok: false, created: null });
    expect(calls).toBe(4);
  });

  it('never repeats the token in what it returns', async () => {
    const r = await fire(async () => {
      throw new Error('failed with Bearer sk-ant-oat01-SECRET');
    });
    expect(JSON.stringify(r)).not.toContain('SECRET');
  });
});

describe('cloudSetupRows', () => {
  const facts = {
    remote: 'origin',
    base: 'main',
    remoteUrl: 'git@github.com:me/repo.git',
    pushed: true,
    unpushed: 0,
    start: 'terminal',
    fireUrlValid: false,
    tokenSet: false,
    maxSessions: 3,
    paused: null,
    ravenseat: 'ravenseat',
  };
  const row = (over: object, name: string) => S.cloudSetupRows({ ...facts, ...over }).find((r) => r.name === name);

  it('passes a GitHub remote and warns about the upload otherwise', () => {
    expect(row({}, 'remote')?.status).toBe('OK');
    expect(row({ remoteUrl: 'https://github.com/me/repo' }, 'remote')?.status).toBe('OK');
    for (const url of [null, 'https://gitlab.com/me/repo.git', 'https://github.com.evil.test/me/repo.git']) {
      const r = row({ remoteUrl: url }, 'remote');
      expect(r?.status).toBe('WARN');
      expect(`${r?.message} ${r?.fix}`).toMatch(/upload/);
    }
  });

  it('says what cannot be checked from here: the GitHub App and the plan', () => {
    const app = row({}, 'github app');
    expect(app?.status).toBe('INFO');
    expect(`${app?.message} ${app?.fix}`).toMatch(/github\.com\/apps\/claude/);
    expect(`${app?.message} ${app?.fix}`).toMatch(/uncommitted/);
    expect(row({}, 'plan')?.message).toMatch(/usage limits/);
    expect(row({}, 'plan')?.message).not.toMatch(/credit/i);
  });

  it('reports the base branch, and what a cloud session does not get', () => {
    expect(row({ pushed: false }, 'base')?.status).toBe('WARN');
    expect(row({ unpushed: 4 }, 'base')?.status).toBe('WARN');
    expect(row({}, 'base')?.status).toBe('OK');
    expect(row({}, 'session')?.message).toMatch(/plugin/);
    expect(row({}, 'session')?.message).toMatch(/\/remote-env/);
  });

  it('the routine way needs a valid URL and a token, and never shows the token', () => {
    expect(row({}, 'start')?.status).toBe('OK');
    expect(row({ start: 'routine' }, 'start')?.status).toBe('WARN');
    expect(row({ start: 'routine', fireUrlValid: true }, 'start')?.status).toBe('WARN');
    expect(row({ start: 'routine', fireUrlValid: true, tokenSet: true }, 'start')?.status).toBe('OK');
    expect(row({ start: 'teleport' }, 'start')?.status).toBe('WARN');
    expect(row({ start: 'routine' }, 'start')?.fix).toMatch(/RAVENSEAT_CLOUD_TOKEN/);
  });

  it('shows the login only when it was read, and warns about an API key', () => {
    expect(row({}, 'login')).toBeUndefined();
    expect(row({ auth: 'claude.ai' }, 'login')?.status).toBe('OK');
    expect(row({ auth: 'api_key' }, 'login')?.status).toBe('WARN');
    expect(row({ auth: null }, 'login')?.status).toBe('INFO');
  });

  it('a pause at the usage limit is shown', () => {
    expect(row({ paused: 'until Sat 14:00' }, 'usage')?.status).toBe('WARN');
    expect(row({}, 'usage')).toBeUndefined();
  });
});

// ---- The commands against a temporary repo with a fake origin -------------------------------------------------------
const cleanup: string[] = [CONFIG_DIR];
afterAll(() => {
  for (const d of cleanup) fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 });
});
const tmp = (prefix: string) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanup.push(d);
  return d;
};

/** A repo with a bare origin, a queue with the given tasks and the given config. */
function project(tasks: Task[], config: object = {}, extraEnv: Record<string, string> = {}) {
  const origin = tmp('queue-ct-origin-');
  const repo = tmp('queue-ct-repo-');
  const folder = tmp('queue-ct-folder-');
  const g = (args: string[], cwd = repo) =>
    execFileSync('git', ['-C', cwd, ...ID, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  g(['init', '-q', '--bare'], origin);
  g(['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(repo, 'README.md'), 'start\n');
  g(['add', '--', 'README.md']);
  g(['commit', '-q', '-m', 'start']);
  g(['remote', 'add', 'origin', origin]);
  g(['push', '-q', 'origin', 'main']);
  g(['fetch', '-q', 'origin']);
  const configFile = path.join(folder, 'queue.config.json');
  fs.writeFileSync(configFile, JSON.stringify({ features: { cloud: true }, ...config }));
  fs.writeFileSync(
    path.join(folder, 'queue.json'),
    JSON.stringify({ created: NOW, limits: {}, next_migr: 1, resolved: [], tasks }),
  );
  const env: Record<string, string | undefined> = {
    ...process.env,
    QUEUE_CONFIG: configFile,
    QUEUE_FOLDER: folder,
    QUEUE_GIT: repo,
    QUEUE_ROOT: repo,
    QUEUE_TIME_LOG: path.join(folder, 'times.jsonl'),
    QUEUE_SCRATCHPAD: path.join(folder, 'scratch'),
    RAVENSEAT_CLOUD_TOKEN: undefined,
    // A path that does not exist: claude counts as not installed, so no test runs the real one.
    QUEUE_CLOUD_FAKE_CLAUDE: path.join(folder, 'no-claude.cjs'),
    ...extraEnv,
  };
  const script = (name: string, args: string[], more: object = {}) => {
    const r = spawnSync(process.execPath, [path.join(SCRIPTS, name), ...args], {
      encoding: 'utf8',
      env: { ...env, ...more },
      cwd: repo,
    });
    return { code: r.status, out: r.stdout, error: r.stderr };
  };
  const run = (...args: string[]) => script('queue.mjs', args);
  /** The same, without blocking this process: the fake endpoint lives here. */
  const runAsync = (args: string[], more: object = {}) =>
    new Promise<{ code: number | null; out: string; error: string }>((resolve) => {
      const c = spawn(process.execPath, [path.join(SCRIPTS, 'queue.mjs'), ...args], {
        env: { ...env, ...more },
        cwd: repo,
      });
      let out = '';
      let error = '';
      c.stdout.on('data', (x) => (out += x));
      c.stderr.on('data', (x) => (error += x));
      c.on('close', (code) => resolve({ code, out, error }));
    });
  const task = (id: string): Task =>
    (JSON.parse(fs.readFileSync(path.join(folder, 'queue.json'), 'utf8')) as Queue).tasks.find((x) => x.id === id)!;
  /** What a cloud session does: a branch from the pushed base with a change, and (optionally) the finish marker. */
  const cloudPush = (branch: string, file: string, marker: string | null) => {
    g(['checkout', '-q', '-b', 'cloud-work', 'origin/main']);
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), 'from the cloud\n');
    g(['add', '--', file]);
    g(['commit', '-q', '-m', `edit ${file}`]);
    if (marker) g(['commit', '-q', '--allow-empty', '-m', marker]);
    g(['push', '-q', 'origin', `cloud-work:refs/heads/${branch}`]);
    const sha = g(['rev-parse', 'HEAD']);
    g(['checkout', '-q', 'main']);
    g(['branch', '-q', '-D', 'cloud-work']);
    return sha;
  };
  return { repo, folder, configFile, g, run, runAsync, script, task, cloudPush };
}

/** A local stand-in for the routine endpoint. */
async function fakeEndpoint(status: number, body: object | string, headers: Record<string, string> = {}) {
  const calls: { auth?: string; body: string }[] = [];
  const server = http.createServer((req, res) => {
    let text = '';
    req.on('data', (x) => (text += x));
    req.on('end', () => {
      calls.push({ auth: req.headers.authorization, body: text });
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/fire`, calls, close: () => new Promise((r) => server.close(r)) };
}

const FUTURE = () => new Date(Date.now() + 3_600_000).toISOString();
const pause = (folder: string) =>
  fs.writeFileSync(path.join(folder, 'usage-limit.json'), JSON.stringify({ until: FUTURE(), type: 'seven_day', source: 'test' }));

describe('cloud starts obey the usage limit pause', () => {
  it('cloud start refuses with exit 12, --force overrides, and setting the run on a started task still works', () => {
    const p = project([o('A'), o('B')]);
    expect(p.run('cloud', 'start', 'A').code).toBe(0);
    pause(p.folder);
    const r = p.run('cloud', 'start', 'B');
    expect(r.code).toBe(12);
    expect(`${r.out}${r.error}`).toMatch(/usage limit/i);
    expect(p.task('B').status).toBe('waiting');
    expect(p.run('cloud', 'start', 'A', '--run', 'cse_1').code).toBe(0);
    expect(p.task('A').cloud?.execution).toBe('cse_1');
    expect(p.run('cloud', 'start', 'B', '--force').code).toBe(0);
    expect(p.task('B').status).toBe('picked');
  }, 60_000);
});

describe('cloud-start.mjs with a fake claude', () => {
  /** A script that records its arguments; `exit` is what it exits with. */
  const fakeClaude = (dir: string, exit = 0) => {
    const file = path.join(dir, 'fake-claude.cjs');
    fs.writeFileSync(
      file,
      `require('node:fs').writeFileSync(${JSON.stringify(path.join(dir, 'args.json'))}, JSON.stringify(process.argv.slice(2))); process.exit(${exit});`,
    );
    return file;
  };
  const args = (dir: string): string[] | null => {
    const f = path.join(dir, 'args.json');
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
  };

  it('marks the task, passes the package to --cloud and says nothing about credits', () => {
    const p = project([o('A')]);
    const dir = tmp('queue-ct-claude-');
    const r = p.script('cloud-start.mjs', ['A', '--allow-upload'], { QUEUE_CLOUD_FAKE_CLAUDE: fakeClaude(dir) });
    expect(r.code).toBe(0);
    expect(r.out).not.toMatch(/credit/i);
    const seen = args(dir)!;
    expect(seen[0]).toBe('--cloud');
    expect(seen[1]).toContain('Mission for A.');
    expect(p.task('A').status).toBe('picked');
  }, 60_000);

  it('refuses at the pause and at the session limit without opening claude', () => {
    const p = project([o('A'), o('B')], { cloud: { maxSessions: 1 } });
    const dir = tmp('queue-ct-claude-');
    const env = { QUEUE_CLOUD_FAKE_CLAUDE: fakeClaude(dir) };
    expect(p.run('cloud', 'start', 'A').code).toBe(0);
    const full = p.script('cloud-start.mjs', ['B', '--allow-upload'], env);
    expect(full.code).not.toBe(0);
    expect(`${full.out}${full.error}`).toMatch(/1 cloud sessions are already running \(at most 1\)/);
    expect(args(dir)).toBeNull();
    expect(p.task('B').status).toBe('waiting');
    p.run('cloud', 'cancel', 'A');
    pause(p.folder);
    const paused = p.script('cloud-start.mjs', ['B', '--allow-upload'], env);
    expect(paused.code).toBe(12);
    expect(args(dir)).toBeNull();
  }, 60_000);

  it('refuses a remote that is not on GitHub, because claude --cloud would then upload the local repo', () => {
    const p = project([o('A')]);
    const dir = tmp('queue-ct-claude-');
    const r = p.script('cloud-start.mjs', ['A'], { QUEUE_CLOUD_FAKE_CLAUDE: fakeClaude(dir) });
    expect(r.code).toBe(1);
    expect(`${r.out}${r.error}`).toMatch(/upload/);
    expect(args(dir)).toBeNull();
    expect(p.task('A').status).toBe('waiting');
  }, 60_000);

  it.runIf(process.platform === 'win32')('refuses a package too long for a Windows command line, before anything is marked', () => {
    const p = project([o('A', { mission: 'x'.repeat(40_000) })]);
    const dir = tmp('queue-ct-claude-');
    const r = p.script('cloud-start.mjs', ['A', '--allow-upload'], { QUEUE_CLOUD_FAKE_CLAUDE: fakeClaude(dir) });
    expect(r.code).toBe(1);
    expect(`${r.out}${r.error}`).toMatch(/too long/);
    expect(args(dir)).toBeNull();
    expect(p.task('A').status).toBe('waiting');
  }, 60_000);

  it('puts the task back when claude cannot be started at all', () => {
    const p = project([o('A')]);
    const r = p.script('cloud-start.mjs', ['A', '--allow-upload'], { QUEUE_CLOUD_FAKE_CLAUDE: path.join(p.folder, 'missing.cjs') });
    expect(r.code).not.toBe(0);
    expect(p.task('A').status).toBe('waiting');
  }, 60_000);
});

describe('cloud check reads the pushed branch', () => {
  it('tells nothing pushed, pushed but unmarked, done and stopped apart, and changes nothing', () => {
    const p = project([o('A'), o('B'), o('C'), o('D')]);
    for (const id of ['A', 'B', 'C', 'D']) expect(p.run('cloud', 'start', id, '--force').code).toBe(0);
    const before = fs.readFileSync(path.join(p.folder, 'queue.json'), 'utf8');
    p.cloudPush('queue/B', 'lib/B.ts', null);
    p.cloudPush('queue/C', 'lib/C.ts', 'CLOUD-DONE C');
    p.cloudPush('claude/D', 'lib/D.ts', 'CLOUD-STOP D needs the database');
    const r = p.run('cloud', 'check');
    expect(r.code).toBe(0);
    const line = (id: string) => r.out.split('\n').find((l) => l.startsWith(`${id}:`)) ?? '';
    expect(line('A')).toMatch(/nothing pushed/);
    expect(line('B')).toMatch(/no finish marker/);
    expect(line('C')).toMatch(/finished/);
    expect(r.out).toContain('cloud done C --branch queue/C');
    expect(line('D')).toMatch(/stopped/);
    expect(line('D')).toContain('needs the database');
    expect(r.out).toContain('cloud cancel D');
    expect(fs.readFileSync(path.join(p.folder, 'queue.json'), 'utf8')).toBe(before);

    const j = JSON.parse(p.run('cloud', 'check', '--json').out);
    expect(j.tasks.find((t: { id: string }) => t.id === 'C')).toMatchObject({ state: 'done', branch: 'queue/C' });
  }, 120_000);

  it('says so when there is nothing in the cloud, and when the remote cannot be read', () => {
    const p = project([o('A')]);
    expect(p.run('cloud', 'check').out).toMatch(/Nothing in the cloud/);
    p.run('cloud', 'start', 'A');
    p.g(['remote', 'set-url', 'origin', path.join(p.folder, 'gone.git')]);
    const r = p.run('cloud', 'check');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/could not read/i);
    expect(p.task('A').status).toBe('picked');
  }, 60_000);

  it('the pulse says when a track has finished, and does not read the remote every round', () => {
    const p = project([o('A')]);
    p.run('cloud', 'start', 'A');
    const first = p.run('orchestrator', 'pulse');
    expect(first.out).not.toMatch(/CLOUD/);
    p.cloudPush('queue/A', 'lib/A.ts', 'CLOUD-DONE A');
    // Inside the five minutes: no read of the remote, so no news yet.
    expect(p.run('orchestrator', 'pulse').out).not.toContain('cloud done A');
    fs.rmSync(path.join(p.folder, 'cloud-check.json'), { force: true });
    expect(p.run('orchestrator', 'pulse').out).toContain('cloud done A --branch queue/A');
  }, 120_000);

  it('a dead remote does not disturb the pulse', () => {
    const p = project([o('A')]);
    p.run('cloud', 'start', 'A');
    p.g(['remote', 'set-url', 'origin', path.join(p.folder, 'gone.git')]);
    expect(p.run('orchestrator', 'pulse').code).toBe(0);
  }, 60_000);
});

describe('from cloud done to recorded evidence', () => {
  it('cloud done points at receive and merge; receive runs the gates at home and records them', () => {
    const p = project([o('A')], { gates: { quick: ['node -e "process.exit(0)"'] } });
    expect(p.run('cloud', 'start', 'A').code).toBe(0);
    const sha = p.cloudPush('queue/A', 'lib/A.ts', 'CLOUD-DONE A');

    const done = p.run('cloud', 'done', 'A', '--branch', 'queue/A');
    expect(done.code).toBe(0);
    expect(done.out).not.toContain('merge-track');
    expect(done.out).toContain('receive A');
    expect(done.out).toContain('merge A');
    expect(done.out).toContain('git worktree add');
    expect(p.task('A').status).toBe('review');

    // The steps it printed: a worktree for the branch, then receive.
    const wt = path.join(tmp('queue-ct-wt-'), 'A');
    p.g(['worktree', 'add', '-q', wt, 'queue/A']);
    const r = p.run('receive', 'A');
    expect(`${r.out}${r.error}`).toMatch(/Gates GREEN/);
    const store = fs.readdirSync(p.folder).filter((f) => /evidence/i.test(f));
    expect(store.length).toBeGreaterThan(0);
    expect(fs.readFileSync(path.join(p.folder, store[0]), 'utf8')).toContain(sha);
    p.g(['worktree', 'remove', '--force', wt]);
  }, 180_000);

  it('a done marker on a branch without any change is refused', () => {
    const p = project([o('A')]);
    p.run('cloud', 'start', 'A');
    p.g(['checkout', '-q', '-b', 'cloud-work', 'origin/main']);
    p.g(['commit', '-q', '--allow-empty', '-m', 'CLOUD-DONE A']);
    p.g(['push', '-q', 'origin', 'cloud-work:refs/heads/queue/A']);
    p.g(['checkout', '-q', 'main']);
    const r = p.run('cloud', 'done', 'A');
    expect(r.code).toBe(1);
    expect(r.error).toMatch(/no changes/);
    expect(p.task('A').status).toBe('picked');
  }, 60_000);
});

describe('cloud send (the routine way)', () => {
  const TOKEN = 'sk-ant-oat01-TESTTOKEN';
  const routine = (url: string, more: object = {}) => ({ cloud: { start: 'routine', fireUrl: url, ...more } });
  const LOOP = { QUEUE_CLOUD_ALLOW_LOOPBACK: '1', RAVENSEAT_CLOUD_TOKEN: TOKEN };

  it('is off until the owner has turned it on, and refuses without a token or with a wrong URL', async () => {
    const p = project([o('A')]);
    const off = p.run('cloud', 'send', 'A');
    expect(off.code).toBe(1);
    expect(off.error).toMatch(/cloud\.start/);
    expect(p.task('A').status).toBe('waiting');

    const end = await fakeEndpoint(200, {});
    const q = project([o('A')], routine(end.url));
    const noToken = await q.runAsync(['cloud', 'send', 'A'], { QUEUE_CLOUD_ALLOW_LOOPBACK: '1' });
    expect(noToken.code).toBe(1);
    expect(noToken.error).toMatch(/RAVENSEAT_CLOUD_TOKEN/);
    // Without the test switch a loopback URL is not the documented endpoint: the token stays home.
    const badUrl = await q.runAsync(['cloud', 'send', 'A'], { RAVENSEAT_CLOUD_TOKEN: TOKEN });
    expect(badUrl.code).toBe(1);
    expect(badUrl.error).toMatch(/fireUrl/);
    expect(end.calls.length).toBe(0);
    await end.close();
  }, 60_000);

  it('fires once, records the session and starts the task', async () => {
    const end = await fakeEndpoint(200, {
      type: 'routine_fire',
      claude_code_session_id: 'session_1',
      claude_code_session_url: 'https://claude.ai/code/session_1',
    });
    const p = project([o('A')], routine(end.url));
    const r = await p.runAsync(['cloud', 'send', 'A'], LOOP);
    await end.close();
    expect(r.code).toBe(0);
    expect(end.calls.length).toBe(1);
    expect(end.calls[0].auth).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(end.calls[0].body).text).toContain('Mission for A.');
    expect(p.task('A')).toMatchObject({ status: 'picked', picked_by: 'cloud' });
    expect(p.task('A').cloud?.execution).toBe('https://claude.ai/code/session_1');
    expect(`${r.out}${r.error}`).not.toContain(TOKEN);
  }, 60_000);

  it('a refusal puts the task back; an unclear answer keeps it and does not fire again', async () => {
    const refused = await fakeEndpoint(429, { error: { message: 'slow down' } }, { 'retry-after': '90' });
    const p = project([o('A')], routine(refused.url));
    const r = await p.runAsync(['cloud', 'send', 'A'], LOOP);
    await refused.close();
    expect(r.code).toBe(1);
    expect(`${r.out}${r.error}`).toContain('90');
    expect(p.task('A').status).toBe('waiting');
    expect(refused.calls.length).toBe(1);

    const broken = await fakeEndpoint(500, 'oops');
    const q = project([o('A')], routine(broken.url));
    const u = await q.runAsync(['cloud', 'send', 'A'], LOOP);
    await broken.close();
    expect(u.code).toBe(1);
    expect(broken.calls.length).toBe(1);
    expect(q.task('A').status).toBe('picked');
    expect(`${u.out}${u.error}`).toMatch(/claude\.ai\/code/);
    expect(`${u.out}${u.error}`).toContain('cloud cancel A');
  }, 60_000);

  it('obeys the pause, the session limit, unpushed work and the size limit before anything is sent', async () => {
    const end = await fakeEndpoint(200, {});
    const paused = project([o('A')], routine(end.url));
    pause(paused.folder);
    expect((await paused.runAsync(['cloud', 'send', 'A'], LOOP)).code).toBe(12);

    const full = project([o('A'), o('B')], routine(end.url, { maxSessions: 1 }));
    full.run('cloud', 'start', 'A');
    const f = await full.runAsync(['cloud', 'send', 'B'], LOOP);
    expect(f.code).toBe(1);
    expect(f.error).toMatch(/at most 1/);
    expect(full.task('B').status).toBe('waiting');

    const big = project([o('A', { mission: 'x'.repeat(F.FIRE_TEXT_MAX + 10) })], routine(end.url));
    const b = await big.runAsync(['cloud', 'send', 'A'], LOOP);
    expect(b.code).toBe(1);
    expect(b.error).toMatch(/65536|65,536/);
    expect(big.task('A').status).toBe('waiting');

    const ahead = project([o('A')], routine(end.url));
    fs.writeFileSync(path.join(ahead.repo, 'other.txt'), 'x\n');
    ahead.g(['add', '--', 'other.txt']);
    ahead.g(['commit', '-q', '-m', 'not pushed']);
    const n = await ahead.runAsync(['cloud', 'send', 'A'], LOOP);
    expect(n.code).toBe(1);
    expect(n.error).toMatch(/not pushed/);

    await end.close();
    expect(end.calls.length).toBe(0);
  }, 120_000);
});

describe('turning cloud on, and the checklist', () => {
  it('cloud on writes features.cloud and keeps the rest; setup works while it is off', () => {
    const p = project([o('A')], { features: { cloud: false }, maxConcurrent: 2 });
    expect(p.run('cloud').out).toMatch(/Cloud is off/);
    const s = p.run('cloud', 'setup');
    expect(s.code).toBe(0);
    expect(s.out).toMatch(/github\.com\/apps\/claude/);
    expect(s.out).not.toMatch(/credit/i);
    expect(p.run('cloud', 'on').code).toBe(0);
    const c = JSON.parse(fs.readFileSync(p.configFile, 'utf8'));
    expect(c.features.cloud).toBe(true);
    expect(c.maxConcurrent).toBe(2);
    expect(p.run('cloud').out).toMatch(/Cloud sessions/);
    expect(p.run('cloud', 'off').code).toBe(0);
    expect(JSON.parse(fs.readFileSync(p.configFile, 'utf8')).features.cloud).toBe(false);
  }, 60_000);

  it('doctor shows the rows while cloud is on, none while it is off, and knows the section', () => {
    const p = project([o('A')], { cloud: { maxSessions: 2, oops: 1 } });
    const j = JSON.parse(p.run('doctor', '--json', '--all').out) as { checks: { name: string; status: string; message: string }[] };
    const cloudRows = j.checks.filter((c) => c.name.startsWith('cloud'));
    expect(cloudRows.length).toBeGreaterThan(0);
    expect(cloudRows.some((c) => c.status === 'WARN' && /upload/.test(c.message))).toBe(true);
    expect(j.checks.some((c) => /cloud\.oops/.test(c.message))).toBe(true);

    const off = project([o('A')], { features: { cloud: false } });
    const k = JSON.parse(off.run('doctor', '--json', '--all').out) as { checks: { name: string }[] };
    expect(k.checks.filter((c) => c.name.startsWith('cloud'))).toEqual([]);
  }, 120_000);
});
