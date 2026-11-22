// =============================================================
// queueGraphLead.test.ts: the Dependencies view answers in words (deps track, review findings H3 step 1 and M2).
//
// What the tests prove (lib/queueGraph.js, pure):
//   - graphLead names things instead of counting them: the question whose answer unlocks the most (by its text) and
//     the longest chain (queueGraph.criticalPath over the open tasks, estimate as weight, as Plans does) by title,
//     with the counts after it as a separate, muted part; the critical chain's edges are returned for drawing,
//   - with no question the lead names only the chain; an empty graph has no lead,
//   - nodeWords gives each task an accessible name with the title first, then the id and the state, then what it
//     waits on and what it unlocks (by title; a question by its text), and the same facts as tooltip lines,
//   - long lists are cut ("A, B, C and 2 more").
// =============================================================
import { describe, it, expect } from 'vitest';

type Node = { id: string; art: string; role: string; title: string; label?: string[] };
type Setup = { nodes: Node[]; edges: { from: string; to: string }[] };
/* eslint-disable @typescript-eslint/no-require-imports */
const G = require('../queueGraph.js') as {
  buildGraph: (data: unknown, option?: Record<string, unknown>) => Setup;
  layer: (g: unknown, option?: Record<string, unknown>) => Setup;
  graphNumber: (g: unknown) => Record<string, number>;
  graphLead: (
    o: Setup,
    counts: Record<string, number>,
  ) => { lead: string | null; counts: string; critical: { path: string[]; edges: string[] } };
  nodeWords: (n: Node, o: Setup) => { name: string; lines: string[] };
  listText: (names: string[], max?: number) => string;
  chainText: (id: string, chain: { before?: string[]; after?: string[] }, o: Setup) => string;
};
/* eslint-enable @typescript-eslint/no-require-imports */

function data(withQuestions = true) {
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
        card('AUTH-4', 'Sign in with Apple', { unlocks: { count: 3 } }),
        card('UI-2', 'Streak calendar', { depends_on: ['AUTH-4'], unlocks: { count: 2 } }),
        card('UI-4', 'Empty states on all screens', { depends_on: ['UI-2'], estimate: 10, unlocks: { count: 1 } }),
        card('UI-6', 'Accessible labels on icon buttons', { depends_on: ['UI-4'], estimate: 10 }),
        card('BILL-5', 'Refund flow', { estimate: 10, ready: true, unlocks: { count: 1 } }),
        card('SYNC-4', 'Conflict screen', { estimate: 10, unlocks: { count: 1 } }),
        card('BILL-4', 'Family sharing', { depends_on: ['BILL-5', 'SYNC-4'] }),
      ],
      batch: [],
      blocked: [],
      inProgress: [],
      review: [],
      built: [],
    },
    inbox: {
      question: withQuestions
        ? [
            { type: 'question', sp: 'Q-SSO', text: 'Which SSO providers do we support at launch?', direct: ['AUTH-4'], count: 4 },
            { type: 'question', sp: 'Q-VAT', text: 'Do we charge VAT on family plans?', direct: ['BILL-4'], count: 1 },
          ]
        : [],
    },
    projects: [{ pid: 'a', title: 'Project a', color: 'category-teal' }],
  };
}
const setup = (withQuestions = true) => {
  const g = G.buildGraph(data(withQuestions));
  return { o: G.layer(g), counts: G.graphNumber(g) };
};
const byId = (o: Setup, id: string) => o.nodes.find((n) => n.id === id) as Node;

describe('graphLead: a sentence that names things', () => {
  it('names the question that unlocks the most by its text, and the longest chain by title', () => {
    const { o, counts } = setup();
    const r = G.graphLead(o, counts);
    expect(r.lead).toBe(
      'Answering "Which SSO providers do we support at launch?" unlocks the most: 4 tasks. ' +
        'Longest chain: Sign in with Apple, Streak calendar, Empty states on all screens and Accessible labels on icon buttons.',
    );
  });

  it('the critical chain comes from queueGraph.criticalPath, with its edges for drawing', () => {
    const { o, counts } = setup();
    const r = G.graphLead(o, counts);
    expect(r.critical.path).toEqual(['AUTH-4', 'UI-2', 'UI-4', 'UI-6']);
    expect(r.critical.edges).toContain('AUTH-4>UI-2');
  });

  it('the counts follow as their own part, never first', () => {
    const { o, counts } = setup();
    const r = G.graphLead(o, counts);
    expect(r.counts).toBe('7 tasks in chains · 2 owner questions hold back 5 tasks');
    expect(r.lead?.startsWith(r.counts)).toBe(false);
  });

  it('one question only: "unlocks N tasks", without "the most"', () => {
    const g = G.buildGraph({ ...data(), inbox: { question: [data().inbox.question[1]] } });
    const r = G.graphLead(G.layer(g), G.graphNumber(g));
    expect(r.lead).toMatch(/^Answering "Do we charge VAT on family plans\?" unlocks 1 task\. Longest chain: /);
  });

  it('no question: the lead names only the chain', () => {
    const { o, counts } = setup(false);
    expect(G.graphLead(o, counts).lead).toMatch(/^Longest chain: Sign in with Apple, /);
  });

  it('an empty graph has no lead and no counts', () => {
    const g = G.buildGraph(data(), { visible: () => false });
    const r = G.graphLead(G.layer(g), G.graphNumber(g));
    expect(r.lead).toBeNull();
    expect(r.counts).toBe('');
  });
});

describe('nodeWords: what it is, what it waits on and what it unlocks', () => {
  it('a task in the middle of a chain: title, id, state, waits on, unlocks (with the total)', () => {
    const { o } = setup();
    expect(G.nodeWords(byId(o, 'UI-2'), o).name).toBe(
      'Streak calendar, UI-2, blocked, waits on Sign in with Apple, unlocks Empty states on all screens (2 tasks in all)',
    );
  });

  it('a fan-in names every predecessor, a question by its text', () => {
    const { o } = setup();
    expect(G.nodeWords(byId(o, 'BILL-4'), o).name).toBe(
      'Family sharing, BILL-4, blocked, waits on Refund flow, Conflict screen and the question "Do we charge VAT on family plans?"',
    );
  });

  it('a task that only waits on a question, and one that waits on nothing', () => {
    const { o } = setup();
    expect(G.nodeWords(byId(o, 'AUTH-4'), o).name).toMatch(
      /^Sign in with Apple, AUTH-4, blocked, waits on the question "Which SSO providers do we support at launch\?", unlocks Streak calendar \(3 tasks in all\)$/,
    );
    expect(G.nodeWords(byId(o, 'BILL-5'), o).name).toBe('Refund flow, BILL-5, ready now, unlocks Family sharing');
  });

  it('the tooltip lines carry the same facts, title first', () => {
    const { o } = setup();
    expect(G.nodeWords(byId(o, 'UI-2'), o).lines).toEqual([
      'Streak calendar',
      'UI-2',
      'blocked',
      'Waits on Sign in with Apple',
      'Unlocks Empty states on all screens (2 tasks in all)',
    ]);
  });
});

describe('nodeWords for a question: its text first, no double period (deps L3)', () => {
  it('the text, the id, the kind, and what answering it unlocks by title', () => {
    const { o } = setup();
    expect(G.nodeWords(byId(o, '?Q-SSO'), o).name).toBe(
      'Which SSO providers do we support at launch?, Q-SSO, owner question, unlocks Sign in with Apple (4 tasks in all)',
    );
    expect(G.nodeWords(byId(o, '?Q-SSO'), o).lines).toEqual([
      'Which SSO providers do we support at launch?',
      'Q-SSO',
      'owner question',
      'Unlocks Sign in with Apple (4 tasks in all)',
    ]);
  });

  it('a text that ends in a period loses it, so the name never says ".."; the kind is in plain words', () => {
    const g = G.buildGraph({
      ...data(),
      inbox: {
        question: [
          { type: 'owner-task', sp: 'Q-OWN', text: 'Decide how conflicts are shown.', direct: ['BILL-4'], count: 1 },
        ],
      },
    });
    const o = G.layer(g);
    const w = G.nodeWords(byId(o, '?Q-OWN'), o);
    expect(w.name).toBe('Decide how conflicts are shown, Q-OWN, owner task, unlocks Family sharing');
    expect(w.name).not.toMatch(/\.\./);
  });
});

describe('chainText: the selection line names the task by title (deps M5)', () => {
  it('title first, the id in brackets, then how many are before and after it', () => {
    const { o } = setup();
    expect(G.chainText('UI-2', { before: ['AUTH-4'], after: ['UI-4', 'UI-6'] }, o)).toBe(
      'Showing the chain of Streak calendar (UI-2): 1 task before it, 2 after it',
    );
  });

  it('says "nothing" on the side that is empty, and falls back to the id when the task is not drawn', () => {
    const { o } = setup();
    expect(G.chainText('AUTH-4', { before: [], after: ['UI-2'] }, o)).toBe(
      'Showing the chain of Sign in with Apple (AUTH-4): nothing before it, 1 task after it',
    );
    expect(G.chainText('GONE-1', { before: ['A'], after: [] }, o)).toBe(
      'Showing the chain of GONE-1: 1 task before it, nothing after it',
    );
  });
});

describe('the side panel never covers the selected chain (deps M5)', () => {
  type Box = { left: number; right: number; top: number; bottom: number };
  type View = { s: number; x: number; y: number };
  const H = G as unknown as {
    chainBox: (o: Setup, ids: Iterable<string>) => Box | null;
    panInto: (box: Box, view: View, area: Box, opt?: { pad?: number; minScale?: number; focus?: { x: number; y: number } }) => View | null;
  };
  const screen = (b: Box, v: View) => ({
    left: v.x + b.left * v.s,
    right: v.x + b.right * v.s,
    top: v.y + b.top * v.s,
    bottom: v.y + b.bottom * v.s,
  });

  it('chainBox covers the circles and the title labels of the chain only', () => {
    const { o } = setup();
    const b = H.chainBox(o, ['AUTH-4', 'UI-2'])!;
    const n = byId(o, 'UI-2') as Node & { x: number; y: number; r: number };
    expect(b.right).toBeGreaterThanOrEqual(n.x + n.r);
    // The label below the circle is part of the box.
    expect(b.bottom).toBeGreaterThan(n.y + n.r + 20);
    expect(H.chainBox(o, ['NOT-THERE'])).toBeNull();
  });

  it('a chain already in the free area is left alone', () => {
    const box = { left: 0, right: 100, top: 0, bottom: 50 };
    expect(H.panInto(box, { s: 1, x: 20, y: 20 }, { left: 0, top: 0, right: 800, bottom: 600 })).toBeNull();
  });

  it('a chain under the panel is moved into the free area left of it, at the same zoom when it fits', () => {
    const box = { left: 900, right: 1200, top: 100, bottom: 200 };
    const area = { left: 0, top: 0, right: 800, bottom: 600 };
    const v = H.panInto(box, { s: 1, x: 0, y: 0 }, area)!;
    expect(v.s).toBe(1);
    const sb = screen(box, v);
    expect(sb.left).toBeGreaterThanOrEqual(area.left);
    expect(sb.right).toBeLessThanOrEqual(area.right);
    expect(sb.top).toBeGreaterThanOrEqual(area.top);
    expect(sb.bottom).toBeLessThanOrEqual(area.bottom);
  });

  it('a chain wider than the free area is zoomed out to fit, but never below the zoom where titles show', () => {
    const area = { left: 0, top: 0, right: 800, bottom: 600 };
    const v = H.panInto({ left: 0, right: 1200, top: 0, bottom: 100 }, { s: 1, x: 0, y: 0 }, area)!;
    expect(v.s).toBeLessThan(1);
    expect(screen({ left: 0, right: 1200, top: 0, bottom: 100 }, v).right).toBeLessThanOrEqual(800);
    // Too wide even at 0.5: stays at 0.5 and centres the selected task instead.
    const w = H.panInto({ left: 0, right: 4000, top: 0, bottom: 100 }, { s: 1, x: 0, y: 0 }, area, {
      focus: { x: 3000, y: 50 },
    })!;
    expect(w.s).toBe(0.5);
    expect(w.x + 3000 * w.s).toBeCloseTo(400, 0);
  });

  it('never zooms in to fit', () => {
    const v = H.panInto({ left: 900, right: 950, top: 0, bottom: 20 }, { s: 0.6, x: 0, y: 0 }, { left: 0, top: 0, right: 500, bottom: 400 })!;
    expect(v.s).toBe(0.6);
  });
});

describe('listText', () => {
  it('joins with commas and "and", and cuts long lists', () => {
    expect(G.listText(['A'])).toBe('A');
    expect(G.listText(['A', 'B'])).toBe('A and B');
    expect(G.listText(['A', 'B', 'C'])).toBe('A, B and C');
    expect(G.listText(['A', 'B', 'C', 'D', 'E', 'F'], 4)).toBe('A, B, C and 3 more');
  });
});
