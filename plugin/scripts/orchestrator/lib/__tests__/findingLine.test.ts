// =============================================================
// findingLine.test.ts: the FINDING line and the GATE tail (lib/findingLine.js). The rules are the ones in the shared
// finding format: every finding a reviewer writes becomes an item, a malformed one too, and the text is data.
// =============================================================
import { describe, expect, it } from 'vitest';

/* eslint-disable-next-line @typescript-eslint/no-require-imports */
const F = require('../findingLine.js');

const one = (line: string) => F.parseFindingLines(line).items[0];

describe('parseFindingLines: a valid line', () => {
  it('reads every field, with file and line', () => {
    expect(one('FINDING M1 M mechanical unchecked-error @ src/api/save.ts:42 | the write result is ignored')).toEqual({
      code: 'M1',
      severity: 'M',
      mark: 'mechanical',
      class: 'unchecked-error',
      file: 'src/api/save.ts',
      line: 42,
      text: 'the write result is ignored',
    });
  });
  it('a path without a line, "-" as place and "-" as class', () => {
    expect(one('FINDING L1 L defer time-zone @ src/day.ts | local time')).toMatchObject({ file: 'src/day.ts', line: null });
    expect(one('FINDING L2 L before-merge - @ - | docs table')).toMatchObject({ class: 'other', file: null, line: null });
  });
  it('an unknown class becomes other; a project class is kept when the project has it', () => {
    expect(one('FINDING H1 H fix-round made-up @ a.js:1 | x').class).toBe('other');
    const classes = [{ id: 'audit-trail', title: 't' }, { id: 'other', title: 'o' }];
    expect(F.parseFindingLines('FINDING H1 H fix-round audit-trail @ a.js:1 | x', { classes }).items[0].class).toBe('audit-trail');
  });
  it('tolerates a list item and backticks, keeps backticks inside the sentence', () => {
    const r = F.parseFindingLines(['- FINDING H1 H fix-round injection @ a.js:3 | uses `eval`', '* `FINDING M1 M mechanical - @ - | y`'].join('\n'));
    expect(r.items.map((x: { code: string; text: string }) => [x.code, x.text])).toEqual([
      ['H1', 'uses `eval`'],
      ['M1', 'y'],
    ]);
  });
  it('prose "finding", a heading, FINDINGS and "FINDING none" are no line', () => {
    const r = F.parseFindingLines(['finding M1 M mechanical - @ - | x', 'Finding: a thing', 'FINDINGS H=0 M=1 L=0', 'FINDING none', 'The FINDING below'].join('\n'));
    expect(r.items).toEqual([]);
    expect(r.lines).toBe(0);
    expect(F.parseFindingLines(null).items).toEqual([]);
  });
  it('counts per severity from the lines', () => {
    const r = F.parseFindingLines(['FINDING H1 H fix-round - @ - | a', 'FINDING L1 L defer - @ - | b', 'FINDING L2 L defer - @ - | c'].join('\n'));
    expect(r.counts).toEqual({ H: 1, M: 0, L: 2 });
  });
});

describe('parseFindingLines: a malformed line is still an item, without a file, that can only be rejected', () => {
  const bad: [string, RegExp][] = [
    ['FINDING M1 H fix-round - @ src/a.js:1 | code letter differs from severity', /code/],
    ['FINDING X1 X fix-round - @ src/a.js:1 | no such severity', /severity/],
    ['FINDING H1 H defer - @ src/a.js:1 | HIGH must be fix-round', /mark/],
    ['FINDING L1 L mechanical - @ src/a.js:1 | mechanical is only for MEDIUM', /mark/],
    ['FINDING M1 M defer - @ src/a.js:1 | defer is only for LOW', /mark/],
    ['FINDING M1 M mechanical - src/a.js:1 | no @', /@/],
    ['FINDING M1 M mechanical - @ src/a.js:1 no bar', /\|/],
    ['FINDING M1 M mechanical - @ src/a.js:1 |', /sentence/],
    ['FINDING M1 | too short', /fields/],
  ];
  it.each(bad)('%s', (line, why) => {
    const x = one(line);
    expect(x.invalid).toMatch(why);
    expect(x.file).toBeNull();
    expect(x.class).toBe('other');
    expect(x.code).toMatch(/^X\d+$/);
    expect(x.text.length).toBeGreaterThan(0);
  });
  it('a path outside the repo or with shell characters gives no file, but the finding is kept as valid', () => {
    for (const p of ['../x.ts:1', '/etc/passwd', 'C:/x.ts', 'a;rm.ts:2']) {
      const x = one(`FINDING M1 M mechanical - @ ${p} | y`);
      expect(x.file).toBeNull();
      expect(x.invalid).toBeUndefined();
      expect(x.place_error).toBeTruthy();
    }
  });
  it('a code used twice in one report: the second is malformed', () => {
    const r = F.parseFindingLines('FINDING L1 L defer - @ - | a\nFINDING L1 L defer - @ - | b');
    expect(r.items[0].code).toBe('L1');
    expect(r.items[1].invalid).toMatch(/twice/);
  });
});

describe('parseFindingLines: the text is data', () => {
  it('the sentence is one line of at most 200 characters', () => {
    const x = one(`FINDING L1 L defer - @ - | ${'word '.repeat(100)}`);
    expect(x.text.length).toBeLessThanOrEqual(200);
  });
  it('a key in the sentence is masked, never stored', () => {
    // Built from parts, so this file holds no key a scanner would flag.
    const key = ['gh', 'p_', 'A1b2C3d4'.repeat(5)].join('');
    const x = one(`FINDING H1 H fix-round secret-leak @ src/c.ts:9 | the token ${key} is committed`);
    expect(x.text).not.toContain(key);
    expect(x.text).toContain('[secret:github-token]');
    expect(x.text).toContain('is committed');
  });
  it('more than 20 lines: 20 items and one summary item for the rest', () => {
    const text = Array.from({ length: 23 }, (_, i) => `FINDING L${i + 1} L defer - @ - | n${i}`).join('\n');
    const r = F.parseFindingLines(text);
    expect(r.lines).toBe(23);
    expect(r.items).toHaveLength(21);
    expect(r.items[20].invalid).toBe('over the cap');
    expect(r.items[20].text).toMatch(/^3 finding/);
    expect(r.counts.L).toBe(23);
  });
});

describe('findingsOf: the counts line and the fallback', () => {
  it('counts over 0 and no FINDING lines give one summary item, so the counts never pass alone', () => {
    const r = F.findingsOf('FINDINGS H=0 M=2 L=3\nsome prose', { counts: { H: 0, M: 2, L: 3 } });
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ file: null, invalid: 'no lines' });
    expect(r.items[0].text).toContain('M=2 L=3');
  });
  it('zero counts and no lines: nothing', () => {
    expect(F.findingsOf('FINDINGS H=0 M=0 L=0', { counts: { H: 0, M: 0, L: 0 } }).items).toEqual([]);
  });
  it('counts that differ from the lines: the lines count and it is noted', () => {
    const r = F.findingsOf('FINDING L1 L defer - @ - | a', { counts: { H: 0, M: 1, L: 0 } });
    expect(r.counts).toEqual({ H: 0, M: 0, L: 1 });
    expect(r.note).toMatch(/differ/);
    expect(r.deferrable).toEqual(['L1']);
  });
});

describe('parseGateLine: the old and the new GATE line', () => {
  it('the old free-text line: the text is the title, the class other', () => {
    expect(F.parseGateLine('GATE a fetch result unchecked @ src/api.js:42')).toEqual({
      title: 'a fetch result unchecked',
      where: 'src/api.js:42',
      class: 'other',
      text: null,
      form: 'old',
    });
    expect(F.parseGateLine('- `GATE: unescaped value`')).toMatchObject({ title: 'unescaped value', where: null });
  });
  it('the new line: a class id, the place and the sentence', () => {
    expect(F.parseGateLine('GATE unchecked-error @ src/api.js:42 | the fetch result is used without its error')).toEqual({
      title: 'unchecked error or result',
      where: 'src/api.js:42',
      class: 'unchecked-error',
      text: 'the fetch result is used without its error',
      form: 'new',
    });
  });
  it('free text with the new tail: the text is the title, the class other', () => {
    expect(F.parseGateLine('GATE a missing retry @ src/a.js | the call gives up at once')).toMatchObject({
      title: 'a missing retry',
      class: 'other',
      text: 'the call gives up at once',
      where: 'src/a.js',
    });
  });
  it('none, a heading and lower case are no line', () => {
    expect(F.parseGateLine('GATE none')).toBeNull();
    expect(F.parseGateLine('Gate: a heading')).toBeNull();
    expect(F.parseGateLine(null)).toBeNull();
  });
  it('the sentence is masked', () => {
    const key = ['gh', 'p_', 'Z9y8X7w6'.repeat(5)].join('');
    expect(F.parseGateLine(`GATE secret-leak @ a.js:1 | key ${key} in a test`).text).not.toContain(key);
  });
});
