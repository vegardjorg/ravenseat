// =============================================================
// gateEvidenceMode.test.ts: the setting gateEvidence.mode (own / external / off) and gateEvidence.external, owner
// decision B2 (plans/innstillinger-vurdering-2026-11-12.md, the B2 table).
//
// Locks: (1) the default is own with no external checks, and an unknown mode reads as own; (2) an external CI result
// counts only for exactly the same sha, only when every listed check name has its newest run green, and never with an
// empty list (which says so); (3) an external entry is evidence for the full gate only in mode external and only for the
// check names it was recorded with, never for receive's quick gates and never in own or off; (4) the registry rows
// (Gates and checks, advanced, both modes) weaken for external and off, and the warning text says that a project
// without gates saves no time with off; (5) doctor: INFO for external, WARN for off, an extra line when the list is
// empty; (6) the push guard treats the owner log as it treats the evidence store.
// =============================================================
import { describe, expect, it } from 'vitest';

/* eslint-disable @typescript-eslint/no-require-imports */
const GE = require('../gateEvidence.js');
const QC = require('../queueConfig.js');
const R = require('../settingsRegistry.js');
const SV = require('../settingsView.js');
/* eslint-enable @typescript-eslint/no-require-imports */

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const run = (o: Record<string, unknown>) => ({ databaseId: 1, workflowName: 'ci', name: 'ci', status: 'completed', conclusion: 'success', headSha: SHA, ...o });

describe('the mode', () => {
  it('own with no external checks by default; an unknown value reads as own', () => {
    expect(QC.STANDARD.gateEvidence).toEqual({ mode: 'own', external: [] });
    expect(GE.modeOf(QC.STANDARD)).toBe('own');
    expect(GE.modeOf({ gateEvidence: { mode: 'external' } })).toBe('external');
    expect(GE.modeOf({ gateEvidence: { mode: 'off' } })).toBe('off');
    expect(GE.modeOf({ gateEvidence: { mode: 'sometimes' } })).toBe('own');
    expect(GE.modeOf({})).toBe('own');
    expect(GE.externalNames({ gateEvidence: { external: [' ci ', '', 3, 'lint'] } })).toEqual(['ci', 'lint']);
  });
});

describe('an external CI result', () => {
  it('green only on exactly the same sha, with every listed name green on its newest run', () => {
    expect(GE.externalCheck([run({})], { sha: SHA, names: ['ci'] })).toMatchObject({ ok: true });
    // Another commit, even with the same name: nothing.
    expect(GE.externalCheck([run({ headSha: OTHER })], { sha: SHA, names: ['ci'] }).ok).toBe(false);
    // A short sha prefix is not the same sha.
    expect(GE.externalCheck([run({ headSha: SHA.slice(0, 12) })], { sha: SHA, names: ['ci'] }).ok).toBe(false);
    // Not done, or red.
    expect(GE.externalCheck([run({ status: 'in_progress', conclusion: '' })], { sha: SHA, names: ['ci'] }).ok).toBe(false);
    expect(GE.externalCheck([run({ conclusion: 'failure' })], { sha: SHA, names: ['ci'] }).ok).toBe(false);
    // skipped and neutral are not a green test run.
    expect(GE.externalCheck([run({ conclusion: 'skipped' })], { sha: SHA, names: ['ci'] }).ok).toBe(false);
    // Every listed name must be there and green.
    expect(GE.externalCheck([run({})], { sha: SHA, names: ['ci', 'e2e'] })).toMatchObject({ ok: false });
    expect(GE.externalCheck([run({}), run({ databaseId: 2, workflowName: 'e2e', name: 'e2e' })], { sha: SHA, names: ['ci', 'e2e'] }).ok).toBe(true);
    // The newest run of a name decides: red after green is red.
    expect(GE.externalCheck([run({ databaseId: 1 }), run({ databaseId: 5, conclusion: 'failure' })], { sha: SHA, names: ['ci'] }).ok).toBe(false);
    expect(GE.externalCheck([run({ databaseId: 5 }), run({ databaseId: 1, conclusion: 'failure' })], { sha: SHA, names: ['ci'] }).ok).toBe(true);
  });

  it('an empty list counts nothing and says so', () => {
    const r = GE.externalCheck([run({})], { sha: SHA, names: [] });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/gateEvidence\.external is empty/);
  });
});

describe('an external entry as evidence', () => {
  const cfg = (mode: string, external: string[] = ['ci']) => ({ gates: { quick: ['q'], full: ['q', 'f'] }, gateEvidence: { mode, external } });
  const entryFor = (c: ReturnType<typeof cfg>, names = ['ci']) =>
    GE.externalEntry({ sha: SHA, setupHash: GE.setupHash(c.gates), gates: c.gates.full, checks: names.map((n) => ({ name: n, id: 1 })) });

  it('counts for the full gate in mode external, for the names it was recorded with', () => {
    const c = cfg('external');
    const e = entryFor(c);
    expect(e).toMatchObject({ kind: 'full', ok: true, clean: true, runner: GE.RUNNER_EXTERNAL, writer: 'orchestrator', external_checks: ['ci'] });
    const store = { entries: [e] };
    const v = (k: ReturnType<typeof cfg>) => GE.verdictFor(store.entries, { sha: SHA, cfg: k });
    expect(v(c)).toBe('green');
    // own and off: an external entry is never evidence.
    expect(v(cfg('own'))).toBe('missing');
    expect(v(cfg('off'))).toBe('missing');
    // A name added to the list since: the old entry does not cover it.
    expect(v(cfg('external', ['ci', 'e2e']))).toBe('missing');
    // The empty list: nothing counts.
    expect(v(cfg('external', []))).toBe('missing');
  });

  it('is never receive\'s quick evidence (the default trust leaves it out)', () => {
    const c = cfg('external');
    const e = entryFor(c);
    expect(GE.latest([e], { sha: SHA, kinds: ['quick', 'full'], commands: ['q'], setupHash: GE.setupHash(c.gates), legacy: false })).toBeNull();
    expect(GE.trusted(e)).toBe(false);
  });
});

describe('the registry rows and the warning', () => {
  it('Gates and checks, advanced, both modes; external and off weaken, own never', () => {
    const mode = R.rowFor('gateEvidence.mode');
    const ext = R.rowFor('gateEvidence.external');
    for (const r of [mode, ext]) {
      expect(r, 'row').toBeTruthy();
      expect(r.category).toBe('gates');
      expect(r.level).toBe('advanced');
      expect(r.modes).toEqual(['lite', 'full']);
    }
    expect(mode.type).toBe('choice');
    expect(mode.choices).toEqual(['own', 'external', 'off']);
    expect(mode.weakens('external', 'own')).toBe(true);
    expect(mode.weakens('off', 'own')).toBe(true);
    expect(mode.weakens('own', 'own')).toBe(false);
    expect(mode.weakens('external', 'off')).toBe(false);
    expect(ext.type).toBe('list');
    // The texts of the dialog: what it protects, why not, what changes; and the empty-gates remark.
    expect(mode.protects && mode.whyNot && mode.changes).toBeTruthy();
    const text = [mode.protects, mode.whyNot, mode.changes].join(' ');
    expect(text).toMatch(/gates\.quick/);
    expect(text).toMatch(/gates\.full/);
    expect(text).toMatch(/saves no time/);
    expect(text).toMatch(/owner row/);
    expect(text).not.toMatch(/[–—]/);
  });

  it('settings set needs the confirmation for external and off', () => {
    const row = R.rowFor('gateEvidence.mode');
    expect(SV.needsConfirm(row, 'off', { now: 'own', standard: 'own' })).toBe(true);
    expect(SV.needsConfirm(row, 'external', { now: 'own', standard: 'own' })).toBe(true);
    expect(SV.needsConfirm(row, 'own', { now: 'off', standard: 'own' })).toBe(false);
  });
});

describe('doctor', () => {
  const rows = (gateEvidence: unknown) =>
    SV.doctorRows({ config: { ...QC.STANDARD, gateEvidence } }).filter((r: { message: string }) => /gateEvidence|GATE EVIDENCE/.test(r.message));
  it('nothing by default, INFO for external, WARN for off, and a WARN when external has no names', () => {
    expect(rows({ mode: 'own', external: [] })).toEqual([]);
    const ext = rows({ mode: 'external', external: ['ci'] });
    expect(ext.map((r: { status: string }) => r.status)).toEqual(['INFO']);
    expect(ext[0].message).toMatch(/ci/);
    const empty = rows({ mode: 'external', external: [] });
    expect(empty.map((r: { status: string }) => r.status)).toEqual(['INFO', 'WARN']);
    expect(empty[1].message).toMatch(/empty/);
    const off = rows({ mode: 'off', external: [] });
    expect(off.map((r: { status: string }) => r.status)).toEqual(['WARN']);
    expect(off[0].message).toMatch(/GATE EVIDENCE OFF/);
    // Not in the shared "weaker than the default" line as well.
    const shared = SV.doctorRows({ config: { ...QC.STANDARD, gateEvidence: { mode: 'off', external: [] } } })
      .filter((r: { message: string }) => /weaker than the default/.test(r.message));
    expect(shared).toEqual([]);
  });
});

describe('doctor value checks', () => {
  it('names a mode that is not own, external or off, and an external list that is not names', async () => {
    const D = await import('../../cli/doctor.mjs');
    expect(D.baselineProblems({ gateEvidence: { mode: 'sometimes' } })).toContain('gateEvidence.mode must be "own", "external" or "off"');
    expect(D.baselineProblems({ gateEvidence: { external: 'ci' } })).toContain('gateEvidence.external must be a list of check names');
    expect(D.baselineProblems({ gateEvidence: { external: ['ci', ''] } })).toContain('gateEvidence.external must be a list of check names');
    expect(D.baselineProblems({ gateEvidence: { mode: 'external', external: ['ci'] } })).toEqual([]);
  });
});

describe('the push guard', () => {
  it('a queue agent may not name the owner log in a shell command', () => {
    expect(GE.tamperReason('cat scripts/.queue/owner-log.json')).toMatch(/owner log/);
    expect(GE.tamperReason('cat scripts/.queue/OWNER-"log".json')).toMatch(/owner log/);
    expect(GE.tamperReason('cat scripts/.queue/owner-notes.md')).toBeNull();
  });
});
