// =============================================================
// findingLog.test.ts: the finding log as a pure library (lib/findingLog.js, step 2 of the finding format contract).
//
// Locks: makeRow validates every field and refuses a half row (unknown caught_by, missing severity, a field a source
// cannot fill); L and `other` never count; the excerpt is capped, has no code and never keeps a key; the area comes from
// the module list or the folder; append creates the file in the data folder, gives sequential F-<n> ids and rotates by
// month like the time log; read covers the archives on request; two writer processes at once give whole lines and unique
// ids; setFixedBy is a follow-up row (old lines never change) and the reader merges the latest state; a broken line is
// skipped with a warning.
// =============================================================
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const FL = require('../findingLog.js') as any;
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

const MODULE = path.resolve(__dirname, '..', 'findingLog.js');
// A test key built from parts, so no whole key is ever written in the source.
const AWS = ['AK', 'IA', 'QX7TFAKE', 'KEY4PUSH'].join('');

let root = '';
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ravenseat-findings-'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

const NOW = Date.parse('2026-11-16T10:02:11.456Z');
const review = (o: object = {}) => ({
  class: 'unchecked-error',
  caught_by: 'review:reviewer-security',
  severity: 'M',
  files: ['src/api/save.ts'],
  line: 42,
  task: 'ARCH-7',
  round: 2,
  item: 'reviewer-security#2:M1',
  excerpt: 'the write result is ignored, so a failed save looks green',
  ...o,
});

describe('makeRow', () => {
  it('builds the full row of the contract', () => {
    const r = FL.makeRow(review(), { now: NOW, seq: 118 });
    expect(r).toEqual({
      id: 'F-118',
      time: '2026-11-16T10:02:11Z',
      class: 'unchecked-error',
      class_source: 'agent',
      confidence: 'high',
      where: { files: ['src/api/save.ts'], line: 42, area: 'src/api' },
      caught_by: 'review:reviewer-security',
      severity: 'M',
      task: 'ARCH-7',
      round: 2,
      item: 'reviewer-security#2:M1',
      cause_task: null,
      signature: null,
      excerpt: 'the write result is ignored, so a failed save looks green',
      disposition: null,
      fixed_by: null,
      test_added: null,
      guard: null,
      counts: true,
    });
  });

  it('leaves the id to append when no seq is given, and refuses a malformed one', () => {
    expect(FL.makeRow(review(), { now: NOW }).id).toBeNull();
    expect(() => FL.makeRow(review({ id: 'X-1' }), { now: NOW })).toThrow(/id/);
  });

  it('refuses an unknown caught_by and a missing required field', () => {
    expect(() => FL.makeRow(review({ caught_by: 'linter' }))).toThrow(/caught_by/);
    expect(() => FL.makeRow(review({ caught_by: 'review:' }))).toThrow(/caught_by/);
    expect(() => FL.makeRow(review({ caught_by: undefined }))).toThrow(/caught_by/);
    expect(() => FL.makeRow(review({ severity: undefined }))).toThrow(/severity/);
    expect(() => FL.makeRow(review({ severity: 'X' }))).toThrow(/severity/);
    expect(() => FL.makeRow(review({ excerpt: '' }))).toThrow(/excerpt/);
    expect(() => FL.makeRow(review({ class: undefined }))).toThrow(/class/);
  });

  it('accepts every caught_by of the fixed list', () => {
    for (const c of ['gate', 'ci', 'base-gate', 'done-check', 'red-on-base', 'secret-scan', 'gate-line', 'finding', 'qa', 'owner', 'post-merge']) {
      expect(FL.makeRow({ class: '-', caught_by: c, severity: 'H', excerpt: 'x' }).caught_by).toBe(c);
    }
  });

  it('keeps item and round to review and signature to gate and CI', () => {
    expect(() => FL.makeRow({ caught_by: 'gate', class: '-', severity: 'H', excerpt: 'x', item: 'a#1:H1' })).toThrow(/item/);
    expect(() => FL.makeRow({ caught_by: 'qa', class: '-', severity: 'H', excerpt: 'x', round: 1 })).toThrow(/round/);
    expect(() => FL.makeRow(review({ signature: 'abc123def456' }))).toThrow(/signature/);
    expect(FL.makeRow({ caught_by: 'ci', class: '-', severity: 'H', excerpt: 'x', signature: 'abc123def456' }).signature).toBe('abc123def456');
    expect(() => FL.makeRow(review({ round: 0 }))).toThrow(/round/);
  });

  it('checks the time, the enums, the disposition and the shas', () => {
    expect(FL.makeRow(review({ time: '2026-11-16T12:00:00+02:00' })).time).toBe('2026-11-16T10:00:00Z');
    expect(() => FL.makeRow(review({ time: 'yesterday' }))).toThrow(/time/);
    expect(() => FL.makeRow(review({ class_source: 'guess' }))).toThrow(/class_source/);
    expect(() => FL.makeRow(review({ confidence: 'maybe' }))).toThrow(/confidence/);
    expect(FL.makeRow(review({ disposition: { kind: 'rejected', ref: 'false-positive', note: 'not reachable' } })).disposition).toEqual({
      kind: 'rejected',
      ref: 'false-positive',
      note: 'not reachable',
    });
    expect(() => FL.makeRow(review({ disposition: { kind: 'rejected', ref: 'because' } }))).toThrow(/disposition/);
    expect(() => FL.makeRow(review({ disposition: { kind: 'moved', ref: 'x' } }))).toThrow(/disposition/);
    expect(() => FL.makeRow(review({ fixed_by: 'not a sha' }))).toThrow(/fixed_by/);
    expect(FL.makeRow(review({ fixed_by: 'A1B2C3D' })).fixed_by).toBe('a1b2c3d');
  });

  it('gives counts false for L and for other, true otherwise', () => {
    expect(FL.makeRow(review({ severity: 'L' })).counts).toBe(false);
    expect(FL.makeRow(review({ class: '-' })).counts).toBe(false);
    expect(FL.makeRow(review({ class: 'Not Kebab' })).class).toBe('other');
    expect(FL.makeRow(review({ class: 'other' })).counts).toBe(false);
    expect(FL.makeRow(review({ severity: 'H' })).counts).toBe(true);
    // counts is derived, never taken from the input.
    expect(FL.makeRow(review({ severity: 'L', counts: true })).counts).toBe(false);
  });

  it('normalizes the class through a given function, and falls back to kebab-case or other', () => {
    const normalizeClass = (id: string) => (id === 'null-check' ? 'null-undefined' : 'other');
    expect(FL.makeRow(review({ class: 'null-check' }), { normalizeClass }).class).toBe('null-undefined');
    expect(FL.makeRow(review({ class: 'time-zone' }), { normalizeClass }).class).toBe('other');
    expect(FL.normalizeClassFallback('time-zone')).toBe('time-zone');
    expect(FL.normalizeClassFallback('TimeZone')).toBe('other');
    expect(FL.normalizeClassFallback('a--b')).toBe('other');
  });

  it('derives the area from the module list or the common folder, and drops paths that are not repo paths', () => {
    const modules = [{ id: 'billing', paths: ['src/billing/'] }];
    expect(FL.makeRow(review({ files: ['src/billing/a/x.ts'] }), { modules }).where.area).toBe('billing');
    expect(FL.makeRow(review({ files: ['src/api/a/x.ts', 'src/api/b/y.ts'] })).where.area).toBe('src/api');
    expect(FL.makeRow(review({ files: ['README.md'] })).where.area).toBe('.');
    const bad = FL.makeRow(review({ files: ['../outside.ts', 'C:/abs.ts', 'ok/file.ts'] }));
    expect(bad.where.files).toEqual(['ok/file.ts']);
    const none = FL.makeRow(review({ files: '-', line: null }));
    expect(none.where).toEqual({ files: [], line: null, area: null });
  });

  it('caps the excerpt, keeps no code, and masks a key', () => {
    const long = FL.makeRow(review({ excerpt: 'word '.repeat(100) })).excerpt;
    expect(long.length).toBeLessThanOrEqual(200);
    const code = FL.makeRow(review({ excerpt: 'see\n```ts\nconst a = 1;\n```\nfor the fix' })).excerpt;
    expect(code).not.toMatch(/const a/);
    expect(code).toMatch(/\[code\]/);
    const masked = FL.makeRow(review({ excerpt: `the key ${AWS} is logged on start` })).excerpt;
    expect(masked).not.toContain(AWS);
    expect(masked).toMatch(/REDACTED|secret/i);
    expect(masked).toMatch(/is logged on start/);
  });
});

describe('append and read', () => {
  it('creates the file in the data folder on the first write, never in a tracked place', () => {
    const file = FL.fileOf(root);
    expect(file).toBe(path.join(root, 'scripts', '.queue', 'findings.jsonl'));
    expect(fs.existsSync(file)).toBe(false);
    const row = FL.append(root, review(), { now: NOW });
    expect(row.id).toBe('F-1');
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readdirSync(root)).toEqual(['scripts']);
  });

  it('gives sequential ids and refuses an invalid row without writing', () => {
    FL.append(root, review(), { now: NOW });
    expect(FL.append(root, review(), { now: NOW }).id).toBe('F-2');
    expect(() => FL.append(root, review({ caught_by: 'nobody' }), { now: NOW })).toThrow();
    expect(FL.read(root).rows.map((r: { id: string }) => r.id)).toEqual(['F-1', 'F-2']);
  });

  it('rotates by month and reads the archives on request, ids going on across them', () => {
    const file = FL.fileOf(root);
    FL.append(root, review(), { now: Date.parse('2026-10-20T10:00:00Z') });
    const oct = Date.parse('2026-10-31T23:00:00Z') / 1000;
    fs.utimesSync(file, oct, oct);
    const r2 = FL.append(root, review({ severity: 'H' }), { now: NOW });
    expect(r2.id).toBe('F-2');
    expect(fs.existsSync(path.join(path.dirname(file), 'findings-2026-10.jsonl'))).toBe(true);
    expect(FL.read(root).rows.map((r: { id: string }) => r.id)).toEqual(['F-2']);
    expect(FL.read(root, { includeArchive: true }).rows.map((r: { id: string }) => r.id)).toEqual(['F-1', 'F-2']);
    expect(FL.read(root, { includeArchive: true, since: '2026-11-01T00:00:00Z' }).rows.map((r: { id: string }) => r.id)).toEqual(['F-2']);
  });

  it('reads nothing, without an error, before the first write', () => {
    expect(FL.read(root)).toEqual({ rows: [], warnings: [] });
    expect(FL.read(root, { includeArchive: true })).toEqual({ rows: [], warnings: [] });
  });

  it('skips a broken line with a warning and reads the rest', () => {
    FL.append(root, review(), { now: NOW });
    fs.appendFileSync(FL.fileOf(root), '{"id": "F-2", half a li\n["not a row"]\n');
    FL.append(root, review(), { now: NOW });
    const { rows, warnings } = FL.read(root);
    expect(rows.map((r: { id: string }) => r.id)).toEqual(['F-1', 'F-2']);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/line 2/);
  });

  it('two writer processes at once give whole lines and unique ids', async () => {
    const N = 15;
    const script = `
      const FL = require(${JSON.stringify(MODULE)});
      for (let i = 0; i < ${N}; i++) FL.append(process.argv[1], { class: 'other', caught_by: 'gate', severity: 'H', excerpt: 'w' + process.argv[2] + ' ' + 'x'.repeat(300) });
    `;
    const run = (tag: string) =>
      new Promise<number>((resolve) => {
        const p = spawn(process.execPath, ['-e', script, root, tag], { stdio: 'ignore' });
        p.on('exit', (code) => resolve(code ?? 1));
      });
    expect(await Promise.all([run('a'), run('b')])).toEqual([0, 0]);
    const text = fs.readFileSync(FL.fileOf(root), 'utf8');
    const lines = text.split('\n').filter(Boolean);
    expect(lines).toHaveLength(2 * N);
    const ids = lines.map((l) => JSON.parse(l).id);
    expect(new Set(ids).size).toBe(2 * N);
    expect(FL.read(root).warnings).toEqual([]);
  });
});

describe('setFixedBy and the merged state', () => {
  it('appends a follow-up row, never rewrites, and the reader merges the latest state', () => {
    FL.append(root, review(), { now: NOW });
    FL.append(root, review({ item: 'reviewer-code#1:L1', severity: 'L' }), { now: NOW });
    const before = fs.readFileSync(FL.fileOf(root), 'utf8');
    FL.setFixedBy(root, 'reviewer-security#2:M1', 'a1b2c3d', { now: NOW + 1000 });
    FL.setFixedBy(root, 'reviewer-security#2:M1', 'b2c3d4e', { now: NOW + 2000 });
    const after = fs.readFileSync(FL.fileOf(root), 'utf8');
    expect(after.startsWith(before)).toBe(true);
    const { rows } = FL.read(root);
    expect(rows).toHaveLength(2);
    expect(rows[0].fixed_by).toBe('b2c3d4e');
    expect(rows[1].fixed_by).toBeNull();
  });

  it('also targets a row by its id, and refuses a bad sha or an empty item', () => {
    FL.append(root, { class: 'other', caught_by: 'gate', severity: 'H', excerpt: 'x' }, { now: NOW });
    FL.setFixedBy(root, 'F-1', 'abcdef1', { now: NOW });
    expect(FL.read(root).rows[0].fixed_by).toBe('abcdef1');
    expect(() => FL.setFixedBy(root, 'F-1', 'nope')).toThrow(/sha/);
    expect(() => FL.setFixedBy(root, '', 'abcdef1')).toThrow(/item/);
  });
});

describe('byClass and byArea', () => {
  it('groups rows with a total and the counted number', () => {
    const rows = [
      FL.makeRow(review({ severity: 'M' })),
      FL.makeRow(review({ severity: 'L' })),
      FL.makeRow(review({ class: '-', files: ['lib/x.js'] })),
    ];
    const c = FL.byClass(rows);
    expect(c['unchecked-error'].total).toBe(2);
    expect(c['unchecked-error'].counts).toBe(1);
    expect(c.other.counts).toBe(0);
    const a = FL.byArea(rows);
    expect(a['src/api'].total).toBe(2);
    expect(a.lib.total).toBe(1);
  });
});
