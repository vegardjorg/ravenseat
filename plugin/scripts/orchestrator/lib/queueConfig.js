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
  // without the key is full, so existing installs keep working as before; a fresh `ravenseat init` writes "lite" (opt out
  // with `ravenseat init --full`). Switch with `ravenseat mode lite|full`.
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
    // A known bug that can happen again (lib/knownBugGate.js): 'propose' = a task the owner approves, 'auto' = approved at
    // once (it uses tokens without asking), 'off' = nothing.
    fromKnownBugs: 'propose',
  },
  // The done command (task field `done_when`, lib/doneCheck.js): `receive` and `merge` run it in the track's worktree.
  // timeoutSec = the time budget per run (a run over it is red); tailLines = how many of the last output lines are kept
  // for the fix brief (only the tail, so a secret printed early in a long run is not copied around).
  doneCheck: { timeoutSec: 600, tailLines: 40 },
  // The base gate (lib/baseHealth.js): after `ravenseat merge` the base branch's new tip is checked in the main checkout and the
  // verdict recorded per tip; a red base stops further merges until a fix task makes it green. enabled: "auto" (on when
  // there are commands), true or false. commands: null = the quick gates (then the merge step's own gates run is the
  // check, nothing runs twice), or a list (e.g. the full gate) run after the quick gates. timeoutSec = the budget for
  // the whole list; tailLines = the output lines kept for the fix task (null = doneCheck.tailLines). flakyRerun: a red
  // check reruns only the failed commands once on the same sha first; green then is "flaky" (a finding, no freeze).
  baseGate: { enabled: 'auto', commands: null, timeoutSec: 900, tailLines: null, flakyRerun: true },
  // The batch push threshold (lib/pushBatch.js; `ravenseat push-check`, the push guard, the board). Every push of baseBranch
  // runs the whole CI, so pushes come in batches of MERGED TASKS (merges through ravenseat merge not yet on <remote>).
  // mode: "owner" = the orchestrator never pushes on its own, only on the owner's word; "threshold" = it may push by
  // itself when push-check says READY or LARGE (never BLOCKED). minTasks: the batch is ready at this many merged tasks
  // (0 = no lower limit); a plain push below it gets a confirmation dialog in both modes. warnTasks: from this many,
  // push-check says LARGE (a warning, never a block: a big batch makes a red CI harder to bisect; 0 = off).
  // maxAgeHours: when set, the oldest unpushed work older than this makes the batch ready below minTasks.
  // ciWatch: "off" (default) or "github": the optional CI watch after a batch push
  // (`ravenseat push-check --watch-ci <sha>`, lib/ciWatch.js, needs gh): polls the runs every ciWatchIntervalSec, gives up
  // after ciWatchTimeoutMin (exit 10). Local gates stay the rule; this is a safety net.
  // allowBranches: branches the main session may push besides baseBranch, for pull request flows ("feat/*"; * is any text).
  // Queue agents never push, and a delete stays denied. A forced push of such a branch asks first; of the base, never. The
  // secret scan runs on these too.
  // controlsWarning: a plain push asks when the project has no CI config or no gates (lib/controls.js); false = no question.
  push: { mode: 'owner', minTasks: 10, warnTasks: 50, maxAgeHours: null, ciWatch: 'off', ciWatchIntervalSec: 60, ciWatchTimeoutMin: 90, controlsWarning: true, allowBranches: [] },
  // The branch that goes live (production). null = unknown. `ravenseat doctor` warns when it is the same as baseBranch: every
  // batch push would then go straight to production. Nothing else reads it yet.
  productionBranch: null,
  // Commands that deploy (e.g. "vercel --prod", "fly deploy"). The push guard ASKS before any command that starts with
  // one of them, from an agent or the main session (a simple prefix match after env prefixes; never complete, so keep
  // production credentials out of the shell too). Empty = off.
  deployCommands: [],
  // The secret precheck before a plain push of baseBranch from the main session (lib/secretScan.js): the added lines of
  // what the push sends are scanned (gitleaks when it is on PATH, else built-in patterns) and a hit gets a confirmation
  // dialog naming file:line, never the value. maxBytes: a larger diff is not scanned, and the push asks. timeoutMs: per git or
  // gitleaks call. Fails open.
  secretScan: { enabled: true, maxBytes: 2_000_000, timeoutMs: 3000 },
  // `ravenseat doctor` warns about tracked files larger than this (MB).
  largeFileMb: 5,
  // Attempts (lib/logic/attempt.js): how long, in minutes, a reservation with no start row counts as live. After that it
  // reads as expired and the next start takes a new attempt. A reservation never blocks a start either way.
  attempts: { reservationTtlMin: 30 },
  // The check of git hooks and executing git config against the accepted baseline (lib/gitSurfaceBaseline.js): "stop" = a
  // difference stops receive, merge and the push check until the owner decides; "warn" = the same text as a warning, nothing
  // stops; "off" = no comparison. For a repository where hook tools or git settings change often enough to be friction.
  // Not set: "warn" in lite mode, "stop" in full (config() below). A value in the file always wins.
  gitSurface: 'stop',
  // A task that changes a dependency file it does not own (package.json, package-lock.json, pyproject.toml, Cargo.toml,
  // requirements*.txt, go.mod, Gemfile, pom.xml, build.gradle(.kts), composer.json):
  // "stop" = the merge guard stops it like any protected path; "warn" = a warning, and the merge goes on. Not set: "warn"
  // in lite mode, "stop" in full. The floor (CORE_PROTECTED in lib/mergeGuard.js) never softens.
  dependencyFiles: 'stop',
  // Git identity: the addresses the identity guard accepts although they look like a test identity (user@example.com).
  // Exact, not case sensitive. A missing identity is always refused.
  identity: { allow: [] },
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
  // mission). `ravenseat helpers on|off <agent>` (and the board's "Helper agents" tab) switch them in queue.json, which wins.
  // Path patterns: "dir/" = the folder from the root, "*.md" = that file name anywhere, "**" = any folders.
  helpers: {
    'reviewer-challenger': { enabled: true, classes: ['U'], labels: ['bug'] },
    'reviewer-design': { enabled: true, labels: ['visual'], paths: [] },
    'reviewer-tests': { enabled: false, classes: ['D', 'D+'], labels: ['bug'] },
    'reviewer-gap': { enabled: false, plan: true, minMissionItems: 8 },
    'reviewer-docs': { enabled: false, mostlyPaths: ['docs/', '*.md'] },
    // The short review for a project with no gates or no CI (lib/controls.js). Off: `ravenseat helpers off reviewer-light`.
    'reviewer-light': { enabled: true, whenControlsMissing: ['K'] },
    // The intake triage (lib/queueTriage.js): runs before the start, not after receive; its rule is `triage` below.
    triage: { enabled: true },
  },
  // Intake triage (lib/queueTriage.js, the `triage` helper): before `fill` starts a task that was added or last edited
  // minAgeDays ago or more (null = no age rule), or that an agent added (agentAdded, once), a short read-only agent
  // checks it against the current code: ready, done, stale or adjust. Never fix tasks or continuations. At most
  // maxPerFill triage steps per fill; a printed step is not printed again for askAgainMin minutes. Off: `ravenseat helpers
  // off triage` (or helpers.triage.enabled false). Lite mode: off unless switched on in the queue.
  triage: { minAgeDays: 3, agentAdded: true, maxPerFill: 3, askAgainMin: 60 },
  // When a focus has ended (every stage done, or its period `to` is over; lib/logic/ranking.js "When the focus has
  // ended"): continueWhenEmpty false (the default) pauses the queue (fill starts nothing) and asks the owner one
  // question in "Waiting on you": set a new focus or continue the regular queue. true = the queue continues by itself
  // (rest fill keeps filling, an expired focus is ranked as without focus), with one line saying so. A focus can
  // override it: ravenseat focus set ... --continue-when-empty on|off. A project that never set a focus is not affected.
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
  // name in any folder, with a slash on the path from the root, "**/" = any folders). An empty list leaves only the floor (CORE_PROTECTED in lib/mergeGuard.js), which holds whatever this says.
  // A list in queue.config.json REPLACES this one (lists are not merged): copy the entries you want to keep.
  // The match ignores case (lib/mergeGuard.js): .CLAUDE/ and .claude/ are the same folder on Windows and macOS.
  protectedPaths: [
    '.claude/', // project settings, hooks, agents, skills, rules
    '**/.claude/', // the same in a subfolder (Claude Code reads nested settings, skills and rules there too)
    '.claude-plugin/',
    '.githooks/',
    '.husky/', // git hooks through core.hooksPath: they run on every commit in the main checkout
    'lefthook.yml', // lefthook git hooks (any folder)
    '.lefthook.yml',
    'lefthook-local.yml',
    '.github/',
    '.vscode/', // tasks.json with runOn folderOpen runs when the folder is opened
    '.mcp.json',
    'CLAUDE.md', // instructions to the orchestrator session (any folder: Claude Code loads nested ones too)
    'CLAUDE.local.md',
    '.npmrc', // npm config (any folder): script-shell, registries and tokens
    '.yarnrc', // yarn 1 config (yarn-path runs a file)
    '.yarnrc.yml', // yarn 2+ config: yarnPath runs arbitrary JavaScript
    '.pnpmfile.cjs', // pnpm hooks: code run on every install
    '.gitattributes', // filter and diff drivers, merge strategies
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
    // The same for other languages: a new library is the owner's call (dependencyFiles above softens these in lite).
    'requirements*.txt',
    'go.mod',
    'Gemfile',
    'pom.xml',
    'build.gradle',
    'build.gradle.kts',
    'composer.json',
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
  // The queue for heavy gate runs (lib/gateQueue.js): a gates.mjs --quick/--full whose last run of the same kind took at
  // least heavyAfterSec waits for one of `slots` slots shared by the whole machine (a folder under the temp folder), across
  // worktrees and projects. No history counts as light, so a small project never notices it. QUEUE_GATE_QUEUE=off|on
  // overrides `enabled`. The time budget starts after the wait.
  gateQueue: { enabled: true, slots: 1, heavyAfterSec: 120 },
  // A temp folder of its own for each gate run, removed afterwards (lib/gateTemp.js): what a project's tests leave goes with
  // it. enabled false gives the gate commands the normal temp folder.
  gateTemp: { enabled: true },
  // The pause at the subscription's usage limit (lib/usageLimit.js): the StopFailure hook saves the reset time, and no new
  // tracks or fix rounds start until then (exit 12). pause false turns it off.
  usageLimit: { pause: true },
  // Auto-accept of agent proposals (lib/queueProposals.js): a proposal that fits the rules is approved by the queue
  // itself (in `queue.mjs add` and `orchestrator pulse`), logged and can be undone. Default off. `queue.mjs proposals
  // auto` and the board's gear write the queue's own rules (queue.json proposals.autoAccept), which win field by field.
  // Never D or D+, never with waiting_on, legal/owner labels, open legal points or protected paths, whatever is set here.
  proposals: {
    autoAccept: { enabled: false, classes: ['K'], maxEstimateMin: 60, maxValue: null },
  },
  // QA evidence: how the owner (or the queue itself) sees that a delivery works. A track writes one line
  // `EVIDENCE <type>[=<ref>[,<ref>...]]` in track-result.md, and `queue.mjs receive` stores it on the task (field `evidence`).
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
  // Cloud tracks (features.cloud turns them on, `ravenseat cloud setup` lists what they need). maxSessions: at most this many at once;
  // they share the plan's usage limits. start: "terminal" (the owner runs `ravenseat cloud-start`) or "routine" (`ravenseat cloud send`
  // fires the scheduled task at fireUrl, lib/cloudFire.js; the token is only ever in the environment, RAVENSEAT_CLOUD_TOKEN).
  cloud: { maxSessions: 3, start: 'terminal', fireUrl: null },
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
    // CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC. The local "run ravenseat setup --settings" notice works either way.
    updateCheck: true,
    // The Cloud tab (with features.cloud on): hidden unless this is true. queue.json board.showCloud wins (written
    // by `ravenseat board-setting cloud on|off` and the gear's Board section). A saved Cloud view still opens with the tab hidden.
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
 * Parses the text of queue.config.json. A leading byte order mark is dropped (Windows editors and PowerShell 5.1
 * write one, and JSON.parse refuses it). Throws the JSON.parse error otherwise.
 * @param {string} text
 */
function parseConfigText(text) {
  return JSON.parse(String(text).replace(/^﻿/, ''));
}

/**
 * The line and column (1-based) of a JSON.parse error: from the message when the runtime names them ("(line 3 column
 * 1)", newer V8), otherwise counted from "at position N" in the text. null when neither is there.
 * @param {string} message
 * @param {string} [text] the text that was parsed
 * @returns {{ line: number, column: number } | null}
 */
function parseErrorPosition(message, text) {
  const m = /line (\d+) column (\d+)/i.exec(String(message || ''));
  if (m) return { line: Number(m[1]), column: Number(m[2]) };
  const p = /at position (\d+)/i.exec(String(message || ''));
  if (!p || typeof text !== 'string') return null;
  const before = text.replace(/^﻿/, '').slice(0, Number(p[1]));
  const lines = before.split('\n');
  return { line: lines.length, column: lines[lines.length - 1].length + 1 };
}

/**
 * Reads and parses queue.config.json. A missing file is no error (the defaults apply, as before); a file that exists
 * but cannot be read or parsed IS one (H3 in plans/review-2026-11-02.md): running on the defaults would silently drop
 * the project's base branch, gates, migration guard and deploy commands.
 * @param {string} file
 * @returns {{ own: object, error: null | { file: string, message: string, line: number|null, column: number|null } }}
 */
function readConfigFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e?.code === 'ENOENT') return { own: {}, error: null };
    return { own: {}, error: { file, message: String(e?.message ?? e), line: null, column: null } };
  }
  try {
    const own = parseConfigText(text);
    if (!isObject(own)) return { own: {}, error: { file, message: 'the file must hold one JSON object ({ ... })', line: null, column: null } };
    return { own, error: null };
  } catch (e) {
    const at = parseErrorPosition(e?.message, text);
    return { own: {}, error: { file, message: String(e?.message ?? e), line: at?.line ?? null, column: at?.column ?? null } };
  }
}

/**
 * Reads queue.config.json (once per process) and merges it with STANDARD. When the file exists but does not parse,
 * the result still holds the defaults (so `ravenseat doctor` and the hooks can run), plus `configError` ({ file, message,
 * line, column }). The CLI stops on it (stopIfConfigUnreadable); the push guard asks or denies the push, migration and
 * deploy shaped commands (lib/configGuard.js). Nothing else may act on such a config as if it were the project's.
 * @param {{ root?: string, fresh?: boolean }} [o]
 */
function config(o = {}) {
  if (buffer && !o.fresh && !o.root) return buffer;
  const root = o.root ?? findRoot();
  const file = configFile(root);
  const { own, error } = readConfigFile(file);
  const k = merge(STANDARD, own);
  // Lite is for a first try: what a surprised new user meets as a hard stop is a warning there, unless the file says otherwise.
  if (k.mode === 'lite') {
    if (own.gitSurface === undefined) k.gitSurface = 'warn';
    if (own.dependencyFiles === undefined) k.dependencyFiles = 'warn';
  }
  k.root = root;
  if (error) Object.defineProperty(k, 'configError', { value: error, enumerable: false });
  if (!o.root) buffer = k;
  return k;
}

/**
 * The CLI message for an unreadable config: the file, the position when known, the parse error and the hint.
 * @param {{ file: string, message: string, line: number|null, column: number|null }} error
 * @returns {string}
 */
function configErrorText(error) {
  const where = error.line ? `${error.file}:${error.line}${error.column ? `:${error.column}` : ''}` : error.file;
  return [
    `STOP: queue.config.json exists but cannot be read: ${where}`,
    `  ${error.message}`,
    '  The queue does not run on the default values instead: they would drop your base branch, gates, migration',
    '  guard and deploy commands. Fix the file (a trailing comma or a missing quote is the usual cause), then run',
    '  `ravenseat doctor` to check it. Until then the push guard asks before every push, migration and deploy command.',
  ].join('\n');
}

/**
 * Stops the process (exit 1, the message on stderr) when queue.config.json exists but does not parse. Called by the
 * CLI entry points (ravenseat.mjs, cli/context.mjs, gates.mjs, push-check.mjs); `ravenseat doctor` and `ravenseat help` are exempt there.
 * @param {object} [k] the configuration (default: config())
 */
function stopIfConfigUnreadable(k = config()) {
  if (!k?.configError) return;
  process.stderr.write(`${configErrorText(k.configError)}\n`);
  process.exit(1);
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
 * from `ravenseat board-setting` or the gear, which wins). Only the known boolean switches (BOARD_SWITCHES) and real booleans count.
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
  parseConfigText,
  parseErrorPosition,
  readConfigFile,
  configErrorText,
  stopIfConfigUnreadable,
  dataFolder,
  timeLog,
  features,
  featureOn,
  featureOffText,
  BOARD_SWITCHES,
  boardSwitches,
};
