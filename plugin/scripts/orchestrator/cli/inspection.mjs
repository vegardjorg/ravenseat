// =============================================================
// cli/inspection.mjs: the inspection queue and the guard registry.
//
//   ravenseat inspection [--json]                 scans the time log for failures that repeat (lib/failureSignature.js,
//                                                 lib/inspection.js), proposes a guard for each one over the threshold
//                                                 (a `proposed` task INSP-<n>; the owner approves, cancels or snoozes it)
//                                                 and lists the entries. The state is <dataFolder>/inspection.json.
//   ravenseat inspection snooze <id> [--days 14]  holds an entry (by its proposal task or its signature) until a date,
//                                                 and cancels its proposal
//   ravenseat guards [--json]                     the guard registry (lib/guardRegistry.js) with the measures from the
//                                                 gate rows
//   ravenseat guards add [--from-task <id>] --kind gate|instruction|review|none --title "..." --explain "..."
//        [--command "<gate command>"] [--against "<lesson>"] [--signature <id>] [--task <id>]
//                                                 adds an entry to the registry file in THIS tree (a track's worktree:
//                                                 the entry is merged with the change). --from-task fills the task, the
//                                                 title and what it guards against from an inspection proposal.
//   ravenseat guards retire <id>                  marks an entry retired (it stays in the file)
//
// The pulse (cli/orchestrator.mjs) runs the same scan at most once an hour (inspectionPulseLines). Nothing here builds,
// approves or runs anything: a proposal waits for the owner like any other. Tested in __tests__/inspectionFlow.test.ts.
// =============================================================

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { a, CLI, CONFIG, die, FILE, FOLDER, HERE, LM, MAIN_TREE, read, require, ROOT, TIME_LOG, val } from './context.mjs';
import { addTask, ensureProject } from './kickstart.mjs';

const I = require('./lib/inspection.js');
const GR = require('./lib/guardRegistry.js');
const FS = require('./lib/failureSignature.js');
const QA = require('./lib/queueArchive.js');

const STATE_FILE = path.join(FOLDER, 'inspection.json');
const QUEUE_PATH = path.join(HERE, 'queue.mjs');
const DAY_MS = 86_400_000;
/** The pulse scans at most this often. */
const PULSE_EVERY_MS = 60 * 60_000;

const setup = () => I.setupOf(CONFIG);
const registryRel = () => String(CONFIG.inspection?.registryFile || GR.DEFAULT_FILE);
const registryIn = (tree) => path.join(tree, registryRel());

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null; // missing or broken: the scan rebuilds it from the time log
  }
}

/** Writes a file atomically (a temporary file and a rename), with LF. */
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

const readState = () => readJson(STATE_FILE);
const saveState = (state) => writeAtomic(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);

/** The registry in a tree. A broken file stops a write, never a read: a read shows it as empty with the problem. */
function readRegistry(tree) {
  const file = registryIn(tree);
  let raw = null;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    raw = null;
  }
  return { file, ...GR.parse(raw) };
}

/** The gate and ciWatch rows of the time log from `fromMs` (null = the whole history). */
function timeRows(fromMs) {
  try {
    return FS.rowsFromText(require('./lib/timeLogArchive.js').readText(TIME_LOG, { from: fromMs }));
  } catch {
    return []; // no log yet
  }
}

/** The tasks in the queue and in the archive. */
function allTasks() {
  const queue = fs.existsSync(FILE) ? read() : { tasks: [] };
  const archived = {};
  for (const o of QA.load(FOLDER).tasks) archived[o.id] = o;
  return { tasks: queue.tasks ?? [], archived };
}

/**
 * One scan: the entries from the time log, and a proposal for each due one. Returns the new state and the proposals
 * added ({ id, entry }), plus the add errors.
 */
function scanAndPropose({ now = Date.now() } = {}) {
  const s = setup();
  const { tasks, archived } = allTasks();
  const occurrences = FS.occurrences(timeRows(now - s.windowDays * DAY_MS));
  const { state, due } = I.scan(readState(), { occurrences, tasks, archived, now, setup: s });
  const added = [];
  const errors = [];
  if (due.length && fs.existsSync(FILE)) {
    const lite = LM.isLite(CONFIG);
    if (!lite) ensureProject();
    const known = [...tasks, ...Object.values(archived)];
    for (const entry of due) {
      const id = I.nextId(known);
      const task = { ...I.proposalTask({ id, entry, cli: CLI, lite, registryFile: registryRel() }), ...(lite ? {} : { project: 'cicd' }) };
      const r = addTask(task);
      if (!r.ok) {
        errors.push(`${entry.id}: ${r.output}`);
        continue;
      }
      known.push({ id });
      I.recordProposal(state, entry.id, id, new Date(now).toISOString());
      added.push({ id, entry });
    }
  }
  saveState(state);
  return { state, added, errors };
}

const proposedLine = ({ id, entry }) =>
  `INSPECTION: proposed ${id}: ${entry.name} went red the same way in ${entry.incidents} separate tasks or commits. ` +
  `${CLI} approve ${id} lets it be built, ${CLI} cancel ${id} rejects it, ${CLI} inspection snooze ${id} holds it.`;

/** The pulse's part: a scan at most once an hour, and a line per new proposal. Never stops the pulse. */
export function inspectionPulseLines() {
  try {
    if (!setup().enabled) return [];
    const last = Date.parse(readState()?.scannedAt ?? '');
    if (Number.isFinite(last) && Date.now() - last < PULSE_EVERY_MS) return [];
    const r = scanAndPropose();
    return [...r.added.map(proposedLine), ...r.errors.map((e) => `INSPECTION: a proposal could not be added (${e}).`)];
  } catch (e) {
    return [`(The inspection scan failed: ${e?.message ?? e}. Run ${CLI} inspection.)`];
  }
}

/**
 * The board's part (the Checks tab, cli/checks.mjs): the guard registry with its measures and the inspection entries
 * from the last scan. Read-only: no scan, no proposal. The time log is read only when a gate entry needs its measures.
 */
export function guardsBoard() {
  const s = setup();
  const { file, registry, error } = readRegistry(MAIN_TREE);
  const needsRows = registry.guards.some((g) => g?.kind === 'gate' && g?.command);
  return {
    guards: { file: path.relative(MAIN_TREE, file).replace(/\\/g, '/'), error, ...GR.boardData(registry, needsRows ? timeRows(null) : []) },
    inspection: { mode: s.mode, minRepeats: s.minRepeats, windowDays: s.windowDays, ...I.boardData(readState(), { registry }) },
  };
}

function cmdSnooze() {
  const ref = a[2];
  if (!ref || ref.startsWith('--')) die(`inspection snooze <id> [--days ${I.SNOOZE_DAYS}]   (the proposal task or the signature id)`);
  const state = readState() ?? { version: 1, entries: {} };
  const r = I.snooze(state, ref, { days: val('--days') ?? I.SNOOZE_DAYS });
  if (r.error) die(r.error);
  saveState(state);
  if (r.proposal && fs.existsSync(FILE)) {
    const task = (read().tasks ?? []).find((o) => o.id === r.proposal);
    if (task && ['proposed', 'waiting'].includes(task.status)) {
      const c = spawnSync(process.execPath, [QUEUE_PATH, 'cancel', r.proposal, '--remark', `snoozed by the inspection queue until ${r.until.slice(0, 10)}`], {
        encoding: 'utf8',
      });
      if (c.status !== 0) die(`Snoozed, but ${r.proposal} could not be cancelled: ${`${c.stdout ?? ''}${c.stderr ?? ''}`.trim()}`);
    }
  }
  console.log(`${r.id}: snoozed until ${r.until.slice(0, 10)}${r.proposal ? ` (${r.proposal} cancelled)` : ''}. It is proposed again after that if it still repeats.`);
}

export function cmdInspection() {
  if (a[1] === 'snooze') return cmdSnooze();
  if (a[1] && !a[1].startsWith('--')) die('inspection [--json] | inspection snooze <id> [--days n]');
  const s = setup();
  const json = a.includes('--json');
  if (!s.enabled) {
    if (json) console.log(JSON.stringify({ setup: s, entries: [] }, null, 2));
    else for (const l of I.lines(null, { setup: s, cli: CLI })) console.log(l);
    return;
  }
  const r = scanAndPropose();
  const registry = readRegistry(MAIN_TREE).registry;
  if (json) {
    console.log(JSON.stringify({ setup: s, proposed: r.added.map((x) => x.id), errors: r.errors, ...I.boardData(r.state, { registry }) }, null, 2));
    return;
  }
  for (const x of r.added) console.log(proposedLine(x));
  for (const e of r.errors) console.log(`A proposal could not be added: ${e}`);
  for (const l of I.lines(r.state, { setup: s, registry, cli: CLI })) console.log(l);
}

function cmdGuardsAdd() {
  const { file, registry, error } = readRegistry(ROOT);
  if (error) die(`${file}: ${error}. Fix the file first; nothing was written.`);
  let input = { against: {} };
  const fromTask = val('--from-task');
  if (fromTask) {
    const { tasks, archived } = allTasks();
    const task = tasks.find((o) => o.id === fromTask) ?? archived[fromTask];
    if (!task) die(`No task ${fromTask} in the queue or its archive.`);
    const entry = Object.values(readState()?.entries ?? {}).find((e) => e?.proposal === fromTask) ?? null;
    input = GR.fromTask({ task, entry });
  }
  const lesson = val('--against');
  const signature = val('--signature');
  input = {
    ...input,
    kind: val('--kind'),
    explain: val('--explain'),
    command: val('--command'),
    ...(val('--title') != null ? { title: val('--title') } : {}),
    ...(val('--task') != null ? { task: val('--task') } : {}),
    against: { ...input.against, ...(lesson != null ? { lesson } : {}), ...(signature != null ? { signature } : {}) },
  };
  const r = GR.addGuard(registry, input);
  if (r.error.length) die(`Not added:\n${r.error.map((e) => `  - ${e}`).join('\n')}`);
  writeAtomic(file, GR.serialize(registry));
  console.log(`Added ${r.guard.id} [${r.guard.kind}] ${r.guard.title} to ${path.relative(ROOT, file).replace(/\\/g, '/')}. Commit the file with the change.`);
}

function cmdGuardsRetire() {
  const id = a[2];
  if (!id || id.startsWith('--')) die('guards retire <id>');
  const { file, registry, error } = readRegistry(ROOT);
  if (error) die(`${file}: ${error}. Fix the file first; nothing was written.`);
  const problem = GR.retire(registry, id);
  if (problem) die(problem);
  writeAtomic(file, GR.serialize(registry));
  console.log(`${id}: retired (the entry stays in the registry). Commit the file.`);
}

export function cmdGuards() {
  if (a[1] === 'add') return cmdGuardsAdd();
  if (a[1] === 'retire') return cmdGuardsRetire();
  if (a[1] && !a[1].startsWith('--')) die('guards [--json] | guards add ... | guards retire <id>');
  const { file, registry, error } = readRegistry(ROOT);
  const rows = timeRows(null);
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  if (a.includes('--json')) {
    console.log(JSON.stringify({ file: rel, error, ...GR.boardData(registry, rows) }, null, 2));
    return;
  }
  if (error) console.log(`${rel}: ${error}`);
  for (const l of GR.lines(registry, rows, { cli: CLI, file: rel })) console.log(l);
}
