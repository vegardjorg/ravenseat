// =============================================================
// claudeCanary.test.ts: the format canary of the Claude Code adapter (lib/clients/claude/canary.js, roadmap 0w W4).
//
// Why: when Claude Code changes a format, the queue should say so once, in plain words, instead of stopping or quietly
// miscounting. The canary reads the last rows of a transcript and sums up what it did not expect, without content.
// Locks:
//   - today's fixtures give no finding (the rows the adapter knows, and the row types that are unknown on purpose);
//   - a new row type, a newer version, an assistant turn without usage and an API error of another kind each give one;
//   - nothing of a row's content reaches the summary or the shape (only type names, counts and short enum codes);
//   - the tail reading cuts the half line at the start, and newestTranscript picks the newest file;
//   - COVERED_VERSION is the newest version in the fixtures.
// Synthetic rows and temp folders only.
// =============================================================
import { describe, expect, it, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const C = require('../clients/index.js').clientFor();
const K = C.canary as any;
const TR = C.transcripts as any;
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

const DIR = path.join(__dirname, '..', 'clients', 'claude', 'fixtures', 'formats');
const FILES = fs.readdirSync(DIR).filter((f) => f.endsWith('.jsonl'));
const rowsOf = (f: string) =>
  fs
    .readFileSync(path.join(DIR, f), 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l));

const temporary: string[] = [];
afterAll(() => {
  for (const d of temporary) fs.rmSync(d, { recursive: true, force: true });
});
const tempDir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-'));
  temporary.push(d);
  return d;
};

/** Words that stand in for content: none of them may show up in a summary or a shape. */
const SECRET = 'PRIVATE-CONTENT-do-not-leak';

describe('the fixtures give no finding', () => {
  it.each(FILES)('%s: nothing unknown, no turn without usage, no API error of another kind', (f) => {
    const s = K.summarize(rowsOf(f));
    expect(s.rows).toBe(rowsOf(f).length);
    expect(s.unknownTypes).toEqual([]);
    expect(s.missingUsage).toBe(0);
    expect(s.otherErrors).toEqual([]);
    expect(s.newer).toBe(false);
    expect(K.hasSignal(s)).toBe(false);
    expect(K.news(s)).toEqual([]);
  });

  it('COVERED_VERSION is the newest version the fixtures hold', () => {
    const versions = FILES.flatMap((f) => rowsOf(f).map((r) => r.version)).filter((v) => typeof v === 'string');
    const newest = versions.reduce((a, b) => (K.compareVersions(a, b) >= 0 ? a : b));
    expect(K.COVERED_VERSION).toBe(newest);
  });

  it('the row types unknown on purpose are exactly the ones the adapter reads as unknown in the fixtures', () => {
    const unknown = new Set(FILES.flatMap((f) => rowsOf(f)).filter((r) => C.entries.entry(r).kind === 'unknown').map((r) => r.type));
    for (const t of unknown) expect(K.QUIET_TYPES).toContain(t);
  });
});

describe('a changed format gives findings, without content', () => {
  const base = rowsOf('2.1.317.jsonl');
  const bump = (r: any) => ({ ...r, version: '2.1.400' });
  const changed = [
    ...base.map(bump),
    { type: 'brand-new-row', uuid: 'x1', version: '2.1.400', payload: SECRET },
    { type: 'brand-new-row', uuid: 'x2', version: '2.1.400', payload: SECRET },
    { type: 'system', subtype: 'api_error', version: '2.1.400', error: { type: SECRET, message: SECRET, status: 500 } },
    { type: 'system', subtype: 'api_error', version: '2.1.400', error: 'server_busy' },
    { type: 'assistant', version: '2.1.400', message: { id: 'msg_new_1', model: 'm', content: [{ type: 'text', text: SECRET }] } },
    { type: 'assistant', version: '2.1.400', message: { id: 'msg_new_1', model: 'm', content: [{ type: 'text', text: SECRET }] } },
    { type: { nested: SECRET }, version: '2.1.400' },
    'not an object',
  ];

  it('a new version is newer than the fixtures', () => {
    const s = K.summarize(base.map(bump));
    expect(s.versions).toEqual(['2.1.400']);
    expect(s.newest).toBe('2.1.400');
    expect(s.newer).toBe(true);
    // A newer version alone is no signal: everything still reads as expected.
    expect(K.hasSignal(s)).toBe(false);
    expect(K.news(s)).toEqual(['Claude Code 2.1.400 is newer than the formats the fixtures cover (2.1.317)']);
  });

  it('new row types, a turn without usage and an API error of another kind are counted', () => {
    const s = K.summarize(changed);
    expect(K.hasSignal(s)).toBe(true);
    expect(s.unknownTypes).toEqual([
      { type: 'brand-new-row', subtype: null, count: 2 },
      { type: '<other>', subtype: null, count: 1 },
      { type: '<not an object>', subtype: null, count: 1 },
    ]);
    // One turn streamed over two rows: one turn without usage.
    expect(s.missingUsage).toBe(1);
    expect(s.otherErrors).toEqual([
      { form: 'system', code: '<other>', status: 500, count: 1 },
      { form: 'system', code: 'server_busy', status: null, count: 1 },
    ]);
    expect(K.news(s)).toEqual([
      'Claude Code 2.1.400 is newer than the formats the fixtures cover (2.1.317)',
      'row types Ravenseat does not know: brand-new-row (2), <other> (1), <not an object> (1)',
      '1 assistant turn(s) without token usage',
      'API errors of an unknown kind: <other> 500 (1), server_busy (1)',
    ]);
  });

  it('nothing of the content reaches the summary or the shapes', () => {
    const s = K.summarize(changed);
    expect(JSON.stringify(s)).not.toContain(SECRET);
    expect(K.news(s).join(' ')).not.toContain(SECRET);
  });

  it('the shape of a system API error: keys and types, a short enum code kept, no other value', () => {
    const s = K.summarize(changed);
    const errors = s.systemErrorShapes.map((x: any) => x.shape.error);
    expect(errors).toContainEqual({ message: 'string', status: 'number', type: 'string' });
    expect(errors).toContainEqual('string:server_busy');
    expect(errors).toContainEqual('string:rate_limit');
    // The row around it: type and subtype as enum codes, the rest as types (a version has dots, so no code).
    const busy = s.systemErrorShapes.find((x: any) => x.shape.error === 'string:server_busy');
    expect(busy).toEqual({ shape: { error: 'string:server_busy', subtype: 'string:api_error', type: 'string:system', version: 'string' }, count: 1 });
    expect(JSON.stringify(s.systemErrorShapes)).not.toContain(SECRET);
    expect(K.shapeOf({ a: [1, 2], b: null, c: true, d: 'Some Text', e: { f: { g: { h: { i: 1 } } } } })).toEqual({
      a: ['number'],
      b: 'null',
      c: 'boolean',
      d: 'string',
      e: { f: { g: { h: 'object' } } },
    });
  });

  it('a row type that is unknown on purpose gives no finding', () => {
    for (const type of K.QUIET_TYPES) expect(K.hasSignal(K.summarize([{ type, version: '2.1.317' }])), type).toBe(false);
  });

  it('a synthetic API error turn without usage is no missing usage', () => {
    const s = K.summarize([{ type: 'assistant', isApiErrorMessage: true, apiErrorStatus: 529, error: 'overloaded', message: { id: 'm1', model: '<synthetic>', content: [] } }]);
    expect(s.missingUsage).toBe(0);
    expect(K.hasSignal(s)).toBe(false);
  });
});

describe('reading the tail', () => {
  it('fromText drops the half line at the cut, a line being written, and keeps the last rows', () => {
    const lines = ['{"type":"user","version":"2.1.317"}', '{"type":"assistant","version":"2.1.317"}', '{"type":"syst'];
    expect(K.fromText(`r":1}\n${lines.join('\n')}`, { fromStart: false }).length).toBe(2);
    expect(K.fromText(lines.join('\n'), { fromStart: true, maxRows: 1 })).toEqual([{ type: 'assistant', version: '2.1.317' }]);
  });

  it('readFile reads only the tail of the file and sums it up', () => {
    const dir = tempDir();
    const file = path.join(dir, 's.jsonl');
    const pad = `${JSON.stringify({ type: 'user', version: '2.1.300', message: { content: 'x'.repeat(200) } })}\n`;
    fs.writeFileSync(file, pad.repeat(50) + `${JSON.stringify({ type: 'brand-new-row', version: '2.1.317' })}\n`);
    const s = K.readFile(file, { bytes: 1000 });
    expect(s.unknownTypes).toEqual([{ type: 'brand-new-row', subtype: null, count: 1 }]);
    expect(s.rows).toBeLessThan(50);
    expect(K.readFile(path.join(dir, 'missing.jsonl'))).toBeNull();
  });

  it('newestTranscript: the newest of the main sessions and the subagents of the newest one', () => {
    const dir = tempDir();
    const at = (f: string, s: number) => {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, '{}\n');
      fs.utimesSync(f, s, s);
    };
    expect(TR.newestTranscript(dir)).toBeNull();
    at(path.join(dir, 'old.jsonl'), 1000);
    at(path.join(dir, 'new.jsonl'), 2000);
    expect(TR.newestTranscript(dir)).toBe(path.join(dir, 'new.jsonl'));
    at(path.join(dir, 'new', 'subagents', 'agent-a1.jsonl'), 3000);
    expect(TR.newestTranscript(dir)).toBe(path.join(dir, 'new', 'subagents', 'agent-a1.jsonl'));
    expect(TR.newestTranscript(path.join(dir, 'none'))).toBeNull();
  });
});
