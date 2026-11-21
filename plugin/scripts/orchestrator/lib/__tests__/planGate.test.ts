// The light plan gate (lib/planGate.js, PG-1..PG-3 of plans/plan-gate-vurdering-2026-11-21.md):
//   PG-2  shapeQuestion: one question with three answers when a request with no plan entry splits into more than
//         shape.threshold tasks (default 5) or meets a sensitive zone; nothing below it, nothing when off.
//   PG-1  decisionState: an L/XL or zone plan expects a decision section (a source with role `decision`) with fixed
//         headings; it says missing, incomplete (which headings), skipped (with the reason) or done.
//   PG-3  readyGate: setting such a plan to ready without a complete section gives one WARNING (advisory, the
//         default), refuses the edit (block) or says nothing (off).
import { describe, expect, it } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const G = require('../planGate.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const P = require('../queuePlan.js');

const FULL_NOTE = [
  '# Export plan',
  '',
  '## 9. Decision',
  '',
  '### Need and evidence',
  'Three customers asked.',
  '### Success measure',
  'Half the exports go through the new path.',
  '### Non-goals',
  'No PDF.',
  '### Alternatives',
  'Do not build; buy; smallest version.',
  '### Cost',
  'Seven tracks.',
  '### Stop criteria',
  'If not used by 2027-01-01, stop.',
  '### Strongest case against',
  'Nobody exports.',
  '### Cheapest test',
  'A CSV button.',
  '',
  '## 10. Next',
  'Later.',
].join('\n');

const entry = (extra = {}) => ({
  id: 'PL-EX-1',
  title: 'Export',
  project: 'p',
  priority: 'later',
  priority_set_by: 'owner',
  maturity: 'planned',
  size: 'L',
  ...extra,
});
const withNote = (anchor: string | null = '§ 9') =>
  entry({ sources: [{ path: 'docs/export.md', role: 'decision', ...(anchor ? { anchor } : {}) }] });
const readDoc = (text: string | null) => () => text;

describe('PG-2 shapeQuestion', () => {
  const setup = G.gateSetup({});
  it('the defaults: offer, threshold 5, decision note on, ready check advisory', () => {
    expect(setup).toEqual({ nudge: 'offer', threshold: 5, decisionNote: true, readyCheck: 'advisory' });
  });

  it('a request that splits into 6 tasks with no plan gets the question with three answers, shaping recommended', () => {
    const q = G.shapeQuestion({ tasks: 6 }, setup);
    expect(q).not.toBeNull();
    expect(q.mode).toBe('offer');
    expect(q.choices.map((c: { key: string }) => c.key)).toEqual(['shape', 'smallest', 'all']);
    expect(q.choices[0].recommended).toBe(true);
    expect(q.text).toMatch(/6 tasks/);
  });

  it('3 tasks, or exactly the threshold, get nothing; a plan entry gets nothing', () => {
    expect(G.shapeQuestion({ tasks: 3 }, setup)).toBeNull();
    expect(G.shapeQuestion({ tasks: 5 }, setup)).toBeNull();
    expect(G.shapeQuestion({ tasks: 9, plan: 'PL-EX-1' }, setup)).toBeNull();
  });

  it('a zone hit asks whatever the size', () => {
    const q = G.shapeQuestion({ tasks: 1, zones: ['D-0001'] }, setup);
    expect(q?.text).toMatch(/D-0001/);
  });

  it('off gives nothing at all; always-shape shapes without asking', () => {
    expect(G.shapeQuestion({ tasks: 20 }, G.gateSetup({ shape: { nudge: 'off' } }))).toBeNull();
    const q = G.shapeQuestion({ tasks: 6 }, G.gateSetup({ shape: { nudge: 'always-shape' } }));
    expect(q?.mode).toBe('always-shape');
  });

  it('a wrong value in the config falls back to the default', () => {
    expect(G.gateSetup({ shape: { nudge: 'yes', threshold: -2 }, plans: { readyCheck: 'hard', decisionNote: 'x' } })).toEqual(
      { nudge: 'offer', threshold: 5, decisionNote: true, readyCheck: 'advisory' },
    );
    expect(G.gateSetup({ shape: { threshold: 8 } }).threshold).toBe(8);
  });

  it('the recorded answer on a task: shaped is skipped or smallest, anything else is an error', () => {
    expect(G.shapedErrors({})).toEqual([]);
    expect(G.shapedErrors({ shaped: 'skipped' })).toEqual([]);
    expect(G.shapedErrors({ shaped: 'smallest' })).toEqual([]);
    expect(G.shapedErrors({ shaped: 'maybe' })[0]).toMatch(/shaped must be/);
  });
});

describe('PG-1 decisionState', () => {
  it('an S or M plan without a zone needs no section', () => {
    expect(G.decisionState(entry({ size: 'S' }), { readDoc: readDoc(null) }).state).toBe('not-needed');
    expect(G.decisionState(entry({ size: undefined }), { readDoc: readDoc(null) }).state).toBe('not-needed');
  });

  it('an L plan without a decision source is missing; with a full section it is done', () => {
    const m = G.decisionState(entry(), { readDoc: readDoc(FULL_NOTE) });
    expect(m.state).toBe('missing');
    expect(m.why).toBe('size L');
    const d = G.decisionState(withNote(), { readDoc: readDoc(FULL_NOTE) });
    expect(d.state).toBe('done');
    expect(d.missing).toEqual([]);
  });

  it('a section without some headings is incomplete and names them', () => {
    const text = FULL_NOTE.replace('### Stop criteria\n', '').replace('### Cheapest test\n', '');
    const r = G.decisionState(withNote(), { readDoc: readDoc(text) });
    expect(r.state).toBe('incomplete');
    expect(r.missing).toEqual(['Stop criteria', 'Cheapest test']);
  });

  it('the anchor limits the look-up to the section: headings after it do not count', () => {
    const text = FULL_NOTE.replace('### Cost\nSeven tracks.\n', '') + '\n### Cost\nmoved out';
    expect(G.decisionState(withNote(), { readDoc: readDoc(text) }).missing).toEqual(['Cost']);
    // Without an anchor the whole document counts.
    expect(G.decisionState(withNote(null), { readDoc: readDoc(text) }).state).toBe('done');
  });

  it('bold labels count as headings too', () => {
    const text = FULL_NOTE.replace(/^### (.*)$/gm, '**$1:** text');
    expect(G.decisionState(withNote(), { readDoc: readDoc(text) }).state).toBe('done');
  });

  it('a zone plan of any size also needs the reversibility heading', () => {
    const e = { ...withNote(), size: 'S' };
    const r = G.decisionState(e, { readDoc: readDoc(FULL_NOTE), zones: ['D-0002'] });
    expect(r.why).toBe('zone D-0002');
    expect(r.missing).toEqual(['Reversibility']);
    const ok = FULL_NOTE.replace('## 10. Next', '### Reversibility\nBehind a flag.\n\n## 10. Next');
    expect(G.decisionState(e, { readDoc: readDoc(ok), zones: ['D-0002'] }).state).toBe('done');
  });

  it('a source whose file cannot be read is missing, with a note', () => {
    const r = G.decisionState(withNote(), { readDoc: readDoc(null) });
    expect(r.state).toBe('missing');
    expect(r.note).toMatch(/cannot be read/);
  });

  it('a recorded skip shows as skipped with its reason, unless the section is done', () => {
    const skip = { reason: 'small in practice', at: '2026-11-21T10:00:00Z', by: 'owner' };
    const r = G.decisionState(entry({ decision_skip: skip }), { readDoc: readDoc(null) });
    expect(r.state).toBe('skipped');
    expect(r.reason).toBe('small in practice');
    expect(G.decisionState({ ...withNote(), decision_skip: skip }, { readDoc: readDoc(FULL_NOTE) }).state).toBe('done');
  });

  it('plans.decisionNote off: no section is expected', () => {
    expect(G.decisionState(entry(), { readDoc: readDoc(null), on: false }).state).toBe('not-needed');
  });

  it('the line for plan get', () => {
    expect(G.decisionLine({ state: 'not-needed' })).toBeNull();
    expect(G.decisionLine({ state: 'done' })).toBe('Decision: done');
    expect(G.decisionLine({ state: 'skipped', reason: 'r' })).toBe('Decision: skipped (r)');
    expect(G.decisionLine({ state: 'incomplete', missing: ['Cost'] })).toBe('Decision: incomplete (missing Cost)');
    expect(G.decisionLine({ state: 'missing', why: 'size XL' })).toMatch(/^Decision: missing \(size XL/);
  });
});

describe('PG-3 readyGate', () => {
  const gate = (mode: string, text: string | null = null, zones: string[] = []) =>
    G.readyGate({ mode, on: true, readDoc: readDoc(text), zonesFor: () => zones });

  it('advisory: an L plan set to ready without the section gives one warning naming what is missing', () => {
    const r = gate('advisory')(entry(), { ...entry(), maturity: 'ready' });
    expect(r.error).toBeNull();
    expect(r.warning).toMatch(/PL-EX-1/);
    expect(r.warning).toMatch(/decision section/i);
    expect(r.warning).toMatch(/--skip-decision/);
  });

  it('with the full section, an S plan, or a plan already ready: silent', () => {
    expect(gate('advisory', FULL_NOTE)(withNote(), { ...withNote(), maturity: 'ready' })).toEqual({ error: null, warning: null });
    const s = entry({ size: 'S' });
    expect(gate('advisory')(s, { ...s, maturity: 'ready' })).toEqual({ error: null, warning: null });
    const r = entry({ maturity: 'ready' });
    expect(gate('advisory')(r, { ...r, summary: 'x' })).toEqual({ error: null, warning: null });
  });

  it('block refuses the edit with the list; off says nothing', () => {
    expect(gate('block')(entry(), { ...entry(), maturity: 'ready' }).error).toMatch(/refused/);
    expect(gate('off')(entry(), { ...entry(), maturity: 'ready' })).toEqual({ error: null, warning: null });
  });

  it('a skip recorded in the same edit, or before, lets ready through even in block mode', () => {
    const skip = { reason: 'owner knows', at: 'x', by: 'owner' };
    expect(gate('block')(entry(), { ...entry(), maturity: 'ready', decision_skip: skip })).toEqual({ error: null, warning: null });
  });

  it('a zone hit makes a small plan count', () => {
    const s = entry({ size: 'S' });
    expect(gate('advisory', null, ['D-0001'])(s, { ...s, maturity: 'ready' }).warning).toMatch(/zone D-0001/);
  });
});

describe('the plan register wiring', () => {
  const projects = { p: { title: 'P', area: 'a' } };
  const reg = () => {
    const r = P.emptyRegister('2026-11-21T08:00:00.000Z');
    const n = P.newEntry(r, { ...entry(), priority_reason: undefined }, { role: 'owner', projects, question: {} });
    if (n.error.length) throw new Error(n.error.join('; '));
    return r;
  };

  it('editEntry passes the warning through and refuses on a block', () => {
    const r = reg();
    const g = G.readyGate({ mode: 'advisory', on: true, readDoc: readDoc(null), zonesFor: () => [] });
    const w = P.editEntry(r, 'PL-EX-1', { maturity: 'ready' }, { role: 'owner', projects, decisionGate: g });
    expect(w.error).toEqual([]);
    expect(w.warnings.some((x: string) => /decision section/i.test(x))).toBe(true);
    const r2 = reg();
    const b = G.readyGate({ mode: 'block', on: true, readDoc: readDoc(null), zonesFor: () => [] });
    const refused = P.editEntry(r2, 'PL-EX-1', { maturity: 'ready' }, { role: 'owner', projects, decisionGate: b });
    expect(refused.error[0]).toMatch(/refused/);
    expect(r2.entries[0].maturity).toBe('planned');
  });

  it('decision_skip is a known field with a checked shape', () => {
    const r = reg();
    const ok = P.editEntry(r, 'PL-EX-1', { decision_skip: { reason: 'tiny in practice', at: 'x', by: 'owner' } }, { role: 'owner', projects });
    expect(ok.error).toEqual([]);
    const bad = P.editEntry(r, 'PL-EX-1', { decision_skip: { reason: '' } }, { role: 'owner', projects });
    expect(bad.error[0]).toMatch(/decision_skip/);
  });

  it('a task with shaped is validated at add and edit, and shaped is a known task field', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const D = require('../doneCheck.js');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const TF = require('../taskFields.js');
    expect(D.doneWhenErrors({ shaped: 'skipped' })).toEqual([]);
    expect(D.doneWhenErrors({ shaped: 'later' })[0]).toMatch(/shaped must be/);
    expect(TF.KNOWN).toContain('shaped');
  });

  it('decision is a source role a task may use, and it is reading material', () => {
    expect(P.SOURCE_ROLES).toContain('decision');
    expect(P.sourceListErrors([{ path: 'docs/a.md', role: 'decision' }], { strict: true })).toEqual([]);
  });
});
