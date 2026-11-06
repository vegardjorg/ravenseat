// =============================================================
// qualityFigures.test.ts: the quality figures in the flow view (lib/eventStatistics.js flowStatistics): right first
// time, post-merge defects, owner interventions, the reviewer hit rate and the inflow by source.
//
// Locks: each condition that makes a merged task a miss (fix round, QA deviation, reopen, fix task, finding cause), the
// old first-pass figure unchanged next to it; owner interventions only by owner/theBoard while the task ran, and
// "unknown" when the changelog has lost the entries before the start; old tasks without the fields never crash; the
// reviewer rows (runs, with findings, attributed fixes, dismissed, no FINDINGS line) and the hint threshold, which needs
// fix rounds with `from`; the inflow split and the hint after INFLOW_WEEKS weeks with more in than out.
// =============================================================
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ES = require('../eventStatistics.js');

const DAY = 86_400_000;
const T0 = Date.parse('2026-03-01T00:00:00.000Z');
const at = (ms: number) => new Date(T0 + ms).toISOString();
const start = at(0);
const done = at(DAY);
const window = { from: T0, to: T0 + 14 * DAY };

describe('right first time', () => {
  it('a fix round, a QA deviation, a reopen, a fix task and a finding cause each make a miss', () => {
    const queue = {
      tasks: [
        { id: 'OK', status: 'done', started: start, done, resumed: [{ reason: 'context' }] },
        { id: 'R', status: 'done', started: start, done, resumed: [{ reason: 'fix' }] },
        { id: 'Q', status: 'done', started: start, done, qa_status: 'ok', qa_note: 'the button is cut off' },
        { id: 'RE', status: 'done', started: start, done },
        { id: 'F', status: 'done', started: start, done },
        { id: 'F-FIX', status: 'waiting', fixes: ['F'] }, // a fix task that names F
        { id: 'B', status: 'done', started: start, done },
        { id: 'G', status: 'done', started: start, done },
        { id: 'G-QA1', status: 'done', done, qa_original: 'G', fixes: 'G' }, // a QA fix: no merged change itself
      ],
      changelog: [
        { nr: 1, at: at(DAY / 2), by: 'owner', action: 'edit', changes: [{ id: 'OK', field: 'value', before: 5, after: 6 }] },
        { nr: 2, at: at(DAY / 2), by: 'theBoard', action: 'edit', changes: [{ id: 'B', field: 'value', before: 5, after: 7 }] },
        { nr: 3, at: at(DAY / 2), by: 'ravenseat', action: 'edit', changes: [{ id: 'B', field: 'value', before: 7, after: 8 }] },
        { nr: 4, at: at(2 * DAY), by: 'owner', action: 'edit', changes: [{ id: 'B', field: 'value', before: 8, after: 9 }] },
        {
          nr: 5,
          at: at(2 * DAY),
          by: 'ravenseat',
          action: 'edit',
          changes: [{ id: 'RE', field: 'status', before: 'done', after: 'waiting' }],
        },
      ],
    };
    const plans = { entries: [{ id: 'PL-FINDING-1', finding: { tasks: ['X'], causes: ['B'] } }, { id: 'PL-2' }] };
    const f = ES.flowStatistics(queue, [], { ...window, plans });
    const r = f.rightFirstTime;
    // The old figure is kept as it was: 7 merged (the QA fix is no merged change), 6 with 0 fix rounds.
    expect(f.firstPass).toEqual({ merged: 7, first_pass: 6, rate_pct: 85.7 });
    expect(r.merged).toBe(7);
    expect(r.right).toBe(1); // only OK
    expect(r.rate_pct).toBe(14.3);
    expect(r.defects).toBe(3); // F-FIX, PL-FINDING-1 (for B), G-QA1
    expect(r.defects_per_10).toBe(4.3);
    expect(Object.fromEntries(r.misses.map((m: { id: string }) => [m.id, m]))).toMatchObject({
      R: { fix_rounds: 1 },
      Q: { qa_deviation: true },
      RE: { reopened: true },
      F: { defects: ['F-FIX'] },
      B: { defects: ['PL-FINDING-1'] },
      G: { defects: ['G-QA1'] },
    });
    // Owner interventions: owner and theBoard edits while the task ran (nr 1 and 2); ravenseat, and after done, are not.
    expect(r.interventions).toBe(2);
    expect(r.interventions_known).toBe(7);
    expect(r.interventions_per_10).toBe(2.9);
    const text = ES.flowLines(f, 'last 14 days').join('\n');
    expect(text).toContain(
      'right first time: 1 of 7 merged (14.3 %); post-merge defects 3 (4.3 per 10 merged); owner interventions 2 (2.9 per 10 merged)',
    );
    // Without the plan register the finding is not known: B counts as a hit, never an error.
    const noPlans = ES.flowStatistics(queue, [], window).rightFirstTime;
    expect(noPlans.defects).toBe(2);
    expect(noPlans.right).toBe(2);
  });

  it('old data: no start time, a changelog that lost its first entries, no changelog, an empty window', () => {
    const queue = {
      tasks: [
        { id: 'A', status: 'done', done }, // no start time: interventions unknown
        { id: 'B', status: 'done', started: start, done }, // started before the oldest kept entry (nr 40): unknown
        { id: 'C', status: 'done', started: at(DAY / 2), done },
      ],
      changelog: [
        { nr: 40, at: at(DAY / 4), by: 'owner', action: 'edit', changes: [{ id: 'C', field: 'x', before: 1, after: 2 }] },
      ],
    };
    const f = ES.flowStatistics(queue, [], window);
    expect(f.rightFirstTime).toMatchObject({
      merged: 3,
      right: 3,
      defects: 0,
      interventions: 0,
      interventions_known: 1,
      interventions_per_10: 0,
    });
    expect(ES.flowLines(f, 'x').join('\n')).toContain('2 task(s) unknown');
    // No changelog at all: nothing can have fallen out, every task with a start is known.
    const { changelog, ...noLog } = queue;
    expect(ES.flowStatistics(noLog, [], window).rightFirstTime.interventions_known).toBe(2);
    expect(changelog).toHaveLength(1);
    const empty = ES.flowStatistics({ tasks: [{ id: 'Z', status: 'done', done }], changelog: 'broken' }, [], {
      from: T0,
      to: T0 + DAY / 2,
    });
    expect(empty.rightFirstTime).toMatchObject({ merged: 0, rate_pct: null, defects_per_10: null, interventions_per_10: null });
    expect(empty.reviewers).toEqual({ tasks: 0, rows: [], fix_rounds: 0, attributed: 0, hints: [] });
    // A result from before the quality figures (no such keys) still prints the old lines only.
    const { rightFirstTime, autonomy, reviewers, inflow, ...old } = ES.flowStatistics({ tasks: [] }, [], window);
    expect([rightFirstTime, autonomy, reviewers, inflow].every(Boolean)).toBe(true);
    expect(ES.flowLines(old, 'x')).toHaveLength(6);
  });
});

describe('reviewer hit rate', () => {
  const agent = (type: string, findings?: object) => ({ agent: 'a', type, usd: 1, ...(findings ? { findings } : {}) });

  it('runs, runs with findings, attributed fixes, dismissed, and runs without a FINDINGS line', () => {
    const queue = {
      tasks: [
        {
          id: 'A',
          status: 'done',
          done,
          resumed: [{ reason: 'fix', from: ['reviewer'] }, { reason: 'fix' }, { reason: 'context', from: ['reviewer-gap'] }],
          cost: {
            agents: [
              agent('track'),
              agent('reviewer', { H: 1, M: 0, L: 0 }),
              agent('reviewer', { H: 0, M: 0, L: 2 }),
              agent('reviewer-security', { H: 0, M: 0, L: 0 }),
              agent('reviewer-gap'),
            ],
          },
        },
        {
          id: 'B',
          status: 'done',
          done,
          cost: { agents: [agent('reviewer', { H: 0, M: 1, L: 0 }), agent('reviewer-docs', { H: 0, M: 0, L: 1 })] },
        },
        { id: 'OLD', status: 'done', done }, // measured before cost.agents existed: left out
        { id: 'OUT', status: 'done', done: at(-5 * DAY), cost: { agents: [agent('reviewer', { H: 3, M: 0, L: 0 })] } },
      ],
    };
    const rv = ES.flowStatistics(queue, [], { ...window, reviewerTypes: ['reviewer', 'reviewer-tests'] }).reviewers;
    expect(rv.tasks).toBe(2);
    expect(rv.fix_rounds).toBe(2); // the continuation is no fix round
    expect(rv.attributed).toBe(1);
    expect(rv.rows).toEqual([
      { type: 'reviewer', runs: 3, tasks: 2, with_findings: 3, no_line: 0, fixes: 1, dismissed: 2 },
      { type: 'reviewer-security', runs: 1, tasks: 1, with_findings: 0, no_line: 0, fixes: 0, dismissed: 0 },
      { type: 'reviewer-gap', runs: 1, tasks: 1, with_findings: 0, no_line: 1, fixes: 0, dismissed: 0 },
      { type: 'reviewer-docs', runs: 1, tasks: 1, with_findings: 1, no_line: 0, fixes: 0, dismissed: 1 },
    ]); // reviewer-tests had no run: no row
    expect(rv.hints).toEqual([]);
    const text = ES.flowLines(ES.flowStatistics(queue, [], window), 'x').join('\n');
    expect(text).toContain('reviewers (2 measured task(s); fix rounds attributed 1 of 2):');
    expect(text).toMatch(/reviewer-gap +1 run\(s\), 0 with findings, 0 led to a fix round, 0 dismissed, 1 without a FINDINGS line/);
  });

  it('the hint: at least 10 runs and 0 fixes, and only once fix rounds carry `from`', () => {
    const tasks = (n: number, withFrom: boolean) =>
      Array.from({ length: n }, (_, i) => ({
        id: `D${i}`,
        status: 'done',
        done,
        resumed: i === 0 ? [{ reason: 'fix', ...(withFrom ? { from: ['reviewer'] } : {}) }] : [],
        cost: { agents: [agent('reviewer-docs', { H: 0, M: 0, L: 1 }), agent('reviewer', { H: 1, M: 0, L: 0 })] },
      }));
    const hit = ES.reviewerStatistics({ tasks: tasks(ES.REVIEWER_HINT_RUNS, true) }, window);
    expect(hit.hints).toEqual(['reviewer-docs: 0 fixes in 10 runs']); // reviewer has its fix, so no hint
    expect(ES.flowLines(ES.flowStatistics({ tasks: tasks(10, true) }, [], window), 'x')).toContain(
      '  HINT reviewer-docs: 0 fixes in 10 runs',
    );
    // 9 runs: under the threshold.
    expect(ES.reviewerStatistics({ tasks: tasks(9, true) }, window).hints).toEqual([]);
    // No fix round says where it came from: no hint (every type would look useless), and the line says how to record it.
    const unknown = ES.reviewerStatistics({ tasks: tasks(10, false) }, window);
    expect(unknown.hints).toEqual([]);
    expect(ES.flowLines(ES.flowStatistics({ tasks: tasks(10, false) }, [], window), 'x').join('\n')).toContain(
      'fix rounds attributed 0 of 1, ravenseat resume --from records it',
    );
  });
});

describe('inflow by source', () => {
  it('splits the added tasks by source and ignores external rows and tasks outside the window', () => {
    const added = at(DAY);
    const queue = {
      tasks: [
        { id: 'O', added_at: added, added_by: 'owner' },
        { id: 'O2', added_at: added, added_by: 'theBoard' },
        { id: 'P', added_at: added, added_by: 'T-1', status: 'proposed' },
        { id: 'P2', added_at: added, added_by: 'rev-T-1', status: 'cancelled' },
        { id: 'AP', added_at: added, added_by: 'someone', approved: added },
        { id: 'X', added_at: added, added_by: 'owner', fixes: ['O'] },
        { id: 'BG', added_at: added, added_by: 'base gate' },
        { id: 'TR', added_at: added, added_by: 'ravenseat', plan: 'PL-FINDING-3' },
        { id: 'C', added_at: added, added_by: 'ravenseat' },
        { id: 'N', added_at: added }, // no added_by: other
        { id: 'E', added_at: added, external: true },
        { id: 'OLD', added_at: at(-30 * DAY), added_by: 'owner' },
      ],
    };
    const i = ES.flowStatistics(queue, [], window).inflow;
    expect(i.added).toBe(10);
    expect(i.by).toEqual({ owner: 2, agent: 3, fix: 2, triage: 1, other: 2 });
    expect(Object.keys(i.by)).toEqual(ES.INFLOW_SOURCES);
  });

  it('the hint when more came in than went out in each of the last 3 weeks, not when one week balanced', () => {
    const to = T0 + 21 * DAY;
    const week = (w: number, inN: number, outN: number) => [
      ...Array.from({ length: inN }, (_, k) => ({ id: `I${w}-${k}`, status: 'waiting', added_at: at(w * 7 * DAY + DAY) })),
      ...Array.from({ length: outN }, (_, k) => ({ id: `D${w}-${k}`, status: 'done', done: at(w * 7 * DAY + 2 * DAY) })),
    ];
    const growing = ES.inflowStatistics({ tasks: [...week(0, 3, 1), ...week(1, 2, 1), ...week(2, 4, 0)] }, { from: T0, to });
    expect(growing.weeks.map((w: { in: number; out: number }) => [w.in, w.out])).toEqual([
      [3, 1],
      [2, 1],
      [4, 0],
    ]);
    expect(growing.hint).toBe('inflow exceeded outflow 3 weeks in a row (added 3, 2, 4; done 1, 1, 0)');
    const text = ES.flowLines(
      ES.flowStatistics({ tasks: [...week(0, 3, 1), ...week(1, 2, 1), ...week(2, 4, 0)] }, [], { from: T0, to }),
      'x',
    ).join('\n');
    expect(text).toContain('last 3 weeks added/done 3/1, 2/1, 4/0');
    expect(text).toContain('HINT inflow exceeded outflow 3 weeks in a row');
    const balanced = ES.inflowStatistics({ tasks: [...week(0, 3, 1), ...week(1, 2, 2), ...week(2, 4, 0)] }, { from: T0, to });
    expect(balanced.hint).toBeNull();
    expect(ES.inflowStatistics({ tasks: [] }, { from: T0, to }).hint).toBeNull();
  });
});

describe('autonomy', () => {
  const H = 3_600_000;
  it('verified tasks per owner intervention: right first time or every defect fixed; "no interventions" at 0', () => {
    const queue = {
      tasks: [
        { id: 'OK', status: 'done', started: start, done },
        { id: 'R', status: 'done', started: start, done, resumed: [{ reason: 'fix' }] }, // fixed in its own round
        { id: 'F', status: 'done', started: start, done },
        { id: 'F-FIX', status: 'done', done, fixes: ['F'] }, // the defect is fixed
        { id: 'G', status: 'done', started: start, done },
        { id: 'G-FIX', status: 'waiting', fixes: ['G'] }, // still open: G is not verified
        { id: 'B', status: 'done', started: start, done },
        { id: 'B-1', status: 'done', done, plan: 'PL-FINDING-1' }, // the finding's task is done
        { id: 'Q', status: 'done', started: start, done, qa_status: 'deviation', qa_note: 'x' },
      ],
      changelog: [
        { nr: 1, at: at(DAY / 2), by: 'owner', action: 'edit', changes: [{ id: 'OK', field: 'value', before: 1, after: 2 }] },
        { nr: 2, at: at(DAY / 2), by: 'theBoard', action: 'park', changes: [{ id: 'G', field: 'parked', before: null, after: true }] },
      ],
    };
    const plans = { entries: [{ id: 'PL-FINDING-1', finding: { tasks: [], causes: ['B'] } }] };
    const f = ES.flowStatistics(queue, [], { ...window, plans });
    expect(f.rightFirstTime.interventions).toBe(2);
    expect(f.autonomy.verified).toBe(5); // OK, R, F, B, and B-1 (a merged task itself, right first time)
    expect(f.autonomy.verified_per_intervention).toBe(2.5);
    expect(ES.flowLines(f, 'x').join('\n')).toContain('verified tasks per owner intervention 2.5 (5 verified)');
    const { changelog, ...none } = queue;
    expect(changelog).toHaveLength(2);
    const g = ES.flowStatistics(none, [], { ...window, plans });
    expect(g.autonomy.verified_per_intervention).toBeNull();
    expect(ES.flowLines(g, 'x').join('\n')).toContain('verified tasks per owner intervention no interventions (5 verified)');
  });

  it('longest stretch: the union of the work spans, cut at owner actions; idle time and old tasks add nothing', () => {
    const queue = {
      tasks: [
        { id: 'A', status: 'done', started: at(0), done: at(10 * H) },
        { id: 'B', status: 'done', picked_at: at(5 * H), delivered: at(20 * H) }, // no done: delivered ends it
        { id: 'C', status: 'done', started: at(30 * H), done: at(32 * H) },
        { id: 'OLD', status: 'done', done: at(50 * H) }, // no start: no work time
        { id: 'X', status: 'running', started: at(60 * H), external: true }, // outside the queue
        { id: 'OWN', status: 'waiting', added_by: 'owner', added_at: at(8 * H) }, // an owner action at 8 h
      ],
    };
    // [0, 20] cut at 8 gives 8 h and 12 h; [30, 32] gives 2 h.
    expect(ES.longestStretch(queue, window) / H).toBe(12);
    expect(ES.flowStatistics(queue, [], window).autonomy.longest_stretch_h).toBe(12);
    // A running task runs to the window's end; an auto-accepted approval is no owner action, a hand approval is.
    const open = {
      tasks: [{ id: 'R', status: 'running', started: at(13 * DAY), approved: at(13 * DAY + 2 * H) }],
      auto_accepted: [{ id: 'R', at: at(13 * DAY + 2 * H) }],
    };
    expect(ES.longestStretch(open, window) / H).toBe(24);
    expect(ES.longestStretch({ ...open, auto_accepted: [] }, window) / H).toBe(22);
    expect(ES.longestStretch({ tasks: [] }, window)).toBe(0);
  });

  it('corrected without the owner: fix rounds, red done commands and base red fix tasks with no owner action', () => {
    const queue = {
      tasks: [
        {
          id: 'X',
          status: 'done',
          started: start,
          done,
          resumed: [{ reason: 'fix', from: ['reviewer'] }, { reason: 'fix', from: ['done_when'] }, { reason: 'context' }],
        },
        { id: 'Y', status: 'done', started: start, done, resumed: [{ reason: 'fix' }] }, // the owner edited it
        { id: 'W', status: 'done', started: start, done, resumed: [{ reason: 'fix' }, { reason: 'fix' }] }, // fix cap answer
        { id: 'Z', status: 'done', started: start, done, added_by: 'base gate', fixes: ['X'] },
        { id: 'Q', status: 'done', started: start, done, resumed: [{ reason: 'fix' }], qa_status: 'deviation', qa_note: 'n' },
        { id: 'OPEN', status: 'running', started: start, resumed: [{ reason: 'fix' }] }, // not done: not counted
        { id: 'OLD', status: 'done', done }, // no resumed field
      ],
      changelog: [
        { nr: 1, at: at(DAY / 2), by: 'owner', action: 'edit', changes: [{ id: 'Y', field: 'value', before: 1, after: 2 }] },
      ],
      resolved: ['W.fixcap2'],
    };
    const c = ES.flowStatistics(queue, [], window).autonomy.corrected;
    expect(c.fix_rounds).toEqual({ total: 5, without_owner: 1 }); // X's review round; Y, W x2 and Q had the owner
    expect(c.done_when).toEqual({ total: 1, without_owner: 1 });
    expect(c.base_fix).toEqual({ total: 1, without_owner: 1 });
    expect(c).toMatchObject({ total: 7, without_owner: 3 });
    expect(ES.flowLines(ES.flowStatistics(queue, [], window), 'x').join('\n')).toContain(
      'corrected without the owner 3 of 7 failure(s) (fix rounds 1/5, red done commands 1/1, base red fix tasks 1/1)',
    );
    // The done_when cause is no reviewer: it neither attributes a round nor gets a reviewer row.
    expect(ES.reviewerStatistics({ tasks: [{ ...queue.tasks[0], cost: { agents: [] } }] }, window).attributed).toBe(1);
    // Old data: nothing recorded, nothing corrected, no crash.
    expect(ES.flowStatistics({ tasks: [{ id: 'A', status: 'done', done }] }, [], window).autonomy).toMatchObject({
      verified: 1,
      verified_per_intervention: null,
      longest_stretch_h: 0,
      corrected: { total: 0, without_owner: 0 },
    });
  });
});
