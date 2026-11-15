// =============================================================
// failureClasses.js: the failure class taxonomy that FINDING and GATE lines name, as data.
//
// Why: a finding or a known bug is only countable across tasks when it carries a class from a fixed list. With free
// text, "unchecked fetch result" and "ignored error from save" are two classes and a repeat is never seen. So the
// classes are a short list of ids (failure-classes.json next to the orchestrator), and those ids are the contract the
// reviewers and tracks write against: an id is never renamed. `other` is the catch-all: it is counted, but never gives
// a proposal on its own.
//
// A project changes the list without touching the plugin, in docs/queue/failure-classes.json (the same pattern as the
// checks catalog in docs/queue/checks/): `{ "classes": [ { "id": "audit-trail", "title": "missing audit row" },
// { "id": "time-zone", "off": true } ] }` adds a class and turns a core one off. A new id must be kebab-case and must
// not collide with a core id; `other` can never be turned off. Anything invalid is ignored with a warning, and a broken
// file gives the core list: a bad project file never stops a review.
//
// Pure apart from classesFor, which reads the one project file. Used by: lib/findingLine.js (normalizeClass, titleOf),
// lib/logic/results.js (promptLine in the reviewer prompt). Tested in: lib/__tests__/failureClasses.test.ts.
// =============================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** The core list, read once from the plugin's data file. */
const CORE = Object.freeze(
  require('../failure-classes.json').classes.map((c) => Object.freeze({ id: c.id, title: c.title })),
);

/** The catch-all id: unknown ids become it, and it is always on. */
const OTHER = 'other';

/** A class id: lower case letters and digits in parts joined by single dashes, at most 40 characters. */
const KEBAB = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** A copy of the core classes ({ id, title }), so a caller can never change the list. */
const coreClasses = () => CORE.map((c) => ({ ...c }));

/** Where a project keeps its own additions and switches, relative to its root. */
const PROJECT_FILE = path.join('docs', 'queue', 'failure-classes.json');

/** One line of plain text for a title, at most 80 characters. */
const plainTitle = (t) => String(t ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);

/**
 * The classes for a project: the core ones, minus those it turns off, plus its own, `other` always last.
 * Never throws: a missing file is the core list, a broken one the core list and a warning.
 * @param {string} root the project root
 * @returns {{ classes: { id: string, title: string }[], warnings: string[] }}
 */
function classesFor(root, { fsImpl = fs } = {}) {
  const warnings = [];
  let raw;
  try {
    raw = fsImpl.readFileSync(path.join(String(root ?? '.'), PROJECT_FILE), 'utf8');
  } catch (e) {
    if (e?.code !== 'ENOENT') warnings.push(`${PROJECT_FILE}: could not read it (${e?.code ?? e?.message}); using the core classes`);
    return { classes: coreClasses(), warnings };
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    warnings.push(`${PROJECT_FILE}: not valid JSON (${e.message}); using the core classes`);
    return { classes: coreClasses(), warnings };
  }
  // Either { classes: [...] } or the list itself.
  const list = Array.isArray(data) ? data : Array.isArray(data?.classes) ? data.classes : null;
  if (!list) {
    warnings.push(`${PROJECT_FILE}: expected { "classes": [ ... ] }; using the core classes`);
    return { classes: coreClasses(), warnings };
  }
  const coreIds = new Set(CORE.map((c) => c.id));
  const off = new Set();
  const added = [];
  for (const entry of list) {
    const id = typeof entry?.id === 'string' ? entry.id : null;
    if (!id) {
      warnings.push(`${PROJECT_FILE}: an entry without a string "id" was ignored`);
      continue;
    }
    const shown = plainTitle(id).slice(0, 40);
    if (entry.off === true) {
      if (id === OTHER) warnings.push(`${PROJECT_FILE}: "other" cannot be turned off; ignored`);
      else if (!coreIds.has(id) && !added.some((c) => c.id === id)) warnings.push(`${PROJECT_FILE}: "${shown}" is not a class to turn off; ignored`);
      else off.add(id);
      continue;
    }
    if (coreIds.has(id)) {
      warnings.push(`${PROJECT_FILE}: "${shown}" is a core class; a project cannot redefine it (ignored)`);
      continue;
    }
    if (id.length > 40 || !KEBAB.test(id)) {
      warnings.push(`${PROJECT_FILE}: "${shown}" is not a kebab-case id (like "audit-trail"); ignored`);
      continue;
    }
    const title = plainTitle(entry.title);
    if (!title) {
      warnings.push(`${PROJECT_FILE}: "${shown}" has no "title"; ignored`);
      continue;
    }
    if (added.some((c) => c.id === id)) {
      warnings.push(`${PROJECT_FILE}: "${shown}" is listed twice; the first one is kept`);
      continue;
    }
    added.push({ id, title });
  }
  const core = coreClasses().filter((c) => !off.has(c.id));
  const classes = [...core.filter((c) => c.id !== OTHER), ...added.filter((c) => !off.has(c.id)), core.find((c) => c.id === OTHER)];
  return { classes, warnings };
}

/** The id when it is one of `classes`, else `other` (also for "-", null and an id in the wrong case). */
function normalizeClass(id, classes = CORE) {
  const s = typeof id === 'string' ? id.trim() : '';
  return s && s !== '-' && classes.some((c) => c.id === s) ? s : OTHER;
}

/** The title of a class id (the id itself when it is not in the list). */
function titleOf(id, classes = CORE) {
  return classes.find((c) => c.id === id)?.title ?? String(id ?? OTHER);
}

/** The one short line for the reviewer prompt and the agent files: the ids, nothing else, so it costs few tokens. */
function promptLine(classes = CORE) {
  return `Classes: ${classes.map((c) => c.id).join(', ')} (or -).`;
}

module.exports = { OTHER, PROJECT_FILE, coreClasses, classesFor, normalizeClass, titleOf, promptLine };
