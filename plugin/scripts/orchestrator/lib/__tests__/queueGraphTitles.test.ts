// =============================================================
// queueGraphTitles.test.ts: the Dependencies view reads title first (deps track, review findings H1 and M1).
//
// What the tests prove (lib/queueGraph.js, pure):
//   - clampLabel cuts a title to at most two lines of about 24 characters, at word boundaries where it can, with an
//     ellipsis when text was left out, and never returns a line over the limit,
//   - buildGraph gives every core task and every question a label (the title lines), and none to neighbors, done
//     predecessors and standalone tasks (they keep the id on hover),
//   - layer reserves the label block below each labelled node, so no label box overlaps another label box or a node,
//     also in a fan-in where a question and a task share a column (the Q-VAT over SYNC-4 case of the review),
//   - a graph without labels (Plans' own Dependencies view) is laid out exactly as before.
// =============================================================
import { describe, it, expect } from 'vitest';

type Node = {
  id: string;
  art: 'task' | 'question';
  role: string;
  r: number;
  x: number;
  y: number;
  label?: string[];
};
/* eslint-disable @typescript-eslint/no-require-imports */
const G = require('../queueGraph.js') as {
  MEASURE: Record<string, number>;
  clampLabel: (text: string, option?: { chars?: number; lines?: number }) => string[];
  labelBox: (n: Node) => { left: number; right: number; top: number; bottom: number } | null;
  buildGraph: (data: unknown, option?: Record<string, unknown>) => { nodes: Node[]; edges: unknown[] };
  layer: (g: unknown, option?: Record<string, unknown>) => { nodes: Node[]; width: number; height: number };
};
/* eslint-enable @typescript-eslint/no-require-imports */

describe('clampLabel', () => {
  it('a short title is one line, unchanged', () => {
    expect(G.clampLabel('Streak calendar')).toEqual(['Streak calendar']);
  });

  it('a longer title wraps at a word boundary onto a second line', () => {
    expect(G.clampLabel('Empty states on all screens')).toEqual(['Empty states on all', 'screens']);
  });

  it('a title longer than two lines ends in an ellipsis, and every line stays within the limit', () => {
    const lines = G.clampLabel('Accessible labels on every icon button in the settings and the panel');
    expect(lines).toHaveLength(2);
    expect(lines[1].endsWith('…')).toBe(true);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(24);
  });

  it('one very long word is cut hard, never over the limit', () => {
    const lines = G.clampLabel('Supercalifragilisticexpialidocious-and-more-of-it-here');
    expect(lines).toHaveLength(2);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(24);
    expect(lines[1].endsWith('…')).toBe(true);
  });

  it('whitespace is collapsed and an empty title gives no lines', () => {
    expect(G.clampLabel('  Sign   in\nwith Apple ')).toEqual(['Sign in with Apple']);
    expect(G.clampLabel('')).toEqual([]);
  });

  it('no trailing period or comma before the ellipsis', () => {
    const lines = G.clampLabel('Decide how sync conflicts are shown, and what the user sees.');
    expect(lines[1]).not.toMatch(/[.,;:]…$/);
  });
});

/** A demo-like queue: a chain of five, a fan-in with a question and a task in the same column. */
function data() {
  const card = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
    id,
    title,
    project: 'a',
    status: 'waiting',
    estimate: 40,
    ready: false,
    depends_on: [],
    ...extra,
  });
  return {
    columns: {
      queue: [
        card('AUTH-4', 'Sign in with Apple'),
        card('UI-2', 'Streak calendar', { depends_on: ['AUTH-4'] }),
        card('UI-4', 'Empty states on all screens', { depends_on: ['UI-2'], estimate: 10 }),
        card('UI-6', 'Accessible labels on icon buttons', { depends_on: ['UI-4'], estimate: 10 }),
        card('BILL-2', 'Receipt validation on the server', { ready: true }),
        card('BILL-5', 'Refund flow', { depends_on: ['BILL-2'], estimate: 10 }),
        card('SYNC-4', 'Conflict screen', { estimate: 10 }),
        card('BILL-4', 'Family sharing for subscriptions', { depends_on: ['BILL-5', 'SYNC-4'] }),
        card('ALONE', 'Standalone task', { ready: true }),
      ],
      batch: [],
      blocked: [],
      inProgress: [],
      review: [],
      built: [card('OLD', 'Finished thing', { status: 'done' })],
    },
    inbox: {
      question: [
        { type: 'question', sp: 'Q-SSO', text: 'Which SSO providers do we support at launch?', direct: ['AUTH-4'], count: 4 },
        { type: 'question', sp: 'Q-VAT', text: 'Do we charge VAT on family plans?', direct: ['BILL-4'], count: 1 },
        { type: 'owner-task', sp: 'Q-CONFLICT', text: 'Decide how sync conflicts are shown.', direct: ['SYNC-4'], count: 2 },
      ],
    },
    projects: [{ pid: 'a', title: 'Project a', color: 'category-teal' }],
  };
}

describe('buildGraph: labels for what is read first', () => {
  const g = G.buildGraph(data(), { showStandalone: true, showDone: true });
  const n = (id: string) => g.nodes.find((x) => x.id === id) as Node;

  it('every core task has its title as the label lines', () => {
    expect(n('UI-2').label).toEqual(['Streak calendar']);
    expect(n('UI-4').label).toEqual(['Empty states on all', 'screens']);
    for (const x of g.nodes.filter((x) => x.art === 'task' && x.role === 'core')) expect(x.label?.length).toBeGreaterThan(0);
  });

  it('a question has its question text as the label', () => {
    expect(n('?Q-VAT').label).toEqual(['Do we charge VAT on', 'family plans?']);
  });

  it('standalone tasks keep the old rule (no label block)', () => {
    expect(n('ALONE').role).toBe('free');
    expect(n('ALONE').label).toBeUndefined();
  });
});

describe('layer: label space is reserved', () => {
  const o = G.layer(G.buildGraph(data()), { surface: { width: 1400, height: 700 } });
  const labelled = o.nodes.filter((x) => x.label);
  const box = (x: Node) => G.labelBox(x)!;
  const circle = (x: Node) => ({ left: x.x - x.r - 5, right: x.x + x.r + 5, top: x.y - x.r - 5, bottom: x.y + x.r + 5 });
  const hit = (a: { left: number; right: number; top: number; bottom: number }, b: typeof a) =>
    a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

  it('labelBox is below the node, as wide as the label column, one line per title line plus the id line', () => {
    const x = labelled.find((n) => n.id === 'UI-4')!;
    const b = box(x);
    expect(b.top).toBeGreaterThan(x.y + x.r);
    expect(b.bottom - b.top).toBeGreaterThanOrEqual(3 * G.MEASURE.labelLine);
    expect(b.right - b.left).toBe(G.MEASURE.labelWidth);
  });

  it('no label box overlaps another label box', () => {
    for (const a of labelled)
      for (const b of labelled) if (a !== b) expect(hit(box(a), box(b)), `${a.id} / ${b.id}`).toBe(false);
  });

  it('no label box overlaps a node (the question in a fan-in column included)', () => {
    for (const a of labelled)
      for (const b of o.nodes) if (a !== b) expect(hit(box(a), circle(b)), `${a.id} over ${b.id}`).toBe(false);
  });

  it('every label box sits inside the graph', () => {
    for (const a of labelled) {
      const b = box(a);
      expect(b.left).toBeGreaterThanOrEqual(0);
      expect(b.right).toBeLessThanOrEqual(o.width);
      expect(b.bottom).toBeLessThanOrEqual(o.height);
    }
  });
});

describe('a graph without labels keeps the old layout (Plans)', () => {
  it('positions follow the old measures: layer distance and frame margin', () => {
    const nodes = [
      { id: 'P1', art: 'task', role: 'core', r: 10 },
      { id: 'P2', art: 'task', role: 'core', r: 10 },
    ];
    const o = G.layer({ nodes, edges: [{ from: 'P1', to: 'P2' }], projects: [] });
    const [a, b] = o.nodes;
    expect(b.x - a.x).toBe(G.MEASURE.makeDistance);
    expect(a.x).toBe(G.MEASURE.margin + G.MEASURE.compactPage);
    expect(G.labelBox(a)).toBeNull();
  });
});
