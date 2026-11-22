// =============================================================
// seenMark.test.ts: the server-side "last seen" mark in lib/seenMark.js (roadmap 3e, AW-3).
//
// Locks: no file reads as no mark (null), a broken file too; a write keeps `previous` (the mark before), so a reader can
// still show the window the owner just looked at; only board and cli are valid `by` values; the write is atomic (no
// .tmp left) and never throws to the caller.
// =============================================================
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const SM = require('../seenMark.js');

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seen-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('seen mark', () => {
  it('reads null when there is no file or it is broken', () => {
    expect(SM.readSeen(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, SM.SEEN_FILE), '{not json');
    expect(SM.readSeen(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, SM.SEEN_FILE), JSON.stringify({ at: 'never' }));
    expect(SM.readSeen(dir)).toBeNull();
  });

  it('writes the mark with who set it and the one before', () => {
    const a = SM.writeSeen(dir, { by: 'cli', now: Date.parse('2026-11-21T21:40:00Z') });
    expect(a).toEqual({ ok: true, seen: { at: '2026-11-21T21:40:00.000Z', by: 'cli', previous: null } });
    SM.writeSeen(dir, { by: 'board', now: Date.parse('2026-11-22T07:00:00Z') });
    expect(SM.readSeen(dir)).toEqual({ at: '2026-11-22T07:00:00.000Z', by: 'board', previous: '2026-11-21T21:40:00.000Z' });
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('refuses an unknown by and never throws', () => {
    expect(SM.writeSeen(dir, { by: 'agent' })).toMatchObject({ ok: false });
    expect(SM.readSeen(dir)).toBeNull();
    expect(SM.writeSeen(path.join(dir, 'missing', 'deeper'), { by: 'cli' })).toMatchObject({ ok: false });
  });
});
