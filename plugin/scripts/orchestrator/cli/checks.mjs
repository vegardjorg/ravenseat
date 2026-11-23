// =============================================================
// cli/checks.mjs: `ravenseat checks`: what the project has for checking its code, and prioritized suggestions for what to add.
//
//   ravenseat checks [--json]             reads the project's files (never runs anything), prints the overview and saves it as
//                                  checks-report.json in the queue folder (ignored by git). Works before ravenseat init.
//                                  It also reads the tail of the newest Claude Code transcript (the format canary,
//                                  lib/clientCanary.js), and with client.shapeLog on writes client-shapes.jsonl there.
//   ravenseat checks show <key>           the suggestion's template: what the investigation and the plan cover
//   ravenseat checks plan <key> [--approved]   adds the investigation and planning as a task. A proposal without --approved; the
//                                  board's button passes it, because the click is the owner's yes.
//   ravenseat checks dismiss|restore <key>     sets a suggestion aside, or brings it back
//   ravenseat checks packs [--apply]      the stack packs for the review signals (lib/reviewPacks.js): which stacks the
//                                  manifests show and which packs are not on yet. --apply writes them to review.packs in
//                                  queue.config.json (a project pack from docs/queue/review-packs/ also into review.signals).
//   ravenseat checks turn-on <key>        a card with `action: setting`: turns its opt-in check on in queue.config.json
//                                  (lib/optInChecks.js; only those keys, and never from a track worktree). The board's
//                                  "Turn on" runs it.
//   ravenseat checks build-gate <class>@<area>   "Build as gate" on the card ledger-recipes: ONE proposed gate task
//                                  (GATE-<n>, the shared cap of three with INSP and GATE) for a due class and area of
//                                  the finding log, with the project's gate commands, CI files, test runner, the recipe
//                                  and the places in its mission (lib/findingRepeats.js buildTask). Needs inspection.mode
//                                  on; never from a track worktree. The board's button runs it.
//   ravenseat checks quick-add <G-n>    the card quick-gate-add: ADDS that gate guard's command (read from the registry)
//                                  at the end of gates.quick in queue.config.json. Never removes or replaces a command,
//                                  never runs it, never from a track worktree (lib/quickGate.js). The board's button runs it.
//   ravenseat checks recipe <id> show|damp|auto   the owner's choice for one recipe (lib/recipePrecision.js): show
//                                  offers it although few of its proposals were accepted, damp keeps it off the card,
//                                  auto lets its numbers decide again (queue.json checksPanel.recipes)
//   ravenseat checks marker on|off        the small red marker on the Checks tab when a high suggestion is open
//   ravenseat checks on|off               the opt-out: the Checks tab, this overview and the setup suggestions. Never a guard.
//
// The rules are in lib/checksScan.js and lib/checksCatalog.js, the suggestions in checks-catalog/ (and docs/queue/checks/
// in the project). Tested in: __tests__/checksFlow.test.ts.
// =============================================================

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { a, CONFIG, CLI, die, edit, FILE, FOLDER, KK, LM, MAIN_TREE, read, require } from './context.mjs';
import { addTask, ensureProject, PROJECT, readFacts } from './kickstart.mjs';
import { ciParityFacts, guardById, guardRecord, guardsBoard, ledgerScan } from './inspection.mjs';
import { allowlistFacts, broadFacts, gitignoreFacts, lockfileFacts, mcpFacts } from './doctorBaseline.mjs';
import { guardWeakening, trackBranchHere } from './settings.mjs';
import { enableShare } from './share.mjs';
import { keepAsNotBuilding, keepRefused } from './notBuilding.mjs';
import { depAuditSummary } from './depsAudit.mjs';

const SCAN = require('./lib/checksScan.js');
const CATALOG = require('./lib/checksCatalog.js');
const GD = require('./lib/guidance.js');
const KNOWN = require('./lib/knownBugGate.js');
const RP = require('./lib/reviewPacks.js');
const RS = require('./lib/reviewSignals.js');
const OI = require('./lib/optInChecks.js');
const RV = require('./lib/repoVisibility.js');
const QG = require('./lib/quickGate.js');
const OSV = require('./lib/osv.js');

/** The cached visibility (any age, never a network call here): the share card is offered only in a private repo. */
const cachedVisibility = () => RV.readCache(FOLDER, { any: true })?.visibility ?? null;

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

/**
 * The opt-in checks (lib/optInChecks.js) as facts: which are off, and the important gaps a quiet read finds while they
 * are (cli/doctorBaseline.mjs, read only). An error leaves a gap unknown, never invented.
 */
function optInFacts(git) {
  const off = OI.OPT_IN.filter((c) => !OI.isOn(CONFIG, c.key)).map((c) => c.key);
  const out = { optInOff: off, allowlistTrackedHit: false, gitignoreGap: false, repoPrivate: false };
  try {
    out.repoPrivate = RV.isPrivate(cachedVisibility());
  } catch {
    // error-ignored: unknown is not private, so no share card
  }
  if (!git) return out;
  try {
    // The setting covers the approved commands and .mcp.json (lib/mcpSecrets.js): a tracked key in either is important.
    if (off.includes('secretScan.allowlist')) out.allowlistTrackedHit = allowlistFacts().tracked.length > 0 || mcpFacts().tracked.length > 0;
  } catch {
    // error-ignored: the card shows at its own priority
  }
  try {
    // The shared settings file: the broad-permissions card is offered only where it exists, high for bypassPermissions.
    const b = broadFacts();
    out.sharedSettings = b.tracked;
    if (off.includes('permissionsCheck.enabled')) out.bypassTracked = require('./lib/broadPermissions.js').hasBypass(b.hits);
  } catch {
    // error-ignored: no card for the shared settings
  }
  try {
    if (off.includes('gitignoreCheck.enabled')) out.gitignoreGap = gitignoreFacts().important;
  } catch {
    // error-ignored: the card shows at its own priority
  }
  return out;
}

/** Is `file` ignored by git in the main tree (any rule)? On any error: not ignored. */
function ignoredHere(file) {
  try {
    execFileSync('git', ['-C', MAIN_TREE, 'check-ignore', '-q', '--no-index', '--', file], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * The facts of the 3b cards that need git, the host or the time log (the rest come from lib/checksScan.js). Each is read
 * on its own: an error leaves that fact unknown, and an unknown fact never shows a card that needs it.
 */
function projectFacts({ git, remote, found }) {
  const out = {};
  if (git) {
    try {
      const lf = lockfileFacts();
      if (lf) out.lockfileMissing = lf.gaps.length > 0;
    } catch {
      // error-ignored: unknown, no card
    }
    try {
      out.envWithoutExample = found.envFile === true && found.envExample === false && ignoredHere('.env');
    } catch {
      // error-ignored: unknown, no card
    }
  }
  // Branch protection on the host (lib/branchProtection.js): only a clear on hides the card. gh, cached for a day.
  if (remote) {
    try {
      const forced = process.env.QUEUE_BRANCH_PROTECTION; // the tests' answer, never a call (on, off or unknown)
      const BPR = require('./lib/branchProtection.js');
      const state = forced
        ? forced
        : BPR.current({ folder: fs.existsSync(FILE) ? KK.dataFolder() : null, remoteUrl: RV.remoteUrlOf(MAIN_TREE, CONFIG.remote ?? 'origin'), branch: CONFIG.baseBranch ?? 'main' });
      out.branchProtected = state === 'on';
    } catch {
      // error-ignored: unknown shows the card
    }
  }
  // Red on base (lib/redOnBase.js): is the command set, and which one the project's own files suggest (lib/fixTests.js).
  // Only a suggestion on the card: the config is never changed here.
  try {
    out.redOnBaseOff = !require('./lib/redOnBase.js').setup(CONFIG.gates);
    out.redOnBaseCommand = out.redOnBaseOff ? require('./lib/fixTests.js').suggestCommand(projectFs()) : null;
  } catch {
    // error-ignored: unknown, no card
  }
  try {
    const FO = require('./lib/flakyObserved.js');
    const text = require('./lib/timeLogArchive.js').readText(KK.timeLog());
    out.flakyObserved = FO.flakyFlips(FO.gateRows(text)).length;
  } catch {
    // error-ignored: no time log yet, nothing observed
  }
  // The finding log (lib/findingRepeats.js): what came back in one area, and a guard that did not hold (the red marker).
  // Read only, no proposal here: those come from the inspection scan. An error leaves the facts unknown, so no card.
  if (fs.existsSync(FILE)) {
    try {
      const now = Date.now();
      const { setup, rows, result, classes, tasks } = ledgerScan({ now });
      out.ledger = require('./lib/findingRepeats.js').facts(result, { rows, now, setup, classes, tasks });
    } catch {
      // error-ignored: unknown, no card
    }
  }
  return out;
}

/**
 * The client format canary as facts for its card (lib/clientCanary.js): the tail of the newest transcript only, so the
 * board's refresh stays light. With client.shapeLog on (and a data folder), the shape of a new API error form is logged
 * too. Off, unreadable or no transcript: no signal, no card. An error never hides the rest of the report.
 */
function canaryFacts() {
  try {
    const CC = require('./lib/clientCanary.js');
    const setup = CC.setupOf(CONFIG);
    if (!setup.on) return { signal: false };
    const summary = CC.readLatest(MAIN_TREE);
    if (setup.shapeLog && summary && fs.existsSync(FILE)) {
      try {
        CC.logShapes(KK.dataFolder(), summary);
      } catch {
        // error-ignored: the log is a help for a report, never a reason to lose the card
      }
    }
    return CC.facts(summary);
  } catch {
    return { signal: false }; // error-ignored: unknown, no card
  }
}

/**
 * The facts with the stack words the accepted stack entries of the project catalog declare (roadmap 0å KD-2,
 * lib/catalog.js withDeclaredStacks), so a recipe's `stack:<word>` holds and the dep-audit card names its command.
 * Only with catalog.stackFacts on (the default); off, no catalog or an error: the facts as the manifests give them.
 */
function declaredStackFacts(facts) {
  try {
    const C = require('./lib/catalog.js');
    if (!C.setupOf(CONFIG).stackFacts) return facts;
    const cat = C.readCatalog(path.join(PROJECT, ...C.DIR.split('/')));
    if (!cat.exists) return facts;
    let ledger = C.emptyLedger();
    try {
      ledger = C.parseLedger(fs.readFileSync(path.join(FOLDER, C.LEDGER_FILE), 'utf8'));
    } catch {
      // error-ignored: no record means nothing is accepted, so nothing is declared
    }
    const declared = C.declaredStacks(cat, ledger);
    return declared.length ? C.withDeclaredStacks(facts, declared) : facts;
  } catch {
    return facts; // error-ignored: the cards from the manifests alone
  }
}

/** Everything the report needs, read fresh. */
function makeReport(queue) {
  const facts = declaredStackFacts(readFacts());
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
  const catalog = CATALOG.loadCatalog({ builtin: BUILTIN, own: OWN });
  const precision = precisionFacts(queue, catalog);
  const found = SCAN.scan({ exists, read: readFile, list, gates: CONFIG.gates, checks: facts.checks, migrationsFolder: CONFIG.migrations?.folder ?? null });
  const report = CATALOG.buildReport({
    facts: {
      ...facts,
      ...found,
      packs: packs.facts,
      instructionsLarge: instructionsLarge(),
      ...optInFacts(facts.git),
      ...projectFacts({ git: facts.git, remote: facts.remote, found }),
      // The project catalog (lib/catalog.js): the card for it shows until the folder exists.
      catalogMissing: !exists('docs/queue/catalog'),
      // Lite mode (lib/liteMode.js): no scope drift card there, and none lights the red marker (condition not-lite).
      lite: LM.isLite(CONFIG),
      // The inspection queue (inspection.mode): the recipe card for the finding log needs it (condition inspection-on).
      inspectionOn: require('./lib/inspection.js').setupOf(CONFIG).enabled === true,
      // The database probe recipes (learning.dbProbes, off by default): condition db-probes-on (0i section 3.8).
      dbProbesOn: require('./lib/findingRepeats.js').setupOf(CONFIG).dbProbes === true,
      // The client format canary (lib/clientCanary.js): the card while the newest transcript has rows read differently.
      clientCanary: canaryFacts(),
      // Accepted and declined per recipe; a damped recipe is listed, never offered on the card (lib/recipePrecision.js).
      recipePrecision: precision,
      recipeDamped: precision?.damped ?? [],
      // CI parity for a built gate guard (0i step 9b): the card quick-gate-add and the lift of the CI cards.
      ...safeCiParity(readFile),
      // The dependency audit's cache (roadmap 0å KD-4, cli/depsAudit.mjs): the card dep-audit-found. Never the network.
      depAudit: safeDepAudit(),
      // The process guard (roadmap 0s, lib/processGuard.js): leftover processes, long runs without a track and tracks
      // over their estimate, for the cards processes-left, processes-untagged and tracks-overtime. Read only.
      processGuard: require('./lib/processGuard.js').factsFor({ folder: FOLDER, cfg: CONFIG, tasks: queue?.tasks ?? [] }),
      // The last `ravenseat secrets scan` (roadmap 6b, lib/repoSecretScan.js): the cards secret-scan-found and -due.
      keyScan: safeKeyScan(),
    },
    catalog,
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
  report.secretReads = secretReadFacts();
  return report;
}

/**
 * Secret reads by guarded agents in the last 7 days (lib/secretReads.js, guards.secretReads): per track, from the
 * time log's guard rows. null when the setting is "off" or the log cannot be read. Never a command or a path: the
 * rows only carry the rule.
 */
function secretReadFacts() {
  try {
    const SR = require('./lib/secretReads.js');
    const mode = SR.modeOf(CONFIG);
    if (mode === 'off') return null;
    const rows = require('./lib/timeCost.js').readRows(require('./lib/timeLogArchive.js').readText(KK.timeLog()));
    return { mode, days: 7, ...SR.counts(rows, { from: Date.now() - 7 * 86_400_000 }) };
  } catch {
    return null; // error-ignored: the Checks tab shows the rest without this section
  }
}

/**
 * The recipe precision (lib/recipePrecision.js) from the queue's tasks and the archived ones, the learning settings and
 * the owner's choices per recipe. Before ravenseat init, or on an error, null: nothing is damped then.
 */
function precisionFacts(queue, catalog) {
  if (!queue) return null;
  try {
    const RPR = require('./lib/recipePrecision.js');
    const archived = require('./lib/queueArchive.js').load(FOLDER).tasks ?? [];
    return RPR.facts({
      tasks: [...(queue.tasks ?? []), ...archived],
      setup: require('./lib/findingRepeats.js').setupOf(CONFIG),
      overrides: RPR.overridesOf(queue),
      recipes: catalog.recipes,
    });
  } catch {
    return null; // error-ignored: unknown precision damps nothing
  }
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

/**
 * The last key scan in numbers (lib/repoSecretScan.js summary, from its file; never a scan): { never: true, due } before
 * the first one, else the summary. Counts only, never a finding. Null on an error.
 */
function safeKeyScan() {
  try {
    const RS = require('./lib/repoSecretScan.js');
    const { rescanDays } = RS.setupOf(CONFIG);
    const s = RS.summary(RS.readResult(FOLDER), { ignored: RS.ignoredSet(FOLDER), rescanDays });
    return s ?? { never: true, due: rescanDays > 0 };
  } catch {
    return null; // error-ignored: no card rather than no Checks tab
  }
}

/** The dependency audit's summary from the cache, or null (no cache, deps.audit off, or it cannot be read). */
function safeDepAudit() {
  try {
    return depAuditSummary();
  } catch {
    return null; // error-ignored: no card rather than no Checks tab
  }
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
  const measured = report.recipePrecision?.recipes ?? [];
  if (measured.length) {
    const RPR = require('./lib/recipePrecision.js');
    console.log('\nRecipe precision (gate proposals from the finding log, accepted out of decided)');
    for (const r of measured) console.log(`  ${RPR.line(r)}`);
    console.log(`  A damped recipe is listed here, not offered on the card. ${CLI} checks recipe <id> show|damp|auto changes that.`);
  }
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

/** The suggestion, for a step that acts on it (plan, turn-on): one set aside that no longer applies is refused. */
function applying(report, key) {
  const s = suggestion(report, key);
  if (s.applies === false) die(`${key} is set aside and does not apply to this project now, so nothing was added or changed. ${CLI} checks restore ${key} brings it back for when it applies.`);
  return s;
}

function show(key) {
  const s = suggestion(makeReport(queueNow()), key);
  console.log(`${s.title} (${s.category}, ${s.priority} priority)\n\nWhy: ${s.why}\n`);
  if (s.applies === false) console.log(`Set aside, and it does not apply to this project now. ${CLI} checks restore ${s.key} brings it back for when it does.\n`);
  if (s.action === 'ask') console.log(`This needs no agent. Ask Claude in your session:

${s.ask}

${CLI} checks dismiss ${s.key} sets it aside if you do it your own way.`);
  else if (s.action === 'packs') console.log(`${s.detail ?? ''}\n\nThis needs no agent: ${CLI} checks packs shows them, ${CLI} checks packs --apply turns them on.`);
  else if (s.action === 'setting') console.log(`This needs no agent: ${CLI} checks turn-on ${s.key} (sets ${s.setting} on). ${CLI} checks dismiss ${s.key} sets it aside.`);
  else if (s.action === 'quick-gate') console.log(`${s.detail ?? ''}

This needs no agent: ${CLI} checks quick-add <G-n> adds that guard's command to gates.quick (nothing runs).`);
  else if (s.action === 'dep-fix') console.log(`${s.detail ?? ''}

${CLI} checks plan ${s.key} proposes one task that updates them, worst first (it waits for Approve). ${CLI} catalog deps --audit lists them all.`);
  else if (s.action) console.log(`This needs no agent: ${CLI} kickstart gates --apply.`);
  else console.log(`Investigate\n${s.investigate}\n\nPlan and build\n${s.plan}\n\nAbout ${s.contentMin} min of agent work for the investigation.`);
}

function plan(key) {
  needsQueue();
  const queue = read();
  const report = makeReport(queue);
  const s = applying(report, key);
  if (s.action === 'ask') die(`${key} needs no agent, and a queue agent cannot do it. Ask Claude in your session:

${s.ask}`);
  if (s.action === 'packs') die(`${key} needs no agent. Run: ${CLI} checks packs --apply`);
  if (s.action === 'setting') die(`${key} needs no agent. Run: ${CLI} checks turn-on ${key}`);
  if (s.action === 'quick-gate') die(`${key} needs no agent. Run: ${CLI} checks quick-add <G-n> (${CLI} checks show ${key} lists the guards)`);
  if (s.action === 'dep-fix') return planDepFix(s, queue);
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

/**
 * The dependency audit's card (roadmap 0å KD-4): one task that updates the packages with known holes, worst first
 * (lib/osv.js fixTask). Always a proposal, also with --approved from the board: the owner sees the list before an agent
 * changes the lockfile. Its id KS-PLAN-DEP-AUDIT-FOUND(-n) lets the card show it as queued.
 */
function planDepFix(s, queue) {
  if (s.state === 'queued') {
    console.log(`Not added: ${s.taskId} is already there.`);
    return;
  }
  const sum = depAuditSummary();
  if (!sum?.open) die(`The last dependency audit has nothing open. ${CLI} catalog deps --audit asks OSV.dev again.`);
  ensureProject();
  const n = CATALOG.planTasks(s.key, queue.tasks).length;
  const id = `KS-PLAN-${s.key.toUpperCase()}${n ? `-${n + 1}` : ''}`;
  const task = { ...OSV.fixTask(sum, { id }), ...(LM.isLite(CONFIG) ? {} : { project: 'cicd' }) };
  const r = addTask(task, { approved: false });
  if (!r.ok) die(r.output);
  if (s.state === 'dismissed') setDismissed(s.key, false);
  console.log(r.output);
  console.log(`Proposed, so nothing runs yet: ${CLI} approve ${task.id} (or Approve on the board) lets it run. About ${task.content_min} min of agent work.`);
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

/**
 * Turns an opt-in check on: the card's setting, written to queue.config.json like `settings set <key> on`. Only a key in
 * lib/optInChecks.js, so a project's own card cannot switch anything else, and turning on never weakens a guard.
 * Refused from a track worktree: an agent never changes the queue's checks.
 */
function turnOn(key) {
  const track = trackBranchHere();
  if (track) die(`${CLI} checks turn-on cannot be run from inside a track worktree (branch ${track}); ask the owner. Nothing was changed.`);
  const s = applying(makeReport(queueNow()), key);
  const c = s.action === 'setting' ? OI.byKey(s.setting) : null;
  if (!c) die(`${key} has no setting to turn on. ${CLI} checks show ${key} says what it needs.`);
  // Sharing is never a plain setting write: the owner's click on the card (offered only in a private repo) is the
  // confirmation, and it goes through the same enableShare as `share on --yes` (config, .gitignore, audit row).
  if (c.key === 'share.queueData') {
    const vis = cachedVisibility();
    if (!RV.isPrivate(vis)) die(`${key}: this repo is not known to be private, so ${CLI} share on explains and confirms first. Nothing was changed.`);
    for (const l of enableShare({ include: require('./lib/queueShare.js').shareOf(CONFIG).include, visibility: vis, by: 'owner (checks)' })) console.log(l);
    return;
  }
  const SV = require('./lib/settingsView.js');
  const file = KK.configFile();
  let text = null;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e?.code !== 'ENOENT') die(`checks turn-on: could not read ${file} (${e.message}). Nothing was changed.`);
  }
  let next;
  try {
    next = SV.setJsonText(text, SV.pathOf(c.key), true);
  } catch (e) {
    die(`checks turn-on: ${file} is not a JSON object (${e.message}). Nothing was changed.`);
  }
  if (next !== text) fs.writeFileSync(file, next);
  console.log(`${c.key} = on (queue.config.json). The card is done. Off again: ${CLI} settings set ${c.key} off.`);
}

/** The CI parity facts (cli/inspection.mjs ciParityFacts) with the project's package.json scripts; an error: none. */
function safeCiParity(readFile) {
  try {
    const pkg = JSON.parse(readFile('package.json') ?? '{}');
    const scripts = pkg && typeof pkg.scripts === 'object' && !Array.isArray(pkg.scripts) ? pkg.scripts : {};
    return ciParityFacts({ scripts });
  } catch {
    // error-ignored: no card and no lift, the rest of the Checks tab is shown
    return {};
  }
}

/**
 * `checks quick-add <G-n>`: the card "Run a built gate guard on every merge" (0i step 9b). The guard's command is read
 * from the main tree's registry (never taken from the board or the command line) and ADDED at the end of gates.quick
 * in queue.config.json; the write keeps the rest of the file and can never remove, replace or reorder a command
 * (lib/quickGate.js addToQuickText). Refused from a track worktree, for a deploy command or a push, and for a guard that
 * is not an active gate guard with a command. Nothing is run: the next merge runs it as a gate.
 */
function quickAdd(raw) {
  const track = trackBranchHere();
  if (track) die(`${CLI} checks quick-add cannot be run from inside a track worktree (branch ${track}); ask the owner. Nothing was changed.`);
  const id = QG.itemId(raw);
  if (!id) die(`Use: ${CLI} checks quick-add <G-n>   (a gate guard id from ${CLI} guards)`);
  const { guard, error } = guardById(id);
  if (!guard) die(`checks quick-add: ${error}. Nothing was changed.`);
  if (guard.status !== 'active' || guard.kind !== 'gate' || typeof guard.command !== 'string' || !guard.command.trim())
    die(`checks quick-add: ${id} is not an active gate guard with a command, so there is nothing to add. Nothing was changed.`);
  const file = KK.configFile();
  let text = null;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e?.code !== 'ENOENT') die(`checks quick-add: could not read ${file} (${e.message}). Nothing was changed.`);
  }
  const r = QG.addToQuickText(text, guard.command, { deployCommands: CONFIG.deployCommands ?? [] });
  if (r.error) die(`checks quick-add: ${r.error}. Nothing was changed.`);
  if (!r.changed) return console.log(`"${guard.command.trim()}" is already in gates.quick. Nothing was changed.`);
  // The one weakening rule every config write goes through (cli/settings.mjs). Adding a gate never weakens one, so this
  // passes; it is here so a future rule on gates.quick applies to this write too.
  guardWeakening('gates.quick', r.list, { confirmWith: `${CLI} checks quick-add ${id}` });
  fs.writeFileSync(file, r.text);
  console.log(`${id}: "${guard.command.trim()}" added at the end of gates.quick (queue.config.json). Nothing was run; the next merge runs it as a gate. Commit queue.config.json.`);
  return undefined;
}

/** The test runner for the mission: the first test command the scan found (a gate first), else the one the files suggest. */
function testRunnerOf(found) {
  const kind = (found?.kinds ?? []).find((k) => k.key === 'test');
  const places = kind?.places ?? [];
  const hit = places.find((p) => p.where === 'gate' && p.command) ?? places.find((p) => p.command);
  if (hit) return hit.command;
  try {
    return require('./lib/fixTests.js').suggestCommand(projectFs()) ?? null;
  } catch {
    return null; // error-ignored: the mission says the runner is not known
  }
}

/**
 * `checks build-gate <class>@<area>`: "Build as gate" (0i section 3.7 point 3). The entry is read again from the finding
 * log here (the board only names it), and the same rules as every gate proposal decide (lib/knownBugGate.js decide):
 * one open already is named, a declined or built one is not proposed again, and the shared cap of three makes it wait.
 * Always proposed: the click asks for the gate, the owner's approve lets an agent spend tokens on it.
 */
function buildGate(raw) {
  needsQueue();
  const track = trackBranchHere();
  if (track) die(`${CLI} checks build-gate cannot be run from inside a track worktree (branch ${track}); ask the owner. Nothing was added.`);
  const FR = require('./lib/findingRepeats.js');
  const key = FR.itemKey(raw);
  if (!key) die(`Name a class and area as <class>@<area>, as the card ledger-recipes shows them (${CLI} checks --json). Nothing was added.`);
  if (!require('./lib/inspection.js').setupOf(CONFIG).enabled)
    die(`Proposals from the finding log need the inspection queue on: ${CLI} settings set inspection.mode on. Nothing was added.`);
  // The queue's tasks with the archived ones (ledgerScan reads both), so a built or declined one is seen.
  const { result, classes, tasks: known } = ledgerScan();
  const entry = result.due.find((e) => e.key === key);
  if (!entry) die(`${key} is not due in the finding log now (it needs repeats in separate tasks), so nothing was added. ${CLI} checks --json shows the card ledger-recipes.`);
  const queue = read();
  const d = KNOWN.decide({ title: FR.gateTitle(entry, classes), tasks: known, mode: 'propose' });
  if (d.action === 'extend') {
    console.log(`Not added: ${key} is already proposed as ${d.task.id} (${d.task.status}). ${CLI} approve ${d.task.id} lets it run.`);
    return;
  }
  if (d.action === 'exists') die(`Not added: ${d.task.id} already built a gate for ${key}. A new incident there means that gate needs a look.`);
  if (d.action === 'declined') die(`Not added: ${d.task.id} for ${key} was declined, and a no is remembered per class and area.`);
  if (d.action === 'full')
    die(`Not added: the cap of three open proposals (inspection and gate) is full, or ${KNOWN.MAX_OPEN} gate tasks are open. It waits for a free slot: approve or cancel one first (${CLI} gate list, ${CLI} inspection).`);
  const report = makeReport(queue);
  const item = report.suggestions.find((s) => s.key === 'ledger-recipes')?.ledger?.items?.find((i) => i.key === key) ?? null;
  const recipe = item?.recipe ? { id: item.recipe.id, title: item.recipe.title, text: item.recipe.text, db: item.recipe.db === true } : null;
  const gates = CONFIG.gates ?? {};
  const project = {
    quick: Array.isArray(gates.quick) ? gates.quick : [],
    full: Array.isArray(gates.full) ? gates.full : [],
    ci: [...new Set((report.found?.ci ?? []).map((c) => c.file).filter(Boolean))],
    testRunner: testRunnerOf(report.found),
    // The shared database guard in the mission (lib/findingRepeats.js buildTask, 0i section 3.8).
    database: { has: report.found?.hasDatabase === true, guardOn: OI.isOn(CONFIG, 'dbGuard.localOnly') },
  };
  if (!LM.isLite(CONFIG)) ensureProject();
  const id = KNOWN.nextId(known);
  const task = { ...FR.buildTask(entry, { id, classes, record: guardRecord(), project, recipe }), ...(queue.projects?.cicd ? { project: 'cicd' } : {}) };
  const r = addTask(task);
  if (!r.ok) die(r.output);
  console.log(
    `${id} proposed: ${task.title}. About ${task.content_min} min of agent work once approved, and it uses tokens. ` +
      `${CLI} approve ${id} (or Approve on the board) lets it run; ${CLI} cancel ${id} declines it for that class and place.`,
  );
}

/**
 * `checks recipe <id> show|damp|auto`: the owner's choice for one recipe (lib/recipePrecision.js). show offers it on the
 * card whatever its numbers, damp keeps it off the card, auto removes the choice. Only a recipe of the catalog; never
 * from a track worktree. It hides or shows a suggestion only, so it needs no confirmation.
 */
function setRecipe(id, choice) {
  needsQueue();
  const track = trackBranchHere();
  if (track) die(`${CLI} checks recipe cannot be run from inside a track worktree (branch ${track}); ask the owner.`);
  if (!['show', 'damp', 'auto'].includes(choice)) die(`Use: ${CLI} checks recipe <id> show|damp|auto`);
  const recipes = CATALOG.loadCatalog({ builtin: BUILTIN, own: OWN }).recipes;
  const recipe = recipes.find((r) => r.id === id);
  if (!recipe) die(`There is no recipe ${String(id ?? '').slice(0, 60)}. ${CLI} checks lists the measured ones; the catalog is checks-catalog/recipes.json and docs/queue/checks/recipes.json.`);
  edit((queue) => {
    const own = { ...(queue.checksPanel?.recipes ?? {}) };
    if (choice === 'auto') delete own[id];
    else own[id] = choice;
    queue.checksPanel = { ...queue.checksPanel, recipes: own };
  });
  const said = {
    show: `${id} is offered on the card again, whatever its numbers.`,
    damp: `${id} is damped: listed on the Checks tab, not offered on the card.`,
    auto: `${id} follows its numbers again (learning.recipeDamping).`,
  };
  console.log(`${said[choice]} ${CLI} checks recipe ${id} auto undoes it.`);
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
  if (sub === 'turn-on') return turnOn(a[2]);
  if (sub === 'build-gate') return buildGate(a[2]);
  if (sub === 'quick-add') return quickAdd(a[2]);
  if (sub === 'recipe') return setRecipe(a[2], a[3]);
  if (sub === 'marker') {
    if (a[2] !== 'on' && a[2] !== 'off') return die(`Use: ${CLI} checks marker on|off`);
    return setMarker(a[2] === 'on');
  }
  if (sub === 'dismiss' || sub === 'restore') {
    needsQueue();
    // dismiss --keep [--why "..."] (roadmap 0f): the card set aside also becomes a proposed "Not building" entry, the
    // reason as its text. Refused before anything changes when catalog.captureAnswers is off or from a track.
    const keep = sub === 'dismiss' && a.includes('--keep');
    if (keep) keepRefused('checks dismiss');
    const s = suggestion(makeReport(read()), a[2]);
    setDismissed(a[2], sub === 'dismiss');
    // A card set aside that no longer applies is restored too; it shows again once its condition holds.
    const back = s.applies === false ? `${a[2]} is no longer set aside. It does not apply to this project now, and shows among the suggestions once it does.` : `${a[2]} is back among the suggestions.`;
    console.log(sub === 'dismiss' ? `${a[2]} is set aside. ${CLI} checks restore ${a[2]} brings it back.` : back);
    if (keep) {
      const why = a.includes('--why') ? (a[a.indexOf('--why') + 1] ?? null) : null;
      console.log(keepAsNotBuilding({ title: s.title ?? a[2], why, source: `Checks card ${a[2]}` }).line);
    }
    return undefined;
  }
  if (sub && sub !== '--json') return die(`Use: ${CLI} checks [--json] | show <key> | plan <key> [--approved] | dismiss <key> | restore <key> | packs [--apply] | turn-on <key> | build-gate <class>@<area> | quick-add <G-n> | recipe <id> show|damp|auto | marker on|off | on | off`);
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
