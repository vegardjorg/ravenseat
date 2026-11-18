// =============================================================
// clientCanary.test.ts: the format canary in the core (lib/clientCanary.js, roadmap 0w W4): the doctor row, the facts
// and the card on the Checks tab, the settings and the shape log.
//
// Locks: the doctor row is OK, INFO or WARN and never FAIL; the card is medium and never lights the red marker; the
// card's line names the version and the row types, never content; the shape log writes only new shapes, under a cap,
// with no values; client.canary and client.shapeLog default to on and off. Temp folders and synthetic rows only.
// =============================================================
import { describe, expect, it, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const CC = require('../clientCanary.js') as any;
const K = require('../clients/index.js').clientFor().canary as any;
const QC = require('../queueConfig.js') as any;
const CATALOG = require('../checksCatalog.js') as any;
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

const temporary: string[] = [];
afterAll(() => {
  for (const d of temporary) fs.rmSync(d, { recursive: true, force: true });
});
const tempDir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'client-canary-'));
  temporary.push(d);
  return d;
};

const SECRET = 'PRIVATE-CONTENT-do-not-leak';
const ok = [{ type: 'assistant', version: '2.1.317', message: { id: 'm1', model: 'x', content: [], usage: { input_tokens: 1 } } }];
const newer = ok.map((r) => ({ ...r, version: '2.1.400' }));
const changed = [...newer, { type: 'brand-new-row', version: '2.1.400', text: SECRET }];

describe('the settings', () => {
  it('client.canary is on and client.shapeLog off by default', () => {
    expect(QC.STANDARD.client).toEqual({ canary: true, shapeLog: false });
    expect(CC.setupOf({})).toEqual({ on: true, shapeLog: false });
    expect(CC.setupOf({ client: { canary: false, shapeLog: true } })).toEqual({ on: false, shapeLog: true });
  });
});

describe('the doctor row', () => {
  it('no summary: no row', () => {
    expect(CC.doctorRow(null)).toBeNull();
  });

  it('OK when the rows read as expected', () => {
    expect(CC.doctorRow(K.summarize(ok))).toMatchObject({ status: 'OK', name: 'canary', fix: null });
  });

  it('INFO for a newer version alone', () => {
    const r = CC.doctorRow(K.summarize(newer));
    expect(r.status).toBe('INFO');
    expect(r.message).toContain('Claude Code 2.1.400 is newer than the formats the fixtures cover (2.1.317)');
  });

  it('a newer version alone is only shown by doctor --all; a changed format is shown by plain doctor (L7)', () => {
    const G = require('../guidance.js');
    const info = CC.doctorRow(K.summarize(newer));
    expect(info).toMatchObject({ status: 'INFO', onRequest: true });
    expect(G.filterDoctor([info], false).rows).toEqual([]);
    expect(G.filterDoctor([info], false, { all: true }).rows).toEqual([info]);
    const warned = CC.doctorRow(K.summarize(changed));
    expect(warned.onRequest).toBeFalsy();
    expect(G.filterDoctor([warned], false).rows).toEqual([warned]);
    expect(CC.doctorRow(K.summarize(ok)).onRequest).toBeFalsy();
  });

  it('WARN for rows read differently, with what to do, never FAIL and never content', () => {
    const r = CC.doctorRow(K.summarize(changed), { cli: 'rs' });
    expect(r.status).toBe('WARN');
    expect(r.message).toContain('brand-new-row (1)');
    expect(r.message).toContain('nothing is stopped');
    expect(r.fix).toContain('claude plugin update ravenseat@ravenseat');
    expect(r.fix).toContain('rs settings set client.canary off');
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });
});

describe('readLatest', () => {
  it('reads the newest transcript of QUEUE_TRANSCRIPTS, and null without one', () => {
    const dir = tempDir();
    expect(CC.readLatest('/x', { env: { QUEUE_TRANSCRIPTS: dir } })).toBeNull();
    fs.writeFileSync(path.join(dir, 's1.jsonl'), changed.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const s = CC.readLatest('/x', { env: { QUEUE_TRANSCRIPTS: dir } });
    expect(K.hasSignal(s)).toBe(true);
    expect(s.newest).toBe('2.1.400');
  });
});

describe('the card on the Checks tab', () => {
  const catalog = CATALOG.loadCatalog({
    builtin: path.join(__dirname, '..', '..', 'checks-catalog'),
    own: path.join(tempDir(), 'none'),
  });
  const report = (clientCanary: unknown) => CATALOG.buildReport({ facts: { clientCanary }, catalog, now: 'now' });
  const card = (r: any) => r.suggestions.find((s: any) => s.key === 'client-format');

  it('shows while rows read differently: medium, its line names the version and the types, no red marker', () => {
    const r = report(CC.facts(K.summarize(changed)));
    const c = card(r);
    expect(c).toMatchObject({ priority: 'medium', category: 'client', action: 'ask', state: 'open' });
    expect(c.detail).toContain('Claude Code 2.1.400');
    expect(c.detail).toContain('brand-new-row (1)');
    expect(JSON.stringify(r)).not.toContain(SECRET);
    // The other cards these bare facts show may count; the canary card adds nothing to the red marker.
    expect(r.important).toBe(report(undefined).important);
  });

  it('no card for a newer version alone, for rows that read as expected, or without facts', () => {
    expect(card(report(CC.facts(K.summarize(newer))))).toBeUndefined();
    expect(card(report(CC.facts(K.summarize(ok))))).toBeUndefined();
    expect(card(report(CC.facts(null)))).toBeUndefined();
    expect(card(report(undefined))).toBeUndefined();
  });
});

describe('the shape log', () => {
  const errorRow = (error: unknown) => ({ type: 'system', subtype: 'api_error', version: '2.1.400', uuid: 'u', timestamp: 't', error });

  it('writes each new shape once, keys and types only, and nothing without a system API error', () => {
    const dir = tempDir();
    const file = path.join(dir, CC.SHAPE_FILE);
    expect(CC.logShapes(dir, K.summarize(ok))).toBe(0);
    expect(fs.existsSync(file)).toBe(false);
    const s = K.summarize([errorRow({ status: 500, message: SECRET }), errorRow('rate_limit'), errorRow({ status: 502, message: SECRET })]);
    expect(CC.logShapes(dir, s, { now: '2026-11-17T00:00:00.000Z' })).toBe(2);
    expect(CC.logShapes(dir, s)).toBe(0);
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines[0]).toEqual({
      seen: '2026-11-17T00:00:00.000Z',
      version: '2.1.400',
      form: 'system api_error',
      shape: { error: { message: 'string', status: 'number' }, subtype: 'string:api_error', type: 'string:system', version: 'string' },
    });
    expect(lines[1].shape.error).toBe('string:rate_limit');
    expect(fs.readFileSync(file, 'utf8')).not.toContain(SECRET);
  });

  it('stops at the cap', () => {
    const dir = tempDir();
    const file = path.join(dir, CC.SHAPE_FILE);
    fs.writeFileSync(file, `${Array.from({ length: CC.SHAPE_MAX }, (_, i) => JSON.stringify({ shape: { n: i } })).join('\n')}\n`);
    expect(CC.logShapes(dir, K.summarize([errorRow('rate_limit')]))).toBe(0);
  });
});
