// =============================================================
// queueBoardPlanDecision.test.ts: the board side of PG-1/PG-3 (plans/plan-gate-vurdering-2026-11-21.md): the plan's
// detail panel shows "Decision: missing / incomplete / skipped / done" for a plan that expects a decision section.
//
// What the tests prove:
//   - planDecisionReader reads the decision source through the /api/doc guard, cached per file by time and size,
//   - a small plan gets null (nothing shown) and reads nothing,
//   - plansData passes the state through only when the server gives a reader (decision: null otherwise).
// =============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const T = require('../queueBoard.js') as any;
const V = require('../queuePlanView.js') as any;
const P = require('../queuePlan.js') as any;
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

const HEADINGS = [
  'Need and evidence',
  'Success measure',
  'Non-goals',
  'Alternatives',
  'Cost',
  'Stop criteria',
  'Strongest case against',
  'Cheapest test',
];

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-decision-'));
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'docs', 'plan.md'),
    ['# Export', '## 9. Decision', ...HEADINGS.flatMap((h) => [`### ${h}`, 'text'])].join('\n'),
  );
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function countingFs() {
  const counter = { reads: 0 };
  const io = {
    fs: {
      ...fs,
      readFileSync: (...a: unknown[]) => {
        counter.reads += 1;
        return (fs.readFileSync as any)(...a);
      },
    },
    path,
  };
  return { io, counter };
}

const large = (extra = {}) => ({
  id: 'PL-EX-1',
  size: 'L',
  sources: [{ path: 'docs/plan.md', anchor: '§ 9', role: 'decision' }],
  ...extra,
});

describe('planDecisionReader', () => {
  it('a large plan with the full section is done, and the file is read once while it is unchanged', () => {
    const { io, counter } = countingFs();
    const read = T.planDecisionReader(root, io);
    expect(read(large(), []).state).toBe('done');
    expect(read(large(), []).state).toBe('done');
    expect(counter.reads).toBe(1);
  });

  it('a section that lacks headings is incomplete; a missing source is missing; a skip is skipped', () => {
    fs.writeFileSync(path.join(root, 'docs', 'plan.md'), '# Export\n## 9. Decision\n### Cost\ntext\n');
    const { io } = countingFs();
    const read = T.planDecisionReader(root, io);
    const r = read(large(), []);
    expect(r.state).toBe('incomplete');
    expect(r.missing).toContain('Stop criteria');
    expect(read(large({ sources: [] }), []).state).toBe('missing');
    expect(read(large({ sources: [], decision_skip: { reason: 'r', at: 'x', by: 'owner' } }), []).state).toBe('skipped');
  });

  it('a small plan gives null and reads nothing; decisionNote off gives null', () => {
    const { io, counter } = countingFs();
    expect(T.planDecisionReader(root, io)(large({ size: 'S' }), [])).toBeNull();
    expect(counter.reads).toBe(0);
    expect(T.planDecisionReader(root, io, { on: false })(large(), [])).toBeNull();
  });

  it('a path outside the document folders cannot be read: missing with a note, never an error', () => {
    const { io } = countingFs();
    const r = T.planDecisionReader(root, io)(large({ sources: [{ path: '../x.md', role: 'decision' }] }), []);
    expect(r.state).toBe('missing');
  });
});

describe('plansData carries the decision state', () => {
  const projects = { p: { title: 'P', area: 'a' } };
  const reg = () => {
    const r = P.emptyRegister('2026-11-21T08:00:00.000Z');
    P.newEntry(
      r,
      { id: 'PL-EX-1', title: 'Export', project: 'p', priority: 'later', maturity: 'planned', size: 'L' },
      { role: 'owner', projects, question: {} },
    );
    return r;
  };
  const queue = { tasks: [], projects, areas: { a: { title: 'A' } }, question: {}, resolved: [] };

  it('with a reader: the state; without: null', () => {
    const withReader = V.plansData(reg(), queue, { decisionFor: () => ({ state: 'missing', why: 'size L' }) });
    expect(withReader.entries[0].decision).toEqual({ state: 'missing', why: 'size L' });
    expect(V.plansData(reg(), queue, {}).entries[0].decision).toBeNull();
  });

  it('the detail text', () => {
    expect(V.decisionText(null)).toBeNull();
    expect(V.decisionText({ state: 'done' })).toBe('Done');
    expect(V.decisionText({ state: 'skipped', reason: 'tiny' })).toBe('Skipped: tiny');
    expect(V.decisionText({ state: 'incomplete', missing: ['Cost', 'Cheapest test'] })).toBe(
      'Incomplete: missing Cost, Cheapest test',
    );
    expect(V.decisionText({ state: 'missing', why: 'size L' })).toMatch(/^Missing \(size L\)/);
  });
});
