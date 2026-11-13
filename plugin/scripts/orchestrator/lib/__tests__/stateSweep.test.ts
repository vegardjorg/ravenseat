// =============================================================
// stateSweep.test.ts: the per-agent state folders of the track hooks lose entries older than 7 days, at most once a day.
//
// Why: hook-track-context.mjs, hook-read-guard.mjs, hook-track-end.mjs and hook-write-guard.mjs each keep one small JSON
// file per agent in the OS temp folder, and nothing removed them. The sweep must stay inside its own folder, take only the
// files the hooks write, never follow a link, never throw, and cost one stat on most calls.
// =============================================================
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const S = require('../stateSweep.js');

const DAY = 86_400_000;
let root: string;
let dir: string;

/** A file with its mtime `ageDays` before `now`. */
function file(p: string, ageDays: number, now: number, body = '{}') {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  const t = new Date(now - ageDays * DAY);
  fs.utimesSync(p, t, t);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ravenseat-sweep-test-'));
  dir = path.join(root, 'queue-read-hint');
  fs.mkdirSync(dir);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('sweepState', () => {
  it('removes state files older than 7 days and keeps newer ones', () => {
    const now = Date.now();
    file(path.join(dir, 'old-agent.json'), 8, now);
    file(path.join(dir, 'new-agent.json'), 1, now);
    const r = S.sweepState(dir, { now });
    expect(r.swept).toBe(true);
    expect(r.removed).toBe(1);
    expect(fs.existsSync(path.join(dir, 'old-agent.json'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'new-agent.json'))).toBe(true);
  });

  it('leaves other folders and entries the hooks do not write alone', () => {
    const now = Date.now();
    const other = path.join(root, 'someone-else');
    file(path.join(other, 'old.json'), 30, now);
    file(path.join(dir, 'notes.txt'), 30, now);
    fs.mkdirSync(path.join(dir, 'sub.json'));
    file(path.join(dir, 'sub.json', 'inner.json'), 30, now);
    S.sweepState(dir, { now });
    expect(fs.existsSync(path.join(other, 'old.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'notes.txt'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'sub.json', 'inner.json'))).toBe(true);
  });

  it('never follows a link: neither the link nor what it points at is removed', () => {
    const now = Date.now();
    const outside = path.join(root, 'outside');
    file(path.join(outside, 'precious.json'), 30, now, 'keep');
    // A junction needs no privilege on Windows; elsewhere it is a plain directory symlink.
    fs.symlinkSync(outside, path.join(dir, 'link.json'), 'junction');
    let fileLink = false;
    try {
      fs.symlinkSync(path.join(outside, 'precious.json'), path.join(dir, 'filelink.json'), 'file');
      fileLink = true;
    } catch {
      // creating a file symlink can need a privilege on Windows; the junction case still runs
    }
    S.sweepState(dir, { now: now + 30 * DAY });
    expect(fs.lstatSync(path.join(dir, 'link.json')).isSymbolicLink()).toBe(true);
    if (fileLink) expect(fs.lstatSync(path.join(dir, 'filelink.json')).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(outside, 'precious.json'), 'utf8')).toBe('keep');
  });

  it('a state folder that is itself a link is not swept', () => {
    const now = Date.now();
    const real = path.join(root, 'real');
    file(path.join(real, 'old.json'), 30, now);
    const linked = path.join(root, 'queue-write-warn');
    fs.symlinkSync(real, linked, 'junction');
    expect(S.sweepState(linked, { now }).swept).toBe(false);
    expect(fs.existsSync(path.join(real, 'old.json'))).toBe(true);
  });

  it('sweeps at most once a day per folder (the marker file)', () => {
    const now = Date.now();
    expect(S.sweepState(dir, { now }).swept).toBe(true);
    file(path.join(dir, 'old-agent.json'), 8, now);
    // Within the day: one stat of the marker, nothing removed.
    expect(S.sweepState(dir, { now: now + DAY / 2 }).swept).toBe(false);
    expect(fs.existsSync(path.join(dir, 'old-agent.json'))).toBe(true);
    // A day later it sweeps again; the marker itself is never removed.
    const r = S.sweepState(dir, { now: now + DAY + 1000 });
    expect(r.swept).toBe(true);
    expect(fs.existsSync(path.join(dir, 'old-agent.json'))).toBe(false);
    expect(fs.existsSync(path.join(dir, S.MARKER))).toBe(true);
  });

  it('never throws: a missing folder or a bad argument is a no-op', () => {
    expect(S.sweepState(path.join(root, 'missing')).swept).toBe(false);
    expect(S.sweepState(undefined).swept).toBe(false);
    expect(fs.existsSync(path.join(root, 'missing'))).toBe(false);
  });
});

describe('the four hooks sweep their own state folder', () => {
  const ORCH = path.resolve(__dirname, '..', '..');
  it.each([
    ['hook-track-context.mjs', 'sweepState(STATE)'],
    ['hook-read-guard.mjs', 'sweepState(HINT_STATE)'],
    ['hook-track-end.mjs', 'sweepState(STATE)'],
    ['hook-write-guard.mjs', 'sweepState(dir)'],
  ])('%s', (f, call) => {
    const s = fs.readFileSync(path.join(ORCH, f), 'utf8');
    expect(s).toContain("require('./lib/stateSweep.js')");
    expect(s).toContain(call);
  });
});
