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

describe('listText', () => {
  it('joins with commas and "and", and cuts long lists', () => {
    expect(G.listText(['A'])).toBe('A');
    expect(G.listText(['A', 'B'])).toBe('A and B');
    expect(G.listText(['A', 'B', 'C'])).toBe('A, B and C');
    expect(G.listText(['A', 'B', 'C', 'D', 'E', 'F'], 4)).toBe('A, B, C and 3 more');
  });
});
