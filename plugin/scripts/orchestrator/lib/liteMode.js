// =============================================================
// liteMode.js: the zero-config mode for new users ("mode": "lite" in queue.config.json).
//
// Why: full cq asks a new user for classes (K/D/D+/U), value 1-10, content_min, focus, the batch queue, the plan
// register, helpers and the handover note before anything runs, and the small-task guard refuses tiny tasks. Lite mode
// keeps the core loop only (init, add, show, fill, receive, merge) and one task type, so cq gives value in the first
// hour. The owner questions ("Waiting on you") stay.
//
// What lite changes (and nothing else; every other command still works when typed):
//   - `cq add "<title>" [--mission "<text or path>"] [--priority 1-10] [--files a,b] [--id X]` adds one task with only a
//     title. A JSON task (--file/--json) may also leave out id, class, domain, mission, project, feature, value and
//     content_min: liteDefaults() fills them (class K, value 5, content_min 30, the mission = the title).
//   - `add` skips the small-task guard and the batch queue rules (a `batched` flag is dropped with a note, because the
//     batch queue is only packed in full mode).
//   - The order is the order added: equal value and size give equal priority, and the generated ids (T-001, T-002 ...)
//     sort in the order they were added. `--priority` (value) moves a task up or down.
//   - `cq help` shows only the core commands (lib/cliHelp.js).
// The mode is switched with `cq mode lite|full` or `cq init --lite|--full`; both only write the `mode` key.
//
// Everything here is pure except readOwnMode/writeMode (one small file), so it is unit tested in
// lib/__tests__/liteMode.test.ts.
// =============================================================
'use strict';

const fs = require('node:fs');

/** The known modes. "full" is the default for every config without a `mode` key, so existing installs keep it. */
const MODES = ['full', 'lite'];

/** The fields a lite task gets when they are missing. Neutral: the defaults full mode itself uses. */
const LITE_DEFAULTS = Object.freeze({
  class: 'K',
  domain: 'general',
  feature: 'General',
  value: 5,
  content_min: 30,
});

/** The project `cq init` creates in lite mode (full mode creates "example" with EX-). */
const LITE_PROJECT = Object.freeze({ id: 'tasks', title: 'Tasks', prefix: 'T-' });

/** Digits in a generated id (T-001). Padding keeps the ids sorting in the order they were added. */
const ID_DIGITS = 3;

/** The mode of a configuration: "lite" only when it says so, otherwise "full". */
function mode(cfg) {
  return cfg?.mode === 'lite' ? 'lite' : 'full';
}

/** Is the configuration in lite mode? */
function isLite(cfg) {
  return mode(cfg) === 'lite';
}

/**
 * The project lite tasks go to: "tasks" when the register has it, otherwise the first project in the register, otherwise
 * none. Returns { pid, prefix } (prefix = the project's first prefix, or LITE_PROJECT.prefix).
 */
function defaultProject(register) {
  const keys = Object.keys(register ?? {});
  const pid = keys.includes(LITE_PROJECT.id) ? LITE_PROJECT.id : (keys[0] ?? null);
  const prefixes = pid ? register[pid]?.prefixes : null;
  const prefix = Array.isArray(prefixes) && typeof prefixes[0] === 'string' && prefixes[0] ? prefixes[0] : LITE_PROJECT.prefix;
  return { pid, prefix };
}

/**
 * The next free id with the prefix: one more than the highest number already used (in the queue or in `taken`),
 * padded to ID_DIGITS. "T-" with T-001 and T-007 taken gives T-008.
 */
function nextId(ids, prefix) {
  let high = 0;
  for (const id of ids) {
    const s = String(id ?? '');
    if (!s.startsWith(prefix)) continue;
    const m = /^(\d+)$/.exec(s.slice(prefix.length));
    if (m) high = Math.max(high, Number(m[1]));
  }
  return `${prefix}${String(high + 1).padStart(ID_DIGITS, '0')}`;
}

/**
 * Fills the missing fields of tasks being added in lite mode (the given fields always win). Never mutates the input.
 * @param {object[]} tasks the tasks from add (objects; anything else is passed through for validate to refuse)
 * @param {{ tasks?: object[], projects?: object }} queue the queue before the add
 * @returns {{ tasks: object[], notes: string[] }}
 */
function liteDefaults(tasks, queue = {}) {
  const { pid, prefix } = defaultProject(queue.projects);
  const ids = (queue.tasks ?? []).map((o) => o?.id);
  for (const n of tasks) if (n && typeof n === 'object' && n.id) ids.push(n.id);
  const notes = [];
  const out = tasks.map((n) => {
    if (!n || typeof n !== 'object' || Array.isArray(n)) return n;
    const o = { ...n };
    if (!o.id) {
      o.id = nextId(ids, prefix);
      ids.push(o.id);
    }
    for (const [k, v] of Object.entries(LITE_DEFAULTS)) if (o[k] == null || o[k] === '') o[k] = v;
    if (!o.mission && typeof o.title === 'string') o.mission = o.title;
    if (o.project == null && pid) o.project = pid;
    if (o.batched === true) {
      delete o.batched;
      notes.push(`${o.id}: lite mode has no batch queue, so it runs as its own task (cq mode full turns the batch queue on)`);
    }
    return o;
  });
  return { tasks: out, notes };
}

/**
 * The task `cq add "<title>"` builds from the flags. Only the title is required.
 * @param {{ title?: string, mission?: string, priority?: string|number, files?: string, id?: string, by?: string }} f
 * @returns {{ task?: object, error: string[] }}
 */
function quickTask(f = {}) {
  const error = [];
  const title = String(f.title ?? '').trim();
  if (!title) error.push('add needs a title: cq add "Fix the login bug"');
  const task = { title };
  if (f.mission != null && String(f.mission).trim()) task.mission = String(f.mission).trim();
  if (f.priority != null) {
    const p = Number(f.priority);
    if (!Number.isInteger(p) || p < 1 || p > 10) error.push('--priority must be a whole number 1-10 (5 = normal)');
    else task.value = p;
  }
  if (f.files != null) {
    const files = String(f.files)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (files.length) task.owned_files = files;
  }
  // --depends a,b: the task waits until these are done. cq add refuses an id that is not in the queue.
  if (f.depends != null) {
    const depends = String(f.depends)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (depends.length) task.depends_on = depends;
  }
  if (f.id != null && String(f.id).trim()) task.id = String(f.id).trim();
  if (f.by != null && String(f.by).trim()) task.added_by = String(f.by).trim();
  return error.length ? { error } : { task, error };
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Sets the top-level `mode` in the text of queue.config.json and keeps the rest of the file as written (the key is
 * replaced in place or inserted first, with the file's own indentation). Throws on text that is not a JSON object.
 * @returns {string} the new text (the same text when the mode is already set)
 */
function setModeText(text, value) {
  if (!MODES.includes(value)) throw new Error(`mode must be ${MODES.join(' or ')}`);
  const src = text == null || !String(text).trim() ? '{}' : String(text);
  const obj = JSON.parse(src);
  if (!isObject(obj)) throw new Error('queue.config.json must be a JSON object');
  if (obj.mode === value) return src;
  const ok = (out) => {
    try {
      const o = JSON.parse(out);
      return isObject(o) && o.mode === value ? out : null;
    } catch {
      return null;
    }
  };
  const key = /("mode"\s*:\s*)"[^"\\]*"/g;
  if (Object.hasOwn(obj, 'mode')) {
    // A nested key can have the same name (push.mode), so take the occurrence that changes the top-level key and nothing else.
    const wanted = JSON.stringify({ ...obj, mode: value });
    for (const m of src.matchAll(key)) {
      const out = `${src.slice(0, m.index)}${m[1]}"${value}"${src.slice(m.index + m[0].length)}`;
      try {
        if (JSON.stringify(JSON.parse(out)) === wanted) return out;
      } catch {
        /* this occurrence was not a real key: try the next one */
      }
    }
  }
  if (!Object.hasOwn(obj, 'mode')) {
    const first = /\{(\r?\n)([ \t]*)"/.exec(src);
    if (first) {
      const [all, nl, indent] = first;
      const at = first.index;
      const out = ok(`${src.slice(0, at)}{${nl}${indent}"mode": "${value}",${nl}${indent}"${src.slice(at + all.length)}`);
      if (out) return out;
    }
  }
  // Anything unusual (one-line file, several "mode" keys): write it out again.
  const rest = Object.fromEntries(Object.entries(obj).filter(([k]) => k !== 'mode'));
  return `${JSON.stringify({ mode: value, ...rest }, null, 2)}\n`;
}

/** The `mode` key as written in the file (null when the file or the key is missing, or the file cannot be read). */
function readOwnMode(file) {
  try {
    const o = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isObject(o) && typeof o.mode === 'string' ? o.mode : null;
  } catch {
    return null;
  }
}

/**
 * Writes the mode into the file (creates it when missing). Returns { before, after, changed }.
 * Throws when the file exists but is not valid JSON (it is never overwritten then).
 */
function writeMode(file, value) {
  let text = null;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e?.code !== 'ENOENT') throw e;
  }
  const before = text == null ? null : readOwnMode(file);
  const next = setModeText(text, value);
  const changed = next !== text;
  if (changed) fs.writeFileSync(file, text == null ? `${JSON.stringify({ mode: value }, null, 2)}\n` : next);
  return { before, after: value, changed };
}

/** The one line that says how to leave lite mode (help, init, mode). */
function switchLine(cq = 'cq') {
  return `Full mode (classes, value, focus, batch queue, plans, helpers): ${cq} mode full. Every command: ${cq} help all.`;
}

module.exports = {
  MODES,
  LITE_DEFAULTS,
  LITE_PROJECT,
  mode,
  isLite,
  defaultProject,
  nextId,
  liteDefaults,
  quickTask,
  setModeText,
  readOwnMode,
  writeMode,
  switchLine,
};
