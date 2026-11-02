// =============================================================
// queueConfig.js: the project settings for the queue system (queue.config.json in the project root).
//
// Everything project specific (the name of the integration branch, the commands that are "gates", an optional
// migration flow, the modules in the plan register, the architecture rules to include in cloud missions, etc.) lives in
// queue.config.json, not in the code. The file is optional: if it is missing, STANDARD below applies. The fields are merged
// recursively (objects field by field, lists and numbers are replaced entirely).
//
// The project root is found like this: two folders above scripts/orchestrator/, and when a script runs from an agent worktree
// (<root>/.claude/worktrees/<name>/...), mainTree is used. QUEUE_ROOT overrides (tests).
// QUEUE_CONFIG overrides the path to the file (tests).
// =============================================================

const fs = require('node:fs');
const path = require('node:path');
const { roots } = require('./projectRoot.js');

/**
 * The modules that can be switched off (`features` in queue.config.json). One line per module: the key and its
 * default. A new switch is one more line here, plus a guard where the module is shown. A dotted key is a part of
 * another module ("plans.legal" is the Legal surface inside Plans) and is only on when its parent is on too.
 */
const FEATURES = Object.freeze({
  plans: true, // the Plans room on the board (the CLI plan register is never switched off: skills use it)
  'plans.legal': false, // the Legal surface in Plans
  'plans.launch': false, // the Launch surface in Plans
  'plans.documents': false, // the Documents and agreements surface in Plans
  focus: true, // the Focus tab on the board
  statistics: true, // the Statistics tab on the board
  cloud: false, // cloud sessions: the Cloud tab, the cloud filter and detail row, and the cloud commands
  follow: false, // the follow-up entries: the /follow page, the follow commands and their lines in show and pulse
});

/** The default values. Edit them in queue.config.json, not here. */
const STANDARD = Object.freeze({
  // "full" (every feature) or "lite" (the core loop only: init, add with just a title, show, fill, receive, merge; one
  // task type, no small-task guard or batch queue, the short help; owner questions stay). See lib/liteMode.js. A config
  // without the key is full, so existing installs keep working as before; a fresh `cq init` writes "lite" (opt out
  // with `cq init --full`). Switch with `cq mode lite|full`.
  mode: 'full',
  // The project name in texts (mission, agent messages, the board).
  projectName: 'theProject',
  // The integration branch: everything is merged here, and this is what is pushed in batches. Often main or develop.
  baseBranch: 'main',
  // Remote for push and for cloud sessions (origin/<baseBranch>).
  remote: 'origin',
  // Where the queue, the plan register and the logs live (relative to the project root, gitignored).
  dataFolder: 'scripts/.queue',
  // The time log hook-time.mjs writes (usage per agent).
  timeLog: 'scripts/.queue/times.jsonl',
  // Branch prefix for queue tasks: <branchPrefix><id>.
  branchPrefix: 'queue/',
  // Folders (relative to the root) linked into each agent worktree instead of being installed again.
  sharedLinks: ['node_modules'],
  // The gates tracks run before delivery (gates.mjs). Each is a shell command; empty list = no gate.
  gates: {
    quick: [],
    full: [],
    // The fail-fast precheck before the full gate (`gates.mjs --precheck`, lib/gatePrecheck.js): the cheapest checks
    // first, stop at the first red one. A list of commands (or { name, command, files, budgetSec }) where {changed} is
    // the changed files against baseBranch and {file} runs once per file. null = the standard checks the project has
    // (node --check, tsc --noEmit, eslint and related tests on the changed files); [] = no precheck.
    precheck: null,
    precheckBudgetSec: 120, // time budget per check (seconds) when the check does not set budgetSec
  },
  // The done command (task field `done_when`, lib/doneCheck.js): `receive` and `merge` run it in the track's worktree.
  // timeoutSec = the time budget per run (a run over it is red); tailLines = how many of the last output lines are kept
  // for the fix brief (only the tail, so a secret printed early in a long run is not copied around).
  doneCheck: { timeoutSec: 600, tailLines: 40 },
  // The base gate (lib/baseHealth.js): after `cq merge` the base branch's new tip is checked in the main checkout and the
  // verdict recorded per tip; a red base stops further merges until a fix task makes it green. enabled: "auto" (on when
  // there are commands), true or false. commands: null = the quick gates (then the merge step's own gates run is the
  // check, nothing runs twice), or a list (e.g. the full gate) run after the quick gates. timeoutSec = the budget for
  // the whole list; tailLines = the output lines kept for the fix task (null = doneCheck.tailLines).
  baseGate: { enabled: 'auto', commands: null, timeoutSec: 900, tailLines: null },
  // The batch push threshold (lib/pushBatch.js; `cq push-check`, the push guard, the board). Every push of baseBranch
  // runs the whole CI, so pushes come in batches of MERGED TASKS (merges through cq merge not yet on <remote>).
  // mode: "owner" = the orchestrator never pushes on its own, only on the owner's word; "threshold" = it may push by
  // itself when push-check says READY or LARGE (never BLOCKED). minTasks: the batch is ready at this many merged tasks
  // (0 = no lower limit); a plain push below it gets a confirmation dialog in both modes. warnTasks: from this many,
  // push-check says LARGE (a warning, never a block: a big batch makes a red CI harder to bisect; 0 = off).
  // maxAgeHours: when set, the oldest unpushed work older than this makes the batch ready below minTasks.
  push: { mode: 'owner', minTasks: 10, warnTasks: 50, maxAgeHours: null },
  // The branch that goes live (production). null = unknown. `cq doctor` warns when it is the same as baseBranch: every
  // batch push would then go straight to production. Nothing else reads it yet.
  productionBranch: null,
  // Commands that deploy (e.g. "vercel --prod", "fly deploy"). The push guard ASKS before any command that starts with
  // one of them, from an agent or the main session (a simple prefix match after env prefixes; never complete, so keep
  // production credentials out of the shell too). Empty = off.
  deployCommands: [],
  // The secret precheck before a plain push of baseBranch from the main session (lib/secretScan.js): the added lines of
  // what the push sends are scanned (gitleaks when it is on PATH, else built-in patterns) and a hit gets a confirmation
  // dialog naming file:line, never the value. maxBytes: a larger diff is skipped silently. timeoutMs: per git or
  // gitleaks call. Fails open.
  secretScan: { enabled: true, maxBytes: 2_000_000, timeoutMs: 3000 },
  // `cq doctor` warns about tracked files larger than this (MB).
  largeFileMb: 5,
  // The fix-round cap per task (`resume --reason fix`, also the one receive starts after a red done command). At the cap
  // the task becomes an owner question instead of another round. The task field `max_fix_rounds` overrides it.
  maxFixRounds: 3,
  // Optional migration flow (e.g. database migrations that must be numbered and pushed after merge).
  // With folder = null everything to do with migrations is turned off (no number blocks, no push in merge).
  migrations: {
    folder: null, // e.g. "db/migrations"
    filePattern: '^(\\d+)_.*\\.sql$', // first group = the number
    blockSize: 10, // numbers per task that touches migrations
    pushCommand: null, // e.g. "npm run db:migrate"; null = merge never pushes
    // Optional guard: the file that says which environment is linked, and the values it is allowed to push to.
    environmentFile: null,
    allowedEnvironment: [],
  },
  // Architecture rules written into cloud missions and the mission text (short lines, the project's own).
  architectureRules: [],
  // The plan register modules (areas). Created with `queue.mjs plan modules`.
  modules: [
    { oid: 'example', title: 'Example', description: 'Example area, give it a new name or delete it' },
    { oid: 'without-module', title: 'No fixed area', description: 'Projects that do not belong to an area yet' },
  ],
  // Suggested module per project id (used by `plan modules --link`).
  projectModuleSuggestion: {},
  // Optional path to a script that backs up the plan register (`queue.mjs plan backup`).
  planBackup: null,
  // The document register: optional list of vendors/subprocessors checked against documents.
  // One element in vendors: { id, name, word?, documents?: (path | { doc, section?, where? })[] }. Empty = off.
  documents: {
    vendors: [],
    secretsManifest: null, // file listing the vendors actually in use; null = no filtering
    vendorSwitches: [], // planned switches: { out, in, planEntry?, text? }
  },
  // The folders the plan register looks for documents in (unregistered documents, the read view, the index).
  documentFolders: ['docs'],
  // The document index make-index.mjs maintains; null turns the index off.
  indexFile: 'docs/INDEX.md',
  // The priority rules in the plan register. null = the generic default rules (`queue.mjs plan rules`).
  priorityRules: null,
  // The fixed reviewer agents run per class after `queue.mjs receive` (always, not switches).
  reviewers: { K: [], U: [], D: ['reviewer'], 'D+': ['reviewer', 'reviewer-security'] },
  // Model per agent: agent name (track, track-d, reviewer, reviewer-docs, a helper ...) -> "opus", "sonnet", "haiku"
  // or "fable". Empty (default) = the model in each agent's own file. A set model is printed on the start lines
  // (fill, start, resume, receive) as `model=<m>`, and the orchestrator passes it to the Agent tool, which overrides
  // the agent file. Example: { "reviewer-docs": "sonnet", "reviewer-gap": "sonnet" }.
  models: {},
  // The list prices for the cost measurement (lib/timeCost.js PRICE_TABLE, per model family). null = the table. An
  // override: { "<model id or part of it>": { input, output, cache_read, cache_5m?, cache_1h? } } in USD per MTok; the
  // cache write prices default to 1.25x and 2x the input price. Example: { "opus-4-1": { input: 15, output: 75, cache_read: 1.5 } }.
  prices: null,
  // The transcript metrics in the time log (hook-time.mjs): idleGapMin = a gap longer than this many minutes between
  // two transcript entries is idle and not counted in active_s.
  metrics: { idleGapMin: 5 },
  // Helper agents: optional reviewers on top of the fixed ones (lib/queueHelpers.js). One runs for a task when it is
  // enabled AND at least one condition hits: classes, labels, paths (a changed file matches), mostlyPaths (more than
  // half of the changed files match), plan (the task has a plan entry), minMissionItems (numbered points in the
  // mission). `cq helpers on|off <agent>` (and the board's "Helper agents" tab) switch them in queue.json, which wins.
  // Path patterns: "dir/" = the folder from the root, "*.md" = that file name anywhere, "**" = any folders.
  helpers: {
    'reviewer-challenger': { enabled: true, classes: ['U'], labels: ['bug'] },
    'reviewer-design': { enabled: true, labels: ['visual'], paths: [] },
    'reviewer-tests': { enabled: false, classes: ['D', 'D+'], labels: ['bug'] },
    'reviewer-gap': { enabled: false, plan: true, minMissionItems: 8 },
    'reviewer-docs': { enabled: false, mostlyPaths: ['docs/', '*.md'] },
    // The intake triage (lib/queueTriage.js): runs before the start, not after receive; its rule is `triage` below.
    triage: { enabled: true },
  },
  // Intake triage (lib/queueTriage.js, the `triage` helper): before `fill` starts a task that was added or last edited
  // minAgeDays ago or more (null = no age rule), or that an agent added (agentAdded, once), a short read-only agent
  // checks it against the current code: ready, done, stale or adjust. Never fix tasks or continuations. At most
  // maxPerFill triage steps per fill; a printed step is not printed again for askAgainMin minutes. Off: `cq helpers
  // off triage` (or helpers.triage.enabled false). Lite mode: off unless switched on in the queue.
  triage: { minAgeDays: 3, agentAdded: true, maxPerFill: 3, askAgainMin: 60 },
  // When a focus has ended (every stage done, or its period `to` is over; lib/logic/ranking.js "When the focus has
  // ended"): continueWhenEmpty false (the default) pauses the queue (fill starts nothing) and asks the owner one
  // question in "Waiting on you": set a new focus or continue the regular queue. true = the queue continues by itself
  // (rest fill keeps filling, an expired focus is ranked as without focus), with one line saying so. A focus can
  // override it: cq focus set ... --continue-when-empty on|off. A project that never set a focus is not affected.
  focus: { continueWhenEmpty: false },
  // Read guard (hook-read-guard.mjs): in addition to the built-in lists.
  readGuard: {
    agentTypes: [], // more agent types the guard applies to (track, track-d and the reviewers are already included)
    autoLoaded: [], // files Claude Code loads itself and that must never be read with Read
    largeFiles: [], // glob patterns for files that must always be read in excerpts
    maxLines: 300,
    blockLines: 2000,
  },
  // Merge guard (lib/mergeGuard.js): paths a track may only change when its task owns them (owned_files or
  // shared_patch). Otherwise merge-track.mjs stops before the merge (exit 4; --allow-guard overrides). These paths can
  // run code or give instructions with the owner's rights in the orchestrator session: hooks, settings, agents, skills,
  // the orchestrator scripts and the queue config. "folder/" = the folder from the root, "dir/file" = that exact path,
  // a bare name (no slash) = that file name in any folder, an entry with * or ? = a glob (without a slash on the file
  // name in any folder, with a slash on the path from the root, "**/" = any folders). An empty list turns the guard off.
  // A list in queue.config.json REPLACES this one (lists are not merged): copy the entries you want to keep.
  protectedPaths: [
    '.claude/', // project settings, hooks, agents, skills, rules
    '.claude-plugin/',
    '.githooks/',
    '.github/',
    '.mcp.json',
    'scripts/orchestrator/', // the installed queue scripts and hooks
    'plugin/scripts/orchestrator/', // the same, in the plugin's own repo
    'plugin/hooks/',
    'plugin/agents/',
    'plugin/skills/',
    'plugin/.claude-plugin/',
    'queue.config.json',
    'CLAUDE.queue.md',
    'settings.queue.json',
    'package.json',
    'package-lock.json',
    // The test, lint and type configs (any folder): a track must not get green by switching a check off, narrowing
    // what a runner collects or loosening a threshold. Formatter configs are left out (formatting cannot hide a bug).
    // Some of these files hold more than check config (pyproject.toml, Cargo.toml, setup.cfg, Makefile): a task that
    // has to change them owns them in owned_files.
    'vitest.config.*',
    'vitest.workspace.*',
    'jest.config.*',
    'playwright.config.*',
    'cypress.config.*',
    'karma.conf.*',
    '.mocharc*',
    'tsconfig*.json',
    '.eslintrc*',
    'eslint.config.*',
    'biome.json*',
    'pytest.ini',
    'tox.ini',
    'setup.cfg',
    'conftest.py',
    'pyproject.toml',
    'mypy.ini',
    '.coveragerc',
    '.flake8',
    '.golangci.*',
    'Cargo.toml',
    'Makefile',
    'Justfile',
    'justfile',
    '.pre-commit-config.yaml',
    'phpunit.xml*',
    '.rspec',
  ],
  // Test-weakening warning (lib/testWeakening.js): `receive` reads the task branch's diff against the merge base and
  // reports deleted test files, test files moved out of the test paths and skip or focus markers on ADDED lines in
  // test files (.skip(, .only(, xit(, @pytest.mark.skip, #[ignore], t.Skip(, @Disabled …). A warning in the receive
  // output and a "Test weakening" section in 00-package.md, never a stop. testPaths: more test file globs (same rules
  // as protectedPaths). markers: more regular expressions (JavaScript syntax) for an added line in a test file.
  testWeakening: { enabled: true, testPaths: [], markers: [] },
  // Load guard (queueLogic.loadGuard): `next`, `start` and `fill` refuse new starts (exit 7) while free memory
  // (os.freemem / os.totalmem, percent) is below minFreeMemoryPct. null = off. `queue.mjs limit minFreeMemoryPct`
  // sets the value for the queue and wins over this one.
  // Default 10: a full machine makes gates red from timeouts and memory, not from code. macOS reports little free
  // memory (the page cache counts as used), so there the default is off; set a number to turn it on.
  //
  // Adaptive slots (lib/loadSlots.js): above the hard limit, the number of parallel slots follows the load instead of
  // always being maxConcurrent. All slots at or above allSlotsFreeMemoryPct free memory, minSlots at the hard limit,
  // linear in between. CPU is optional: both allSlotsCpuPct and minSlotsCpuPct set (e.g. 60 and 95) turns it on; it
  // costs a ~200 ms sample per call. adaptive false (or QUEUE_LOAD_ADAPTIVE=off) = the fixed maxConcurrent as before.
  // On macOS the memory part is off by default for the same reason as the hard limit.
  loadGuard: {
    minFreeMemoryPct: process.platform === 'darwin' ? null : 10,
    adaptive: true,
    minSlots: 1,
    allSlotsFreeMemoryPct: process.platform === 'darwin' ? null : 40,
    allSlotsCpuPct: null,
    minSlotsCpuPct: null,
  },
  // Auto-accept of agent proposals (lib/queueProposals.js): a proposal that fits the rules is approved by the queue
  // itself (in `queue.mjs add` and `orchestrator pulse`), logged and can be undone. Default off. `queue.mjs proposals
  // auto` and the board's gear write the queue's own rules (queue.json proposals.autoAccept), which win field by field.
  // Never D or D+, never with waiting_on, legal/owner labels, open legal points or protected paths, whatever is set here.
  proposals: {
    autoAccept: { enabled: false, classes: ['K'], maxEstimateMin: 60, maxValue: null },
  },
  // QA evidence: how the owner (or the queue itself) sees that a delivery works. A track writes one line
  // `EVIDENCE <type>[=<ref>[,<ref>...]]` in report.md, and `queue.mjs receive` stores it on the task (field `evidence`).
  qa: {
    // The evidence types a track may write. screenshot = the owner looks at a screen or route, test = a test file,
    // manual = something the owner checks by hand.
    evidenceTypes: ['screenshot', 'test', 'manual'],
    // Types closed automatically by `queue.mjs qa auto --run` when autoCommand is green (exit 0). They need a ref.
    autoTypes: ['test'],
    // Types whose ref is free text (what to check by hand); they are gathered in one manual round in `queue.mjs qa`.
    manualTypes: ['manual'],
    // The shell command `qa auto --run` runs from the project root, e.g. "npx vitest run {refs}". {refs} is replaced by the
    // refs separated by spaces (appended when the placeholder is missing), {id} by the task id. Either one command for every
    // auto type, or { "<type>": "<command>" }. null = qa auto only lists.
    autoCommand: null,
    // Labels that require evidence: receive warns when such a task delivers without an EVIDENCE line. [] = never warn.
    evidenceLabels: ['visual'],
  },
  // Branches never counted as queue branches (in addition to baseBranch).
  excludeBranches: ['main', 'master'],
  // Paths a cloud session cannot see (e.g. gitignored folders); a mission that points there is stopped.
  cloudHidden: [],
  // Weekly quota (queue.mjs capacity): when it resets, and the subscription name in the text (null = "weeklyQuota").
  capacity: {
    resetDay: null, // 0-6 (0 = Sunday)
    resetClock: null, // "HH:MM"
    timeZone: null, // IANA, e.g. "Europe/Berlin"
    planName: null,
  },
  // Queue board (queue-board.mjs).
  // Context guard (hook-context.mjs, lib/contextGuard.js). blockOtherChats: stop the message at 400k (CONTEXT_STOP) in
  // chats that are NOT the orchestrator. Default false: those chats only get the notice from 250k. The orchestrator's
  // own limits (compact, wind-down, hard stop) are not affected.
  contextGuard: { blockOtherChats: false },
  board: {
    port: 2000,
    title: 'Queue board',
    // The mascot's speech bubble: "chatty" (everything), "events" (only events and clicks) or "off" (no bubbles at
    // all, for every viewer; the choice in the gear is then locked). `queue-board.mjs --mascot <mode>` overrides it.
    mascot: 'chatty',
    // The update banner: the board checks GitHub for a newer plugin version at start (at most once per 24 hours, a
    // plain GET that sends nothing about you). false turns it off; so do DISABLE_UPDATES and
    // CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC. The local "run cq setup --settings" notice works either way.
    updateCheck: true,
    // The Cloud tab (with features.cloud on): hidden unless this is true. queue.json board.showCloud wins (written
    // by `cq board-setting cloud on|off` and the gear's Board section). A saved Cloud view still opens with the tab hidden.
    showCloud: false,
  },
  // The modules that can be switched off (FEATURES above): { "cloud": true } turns one on. Unknown keys are ignored.
  features: FEATURES,
});

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Recursive merge: objects field by field, everything else (lists, numbers, text, null) is replaced. */
function merge(standard, own) {
  if (!isObject(own)) return own === undefined ? standard : own;
  const out = { ...standard };
  for (const [k, v] of Object.entries(own)) {
    if (k.startsWith('$') || k.startsWith('_')) continue; // $schema, _comment
    out[k] = isObject(standard?.[k]) && isObject(v) ? merge(standard[k], v) : v;
  }
  return out;
}

/** The project root (always the main tree, also from a worktree). How it is found: lib/projectRoot.js. */
function findRoot() {
  return roots().main;
}

let buffer = null;

/** The path to queue.config.json (QUEUE_CONFIG overrides, as in config()). */
function configFile(root = findRoot()) {
  return process.env.QUEUE_CONFIG ?? path.join(root, 'queue.config.json');
}

/**
 * Reads queue.config.json (once per process) and merges it with STANDARD.
 * @param {{ root?: string, fresh?: boolean }} [o]
 */
function config(o = {}) {
  if (buffer && !o.fresh && !o.root) return buffer;
  const root = o.root ?? findRoot();
  const file = configFile(root);
  let own = {};
  try {
    own = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e?.code !== 'ENOENT') {
      process.stderr.write(`WARNING: could not read ${file} (${e?.message}); using the default values.\n`);
    }
  }
  const k = merge(STANDARD, own);
  k.root = root;
  if (!o.root) buffer = k;
  return k;
}

/** Absolute path to the data folder (QUEUE_FOLDER overrides). */
function dataFolder() {
  return process.env.QUEUE_FOLDER ?? path.join(config().root, config().dataFolder);
}

/** Absolute path to the time log (QUEUE_TIME_LOG overrides). */
function timeLog() {
  return process.env.QUEUE_TIME_LOG ?? path.join(config().root, config().timeLog);
}

/**
 * The resolved module switches: FEATURES merged with `features` from the configuration. Only known keys and real
 * booleans count (an unknown key or a value like "yes" is ignored without an error), and a part ("plans.legal") is
 * off when its parent ("plans") is off.
 * @param {object} [cfg] the configuration (default: config())
 * @returns {Record<string, boolean>}
 */
function features(cfg = config()) {
  const own = isObject(cfg?.features) ? cfg.features : {};
  const out = {};
  for (const [k, v] of Object.entries(FEATURES)) out[k] = typeof own[k] === 'boolean' ? own[k] : v;
  for (const k of Object.keys(out)) {
    const parent = k.includes('.') ? k.slice(0, k.indexOf('.')) : null;
    if (parent && out[parent] === false) out[k] = false;
  }
  return out;
}

/**
 * The board's own switches: STANDARD.board merged with config board and then queue.json `board` (the owner's choice
 * from `cq board-setting` or the gear, which wins). Only the known boolean switches (BOARD_SWITCHES) and real booleans count.
 * @param {object} [cfg] the configuration (default: config())
 * @param {object} [queue] queue.json (its `board` object), or null
 * @returns {{ showCloud: boolean }}
 */
const BOARD_SWITCHES = Object.freeze({ showCloud: 'the Cloud tab on the board (with features.cloud on)' });
function boardSwitches(cfg = config(), queue = null) {
  const out = {};
  for (const k of Object.keys(BOARD_SWITCHES)) {
    const own = queue?.board?.[k];
    const set = cfg?.board?.[k];
    out[k] = typeof own === 'boolean' ? own : typeof set === 'boolean' ? set : STANDARD.board[k] === true;
  }
  return out;
}

/** Is the module on? An unknown name is off. */
function featureOn(name, cfg) {
  return features(cfg)[name] === true;
}

/** The answer a switched-off module's command gives: "Cloud is off (features.cloud in queue.config.json)." */
function featureOffText(name) {
  const label = name.charAt(0).toUpperCase() + name.slice(1);
  return `${label} is off (features.${name} in queue.config.json).`;
}

module.exports = {
  STANDARD,
  FEATURES,
  merge,
  findRoot,
  configFile,
  config,
  dataFolder,
  timeLog,
  features,
  featureOn,
  featureOffText,
  BOARD_SWITCHES,
  boardSwitches,
};
