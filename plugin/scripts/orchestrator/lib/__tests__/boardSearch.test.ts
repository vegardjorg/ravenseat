// =============================================================
// boardSearch.test.ts: the structured search in lib/boardSearch.js (roadmap 0ø J6, plans/jira-vurdering-2026-11-18.md
// proposal 6).
//
// Locks: plain words search exactly as before (id, title, feature and project, the words as one phrase); fields
// class, status, project, block, label, plan, age and cost, with :, >, <, >= and <=; -field:value leaves out; values of
// one field are "or" (also a comma list), different fields are "and"; class:D is not D+; status:blocked is an open
// block; age is the time since the card last changed; an unknown field or a bad value is a hint and is left out of the
// match, so it never empties the board; the suggestions for a field name and for a field's values; the block codes match
// the queue's own list.
// =============================================================
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const S = require('../boardSearch.js');
const L = require('../queueLogic.js');

const H = 3_600_000;
const NOW = Date.parse('2026-11-22T07:00:00.000Z');
const ago = (h: number) => new Date(NOW - h * H).toISOString();
const card = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `Task ${id}`,
  feature: 'Sign-in',
  project: 'auth',
  class: 'K',
  status: 'waiting',
  labels: [],
  plan: null,
  block: null,
  cost_usd: null,
  changed_at: ago(1),
  ...extra,
});
const cards = [
  card('EX-1', {
    class: 'D',
    status: 'waiting',
    block: 'gate-red',
    changed_at: ago(72),
    labels: ['visual'],
  }),
  card('EX-2', {
    class: 'D+',
    status: 'running',
    project: 'sync',
    cost_usd: 2.5,
  }),
  card('EX-3', {
    class: 'K',
    status: 'review',
    block: 'merge-conflict',
    changed_at: ago(30),
    cost_usd: 0.4,
  }),
  card('EX-4', {
    class: 'U',
    status: 'done',
    plan: 'PL-AUTH',
    title: 'Billing page',
  }),
];
const hits = (q: string) => {
  const p = S.parse(q.toLowerCase());
  return cards.filter((k) => S.matches(k, p, { now: NOW })).map((k) => k.id);
};

describe('plain words', () => {
  it('search the id, title, feature and project as one phrase, as before', () => {
    expect(hits('ex-2')).toEqual(['EX-2']);
    expect(hits('billing')).toEqual(['EX-4']);
    expect(hits('sign-in')).toHaveLength(4);
    expect(hits('sync')).toEqual(['EX-2']);
    expect(hits('task ex-3')).toEqual(['EX-3']);
    expect(hits('')).toHaveLength(4);
  });
});

describe('fields', () => {
  it('class is exact (D is not D+), and values of one field are or', () => {
    expect(hits('class:d')).toEqual(['EX-1']);
    expect(hits('class:d+')).toEqual(['EX-2']);
    expect(hits('class:d class:k')).toEqual(['EX-1', 'EX-3']);
    expect(hits('class:d,u')).toEqual(['EX-1', 'EX-4']);
  });

  it('status takes the task status, and blocked means an open block', () => {
    expect(hits('status:running')).toEqual(['EX-2']);
    expect(hits('status:blocked')).toEqual(['EX-1', 'EX-3']);
  });

  it('project, block, label and plan', () => {
    expect(hits('project:sync')).toEqual(['EX-2']);
    expect(hits('block:gate-red')).toEqual(['EX-1']);
    expect(hits('label:visual')).toEqual(['EX-1']);
    expect(hits('plan:pl-auth')).toEqual(['EX-4']);
  });

  it("takes the board's own shapes: the Blocked column's block object and open_block", () => {
    const p = S.parse('block:quota');
    const blocked = card('EX-9', { block: { code: 'quota', age: '2 h' } });
    const open = card('EX-8', { open_block: 'quota' });
    expect(S.matches(blocked, p, { now: NOW })).toBe(true);
    expect(S.matches(open, p, { now: NOW })).toBe(true);
    expect(S.matches(open, S.parse('status:blocked'), { now: NOW })).toBe(true);
    expect(S.matches(blocked, S.parse('status:blocked'), { now: NOW })).toBe(true);
  });

  it('status:blocked is what the board calls Blocked: also a waiting card that is not ready (it waits on something)', () => {
    const p = S.parse('status:blocked');
    expect(S.matches(card('EX-7', { status: 'waiting', ready: false }), p, { now: NOW })).toBe(true);
    expect(S.matches(card('EX-6', { status: 'waiting', ready: true }), p, { now: NOW })).toBe(false);
    expect(S.matches(card('EX-5', { status: 'running', ready: false }), p, { now: NOW })).toBe(false);
  });

  it('age is the time since the card last changed, with m, h, d and w', () => {
    expect(hits('age>2d')).toEqual(['EX-1']);
    expect(hits('age>1d')).toEqual(['EX-1', 'EX-3']);
    expect(hits('age<2h')).toEqual(['EX-2', 'EX-4']);
    expect(hits('age>=72h')).toEqual(['EX-1']);
    expect(hits('age<1w')).toHaveLength(4);
  });

  it('cost compares the measured USD; a card without a cost never matches a comparison', () => {
    expect(hits('cost>1')).toEqual(['EX-2']);
    expect(hits('cost<1')).toEqual(['EX-3']);
    expect(hits('cost<=2.5')).toEqual(['EX-2', 'EX-3']);
  });

  it('-field:value leaves out, and fields combine with and, and with plain words', () => {
    expect(hits('-class:k')).toEqual(['EX-1', 'EX-2', 'EX-4']);
    expect(hits('status:blocked age>2d')).toEqual(['EX-1']);
    expect(hits('class:d status:blocked age>1d')).toEqual(['EX-1']);
    expect(hits('status:blocked task ex-3')).toEqual(['EX-3']);
  });
});

describe('hints, never an empty board', () => {
  it('an unknown field is a hint and is left out of the match', () => {
    const p = S.parse('colour:red ex-2');
    expect(p.hints[0]).toContain('colour');
    expect(cards.filter((k) => S.matches(k, p, { now: NOW })).map((k) => k.id)).toEqual(['EX-2']);
  });

  it('a bad age or cost is a hint and is left out', () => {
    expect(S.parse('age>soon').hints[0]).toMatch(/age/);
    expect(hits('age>soon')).toHaveLength(4);
    expect(S.parse('cost>much').hints[0]).toMatch(/cost/);
  });

  it('a field without a value yet is left out without a hint (you are still typing)', () => {
    const p = S.parse('class:');
    expect(p.hints).toEqual([]);
    expect(hits('class:')).toHaveLength(4);
  });

  it('a known field with an unknown class value says which ones exist', () => {
    expect(S.parse('class:x').hints[0]).toContain('K, D, D+, U');
  });

  it('a word with a colon that is not field-like stays plain text (a time, a url)', () => {
    expect(S.parse('10:30').terms).toEqual([]);
    expect(S.parse('10:30').text).toBe('10:30');
  });

  it('isStructured says when a search uses fields', () => {
    expect(S.isStructured('class:d')).toBe(true);
    expect(S.isStructured('streak counter')).toBe(false);
  });
});

describe('suggestions', () => {
  const known = {
    class: ['K', 'D', 'D+', 'U'],
    project: ['auth', 'sync'],
    label: ['visual'],
    plan: ['PL-AUTH'],
  };

  it('a field name being typed suggests the fields that start with it', () => {
    const s = S.suggest('st', 2, known);
    expect(s.items.map((x: any) => x.insert)).toEqual(['status:']);
    expect(s.from).toBe(0);
    expect(s.to).toBe(2);
  });

  it('after field: it suggests the values, filtered by what is typed', () => {
    expect(S.suggest('class:', 6, known).items.map((x: any) => x.insert)).toEqual([
      'class:K',
      'class:D',
      'class:D+',
      'class:U',
    ]);
    expect(S.suggest('class:d', 7, known).items.map((x: any) => x.insert)).toEqual(['class:D', 'class:D+']);
    expect(S.suggest('x status:bl', 11, known).items.map((x: any) => x.insert)).toEqual(['status:blocked']);
    expect(S.suggest('x status:bl', 11, known).from).toBe(2);
    expect(S.suggest('-pro', 4, known).items.map((x: any) => x.insert)).toEqual(['-project:']);
    expect(S.suggest('block:gate', 10, known).items.map((x: any) => x.insert)).toEqual(['block:gate-red']);
  });

  it('age and cost suggest an example, and plain words suggest nothing', () => {
    expect(S.suggest('age', 3, known).items[0].insert).toBe('age>');
    expect(S.suggest('age>', 4, known).items.map((x: any) => x.insert)).toContain('age>1d');
    expect(S.suggest('streak', 6, known).items).toEqual([]);
    expect(S.suggest('', 0, known).items).toEqual([]);
  });

  it('applySuggestion puts the choice in the text and the caret after it', () => {
    const s = S.suggest('x status:bl y', 11, known);
    expect(S.applySuggestion('x status:bl y', s, s.items[0])).toEqual({
      text: 'x status:blocked y',
      caret: 16,
    });
    const f = S.suggest('st', 2, known);
    expect(S.applySuggestion('st', f, f.items[0])).toEqual({
      text: 'status:',
      caret: 7,
    });
  });
});

describe('the block codes', () => {
  it("are the queue's own list", () => {
    expect([...S.BLOCK_CODES].sort()).toEqual(L.BLOCK_CODES.map((b: any) => b.code).sort());
  });
});
