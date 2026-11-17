// =============================================================
// guardRegistry.js: the guard registry, a tracked, structured list of the guards a project has built and what each one
// guards against. The file is the project's own (inspection.registryFile, default .ravenseat/guards.json), committed
// like queue.config.json, so a guard and its entry are merged together and every clone sees the same list.
//
// Why: a gate, an instruction line or a review point is added after a failure, and a year later nobody knows why it is
// there, whether it ever caught anything, or whether it can go. One entry per guard keeps the reason next to it, and the
// `measures` object gives later measurements a place without a new format.
//
// An entry:
//   id         G-<n>
//   title      a short name
//   explain    one plain sentence for the dashboard
//   kind       gate | instruction | review | none ("none" records a decision that a failure needs no guard)
//   against    { signature, lesson, class?, area? }: the failure signature it guards against (lib/failureSignature.js),
//              a free text lesson for one that came from elsewhere, and/or the failure class (lib/failureClasses.js, the
//              project's own classes too) with the area it covers (`guards add --class <id> --area <area>`; no area, or
//              --area '*', covers the whole project). The repeat count reads class and area (lib/findingRepeats.js
//              guardsFrom: a new incident of the class there after the guard was built is "guard failed"). The file is
//              tracked, so an entry holds the class, the area and its one sentence only, never an excerpt (0i 3.11).
//              class and area are written only when a class is given, so an older entry keeps its shape.
//   command    the gate command, for kind gate (optional): the measures match it against the gate rows
//   task       the task that built it (an inspection proposal INSP-<n>, or any task), or null
//   built      the date (YYYY-MM-DD, UTC)
//   status     active | retired (a retired entry stays, so the history is kept)
//   measures   { runs, redRuns, caughtSince, lastRed }: reserved for measurements, null in the file. Ravenseat fills them
//              when it shows the registry (withMeasures, from the gate rows of the time log) and never writes them back,
//              so the tracked file does not change on every gate run. For a gate entry with a command:
//                runs         gate runs of the command since it was built
//                redRuns      red runs of the command in the whole time log
//                caughtSince  red runs since it was built (each one a time the guard caught something)
//                lastRed      the time of the last red run
//              More keys can be added later (a sabotage result: CATCHES, PARTIAL or BLIND when the guarded code is broken
//              on purpose in a worktree) without a migration: readers ignore what they do not know, and unknown fields
//              in an entry are kept as they are.
//
// Pure functions without I/O; cli/guards.mjs reads and writes the file. Tested in lib/__tests__/guardRegistry.test.ts.
// =============================================================
'use strict';

/** The registry's default place in the project (inspection.registryFile in queue.config.json overrides). */
const DEFAULT_FILE = '.ravenseat/guards.json';
const KINDS = Object.freeze(['gate', 'instruction', 'review', 'none']);
const STATUSES = Object.freeze(['active', 'retired']);
const TITLE_MAX = 100;
const EXPLAIN_MAX = 240;
const LESSON_MAX = 300;
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/;
/** An area is a path or a folder as the finding log names it: one plain line of at most this many characters. */
const AREA_MAX = 200;
/** The area for the whole project (stored as null: a guard without an area covers every area). */
const PROJECT_AREA = '*';
/** The source a gate task proposed from the finding log carries (lib/findingRepeats.js proposalTask). */
const LOG_SOURCE = /^finding-log ([a-z0-9-]+)@(.+)$/;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v) => (typeof v === 'string' ? v.trim() : '');
const emptyMeasures = () => ({ runs: null, redRuns: null, caughtSince: null, lastRed: null });

/** A registry with no entries. */
const empty = () => ({ version: 1, guards: [] });

/**
 * The registry from the file's text. A missing file (null) is an empty registry; a broken one is an error, never an
 * empty list, so `guards add` cannot overwrite entries it could not read.
 * @returns {{ registry: object, error: string|null }}
 */
function parse(raw) {
  if (raw == null) return { registry: empty(), error: null };
  try {
    const v = JSON.parse(String(raw).replace(/^﻿/, ''));
    if (!isObject(v) || !Array.isArray(v.guards)) return { registry: empty(), error: 'the file has no "guards" list' };
    return { registry: { ...v, version: v.version ?? 1, guards: v.guards.filter(isObject) }, error: null };
  } catch (e) {
    return { registry: empty(), error: `the file is not valid JSON (${e.message})` };
  }
}

/** The file's text: 2-space JSON with LF and a final newline, so a diff shows one entry per change. */
const serialize = (registry) => `${JSON.stringify(registry, null, 2)}\n`;

/** The next free G-<n>. */
function nextId(registry) {
  const numbers = (registry?.guards ?? []).map((g) => /^G-(\d+)$/.exec(g?.id ?? '')?.[1]).filter(Boolean).map(Number);
  return `G-${Math.max(0, ...numbers) + 1}`;
}

/**
 * The errors in the class and area of a new entry. The class must be one of `classes` (the core ones and the project's
 * own, lib/failureClasses.js classesFor) and never `other`: the repeat count never counts `other`, so such a guard could
 * never be seen to fail. An area needs a class, and is one plain line that does not start with a dash.
 */
function classErrors(against, classes) {
  const error = [];
  const cls = against.class;
  const area = against.area;
  if (cls != null && cls !== '') {
    const FC = require('./failureClasses.js');
    const list = Array.isArray(classes) && classes.length ? classes : FC.coreClasses();
    const shown = String(cls).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 40);
    if (typeof cls !== 'string') error.push('class must be text');
    else if (cls === FC.OTHER) error.push('class other cannot be guarded against: the repeat count never counts it (name the class, or use --against)');
    else if (!list.some((c) => c.id === cls)) error.push(`class ${shown} is not a failure class here (${list.map((c) => c.id).filter((id) => id !== FC.OTHER).join(', ')})`);
  }
  if (area != null && area !== '') {
    if (cls == null || cls === '') error.push('an area needs its class (--class <id> --area <area>)');
    if (typeof area !== 'string') error.push('area must be text');
    else if (/[\r\n]/.test(area)) error.push('area must be one line');
    else if (/[\u0000-\u001f\u007f]/.test(area) || area.trim().startsWith('-') || area.trim().length > AREA_MAX)
      error.push(`area must be a path or a folder of at most ${AREA_MAX} characters, not starting with -`);
  }
  return error;
}

/** The errors in one new entry (empty = valid). */
function entryErrors(input, registry, { classes } = {}) {
  const error = [];
  const oneLine = (k, max) => {
    const v = input?.[k];
    if (v == null || v === '') return;
    if (typeof v !== 'string') error.push(`${k} must be text`);
    else if (/[\r\n]/.test(v)) error.push(`${k} must be one line`);
    else if (v.trim().length > max) error.push(`${k} must be at most ${max} characters`);
  };
  if (!text(input?.title)) error.push('a title is needed (--title "...")');
  if (!text(input?.explain)) error.push('a one-sentence explanation is needed (--explain "...")');
  oneLine('title', TITLE_MAX);
  oneLine('explain', EXPLAIN_MAX);
  if (!KINDS.includes(input?.kind)) error.push(`kind must be one of ${KINDS.join(', ')} (--kind)`);
  const against = isObject(input?.against) ? input.against : {};
  if (!text(against.signature) && !text(against.lesson) && !text(against.class))
    error.push('say what it guards against: a failure class (--class <id>), a failure signature (--signature) or a lesson (--against "...")');
  if (against.lesson != null && /[\r\n]/.test(String(against.lesson))) error.push('against must be one line');
  error.push(...classErrors(against, classes));
  if (input?.command != null && input.command !== '' && (typeof input.command !== 'string' || /[\r\n]/.test(input.command)))
    error.push('command must be one line');
  if (input?.task != null && input.task !== '') {
    if (!TASK_ID.test(String(input.task))) error.push(`task ${input.task} is not a task id`);
    else if ((registry?.guards ?? []).some((g) => g?.task === input.task && g?.status !== 'retired'))
      error.push(`task ${input.task} already has an entry in the registry`);
  }
  return error;
}

/**
 * Adds one entry (mutates `registry`).
 * @param {object} registry
 * @param {{ title: string, explain: string, kind: string,
 *   against: { signature?: string, lesson?: string, class?: string, area?: string },
 *   command?: string, task?: string, built?: string }} input
 * @param {{ now?: string, classes?: { id: string }[] }} [o]  classes: the project's failure classes (the core ones when
 *   left out), which a class must be one of
 * @returns {{ error: string[], guard?: object }}
 */
function addGuard(registry, input, { now = new Date().toISOString(), classes } = {}) {
  const error = entryErrors(input, registry, { classes });
  if (error.length) return { error };
  const against = isObject(input.against) ? input.against : {};
  const lesson = text(against.lesson);
  const cls = text(against.class);
  const area = text(against.area);
  const guard = {
    id: nextId(registry),
    title: text(input.title),
    explain: text(input.explain),
    kind: input.kind,
    against: {
      signature: text(against.signature) || null,
      lesson: lesson ? lesson.slice(0, LESSON_MAX) : null,
      // Only with a class, so an entry without one keeps the shape it had (see the header).
      ...(cls ? { class: cls, area: area && area !== PROJECT_AREA ? area : null } : {}),
    },
    command: text(input.command) || null,
    task: text(input.task) || null,
    built: /^\d{4}-\d{2}-\d{2}/.test(String(input.built ?? '')) ? String(input.built).slice(0, 10) : String(now).slice(0, 10),
    status: 'active',
    measures: emptyMeasures(),
  };
  registry.guards.push(guard);
  return { error: [], guard };
}

/** Marks an entry retired (mutates `registry`); the error text or null. */
function retire(registry, id) {
  const g = (registry?.guards ?? []).find((x) => x?.id === id);
  if (!g) return `no guard ${id} in the registry (ravenseat guards lists them)`;
  g.status = 'retired';
  return null;
}

/**
 * The add input a task gives: the task, a title from the task's ("Guard: " or "Gate: " dropped), and what it guards
 * against. An inspection task gives its signature and the failure as the lesson; a gate task proposed from the finding
 * log gives the class and area of its source (`finding-log <class>@<area>`, `*` is the whole project), so the entry
 * holds them even when the track leaves out --class and --area. The kind and the explanation come from whoever adds it.
 */
function fromTask({ task, entry }) {
  const title = String(task?.title ?? '').replace(/^(?:guard|gate):\s*/i, '').trim();
  const m = LOG_SOURCE.exec(String(task?.source ?? ''));
  return {
    task: task?.id ?? null,
    title: title.slice(0, TITLE_MAX),
    against: {
      signature: entry?.id ?? null,
      lesson: entry ? `${entry.name}${entry.excerpt ? `: ${entry.excerpt}` : ''}`.slice(0, LESSON_MAX) : null,
      ...(m ? { class: m[1], area: m[2] === PROJECT_AREA ? null : m[2] } : {}),
    },
  };
}

const ms = (t) => {
  const v = Date.parse(t ?? '');
  return Number.isFinite(v) ? v : null;
};

/** The measures of one entry from the gate rows (see the header); the stored ones for anything that is not a gate. */
function measuresFor(guard, rows) {
  const stored = isObject(guard?.measures) ? guard.measures : {};
  if (guard?.kind !== 'gate' || !text(guard.command)) return { ...emptyMeasures(), ...stored };
  const since = ms(guard.built) ?? 0;
  let runs = 0;
  let redRuns = 0;
  let caughtSince = 0;
  let lastRed = null;
  for (const r of rows ?? []) {
    if (r?.event !== 'gate' || !Array.isArray(r.gates) || !r.gates.includes(guard.command)) continue;
    const t = ms(r.time);
    const red = Array.isArray(r.failed) && r.failed.includes(guard.command);
    const after = t != null && t >= since;
    if (after) runs++;
    if (!red) continue;
    redRuns++;
    if (after) caughtSince++;
    if (t != null && (lastRed == null || t > ms(lastRed))) lastRed = r.time;
  }
  return { ...emptyMeasures(), ...stored, runs, redRuns, caughtSince, lastRed };
}

/** Copies of the entries with the measures filled in (the registry is not changed). */
function withMeasures(registry, rows) {
  return (registry?.guards ?? []).map((g) => ({ ...g, measures: measuresFor(g, rows) }));
}

/** One line of measures, or null when there are none. */
function measureText(m) {
  if (!isObject(m) || m.runs == null) return null;
  const times = (n) => `${n} time${n === 1 ? '' : 's'}`;
  return (
    `caught ${times(m.caughtSince ?? 0)} since built (${m.runs} run(s))` +
    `${m.lastRed ? `, last red ${String(m.lastRed).slice(0, 10)}` : ''}`
  );
}

/** The lines for `ravenseat guards`. */
function lines(registry, rows, { cli = 'ravenseat', file = DEFAULT_FILE } = {}) {
  const list = withMeasures(registry, rows);
  if (!list.length)
    return [
      `No guards in the registry (${file}) yet.`,
      `An inspection proposal adds one when its task is built; add one by hand: ${cli} guards add --kind <${KINDS.join('|')}> --title "..." --explain "..." --against "<lesson>" (or --class <failure class> [--area <path>])`,
    ];
  const out = [`Guards (${file}):`];
  for (const g of list) {
    out.push(`  ${g.id}  [${g.kind}] ${g.title} (${g.status}, built ${g.built}${g.task ? ` by ${g.task}` : ''})`);
    out.push(`      ${g.explain}`);
    const cls = g.against?.class ? `class ${g.against.class} ${g.against.area ? `in ${g.against.area}` : 'across the project'}` : null;
    const against = [cls, g.against?.lesson, g.against?.signature ? `signature ${g.against.signature}` : null].filter(Boolean).join('; ');
    if (against) out.push(`      against: ${against}`);
    if (g.command) out.push(`      command: ${g.command}`);
    const m = measureText(g.measures);
    if (m) out.push(`      ${m}`);
  }
  return out;
}

/** The board's part (the Checks tab): the entries with their measures. */
function boardData(registry, rows) {
  return {
    guards: withMeasures(registry, rows).map((g) => ({
      id: g.id,
      title: g.title,
      explain: g.explain,
      kind: g.kind,
      status: g.status,
      built: g.built,
      task: g.task ?? null,
      command: g.command ?? null,
      against: g.against ?? null,
      measures: g.measures,
    })),
  };
}

module.exports = {
  DEFAULT_FILE,
  KINDS,
  STATUSES,
  empty,
  parse,
  serialize,
  nextId,
  addGuard,
  retire,
  fromTask,
  measuresFor,
  withMeasures,
  measureText,
  lines,
  boardData,
};
