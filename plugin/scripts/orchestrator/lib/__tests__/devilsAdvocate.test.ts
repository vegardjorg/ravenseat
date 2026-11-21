// =============================================================
// devilsAdvocate.test.ts: the devil's advocate on a big plan's decision section (PG-7, lib/devilsAdvocate.js;
// plans/plan-gate-vurdering-2026-11-21.md, PG-7).
//
// What the tests prove:
//   - plans.devilsAdvocate is off by default; off means no offer, and on offers only for XL or a zone,
//   - the brief has the decision section and not the investigation (neither its path nor its text),
//   - the answer must have exactly three objections and one cheapest test,
//   - the block goes at the end of the decision section, and never completes a missing decision heading.
// =============================================================
import { describe, it, expect } from 'vitest';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const DA = require('../devilsAdvocate.js') as any;
const KK = require('../queueConfig.js') as any;
const G = require('../planGate.js') as any;
const H = require('../queueHelpers.js') as any;
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

const DOC = [
  '# Exports',
  '## Investigation',
  'We measured the old exporter in plans/old-notes.md and found it slow.',
  '## Decision',
  '**Need and evidence:** three teams asked.',
  '**Success measure:** exports open in a spreadsheet.',
  '',
  '## Later',
  'Something else.',
].join('\n');
const ANSWER = [
  'Some preamble the agent wrote.',
  'OBJECTION 1: The spreadsheet library already reads the format.',
  '**OBJECTION 2:** Only one team uses exports weekly.',
  'OBJECTION 3: The data model change is the real cost.',
  'CHEAPEST TEST: Open last week\'s export in the spreadsheet by hand.',
].join('\n');

describe('the plans.devilsAdvocate switch and the offer', () => {
  it('is off by default, and off means no offer', () => {
    expect(KK.STANDARD.plans.devilsAdvocate).toBe(false);
    expect(DA.setup({}).on).toBe(false);
    expect(DA.setup({ plans: { devilsAdvocate: 'yes' } }).on).toBe(false);
    expect(DA.setup({ plans: { devilsAdvocate: true } }).on).toBe(true);
    expect(DA.offer({ on: false, entry: { id: 'PL-X', size: 'XL' } }).offer).toBe(false);
  });

  it('on, it is offered for XL or a zone only', () => {
    expect(DA.offer({ on: true, entry: { id: 'PL-X', size: 'XL' } })).toMatchObject({ offer: true, why: 'size XL' });
    expect(DA.offer({ on: true, entry: { id: 'PL-Z', size: 'M' }, zones: ['D-0001'] }).why).toBe('in sensitive zone D-0001');
    expect(DA.offer({ on: true, entry: { id: 'PL-L', size: 'L' } }).offer).toBe(false);
  });

  it('runs as the existing challenger helper', () => {
    expect(DA.AGENT).toBe('reviewer-challenger');
    expect(JSON.stringify(H.CATALOG)).toContain('reviewer-challenger');
  });
});

describe('the brief', () => {
  const entry = { id: 'PL-X', title: 'Exports', size: 'XL', sources: [{ path: 'plans/exports.md', anchor: '#investigation', role: 'investigation' }] };
  const section = G.sectionLines(DOC, '#decision').lines.join('\n');
  const text = DA.brief({ entry, section, code: ['src/export/'] });

  it('has the decision section and the code', () => {
    expect(text).toContain('**Success measure:** exports open in a spreadsheet.');
    expect(text).toContain('src/export/');
    expect(text).toMatch(/OBJECTION 1:[\s\S]*CHEAPEST TEST:/);
  });

  it('has neither the investigation path nor its text', () => {
    expect(text).not.toContain('plans/exports.md');
    expect(text).not.toContain('old-notes');
    expect(text).not.toContain('found it slow');
  });
});

describe('the answer', () => {
  it('three objections and one cheapest test', () => {
    const a = DA.parseAnswer(ANSWER);
    expect(a.error).toEqual([]);
    expect(a.objections).toEqual([
      'The spreadsheet library already reads the format.',
      'Only one team uses exports weekly.',
      'The data model change is the real cost.',
    ]);
    expect(a.test).toBe("Open last week's export in the spreadsheet by hand.");
  });

  it('refuses two, four, a repeated or an empty objection, and a missing test', () => {
    const lines = ANSWER.split('\n');
    expect(DA.parseAnswer(lines.filter((l) => !l.startsWith('OBJECTION 3')).join('\n')).error.join(' ')).toMatch(/OBJECTION 3/);
    expect(DA.parseAnswer(`${ANSWER}\nOBJECTION 4: one more`).error.join(' ')).toMatch(/exactly 3 objections/);
    expect(DA.parseAnswer(`${ANSWER}\nOBJECTION 1: again`).error.join(' ')).toMatch(/OBJECTION 1/);
    expect(DA.parseAnswer(ANSWER.replace('The data model change is the real cost.', '')).error.join(' ')).toMatch(/OBJECTION 3/);
    expect(DA.parseAnswer(lines.slice(0, 4).join('\n')).error.join(' ')).toMatch(/CHEAPEST TEST/);
  });
});

describe('the block under the section', () => {
  const answer = DA.parseAnswer(ANSWER);

  it('goes at the end of the decision section, before the next heading', () => {
    const r = DA.appendBlock(DOC, '#decision', answer, { date: '2026-11-21' });
    expect(r.error).toBeNull();
    const lines = r.text.split('\n');
    const block = lines.indexOf("### Devil's advocate (2026-11-21, reviewer-challenger)");
    expect(block).toBeGreaterThan(lines.indexOf('## Decision'));
    expect(block).toBeLessThan(lines.indexOf('## Later'));
    expect(r.text).toContain('- Objection 2: Only one team uses exports weekly.');
    expect(r.text).toContain("- Cheapest test: Open last week's export in the spreadsheet by hand.");
    // The section is still found and has the block in it.
    expect(G.sectionLines(r.text, '#decision').lines.join('\n')).toContain('Objection 3');
  });

  it('never completes a missing decision heading by itself', () => {
    const entry = { id: 'PL-X', size: 'XL', sources: [{ path: 'd.md', anchor: '#decision', role: 'decision' }] };
    const before = G.decisionState(entry, { readDoc: () => DOC });
    const after = G.decisionState(entry, { readDoc: () => DA.appendBlock(DOC, '#decision', answer).text });
    expect(after.missing).toEqual(before.missing);
    expect(before.missing).toContain('Cheapest test');
  });

  it('refuses an anchor with no section', () => {
    expect(DA.appendBlock(DOC, '#nowhere', answer).error).toMatch(/no heading/);
  });
});
