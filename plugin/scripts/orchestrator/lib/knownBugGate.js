// =============================================================
// lib/knownBugGate.js: a known bug that can happen again becomes a gate task. Pure logic.
//
// A track writes one line `GATE <failure class>` in track-result.md, `cq receive` reads it, and `cq gate` does the same by hand.
// gates.fromKnownBugs in queue.config.json decides what happens:
//   propose (default)  a proposed task; it starts only when the owner approves it
//   auto               an approved task; it runs when the queue gets to it, and it uses tokens without asking
//   off                nothing
// At most MAX_OPEN gate tasks are open at a time, so a project is not buried in proposals. A class the owner cancelled
// stays declined, and the same class again extends the open task instead of adding a second one.
//
// The criteria in the mission are the ones in skills/review/SKILL.md ("The gate criteria").
// Used by: cli/gate.mjs. Tested in: lib/__tests__/knownBugGate.test.ts and __tests__/gateFlow.test.ts.
// =============================================================

const MODES = ['propose', 'auto', 'off'];
const MAX_OPEN = 3;
const MAX_TITLE = 100;
const RED_FIRST = 'The new check fails on the original bug or a minimal reproduction, and passes on the fixed code (both runs shown in the report).';

const isGate = (o) => Array.isArray(o?.labels) && o.labels.includes('gate');
const isClosed = (o) => o.status === 'done' || o.status === 'cancelled';

/** The setting; anything else counts as the default. */
const modeOf = (config) => (MODES.includes(config?.gates?.fromKnownBugs) ? config.gates.fromKnownBugs : 'propose');

/** "Gate: A missing check" and "a missing check." are the same class. */
const classKey = (title) => String(title ?? '').replace(/^gate:\s*/i, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** One plain line of at most MAX_TITLE characters. */
const cleanTitle = (title) => String(title ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE).trim();

/** The failure class from a `GATE <failure class>` line in a report, or null. Upper case only, so a heading "Gate: ..." is not one. */
function parseGateLine(text) {
  return parseGate(text)?.title ?? null;
}

/** The same line with its place: `GATE <failure class> @ <file:line>` gives { title, where }; where is null without one. */
function parseGate(text) {
  const m = /^[ \t]*(?:[-*][ \t]+)?`?GATE(?::|[ \t])[ \t]*([^\n`]*)`?[ \t]*$/m.exec(String(text ?? ''));
  if (!m) return null;
  const place = /^(.*\S)\s+@\s+(\S+:\d+)\s*$/.exec(m[1]);
  const title = cleanTitle(place ? place[1] : m[1]);
  return !title || /^(none|n\/a|no|-)$/i.test(title) ? null : { title, where: place ? place[2] : null };
}

/** A gate task whose mission names no file and line: approving it means agent work on a guess (cq decide says so). */
function gateWithoutPlace(o) {
  return isGate(o) && !/seen in: .*?[\w./\\-]+:\d+/i.test(String(o.mission ?? ''));
}

/**
 * What to do with a failure class.
 * @returns {{ action: 'off'|'add'|'extend'|'exists'|'declined'|'full', task?: object }}
 */
function decide({ title, tasks = [], mode = 'propose' }) {
  if (mode === 'off') return { action: 'off' };
  const gates = tasks.filter(isGate);
  const same = gates.filter((o) => classKey(o.title) === classKey(title));
  const open = same.find((o) => !isClosed(o));
  if (open) return { action: 'extend', task: open };
  const done = same.find((o) => o.status === 'done');
  if (done) return { action: 'exists', task: done };
  const cancelled = same.find((o) => o.status === 'cancelled');
  if (cancelled) return { action: 'declined', task: cancelled };
  return { action: gates.filter((o) => !isClosed(o)).length >= MAX_OPEN ? 'full' : 'add' };
}

/** The next free GATE-<n>. */
function nextId(tasks = []) {
  const numbers = tasks.map((o) => /^GATE-(\d+)$/.exec(o.id ?? '')?.[1]).filter(Boolean).map(Number);
  return `GATE-${Math.max(0, ...numbers) + 1}`;
}

/** Where a bug was seen, as one line for the mission. */
const seenLine = ({ from, where, detail }) =>
  [from && `task ${from}`, where, detail].map((x) => (x ? String(x).replace(/\s+/g, ' ').trim() : '')).filter(Boolean).join(': ');

/** The gate task, ready for `cq add`. added_by makes it proposed unless it is added with --approved. */
function gateTask({ id, title, from, where, detail }) {
  const seen = seenLine({ from, where, detail });
  return {
    id,
    title: `Gate: ${title}`,
    class: 'K',
    domain: 'ci',
    feature: 'Known bugs',
    value: 7,
    content_min: 45,
    labels: ['gate'],
    added_by: 'gate agent',
    own_track: 'a gate for a known bug',
    acceptance: [RED_FIRST],
    mission: [
      `A known bug can happen again, so add a check that stops this failure class: ${title}.`,
      seen ? `Seen in: ${seen}.` : 'Find a place in the code that shows it, or write a minimal reproduction.',
      '',
      'The gate criteria:',
      '1. Clear purpose: one sentence naming the failure class it stops and why that matters here.',
      '2. Reproducible failing example: the original finding (file:line) or a minimal reproduction kept as a fixture or test case next to the check.',
      '3. Low maintenance cost: fast enough for the quick gate, no network, few false alarms, and exceptions only in an explicit list with a reason per entry.',
      '4. Red first: show the new check failing on the original bug or the reproduction, and passing on the fixed code. Put both runs (command and result line) in track-result.md.',
      "5. In the project's own gates: a test, lint rule or script that the project's existing check commands already run. If they would not run it, say in track-result.md which command to add to gates.quick; do not edit queue.config.json.",
      '',
      'If a good check would cost more than it saves, stop and say so in track-result.md. Never push, deploy or change settings on the git host.',
    ].join('\n'),
  };
}

/** The mission with one more place, or null when that place is already in it or there is no place. */
function extendedMission(task, seen) {
  const line = seenLine(seen);
  if (!line || String(task.mission ?? '').includes(line)) return null;
  return `${task.mission}\n\nAlso seen in: ${line}.`;
}

/** The numbers for the overview. */
function summary(tasks = [], mode = 'propose') {
  const gates = tasks.filter(isGate);
  return {
    mode,
    proposed: gates.filter((o) => o.status === 'proposed').length,
    open: gates.filter((o) => !isClosed(o)).length,
    done: gates.filter((o) => o.status === 'done').length,
  };
}

module.exports = { MODES, MAX_OPEN, modeOf, classKey, cleanTitle, parseGateLine, parseGate, gateWithoutPlace, decide, nextId, gateTask, extendedMission, summary };
