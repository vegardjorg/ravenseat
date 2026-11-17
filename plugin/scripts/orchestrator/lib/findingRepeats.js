// =============================================================
// findingRepeats.js: the repeat count on class and area over the finding log, "guard failed", and the gate proposal that
// comes from it (step 7 of the finding format, plans/funnformat-0i-0j-2026-11-15.md section 6 row 7; 0i sections 3.6 and
// 3.9). Pure functions without I/O: cli/inspection.mjs and cli/checks.mjs read the files.
//
// Why: the inspection queue counts one failure signature (the same red command with the same first line). The same
// kind of mistake in the same part of the code, caught by review one week and by a gate the next, has no common
// signature, so nobody sees that it keeps coming back. The finding log has one row per finding with its class and area;
// this file counts them, in plain JS (no tokens, milliseconds).
//
// WHAT COUNTS (eligible): a row with counts true (lib/findingLog.js: false for L and for `other`), confidence not low,
// and a class that is not `other`. Low confidence and `other` never count toward a proposal, whatever the row says.
//
// INCIDENTS: the rows of one task are one incident (a track's red-fix-red loop is not a pattern); a row without a task is
// its own. An incident weighs 2 when one of its rows is a fix without a proven red test (fixedWithoutTest), else 1.
// The verdict is read from test_added again here, not from the stored status: a row from before step 6 has test_added
// as a path or a list, which is read as verdict null and weighs 1 (owner decision 2026-11-16).
//
// DUE (0i section 3.6, owner decision 7: 90 days):
//   area     at least 2 incidents of the class in one area within windowDays, weighing at least areaRepeats (2);
//   project  at least 2 incidents of the class in the whole project, weighing at least projectRepeats (3), when no
//            single area is due for it. The double weight matters here: an untested fix and one more is enough.
// A repeat always needs two incidents: one untested fix alone is a fix without a test (step 6 warns about it), not a
// pattern, so it never makes a proposal by itself.
//
// GUARD FAILED (0i section 3.6, owner decision 8: the red marker, by default; learning.guardFailedMarker off keeps the
// card at medium without it): an incident of the class in an area, within the
// window, after one of these had been in place there:
//   guard        an active guard for the class (a registry entry with against.class, or a done gate task proposed from
//                the log for the class and area, guardsFrom), or the row itself names the guard it was seen under;
//   fix          an earlier fix in another task with a proven red test (the test was the guard, and it did not hold);
//   untested-h   an earlier fix without a proven test, when it or the new incident is H (0i section 3.9).
// A plain repeat is not a guard failure: a review finding fixed in its round is no guard. It is resolved, and the red
// marker goes out, when a newer guard for the class and area is in place after it, or a later fix (also the incident
// itself) comes with a proven red test. So the marker means "a guard did not hold and nothing new holds yet".
//
// THE PROPOSAL: a due entry becomes a gate task (lib/knownBugGate.js gateTask) titled per class and area, so
// knownBugGate.decide finds the same one again: open = the new place is added, done = it exists, cancelled = declined
// (a no is remembered per class and area). It is always proposed, never approved here, also with gates.fromKnownBugs
// auto: proposals from the log are opt-in (learning.proposals, off by default) and share one cap of 3 with the
// inspection queue and the GATE proposals (knownBugGate.sharedProposals).
//
// Tested in lib/__tests__/findingRepeats.test.ts and __tests__/findingRepeatsFlow.test.ts.
// =============================================================
'use strict';

const G = require('./knownBugGate.js');
const FC = require('./failureClasses.js');

/** The settings' defaults (lib/queueConfig.js STANDARD.learning holds the same values). */
const DEFAULTS = Object.freeze({ repeats: true, windowDays: 90, areaRepeats: 2, projectRepeats: 3, guardFailedMarker: true, proposals: false });
const ONOFF = ['repeats', 'guardFailedMarker', 'proposals'];
const NUMBERS = ['windowDays', 'areaRepeats', 'projectRepeats'];
/** The scope drift cards' rule (plans/scope-drift-dry-katalog-2026-11-15.md): 3 in one area within 30 days. */
const RECENT_DAYS = 30;
/** The verdicts of an untested fix (lib/fixTests.js UNTESTED). */
const UNTESTED = Object.freeze(['no-tests', 'unproven']);
/** The label a gate task proposed from the log carries, besides `gate`. */
const LABEL = 'finding-log';
/** The area of a project-wide entry. */
const PROJECT = '*';
/** Example tasks kept per entry. */
const MAX_TASKS = 5;
const DAY_MS = 86_400_000;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const whole = (v, standard) => (Number.isInteger(v) && v >= 1 ? v : standard);
const ms = (t) => {
  const v = typeof t === 'number' ? t : Date.parse(t ?? '');
  return Number.isFinite(v) ? v : null;
};
const RANK = { H: 0, M: 1, L: 2 };

/** The learning setup from config().learning; a value that is not the right type is the default. */
function setupOf(cfg = {}) {
  const own = isObject(cfg?.learning) ? cfg.learning : {};
  const out = {};
  for (const k of ONOFF) out[k] = typeof own[k] === 'boolean' ? own[k] : DEFAULTS[k];
  for (const k of NUMBERS) out[k] = whole(own[k], DEFAULTS[k]);
  return out;
}

/** The problems in config().learning, for doctor (texts, empty when valid). */
function setupProblems(own) {
  if (own === undefined) return [];
  if (!isObject(own)) return ['learning must be an object'];
  const out = [];
  for (const k of ONOFF) if (own[k] !== undefined && typeof own[k] !== 'boolean') out.push(`learning.${k} must be true or false`);
  for (const k of NUMBERS)
    if (own[k] !== undefined && !(Number.isInteger(own[k]) && own[k] >= 1)) out.push(`learning.${k} must be a whole number of 1 or more`);
  return out;
}

/** The red on base verdict of a row: only the object form { verdict } has one; a path or a list (before step 6) is null. */
function testVerdict(row) {
  const t = row?.test_added;
  return isObject(t) && typeof t.verdict === 'string' ? t.verdict : null;
}

/** A fix without a proven red test (lib/findingLog.js status fixed-without-test, derived again from the verdict). */
const fixedWithoutTest = (row) => !!row?.fix && UNTESTED.includes(testVerdict(row));
/** A fix with a proven red test: the test is a guard from then on. */
const provenFix = (row) => !!row?.fix && testVerdict(row) === 'proven';
const weightOf = (row) => (fixedWithoutTest(row) ? 2 : 1);

/** Does the row count toward a repeat (see WHAT COUNTS)? */
function eligible(row) {
  return (
    isObject(row) &&
    row.counts === true &&
    row.confidence !== 'low' &&
    typeof row.class === 'string' &&
    !!row.class &&
    row.class !== FC.OTHER &&
    ms(row.time) != null
  );
}

const areaOf = (row) => {
  const a = row?.where?.area;
  return typeof a === 'string' && a && a !== '-' ? a : null;
};

/** The rows as incidents (one per task, a row without a task alone), newest first. */
function incidentsOf(rows) {
  const per = new Map();
  for (const r of rows) {
    const key = r.task ? `task:${r.task}` : `row:${r.id}`;
    if (!per.has(key)) per.set(key, { key, task: r.task ?? null, rows: [] });
    per.get(key).rows.push(r);
  }
  return [...per.values()]
    .map((i) => {
      const list = i.rows.sort((a, b) => ms(b.time) - ms(a.time));
      return {
        ...i,
        rows: list,
        t: ms(list[0].time),
        first: ms(list[list.length - 1].time),
        weight: Math.max(...list.map(weightOf)),
        severity: list.map((r) => r.severity).sort((a, b) => (RANK[a] ?? 9) - (RANK[b] ?? 9))[0] ?? null,
      };
    })
    .sort((a, b) => b.t - a.t);
}

/** Does a guard cover the class in the area? A guard without an area covers every area. */
const covers = (g, cls, area) => g?.class === cls && (g.area == null || g.area === area);

/**
 * The newest guard failure in one class and area that nothing newer has resolved (see GUARD FAILED), or null.
 * @param {object[]} all  every eligible row of the class in the area (also older than the window)
 * @param {object[]} recent  the incidents in the window, newest first
 */
function guardFailureOf(all, recent, { cls, area, guards }) {
  const history = incidentsOf(all);
  for (const inc of recent) {
    // Resolved: a guard put in place after it, or a later fix (or this one) with a proven red test.
    if (guards.some((g) => covers(g, cls, area) && ms(g.since) != null && ms(g.since) > inc.t)) continue;
    if (history.some((h) => h.t >= inc.t && h.rows.some(provenFix))) continue;
    const named = inc.rows.find((r) => typeof r.guard === 'string' && r.guard);
    if (named) return { inc, reason: 'guard', ref: named.guard };
    const g = guards
      .filter((x) => covers(x, cls, area) && ms(x.since) != null && ms(x.since) < inc.t)
      .sort((a, b) => ms(b.since) - ms(a.since))[0];
    if (g) return { inc, reason: 'guard', ref: g.id };
    const before = history.filter((h) => h.key !== inc.key && h.t < inc.t);
    const fixed = before.find((h) => h.rows.some(provenFix));
    if (fixed) return { inc, reason: 'fix', ref: fixed.task ?? fixed.rows[0].id };
    const untested = before.find((h) => h.rows.some(fixedWithoutTest) && (h.severity === 'H' || inc.severity === 'H'));
    if (untested) return { inc, reason: 'untested-h', ref: untested.task ?? untested.rows[0].id };
  }
  return null;
}

/** One entry from the incidents in the window. */
function entryOf(cls, area, scope, incidents, guardFailed, setup) {
  const latest = incidents[0];
  const place = latest.rows.find((r) => (r.where?.files ?? []).length) ?? latest.rows[0];
  const weight = incidents.reduce((s, i) => s + i.weight, 0);
  const threshold = scope === 'area' ? setup.areaRepeats : setup.projectRepeats;
  return {
    key: `${cls}@${area}`,
    class: cls,
    area,
    scope,
    incidents: incidents.length,
    weight,
    severity: incidents.map((i) => i.severity).sort((a, b) => (RANK[a] ?? 9) - (RANK[b] ?? 9))[0] ?? null,
    tasks: [...new Set(incidents.map((i) => i.task).filter(Boolean))].slice(0, MAX_TASKS),
    files: place?.where?.files ?? [],
    line: place?.where?.line ?? null,
    firstSeen: new Date(Math.min(...incidents.map((i) => i.first))).toISOString(),
    lastSeen: new Date(latest.t).toISOString(),
    due: incidents.length >= 2 && weight >= threshold,
    guardFailed: guardFailed ? { reason: guardFailed.reason, ref: guardFailed.ref, task: guardFailed.inc.task, time: new Date(guardFailed.inc.t).toISOString() } : null,
  };
}

/**
 * The repeat count over the rows.
 * @param {object[]} rows  the finding log rows (lib/findingLog.js read), any order; older ones help find guards
 * @param {{ now?: number, setup?: object, guards?: { id: string, class: string, area: string|null, since: number }[] }} [o]
 * @returns {{ entries: object[], due: object[], guardFailed: object[] }}
 */
function scan(rows, { now = Date.now(), setup, guards = [] } = {}) {
  const s = setup ?? setupOf({});
  if (!s.repeats) return { entries: [], due: [], guardFailed: [] };
  const from = now - s.windowDays * DAY_MS;
  const inWindow = (r) => ms(r.time) >= from && ms(r.time) <= now + DAY_MS;
  const perClass = new Map();
  for (const r of (Array.isArray(rows) ? rows : []).filter(eligible)) {
    if (!perClass.has(r.class)) perClass.set(r.class, []);
    perClass.get(r.class).push(r);
  }
  const entries = [];
  for (const [cls, list] of perClass) {
    const perArea = new Map();
    for (const r of list) {
      const area = areaOf(r);
      if (!area) continue;
      if (!perArea.has(area)) perArea.set(area, []);
      perArea.get(area).push(r);
    }
    let areaDue = false;
    for (const [area, all] of perArea) {
      const recent = incidentsOf(all.filter(inWindow));
      if (!recent.length) continue;
      const failed = guardFailureOf(all, recent, { cls, area, guards: Array.isArray(guards) ? guards : [] });
      const e = entryOf(cls, area, 'area', recent, failed, s);
      areaDue ||= e.due;
      entries.push(e);
    }
    const recent = incidentsOf(list.filter(inWindow));
    if (!areaDue && recent.length) {
      const e = entryOf(cls, PROJECT, 'project', recent, null, s);
      if (e.due) entries.push(e);
    }
  }
  const order = (a, b) => b.weight - a.weight || b.incidents - a.incidents || b.lastSeen.localeCompare(a.lastSeen) || a.key.localeCompare(b.key);
  entries.sort(order);
  return { entries, due: entries.filter((e) => e.due), guardFailed: entries.filter((e) => e.guardFailed) };
}

/** The entry as the Checks tab reads it: the class with its title, never an excerpt. */
const summary = (e, classes) => ({
  class: e.class,
  title: FC.titleOf(e.class, classes),
  area: e.area,
  scope: e.scope,
  incidents: e.incidents,
  weight: e.weight,
  severity: e.severity,
  tasks: e.tasks,
  lastSeen: e.lastSeen,
  guardFailed: e.guardFailed,
});

/**
 * The facts for lib/checksCatalog.js (facts.ledger): what is due, what failed, the marker setting, and `recent` (per
 * class, the most incidents in one area within RECENT_DAYS, for the scope drift cards' important_when).
 */
function facts(result, { rows = [], now = Date.now(), setup, classes } = {}) {
  const s = setup ?? setupOf({});
  const out = { due: [], guardFailed: [], marker: s.guardFailedMarker, recent: {} };
  if (!s.repeats) return out;
  out.due = (result?.due ?? []).map((e) => summary(e, classes));
  out.guardFailed = (result?.guardFailed ?? []).map((e) => summary(e, classes));
  const from = now - RECENT_DAYS * DAY_MS;
  const per = new Map();
  for (const r of (Array.isArray(rows) ? rows : []).filter((x) => eligible(x) && ms(x.time) >= from && areaOf(x))) {
    const key = `${r.class}\u0000${areaOf(r)}`;
    if (!per.has(key)) per.set(key, { cls: r.class, rows: [] });
    per.get(key).rows.push(r);
  }
  for (const { cls, rows: list } of per.values()) out.recent[cls] = Math.max(out.recent[cls] ?? 0, incidentsOf(list).length);
  return out;
}

const capital = (s) => (s ? `${s[0].toUpperCase()}${s.slice(1)}` : s);

/** The gate title for an entry, per class and area, so knownBugGate.decide matches the same one again. */
function gateTitle(e, classes) {
  const title = capital(FC.titleOf(e.class, classes));
  return e.area === PROJECT || e.scope === 'project' ? `${title} across the project` : `${title} in ${e.area}`;
}

/**
 * The gate task for a due entry, ready for `ravenseat add` (added_by makes it proposed; it is never added approved).
 * @param {object} e  a due entry from scan
 * @param {{ id: string, classes?: object[] }} o
 */
function proposalTask(e, { id, classes } = {}) {
  const title = gateTitle(e, classes);
  const where = e.files?.length ? `${e.files[0]}${e.line ? `:${e.line}` : ''}` : null;
  const detail =
    `the finding log has ${e.incidents} incident(s) of this class here in separate tasks (${e.tasks.join(', ') || 'no task'}), ` +
    `from ${String(e.firstSeen).slice(0, 10)} to ${String(e.lastSeen).slice(0, 10)}`;
  const task = G.gateTask({ id, title, whole: `${title} (class ${e.class})`, from: e.tasks[0] ?? null, where, detail });
  return { ...task, labels: [...task.labels, LABEL], source: `finding-log ${e.key}` };
}

/**
 * The guards for guard failed (see GUARD FAILED): active registry entries that name their class (against.class, and
 * against.area when one is given), and done gate tasks proposed from the log (their source names class and area).
 * @param {{ registry?: { guards?: object[] }, tasks?: object[] }} x
 */
function guardsFrom({ registry = null, tasks = [] } = {}) {
  const out = [];
  for (const g of Array.isArray(registry?.guards) ? registry.guards : []) {
    const cls = g?.against?.class;
    if (g?.status === 'retired' || typeof cls !== 'string' || !cls) continue;
    const area = typeof g.against.area === 'string' && g.against.area ? g.against.area : null;
    out.push({ id: String(g.id), class: cls, area, since: ms(g.built) ?? 0 });
  }
  for (const o of Array.isArray(tasks) ? tasks : []) {
    if (o?.status !== 'done' || !Array.isArray(o.labels) || !o.labels.includes(LABEL)) continue;
    const m = /^finding-log ([a-z0-9-]+)@(.+)$/.exec(String(o.source ?? ''));
    if (!m) continue;
    out.push({ id: String(o.id), class: m[1], area: m[2] === PROJECT ? null : m[2], since: ms(o.done ?? o.merged) ?? 0 });
  }
  return out;
}

module.exports = {
  DEFAULTS,
  LABEL,
  RECENT_DAYS,
  setupOf,
  setupProblems,
  testVerdict,
  fixedWithoutTest,
  weightOf,
  eligible,
  scan,
  facts,
  gateTitle,
  proposalTask,
  guardsFrom,
};
