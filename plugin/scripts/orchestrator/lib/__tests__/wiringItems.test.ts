// =============================================================
// wiringItems.test.ts: the rules for the wiring spec's open items (lib/wiringItems.js). The real commands are in
// __tests__/wiringFlow.test.ts.
// =============================================================
import { describe, expect, it } from 'vitest';

/* eslint-disable-next-line @typescript-eslint/no-require-imports */
const W = require('../wiringItems.js');

const NOW = '2026-11-13T10:00:00.000Z';

describe('parseWiring', () => {
  it('reads WIRE lines, also as list items or in backticks, and keeps backticks inside the text', () => {
    const r = W.parseWiring(
      ['# Report', 'WIRE src/a.ts | after `import x` add `import A`', '- `WIRE src\\b.ts | register B`', '* WIRE ./c.json | key "c"'].join('\n'),
    );
    expect(r.items).toEqual([
      { file: 'src/a.ts', text: 'after `import x` add `import A`' },
      { file: 'src/b.ts', text: 'register B' },
      { file: 'c.json', text: 'key "c"' },
    ]);
  });
  it('prose, a heading, lower case and "none" are no item', () => {
    expect(W.parseWiring('Wiring: none\nwire src/a.ts | x\nThe WIRE line below\nWIRE none\nWIRE -').items).toEqual([]);
    expect(W.parseWiring(null).items).toEqual([]);
  });
  it('a line that is not file | text still becomes an item, without a file, so it is not lost', () => {
    const r = W.parseWiring(['WIRE src/a.ts add it', 'WIRE src/a.ts |', 'WIRE ../x.ts | y', 'WIRE /etc/x | y', 'WIRE C:/x | y', 'WIRE a;rm -rf b | y'].join('\n'));
    expect(r.items).toHaveLength(6);
    for (const x of r.items) {
      expect(x.file).toBeNull();
      expect(x.invalid).toBeTruthy();
    }
  });
  it('the text is one printable line with a cap, and the count is capped with one item that says so', () => {
    const long = W.parseWiring(`WIRE a.ts | ${'x'.repeat(500)}\u0007`);
    expect(long.items[0].text.length).toBe(W.MAX_TEXT);
    const many = Array.from({ length: W.MAX_ITEMS + 3 }, (_, i) => `WIRE f${i}.ts | add ${i}`).join('\n');
    const r = W.parseWiring(many);
    expect(r.items).toHaveLength(W.MAX_ITEMS + 1);
    expect(r.items.at(-1)).toMatchObject({ file: null, invalid: 'over the cap' });
    expect(r.items.at(-1).text).toMatch(/^3 more WIRE line/);
  });
});

describe('mergeItems', () => {
  it('numbers new items, adds nothing twice and never drops one', () => {
    const first = W.mergeItems([], W.parseWiring('WIRE a.ts | one\nWIRE b.ts | two').items, { now: NOW });
    expect(first.items.map((x: { id: string }) => x.id)).toEqual(['W1', 'W2']);
    expect(first.items[0]).toMatchObject({ status: 'open', added: NOW, source: 'report' });
    const closed = first.items.map((x: object, i: number) => (i === 0 ? { ...x, status: 'done' } : x));
    const again = W.mergeItems(closed, W.parseWiring('WIRE A.ts | One\nWIRE c.ts | three').items, { now: NOW });
    expect(again.added.map((x: { id: string }) => x.id)).toEqual(['W3']);
    expect(again.items.map((x: { id: string; status: string }) => `${x.id}:${x.status}`)).toEqual(['W1:done', 'W2:open', 'W3:open']);
  });
});

describe('done, closing and the setting', () => {
  const task = () => ({
    id: 'T',
    wiring: W.mergeItems([], W.parseWiring('WIRE a.ts | one\nWIRE ../b | two').items, { now: NOW }).items,
  });
  it('refusalLines names each open item with the commands, and null when none is open', () => {
    const lines = W.refusalLines(task(), { cli: 'rs', base: 'main' });
    expect(lines[0]).toContain('NOT DONE: T has 2 open wiring item(s)');
    expect(lines[1]).toContain('rs wiring T W1 --commit <sha>');
    expect(lines[2]).not.toContain('--commit');
    expect(lines[2]).toContain('rs wiring T W2 --reject "<reason>"');
    expect(W.refusalLines({ id: 'T' })).toBeNull();
  });
  it('commitError: no sha, not found, not in base, not touching, and fine', () => {
    const x = task().wiring[0];
    expect(W.commitError(x, { sha: '--exec=x', full: null, inBase: false, touched: [] })).toMatch(/needs a commit sha/);
    expect(W.commitError(x, { sha: 'abcd1234', full: null, inBase: false, touched: [] })).toMatch(/no commit/);
    expect(W.commitError(x, { sha: 'abcd1234', full: 'a'.repeat(40), inBase: false, touched: ['a.ts'], base: 'main' })).toMatch(/not in main/);
    expect(W.commitError(x, { sha: 'abcd1234', full: 'a'.repeat(40), inBase: true, touched: ['b.ts'] })).toMatch(/does not change a.ts/);
    expect(W.commitError(x, { sha: 'abcd1234', full: 'a'.repeat(40), inBase: true, touched: ['A.ts'] })).toBeNull();
    expect(W.commitError(task().wiring[1], { sha: 'abcd', full: 'a'.repeat(40), inBase: true, touched: [] })).toMatch(/no valid target file/);
  });
  it('closeItem keeps the commit or the reason with the time, and refuses an empty reason or a closed item', () => {
    const o = task();
    expect(W.closeItem(o, 'w1', { commit: 'f'.repeat(40), now: NOW, by: 'me' }).item).toMatchObject({ status: 'done', closed: NOW, by: 'me' });
    expect(W.closeItem(o, 'W1', { reason: 'x', now: NOW }).error).toMatch(/already done/);
    expect(W.closeItem(o, 'W2', { reason: '  ', now: NOW }).error).toMatch(/needs a reason/);
    expect(W.closeItem(o, 'W2', { reason: 'not needed', now: NOW }).item).toMatchObject({ status: 'rejected', reason: 'not needed' });
    expect(W.closeItem(o, 'W9', { reason: 'x', now: NOW }).error).toMatch(/no wiring item W9/);
    expect(W.openItems(o)).toEqual([]);
  });
  it('the stop is on unless wiring.stop is false; off gives a line that names the items', () => {
    expect(W.stopOn({})).toBe(true);
    expect(W.stopOn({ wiring: { stop: true } })).toBe(true);
    expect(W.stopOn({ wiring: { stop: false } })).toBe(false);
    expect(W.offLine(task())).toMatch(/^WIRING STOP OFF .*W1 a\.ts, W2 \(no file\)/);
  });
  it('openState and summaryLine across the queue leave out cancelled tasks', () => {
    const tasks = [task(), { ...task(), id: 'C', status: 'cancelled' }];
    expect(W.openState(tasks).map((x: { task: string; item: string }) => `${x.task}.${x.item}`)).toEqual(['T.W1', 'T.W2']);
    expect(W.summaryLine(tasks, 'rs')).toMatch(/^OPEN WIRING \(2\): T W1 a\.ts, T W2 \(no file\)\. Done waits for them: rs wiring T\.$/);
    expect(W.summaryLine([])).toBeNull();
  });
});
