// =============================================================
// queueUsageLimit.test.ts: the pause when the subscription's usage limit is reached (lib/usageLimit.js).
//
// Locks: (1) what counts as a limit: only a transcript entry that says the quota rejected the call (the shape is copied
// from real entries), or a rate_limit stop with a status line window at 100 %. A plain 429 never pauses; (2) the hook
// (hook-usage-limit.mjs) writes the pause from the StopFailure input, and it can be turned off; (3) during the pause
// next, start, fill and resume refuse with exit 12 and start nothing, start --force and `limit usageLimit clear` lift
// it; (4) after the reset everything runs again, the pulse names the tracks that were running once, and a context
// round is not a fix round.
// Runs against a temporary queue (QUEUE_FOLDER, QUEUE_GIT). Never the main repo or the real queue.
// =============================================================
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const UL = require('../lib/usageLimit.js');
const L = require('../lib/queueLogic.js');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const QUEUE = path.join(ROOT, 'scripts', 'orchestrator', 'queue.mjs');
const HOOK = path.join(ROOT, 'scripts', 'orchestrator', 'hook-usage-limit.mjs');
const ID = ['-c', 'user.name=queue-test', '-c', 'user.email=queue-test@example.invalid'];

const NOW = Date.parse('2026-11-07T12:00:00.000Z');
const RESET = Math.floor(NOW / 1000) + 3 * 3600;

/** The limit entry as Claude Code writes it, reduced to the fields that matter. */
const limitEntry = (over: Record<string, unknown> = {}) => ({
  type: 'assistant',
  isApiErrorMessage: true,
  apiErrorStatus: 429,
  error: 'rate_limit',
  apiError: 'usage_limit_reached',
  quotaLimits: { status: 'rejected', resetsAt: RESET, rateLimitType: 'seven_day', overageStatus: 'rejected', isUsingOverage: false },
  apiErrorParams: { rate_limit_info: { status: 'rejected', resetsAt: RESET, rateLimitType: 'seven_day' } },
  message: { model: '<synthetic>', content: [{ type: 'text', text: "You've hit your weekly limit" }] },
  ...over,
});
/** A plain 429: the API was busy for a moment, no quota was rejected. */
const plain429 = { type: 'assistant', isApiErrorMessage: true, apiErrorStatus: 429, error: 'rate_limit', message: { content: [] } };
const tail = (...entries: unknown[]) => entries.map((e) => JSON.stringify(e)).join('\n') + '\n';

describe('what counts as a usage limit', () => {
  it('a rejected quota entry gives its reset and type', () => {
    expect(UL.decide({ error: 'rate_limit' }, { tail: tail(limitEntry()), now: NOW })).toMatchObject({
      until: new Date(RESET * 1000).toISOString(),
      type: 'seven_day',
      source: 'transcript',
    });
  });

  it('the older shape with only apiError counts, with a short default pause', () => {
    const r = UL.decide({ error: 'rate_limit' }, { tail: tail(limitEntry({ quotaLimits: undefined, apiErrorParams: undefined })), now: NOW });
    expect(r).toMatchObject({ source: 'default', type: null });
    expect(Date.parse(r.until) - NOW).toBe(UL.DEFAULT_PAUSE_MS);
  });

  it('a reset already in the past falls back to the default pause', () => {
    const past = Math.floor(NOW / 1000) - 60;
    const r = UL.decide({}, { tail: tail(limitEntry({ quotaLimits: { status: 'rejected', resetsAt: past }, apiErrorParams: undefined })), now: NOW });
    expect(Date.parse(r.until) - NOW).toBe(UL.DEFAULT_PAUSE_MS);
  });

  it('a plain 429 does not pause', () => {
    expect(UL.decide({ error: 'rate_limit' }, { tail: tail(plain429), now: NOW })).toBeNull();
  });

  it('a quota that only warns does not pause', () => {
    const warn = limitEntry({ apiError: undefined, apiErrorParams: undefined, quotaLimits: { status: 'allowed_warning', resetsAt: RESET } });
    expect(UL.decide({ error: 'rate_limit' }, { tail: tail(warn), now: NOW })).toBeNull();
  });

  it('an old limit followed by a normal answer does not pause', () => {
    const ok = { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } };
    expect(UL.decide({ error: 'rate_limit' }, { tail: tail(limitEntry(), ok), now: NOW })).toBeNull();
  });

  it('a broken last line and later user rows do not hide the entry', () => {
    const t = tail(limitEntry(), { type: 'user', message: { content: 'hello' } }) + '{"type":"assis';
    expect(UL.decide({ error: 'rate_limit' }, { tail: t, now: NOW })?.source).toBe('transcript');
  });

  it('with no entry yet, a rate_limit stop and a status line window at 100 % count', () => {
    const observed = {
      five_hour: { used_percentage: 100, resets_at: RESET },
      seven_day: { used_percentage: 40, resets_at: RESET + 86400 },
    };
    expect(UL.decide({ error: 'rate_limit' }, { tail: '', observed, now: NOW })).toMatchObject({
      type: 'five_hour',
      source: 'statusline',
      until: new Date(RESET * 1000).toISOString(),
    });
    // Another kind of stop never reads the status line, and neither does a window that has reset.
    expect(UL.decide({ error: 'overloaded' }, { tail: '', observed, now: NOW })).toBeNull();
    const reset = { five_hour: { used_percentage: 100, resets_at: Math.floor(NOW / 1000) - 1 } };
    expect(UL.decide({ error: 'rate_limit' }, { tail: '', observed: reset, now: NOW })).toBeNull();
  });

  it('merge keeps the later reset; an expired one is replaced', () => {
    const a = { until: new Date(NOW + 1000).toISOString(), at: new Date(NOW - 5000).toISOString(), type: 'five_hour', source: 'transcript' };
    const b = { until: new Date(NOW + 9000).toISOString(), at: new Date(NOW).toISOString(), type: 'seven_day', source: 'transcript' };
    expect(UL.merge(a, b, NOW)).toMatchObject({ until: b.until, type: 'seven_day', at: a.at });
    expect(UL.merge(b, a, NOW)).toMatchObject({ until: b.until, type: 'seven_day', at: b.at });
    const old = { ...a, until: new Date(NOW - 1).toISOString() };
    expect(UL.merge(old, b, NOW)).toEqual(b);
  });

  it('startGuard stops with exit 12 first of all, and --force goes past it', () => {
    const usageLimit = { until: new Date(NOW + 3600_000).toISOString(), at: new Date(NOW).toISOString(), type: 'seven_day', source: 'transcript' };
    const queue = { tasks: [], limits: {} };
    const g = L.startGuard(queue, {}, { now: NOW, usageLimit });
    expect(g).toMatchObject({ code: 12, stop: 'usageLimit' });
    expect(g.message).toMatch(/USAGE LIMIT/);
    expect(g.message).toContain('limit usageLimit clear');
    expect(L.startGuard(queue, {}, { now: NOW, usageLimit, force: true })).toBeNull();
    expect(L.startGuard(queue, {}, { now: NOW + 3600_001, usageLimit })).toBeNull();
  });
});

const temporary: string[] = [];
afterAll(() => {
  for (const m of temporary) {
    try { fs.rmSync(m, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch { /* left for the OS */ }
  }
});

/** A temporary project with one waiting task and one running on a branch. */
function project(config: Record<string, unknown> = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-usagelimit-'));
  temporary.push(folder);
  const repo = path.join(folder, 'repo');
  fs.mkdirSync(repo);
  const g = (...args: string[]) => execFileSync('git', ['-C', repo, ...ID, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  g('init', '-q', '-b', 'develop');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  g('add', '--', 'a.txt');
  g('commit', '-q', '-m', 'start');
  g('branch', 'queue/RUN');
  const base = { domain: 'dom', class: 'K', value: 5, content_min: 30, depends_on: [], waiting_on: [] };
  fs.writeFileSync(
    path.join(folder, 'queue.json'),
    JSON.stringify({
      created: '2026-01-01T00:00:00.000Z',
      limits: {},
      next_migr: 3600,
      resolved: [],
      tasks: [
        { ...base, id: 'WAIT', title: 'Waiting', status: 'waiting', mission: 'Do it.', owned_files: ['w.txt'] },
        { ...base, id: 'RUN', title: 'Running', status: 'running', mission: 'Run it.', owned_files: ['r.txt'], started: '2026-01-01T00:00:00.000Z', branch: 'queue/RUN' },
      ],
    }),
  );
  const configFile = path.join(folder, 'queue.config.json');
  fs.writeFileSync(configFile, JSON.stringify({ baseBranch: 'develop', ...config }));
  const env = {
    ...process.env,
    QUEUE_FOLDER: folder,
    QUEUE_CONFIG: configFile,
    QUEUE_ROOT: folder,
    QUEUE_GIT: repo,
    QUEUE_TIME_LOG: path.join(folder, 'times.jsonl'),
    QUEUE_TRANSCRIPTS: path.join(folder, 'transcripts'),
    QUEUE_LOAD: 'free=100,cpu=5',
    QUEUE_SCRATCHPAD: path.join(folder, 'pad'),
  } as NodeJS.ProcessEnv;
  delete env.QUEUE_SESSION;
  const run = (...args: string[]) => {
    const r = spawnSync(process.execPath, [QUEUE, ...args], { encoding: 'utf8', env, cwd: folder });
    return { code: r.status, out: r.stdout ?? '', error: r.stderr ?? '' };
  };
  const hook = (input: unknown) => spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), encoding: 'utf8', env, cwd: folder });
  const file = path.join(folder, 'usage-limit.json');
  const pause = (ms: number, at = Date.now() - 60_000) =>
    fs.writeFileSync(file, JSON.stringify({ until: new Date(Date.now() + ms).toISOString(), at: new Date(at).toISOString(), type: 'seven_day', source: 'transcript' }));
  const task = (id: string) => JSON.parse(fs.readFileSync(path.join(folder, 'queue.json'), 'utf8')).tasks.find((t: { id: string }) => t.id === id);
  return { folder, run, hook, file, pause, task };
}

describe('the hook', () => {
  it('writes the pause from a real limit entry, and nothing else from the transcript', () => {
    const p = project();
    const transcript = path.join(p.folder, 'session.jsonl');
    const future = Math.floor(Date.now() / 1000) + 3600;
    fs.writeFileSync(transcript, tail(limitEntry({ quotaLimits: { status: 'rejected', resetsAt: future, rateLimitType: 'five_hour' }, apiErrorParams: undefined })));
    const r = p.hook({ hook_event_name: 'StopFailure', error: 'rate_limit', transcript_path: transcript });
    expect(r.status).toBe(0);
    const saved = JSON.parse(fs.readFileSync(p.file, 'utf8'));
    expect(saved).toMatchObject({ until: new Date(future * 1000).toISOString(), type: 'five_hour', source: 'transcript' });
    expect(Object.keys(saved).sort()).toEqual(['at', 'source', 'type', 'until']);
  });

  it('a plain 429 and a missing transcript write nothing and still exit 0', () => {
    const p = project();
    const transcript = path.join(p.folder, 'session.jsonl');
    fs.writeFileSync(transcript, tail(plain429));
    expect(p.hook({ hook_event_name: 'StopFailure', error: 'rate_limit', transcript_path: transcript }).status).toBe(0);
    expect(p.hook({ hook_event_name: 'StopFailure', error: 'rate_limit', transcript_path: path.join(p.folder, 'none.jsonl') }).status).toBe(0);
    expect(fs.existsSync(p.file)).toBe(false);
  });

  it('usageLimit.pause false turns it off', () => {
    const p = project({ usageLimit: { pause: false } });
    const transcript = path.join(p.folder, 'session.jsonl');
    fs.writeFileSync(transcript, tail(limitEntry({ quotaLimits: { status: 'rejected', resetsAt: Math.floor(Date.now() / 1000) + 3600 }, apiErrorParams: undefined })));
    expect(p.hook({ hook_event_name: 'StopFailure', error: 'rate_limit', transcript_path: transcript }).status).toBe(0);
    expect(fs.existsSync(p.file)).toBe(false);
    // A file left from before the setting was changed does not stop anything either.
    p.pause(3600_000);
    expect(p.run('next').code).toBe(0);
  });
});

describe('during the pause', () => {
  it('next, start, fill and resume refuse with exit 12 and change nothing', () => {
    const p = project();
    p.pause(3600_000);
    const before = fs.readFileSync(path.join(p.folder, 'queue.json'), 'utf8');
    const next = p.run('next');
    expect(next.code).toBe(12);
    expect(next.error).toMatch(/USAGE LIMIT/);
    expect(p.run('start', 'WAIT').code).toBe(12);
    expect(p.run('fill').code).toBe(12);
    expect(p.run('fill', '--ids', 'WAIT').code).toBe(12);
    const fix = p.run('resume', 'RUN', '--reason', 'fix');
    expect(fix.code).toBe(12);
    expect(fix.error).toMatch(/USAGE LIMIT/);
    expect(p.task('WAIT').status).toBe('waiting');
    expect(p.task('RUN').resumed).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(path.join(p.folder, 'queue.json'), 'utf8')).tasks).toEqual(JSON.parse(before).tasks);
  });

  it('show says so; the pulse names the running tracks and keeps the pause', () => {
    const p = project();
    p.pause(3600_000);
    expect(p.run('show').out).toMatch(/USAGE LIMIT/);
    const pulse = p.run('orchestrator', 'pulse');
    expect(pulse.out).toMatch(/USAGE LIMIT/);
    expect(pulse.out).toMatch(/Running when it hit: RUN/);
    expect(fs.existsSync(p.file)).toBe(true);
  });

  it('start --force goes past it, one task on the owner\'s word', () => {
    const p = project();
    p.pause(3600_000);
    expect(p.run('start', 'WAIT', '--force').code).toBe(0);
    expect(p.task('WAIT').status).toBe('running');
  });

  it('limit usageLimit clear lifts it', () => {
    const p = project();
    p.pause(3600_000);
    const c = p.run('limit', 'usageLimit', 'clear');
    expect(c.code).toBe(0);
    expect(c.out).toMatch(/usage limit pause is lifted/i);
    expect(fs.existsSync(p.file)).toBe(false);
    expect(p.run('next').code).toBe(0);
  });
});

describe('after the reset', () => {
  it('everything runs again; the pulse says once which tracks were running; a context round is no fix round', () => {
    const p = project();
    p.pause(-1000);
    expect(p.run('next').code).toBe(0);
    const pulse = p.run('orchestrator', 'pulse');
    expect(pulse.out).toMatch(/usage limit has reset/i);
    expect(pulse.out).toContain('RUN');
    expect(pulse.out).toContain('resume <id> --reason context');
    expect(fs.existsSync(p.file)).toBe(false);
    expect(p.run('orchestrator', 'pulse').out).not.toMatch(/usage limit has reset/i);
    const r = p.run('resume', 'RUN', '--reason', 'context');
    expect(r.error).toBe('');
    expect(r.code).toBe(0);
    expect(p.task('RUN').resumed.at(-1).reason).toBe('context');
  });
});
