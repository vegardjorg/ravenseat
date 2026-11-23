// =============================================================
// queueUpdateCli.test.ts: the update notice for CLI users (lib/queueUpdate.js, roadmap 0u3).
// `ravenseat show` and `ravenseat doctor` print one line when the cache says a newer version is out. The CLI only reads
// the cache; an old cache starts a detached refresh (spawn is a mock here). Once a day per version in show, silent in
// --json, agent, CI and hook context, hidden by `ravenseat update dismiss` (the same storage the board's X uses), and off
// with updates.check false or its old name board.updateCheck false. No test goes on the network.
// =============================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import * as fs from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const U = require('../queueUpdate.js');

const HOUR = 3_600_000;
const NOW = 1_000 * HOUR;

let dir: string;
let cacheFile: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'queue-update-cli-'));
  cacheFile = join(dir, 'update-check.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const writeCache = (o: object) => writeFileSync(cacheFile, JSON.stringify(o));
const readCacheRaw = () => JSON.parse(readFileSync(cacheFile, 'utf8'));
const notice = (o: object = {}) =>
  U.cliNotice({ surface: 'show', config: {}, env: {}, fs, cacheFile, installed: '0.3.0', mode: 'plugin', now: NOW, ...o });

describe('updates.check and the old name board.updateCheck', () => {
  it('on by default; updates.check false turns it off', () => {
    expect(U.disabledReason({}, {})).toBeNull();
    expect(U.disabledReason({ updates: { check: true } }, {})).toBeNull();
    expect(U.disabledReason({ updates: { check: false } }, {})).toMatch(/updates\.check/);
  });
  it('board.updateCheck false still turns it off (the old alias)', () => {
    expect(U.disabledReason({ board: { updateCheck: false } }, {})).toMatch(/board\.updateCheck/);
    expect(U.disabledReason({ updates: { check: true }, board: { updateCheck: false } }, {})).not.toBeNull();
  });
  it('the CLI line is silent when either is off, and with DISABLE_UPDATES', () => {
    writeCache({ checkedAt: NOW, latest: '0.4.0' });
    expect(notice({ config: { updates: { check: false } } }).line).toBeNull();
    expect(notice({ config: { board: { updateCheck: false } } }).line).toBeNull();
    expect(notice({ env: { DISABLE_UPDATES: '1' } }).line).toBeNull();
    expect(notice({ env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: 'true' } }).refresh).toBe(false);
  });
  it('the registry row: Board, Advanced, on in lite and full alike; the old name is internal, not a row', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const R = require('../settingsRegistry.js');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const C = require('../queueConfig.js');
    const r = R.rowFor('updates.check');
    expect(r).toMatchObject({ category: 'board', level: 'advanced', type: 'onoff', defaultByMode: null });
    expect(r.modes).toEqual(['lite', 'full']);
    expect(C.STANDARD.updates.check).toBe(true);
    expect(R.rowFor('board.updateCheck')).toBeNull();
    expect(R.INTERNAL).toContain('board.updateCheck');
  });
});

describe('cliNotice: the cache only, never the network', () => {
  it('a newer cached version gives the one line with the update command', () => {
    writeCache({ checkedAt: NOW - HOUR, latest: '0.4.0' });
    const n = notice();
    expect(n.line).toBe(
      'ravenseat 0.4.0 is out (you have 0.3.0): claude plugin update ravenseat@ravenseat, then ravenseat setup --settings',
    );
    expect(n.version).toBe('0.4.0');
    expect(n.refresh).toBe(false);
  });
  it('is synchronous: it returns the answer, not a promise', () => {
    writeCache({ checkedAt: NOW, latest: '0.4.0' });
    expect(notice()).not.toBeInstanceOf(Promise);
  });
  it('the same or an older cached version gives no line', () => {
    writeCache({ checkedAt: NOW, latest: '0.3.0' });
    expect(notice().line).toBeNull();
    writeCache({ checkedAt: NOW, latest: '0.2.9' });
    expect(notice().line).toBeNull();
  });
  it('no cache or a broken one: no line, and a refresh is asked for', () => {
    expect(notice()).toMatchObject({ line: null, refresh: true });
    writeFileSync(cacheFile, '{ broken');
    expect(notice()).toMatchObject({ line: null, refresh: true });
  });
  it('a cache older than 24 h still gives the line and asks for a refresh', () => {
    writeCache({ checkedAt: NOW - 25 * HOUR, latest: '0.4.0' });
    expect(notice()).toMatchObject({ version: '0.4.0', refresh: true });
    expect(notice().line).toContain('0.4.0 is out');
  });
  it('a refresh started within the hour is not started again', () => {
    writeCache({ checkedAt: NOW - 25 * HOUR, latest: '0.4.0', refreshStartedAt: NOW - 10 * 60_000 });
    expect(notice().refresh).toBe(false);
    writeCache({ checkedAt: NOW - 25 * HOUR, latest: '0.4.0', refreshStartedAt: NOW - 2 * HOUR });
    expect(notice().refresh).toBe(true);
  });
  it('a vendored install gets git pull and the installer', () => {
    writeCache({ checkedAt: NOW, latest: '0.4.0' });
    expect(notice({ mode: 'vendored' }).line).toBe(
      'ravenseat 0.4.0 is out (you have 0.3.0): git pull in your Ravenseat folder, then node scripts/install.mjs <your project folder> --overwrite',
    );
  });
  it('an unknown installed version gives no line', () => {
    writeCache({ checkedAt: NOW, latest: '0.4.0' });
    expect(notice({ installed: null }).line).toBeNull();
  });
});

describe('once per day per version in show, always in doctor', () => {
  it('show: hidden for 24 h after it was shown, back for a newer version or a day later', () => {
    writeCache({ checkedAt: NOW, latest: '0.4.0' });
    expect(notice().line).not.toBeNull();
    U.markShown(fs, cacheFile, '0.4.0', NOW);
    expect(readCacheRaw()).toMatchObject({ latest: '0.4.0', shown: { version: '0.4.0', at: NOW } });
    expect(notice({ now: NOW + 23 * HOUR }).line).toBeNull();
    expect(notice({ now: NOW + 25 * HOUR }).line).not.toBeNull();
    // A newer version is news at once.
    writeCache({ ...readCacheRaw(), latest: '0.5.0' });
    expect(notice({ now: NOW + HOUR }).line).toContain('0.5.0');
  });
  it('doctor: shown every time', () => {
    writeCache({ checkedAt: NOW, latest: '0.4.0', shown: { version: '0.4.0', at: NOW } });
    expect(notice({ surface: 'doctor' }).line).toContain('0.4.0 is out');
  });
});

describe('quiet contexts', () => {
  it('json, agent (worktree or role), CI and hooks are quiet; a plain terminal is not', () => {
    expect(U.quietReason({ argv: ['show'], env: {}, inWorktree: false })).toBeNull();
    expect(U.quietReason({ argv: ['doctor', '--json'], env: {}, inWorktree: false })).toBe('json');
    expect(U.quietReason({ argv: ['show'], env: {}, inWorktree: true })).toBe('agent');
    expect(U.quietReason({ argv: ['show'], env: { QUEUE_AGENT_ROLE: 'track' }, inWorktree: false })).toBe('agent');
    expect(U.quietReason({ argv: ['show'], env: { QUEUE_ROLE: 'agent' }, inWorktree: false })).toBe('agent');
    expect(U.quietReason({ argv: ['show'], env: { CI: 'true' }, inWorktree: false })).toBe('ci');
    expect(U.quietReason({ argv: ['show'], env: { CI: 'false' }, inWorktree: false })).toBeNull();
    expect(U.quietReason({ argv: ['show'], env: { QUEUE_HOOK: '1' }, inWorktree: false })).toBe('hook');
  });
  it('a quiet context gives no line and no refresh', () => {
    writeCache({ checkedAt: NOW - 25 * HOUR, latest: '0.4.0' });
    expect(notice({ quiet: 'agent' })).toMatchObject({ line: null, refresh: false });
  });
});

describe('dismiss (shared with the board)', () => {
  it('hides that version in show and doctor until a newer one is out', () => {
    writeCache({ checkedAt: NOW, latest: '0.4.0' });
    expect(U.dismiss(fs, cacheFile, '0.4.0')).toBe(true);
    expect(U.dismissedVersion(fs, cacheFile)).toBe('0.4.0');
    expect(readCacheRaw()).toMatchObject({ checkedAt: NOW, latest: '0.4.0', dismissed: '0.4.0' });
    expect(notice().line).toBeNull();
    expect(notice({ surface: 'doctor' }).line).toBeNull();
    writeCache({ ...readCacheRaw(), latest: '0.5.0' });
    expect(notice().line).toContain('0.5.0');
  });
  it('refuses a version that is not semver', () => {
    expect(U.dismiss(fs, cacheFile, 'soon')).toBe(false);
    expect(existsSync(cacheFile)).toBe(false);
  });
  it('the board hides the banner for a version dismissed on the server (notice carries dismissed)', () => {
    const n = U.notice({ mode: 'plugin', installed: '0.3.0', latest: '0.4.0', setupVersion: '0.3.0', dismissed: '0.4.0' });
    expect(U.visible(n, null)).toEqual({ newVersion: false, setup: false });
    // The newer of the browser's and the server's dismissal counts.
    const newer = U.notice({ mode: 'plugin', installed: '0.3.0', latest: '0.5.0', setupVersion: '0.3.0', dismissed: '0.4.0' });
    expect(U.visible(newer, null).newVersion).toBe(true);
    expect(U.visible(newer, '0.5.0').newVersion).toBe(false);
  });
  it('the cache refresh keeps the dismissal and the shown stamp', async () => {
    writeCache({ checkedAt: NOW - 25 * HOUR, latest: '0.4.0', dismissed: '0.4.0', shown: { version: '0.4.0', at: NOW - 25 * HOUR } });
    const fetch = vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ version: '0.5.0' }) }));
    expect(await U.latestVersion({ config: {}, env: {}, cacheFile, fs, fetch, now: NOW })).toMatchObject({ latest: '0.5.0' });
    expect(readCacheRaw()).toMatchObject({ checkedAt: NOW, latest: '0.5.0', dismissed: '0.4.0' });
    expect(readCacheRaw().shown).toEqual({ version: '0.4.0', at: NOW - 25 * HOUR });
  });
});

describe('startRefresh: a detached background process, never waited on', () => {
  it('spawns `update refresh` detached with no stdio, unrefs it and records the start', () => {
    const child = { unref: vi.fn(), on: vi.fn() };
    const spawn = vi.fn(() => child);
    expect(U.startRefresh({ spawn, execPath: 'node', script: '/x/queue.mjs', fs, cacheFile, now: NOW })).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawn.mock.calls[0] as unknown as [string, string[], Record<string, unknown>];
    expect(cmd).toBe('node');
    expect(args).toEqual(['/x/queue.mjs', 'update', 'refresh']);
    expect(opts).toMatchObject({ detached: true, stdio: 'ignore', windowsHide: true });
    expect(child.unref).toHaveBeenCalled();
    expect(readCacheRaw().refreshStartedAt).toBe(NOW);
  });
  it('a spawn that throws is swallowed (false)', () => {
    const spawn = vi.fn(() => {
      throw new Error('EPERM');
    });
    expect(U.startRefresh({ spawn, execPath: 'node', script: 'q.mjs', fs, cacheFile, now: NOW })).toBe(false);
  });
});

describe('networkAllowed and the manifest URL (tests never go on the net)', () => {
  it('outside a test runner the network is allowed and the URL is the published manifest', () => {
    expect(U.networkAllowed({})).toBe(true);
    expect(U.manifestUrl({})).toBe(U.MANIFEST_URL);
  });
  it('under a test runner only a loopback override is allowed', () => {
    expect(U.networkAllowed({ VITEST: 'true' })).toBe(false);
    expect(U.networkAllowed({ VITEST: 'true', QUEUE_UPDATE_URL: 'http://127.0.0.1:5000/p.json' })).toBe(true);
    expect(U.networkAllowed({ VITEST: 'true', QUEUE_UPDATE_URL: 'https://example.com/p.json' })).toBe(false);
  });
  it('the override is taken only for a loopback address', () => {
    expect(U.manifestUrl({ QUEUE_UPDATE_URL: 'http://127.0.0.1:5000/p.json' })).toBe('http://127.0.0.1:5000/p.json');
    expect(U.manifestUrl({ QUEUE_UPDATE_URL: 'http://localhost:5000/p.json' })).toBe('http://localhost:5000/p.json');
    expect(U.manifestUrl({ QUEUE_UPDATE_URL: 'https://evil.example/p.json' })).toBe(U.MANIFEST_URL);
  });
});
