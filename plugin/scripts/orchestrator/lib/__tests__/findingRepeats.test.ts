// =============================================================
// findingRepeats.test.ts: the repeat count on class and area over the finding log, "guard failed", the facts the Checks
// tab reads, and the gate proposal that shares one cap with the inspection queue and the GATE proposals (step 7 of the
// finding format, plans/funnformat-0i-0j-2026-11-15.md section 6 row 7; 0i sections 3.6 and 3.9).
//
// Locks: (1) two incidents in separate tasks in one area within the window are due, one is not, and the reruns of one
// task are one incident; (2) three across the project are due when no area is; (3) only rows with counts true count,
// and confidence low and the class other never do; (4) fixed-without-test weighs twice, and an old row whose test_added
// is a path or a list is read as verdict null and counted once (owner decision); (5) guard failed: the class back in
// an area after an active guard, a row that names its guard, a fix with a proven red test, or an untested H fix; a guard
// built after the failure resolves it; (6) the settings: the window, the thresholds, repeats off, the marker; (7) the
// facts and ledger-recent (3 in one area in 30 days); (8) the shared cap counts proposed INSP and gate tasks together,
// and the proposal is a gate task per class and area, so the same one is never proposed twice.
// The end to end run (the files, the pulse, the Checks tab) is __tests__/findingRepeatsFlow.test.ts.
// =============================================================
import { describe, expect, it } from 'vitest';

/* eslint-disable-next-line @typescript-eslint/no-require-imports */
const R = require('../findingRepeats.js');
/* eslint-disable-next-line @typescript-eslint/no-require-imports */
const G = require('../knownBugGate.js');

const NOW = Date.parse('2026-11-16T12:00:00Z');
const DAY = 86_400_000;
const at = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString().replace(/\.\d{3}Z$/, 'Z');

let n = 0;
/** A finding log row as findingLog.makeRow writes it (only the fields the count reads). */
function row(o: Record<string, unknown> = {}) {
  n += 1;
  const { area = 'src/api', files = ['src/api/save.ts'], daysAgo = 1, ...rest } = o as { area?: string | null; files?: string[]; daysAgo?: number };
  return {
    id: `F-${n}`,
    time: at(daysAgo),
    class: 'unchecked-error',
    class_source: 'agent',
    confidence: 'high',
    where: { files, line: 4, area },
    caught_by: 'review:reviewer',
    severity: 'M',
    task: `T-${n}`,
    fix: null,
    test_added: null,
    status: null,
    guard: null,
    counts: true,
    ...rest,
  };
}

const scan = (rows: object[], o: Record<string, unknown> = {}) => R.scan(rows, { now: NOW, setup: R.setupOf({}), ...o });
const keys = (list: { class: string; area: string }[]) => list.map((e) => `${e.class}@${e.area}`);

describe('the repeat count on class and area', () => {
  it('two incidents in separate tasks in one area within the window are due; one is not', () => {
    expect(scan([row()]).due).toEqual([]);
    const r = scan([row({ daysAgo: 40 }), row({ daysAgo: 2 })]);
    expect(keys(r.due)).toEqual(['unchecked-error@src/api']);
    expect(r.due[0]).toMatchObject({ scope: 'area', incidents: 2, weight: 2, severity: 'M' });
  });

  it('the rows of one task are one incident, and a row out of the window does not count', () => {
    expect(scan([row({ task: 'A-1' }), row({ task: 'A-1' })]).due).toEqual([]);
    expect(scan([row({ daysAgo: 91 }), row({ daysAgo: 2 })]).due).toEqual([]);
  });

  it('three in separate areas are due for the project when no area is', () => {
    const rows = [row({ area: 'a', files: ['a/x.ts'] }), row({ area: 'b', files: ['b/x.ts'] })];
    expect(scan(rows).due).toEqual([]);
    const r = scan([...rows, row({ area: 'c', files: ['c/x.ts'] })]);
    expect(r.due).toHaveLength(1);
    expect(r.due[0]).toMatchObject({ class: 'unchecked-error', area: '*', scope: 'project', incidents: 3 });
  });

  it('only rows with counts true count; confidence low and the class other never do', () => {
    expect(scan([row(), row({ counts: false })]).due).toEqual([]);
    expect(scan([row(), row({ confidence: 'low' })]).due).toEqual([]);
    expect(scan([row({ class: 'other' }), row({ class: 'other' })]).due).toEqual([]);
    // A row that says counts true for the class other (written by hand) is still never counted.
    expect(scan([row({ class: 'other', counts: true }), row({ class: 'other', counts: true }), row({ class: 'other', counts: true })]).due).toEqual([]);
  });

  it('fixed-without-test weighs twice', () => {
    const untested = { fix: 'base-fix', test_added: { verdict: 'no-tests', files: [] }, status: 'fixed-without-test' };
    const rows = [row({ area: 'a', files: ['a/x.ts'], ...untested }), row({ area: 'b', files: ['b/x.ts'] })];
    const r = scan(rows);
    // 2 + 1 = 3 across the project, although only two incidents.
    expect(r.due).toHaveLength(1);
    expect(r.due[0]).toMatchObject({ scope: 'project', incidents: 2, weight: 3 });
    // Without the untested fix the same two are not due.
    expect(scan([row({ area: 'a', files: ['a/x.ts'] }), row({ area: 'b', files: ['b/x.ts'] })]).due).toEqual([]);
  });

  it('one untested fix alone is never due: a repeat needs two incidents', () => {
    const untested = { fix: 'base-fix', test_added: { verdict: 'unproven', files: [] }, status: 'fixed-without-test' };
    expect(scan([row(untested)]).due).toEqual([]);
  });

  it('an old row whose test_added is a path or a list reads as verdict null and counts once', () => {
    expect(R.testVerdict(row({ test_added: 'src/api/save.test.ts' }))).toBeNull();
    expect(R.testVerdict(row({ test_added: ['a.test.ts', 'b.test.ts'] }))).toBeNull();
    expect(R.testVerdict(row({ test_added: { verdict: 'proven', files: [] } }))).toBe('proven');
    // Even with a status written next to it (by hand, or by an old writer), the verdict decides.
    const old = row({ area: 'a', files: ['a/x.ts'], fix: 'fixes', test_added: ['a/x.test.ts'], status: 'fixed-without-test' });
    expect(R.weightOf(old)).toBe(1);
    expect(scan([old, row({ area: 'b', files: ['b/x.ts'] })]).due).toEqual([]);
  });
});

describe('guard failed', () => {
  it('the class back in an area after an active guard for it is a guard failure, also while it is not due', () => {
    const guards = [{ id: 'G-1', class: 'unchecked-error', area: 'src/api', since: NOW - 30 * DAY }];
    const r = scan([row({ daysAgo: 2 })], { guards });
    expect(r.due).toEqual([]);
    expect(r.guardFailed).toHaveLength(1);
    expect(r.guardFailed[0]).toMatchObject({ class: 'unchecked-error', area: 'src/api', guardFailed: { reason: 'guard', ref: 'G-1' } });
    // A guard for another area, another class, or one built after the failure does not count.
    expect(scan([row({ daysAgo: 2 })], { guards: [{ ...guards[0], area: 'src/ui' }] }).guardFailed).toEqual([]);
    expect(scan([row({ daysAgo: 2 })], { guards: [{ ...guards[0], class: 'null-undefined' }] }).guardFailed).toEqual([]);
    expect(scan([row({ daysAgo: 2 })], { guards: [{ ...guards[0], since: NOW - DAY }] }).guardFailed).toEqual([]);
    // A guard without an area covers the class in every area.
    expect(scan([row({ daysAgo: 2 })], { guards: [{ ...guards[0], area: null }] }).guardFailed).toHaveLength(1);
  });

  it('a row that names the guard it was seen under is a guard failure', () => {
    expect(scan([row({ guard: 'G-4' })]).guardFailed[0]).toMatchObject({ guardFailed: { reason: 'guard', ref: 'G-4' } });
  });

  it('the class back after a fix with a proven red test is a guard failure; after a plain repeat it is not', () => {
    const fixed = row({ daysAgo: 20, task: 'FIX-1', fix: 'base-fix', test_added: { verdict: 'proven', files: ['src/api/save.test.ts'] } });
    const r = scan([fixed, row({ daysAgo: 2 })]);
    expect(r.guardFailed).toHaveLength(1);
    expect(r.guardFailed[0].guardFailed).toMatchObject({ reason: 'fix', ref: 'FIX-1' });
    expect(scan([row({ daysAgo: 20 }), row({ daysAgo: 2 })]).guardFailed).toEqual([]);
  });

  it('an H class back after an untested fix is a guard failure; an M one is only a repeat', () => {
    const untested = { fix: 'base-fix', test_added: { verdict: 'no-tests', files: [] }, status: 'fixed-without-test' };
    const h = scan([row({ daysAgo: 20, task: 'FIX-2', severity: 'H', ...untested }), row({ daysAgo: 2, severity: 'H' })]);
    expect(h.guardFailed[0].guardFailed).toMatchObject({ reason: 'untested-h', ref: 'FIX-2' });
    const m = scan([row({ daysAgo: 20, ...untested }), row({ daysAgo: 2 })]);
    expect(m.guardFailed).toEqual([]);
    expect(m.due).toHaveLength(1);
  });

  it('a guard built after the failure resolves it', () => {
    const fixed = row({ daysAgo: 20, task: 'FIX-1', fix: 'base-fix', test_added: { verdict: 'proven', files: [] } });
    const again = row({ daysAgo: 5 });
    expect(scan([fixed, again]).guardFailed).toHaveLength(1);
    const later = [{ id: 'GATE-3', class: 'unchecked-error', area: 'src/api', since: NOW - DAY }];
    expect(scan([fixed, again], { guards: later }).guardFailed).toEqual([]);
    // So does a newer fix with a proven red test in the same place.
    const fixedAgain = row({ daysAgo: 1, task: 'FIX-9', fix: 'fixes', test_added: { verdict: 'proven', files: [] } });
    expect(scan([fixed, again, fixedAgain]).guardFailed).toEqual([]);
  });

  it('low confidence and other never make a guard failure', () => {
    const guards = [{ id: 'G-1', class: 'unchecked-error', area: null, since: NOW - 30 * DAY }];
    expect(scan([row({ confidence: 'low' })], { guards }).guardFailed).toEqual([]);
    expect(scan([row({ class: 'other' })], { guards: [{ ...guards[0], class: 'other' }] }).guardFailed).toEqual([]);
  });
});

describe('the setup', () => {
  it('the defaults: counting and the marker on, proposals and database probe recipes off, 90 days, 2 in an area, 3 in the project', () => {
    expect(R.setupOf({})).toEqual({ repeats: true, windowDays: 90, areaRepeats: 2, projectRepeats: 3, guardFailedMarker: true, proposals: false, dbProbes: false, recipeDamping: true, recipeMinProposals: 5, recipeMinProposalsDb: 10, recipeMinAccepted: 30 });
    expect(R.setupOf({ learning: { windowDays: 0, areaRepeats: 'x', proposals: 'yes' } })).toMatchObject({ windowDays: 90, areaRepeats: 2, proposals: false });
  });

  it('the thresholds and the window come from the setup; repeats off counts nothing', () => {
    const rows = [row({ daysAgo: 40 }), row({ daysAgo: 2 })];
    expect(scan(rows, { setup: R.setupOf({ learning: { areaRepeats: 3 } }) }).due).toEqual([]);
    expect(scan(rows, { setup: R.setupOf({ learning: { windowDays: 30 } }) }).due).toEqual([]);
    const off = scan([...rows, row({ guard: 'G-1' })], { setup: R.setupOf({ learning: { repeats: false } }) });
    expect(off).toMatchObject({ due: [], guardFailed: [] });
  });

  it('reports the problems in learning for doctor', () => {
    expect(R.setupProblems(undefined)).toEqual([]);
    expect(R.setupProblems({ windowDays: 0, proposals: 'yes' })).toHaveLength(2);
  });
});

describe('the facts for the Checks tab', () => {
  it('names what is due and what failed, with the marker setting', () => {
    const guards = [{ id: 'G-1', class: 'null-undefined', area: null, since: NOW - 30 * DAY }];
    const rows = [row({ daysAgo: 40 }), row({ daysAgo: 2 }), row({ class: 'null-undefined', daysAgo: 1 })];
    const f = R.facts(scan(rows, { guards }), { rows, now: NOW, setup: R.setupOf({}) });
    expect(f.due.map((e: { class: string }) => e.class)).toEqual(['unchecked-error']);
    expect(f.guardFailed.map((e: { class: string }) => e.class)).toEqual(['null-undefined']);
    expect(f.marker).toBe(true);
    expect(R.facts(scan(rows, { guards }), { rows, now: NOW, setup: R.setupOf({ learning: { guardFailedMarker: false } }) }).marker).toBe(false);
  });

  it('recent: the most incidents of a class in one area within 30 days (the scope drift cards read 3)', () => {
    const rows = [1, 2, 3].map((d) => row({ class: 'duplication', daysAgo: d }));
    const f = R.facts(scan(rows), { rows, now: NOW, setup: R.setupOf({}) });
    expect(f.recent).toEqual({ duplication: 3 });
    const old = [10, 35, 40].map((d) => row({ class: 'duplication', daysAgo: d }));
    expect(R.facts(scan(old), { rows: old, now: NOW, setup: R.setupOf({}) }).recent).toEqual({ duplication: 1 });
  });

  it('a due entry names its key and its places across the incidents (paths only, at most five), never an excerpt', () => {
    const rows = [
      row({ daysAgo: 40, files: ['src/api/a.ts'], excerpt: 'TypeError: token abc' }),
      row({ daysAgo: 20, files: ['src/api/b.ts', 'src/api/a.ts'] }),
      ...[3, 4, 5, 6].map((d) => row({ daysAgo: d, files: [`src/api/f${d}.ts`] })),
    ];
    const f = R.facts(scan(rows), { rows, now: NOW, setup: R.setupOf({}) });
    expect(f.due[0]).toMatchObject({ key: 'unchecked-error@src/api' });
    expect(f.due[0].files).toHaveLength(5);
    expect(new Set(f.due[0].files).size).toBe(5);
    for (const p of f.due[0].files) expect(p).toMatch(/^src\/api\/[a-z0-9]+\.ts$/);
    expect(JSON.stringify(f)).not.toMatch(/token abc/);
  });

  it('with the tasks: what became of each class and area as a proposal, and the shared cap', () => {
    const rows = [row({ daysAgo: 40 }), row({ daysAgo: 2 })];
    const r = scan(rows);
    const title = `Gate: ${R.gateTitle(r.due[0])}`;
    const facts = (tasks: object[]) => R.facts(r, { rows, now: NOW, setup: R.setupOf({}), tasks });
    expect(facts([]).due[0].proposal).toEqual({ state: 'add', task: null });
    expect(facts([{ id: 'GATE-1', title, status: 'cancelled', labels: ['gate'] }]).due[0].proposal).toEqual({ state: 'declined', task: 'GATE-1' });
    expect(facts([{ id: 'GATE-1', title, status: 'done', labels: ['gate'] }]).due[0].proposal).toEqual({ state: 'exists', task: 'GATE-1' });
    expect(facts([{ id: 'GATE-1', title, status: 'proposed', labels: ['gate'] }]).due[0].proposal).toEqual({ state: 'extend', task: 'GATE-1' });
    const three = [1, 2, 3].map((i) => ({ id: `INSP-${i}`, status: 'proposed' }));
    expect(facts(three).due[0].proposal).toEqual({ state: 'full', task: null });
    expect(facts(three).cap).toEqual({ open: 3, max: 3, full: true });
    // Without the tasks the state is unknown, and nothing is left out for it.
    expect(R.facts(r, { rows, now: NOW, setup: R.setupOf({}) }).due[0].proposal).toBeNull();
  });
});

describe('the gate proposal and the shared cap', () => {
  it('the shared cap counts proposed INSP and gate tasks together, not approved or closed ones', () => {
    const tasks = [
      { id: 'INSP-1', status: 'proposed' },
      { id: 'GATE-1', status: 'proposed', labels: ['gate'] },
      { id: 'GATE-2', status: 'waiting', labels: ['gate'] },
      { id: 'INSP-2', status: 'done' },
      { id: 'T-1', status: 'proposed' },
    ];
    expect(G.sharedProposals(tasks)).toBe(2);
    expect(G.SHARED_MAX).toBe(3);
  });

  it('a gate from a known bug waits when three proposals of any kind wait for the owner', () => {
    const tasks = [{ id: 'INSP-1', status: 'proposed' }, { id: 'INSP-2', status: 'proposed' }, { id: 'GATE-1', status: 'proposed', labels: ['gate'], title: 'Gate: x' }];
    expect(G.decide({ title: 'A new class', tasks }).action).toBe('full');
    expect(G.decide({ title: 'A new class', tasks: tasks.slice(1) }).action).toBe('add');
  });

  it('the proposal is a gate task per class and area, never approved here, so the same one is matched again', () => {
    const r = scan([row({ daysAgo: 40, task: 'A-1' }), row({ daysAgo: 2, task: 'B-2' })]);
    const t = R.proposalTask(r.due[0], { id: 'GATE-1' });
    expect(t).toMatchObject({ id: 'GATE-1', added_by: 'gate agent', labels: ['gate', 'finding-log'] });
    expect(t.title).toBe('Gate: Unchecked error or result in src/api');
    expect(t.mission).toContain('B-2');
    expect(t.mission).toContain('src/api/save.ts:4');
    expect(t).not.toHaveProperty('approved');
    // The same class and area again: the open task is extended, a done one exists, a cancelled one stays declined.
    const title = R.gateTitle(r.due[0]);
    expect(G.decide({ title, tasks: [{ ...t, status: 'proposed' }] }).action).toBe('extend');
    expect(G.decide({ title, tasks: [{ ...t, status: 'cancelled' }] }).action).toBe('declined');
    // Another area is another proposal.
    expect(G.decide({ title: R.gateTitle({ ...r.due[0], area: 'src/ui' }), tasks: [{ ...t, status: 'cancelled' }] }).action).toBe('add');
  });

  it('a done gate task from the log is a guard for its class and area', () => {
    const r = scan([row({ daysAgo: 40 }), row({ daysAgo: 30 })]);
    const t = { ...R.proposalTask(r.due[0], { id: 'GATE-1' }), status: 'done', done: at(20) };
    const guards = R.guardsFrom({ tasks: [t], registry: { guards: [] } });
    expect(guards).toEqual([{ id: 'GATE-1', class: 'unchecked-error', area: 'src/api', since: NOW - 20 * DAY }]);
    // And a registry entry that names its class, while active.
    const reg = { guards: [{ id: 'G-2', status: 'active', built: '2026-10-01', against: { class: 'null-undefined' } }, { id: 'G-3', status: 'retired', built: '2026-10-01', against: { class: 'x' } }] };
    expect(R.guardsFrom({ tasks: [], registry: reg })).toEqual([{ id: 'G-2', class: 'null-undefined', area: null, since: Date.parse('2026-10-01') }]);
  });
});
