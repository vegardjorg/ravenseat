// =============================================================
// timeLogArchive.test.ts: the monthly rotation of the time log (lib/timeLogArchive.js, owner decision B5).
//
// Locks: a write in a new UTC month moves the old file to times-<YYYY-MM>.jsonl next to it before it appends; an
// existing archive is never overwritten (a second one gets .2); `off` never rotates; a reader with a window skips only
// archives that end well before it, and the cost of a window that spans a rotation is the same as before it; many
// writers at once at the month boundary lose and duplicate nothing; a lock left by a dead process and a crash between
// the rename and the append leave a state the next write and every reader can use.
// =============================================================
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const TA = require('../timeLogArchive.js') as any;
const TK = require('../timeCost.js') as any;
const TL = require('../timeLogRows.js') as any;
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

const MODULE = path.resolve(__dirname, '..', 'timeLogArchive.js');
let dir = '';
let log = '';
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ravenseat-timelog-'));
  log = path.join(dir, 'times.jsonl');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

const NOV = Date.parse('2026-11-02T10:00:00.000Z');
const OCT_MTIME = Date.parse('2026-10-31T23:00:00.000Z') / 1000;
const jsonl = (rows: object[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const lines = (file: string) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
/** Writes the log and dates it to the last day of October, as if the last write was then. */
function octoberLog(rows: object[]) {
  fs.writeFileSync(log, jsonl(rows));
  fs.utimesSync(log, OCT_MTIME, OCT_MTIME);
}

describe('rotateIfDue and appendText', () => {
  it('the first write in a new month moves the old file to times-2026-10.jsonl, then appends to a new file', () => {
    octoberLog([{ time: '2026-10-31T22:00:00.000Z', event: 'start', agent_id: 'a' }]);
    TA.appendText(log, `${JSON.stringify({ time: '2026-11-02T10:00:00.000Z', event: 'x' })}\n`, { now: NOV, mode: 'monthly' });
    const archive = path.join(dir, 'times-2026-10.jsonl');
    expect(lines(archive)).toHaveLength(1);
    expect(lines(log)).toHaveLength(1);
    expect(JSON.parse(lines(log)[0]).event).toBe('x');
    expect(TA.archives(log).map((a: any) => path.basename(a.file))).toEqual(['times-2026-10.jsonl']);
  });

  it('a write in the same month does not rotate', () => {
    fs.writeFileSync(log, jsonl([{ time: '2026-11-01T01:00:00.000Z' }]));
    const now = Date.now();
    expect(TA.rotateIfDue(log, { now, mode: 'monthly' }).rotated).toBe(false);
    expect(TA.archives(log)).toEqual([]);
  });

  it('mode off never rotates, however old the file is', () => {
    octoberLog([{ time: '2026-10-01T00:00:00.000Z' }]);
    TA.appendText(log, '{"a":1}\n', { now: NOV, mode: 'off' });
    expect(TA.archives(log)).toEqual([]);
    expect(lines(log)).toHaveLength(2);
  });

  it('an archive of that month that exists already is never overwritten: the new one is .2', () => {
    fs.writeFileSync(path.join(dir, 'times-2026-10.jsonl'), '{"old":1}\n');
    octoberLog([{ time: '2026-10-31T22:00:00.000Z', n: 2 }]);
    expect(TA.rotateIfDue(log, { now: NOV, mode: 'monthly' })).toMatchObject({ rotated: true });
    expect(lines(path.join(dir, 'times-2026-10.jsonl'))).toEqual(['{"old":1}']);
    expect(lines(path.join(dir, 'times-2026-10.2.jsonl'))).toHaveLength(1);
    expect(TA.archives(log).map((a: any) => path.basename(a.file))).toEqual(['times-2026-10.jsonl', 'times-2026-10.2.jsonl']);
  });

  it('timeLogRows.appendRows rotates too (every writer goes through appendText), with the mode from the config', () => {
    fs.writeFileSync(log, '{"n":1}\n');
    const old = (Date.now() - 40 * 86_400_000) / 1000;
    fs.utimesSync(log, old, old);
    expect(TL.appendRows(log, { event: 'gate' })).toBe(true);
    const month = new Date(old * 1000).toISOString().slice(0, 7);
    expect(fs.existsSync(path.join(dir, `times-${month}.jsonl`))).toBe(true);
    expect(lines(log)).toHaveLength(1);
  });

  it('a lock left by a dead process does not stop the rotation (taken over)', () => {
    octoberLog([{ time: '2026-10-31T22:00:00.000Z' }]);
    const lock = TA.lockDir(log);
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, 'owner-1.json'), JSON.stringify({ generation: 1, pid: 999999, nonce: 'x', hostname: os.hostname() }));
    expect(TA.rotateIfDue(log, { now: NOV, mode: 'monthly' }).rotated).toBe(true);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('a crash after the rename and before the append: readers still see every row, and the next write goes on', () => {
    octoberLog([{ time: '2026-10-31T22:00:00.000Z', n: 1 }]);
    TA.rotateIfDue(log, { now: NOV, mode: 'monthly' });
    expect(fs.existsSync(log)).toBe(false);
    expect(TK.readRows(TA.readText(log)).map((r: any) => r.n)).toEqual([1]);
    TA.appendText(log, '{"n":2}\n', { now: NOV, mode: 'monthly' });
    expect(TK.readRows(TA.readText(log)).map((r: any) => r.n)).toEqual([1, 2]);
  });
});

describe('readText', () => {
  it('reads the archives oldest first, then the current file; without any file it throws ENOENT as before', () => {
    expect(() => TA.readText(log)).toThrow(/ENOENT/);
    fs.writeFileSync(path.join(dir, 'times-2026-09.jsonl'), '{"n":1}\n');
    fs.writeFileSync(path.join(dir, 'times-2026-10.jsonl'), '{"n":2}'); // a half line at the end of a file
    fs.writeFileSync(log, '{"n":3}\n');
    expect(TK.readRows(TA.readText(log)).map((r: any) => r.n)).toEqual([1, 2, 3]);
  });

  it('a window skips only archives that ended more than the margin before it', () => {
    fs.writeFileSync(path.join(dir, 'times-2026-08.jsonl'), '{"n":8}\n');
    fs.writeFileSync(path.join(dir, 'times-2026-09.jsonl'), '{"n":9}\n');
    fs.writeFileSync(path.join(dir, 'times-2026-10.jsonl'), '{"n":10}\n');
    fs.writeFileSync(log, '{"n":11}\n');
    // From 5 October: September ended 4 days before (inside the 7-day margin), August long before.
    const rows = TK.readRows(TA.readText(log, { from: '2026-10-05T00:00:00.000Z' })).map((r: any) => r.n);
    expect(rows).toEqual([9, 10, 11]);
    expect(TK.readRows(TA.readText(log, { from: Date.parse('2026-11-20T00:00:00.000Z') })).map((r: any) => r.n)).toEqual([11]);
  });

  it('the cost of a day that spans a rotation is the same before and after it (cumulative rows across files)', () => {
    // One agent from 31 October to 1 November (Oslo): its rows are cumulative, so the 1 November cost is the growth.
    const usage = (mtok: number, time: string) => ({
      time, event: 'done', agent_id: 'a1', agent_type: 'track', track: 'T-1', cumulative: true,
      tokens: { input: 0, output: mtok * 1_000_000, cache_read: 0, cache_written: 0 },
    });
    const rows = [
      usage(4, '2026-10-31T20:00:00.000Z'),
      usage(5, '2026-10-31T22:30:00.000Z'), // 23:30 in Oslo: still 31 October there
      usage(9, '2026-10-31T23:30:00.000Z'), // 00:30 on 1 November in Oslo
    ];
    octoberLog(rows);
    const day = '2026-11-01';
    const sum = (text: string) => TK.usageEvents(TK.readRows(text)).reduce((s: number, e: any) => s + e.usd, 0);
    const before = TK.dailyUsage(TK.readRows(fs.readFileSync(log, 'utf8')), day, 'Europe/Oslo');
    const beforeAll = sum(fs.readFileSync(log, 'utf8'));
    expect(before).toBeGreaterThan(0);
    TA.appendText(log, `${JSON.stringify(usage(12, '2026-11-02T09:00:00.000Z'))}\n`, { now: NOV, mode: 'monthly' });
    expect(fs.existsSync(path.join(dir, 'times-2026-10.jsonl'))).toBe(true);
    // A window from 31 October reads the October archive (inside the margin) and gets exactly the same day.
    const after = TK.dailyUsage(TK.readRows(TA.readText(log, { from: Date.parse('2026-10-31T00:00:00.000Z') })), day, 'Europe/Oslo');
    expect(after).toBe(before);
    // Everything read: the old total plus the new row's growth only (12 - 9 million output tokens), nothing twice.
    const allAfter = sum(TA.readText(log));
    const growth = sum(jsonl([usage(9, '2026-10-31T23:30:00.000Z'), usage(12, '2026-11-02T09:00:00.000Z')])) - sum(jsonl([usage(9, '2026-10-31T23:30:00.000Z')]));
    expect(allAfter).toBeCloseTo(beforeAll + growth, 9);
    // The current file alone would count the new row as all new: that is why the window reads the archive.
    expect(sum(fs.readFileSync(log, 'utf8'))).toBeGreaterThan(growth);
  });

  it('signature changes when an archive appears, so a cache keyed on it reads again', () => {
    fs.writeFileSync(log, '{"n":1}\n');
    const a = TA.signature(log);
    fs.writeFileSync(path.join(dir, 'times-2026-10.jsonl'), '{"n":0}\n');
    expect(TA.signature(log)).not.toBe(a);
  });
});

describe('many writers at the month boundary', () => {
  it('eight processes appending at once after the month changed: one rotation, no row lost or doubled', async () => {
    const old = Array.from({ length: 50 }, (_, i) => ({ time: '2026-10-31T20:00:00.000Z', id: `old-${i}` }));
    octoberLog(old);
    const PER = 40;
    const script = (w: number) =>
      `const TA = require(${JSON.stringify(MODULE)});` +
      `for (let i = 0; i < ${PER}; i++) TA.appendText(${JSON.stringify(log)}, JSON.stringify({ id: 'w${w}-' + i }) + '\\n', { now: ${NOV}, mode: 'monthly' });`;
    await Promise.all(
      Array.from({ length: 8 }, (_, w) =>
        new Promise<void>((resolve, reject) => {
          const p = spawn(process.execPath, ['-e', script(w)], { stdio: 'ignore' });
          p.on('error', reject);
          p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`writer ${w} exit ${code}`))));
        }),
      ),
    );
    const archived = TA.archives(log);
    expect(archived.map((a: any) => path.basename(a.file))).toEqual(['times-2026-10.jsonl']);
    expect(lines(archived[0].file).map((l) => JSON.parse(l).id)).toEqual(old.map((r) => r.id));
    const ids = TK.readRows(TA.readText(log)).map((r: any) => r.id);
    expect(ids).toHaveLength(50 + 8 * PER);
    expect(new Set(ids).size).toBe(ids.length);
    expect(fs.existsSync(TA.lockDir(log))).toBe(false);
  });
});

describe('modeOf and stats', () => {
  it('monthly unless the config says off', () => {
    expect(TA.modeOf({})).toBe('monthly');
    expect(TA.modeOf({ history: { rotateTimeLog: 'off' } })).toBe('off');
    expect(TA.modeOf({ history: { rotateTimeLog: 'weekly' } })).toBe('monthly');
  });

  it('stats counts the rows and bytes of the current file and the archives', () => {
    fs.writeFileSync(path.join(dir, 'times-2026-10.jsonl'), '{"n":1}\n{"n":2}\n');
    fs.writeFileSync(log, '{"n":3}\n');
    expect(TA.stats(log)).toMatchObject({ rows: 1, archives: 1, archiveRows: 2 });
  });
});
