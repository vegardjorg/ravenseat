// =============================================================
// demoMode.test.ts: demo mode on the board (owner decision 22.11): the offer rule, the server's allow-list, the path
// confinement, building and resetting the demo folder, and the environment demo writes run with.
//
// Safety is the hard requirement: the demo lives in its own folder, every request that would start work, run git,
// gates or agents, change settings, call the network or cost tokens is refused while demo mode is on, and no demo write
// can land outside the demo folder. These tests use temporary folders only; the snapshot is the tracked one.
// =============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const D = require('../demoMode.js') as any;
const O = require('../demoOffer.js') as any;
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

let tmp = '';
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ravenseat-demo-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('the offer (lib/demoOffer.js offerShown)', () => {
  const base = { setting: true, dismissed: false, taskCount: 0, archivedCount: 0, notNow: false };
  it('shows on a queue that has never had a task', () => {
    expect(O.offerShown(base)).toBe(true);
  });
  it('the first real task ends it, also when it is cancelled or archived later', () => {
    expect(O.offerShown({ ...base, taskCount: 1 })).toBe(false);
    expect(O.offerShown({ ...base, archivedCount: 3 })).toBe(false);
  });
  it('"Not now" hides it for this visit only; the next visit (notNow false) shows it again', () => {
    expect(O.offerShown({ ...base, notNow: true })).toBe(false);
    expect(O.offerShown({ ...base, notNow: false })).toBe(true);
  });
  it('"Don\'t show again" and board.demoOffer false hide it for good', () => {
    expect(O.offerShown({ ...base, dismissed: true })).toBe(false);
    expect(O.offerShown({ ...base, setting: false })).toBe(false);
  });
  it('the dismissal is stored per project in the data folder (demo-offer.json) and read back', () => {
    expect(D.readOffer(tmp)).toEqual({ dismissed: false });
    expect(D.writeDismissed(tmp, { now: Date.parse('2026-11-22T10:00:00Z') }).ok).toBe(true);
    expect(D.readOffer(tmp)).toEqual({ dismissed: true });
    expect(JSON.parse(fs.readFileSync(path.join(tmp, 'demo-offer.json'), 'utf8')).at).toBe('2026-11-22T10:00:00.000Z');
  });
  it('a broken demo-offer.json counts as not dismissed', () => {
    fs.writeFileSync(path.join(tmp, 'demo-offer.json'), '{oops');
    expect(D.readOffer(tmp)).toEqual({ dismissed: false });
  });
});

describe('the allow-list (lib/demoMode.js refusal)', () => {
  const ok = (method: string, route: string, body: object = {}) => expect(D.refusal(method, route, body), `${method} ${route} ${JSON.stringify(body)}`).toBeNull();
  const no = (method: string, route: string, body: object = {}) => {
    const r = D.refusal(method, route, body);
    expect(r, `${method} ${route} ${JSON.stringify(body)} should be refused`).not.toBeNull();
    expect(r.status).toBe(409);
    expect(r.answer.ok).toBe(false);
    expect(r.answer.demo).toBe(true);
    expect(r.answer.message).toMatch(/^Not in demo mode/);
    return r.answer;
  };

  it('lets the safe actions through: answer, approve, QA, edit, move, focus, the views', () => {
    for (const type of ['resolve', 'approve', 'qa-ok', 'qa-deviation', 'pause', 'continue', 'flag-stuck', 'batch-in', 'batch-out', 'batch-pack'])
      ok('POST', '/api/action', { type, id: 'AUTH-7' });
    ok('POST', '/api/action', { type: 'approve', ids: ['AUTH-7', 'SYNC-6'] });
    for (const route of ['/api/move', '/api/lane', '/api/bulk', '/api/undo', '/api/task-edit', '/api/focus', '/api/area', '/api/seen', '/api/plan-prioritize', '/api/plan-bulk', '/api/plan-undo'])
      ok('POST', route);
    for (const route of ['/api/state', '/api/since', '/api/schedule', '/api/statistics', '/api/plans', '/api/plan-search', '/api/doc', '/api/settings', '/api/task', '/api/archive', '/api/follow'])
      ok('GET', route);
  });

  it('refuses starting work and the tracks: pick, release, requeue, a track answer, the cloud', () => {
    for (const type of ['pick', 'release', 'requeue', 'track-answer', 'cloud-start', 'cloud-done', 'cloud-cancel'])
      expect(no('POST', '/api/action', { type, id: 'UI-6' }).refused).toBe('start');
    expect(no('POST', '/api/action', { type: 'cloud-start', ids: ['UI-6'] }).refused).toBe('start');
  });

  it('refuses every settings write (settings stay view only)', () => {
    for (const route of ['/api/limit', '/api/setting', '/api/guidance', '/api/helper', '/api/helper-add', '/api/proposals', '/api/proposals-undo', '/api/update-dismiss'])
      expect(no('POST', route).refused).toBe('settings');
    for (const type of ['board-switch', 'cloud-switch', 'cloud-setting'])
      expect(no('POST', '/api/action', { type }).refused).toBe('settings');
  });

  it('refuses gates and checks, which run commands in the repo', () => {
    expect(no('POST', '/api/checks', { action: 'build-gate' }).refused).toBe('gates');
    expect(no('GET', '/api/checks').refused).toBe('gates');
    expect(no('GET', '/api/plan-check').refused).toBe('gates');
  });

  it('refuses the cloud package and bundles, and writes into the project files', () => {
    expect(no('GET', '/api/cloudPackage').refused).toBe('start');
    expect(no('GET', '/api/cloud-bundles').refused).toBe('start');
    for (const route of ['/api/plan-new', '/api/plan-source', '/api/lawyerPackage', '/api/plan-capture', '/api/plan-proposal'])
      expect(no('POST', route).refused).toBe('project');
    // "Keep as design choice" writes a draft into the project catalog.
    expect(no('POST', '/api/action', { type: 'resolve', sp: 'Q-TRIAL', keep: true }).refused).toBe('project');
  });

  it('refuses by default: an unknown route, an unknown action type, another method', () => {
    expect(no('POST', '/api/something-new').refused).toBe('unknown');
    expect(no('POST', '/api/action', { type: 'merge' }).refused).toBe('unknown');
    expect(no('POST', '/api/action', {}).refused).toBe('unknown');
    expect(no('GET', '/api/whatever').refused).toBe('unknown');
    expect(no('DELETE', '/api/state').refused).toBe('unknown');
  });

  it('the message says what is refused and how to do it for real', () => {
    const a = no('POST', '/api/action', { type: 'pick', id: 'UI-6' });
    expect(a.message).toContain('Back to my board');
  });
});

describe('path confinement (lib/demoMode.js confined, linksIn)', () => {
  it('a path inside the root is fine; .. and an absolute path elsewhere are refused', () => {
    const root = path.join(tmp, 'demo');
    fs.mkdirSync(root);
    expect(D.confined(root, path.join(root, 'data', 'queue.json')).ok).toBe(true);
    expect(D.confined(root, path.join(root, '..', 'queue.json')).ok).toBe(false);
    expect(D.confined(root, path.join(tmp, 'queue.json')).ok).toBe(false);
    expect(D.confined(root, root).ok).toBe(false); // the root itself is not a file inside it
  });

  it('a junction or symlink on the way out of the root is refused, and found by linksIn', () => {
    const root = path.join(tmp, 'demo');
    const outside = path.join(tmp, 'real');
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(root, 'data', 'link'), 'junction');
    expect(D.confined(root, path.join(root, 'data', 'link', 'queue.json')).ok).toBe(false);
    expect(D.linksIn(root)).toEqual([path.join('data', 'link')]);
  });

  it('a demo root that is itself a link is refused (it could point at the real data folder)', () => {
    const data = path.join(tmp, 'q');
    fs.mkdirSync(data);
    fs.symlinkSync(data, path.join(data, 'demo'), 'junction');
    const r = D.checkRoot(data);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/link/);
  });
});

describe('the demo folder (lib/demoMode.js build, reset)', () => {
  const NOW = Date.parse('2026-11-22T12:00:00Z');
  const data = () => {
    const f = path.join(tmp, 'q');
    fs.mkdirSync(f, { recursive: true });
    fs.writeFileSync(path.join(f, 'queue.json'), '{"tasks":[]}\n');
    return f;
  };

  it('build writes the snapshot under <dataFolder>/demo with every date around now, and nothing outside it', () => {
    const f = data();
    const before = fs.readdirSync(f).sort();
    const r = D.build(f, { now: NOW, mode: 'lite' });
    expect(r.ok, r.message).toBe(true);
    const p = D.paths(f);
    expect(p.root).toBe(path.join(f, 'demo'));
    expect(fs.readdirSync(f).sort()).toEqual([...before, 'demo'].sort());
    const q = JSON.parse(fs.readFileSync(p.queue, 'utf8'));
    expect(q.tasks.length).toBeGreaterThan(10);
    const text = fs.readFileSync(p.queue, 'utf8') + fs.readFileSync(p.timeLog, 'utf8') + fs.readFileSync(p.plans, 'utf8');
    expect(text).not.toContain('@rel:');
    const dates = [...text.matchAll(/"(\d{4}-\d\d-\d\dT[\d:.]+Z)"/g)].map((m) => Date.parse(m[1]));
    expect(dates.length).toBeGreaterThan(50);
    for (const d of dates) expect(Math.abs(d - NOW)).toBeLessThan(30 * 86_400_000);
    // The demo's own settings: the real mode, its own data folder and docs.
    const cfg = JSON.parse(fs.readFileSync(p.config, 'utf8'));
    expect(cfg.mode).toBe('lite');
    expect(cfg.projectName).toBe('pebble');
    expect(fs.existsSync(path.join(p.root, 'docs', 'plans', 'auth.md'))).toBe(true);
    // The real queue is untouched.
    expect(fs.readFileSync(path.join(f, 'queue.json'), 'utf8')).toBe('{"tasks":[]}\n');
  });

  it('a snapshot entry that points outside the demo folder is refused and nothing is written there', () => {
    const f = data();
    const evil = { ...D.snapshot(), docs: { '../escape.md': 'x' } };
    const r = D.build(f, { now: NOW, snapshot: evil });
    expect(r.ok).toBe(false);
    expect(fs.existsSync(path.join(f, 'escape.md'))).toBe(false);
  });

  it('reset re-creates the folder from the snapshot after demo changes', () => {
    const f = data();
    D.build(f, { now: NOW });
    const p = D.paths(f);
    fs.writeFileSync(p.queue, '{"tasks":[]}');
    fs.writeFileSync(path.join(p.data, 'extra.json'), '{}');
    const r = D.reset(f, { now: NOW });
    expect(r.ok, r.message).toBe(true);
    expect(JSON.parse(fs.readFileSync(p.queue, 'utf8')).tasks.length).toBeGreaterThan(10);
    expect(fs.existsSync(path.join(p.data, 'extra.json'))).toBe(false);
  });

  it('reset refuses when the demo folder holds a link, and the link target is left as it was', () => {
    const f = data();
    D.build(f, { now: NOW });
    const real = path.join(tmp, 'precious');
    fs.mkdirSync(real);
    fs.writeFileSync(path.join(real, 'keep.txt'), 'keep');
    fs.symlinkSync(real, path.join(D.paths(f).data, 'link'), 'junction');
    const r = D.reset(f, { now: NOW });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/link/);
    expect(fs.readFileSync(path.join(real, 'keep.txt'), 'utf8')).toBe('keep');
  });
});

describe('the environment of a demo write (lib/demoMode.js childEnv)', () => {
  it('points every queue path into the demo folder, locks git out and drops the tokens', () => {
    const f = path.join(tmp, 'q');
    const p = D.paths(f);
    const env = D.childEnv({ PATH: 'x', QUEUE_FOLDER: f, GH_TOKEN: 'secret', GITHUB_TOKEN: 'secret', ANTHROPIC_API_KEY: 'secret' }, p);
    for (const k of ['QUEUE_ROOT', 'QUEUE_FOLDER', 'QUEUE_FILE', 'QUEUE_CONFIG', 'QUEUE_TIME_LOG', 'QUEUE_GIT', 'QUEUE_PLAN_SOURCE_ROOT', 'QUEUE_SCRATCHPAD', 'QUEUE_TRANSCRIPTS', 'QUEUE_PLAN_BACKUP', 'QUEUE_INDEX_FILE', 'QUEUE_DOC_ROOT', 'GIT_DIR'])
      expect(env[k] === p.root || D.confined(p.root, env[k]).ok, k).toBe(true);
    expect(env.GIT_CEILING_DIRECTORIES).toBe(path.dirname(p.root));
    expect(fs.existsSync(env.GIT_DIR)).toBe(false);
    expect(env.RAVENSEAT_DEMO).toBe('1');
    expect(env.DISABLE_UPDATES).toBe('1');
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.PATH).toBe('x');
  });
});

describe('the tracked snapshot (demo-data/pebble.json)', () => {
  it('holds nothing private: no drive or home paths, no email outside example.com, a made-up picker', () => {
    const text = fs.readFileSync(path.join(__dirname, '..', '..', 'demo-data', 'pebble.json'), 'utf8');
    expect(text).not.toMatch(/(?<![A-Za-z])[A-Za-z]:(?:\\|\/(?!\/))/);
    expect(text).not.toMatch(/\/(?:Users|home)\//);
    expect(text).not.toMatch(/[A-Za-z0-9._%+-]+@(?!example\.com)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    expect(text).not.toMatch(/"\d{4}-\d\d-\d\dT\d\d:\d\d/); // every time is relative
    expect([...text.matchAll(/"picked_by": "([^"]+)"/g)].map((m) => m[1])).toEqual(['Sam']);
  });
});
