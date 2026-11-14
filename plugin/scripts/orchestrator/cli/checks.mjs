// =============================================================
// cli/checks.mjs: `ravenseat checks`: what the project has for checking its code, and prioritized suggestions for what to add.
//
//   ravenseat checks [--json]             reads the project's files (never runs anything), prints the overview and saves it as
//                                  checks-report.json in the queue folder (ignored by git). Works before ravenseat init.
//   ravenseat checks show <key>           the suggestion's template: what the investigation and the plan cover
//   ravenseat checks plan <key> [--approved]   adds the investigation and planning as a task. A proposal without --approved; the
//                                  board's button passes it, because the click is the owner's yes.
//   ravenseat checks dismiss|restore <key>     sets a suggestion aside, or brings it back
//   ravenseat checks packs [--apply]      the stack packs for the review signals (lib/reviewPacks.js): which stacks the
//                                  manifests show and which packs are not on yet. --apply writes them to review.packs in
//                                  queue.config.json (a project pack from docs/queue/review-packs/ also into review.signals).
//   ravenseat checks marker on|off        the small red marker on the Checks tab when a high suggestion is open
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
import { guardsBoard } from './inspection.mjs';

const SCAN = require('./lib/checksScan.js');
const CATALOG = require('./lib/checksCatalog.js');
const GD = require('./lib/guidance.js');
const KNOWN = require('./lib/knownBugGate.js');
const RP = require('./lib/reviewPacks.js');
const RS = require('./lib/reviewSignals.js');

const BUILTIN = fileURLToPath(new URL('../checks-catalog', import.meta.url));
const OWN = path.join(MAIN_TREE, 'docs', 'queue', 'checks');
const OWN_PACKS = path.join(MAIN_TREE, 'docs', 'queue', 'review-packs');
const REPORT_FILE = 'checks-report.json';
const NOTHING_RAN = 'Read from your files. ravenseat did not run any of it, so this shows what is set up, not that it works.';

const queueNow = () => (fs.existsSync(FILE) ? read() : null);

/** Are Claude's instructions over a limit (the condition instructions-large)? Never with instructionSize.mode off. */
function instructionsLarge() {
  const IS = require('./lib/instructionSize.js');
  const limits = IS.limitsOf(CONFIG);
  if (limits.mode === 'off') return false;
  return IS.assess(IS.measureDisk(MAIN_TREE, { nested: true }), limits).large;
}

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
  const packs = packFacts({ exists, read: readFile, list });
  const found = SCAN.scan({ exists, read: readFile, list, gates: CONFIG.gates, checks: facts.checks });
  const report = CATALOG.buildReport({
    facts: { ...facts, ...found, packs: packs.facts, instructionsLarge: instructionsLarge() },
    catalog: CATALOG.loadCatalog({ builtin: BUILTIN, own: OWN }),
    tasks: queue?.tasks ?? [],
    dismissed: queue?.checksPanel?.dismissed ?? [],
    knownBugs: queue ? KNOWN.summary(queue.tasks, KNOWN.modeOf(CONFIG)) : null,
    now: new Date().toISOString(),
  });
  report.marker = queue?.checksPanel?.marker !== false;
  if (packs.problems.length) report.catalogErrors = [...report.catalogErrors, ...packs.problems];
  // The guard registry and the open inspection entries (cli/inspection.mjs). An error here never hides the rest.
  try {
    Object.assign(report, guardsBoard());
  } catch {
    // error-ignored: the board shows the checks without the guards
  }
  return report;
}

/**
 * The stack packs as facts for the report: what the manifests show (read only, nothing runs), what review.packs has on,
 * and what is missing. core comes with the first pack; a project with no known stack gets core alone.
 */
function packFacts(fsLike) {
  const data = RP.loadPacks({ own: OWN_PACKS });
  const { packs: detected, unpacked } = RP.detectStacks(fsLike, data);
  const applied = Array.isArray(CONFIG.review?.packs) ? CONFIG.review.packs : [];
  const missing = ['core', ...detected].filter((id) => !applied.includes(id));
  const titles = Object.fromEntries(['core', ...detected].map((id) => [id, data.packs[id]?.title ?? id]));
  return { data, problems: data.problems, facts: { detected, applied, missing, unpacked, titles } };
}

/** The project's files, read only, for the scans. */
function projectFs() {
  return {
    exists: (f) => fs.existsSync(path.join(PROJECT, f)),
    read: (f) => {
      try {
        return fs.readFileSync(path.join(PROJECT, f), 'utf8');
      } catch {
        return null;
      }
    },
    list: (dir) => {
      try {
        return fs.readdirSync(path.join(PROJECT, dir));
      } catch {
        return [];
      }
    },
  };
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
  if (s.action === 'ask') console.log(`This needs no agent. Ask Claude in your session:

${s.ask}

${CLI} checks dismiss ${s.key} sets it aside if you do it your own way.`);
  else if (s.action === 'packs') console.log(`${s.detail ?? ''}\n\nThis needs no agent: ${CLI} checks packs shows them, ${CLI} checks packs --apply turns them on.`);
  else if (s.action) console.log(`This needs no agent: ${CLI} kickstart gates --apply.`);
  else console.log(`Investigate\n${s.investigate}\n\nPlan and build\n${s.plan}\n\nAbout ${s.contentMin} min of agent work for the investigation.`);
}

function plan(key) {
  needsQueue();
  const queue = read();
  const report = makeReport(queue);
  const s = suggestion(report, key);
  if (s.action === 'ask') die(`${key} needs no agent, and a queue agent cannot do it. Ask Claude in your session:

${s.ask}`);
  if (s.action === 'packs') die(`${key} needs no agent. Run: ${CLI} checks packs --apply`);
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

/** queue.config.json as an object, or a stop when it does not parse. */
function ownConfig(file) {
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return die(`queue.config.json does not parse (${e.message}). Nothing written.`);
  }
}

const union = (x, y) => [...new Set([...(x ?? []), ...(y ?? [])])];

/**
 * `checks packs [--apply]`. A built-in pack is written as its id only: its words are read from the plugin at run time,
 * so they follow plugin updates. A project pack is not in the plugin, so its words are merged into review.signals too.
 */
function packs() {
  const p = packFacts(projectFs());
  const { detected, applied, missing, unpacked, titles } = p.facts;
  for (const e of p.problems) console.log(`Pack problem: ${e}`);
  console.log(`Stacks found in the manifests: ${detected.length ? detected.map((id) => `${titles[id]} (${id})`).join(', ') : 'none with a pack'}`);
  if (unpacked.length) console.log(`Known, but no pack yet: ${unpacked.join(', ')} (the Checks tab suggests the research)`);
  if (applied.length) console.log(`On in review.packs: ${applied.join(', ')}`);
  if (!missing.length) {
    console.log('The packs for your stack are already on. Nothing changed.');
    return;
  }
  for (const id of missing) {
    const pack = p.data.packs[id];
    console.log(`  ${id}: ${pack?.title ?? id}, signals ${Object.keys(pack?.signals ?? {}).join(', ')}${pack?.own ? ' (your own pack)' : ''}`);
  }
  if (!a.includes('--apply')) {
    console.log(`Nothing written. ${CLI} checks packs --apply turns them on in queue.config.json (review.packs).`);
    return;
  }
  const file = KK.configFile(MAIN_TREE);
  const own = ownConfig(file);
  const review = { ...own.review };
  review.packs = union(Array.isArray(review.packs) ? review.packs : [], missing);
  const signals = { ...review.signals };
  for (const id of missing) {
    const pack = p.data.packs[id];
    if (!pack?.own) continue;
    for (const [name, sig] of Object.entries(pack.signals ?? {})) {
      const prev = signals[name] ?? {};
      // A new signal (not built in) needs its reviewer and text, or nothing asks for the review.
      const known = RS.BUILTIN[name] ? {} : (p.data.newSignals?.[name] ?? {});
      signals[name] = { ...known, ...prev, words: union(prev.words, sig.words), ...(sig.paths || prev.paths ? { paths: union(prev.paths, sig.paths) } : {}) };
    }
  }
  if (Object.keys(signals).length) review.signals = signals;
  fs.writeFileSync(file, `${JSON.stringify({ ...own, review }, null, 2)}\n`);
  console.log(`Written to queue.config.json: review.packs ${review.packs.join(', ')}. The next review reads them. Off again: remove the ids from review.packs.`);
}

function setMarker(on) {
  needsQueue();
  edit((queue) => {
    queue.checksPanel = { ...queue.checksPanel, marker: on };
  });
  console.log(
    on
      ? `Checks marker: on. The Checks tab shows a small red dot while a high suggestion is open. Off: ${CLI} checks marker off.`
      : `Checks marker: off. The suggestions are still on the Checks tab, only the dot is gone. On: ${CLI} checks marker on.`,
  );
}

/** `ravenseat checks ...` (the usage is at the top of queue.mjs). */
export function cmdChecks() {
  const sub = a[1];
  if (sub === 'on' || sub === 'off') return setMode(sub);
  if (sub === 'show') return show(a[2]);
  if (sub === 'plan') return plan(a[2]);
  if (sub === 'packs') return packs();
  if (sub === 'marker') {
    if (a[2] !== 'on' && a[2] !== 'off') return die(`Use: ${CLI} checks marker on|off`);
    return setMarker(a[2] === 'on');
  }
  if (sub === 'dismiss' || sub === 'restore') {
    needsQueue();
    suggestion(makeReport(read()), a[2]);
    setDismissed(a[2], sub === 'dismiss');
    console.log(sub === 'dismiss' ? `${a[2]} is set aside. ${CLI} checks restore ${a[2]} brings it back.` : `${a[2]} is back among the suggestions.`);
    return undefined;
  }
  if (sub && sub !== '--json') return die(`Use: ${CLI} checks [--json] | show <key> | plan <key> [--approved] | dismiss <key> | restore <key> | packs [--apply] | marker on|off | on | off`);
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
