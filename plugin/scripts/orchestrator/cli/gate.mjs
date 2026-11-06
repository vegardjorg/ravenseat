// =============================================================
// cli/gate.mjs: `ravenseat gate`: a known bug that can happen again becomes a gate task.
//
//   ravenseat gate "<failure class>" [--from <task>] [--where <file:line>] [--detail "..."]
//   ravenseat gate list
//
// ravenseat receive calls proposeGate for a `GATE <failure class>` line in track-result.md. The rules (the setting
// gates.fromKnownBugs, the cap, the same class again) are in lib/knownBugGate.js. A proposal never starts by itself.
// =============================================================

import fs from 'node:fs';

import { a, CONFIG, CLI, die, edit, FILE, read, require, val } from './context.mjs';
import { addTask, ensureProject } from './kickstart.mjs';

const G = require('./lib/knownBugGate.js');

/**
 * Applies the setting and the rules to one failure class. Returns the line to show, or null when the setting is off.
 * @param {{ title: string, from?: string, where?: string, detail?: string }} bug
 */
export function proposeGate({ title: raw, from, where, detail }) {
  const title = G.cleanTitle(raw);
  const mode = G.modeOf(CONFIG);
  const queue = read();
  const d = G.decide({ title, tasks: queue.tasks, mode });
  if (d.action === 'off') return null;
  if (d.action === 'exists') return `Gate: ${d.task.id} already covers "${title}". A bug in that class again means the check needs a look.`;
  if (d.action === 'declined') return `Gate: ${d.task.id} for "${title}" was cancelled, so it is not proposed again.`;
  if (d.action === 'full')
    return `Gate: not proposed, because ${G.MAX_OPEN} gate tasks are already open. Approve or cancel one first (${CLI} gate list). The bug was: ${title}.`;
  if (d.action === 'extend') {
    const changed = edit((q) => {
      const o = q.tasks.find((x) => x.id === d.task.id);
      if (o?.status === 'picked') return false; // a running track has already read its mission
      const mission = o && G.extendedMission(o, { from, where, detail });
      if (!mission) return false;
      o.mission = mission;
      return true;
    });
    return `Gate: ${d.task.id} already covers "${title}"${changed ? ', and the new place was added to it' : ''}.`;
  }
  ensureProject();
  const task = { ...G.gateTask({ id: G.nextId(queue.tasks), title, whole: G.plainLine(raw), from, where, detail }), ...projectField() };
  const r = addTask(task, { approved: mode === 'auto' });
  if (!r.ok) return `Gate: could not add the task: ${r.output}`;
  return mode === 'auto'
    ? `Gate: ${task.id} added and approved (gates.fromKnownBugs is auto). About ${task.content_min} min of agent work: ${title}.`
    : `Gate: ${task.id} proposed: ${title}. About ${task.content_min} min of agent work. ${CLI} approve ${task.id} (or Approve on the board) lets it run; ${CLI} set ${task.id} cancelled declines it.`;
}

/** The project for a full-mode task (lite fills its own). */
function projectField() {
  return read().projects?.cicd ? { project: 'cicd' } : {};
}

function list() {
  const gates = read().tasks.filter((o) => o.labels?.includes('gate'));
  if (!gates.length) return console.log('No gate tasks yet.');
  for (const o of gates) console.log(`${o.id.padEnd(10)} ${String(o.status).padEnd(10)} ${o.title}`);
}

/** `ravenseat gate ...` (the usage is at the top of queue.mjs). */
export function cmdGate() {
  if (!fs.existsSync(FILE)) die(`The queue does not exist yet, so a task has nowhere to go. Run: ${CLI} init`);
  if (a[1] === 'list') return list();
  const title = a[1];
  if (!title || title.startsWith('--')) die(`Use: ${CLI} gate "<failure class>" [--from <task>] [--where <file:line>] [--detail "..."] | ${CLI} gate list`);
  const option = (name) => (a.includes(name) ? val(name) : undefined);
  const line = proposeGate({ title, from: option('--from'), where: option('--where'), detail: option('--detail') });
  console.log(line ?? 'gates.fromKnownBugs is off in queue.config.json, so nothing was added.');
}
