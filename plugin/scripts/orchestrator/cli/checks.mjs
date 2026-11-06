// =============================================================
// cli/checks.mjs: `ravenseat checks`: what the project has for checking its code, and prioritized suggestions for what to add.
//
//   ravenseat checks [--json]             reads the project's files (never runs anything), prints the overview and saves it as
//                                  checks-report.json in the queue folder (ignored by git). Works before ravenseat init.
//   ravenseat checks show <key>           the suggestion's template: what the investigation and the plan cover
//   ravenseat checks plan <key> [--approved]   adds the investigation and planning as a task. A proposal without --approved; the
//                                  board's button passes it, because the click is the owner's yes.
//   ravenseat checks dismiss|restore <key>     sets a suggestion aside, or brings it back
//   ravenseat checks on|off               the opt-out: the Checks tab, this overview and the setup suggestions. Never a guard.
//
// The rules are in lib/checksScan.js and lib/checksCatalog.js, the suggestions in checks-catalog/ (and docs/queue/checks/
// in the project). Tested in: __tests__/checksFlow.test.ts.
// =============================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { a, CONFIG, CLI, die, edit, FILE, KK, LM, MAIN_TREE, read, require } from './context.mjs';
import { addTask, ensureProject, PROJECT, readFacts } from './kickstart.mjs';

const SCAN = require('./lib/checksScan.js');
const CATALOG = require('./lib/checksCatalog.js');
const GD = require('./lib/guidance.js');
const KNOWN = require('./lib/knownBugGate.js');

const BUILTIN = fileURLToPath(new URL('../checks-catalog', import.meta.url));
const OWN = path.join(MAIN_TREE, 'docs', 'queue', 'checks');
const REPORT_FILE = 'checks-report.json';
const NOTHING_RAN = 'Read from your files. ravenseat did not run any of it, so this shows what is set up, not that it works.';

const queueNow = () => (fs.existsSync(FILE) ? read() : null);

/** Everything the report needs, read fresh. */
function makeReport(queue) {
  const facts = readFacts();
  const list = (dir) => {
    try {
      return fs.readdirSync(path.join(PROJECT, dir));
    } catch {
      return [];
    }
  };
  const exists = (f) => fs.existsSync(path.join(PROJECT, f));
  const readFile = (f) => {
    try {
      return fs.readFileSync(path.join(PROJECT, f), 'utf8');
    } catch {
      return null;
    }
  };
  const found = SCAN.scan({ exists, read: readFile, list, gates: CONFIG.gates, checks: facts.checks });
  return CATALOG.buildReport({
    facts: { ...facts, ...found },
    catalog: CATALOG.loadCatalog({ builtin: BUILTIN, own: OWN }),
    tasks: queue?.tasks ?? [],
    dismissed: queue?.checksPanel?.dismissed ?? [],
    knownBugs: queue ? KNOWN.summary(queue.tasks, KNOWN.modeOf(CONFIG)) : null,
    now: new Date().toISOString(),
  });
}

/** Saved beside the queue, so other tools can read it. Before ravenseat init there is no folder, and nothing is written. */
function saveReport(report) {
  if (!fs.existsSync(FILE)) return;
  const file = path.join(KK.dataFolder(), REPORT_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(report, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

const WHERE = { ci: 'CI', gate: 'gate', script: 'script', hook: 'git hook', config: 'config' };

function printOverview(report) {
  console.log(`Project: ${report.stacks.length ? report.stacks.join(', ') : 'no known stack found'}\n`);
  console.log('In place');
  if (!report.found.kinds.length && !report.found.ci.length) console.log('  Nothing found yet.');
  for (const c of report.found.ci) {
    const runs = [c.triggers.length ? `on ${c.triggers.join(', ')}` : '', c.jobs.length ? `jobs: ${c.jobs.join(', ')}` : ''].filter(Boolean).join('; ');
    console.log(`  CI  ${c.host}, ${c.file}${runs ? ` (${runs})` : ''}`);
  }
  for (const k of report.found.kinds) console.log(`  ${k.title}: ${[...new Set(k.places.map((p) => WHERE[p.where] ?? p.where))].join(', ')}`);
  const open = report.suggestions.filter((s) => s.state !== 'dismissed');
  console.log('\nSuggestions, most important first');
  if (!open.length) console.log('  None right now.');
  for (const s of open) {
    const state = s.taskId ? ` [${s.state}: ${s.taskId}]` : '';
    console.log(`  ${s.priority.toUpperCase().padEnd(7)}${s.key}: ${s.title}${state}`);
  }
  const aside = report.suggestions.length - open.length;
  if (aside) console.log(`  (${aside} set aside; ${CLI} checks --json lists them)`);
  for (const e of report.catalogErrors) console.log(`\nCatalog problem: ${e}`);
  console.log(`\n${NOTHING_RAN}`);
  if (open.length) console.log(`${CLI} checks show <key> says what a suggestion covers. ${CLI} checks plan <key> adds the investigation and planning to the queue. Nothing is built before you approve it.`);
  console.log(`${CLI} checks off turns this overview and the Checks tab off.`);
}

function needsQueue() {
  if (!fs.existsSync(FILE)) die(`The queue does not exist yet. Run: ${CLI} init`);
}

/** The suggestion, also one set aside or no longer open. Unknown key: says which there are. */
function suggestion(report, key) {
  if (!key || key.startsWith('--')) die(`Name a suggestion: ${CLI} checks shows the keys.`);
  const s = report.suggestions.find((x) => x.key === key);
  if (!s) die(`No suggestion ${key} applies to this project now. ${CLI} checks lists the ones that do.`);
  return s;
}

function show(key) {
  const s = suggestion(makeReport(queueNow()), key);
  console.log(`${s.title} (${s.category}, ${s.priority} priority)\n\nWhy: ${s.why}\n`);
  if (s.action) console.log(`This needs no agent: ${CLI} kickstart gates --apply.`);
  else console.log(`Investigate\n${s.investigate}\n\nPlan and build\n${s.plan}\n\nAbout ${s.contentMin} min of agent work for the investigation.`);
}

function plan(key) {
  needsQueue();
  const queue = read();
  const report = makeReport(queue);
  const s = suggestion(report, key);
  if (s.action) die(`${key} needs no agent. Run: ${CLI} kickstart gates --apply`);
  if (s.state === 'queued' || s.state === 'planned') {
    console.log(`Not added: ${s.taskId} is already there.`);
    return;
  }
  ensureProject();
  const task = { ...CATALOG.planTask(s, report.found, queue.tasks), ...(LM.isLite(CONFIG) ? {} : { project: 'cicd' }) };
  const approved = a.includes('--approved');
  const r = addTask(task, { approved });
  if (!r.ok) die(r.output);
  // Added again, so it is no longer set aside.
  if (s.state === 'dismissed') setDismissed(key, false);
  console.log(r.output);
  console.log(
    `About ${task.content_min} min of agent work, and it uses tokens. It delivers a plan with recommended steps, no code. ` +
      (approved ? `${CLI} set ${task.id} cancelled takes it out.` : `${CLI} approve ${task.id} (or Approve on the board) lets it run.`),
  );
}

function setDismissed(key, on) {
  edit((queue) => {
    const panel = queue.checksPanel ?? {};
    const list = (panel.dismissed ?? []).filter((k) => k !== key);
    queue.checksPanel = { ...panel, dismissed: on ? [...list, key] : list };
  });
}

function setMode(mode) {
  needsQueue();
  edit((queue) => {
    queue.checksPanel = { ...queue.checksPanel, mode };
  });
  console.log(
    mode === 'off'
      ? `Checks: off. No Checks tab, no overview and no suggestions in setup. Your guards and gates run as before, and advice elsewhere follows ${CLI} guidance. Back: ${CLI} checks on.`
      : `Checks: on. ${CLI} checks and the Checks tab on the board show what the project has and what to add. Off: ${CLI} checks off.`,
  );
}

/** `ravenseat checks ...` (the usage is at the top of queue.mjs). */
export function cmdChecks() {
  const sub = a[1];
  if (sub === 'on' || sub === 'off') return setMode(sub);
  if (sub === 'show') return show(a[2]);
  if (sub === 'plan') return plan(a[2]);
  if (sub === 'dismiss' || sub === 'restore') {
    needsQueue();
    suggestion(makeReport(read()), a[2]);
    setDismissed(a[2], sub === 'dismiss');
    console.log(sub === 'dismiss' ? `${a[2]} is set aside. ${CLI} checks restore ${a[2]} brings it back.` : `${a[2]} is back among the suggestions.`);
    return undefined;
  }
  if (sub && sub !== '--json') return die(`Use: ${CLI} checks [--json] | show <key> | plan <key> [--approved] | dismiss <key> | restore <key> | on | off`);
  const queue = queueNow();
  if (queue && !GD.checksPanelOn(queue)) {
    if (a.includes('--json')) console.log(JSON.stringify({ off: true }));
    else console.log(`The Checks overview is off. ${CLI} checks on turns it on.`);
    return undefined;
  }
  const report = makeReport(queue);
  saveReport(report);
  if (a.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else printOverview(report);
  return undefined;
}
