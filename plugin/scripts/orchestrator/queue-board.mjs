#!/usr/bin/env node
// =============================================================
// queue-board.mjs: local kanban board for the work queue (see docs/board.md).
//
// A small Node server (built-in modules only) that shows the queue as a board in the browser: In queue, In progress, Review and
// Built. The owner can drag cards to reprioritize, drag project lanes, pick, release, approve QA and pause projects.
//
//   node scripts/orchestrator/queue-board.mjs [--port <nr>]
//
// The port is config().board.port (default 2000) from queue.config.json; --port overrides it. The title is
// config().board.title and config().projectName. Prints a link with a random key (new for every run).
// Open it in the browser; Ctrl+C stops the board.
//
// How the board stays equal to the queue:
//   - READING: queue.json + the pure rules in lib/queueLogic.js (priority, project, blockers, limits) via
//     lib/queueBoard.js. No copy of its own of the rules.
//   - WRITING: only via the queue.mjs commands (edit, project, edit-many, pick, release, qa ok|deviation, batch pack), so
//     the lock, the atomic write and the validation are the same as elsewhere. The board never writes queue.json itself.
//     Writes run one at a time.
//   - COLORS: the neutral palette (light and dark) in lib/queueBoard.js is served as CSS variables (/theme.css).
//   - STATISTICS: queue.json and the time log (read only) are aggregated by the pure functions in lib/queueStatistics.js.
//     The time log is read again only when mtime or size has changed, and the result is cached until queue.json, the time log
//     or the date changes.
//   - SETTINGS: the limits are written with `queue.mjs limit <name> <val>` (same lock and validation); the setup
//     (migrations when they are turned on, orchestrator, model, hooks and skills) is read only.
//     "Auto-accept proposals" (lib/queueProposals.js) saves with POST /api/proposals (= `queue.mjs proposals auto ...`) and
//     undoes one with POST /api/proposals-undo { id } (= `queue.mjs proposals undo <id>`).
//     GET /api/settings also sends `mode` and `registry` (every registry row by category, lib/settingsView.js), and POST
//     /api/setting { key, value, confirm } writes one row with `queue.mjs settings set`. A value that weakens a guard (and
//     switching auto-accept on) is refused with 422 { weaken: true, protects, whyNot, changes } unless confirm is 'weaken',
//     which only the warning dialog's completed slide sends.
//   - FORECAST: the state and the statistics carry `forecast` (lib/queueForecast.js, Monte Carlo over the daily throughput,
//     a fixed seed), shown as a box in the Focus view and a line in Statistics.
//   - GUARD RULES: every write call runs queueBoard.assess first. stop → 422, warning → 409 until the call sends
//     `confirm: true`, info → the action is done and the texts are sent with the response. queue.mjs still refuses on its own.
//   - MASCOT: GET /mascot sends the phrases from the optional <dataFolder>/mascot-phrases.json (or the neutral default
//     set), and the state has `mascot` ({ mode, file }) and `mascotNumbers` (lib/queueMascot.js). The mode is
//     board.mascot in queue.config.json ("chatty", "events" or "off"); --mascot <mode> overrides it. "off" turns the
//     speech bubble off for every viewer.
//   - DEPENDENCIES: the graph with circles and strokes is computed in the browser by lib/queueGraph.js (served as /queueGraph.js) from
//     the same state, once per version and filter, so the search and the filter menu work the same.
//   - WAITING ON YOU: the state has `inbox` (owner question, QA, proposed, what is stuck) and `next` ("Next up").
//     Answers go via `queue.mjs resolve <id> --answer … --by owner`, QA ok and approve for several via `queue.mjs qa ok <id…>
//     --by owner` and `queue.mjs approve <id…> --by owner`. DECISIONS (board/decide.js) is the same inbox as one list by
//     impact (lib/queueDecisions.js, also `ravenseat decide`); its writes are the same calls, plus { type: 'flag-stuck', id }
//     (= `queue.mjs block <id> other --note …`) for stuck work. The inbox also has `decided` ("Decided today").
//   - BOARD SWITCHES: state.boardSwitches (lib/queueConfig.js boardSwitches). The Cloud tab shows only with features.cloud
//     AND board.showCloud (default false); POST /api/action { type: 'board-switch', name: 'showCloud', on } runs
//     `queue.mjs board-setting cloud on|off`. A saved Cloud view still opens with the tab hidden (with a note).
//     board.blockedColumn (default false; name 'blockedColumn', `board-setting blocked on|off`) gives state.columns.blocked:
//     queueBoard.board moves the tasks with an open blocker that needs action there, out of their own column.
//   - CLOUD: the cards in the queue and in cloud sessions get queueLogic.cloudSuitable (<remote>/<baseBranch> and local changes are read with git,
//     at most every minute). "Copy cloud package" fetches /api/cloudPackage (= `queue.mjs cloud-package <id>`), and "Started in cloud",
//     "Completed in cloud" and "Cancel cloud" go via `queue.mjs cloud start|done|cancel`.
//   - MULTI_SELECT: POST /api/bulk { action, ids, val, dry, expect, confirm } is translated by queueBoard.bulkPlan to
//     `queue.mjs edit-many`, `rank` or `batch pack`. dry = preview (--dry, or
//     queueBoard.packPreview on a copy), otherwise it is written with --expect-changed (exit 6 → 409 outdated).
//     POST /api/undo { show? , nr? } = `queue.mjs undo [--show] [--nr <n>] --json`.
//   - CANCEL, DECLINE, EDIT (the detail panel): POST /api/task-edit { type: cancel|decline|edit, id, reason?, form? } runs
//     `queue.mjs cancel <id> --remark …` or `queue.mjs edit <id> --json {value, content_min, class}` with --by theBoard
//     (rules in lib/queueTaskEdit.js: only waiting and proposed tasks). Both are logged, so the answer's `log` goes to /api/undo.
//   - CHECKS (board/checks.js): what the project has and prioritized suggestions. GET /api/checks = `queue.mjs checks --json`,
//     POST /api/checks { action, key } = `queue.mjs checks plan|dismiss|restore|turn-on|packs --apply|on|off` (lib/checksCatalog.js,
//     and { action: 'build-gate', item: '<class>@<area>' } = `queue.mjs checks build-gate <item>`,
//     and { action: 'quick-add', item: '<G-n>' } = `queue.mjs checks quick-add <item>` (adds that guard's command to gates.quick),
//     checks-catalog/). state().checksMarker = the small red dot on the tab: a high suggestion is open and checksPanel.marker
//     is not off. It is read in the background, at most every two minutes.
//   - PLANS (see docs/plan-register.md): the Plans workspace (queue-board/plans/). GET /api/plans reads plans.json and
//     queue.json (read only) and sends what queuePlanView.plansData makes, with a version so unchanged data is not sent
//     again. The same response has the document register for the Documents and agreements view. The priority map saves a draft with
//     POST /api/plan-prioritize (dry = preview), which runs one `queue.mjs plan prioritize-many --file …
//     --set-by owner` with --expect-changed (one save is one changelog entry and one undo).
//     GET /api/doc?path=… reads one markdown document for the reading view (the allowlist is in queuePlanView.readPathError,
//     the path guard against .., hidden files, symlinks and other file types in queueBoard.readDocument). GET /api/plan-search?q=…
//     gives the plans whose plan document contains the search, with the matching sentence (queueBoard.planDocSearcher, P5;
//     off with plans.searchDocuments false). GET /api/plan-check gives the
//     unregistered documents (queue.mjs plan check), and POST /api/plan-new and /api/plan-source run `queue.mjs plan new`
//     and `plan edit <id> --set {sources}` with --set-by owner, --dry and --expect-changed.
//     The Legal, Decisions and Launch views read the same data. An answer to an owner question goes via
//     POST /api/action { type: 'resolve' } (= `queue.mjs resolve`; { choice: <n> } from a choice button = resolve --choice;
//     { keep: true } from "Keep as design choice" = resolve --keep, refused when catalog.captureAnswers is off),
//     and POST /api/lawyerPackage writes a draft locally (dry = preview; never sent).
//     POST /api/plan-bulk runs `queue.mjs plan prioritize|edit|combine` (dry = preview, otherwise
//     --expect-changed, all or nothing), POST /api/plan-capture { title, text? } adds a plan to the Inbox at once
//     (`plan capture`, P6, no preview, Undo in the toast), POST /api/plan-proposal { action, id, edits?, reason?, to?,
//     expect } is the owner's Accept, Decline or Merge of an Inbox item (`plan accept|decline|merge --set-by owner`,
//     P7, with --expect-changed, Undo in the toast), POST /api/plan-undo undoes what the board just saved (`plan undo --nr`),
//     and GET /api/plans?wait=1 waits until plans.json or queue.json changes (live update, fs.watch).
//   - SINCE YOU LEFT (roadmap 3e AW-2, AW-3): GET /api/since?window=last-seen|24h|7d&from=<ms> gives the band at the top
//     of Decisions (lib/awaySummary.js on the queue with its archive and the cached time log rows, plus "Decided" for
//     the same window); POST /api/seen sets the seen mark (lib/seenMark.js, <dataFolder>/seen.json, by board).
//   - FOLLOW UP: the read view /follow (its own page; the link is written in the terminal) with the follow-up entries from
//     follow.json via GET /api/follow (behind the key). The rules (due date, statuses) are lib/queueFollow.js, the same
//     as queue.mjs follow; the board never writes follow.json. Only with features.follow on (off by default).
//   - UPDATE BANNER (lib/queueUpdate.js): at start, and at most once per 24 hours (cache <dataFolder>/update-check.json),
//     the server fetches the published plugin.json from GitHub with a plain GET (no headers of its own, nothing about
//     the user or the project, 3 s timeout); any error is silent. Off with updates.check: false (or the old
//     board.updateCheck: false), DISABLE_UPDATES or CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC. The banner's X is
//     stored in the same file (POST /api/update-dismiss, `dismissed`), shared with `ravenseat update dismiss` and the CLI
//     line in show and doctor (cli/update.mjs). The state carries `update`, which also says when
//     the plugin version differs from the one `ravenseat setup --settings` recorded in <dataFolder>/setup.json (local only).
//
// Security (another web page in the same browser must not be able to read or edit the queue):
//   - listens only on 127.0.0.1,
//   - every /api/ call requires the key in the X-Queue-Key header (the link carries it in the # part, which is never sent to
//     the server or leaked in Referer),
//   - Host must be 127.0.0.1:<port> or localhost:<port> (stops DNS rebinding), and a write call with Origin must
//     come from the board itself and have Content-Type application/json,
//   - strict Content-Security-Policy: only our own files, no CDN, no inline script.
//
// Environment (as queue.mjs): QUEUE_FOLDER (the queue's folder, smoke test against a copy), QUEUE_GIT (the repo branches are counted in, and where
// the migrations folder and .claude/settings.json are read), QUEUE_TIME_LOG (the time log), QUEUE_PLAN_SOURCE_ROOT (the root documents
// are read from).
//
// Where the parts live (SPLIT-1). This file is the entry point: it reads the arguments and the config, keeps the live
// paths and caches (demo mode switches them), builds the state, statistics, plans and schedule data, serves the static
// files and /open, runs demo mode, and maps every /api/ route to its handler (write() for POST, the GET lines in the
// server). The handlers live in queue-board/api/, one module per route group:
//   writeTools.mjs  the write plumbing: the queue.mjs runner, the write chain, the input checks, edit-many, the guard
//                   rules and the weakening rule
//   views.mjs       GET /api/state, since, schedule, statistics, follow; POST /api/seen; the Follow up page
//   tasks.mjs       POST /api/bulk, undo, task-edit, move, lane; GET /api/task, archive
//   focus.mjs       POST /api/focus, area
//   plans.mjs       GET /api/plans, plan-search, doc, plan-check; POST /api/plan-prioritize, plan-new, plan-source
//   planEdits.mjs   POST /api/plan-capture, plan-proposal, plan-bulk, plan-undo, lawyerPackage
//   actions.mjs     POST /api/action; GET /api/cloudPackage, cloud-bundles
//   settings.mjs    POST /api/limit, setting, guidance, checks, helper, helper-add, proposals, proposals-undo,
//                   update-dismiss; GET /api/settings, checks
// Every handler gets `ctx` (built once, just above the server) and a write also the per-call tools write() builds.
// =============================================================

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { writeTools } from './queue-board/api/writeTools.mjs';
import { viewRoutes, FOLLOW_PAGE } from './queue-board/api/views.mjs';
import { taskRoutes } from './queue-board/api/tasks.mjs';
import { focusRoutes } from './queue-board/api/focus.mjs';
import { planRoutes, resetPlanCheck } from './queue-board/api/plans.mjs';
import { planEditRoutes } from './queue-board/api/planEdits.mjs';
import { actionRoutes } from './queue-board/api/actions.mjs';
import { settingRoutes } from './queue-board/api/settings.mjs';

const require = createRequire(import.meta.url);
const CS = require('./lib/cloudSetup.js');
const T = require('./lib/queueBoard.js');
const G = require('./lib/queueGit.js');
const L = require('./lib/queueLogic.js');
const S = require('./lib/queueStatistics.js');
// The reworked Statistics sections (top row, Cost and tokens, Machine, Quality), the finding log and the quota reading.
const SX = require('./lib/statisticsSections.js');
const FL = require('./lib/findingLog.js');
const RL = require('./lib/rateLimits.js');
const TK = require('./lib/timeCost.js');
// The flow rows (fixRound, mergeConflict, baseGate, triage, push, load) and their figures for the Statistics tab.
const ER = require('./lib/eventRows.js');
const GL = require('./lib/guardLog.js');
const ES = require('./lib/eventStatistics.js');
// The Plans space. The register is read with queuePlan.js, and what the board needs is made by queuePlanView.js (read only).
const P = require('./lib/queuePlan.js');
const PRIVACY = require('./lib/queuePlanView.js');
const KK = require('./lib/queueConfig.js');
// The mascot's rules (the same file the browser gets at /queueMascot.js) and the weekly quota (the forecast).
const M = require('./lib/queueMascot.js');
const KAP = require('./lib/queueCapacity.js');
// The update banner (a newer plugin version, or setup not run after an update). Served to the browser as /queueUpdate.js.
const U = require('./lib/queueUpdate.js');
// `ravenseat wait`'s heartbeat (lib/ownerWait.js): "Orchestrator listening" in "Waiting on you" while it is fresh.
const OW = require('./lib/ownerWait.js');
// The project catalog's settings (catalog.captureAnswers: "Keep as design choice" in Decisions, roadmap 0z Z-A).
const CATALOG = require('./lib/catalog.js');
// "Not building" in Decisions (roadmap 0f, lib/notBuilding.js boardEntries): the catalog's entries, read only.
const NOT_BUILDING = require('./lib/notBuilding.js');
// The sensitive zones a task meets (PG-5, lib/catalogZones.js): the badge on the card and the panel fact.
const ZONES = require('./lib/catalogZones.js');
// The switch for door and blast radius (mergeDanger.show): off hides a stored record from every card.
const DOOR = require('./lib/doorShow.js');

/**
 * The accepted zones per task for the board (PG-5), or null when zones.detect is off or no zone exists. The board reads
 * no mission files: the inline mission and the description stand in for the mission text.
 */
function zonesNow(fresh) {
  if (demoOn) return null; // the demo has no catalog, and the real one is never read for it
  const zf = ZONES.zonesOnDisk({ root: MAIN_TREE, dataFolder: FOLDER, cfg: fresh });
  if (zf.empty) return null;
  return (o) => {
    const inline = typeof o.mission === 'string' && !/\.md$/i.test(o.mission.trim()) ? o.mission : '';
    return zf(o, { missionText: [inline, o.description ?? ''].filter(Boolean).join('\n') });
  };
}
// The base gate's verdict (lib/baseHealth.js; ravenseat merge writes base-health.json, the board only reads it).
const BH = require('./lib/baseHealth.js');
// The batch push threshold (config().push): the unpushed merged tasks next to the base health in the status line.
const PB = require('./lib/pushBatch.js');

const CONFIG = KK.config();
// The modules that are on (features in queue.config.json, resolved once at start): sent with the state, so the board
// hides what is off. A change in the file needs a restart of the board, like the rest of the configuration.
const FEATURES = KK.features(CONFIG);
// The forecast box (Focus view, Statistics).
const FC = require('./lib/queueForecast.js');
// The decision overview (the flag note for stuck work; the board's Decisions view uses the same file in the browser).
const DEC = require('./lib/queueDecisions.js');
const HERE = path.dirname(fileURLToPath(import.meta.url));
// The project root (two folders above scripts/orchestrator/). The queue lives in the main tree, as for queue.mjs: if the board runs from a
// worktree, config().root already points to the main tree.
const ROOT = require('./lib/projectRoot.js').roots().tree;
const MAIN_TREE = CONFIG.root;
// DEMO MODE (lib/demoMode.js): the paths below are `let`, since demo mode points the board's reads and writes at
// <dataFolder>/demo/ (useDemo further down) and back. REAL keeps the real ones; nothing else reassigns them.
let FOLDER = KK.dataFolder();
let FILE = path.join(FOLDER, 'queue.json');
let CURSOR = path.join(FOLDER, 'orchestrator.json');
let PLAN_FILE = path.join(FOLDER, 'plans.json');
// The "Follow up" entries (queue.mjs follow writes; the board only reads).
let FOLLOW_FILE = path.join(FOLDER, 'follow.json');
// The base gate's state file (cli/baseHealth.mjs writes it after ravenseat merge).
let BASE_HEALTH_FILE = path.join(FOLDER, 'base-health.json');
// Documents in the reading view live in the main tree, like the source paths in the plan register (same env var as queue.mjs).
let SOURCE_ROOT = process.env.QUEUE_PLAN_SOURCE_ROOT ?? MAIN_TREE;
let GIT_ROOT = process.env.QUEUE_GIT ?? MAIN_TREE;
let TIME_LOG = KK.timeLog();
const REAL = Object.freeze({ FOLDER, FILE, CURSOR, PLAN_FILE, FOLLOW_FILE, BASE_HEALTH_FILE, SOURCE_ROOT, GIT_ROOT, TIME_LOG });
const DEMO = require('./lib/demoMode.js');
const DEMO_OFFER = require('./lib/demoOffer.js');
/** The demo folder's paths (always under the REAL data folder). */
const DEMO_PATHS = DEMO.paths(REAL.FOLDER);
/** Is demo mode on? In memory only: a restarted board always starts on the real queue. */
let demoOn = false;
// The time log's monthly archives (lib/timeLogArchive.js, owner decision B5): read across them, windowed where it can.
const TA = require('./lib/timeLogArchive.js');
// The archive of done tasks (lib/queueArchive.js, owner decision B5): statistics, plans and lookups by id read it too.
const QARCH = require('./lib/queueArchive.js');
// "Since you left" (roadmap 3e AW-1 to AW-3): the shared join and the server-side seen mark (GET /api/since, POST /api/seen).
const AWAY = require('./lib/awaySummary.js');
const SEEN = require('./lib/seenMark.js');
// The card's History in the detail panel (roadmap 0ø J5, lib/taskHistory.js): only data that already exists.
const HIST = require('./lib/taskHistory.js');
// The Timeline tab (roadmap TIDSLINJE T-A): the payload of GET /api/schedule (lib/queueTimeline.js over queueSchedule.js),
// the quota cap the way `ravenseat schedule` takes it, and the load-aware slots (memory only, no CPU sampling here).
const QT = require('./lib/queueTimeline.js');
const SCHED = require('./lib/queueSchedule.js');
// T-C: the uncertainty band per focus step and the backtest (board.timelineUncertainty).
const UNC = require('./lib/scheduleUncertainty.js');
const LOADS = require('./lib/loadSlots.js');

/**
 * The history of one task for /api/task: the queue with its archive, the cached time log rows (flow rows and the track
 * gate runs) and the review rows of the finding log. Null when it cannot be built (the panel then says so; the rest of
 * the answer is unchanged).
 */
function historyFor(o, queue) {
  try {
    const log = timeLogRows();
    let findings = [];
    try {
      findings = FL.read(null, { since: o.added_at ?? null, includeArchive: true }).rows;
    } catch {
      findings = []; // no finding log yet: the review rounds are left out
    }
    return HIST.taskHistory({ task: o, queue, rows: [...(log.events ?? []), ...(log.trackGates ?? [])], findings, now: Date.now() });
  } catch {
    return null;
  }
}
const archiveMtime = () => {
  try {
    return fs.statSync(QARCH.archiveFile(FOLDER)).mtimeMs;
  } catch {
    return 0;
  }
};
const QUEUE_MJS = path.join(HERE, 'queue.mjs');
const CLIENT = path.join(HERE, 'queue-board');
// Base branch (the integration branch) and the remote, for "commits ahead" and "changed since push".
const BASE = String(CONFIG.baseBranch ?? 'main');
const REMOTE = String(CONFIG.remote ?? 'origin');
// The title in the browser and at the top of the board.
const TITLE = T.boardTitle(CONFIG);

const a = process.argv.slice(2);
const val = (name) => {
  const i = a.indexOf(name);
  return i >= 0 ? a[i + 1] : undefined;
};
if (a.includes('--help') || a.includes('-h')) {
  console.log(
    `Kanban board for the work queue.\n\n  ${require('./lib/projectRoot.js').cliCommand()} board [--port <nr>] [--mascot chatty|events|off]\n\n` +
      `The default port is board.port in queue.config.json (now ${CONFIG.board?.port ?? 2000}).\n` +
      `The mascot's speech bubble is board.mascot in queue.config.json (now ${CONFIG.board?.mascot ?? 'chatty'}); ` +
      '--mascot off turns it off for every viewer.\n' +
      'The board opens itself in your browser with its key (new for every run); the key is never printed.\n' +
      `  ${require('./lib/projectRoot.js').cliCommand()} board open [--follow] [--port <nr>]   opens the running board again\n` +
      `  ${require('./lib/projectRoot.js').cliCommand()} board open --task <id> [--no-open]   opens it on that card (--no-open: prints the link without the key)\n` +
      'board.hideKey false in queue.config.json prints the link with the key instead (a weakened guard). Ctrl+C stops the board.',
  );
  process.exit(0);
}
const PORT = Number(val('--port') ?? CONFIG.board?.port ?? 2000);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error('--port must be an integer between 1 and 65535');
  process.exit(1);
}

// ---- The key stays out of Claude's view (0l bolk 5, owner decision 16.11) ---------------------------------------
// The key gives every owner action on the board (`--by owner`, confirmed weakenings). It used to be printed in the
// start line, and that output is what Claude reads when it starts the board in the background, so the model held the
// owner's key. Now the server opens the browser itself with the key in the # part, and prints the link without it.
// `ravenseat board open` asks the running board (POST /open, no key, refused with an Origin) to open it again. Scripts
// and tests pass --key-file <path>: the link goes to that file and no browser opens; the approval guard asks the owner
// before the main session does that (lib/approvalAsk.js, rule override-board-key). board.hideKey false prints the key
// as before (a weakened guard). Limits: a model with a browser tool on the same browser, or one that reads the process
// list while the browser starts, can still see it; this closes the plain way (stdout, then curl).
const HIDE_KEY = CONFIG.board?.hideKey !== false;
const KEY_FILE = val('--key-file') ?? null;
/** A task id in `board open --task` and POST /open: the same pattern as the page's deep link (board/route.js ROUTE_TASK). */
const OPEN_TASK = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
if (a[0] === 'open') await openRunningBoard();

/**
 * `ravenseat board open`: asks the board on PORT to open itself in the browser; exits. Never sees the key. Plain
 * node:http with no keep-alive (fetch leaves a pooled socket, and process.exit with one open can crash Node on Windows).
 */
async function openRunningBoard() {
  const cli = require('./lib/projectRoot.js').cliCommand();
  // --task <id> (J14 follow-up): the board opens on that card with the J2 deep link (#view=flat&task=<id>). The id is
  // checked here first with the same pattern the page uses (board/route.js ROUTE_TASK), so a typo never reaches the
  // board; the board then checks that the task is in the queue. --no-open: the board answers with the link without
  // the key and opens nothing (paste it into the board's tab, which keeps its key).
  const task = a.includes('--task') ? String(val('--task') ?? '') : null;
  if (task != null && !OPEN_TASK.test(task)) {
    console.error(`"${task.slice(0, 80)}" is not a task id. Use: ${cli} board open --task <id> [--no-open]`);
    process.exit(1);
  }
  if (task != null && a.includes('--follow')) {
    console.error(`Use --task or --follow, not both.`);
    process.exit(1);
  }
  const body = JSON.stringify({ follow: a.includes('--follow'), ...(task != null ? { task, open: !a.includes('--no-open') } : {}) });
  const answer = await new Promise((done) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        method: 'POST',
        path: '/open',
        agent: false,
        timeout: 10_000,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (d) => (text += d));
        res.on('end', () => {
          let b = {};
          try {
            b = JSON.parse(text) ?? {};
          } catch {
            /* not the board's answer */
          }
          done({ status: res.statusCode ?? 0, message: b?.message ?? null });
        });
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => done(null));
    req.end(body);
  });
  if (!answer) {
    console.error(`No board answers on port ${PORT}. Start it with ${cli} board, or pass --port <nr>.`);
    process.exit(1);
  }
  const ok = answer.status >= 200 && answer.status < 300;
  const line = String(answer.message ?? (ok ? 'Opened the board in your browser.' : `The board on port ${PORT} answered ${answer.status}.`));
  if (ok) console.log(line);
  else console.error(line);
  process.exit(ok ? 0 : 1);
}
// The mascot mode: --mascot overrides board.mascot. "off" = no speech bubble at all, for every viewer.
const MASCOT_INPUT = val('--mascot') ?? CONFIG.board?.mascot ?? M.DEFAULT_MODE;
const MASCOT_MODE = M.normalizeMode(MASCOT_INPUT);
if (!MASCOT_MODE) {
  console.error(`--mascot / board.mascot must be one of ${M.MODES.join(', ')} (got "${MASCOT_INPUT}")`);
  process.exit(1);
}
const HOST = '127.0.0.1';
const KEY = crypto.randomBytes(24).toString('base64url');
const VALID_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const VALID_ORIGIN = new Set([...VALID_HOSTS].map((v) => `http://${v}`));
/** The link with the key (only for the browser, the key file, or the start line when board.hideKey is false). */
const keyLink = (page = '/') => `http://${HOST}:${PORT}${page}#key=${KEY}`;
/** The link without the key: safe to print. */
const plainLink = (page = '/') => `http://${HOST}:${PORT}${page}`;
/** --key-file: the link with the key, readable by this user only (best effort on Windows). route = a J2 deep link part. */
function writeKeyFile(route = '') {
  fs.writeFileSync(KEY_FILE, `${keyLink()}${route ? `&${route}` : ''}\n`, { mode: 0o600 });
}
/**
 * Opens the link in the default browser, without a shell that could log it and with nothing printed. Resolves
 * { ok, error }: error is an error code, never a message (a spawn message can carry the arguments, and so the key).
 * An opener still running after 5 s counts as opened (xdg-open can stay with the browser).
 */
function openBrowser(url) {
  const [cmd, args, extra] =
    process.platform === 'win32'
      ? ['cmd.exe', ['/d', '/s', '/c', `start "" "${url}"`], { windowsVerbatimArguments: true }]
      : process.platform === 'darwin'
        ? ['open', [url], {}]
        : ['xdg-open', [url], {}];
  return new Promise((done) => {
    let child;
    try {
      child = spawn(cmd, args, { ...extra, stdio: 'ignore', detached: true, windowsHide: true });
    } catch (e) {
      done({ ok: false, error: String(e?.code ?? 'failed') });
      return;
    }
    const timer = setTimeout(() => {
      child.unref();
      done({ ok: true });
    }, 5000);
    timer.unref();
    child.once('error', (e) => {
      clearTimeout(timer);
      done({ ok: false, error: String(e?.code ?? 'failed') });
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      done(code === 0 ? { ok: true } : { ok: false, error: `exit ${code}` });
    });
  });
}
/** The line after a failed open: what to do, never the key. */
const openFailedLine = (error) =>
  `Could not open a browser (${error}). Run ${require('./lib/projectRoot.js').cliCommand()} board open when one is ` +
  'available, or set board.hideKey false in queue.config.json to print the link with its key (a weakened guard).';

// ---- The update banner (lib/queueUpdate.js) ------------------------------------------------------------------------
// The installed version: the plugin manifest (setupSources finds it), or ravenseat-version.json next to the scripts in a vendored
// install (install.mjs writes it). Read once: a plugin update installs into a new folder, so this board keeps its version.
const INSTALL = (() => {
  const src = T.setupSources(HERE, GIT_ROOT, (f) => fs.existsSync(f));
  let version = null;
  try {
    const file = src.manifest ?? path.join(HERE, 'ravenseat-version.json');
    version = JSON.parse(fs.readFileSync(file, 'utf8')).version ?? null;
  } catch {
    version = null;
  }
  return { mode: src.mode, version };
})();
const UPDATE_CACHE = path.join(FOLDER, 'update-check.json');
const SETUP_RECORD = path.join(FOLDER, 'setup.json');
// The published version. Fetched at start and then at most once per 24 hours (the cache on disk); null when unknown,
// turned off or on any error (no message: the banner simply does not show).
let latestPublished = null;
async function refreshLatest() {
  if (typeof globalThis.fetch !== 'function') return;
  const r = await U.latestVersion({
    config: CONFIG,
    env: process.env,
    cacheFile: UPDATE_CACHE,
    fs,
    fetch: globalThis.fetch,
  });
  if (r) latestPublished = r.latest;
}
/** What the banner says now (null = nothing). The setup record is read on every state build (a tiny file). */
const updateNotice = () =>
  // In demo mode the demo banner has the top; the update notice comes back on the real board.
  demoOn ? null : U.notice({
    mode: INSTALL.mode,
    installed: INSTALL.version,
    latest: latestPublished,
    setupVersion: U.readSetupRecord(fs, SETUP_RECORD),
    projectFolder: MAIN_TREE,
    // The version closed on the board or with `ravenseat update dismiss` (the same file as the cache).
    dismissed: U.dismissedVersion(fs, UPDATE_CACHE),
  });

// ---- The colors (the neutral palette in lib/queueBoard.js) ----------------------------------------------------------
const THEME_CSS = T.themeCss(T.PALETTE);

// ---- Git (uncommitted files in the main tree, the branches <branchPrefix><id>) ----------------------------------
const realGitRead = G.makeGit(REAL.GIT_ROOT);
// Demo mode has no git: every read answers "nothing" (null), so branches and diffs are empty in the demo.
const gitRead = (args) => (demoOn ? null : realGitRead(args));
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,80}$/;
const BRANCH_PREFIX = String(CONFIG.branchPrefix ?? 'queue/');
/** The branch a task is built on: `branch` in the queue, otherwise <branchPrefix><id>. */
const branchFor = (o) => o.branch ?? `${BRANCH_PREFIX}${o.id}`;

/** Commits ahead of baseBranch on the branch and the time of the last one (the same question queue.mjs asks). */
function branchInfo(branch) {
  if (!BRANCH_PATTERN.test(branch)) return { exists: false, commits: 0, lastCommit: null };
  if (gitRead(['rev-parse', '-q', '--verify', `refs/heads/${branch}`]) == null)
    return { exists: false, commits: 0, lastCommit: null };
  const commits = Number(String(gitRead(['rev-list', '--count', `${BASE}..${branch}`]) ?? '0').trim());
  const last = commits > 0 ? String(gitRead(['log', '-1', '--format=%cI', branch]) ?? '').trim() : '';
  return { exists: true, commits: commits || 0, lastCommit: last || null };
}

// git status in a large repo takes time: read it again at most every minute.
// At the same time <remote>/<baseBranch> is read, and the paths changed locally since it (for "Suitable for cloud").
let gitStatus = { time: 0, uncommitted: [], error: false, pushedHead: null, sincePush: [] };
function uncommitted() {
  if (demoOn) return gitStatus; // reset to empty when demo mode starts (useDemo), never read from git in the demo
  if (Date.now() - gitStatus.time > 60_000) {
    const u = G.readUncommitted(gitRead);
    const pushedHead =
      String(gitRead(['rev-parse', '-q', '--verify', `refs/remotes/${REMOTE}/${BASE}`]) ?? '').trim() ||
      null;
    const sincePush = pushedHead
      ? String(gitRead(['diff', '--name-only', `refs/remotes/${REMOTE}/${BASE}...${BASE}`]) ?? '')
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    gitStatus = {
      time: Date.now(),
      uncommitted: u ? u.map((x) => x.path) : [],
      error: u == null,
      pushedHead,
      sincePush,
    };
  }
  return gitStatus;
}

// ---- The logo ---------------------------------------------------------------------------------------------------
// The project can put its own logo in the queue folder (logo.webp, logo.png or logo.svg, same folder as queue.json, so
// QUEUE_FOLDER applies). If none exists there, the bundled image is shown (queue-board/logo.webp). Keeping it is a friendly
// request (see "About the logo" in the README), so the default setup always shows it.
const LOGO_TYPES = [
  ['logo.webp', 'image/webp'],
  ['logo.png', 'image/png'],
  ['logo.svg', 'image/svg+xml'],
];
const STANDARD_LOGO = { path: path.join(CLIENT, 'logo.webp'), type: 'image/webp' };
/** The first logo file in the queue folder, otherwise the bundled one (null only if that is missing too). */
function findLogo() {
  for (const [file, type] of LOGO_TYPES) {
    const filePath = path.join(FOLDER, file);
    try {
      if (fs.statSync(filePath).isFile()) return { path: filePath, type };
    } catch {
      /* does not exist */
    }
  }
  try {
    if (fs.statSync(STANDARD_LOGO.path).isFile()) return STANDARD_LOGO;
  } catch {
    /* missing in the installation */
  }
  return null;
}

// ---- The mascot's phrases (optional, in the gitignored queue folder next to the logo, never in the repo) -------------
const MASCOT_FILE = path.join(FOLDER, 'mascot-phrases.json');
const isFile = (p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};
let mascotLogged = null; // mtime of the file the last time it was invalid (one line in the log per version of the file)
/** The phrases for /mascot: the file validated with queueMascot.readPhrases; missing or invalid gives the default set. */
function mascotPhrases() {
  let text = null;
  let mtime = null;
  try {
    text = fs.readFileSync(MASCOT_FILE, 'utf8');
    mtime = fs.statSync(MASCOT_FILE).mtimeMs;
  } catch {
    return M.DEFAULT; // no file: the default set
  }
  const r = M.readPhrases(text);
  if (r.error && mascotLogged !== mtime) {
    mascotLogged = mtime;
    console.log(
      `${new Date().toLocaleTimeString('en-GB')} mascot-phrases.json: ${r.error}, using the default set`,
    );
  }
  return r.phrases;
}
// The usage from the time log (night cost and the weekly quota), computed again only when the time log has changed.
let usageCache = { key: null, list: [] };
function usage() {
  const log = timeLogRows();
  if (usageCache.key !== log.key) usageCache = { key: log.key, list: TK.usageEvents(log.rows) };
  return usageCache.list;
}
/** The summary the mascot fills its placeholders from (queueMascot.numbers). null on error (the mascot skips numbers). */
function mascotNumbers(queue) {
  try {
    const events = usage();
    let quotaPct = null;
    // Only with a calibrated weekly quota (queue.mjs capacity); otherwise {p} and "quota-90" are skipped.
    if (queue.capacity?.usd_per_100 != null || queue.capacity?.calibrations?.length) {
      try {
        quotaPct = KAP.forecast({ queue, events }).pct;
      } catch {
        quotaPct = null;
      }
    }
    return M.numbers(queue, { events, quotaPct });
  } catch {
    return null;
  }
}

// ---- SILENT tracks (the badge on the card): the same rule as queue.mjs show (queueLogic.silentTracks), measured with
// lib/trackActivity.js. The measurement (git, a capped mtime walk per running track) is cached for 60 s per task set, so a
// refresh of the board does not walk the worktrees again.
let silentCache = { time: 0, key: null, list: [] };
/** Tracks marked running with no agent (the Decisions card). Cached like the silent ones, since it asks git. */
const noAgentCache = { time: 0, list: [] };
function withoutAgentNow(queue) {
  if (Date.now() - noAgentCache.time < 60_000) return noAgentCache.list;
  let list = [];
  try {
    list = L.noAgentTracks(queue, {
      worktreeBranches: new Set(G.readWorktrees(gitRead).map((w) => w.branch).filter(Boolean)),
      reportOf: (o) => L.findTrackReport(o.id, o.scratchpad ? [o.scratchpad] : []).report,
      rows: () => {
        try {
          return TK.readRows(TA.readText(TIME_LOG, { from: TA.activeFrom(queue.tasks) }));
        } catch {
          return [];
        }
      },
      lastCommitMs: (o) => {
        const s = String(gitRead(['log', '-1', '--format=%ct', `refs/heads/${o.branch}`, '--']) ?? '').trim();
        return /^\d+$/.test(s) ? Number(s) * 1000 : null;
      },
    });
  } catch (e) {
    console.error(`the agent check failed: ${e?.message ?? e}`);
  }
  noAgentCache.time = Date.now();
  noAgentCache.list = list;
  return list;
}

// ---- Tracks that wait on a permission prompt (hook-approval-wait.mjs saves the agent; lib/approvalWait.js) ---------
/**
 * The running tasks whose agent waits on an approval. The agent is mapped to its task by the time log, and when the log
 * has only the agent id (its start row was written before the transcript existed), by the mission at the start of the
 * agent's transcript.
 */
/**
 * How an agent id is tied to its running task: the time log first, then the mission at the start of the agent's
 * transcript. Null when no task is running or in review. Shared by the approval waits and the tool trouble.
 */
function agentMapping(queue) {
  const running = (queue.tasks ?? []).filter((o) => o.status === 'running' || o.status === 'review').map((o) => o.id);
  if (!running.length) return null;
  const AW = require('./lib/approvalWait.js');
  const ACT = require('./lib/trackActivity.js');
  let rows = [];
  try {
    rows = TK.readRows(TA.readText(TIME_LOG, { from: TA.activeFrom(queue.tasks) }));
  } catch {
    rows = []; // no time log yet: the mission in the transcript can still tie the agent to its task
  }
  const agentTask = new Map();
  for (const [id, x] of ACT.agentsByTask(rows, running)) for (const a of x.agents) agentTask.set(a, id);
  const root = ACT.transcriptsRoot(MAIN_TREE);
  const taskOf = (agentId) => {
    const p = ACT.findTranscript(root, agentId);
    return p ? AW.missionTask(AW.readHead(p), running, TK) : null;
  };
  return { agentTask, taskOf, root, ACT };
}

/** The running tasks whose agent auto mode refused, or that fails the same tool again and again (lib/toolTrouble.js). */
function toolTroubleNow(queue) {
  try {
    const TT = require('./lib/toolTrouble.js');
    const state = TT.read(FOLDER);
    if (!Object.keys(state).length) return [];
    const m = agentMapping(queue);
    return m ? TT.troubleTasks(state, { agentTask: m.agentTask, taskOf: m.taskOf }) : [];
  } catch (e) {
    console.error(`the tool trouble check failed: ${e?.message ?? e}`);
    return [];
  }
}

function approvalNow(queue) {
  try {
    const AW = require('./lib/approvalWait.js');
    const waits = AW.read(FOLDER);
    if (!Object.keys(waits).length) return [];
    const m = agentMapping(queue);
    if (!m) return [];
    const { agentTask, taskOf, root, ACT } = m;
    return AW.waitingTasks(waits, {
      agentTask,
      taskOf,
      mtimeOf: (agentId) => {
        const p = ACT.findTranscript(root, agentId);
        try {
          return p ? fs.statSync(p).mtimeMs : null;
        } catch {
          return null;
        }
      },
    });
  } catch (e) {
    console.error(`the approval check failed: ${e?.message ?? e}`);
    return [];
  }
}

// ---- The review progress on a card in Review (0l bolk 4) ---------------------------------------------------------
// The merge gate (lib/reviewItems.js reviewGate) stops a merge while a reviewer receive chose has not reported, or
// reports H>0. The card shows the same verdict as "reviews k/n" before anyone runs merge. The reviewer transcripts are
// read only when the agents or the receive change (the key), and only the reviewer types: a track transcript is never
// opened here. review.requireFindings false: no badge, like no gate.
let reviewsCache = { key: null, list: [] };
/**
 * A transcript, or null when it is missing or over 50 MB (the CLI reads up to 300 MB, cli/tracks.mjs readTranscript;
 * the board must not stall on one, so a reviewer with a larger transcript shows as missing here, never as reported).
 */
function readSmallTranscript(filePath) {
  try {
    if (!filePath || fs.statSync(filePath).size > 50 * 1024 * 1024) return null;
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}
function reviewsNow(queue) {
  const RI = require('./lib/reviewItems.js');
  if (!RI.requireOn(CONFIG)) return [];
  const tasks = (queue.tasks ?? []).filter(
    (o) => o.status === 'review' && Array.isArray(o.review_reviewers) && o.review_reviewers.length,
  );
  if (!tasks.length) return [];
  try {
    const ACT = require('./lib/trackActivity.js');
    let rows = [];
    try {
      rows = TK.readRows(TA.readText(TIME_LOG, { from: TA.activeFrom(tasks) }));
    } catch {
      /* no time log: no reviewer has reported */
    }
    const per = tasks.map((o) => {
      const { secure, uncertainOnes } = L.agentsForTask(rows, o.id, { from: o.started ?? o.picked_at ?? o.added_at ?? null });
      const agents = [...secure, ...uncertainOnes.map((x) => ({ ...x, uncertain: true }))].filter(
        (x) => L.REVIEWER_TYPES.includes(x.type) || o.review_reviewers.includes(x.type),
      );
      return { o, agents };
    });
    const key = JSON.stringify(
      per.map(({ o, agents }) => [o.id, o.review_at ?? o.t_receive ?? null, o.review_reviewers, agents.map((x) => [x.agent, x.row?.time])]),
    );
    if (reviewsCache.key === key) return reviewsCache.list;
    const root = ACT.transcriptsRoot(MAIN_TREE);
    const list = [];
    for (const { o, agents } of per) {
      const read = [];
      for (const x of agents) {
        const text = readSmallTranscript(ACT.findTranscript(root, x.agent));
        if (!text || (x.uncertain && !L.missionNamesTask(text, o.id))) continue;
        read.push({ ...x, text });
      }
      const p = RI.progress({
        required: o.review_reviewers,
        since: o.review_at ?? o.t_receive ?? null,
        reports: RI.reportsOf(read, o.review_reviewers, L),
      });
      if (p) list.push({ id: o.id, ...p });
    }
    reviewsCache = { key, list };
    return list;
  } catch (e) {
    console.error(`the review progress failed: ${e?.message ?? e}`);
    return [];
  }
}

function silentNow(queue) {
  const limitMin = L.silentMinFor(queue);
  const running = (queue.tasks ?? []).filter((o) => L.silentWatched(o));
  const key = `${limitMin}|${running.map((o) => `${o.id}:${o.started ?? ''}:${o.attempts?.at(-1)?.reserved ?? ''}`).join(',')}`;
  if (silentCache.key === key && Date.now() - silentCache.time < 60_000) return silentCache.list;
  let list = [];
  try {
    if (limitMin > 0 && running.length) {
      const ACT = require('./lib/trackActivity.js');
      const worktrees = G.readWorktrees(gitRead).filter((w) => w.branch);
      const worktreeBranches = new Set(worktrees.map((w) => w.branch));
      const candidates = L.silentCandidates(queue, worktreeBranches);
      if (candidates.length) {
        const now = Date.now();
        let rows = [];
        try {
          rows = TK.readRows(TA.readText(TIME_LOG, { from: TA.activeFrom(candidates) }));
        } catch {
          /* no time log: the other sources still count */
        }
        const agents = ACT.agentsByTask(
          rows,
          candidates.map((o) => o.id),
        );
        const root = ACT.transcriptsRoot(MAIN_TREE);
        const lastActivity = {};
        for (const o of candidates)
          lastActivity[o.id] = ACT.lastActivity({
            branch: o.branch,
            worktree: worktrees.find((w) => w.branch === o.branch)?.path ?? null,
            trackDirs: o.scratchpad ? [path.join(o.scratchpad, o.id)] : [],
            agents: agents.get(o.id) ?? null,
            findTranscript: (agentId) => ACT.findTranscript(root, agentId),
            git: gitRead,
            freshMs: now - limitMin * 60_000,
          }).ms;
        list = L.silentTracks(queue, {
          worktreeBranches,
          lastActivity,
          hasReport: (o) => L.reportSinceStart(o, L.findTrackReport(o.id, o.scratchpad ? [o.scratchpad] : []).report),
          now,
          limitMin,
        });
      }
    }
  } catch (e) {
    console.error(`the silence check failed: ${e?.message ?? e}`);
  }
  silentCache = { time: Date.now(), key, list };
  return list;
}

// ---- SPINNING tracks (the Decisions card after an hour): the same rule as ravenseat show (lib/trackSpin.js), cached 60 s.
let spinCache = { time: 0, key: null, list: [] };
function spinningNow(queue, silent) {
  const SP = require('./lib/trackSpin.js');
  const limitMin = SP.spinMinFor(queue);
  const running = (queue.tasks ?? []).filter((o) => L.silentWatched(o));
  const key = `${limitMin}|${running.map((o) => `${o.id}:${o.started ?? ''}`).join(',')}|${(silent ?? []).map((x) => x.id).join(',')}`;
  if (spinCache.key === key && Date.now() - spinCache.time < 60_000) return spinCache.list;
  let list = [];
  try {
    const worktreeBranches = new Set(G.readWorktrees(gitRead).map((w) => w.branch).filter(Boolean));
    const candidates = limitMin > 0 ? L.silentCandidates(queue, worktreeBranches) : [];
    if (candidates.length) {
      const ACT = require('./lib/trackActivity.js');
      let rows = [];
      try {
        rows = TK.readRows(TA.readText(TIME_LOG, { from: TA.activeFrom(candidates) }));
      } catch {
        /* no time log: no agents to measure */
      }
      const agents = ACT.agentsByTask(rows, candidates.map((o) => o.id));
      const root = ACT.transcriptsRoot(MAIN_TREE);
      const skip = new Set((silent ?? []).map((x) => x.id));
      const measures = {};
      const lastCommit = {};
      for (const o of candidates) {
        if (skip.has(o.id) || L.reportSinceStart(o, L.findTrackReport(o.id, o.scratchpad ? [o.scratchpad] : []).report)) continue;
        const newest = [...(agents.get(o.id)?.agents ?? [])]
          .map((id) => ACT.findTranscript(root, id))
          .filter(Boolean)
          .map((p) => ({ p, ms: fs.statSync(p).mtimeMs }))
          .sort((p, q) => q.ms - p.ms)[0];
        const m = newest ? SP.measure(newest.p) : null;
        if (!m) continue;
        measures[o.id] = m;
        const s = String(gitRead(['log', '-1', '--format=%ct', `refs/heads/${o.branch}`, '--']) ?? '').trim();
        lastCommit[o.id] = /^\d+$/.test(s) ? Number(s) * 1000 : null;
      }
      list = SP.spinningTracks(queue, { candidates, measures, lastCommit, skip, limitMin });
    }
  } catch (e) {
    console.error(`the spinning check failed: ${e?.message ?? e}`);
  }
  spinCache = { time: Date.now(), key, list };
  return list;
}

// ---- The base health (the base gate's verdict for the current base tip) ------------------------------------------
const BASE_SETUP = BH.baseGateSetup(CONFIG);
let baseTipCache = { time: 0, tip: null };
/** { status, tip, fixTask, text } or null when the base gate is off. The tip is read at most once a minute. */
function baseHealthNow() {
  if (!BASE_SETUP.enabled) return null;
  try {
    if (Date.now() - baseTipCache.time > 60_000)
      baseTipCache = { time: Date.now(), tip: String(gitRead(['rev-parse', '-q', '--verify', `refs/heads/${BASE}`]) ?? '').trim() || null };
    return BH.boardHealth({ state: BH.readState(BASE_HEALTH_FILE), tip: baseTipCache.tip, setup: BASE_SETUP, branch: BASE });
  } catch {
    return null;
  }
}

// ---- The push batch (merged tasks not on <remote>/<baseBranch>, lib/pushBatch.js) ------------------------------------
const PUSH_SETUP = PB.pushSetup(CONFIG);
let pushBatchCache = { time: 0, batch: null, blocked: [], fullGate: 'off' };
/** What push-check would stop on besides the base: external commits and a remote ahead of us, and the full gate on the tip. */
function pushStops(from, to, batch) {
  if (!batch) return { blocked: [], fullGate: 'off' };
  const raw = G.readFirstParents(gitRead, { from, to }) ?? [];
  const plan = L.pushPlan(G.classify(gitRead, raw, { from }).reverse());
  const behind = Number(String(gitRead(['rev-list', '--count', `${to}..${from}`]) ?? '0').trim()) || 0;
  return {
    blocked: PB.blockedTexts({ external: plan.externalOnes.length, behind, from: `${REMOTE}/${BASE}`, to: BASE, mode: PUSH_SETUP.mode }),
    fullGate: require('./lib/gateEvidence.js').fullGateVerdict({ folder: FOLDER, sha: batch.tip, cfg: CONFIG }),
  };
}
/** { verdict, tasks, minTasks, text } or null (no remote ref yet, or git failed). git is read at most once a minute. */
function pushBatchNow(baseHealth) {
  try {
    if (Date.now() - pushBatchCache.time > 60_000) {
      const from = `refs/remotes/${REMOTE}/${BASE}`;
      const to = `refs/heads/${BASE}`;
      const batch = PB.readBatch(gitRead, { from, to, prefix: BRANCH_PREFIX, withCommits: false });
      pushBatchCache = { time: Date.now(), batch, ...pushStops(from, to, batch) };
    }
    // The health is the base gate's verdict for the tip (red blocks); unknown when the gate is off.
    return PB.boardBatch({
      batch: pushBatchCache.batch,
      setup: PUSH_SETUP,
      health: baseHealth?.status ?? 'unknown',
      fullGate: pushBatchCache.fullGate,
      blocked: pushBatchCache.blocked,
    });
  } catch {
    return null;
  }
}

// ---- The checks overview (`queue.mjs kickstart --json`, lib/kickstart.js) --------------------------------------------
// It reads git and the files, so it runs in the background at most once a minute, and the board shows the last answer.
let checksCache = { time: 0, data: null, running: false };
function checksNow() {
  if (demoOn) return null; // kickstart reads the repo: never in the demo
  if (!checksCache.running && Date.now() - checksCache.time > 60_000) {
    checksCache.running = true;
    queueMjs(['kickstart', '--json']).then((r) => {
      let data = null;
      try {
        const j = r.ok ? JSON.parse(r.out) : null;
        data = j && { steps: j.steps.map(({ key, state, title, why, how }) => ({ key, state, title, why, how })), next: j.next, knownBugs: j.knownBugs };
      } catch {
        /* no overview this round */
      }
      checksCache = { time: Date.now(), data, running: false };
    });
  }
  return checksCache.data;
}

/**
 * The "Not building" entries of the main tree's catalog (roadmap 0f) and a key for the state cache: the names and
 * times of the decisions folder and of the owner's record. Read only, and [] on any trouble (the view is display only).
 */
let notBuildingCache = { key: null, list: [] };
function notBuildingNow() {
  // The catalog is the real project's (MAIN_TREE): the demo shows none.
  if (demoOn) return { key: 'demo', list: [], groups: [] };
  try {
    const dir = path.join(MAIN_TREE, ...CATALOG.DIR.split('/'));
    const ledgerFile = path.join(FOLDER, CATALOG.LEDGER_FILE);
    const stamp = (f) => {
      try {
        return fs.statSync(f).mtimeMs;
      } catch {
        return 0; // error-ignored: a missing file is part of the key as 0
      }
    };
    let names = [];
    try {
      names = fs.readdirSync(path.join(dir, 'decisions')).sort();
    } catch {
      names = []; // error-ignored: no catalog, no entries
    }
    const key = JSON.stringify([names.map((n) => [n, stamp(path.join(dir, 'decisions', n))]), stamp(ledgerFile)]);
    if (key === notBuildingCache.key) return notBuildingCache;
    let ledger = CATALOG.emptyLedger();
    try {
      ledger = CATALOG.parseLedger(fs.readFileSync(ledgerFile, 'utf8'));
    } catch {
      ledger = CATALOG.emptyLedger(); // error-ignored: no record means every entry is unconfirmed
    }
    const cat = CATALOG.readCatalog(dir);
    // groups: the other entries by kind (roadmap 0å KD-0, lib/catalog.js boardGroups), for "Project catalog" in Decisions.
    notBuildingCache = { key, list: NOT_BUILDING.boardEntries(cat, ledger), groups: CATALOG.boardGroups(cat, ledger) };
    return notBuildingCache;
  } catch (e) {
    console.error(`the "not building" list failed: ${e?.message ?? e}`);
    return { key: 'error', list: [], groups: [] };
  }
}

/** The Checks tab's switch. Unreadable queue: on, so the tab is not lost to a passing read error. */
function checksPanelNow() {
  try {
    return require('./lib/guidance.js').checksPanelOn(JSON.parse(fs.readFileSync(FILE, 'utf8')));
  } catch {
    return true;
  }
}

// ---- The Checks tab (`queue.mjs checks --json`, lib/checksCatalog.js) ---------------------------------------------------
// Runs when the tab asks, at most once a minute unless the tab asks for a fresh one (Read again, after a write).
let checksReport = { time: 0, report: null };
async function checksReportNow(fresh) {
  if (!fresh && checksReport.report && Date.now() - checksReport.time < 60_000) return { ok: true, report: checksReport.report };
  const r = await queueMjs(['checks', '--json']);
  if (!r.ok) return { ok: false, message: r.error || r.out || 'ravenseat checks failed' };
  try {
    const answer = JSON.parse(r.out);
    // Switched off, the answer is {off:true}: no report, so the view has nothing to draw while the tab goes away.
    const report = answer.off ? null : answer;
    checksReport = { time: Date.now(), report };
    return { ok: true, report };
  } catch {
    return { ok: false, message: 'ravenseat checks gave an answer that could not be read' };
  }
}

/**
 * The red marker on the Checks tab: an open suggestion with high priority, unless checksPanel.marker is off. The report is
 * read in the background (at most every two minutes), so the state never waits for it; null until the first answer.
 */
let markerRunning = false;
function checksMarkerNow(panelOn) {
  if (!panelOn || demoOn) return false; // no background checks run in the demo
  if (!markerRunning && Date.now() - checksReport.time > 120_000) {
    markerRunning = true;
    checksReportNow(false)
      .catch(() => null)
      .finally(() => {
        markerRunning = false;
      });
  }
  const r = checksReport.report;
  return r ? r.marker !== false && (r.important ?? 0) > 0 : null;
}

// ---- The state (cheap: rebuilt only when queue.json, git status or the logo has changed) -----------------------------
// git status is read again every minute, so the state (age, night pause, "Next up") is recomputed at least that often.
let quick = null;
function state() {
  const fresh = KK.config({ fresh: true }); // the gear changes it through the CLI, so the file is what counts
  const mtime = fs.statSync(FILE).mtimeMs;
  const g = uncommitted();
  const logo = findLogo() != null;
  const mascotFile = MASCOT_MODE !== 'off' && isFile(MASCOT_FILE);
  // With a daily quota, "Next up" needs today's usage (the time log, via the cached statistics).
  const stat = quick?.budget ? statistics().version : null;
  const update = updateNotice();
  const updateKey = JSON.stringify(update);
  // The base health: the file's time and the base tip (read with git status, at most once a minute) are in the key.
  const baseHealth = baseHealthNow();
  const pushBatch = pushBatchNow(baseHealth);
  // The Checks tab's switch (lib/guidance.js checksPanelOn: its own setting, otherwise the guidance). Off: no overview, so
  // the status line and the first-run card have nothing to say.
  const checksPanel = checksPanelNow();
  const checks = checksPanel ? checksNow() : null;
  const checksMarker = checksMarkerNow(checksPanel);
  const baseKey = JSON.stringify([baseHealth, pushBatch, checks, checksPanel, checksMarker]);
  // Is a `ravenseat wait` listening (its heartbeat is fresh)? Read every time, so the line flips without a queue change.
  const listening = OW.heartbeatState(FOLDER).listening;
  // How the side panel sits on a wide screen (board.panelMode, QA-1c Q5): read fresh and part of the cache key, so a
  // change in the gear reaches the open board on its next poll without a restart.
  const panelMode = KK.boardPanelMode(fresh);
  // The display switches (roadmap 0ø J1, J3, J4: tab title count, shortcuts, quick filters), read fresh the same way.
  const display = KK.boardDisplay(fresh);
  // The Timeline tab's settings (T-A: board.timeline, .timelineHorizonDays, .timelineRows), read fresh the same way.
  const timeline = KK.boardTimeline(fresh);
  const displayKey = JSON.stringify([display, timeline]);
  // catalog.captureAnswers (roadmap 0z Z-A): read fresh and part of the cache key like panelMode, so `settings set`
  // shows or hides "Keep as design choice" on the next poll.
  const captureAnswers = CATALOG.setupOf(fresh).captureAnswers;
  // The "Not building" list (roadmap 0f): the decisions folder's names and times and the owner's record are the key,
  // so a new draft or an accept shows on the next poll.
  const notBuilding = notBuildingNow();
  // zones.detect (PG-5): read fresh and part of the key. The zones themselves live in the decisions folder, whose names,
  // times and the owner's record are already notBuilding.key.
  const zonesDetect = ZONES.zonesSetup(fresh).detect;
  // mergeDanger.show (lib/doorShow.js): read fresh and part of the key; off hides a stored door and blast radius.
  const doorOn = DOOR.on(fresh);
  if (
    quick &&
    quick.notBuildingKey === notBuilding.key &&
    quick.zonesDetect === zonesDetect &&
    quick.doorOn === doorOn &&
    quick.listening === listening &&
    quick.panelMode === panelMode &&
    quick.displayKey === displayKey &&
    quick.captureAnswers === captureAnswers &&
    quick.mtime === mtime &&
    quick.updateKey === updateKey &&
    quick.baseKey === baseKey &&
    quick.gitTime === g.time &&
    quick.logo === logo &&
    quick.mascotFile === mascotFile &&
    quick.stat === stat
  )
    return quick;
  const queue = DOOR.hideStored(JSON.parse(fs.readFileSync(FILE, 'utf8')), fresh);
  const branches = {};
  for (const o of queue.tasks ?? []) {
    if (o.status !== 'picked') continue;
    const branch = branchFor(o);
    branches[branch] = branchInfo(branch);
  }
  const budget = queue.limits?.dailyBudget != null;
  const s = budget ? statistics() : null;
  // The board shows the queue as if done focus stages were already taken out (queueLogic.focusWithoutDone; nothing
  // is written, that is done by queue.mjs focus clean and receive/set/fill). The whole board is computed on the same
  // focus, so the stage numbers on the cards match the focus line.
  let focusEval = null;
  let showQueue = queue;
  try {
    const fe = L.focusWithoutDone(queue);
    focusEval = new Map(fe.evaluation.map((t) => [t.stage, t]));
    if (fe.focus) showQueue = { ...queue, focus: fe.focus };
  } catch (e) {
    console.error(`the focus evaluation failed: ${e?.message ?? e}`);
  }
  const data = {
    ...T.board(showQueue, {
      captureAnswers,
      zonesFor: zonesNow(fresh),
      // The Blocked column (board.blockedColumn): the server moves the stuck tasks there, so no card is in two columns.
      blockedColumn: KK.boardSwitches(CONFIG, queue).blockedColumn,
      uncommitted: g.uncommitted,
      branches,
      branchPrefix: BRANCH_PREFIX,
      // Aging work against p85 for the class (only from queue.json).
      ageLimits: S.ageBounds(queue),
      // SILENT tracks (the badge on the card; cached 60 s).
      silent: silentNow(queue),
      // SPINNING tracks (a Decisions card after an hour; cached 60 s, as the silent ones).
      spinning: spinningNow(queue, silentNow(queue)),
      // "reviews k/n" on a card in Review: the merge gate's verdict (cached on the agents and the receive).
      reviews: reviewsNow(queue),
      withoutAgent: withoutAgentNow(queue),
      // Tracks that stand still on a permission prompt (not cached: one small file, and the card should go at once).
      approval: approvalNow(queue),
      // Tracks that auto mode refused, or that fail the same tool again and again (one small file, not cached either).
      toolTrouble: toolTroubleNow(queue),
      baseRed: baseHealth?.status === 'red',
      dailyUsage: s?.data.keyFigures.usageToday,
      // Suitability with the same rules as queue.mjs cloud-package (queueLogic.cloudSuitable).
      cloud: {
        pushedHead: g.pushedHead,
        changed: [...g.sincePush, ...g.uncommitted],
        mission: missionFor,
      },
    }),
    gitError: g.error,
    logo,
    // The mascot: the mode, whether the phrase file exists (the board fetches /mascot again when it appears), and the
    // numbers for the placeholders. With mode off nothing is computed.
    mascot: { mode: MASCOT_MODE, file: mascotFile },
    mascotNumbers: MASCOT_MODE === 'off' ? null : mascotNumbers(queue),
    title: TITLE,
    baseBranch: BASE,
    // The update banner (lib/queueUpdate.js): null, or a newer version and/or "run ravenseat setup --settings".
    update,
    // The base branch's health (lib/baseHealth.js boardHealth): null when the base gate is off; the status line shows it.
    baseHealth,
    // The push batch (lib/pushBatch.js boardBatch): "4 of 10 tasks, NOT YET"; null without a remote ref.
    pushBatch,
    // The checks overview: the steps of `ravenseat kickstart`; null until the first answer is in.
    checks,
    // Does the Checks tab show (`ravenseat checks on|off`)?
    checksPanel,
    // The red dot on the Checks tab (a high suggestion is open; `ravenseat checks marker off` hides it).
    checksMarker,
    // The module switches (lib/queueConfig.js features): the board hides the tabs, buttons and rows of those that are off.
    // The cloud switch is read fresh, so the gear can turn it on without a restart. The other modules are read at start.
    features: { ...FEATURES, cloud: KK.featureOn('cloud', fresh) },
    cloudSettings: CS.cloudSettingsView(fresh.cloud)
      .filter((s) => s.inGear !== false)
      .map(({ key, label, kind, choices, value, help }) => ({ key, label, kind, choices, value, help })),
    // The board's own switches (lib/queueConfig.js boardSwitches; queue.json board wins): showCloud = the Cloud tab.
    boardSwitches: KK.boardSwitches(CONFIG, queue),
    // The forecast box in the Focus view (lib/queueForecast.js, a fixed seed so the version stays stable).
    forecast: boardForecast(showQueue),
    // `ravenseat wait` runs and will start an orchestrator turn when the owner acts (lib/ownerWait.js heartbeatState).
    listening,
    // The side panel's mode on a wide screen: "float" (over the board, default) or "beside" (the board makes room).
    panelMode,
    // board.titleCount, .shortcuts, .quickFilters (lib/queueConfig.js boardDisplay).
    boardDisplay: display,
    // The Timeline tab: shown, its horizon in days and its default rows (lib/queueConfig.js boardTimeline).
    boardTimeline: timeline,
  };
  // Each step gets status and rests; a step with only rests shows them in the title and the label (the focus line
  // reads the label, the cards and the panel the title), not as an empty step.
  if (focusEval && Array.isArray(data.focus?.stage))
    data.focus.stage = data.focus.stage.map((t) => {
      const e = focusEval.get(t.stage);
      if (!e) return t;
      const extra = { status: e.status, rests: e.rests, open: e.open };
      if (e.status === 'done-with-rests') {
        const types = new Map();
        for (const r of e.rests) types.set(r.type, (types.get(r.type) ?? 0) + 1);
        const text = [...types].map(([type, n]) => `${n} ${type}`).join(', ');
        const suffix = ` (done, rests: ${text})`;
        return { ...t, ...extra, title: `${t.title}${suffix}`, label: `${t.label ?? t.title}${suffix}` };
      }
      if (e.status === 'done')
        return { ...t, ...extra, title: `${t.title} (done)`, label: `${t.label ?? t.title} (done)` };
      return { ...t, ...extra };
    });
  const version = crypto.createHash('sha1').update(JSON.stringify(data)).digest('hex').slice(0, 16);
  // The "Not building" entries for Decisions (board/decide.js notBuildingPart): drafts first, then decided ones.
  data.notBuilding = notBuilding.list;
  // The other catalog entries grouped by kind (board/decide.js catalogPart, roadmap 0å KD-0); the same cache key.
  data.catalogGroups = notBuilding.groups ?? [];
  quick = {
    mtime,
    gitTime: g.time,
    logo,
    mascotFile,
    budget,
    stat: s?.version ?? null,
    listening,
    panelMode,
    displayKey,
    captureAnswers,
    zonesDetect,
    doorOn,
    notBuildingKey: notBuilding.key,
    updateKey,
    baseKey,
    version,
    data,
  };
  return quick;
}

// ---- The statistics: the time log is read only when it has changed, the result is cached -------------
let logCache = { key: null, rows: [], events: [], error: null };
function timeLogRows() {
  // The current file and the monthly archives (lib/timeLogArchive.js): the statistics read all of it, so a rotation
  // changes no number; the key changes when either does.
  const key = TA.signature(TIME_LOG);
  if (key === 'missing') return { key: 'missing', rows: [], events: [], error: 'ENOENT' };
  if (logCache.key !== key) {
    // Only the "done" rows are needed (usage and context); the gate rows (most of them) are dropped at once.
    let text;
    try {
      text = TA.readText(TIME_LOG);
    } catch (e) {
      return { key: 'missing', rows: [], events: [], error: e?.code ?? 'does not exist' };
    }
    const all = TK.readRows(text);
    const rows = all.filter((r) => r?.event === 'done');
    // The flow rows apart (boardFlow), so the "done" rows stay exactly as before.
    const events = all.filter((r) => ER.EVENTS.has(r?.event));
    // The guards' decisions and the overrides (lib/guardLog.js), for "Guard decisions last 7 days".
    const guards = all.filter((r) => GL.OVERRIDES.includes(r?.event) || r?.event === GL.EVENTS.deny || r?.event === GL.EVENTS.ask);
    // S3: the gate and flakyGate rows in a slim form (the numbers only, never an excerpt), for the Machine and Quality
    // sections; the compaction rows only as time and scope.
    const gates = [];
    const compacts = [];
    // "Since you left" (lib/awaySummary.js): a track's red gate runs as time, track, kind and the red command names only.
    const redGates = [];
    // The card's History (lib/taskHistory.js, J5): every track gate run, red and green, in the same slim form.
    const trackGates = [];
    for (const r of all) {
      if (r?.event === 'gate' || r?.event === 'flakyGate') gates.push(SX.slimGateRow(r));
      else if (r?.event === 'compact' && r.scope !== 'session') compacts.push({ time: r.time });
      if (r?.event === 'gate' && r.track) {
        const slim = { time: r.time, event: 'gate', track: r.track, kind: r.kind ?? null, ok: r.ok === false ? false : r.ok === true, failed: r.failed ?? [] };
        trackGates.push(slim);
        if (r.ok === false) redGates.push(slim);
      }
    }
    logCache = { key, rows, events, guards, gates, compacts, redGates, trackGates, error: null };
  }
  return logCache;
}

/** The forecast for the board; an error never stops the state or the statistics (the box is then left out). */
function boardForecast(queue) {
  try {
    return FC.boardForecast(queue);
  } catch (e) {
    console.error(`the forecast failed: ${e?.message ?? e}`);
    return null;
  }
}

/** The plan register for the flow figures (the findings' causes), or null when it is missing or cannot be read. */
function flowPlans() {
  try {
    return fs.existsSync(PLAN_FILE) ? P.normalize(JSON.parse(fs.readFileSync(PLAN_FILE, 'utf8'))) : null;
  } catch {
    return null; // error-ignored: the findings are one input of the right-first-time figure
  }
}

let revertedCache = { time: 0, commits: new Set() };
/** The commits reverted on the base. Read at most once a minute, like the base tip. */
function revertedNow() {
  if (Date.now() - revertedCache.time > 60_000)
    revertedCache = {
      time: Date.now(),
      commits: ES.revertedCommitsIn(gitRead(['log', BASE, '--grep=This reverts commit', '--format=%B'])),
    };
  return revertedCache.commits;
}

/** The flow figures for the last 14 days (lib/eventStatistics.js, the same as in ravenseat cost); an error leaves the box out. */
function boardFlow(queue, events) {
  try {
    const to = Date.now();
    return ES.flowStatistics(queue, events ?? [], {
      from: to - 14 * 86_400_000,
      to,
      plans: flowPlans(),
      reviewerTypes: L.REVIEWER_TYPES,
      revertedCommits: revertedNow(),
    });
  } catch (e) {
    console.error(`the flow figures failed: ${e?.message ?? e}`);
    return null;
  }
}

// The Claude Code settings files that may set autoCompactWindow (the context cap), in precedence order.
const COMPACT_FILES = [
  ['.claude/settings.local.json', path.join(ROOT, '.claude', 'settings.local.json')],
  ['.claude/settings.json', path.join(ROOT, '.claude', 'settings.json')],
  ['~/.claude/settings.json', path.join(os.homedir(), '.claude', 'settings.json')],
];
const FINDINGS_FILE = path.join(FOLDER, 'findings.jsonl');
const RATE_FILE = path.join(FOLDER, RL.FILE);
/** A file's mtime for a cache key, 0 when it is missing. */
function mtimeOf(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0; // not there (yet)
  }
}
/** A JSON file, or null when it is missing or broken (a settings file the owner is editing, say). */
function jsonOrNull(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null; // error-ignored: the figure then falls back (300k cap, no quota reading)
  }
}

/**
 * The reworked sections (lib/statisticsSections.js: top row, Cost and tokens, Machine, Quality); an error leaves them
 * out and the older charts still show.
 */
function boardSections(queue, log, stat, cap) {
  try {
    let findings = [];
    try {
      findings = FL.read(null, { since: Date.now() - S.WINDOW_DAYS * 86_400_000, includeArchive: true }).rows;
    } catch {
      findings = []; // error-ignored: no finding log yet, or a data folder without one
    }
    // PG-6 (lib/planPostCheck.js): the built plans against their estimates, with plans.postCheck on. The success
    // measure is read through the /api/doc guard (queueBoard.readDocument), only for a plan with a decision source.
    const fresh = KK.config({ fresh: true });
    let postCheck = null;
    if (require('./lib/planPostCheck.js').postCheckSetup(fresh).on) {
      const reg = flowPlans();
      const readDoc = (p) => {
        const r = T.readDocument(SOURCE_ROOT, p, { fs, path });
        return r.ok ? r.text : null;
      };
      if (reg?.entries?.length)
        postCheck = { entries: reg.entries, measureFor: (e) => require('./lib/planPostCheck.js').decisionMeasure(e, readDoc) };
    }
    const out = SX.sections({
      queue,
      rows: log.rows,
      gateRows: log.gates ?? [],
      loadRows: (log.events ?? []).filter((r) => r?.event === 'load'),
      findings,
      observed: jsonOrNull(RATE_FILE),
      cap: cap.cap,
      statistics: stat,
      plans: postCheck,
    });
    const from = Date.now() - S.WINDOW_DAYS * 86_400_000;
    out.cost.context.source = cap.source;
    out.cost.context.compactions = (log.compacts ?? []).filter((c) => Date.parse(c.time) >= from).length;
    // Which settings are on now, for the "Does this look bad?" lines (no figure, only the advice text).
    out.settings = { machineSampleMin: require('./lib/machineSample.js').minutesFrom(fresh) };
    return out;
  } catch (e) {
    console.error(`the statistics sections failed: ${e?.message ?? e}`);
    return null;
  }
}

let statCache = null;
function statistics() {
  const log = timeLogRows();
  // plans.json is in the key too: a new finding with --cause changes the right-first-time figure. So are the quota
  // reading, the finding log and the settings files that set the context cap.
  const extra = [PLAN_FILE, RATE_FILE, FINDINGS_FILE, ...COMPACT_FILES.map((f) => f[1])].map(mtimeOf).join('|');
  const key = `${log.key}|${fs.statSync(FILE).mtimeMs}|${archiveMtime()}|${extra}|${TK.dayFor(new Date().toISOString())}`;
  if (statCache?.key === key) return statCache;
  // With the archived tasks, so no figure changes when a task moves to the archive.
  const queue = QARCH.withArchive(JSON.parse(fs.readFileSync(FILE, 'utf8')), FOLDER);
  // The context cap follows the compaction window (roadmap B13) instead of a fixed 300k.
  const cap = SX.compactWindow(COMPACT_FILES.map(([name, file]) => ({ name, settings: jsonOrNull(file) })));
  const stat = S.statistics(queue, log.rows, { cap: cap.cap });
  const data = {
    ...stat,
    sections: boardSections(queue, log, stat, cap),
    // "Blockers last 7 days" (queueLogic.blockerSummary, the same numbers as ravenseat blockers).
    blockers: L.blockerSummary(queue, { days: 7 }),
    // "Guard decisions last 7 days" (lib/guardLog.js counts, the same numbers as the doctor's decisions row).
    guards: GL.counts(log.guards ?? [], { from: Date.now() - 7 * 86_400_000 }),
    timeLogError: log.error,
    forecast: boardForecast(queue),
    // The slim gate rows too: "Gates run twice" (CI-1) reads their wait_sec and sha. Only event "gate": the flakyGate
    // rows in log.gates are already in log.events, and counting them twice would double the flaky figure.
    flow: boardFlow(queue, [...(log.events ?? []), ...(log.gates ?? []).filter((r) => r?.event === 'gate')]),
  };
  const version = crypto.createHash('sha1').update(JSON.stringify(data)).digest('hex').slice(0, 16);
  statCache = { key, version, data };
  return statCache;
}

// ---- The Timeline tab (roadmap TIDSLINJE T-A; lib/queueTimeline.js) ------------------------------------------------
// Read-only: the queue is played forward on a copy (queueSchedule.js) and nothing is written. One payload is kept per
// key (the queue's mtime and size, the settings and the minute), so the polls of an open tab do not play it again.
let scheduleCache = { key: null, data: null };
/** The payload of GET /api/schedule; with board.timeline off only { enabled: false } (nothing is read). */
function scheduleData() {
  const settings = KK.boardTimeline(KK.config({ fresh: true }));
  if (!settings.on) return { enabled: false, settings, version: 'off' };
  let stamp = 'none';
  try {
    const st = fs.statSync(FILE);
    stamp = `${st.mtimeMs}:${st.size}`;
  } catch {
    /* no queue file: read below fails with its own error */
  }
  const now = Date.now();
  const key = QT.cacheKey({ queueStamp: stamp, settings, now });
  if (scheduleCache.key === key) return scheduleCache.data;
  const queue = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const caps = scheduleCaps(queue);
  // T-C (board.timelineUncertainty): the band is played up to 200 times (lib/scheduleUncertainty.js runsFor caps it by
  // the open tasks), so it is kept per queue stamp and BAND_MINUTES instead of per minute; the backtest only reads the
  // past, so it is kept per UTC day and the number of done tasks.
  let extra = {};
  if (settings.uncertainty) {
    const bandKey = JSON.stringify([stamp, caps, Math.floor(now / (BAND_MINUTES * 60_000))]);
    if (bandCache.key !== bandKey) bandCache = { key: bandKey, data: UNC.uncertainty(queue, { now, ...caps }) };
    const doneCount = (queue.tasks ?? []).filter((o) => o?.status === 'done').length;
    const backtestKey = JSON.stringify([Math.floor(now / 86_400_000), doneCount, (queue.tasks ?? []).length]);
    if (backtestCache.key !== backtestKey) backtestCache = { key: backtestKey, data: UNC.backtest(queue, { now }) };
    extra = { uncertainty: true, band: bandCache.data, backtest: backtestCache.data };
  }
  const data = { enabled: true, settings, version: key, ...QT.timelineData(queue, { now, ...caps, ...extra }) };
  scheduleCache = { key, data };
  return data;
}
/** T-C: how long the band is kept (minutes), and the band and backtest caches. */
const BAND_MINUTES = 5;
let bandCache = { key: null, data: null };
let backtestCache = { key: null, data: null };

/**
 * The caps the plan is played with: the same as cli/schedule.mjs. A forecast or a measurement that fails never stops
 * the tab or a preview (no cap then). Used by the Timeline (scheduleData) and by a drop's preview (T-B, planEffect).
 */
function scheduleCaps(queue) {
  let quotaSlots = null;
  try {
    const running = (queue.tasks ?? []).filter((o) => o.status === 'running').length;
    quotaSlots = SCHED.quotaSlotsFrom(KAP.forecast({ queue, events: usage() }), running);
  } catch {
    quotaSlots = null;
  }
  let loadSlots = null;
  try {
    const ls = L.loadSlotsFor(queue, LOADS.measure({ cpu: false }));
    loadSlots = ls.active ? ls.slots : null;
  } catch {
    loadSlots = null;
  }
  return { quotaSlots, loadSlots };
}

/**
 * T-B: what a Timeline drop does to the plan, in words ({ sentence, parts }), for a dry run that asked for it
 * (plan_effect: true). `copy` is the queue as the drop would leave it. A failure gives null: the preview then shows the
 * dry run without the sentence, it never stops the drop.
 */
function planEffectOf(queue, copy, moved = []) {
  try {
    return QT.planEffect(queue, copy, { now: Date.now(), ...scheduleCaps(queue), moved });
  } catch {
    return null;
  }
}

// ---- "Since you left" (roadmap 3e AW-2, AW-3, AW-8; lib/awaySummary.js) ---------------------------------------------
/**
 * The band at the top of Decisions: the window (the board's choice, else board.sinceLastWindow), the summary on the
 * queue with its archive and the time log rows the cache already keeps, and "Decided" for the same window. `from` is
 * the start the board opened with, so the window stays put for the visit while the seen mark moves. With
 * board.sinceLast off only { on: false } (nothing is read).
 */
function sinceData({ choice = null, from = null } = {}) {
  const fresh = KK.config({ fresh: true });
  const setup = KK.boardSince(fresh);
  if (!setup.on) return { on: false, default_choice: setup.window };
  const now = Date.now();
  const seen = SEEN.readSeen(FOLDER);
  const w = AWAY.resolveWindow({ choice: choice ?? setup.window, seen, from, now });
  // Decided for you carries a delivery's door and blast radius; hidden while mergeDanger.show is off (lib/doorShow.js).
  const queue = DOOR.hideStored(QARCH.withArchive(JSON.parse(fs.readFileSync(FILE, 'utf8')), FOLDER), fresh);
  const log = timeLogRows();
  // What waits on the owner now: the same count as "Waiting on you" (null when the state could not be built).
  let waiting = null;
  try {
    waiting = state().data?.inbox?.count ?? null;
  } catch {
    waiting = null;
  }
  return {
    on: true,
    default_choice: setup.window,
    seen,
    window: { ...w, text: AWAY.windowText(w) },
    summary: AWAY.awaySummary({ queue, rows: [...(log.events ?? []), ...(log.redGates ?? [])], from: w.from, to: w.to, waiting }),
    decided: DEC.decidedToday(queue, { now, from: w.from }),
    decided_for_you: DEC.decidedForYou(queue, { now, from: w.from }),
  };
}

// ---- The plan register: read only, rebuilt when plans.json or queue.json changes (or every minute,
// so "stale" and "Working now" expire on their own). Writing to the register never goes via the board in this track.
let planCache = null;
// The lead of a plan without a summary, read from its plan document (P3 of plans/plans-tab-ux-review-2026-11-19.md;
// queueBoard.planLeadReader: the /api/doc guard, cached per file by time and size). One reader for the process, so the
// cache lives as long as the board.
// `let`: demo mode makes both again on the demo folder's documents (useDemo), and back.
let planLead = T.planLeadReader(SOURCE_ROOT, { fs, path });
// P5: the full-text search in the plan documents (queueBoard.planDocSearcher: the same source, guard and cap as the
// lead, passages cached per file by time and size). One searcher for the process, like the lead reader.
let planSearch = T.planDocSearcher(SOURCE_ROOT, { fs, path });
// PG-1/PG-3: the decision section's state for a large plan's detail panel (queueBoard.planDecisionReader: the same
// guard, cached per file by time and size). The zones are read again with each new plans() answer, so an accepted zone
// shows within a minute; plans.decisionNote off reads nothing (the caller passes no reader).
const planDecisionFor = () => {
  let zonesFor = null;
  try {
    // The demo has no catalog: the real project's zones are never read for it.
    if (!demoOn) zonesFor = require('./lib/catalogZones.js').zonesOnDisk();
  } catch {
    // error-ignored: a zone only raises attention; the size rule still applies
  }
  const read = T.planDecisionReader(SOURCE_ROOT, { fs, path }, { zonesFor });
  return (entry, tasks) => read(entry, tasks);
};
function plans() {
  const mt = (f) => {
    try {
      return fs.statSync(f).mtimeMs;
    } catch {
      return 0;
    }
  };
  // The Roadmap settings (plans.* in queue.config.json) are read fresh and are part of the key, so a change in the gear
  // reaches the open board on its next poll without a restart.
  const view = KK.plansView(KK.config({ fresh: true }));
  const key = `${mt(PLAN_FILE)}|${mt(FILE)}|${archiveMtime()}|${Math.floor(Date.now() / 60_000)}|${JSON.stringify(view)}`;
  if (planCache?.key === key) return planCache;
  const reg = fs.existsSync(PLAN_FILE)
    ? P.normalize(JSON.parse(fs.readFileSync(PLAN_FILE, 'utf8')))
    : P.emptyRegister();
  // With the archived tasks: a plan's status is derived from its linked tasks, so archiving one never changes it.
  const queue = fs.existsSync(FILE) ? QARCH.withArchive(JSON.parse(fs.readFileSync(FILE, 'utf8')), FOLDER) : {};
  const now = new Date();
  const fk = L.rankingContext(queue, now.getTime());
  // The column and focus stage for a queue task (same rules as the cards on the board, queueBoard.board).
  const queueInfo = (o) => {
    const column = o.id ? T.columnFor(o) : null;
    if (column !== 'queue') return { column, applies: fk.applies };
    const p = L.focusSpace(o, fk);
    const stage = p.step != null ? queue.focus?.order?.[p.step] : null;
    return {
      column,
      applies: fk.applies,
      step: p.step,
      outside: fk.applies ? p.outside : false,
      step_title: stage ? L.stepTitle(stage, queue) : null,
    };
  };
  // The pace for the capacity figure on the overview (finished queue tasks per week, as `plan check`).
  const window = P.CAPACITY_WINDOW_DAYS ?? 28;
  const donePerWeek =
    S.doneInWindow(queue, S.daysBackward(now.getTime(), window)).length / (window / 7);
  const data = {
    ...PRIVACY.plansData(reg, queue, {
      now,
      queueInfo,
      queuePlan: P,
      donePerWeek,
      // No document is read while the Plans room is off or plans.leadFromDocument is false.
      leadFor: FEATURES.plans && view.leadFromDocument ? planLead : null,
      decisionFor: FEATURES.plans && view.decisionNote ? planDecisionFor() : null,
    }),
    exists: fs.existsSync(PLAN_FILE),
    view,
  };
  const version = crypto.createHash('sha1').update(JSON.stringify(data)).digest('hex').slice(0, 16);
  planCache = { key, version, data };
  return planCache;
}

// ---- Live update. GET /api/plans?version=…&wait=1 waits (at most WAIT_MS) until plans.json
// or queue.json changes, so changes from a Claude Code session show without reloading the page. The folder is watched with
// fs.watch (the files are written atomically with rename); if that does not work, the call answers "unchanged" after the wait, and the client
// asks again. Read only.
const WAIT_MS = 25_000;
const PLAN_WAITERS = new Set();
let planGuard = null;
function planGuardOn() {
  if (planGuard !== null) return;
  try {
    let time = null;
    planGuard = fs.watch(FOLDER, (_event, name) => {
      if (name && !/^(plans|queue)\.json$/.test(String(name))) return;
      clearTimeout(time);
      // A short pause: a write is a tmp file + rename, and queue.mjs can write both files one after the other.
      time = setTimeout(() => {
        for (const v of [...PLAN_WAITERS]) v();
      }, 150);
    });
    planGuard.on('error', () => {
      planGuard?.close();
      planGuard = false;
    });
  } catch {
    planGuard = false; // fs.watch does not work here: the calls answer after the wait
  }
}
/**
 * Waits until the register changes, the client leaves, or WAIT_MS has passed. `res` (not req): req sends "close" as soon as a
 * GET without a body is fully read, res only when the connection closes.
 */
function waitOnPlans(res) {
  planGuardOn();
  return new Promise((done) => {
    let time = null;
    const v = () => {
      PLAN_WAITERS.delete(v);
      clearTimeout(time);
      res.off('close', v);
      done();
    };
    time = setTimeout(v, WAIT_MS);
    PLAN_WAITERS.add(v);
    res.on('close', v);
  });
}

/** A JSON file, or null when it is missing or broken. */
function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * The tidy line in Settings > Project (lib/tidy.js, roadmap 1b): the same count as doctor's tidy row, with the command
 * to copy. Read only. Kept for five minutes, since it runs git status in every worktree; null value fields = unknown.
 * tidy.doctor false hides the count (the line still shows the command).
 */
const TIDY_CACHE_MS = 5 * 60_000;
let tidyCache = null;
function tidySummary(queue, config) {
  const command = `${require('./lib/projectRoot.js').cliCommand()} tidy`;
  if (config.tidy?.doctor === false) return { off: true, command };
  if (tidyCache && Date.now() - tidyCache.at < TIDY_CACHE_MS) return tidyCache.value;
  let value;
  try {
    const TIDY = require('./lib/tidy.js');
    const minAge = Number(config.tidy?.minAgeHours);
    const t = TIDY.scan({
      main: GIT_ROOT,
      base: String(config.baseBranch ?? 'main'),
      prefix: config.branchPrefix ?? 'queue/',
      tasks: queue.tasks ?? [],
      minAgeHours: Number.isFinite(minAge) && minAge >= 0 ? minAge : 3,
      sharedLinks: config.sharedLinks,
      production: config.productionBranch ?? null,
      exclude: config.excludeBranches ?? [],
      dataFolder: FOLDER,
      sizes: 'removable',
    }).totals;
    value = { worktrees: t.worktrees, branches: t.branches, size: TIDY.sizeText(t.worktreeBytes, t.capped), command, at: new Date().toISOString() };
  } catch (e) {
    value = { error: String(e?.message ?? e).split('\n')[0], command };
  }
  tidyCache = { at: Date.now(), value };
  return value;
}

/** The setup in the settings panel (read only, from the real sources). */
function setup(queue, stat) {
  // The migrations are shown only when the project has turned on the migration flow (config().migrations.folder).
  const m = CONFIG.migrations ?? {};
  let migrations = null;
  if (m.folder) {
    let files = [];
    let error = null;
    try {
      files = fs.readdirSync(path.join(GIT_ROOT, ...String(m.folder).split('/')));
    } catch (e) {
      error = e?.code ?? 'could not read the folder';
    }
    migrations = {
      folder: m.folder,
      error,
      next: queue.next_migr ?? null,
      highest: T.highestMigration(files, m.filePattern),
    };
  }
  const cursor = readJson(CURSOR);
  // Plugin install: the hooks and skills ship in the plugin folder. Vendored: they are in the project's .claude/.
  const src = T.setupSources(HERE, GIT_ROOT, (f) => fs.existsSync(f));
  const settings = readJson(src.hooksFile);
  const manifest = src.manifest ? readJson(src.manifest) : null;
  return {
    baseBranch: BASE,
    migrations,
    orchestrator: { ...L.orchestratorStatus(cursor), updated: cursor?.updated ?? null },
    models: stat.models,
    install: {
      mode: src.mode,
      name: manifest?.name ?? null,
      version: manifest?.version ?? null,
    },
    hooks: settings ? T.hooksCoverage(settings) : null,
    skills: T.skillsCoverage((name) =>
      fs.existsSync(path.join(src.skillsFolder, name, 'SKILL.md')),
    ),
    rules: T.SKILL_RULES.map((r) => r.text),
    rulesSource: T.SKILL_SOURCE,
  };
}

/**
 * The mission text: the file `mission` points to (in the worktree or the main tree, never outside), otherwise the text itself.
 *
 * "Never outside" is checked the same way as /api/doc (queueBoard.readDocument), not only on the written path:
 *   1. the resolved path must lie under the root (stops `..` and absolute paths),
 *   2. every part under the root is checked with lstat: a symlink or junction (Node reports both as a symlink) is refused,
 *   3. the real path (realpath) must be exactly the real root + the same parts (catches 8.3 short names, other upper and
 *      lower case and links step 2 did not see).
 * Without 2 and 3 a mission path like `docs/link/secret.md`, where `link` is a junction to another folder, would let
 * the board show any file on the machine (red team finding 11, RT-23). A refused path falls back to the text itself.
 */
function missionFor(o) {
  const s = String(o.mission ?? '');
  // The demo's missions are text; a path in one is never read from the real project.
  if (s && !s.includes('\n') && !demoOn) {
    for (const root of [ROOT, MAIN_TREE]) {
      const filePath = path.resolve(root, s);
      if (!filePath.startsWith(root + path.sep)) continue;
      try {
        // Step 2: walk from the real root, part by part, and refuse any link on the way.
        const realRoot = fs.realpathSync.native(root);
        const parts = path.relative(root, filePath).split(path.sep);
        let here = realRoot;
        let linked = false;
        for (const d of parts) {
          here = path.join(here, d);
          if (fs.lstatSync(here).isSymbolicLink()) {
            linked = true;
            break;
          }
        }
        if (linked) continue;
        // Step 3: the real path must be the path we walked, nothing else.
        const real = fs.realpathSync.native(here);
        if (real !== path.join(realRoot, ...parts)) continue;
        if (fs.statSync(real).isFile())
          return { text: fs.readFileSync(real, 'utf8').slice(0, 200_000), path: s };
      } catch {
        /* does not exist here */
      }
    }
  }
  return { text: s, path: null };
}

/**
 * Does a write action. Returns { status, answer }. The POST route map: each /api/ path and its handler in
 * queue-board/api/. `c` is what one write call shares: the queue as it is now, the 400 answer, and `run`, which runs
 * queue.mjs, logs one line and answers with the guard rules' info texts (`c.info`, set by the handler first).
 */
async function write(filePath, b) {
  const queueNow = () => JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const c = {
    info: [],
    queueNow,
    no: (message) => ({ status: 400, answer: { ok: false, message } }),
    run: async (args, what) => {
      const r = await queueMjs(args);
      quick = null;
      const clock = new Date().toLocaleTimeString('en-GB');
      console.log(`${clock} ${what}: ${r.ok ? 'ok' : `failed (${r.error || r.out})`}`);
      return r.ok
        ? { status: 200, answer: { ok: true, message: r.out, info: c.info } }
        : { status: 409, answer: { ok: false, message: r.error || r.out || 'ravenseat failed' } };
    },
  };

  // Bulk actions from the selection bar and "Undo".
  if (filePath === '/api/bulk') return bulk(b, queueNow);
  if (filePath === '/api/undo') return undo(b);
  // "Cancel task", "Decline" and "Edit" in the detail panel (logged, so the same "Undo" works).
  if (filePath === '/api/task-edit') return taskEdit(b, queueNow);
  // The plan view ("Save focus") and areas.
  if (filePath === '/api/focus') return focus(b, queueNow);
  if (filePath === '/api/area') return area(b, queueNow);
  // The priority map in the Plans space ("Save the priorities").
  if (filePath === '/api/plan-prioritize') return planPrioritize(b);
  // The Unregistered box ("New entry" and "Add as source").
  if (filePath === '/api/plan-new') return planNew(b);
  if (filePath === '/api/plan-source') return planSource(b);
  // "+ New plan": quick capture into the Inbox, saved at once with Undo.
  if (filePath === '/api/plan-capture') return planCapture(b);
  // Accept, Decline and Merge on an Inbox row (P7): the owner confirms Claude's proposal, with Undo.
  if (filePath === '/api/plan-proposal') return planProposal(b);
  // Multi select and change in the row, and undo what the board just saved.
  if (filePath === '/api/plan-bulk') return planBulk(b);
  if (filePath === '/api/plan-undo') return planUndo(b);
  // The lawyer package (local draft, never sent).
  if (filePath === '/api/lawyerPackage') return lawyerPackageWrite(b);
  // "Since you left": the seen mark (AW-3).
  if (filePath === '/api/seen') return seen(b, c);
  // The update banner's X: the same dismissal as `ravenseat update dismiss`.
  if (filePath === '/api/update-dismiss') return updateDismiss(b, c);
  // A card dragged on the board, and a project lane (tasks.mjs).
  if (filePath === '/api/move') return move(b, c);
  // The gear, the Checks tab, the helper agents and auto-accept (settings.mjs).
  if (filePath === '/api/limit') return limit(b, c);
  if (filePath === '/api/setting') return setting(b, c);
  if (filePath === '/api/guidance') return guidance(b, c);
  if (filePath === '/api/checks') return checks(b, c);
  if (filePath === '/api/helper') return helper(b, c);
  if (filePath === '/api/proposals') return proposals(b, c);
  if (filePath === '/api/proposals-undo') return proposalsUndo(b, c);
  if (filePath === '/api/helper-add') return helperAdd(b, c);
  if (filePath === '/api/lane') return lane(b, c);
  // The card and inbox actions: pause, resolve, QA, approve, pick, release, batch, cloud, switches (actions.mjs).
  if (filePath === '/api/action') return action(b, c);
  return { status: 404, answer: { ok: false, message: 'unknown address' } };
}

// ---- HTTP -------------------------------------------------------------------------------------------------------
const SECURITY = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; " +
    "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

// JSON over 50 KB (/api/state is several hundred KB) is compressed with brotli or gzip when
// the client says it supports it (Accept-Encoding). The choice is the pure function in queue-board/performance.js (tested).
const Y = require('./queue-board/performance.js');
function send(res, status, type, body, extra = {}) {
  const header = { ...SECURITY, 'Content-Type': type, ...extra };
  if (type.startsWith('application/json')) {
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''), 'utf8');
    const encoding = Y.selectEncoding(res.req?.headers['accept-encoding'], bytes.length);
    header.Vary = 'Accept-Encoding';
    if (encoding) {
      body =
        encoding === 'br'
          ? zlib.brotliCompressSync(bytes, {
              params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 }, // quick enough for every fetch
            })
          : zlib.gzipSync(bytes, { level: 6 });
      header['Content-Encoding'] = encoding;
    }
  }
  res.writeHead(status, header);
  res.end(body);
}
const json = (res, status, obj) =>
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(obj), {
    'Cache-Control': 'no-store',
  });

// The board's own client: classic scripts in queue-board/board/ that share one scope and load in this order (the
// same list as index.html; see docs/board.md). Each file is allow-listed by name, like the rest of STATIC.
const BOARD_SCRIPTS = [
  'core.js',
  'api.js',
  'cards.js',
  'draw.js',
  'views.js',
  'menus.js',
  'statistics.js',
  'settings.js',
  'question.js',
  'decide.js',
  'checks.js',
  'panel.js',
  'edit.js',
  'select.js',
  'bulk.js',
  'interact.js',
  'top.js',
  'cloud.js',
  'timeline.js',
  'timelinemove.js',
  'route.js',
  'keys.js',
  'palette.js',
  'search.js',
  'demo.js',
  'start.js',
];
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  ...Object.fromEntries(
    BOARD_SCRIPTS.map((f) => [`/board/${f}`, [path.join('board', f), 'text/javascript; charset=utf-8']]),
  ),
  '/board.css': ['board.css', 'text/css; charset=utf-8'],
  // The "Dependencies" view. The layout is the pure functions in lib/queueGraph.js (the same file the tests use),
  // served unchanged to the browser; graph.js draws.
  '/graph.js': ['graph.js', 'text/javascript; charset=utf-8'],
  '/queueGraph.js': [path.join('..', 'lib', 'queueGraph.js'), 'text/javascript; charset=utf-8'],
  // The speech bubble (mascot.js) and the pure rules in lib/queueMascot.js (the same file the tests use).
  '/mascot.js': ['mascot.js', 'text/javascript; charset=utf-8'],
  // The Ravenseat logo: the default picture in the mascot zone (the mascot from /logo is a switch in the gear). Used as
  // a CSS mask, so the color comes from the theme.
  '/ravenseat.svg': ['ravenseat.svg', 'image/svg+xml'],
  '/queueMascot.js': [path.join('..', 'lib', 'queueMascot.js'), 'text/javascript; charset=utf-8'],
  // The Decisions view's rules (lib/queueDecisions.js: sorting, grouping, impact, the writes; the same file the tests
  // and ravenseat decide use); board/decide.js draws.
  '/queueDecisions.js': [path.join('..', 'lib', 'queueDecisions.js'), 'text/javascript; charset=utf-8'],
  // The update banner's rules (lib/queueUpdate.js, the same file the tests use); board/start.js draws it.
  '/queueUpdate.js': [path.join('..', 'lib', 'queueUpdate.js'), 'text/javascript; charset=utf-8'],
  '/demoOffer.js': [path.join('..', 'lib', 'demoOffer.js'), 'text/javascript; charset=utf-8'],
  // The structured search's rules (lib/boardSearch.js, J6, the same file the tests use); board/search.js draws.
  '/boardSearch.js': [path.join('..', 'lib', 'boardSearch.js'), 'text/javascript; charset=utf-8'],
  // The Timeline tab's layout (lib/timelineLayout.js, T-A, the same file the tests use); board/timeline.js draws.
  '/timelineLayout.js': [path.join('..', 'lib', 'timelineLayout.js'), 'text/javascript; charset=utf-8'],
  // The Timeline's drop math for the drag (lib/timelineDrag.js, T-B, the same file the tests use).
  '/timelineDrag.js': [path.join('..', 'lib', 'timelineDrag.js'), 'text/javascript; charset=utf-8'],
  // The plan view (Now, Next, Later, Waiting) with a draft and "Save focus", and the help.
  '/plan.js': ['plan.js', 'text/javascript; charset=utf-8'],
  // Shared focus trap, toast queue, tabs and legend (the same file the tests use).
  '/a11y.js': ['a11y.js', 'text/javascript; charset=utf-8'],
  // The card buffer, the keyboard between the columns and the compression choice (the same file the tests use).
  '/performance.js': ['performance.js', 'text/javascript; charset=utf-8'],
  // The Plans space (its own files in plans/) and the pure rules in lib/queuePlanView.js (the same file the tests use),
  // served unchanged to the browser.
  '/plans/plans.js': [path.join('plans', 'plans.js'), 'text/javascript; charset=utf-8'],
  '/plans/plans.css': [path.join('plans', 'plans.css'), 'text/css; charset=utf-8'],
  // The Documents and agreements view, drawn with the pure rules in queuePlanView.js.
  '/plans/documents.js': [path.join('plans', 'documents.js'), 'text/javascript; charset=utf-8'],
  // The priority map and the deadline band.
  '/plans/map.js': [path.join('plans', 'map.js'), 'text/javascript; charset=utf-8'],
  // Tree map and dependencies for the selection.
  '/plans/structure.js': [path.join('plans', 'structure.js'), 'text/javascript; charset=utf-8'],
  // The reading view of documents and the Unregistered box.
  '/plans/read.js': [path.join('plans', 'read.js'), 'text/javascript; charset=utf-8'],
  // The Legal, Decisions and Launch views.
  '/plans/legal.js': [path.join('plans', 'legal.js'), 'text/javascript; charset=utf-8'],
  // Overview, and the keyboard, Ctrl+K, multi select and change in the row.
  '/plans/overview.js': [path.join('plans', 'overview.js'), 'text/javascript; charset=utf-8'],
  '/plans/work.js': [path.join('plans', 'work.js'), 'text/javascript; charset=utf-8'],
  // The Roadmap (the start page) and the plan page.
  '/plans/roadmap.js': [path.join('plans', 'roadmap.js'), 'text/javascript; charset=utf-8'],
  '/plans/filter.js': [path.join('plans', 'filter.js'), 'text/javascript; charset=utf-8'],
  '/plans/capture.js': [path.join('plans', 'capture.js'), 'text/javascript; charset=utf-8'],
  // P7: Accept, Edit, Decline and Merge on an Inbox row.
  '/plans/triage.js': [path.join('plans', 'triage.js'), 'text/javascript; charset=utf-8'],
  '/queuePlanView.js': [path.join('..', 'lib', 'queuePlanView.js'), 'text/javascript; charset=utf-8'],
};

/** HTML escaping for the title inserted into index.html. */
const escHtml = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
/** index.html with the title from queue.config.json inserted ({{TITLE}}). */
const readIndex = () =>
  fs.readFileSync(path.join(CLIENT, 'index.html'), 'utf8').replaceAll('{{TITLE}}', escHtml(TITLE));

function correctKey(req) {
  const input = Buffer.from(String(req.headers['x-queue-key'] ?? ''));
  const answerKey = Buffer.from(KEY);
  return input.length === answerKey.length && crypto.timingSafeEqual(input, answerKey);
}

/**
 * The request body cap. A write is small (a task id, a form), so 16 KB is plenty; the one exception is the focus plan
 * (POST /api/focus), which may carry up to queueLogic.FOCUS_STEPS_MAX steps of up to ~130 characters each (QA-1c Q12):
 * it gets FOCUS_BODY_MAX, so a plan at the step limit is never refused as "too large" before the limit can answer.
 */
const BODY_MAX = 16_384;
const FOCUS_BODY_MAX = 131_072;
function readBody(req, limit = BODY_MAX) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    req.on('data', (b) => {
      n += b.length;
      if (n > limit) {
        reject(new Error('request too large'));
        req.destroy();
      } else chunks.push(b);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** The time of the last POST /open (one per 2 s). */
let lastOpen = 0;

// ---- Demo mode (lib/demoMode.js, lib/demoOffer.js; docs/board.md "Demo mode") ---------------------------------------
// useDemo(true) points every path the board reads and writes at <dataFolder>/demo/, puts the demo variables into this
// process's environment (so the lib modules that ask KK.dataFolder(), KK.timeLog(), the config file or the transcripts
// folder get the demo too), makes the plan document readers again on the demo's documents and drops every cache, so
// nothing read from the real queue is shown in the demo or the other way. useDemo(false) puts all of it back. Both run
// inside the write chain (oneAtATime), so no write ever runs half in one mode and half in the other.
const DEMO_ENV_KEYS = Object.keys(DEMO.demoVariables(DEMO_PATHS));
let savedEnv = null;

/** Every cache back to its start value (the paths behind them have changed). */
function resetCaches() {
  gitStatus = { time: 0, uncommitted: [], error: false, pushedHead: null, sincePush: [] };
  usageCache = { key: null, list: [] };
  silentCache = { time: 0, key: null, list: [] };
  reviewsCache = { key: null, list: [] };
  spinCache = { time: 0, key: null, list: [] };
  baseTipCache = { time: 0, tip: null };
  pushBatchCache = { time: 0, batch: null, blocked: [], fullGate: 'off' };
  checksCache = { time: 0, data: null, running: false };
  notBuildingCache = { key: null, list: [] };
  checksReport = { time: 0, report: null };
  quick = null;
  logCache = { key: null, rows: [], events: [], error: null };
  revertedCache = { time: 0, commits: new Set() };
  statCache = null;
  scheduleCache = { key: null, data: null };
  bandCache = { key: null, data: null };
  backtestCache = { key: null, data: null };
  planCache = null;
  tidyCache = null;
  resetPlanCheck();
  demoCountCache = { key: null, count: 0, archived: 0 };
  // The live update watched the old data folder: close it (the next wait watches the new one) and answer the waiters.
  if (planGuard) {
    try {
      planGuard.close();
    } catch {
      // error-ignored: a watcher that is already gone needs no closing
    }
  }
  planGuard = null;
  for (const v of [...PLAN_WAITERS]) v();
}

function useDemo(on) {
  if (on === demoOn) return;
  if (on) {
    savedEnv = Object.fromEntries(DEMO_ENV_KEYS.map((k) => [k, process.env[k]]));
    Object.assign(process.env, DEMO.demoVariables(DEMO_PATHS));
    FOLDER = DEMO_PATHS.data;
    FILE = DEMO_PATHS.queue;
    CURSOR = path.join(DEMO_PATHS.data, 'orchestrator.json');
    PLAN_FILE = DEMO_PATHS.plans;
    FOLLOW_FILE = path.join(DEMO_PATHS.data, 'follow.json');
    BASE_HEALTH_FILE = path.join(DEMO_PATHS.data, 'base-health.json');
    SOURCE_ROOT = DEMO_PATHS.root;
    GIT_ROOT = DEMO_PATHS.root;
    TIME_LOG = DEMO_PATHS.timeLog;
  } else {
    for (const [k, v] of Object.entries(savedEnv ?? {})) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    savedEnv = null;
    ({ FOLDER, FILE, CURSOR, PLAN_FILE, FOLLOW_FILE, BASE_HEALTH_FILE, SOURCE_ROOT, GIT_ROOT, TIME_LOG } = REAL);
  }
  demoOn = on;
  planLead = T.planLeadReader(SOURCE_ROOT, { fs, path });
  planSearch = T.planDocSearcher(SOURCE_ROOT, { fs, path });
  resetCaches();
}

/** The real queue's task count and archive count, read again only when queue.json or the archive changes. */
let demoCountCache = { key: null, count: 0, archived: 0 };
/**
 * state().demo: { on, offer, setting }. The offer (lib/demoOffer.js offerShown) is read from the REAL queue: shown while it
 * has never had a task, board.demoOffer is on and the project has not said "Don't show again". "Not now" is the
 * browser's own (one visit, sessionStorage).
 */
function demoNow(fresh) {
  const setting = fresh?.board?.demoOffer !== false;
  if (demoOn) return { on: true, offer: false, setting };
  let key = 'none';
  try {
    let arch = 0;
    try {
      arch = fs.statSync(QARCH.archiveFile(REAL.FOLDER)).mtimeMs;
    } catch {
      // error-ignored: no archive yet
    }
    key = `${fs.statSync(REAL.FILE).mtimeMs}:${arch}`;
  } catch {
    // error-ignored: no queue file yet counts as no task
  }
  if (demoCountCache.key !== key) {
    let count = 0;
    let archived = 0;
    try {
      count = (JSON.parse(fs.readFileSync(REAL.FILE, 'utf8')).tasks ?? []).length;
      archived = QARCH.load(REAL.FOLDER).tasks.length;
    } catch {
      // error-ignored: an unreadable queue offers nothing (the board shows its own error)
      count = 1;
    }
    demoCountCache = { key, count, archived };
  }
  const offer = DEMO_OFFER.offerShown({
    setting,
    dismissed: DEMO.readOffer(REAL.FOLDER).dismissed,
    taskCount: demoCountCache.count,
    archivedCount: demoCountCache.archived,
  });
  return { on: false, offer, setting };
}

/**
 * POST /api/demo { action: enter | reset | leave | dismiss }: the offer card, the banner and the Settings row. Runs in
 * the write chain. enter and reset make the demo folder fresh from the snapshot (lib/demoMode.js build: refused when
 * the folder is or holds a link); leave points the board back at the real queue and deletes nothing.
 */
function demoAction(b) {
  const action = String(b?.action ?? '');
  const ok = (message) => ({ status: 200, answer: { ok: true, message, demo: demoOn } });
  const refused = (message) => ({ status: 409, answer: { ok: false, message } });
  if (action === 'dismiss') {
    const r = DEMO.writeDismissed(REAL.FOLDER);
    if (!r.ok) return { status: 500, answer: { ok: false, message: `Could not write demo-offer.json (${r.error}).` } };
    quick = null;
    return ok(DEMO_OFFER.TEXTS.neverDone);
  }
  if (action === 'leave') {
    useDemo(false);
    console.log(`${new Date().toLocaleTimeString('en-GB')} demo mode off: the board shows your queue again`);
    return ok('Back on your board.');
  }
  if (action === 'enter' || action === 'reset') {
    if (action === 'reset' && !demoOn) return refused('Demo mode is not on.');
    // The demo gets the real project's mode (read before the switch and kept), so a lite user sees a lite demo board.
    if (!demoOn) realConfig = KK.config({ fresh: true });
    const mode = realConfig?.mode === 'lite' ? 'lite' : 'full';
    const built = DEMO.build(REAL.FOLDER, { mode });
    if (!built.ok) return refused(built.message);
    if (demoOn) resetCaches();
    else useDemo(true);
    console.log(`${new Date().toLocaleTimeString('en-GB')} demo mode ${action === 'reset' ? 'reset' : 'on'} (${DEMO_PATHS.root})`);
    return ok(action === 'reset' ? 'The demo is back to its start.' : 'Demo board on.');
  }
  return { status: 400, answer: { ok: false, message: `unknown demo action ${action.slice(0, 40)}` } };
}
/** The real project's config, read when demo mode is entered (QUEUE_CONFIG points at the demo while it is on). */
let realConfig = null;

/** Every POST in the write chain: /api/demo itself, then the demo allow-list while demo mode is on, then write(). */
async function writeOrDemo(filePath, b) {
  if (filePath === '/api/demo') return demoAction(b);
  if (demoOn) {
    const no = DEMO.refusal('POST', filePath, b);
    if (no) return no;
  }
  return write(filePath, b);
}

// ---- The route modules (queue-board/api/) ---------------------------------------------------------------------
// ctx is what the handlers read from this file: the live paths and caches as getters (demo mode switches them, so a
// handler reads the value of the moment, as it did when it lived here), the two cache resets, the constants, the data
// builders, the JSON answer and the write plumbing (writeTools.mjs). It is built once and copies nothing.
const ctx = {
  get FILE() {
    return FILE;
  },
  get FOLDER() {
    return FOLDER;
  },
  get CURSOR() {
    return CURSOR;
  },
  get PLAN_FILE() {
    return PLAN_FILE;
  },
  get SOURCE_ROOT() {
    return SOURCE_ROOT;
  },
  get FOLLOW_FILE() {
    return FOLLOW_FILE;
  },
  get demoOn() {
    return demoOn;
  },
  get planSearch() {
    return planSearch;
  },
  get realConfig() {
    return realConfig;
  },
  get planCache() {
    return planCache;
  },
  clearQuick() {
    quick = null;
  },
  clearChecksReport() {
    checksReport = { time: 0, report: null };
  },
  BRANCH_PATTERN, BRANCH_PREFIX, CONFIG, DEMO_PATHS, FEATURES, MAIN_TREE, QUEUE_MJS, REAL, ROOT, TITLE, UPDATE_CACHE,
  branchFor, branchInfo, checksReportNow, demoNow, escHtml, historyFor, json, missionFor, planEffectOf, plans,
  readJson, scheduleData, setup, sinceData, state, statistics, tidySummary, uncommitted, waitOnPlans, write,
};
const WRITE_TOOLS = writeTools(ctx);
Object.assign(ctx, WRITE_TOOLS);
const { queueMjs, oneAtATime } = WRITE_TOOLS;
const { getState, getFollow, getSince, getSchedule, getStatistics, seen } = viewRoutes(ctx);
const { bulk, undo, taskEdit, move, lane, getTask, getArchive } = taskRoutes(ctx);
const { focus, area } = focusRoutes(ctx);
const { planPrioritize, planNew, planSource, getPlans, getPlanSearch, getDoc, getPlanCheck } = planRoutes(ctx);
const { planCapture, planProposal, planBulk, planUndo, lawyerPackageWrite } = planEditRoutes(ctx);
const { action, getCloudPackage, getCloudBundles } = actionRoutes(ctx);
const { updateDismiss, limit, setting, guidance, checks, helper, proposals, proposalsUndo, helperAdd, getChecks, getSettings } =
  settingRoutes(ctx);

const server = http.createServer(async (req, res) => {
  try {
    // DNS rebinding: a foreign page that points its name to 127.0.0.1 sends its own Host.
    if (!VALID_HOSTS.has(String(req.headers.host ?? '')))
      return send(res, 421, 'text/plain; charset=utf-8', 'Wrong host.');
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const filePath = url.pathname;

    // `ravenseat board open` (openRunningBoard): open the board in the browser again. No key, since the caller must never
    // get it; the answer never carries it either. A browser always sends Origin on a POST, so a call with one is a web
    // page and refused (a page must not be able to pop tabs), and one call per 2 s at most.
    if (filePath === '/open') {
      if (req.method !== 'POST') return json(res, 405, { ok: false, message: 'POST only' });
      if (req.headers.origin != null)
        return json(res, 403, { ok: false, message: `only from the command line: ${require('./lib/projectRoot.js').cliCommand()} board open` });
      if (Date.now() - lastOpen < 2000) return json(res, 429, { ok: false, message: 'opened a moment ago; try again in a few seconds' });
      lastOpen = Date.now();
      let b = {};
      try {
        b = JSON.parse((await readBody(req)) || '{}') ?? {};
      } catch {
        /* no body: the board itself */
      }
      // --task <id> (J14 follow-up): the J2 deep link after the key, '#key=…&view=flat&task=<id>'. The page takes the key
      // out of the address at once and keeps the rest (board/api.js getKey), so the key never stays in the address.
      const task = typeof b?.task === 'string' ? b.task : null;
      let route = '';
      if (b?.task != null) {
        if (!task || !OPEN_TASK.test(task)) return json(res, 400, { ok: false, message: 'not a task id' });
        let ids = [];
        try {
          ids = (JSON.parse(fs.readFileSync(FILE, 'utf8')).tasks ?? []).map((o) => o?.id);
        } catch {
          /* no queue file: no task either */
        }
        if (!ids.includes(task)) return json(res, 404, { ok: false, message: `There is no task ${task} in the queue.` });
        route = `view=flat&task=${encodeURIComponent(task)}`;
        // --no-open: only the link without the key, for the owner to paste into the board's tab (which keeps its key).
        if (b.open === false)
          return json(res, 200, { ok: true, message: `The card: ${plainLink(`/#${route}`)} (paste it into the board's tab; no browser opened)` });
      }
      const page = !route && b?.follow === true && FEATURES.follow ? '/follow' : '/';
      const opened = route ? `Opened the board on ${task} in your browser.` : 'Opened the board in your browser.';
      // Scripted (--key-file): the link goes to the file again, no browser.
      if (KEY_FILE) {
        writeKeyFile(route);
        return json(res, 200, { ok: true, message: 'Wrote the link to the key file again (--key-file); no browser opened.' });
      }
      if (process.env.VITEST) return json(res, 200, { ok: true, message: 'Under a test runner: no browser opened.' });
      const r = await openBrowser(`${keyLink(page)}${route ? `&${route}` : ''}`);
      // A failed open prints the card's link without the key, so the owner can still get there from the board's tab.
      const failed = () => `${openFailedLine(r.error)}${route ? ` The card: ${plainLink(`/#${route}`)}` : ''}`;
      return json(res, r.ok ? 200 : 500, { ok: r.ok, message: r.ok ? opened : failed() });
    }

    if (!filePath.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD')
        return send(res, 405, 'text/plain; charset=utf-8', 'GET only.');
      if (filePath === '/theme.css')
        return send(res, 200, 'text/css; charset=utf-8', THEME_CSS, { 'Cache-Control': 'no-cache' });
      // Follow up: the read view (the shell without data; the data is fetched from /api/follow behind the key).
      if (FOLLOW_PAGE[filePath] && FEATURES.follow) {
        const [type, body] = FOLLOW_PAGE[filePath];
        return send(res, 200, type, body(ctx), { 'Cache-Control': 'no-cache' });
      }
      if (STATIC[filePath]) {
        const [file, type] = STATIC[filePath];
        const body =
          file === 'index.html' ? readIndex() : fs.readFileSync(path.join(CLIENT, file));
        return send(res, 200, type, body, { 'Cache-Control': 'no-cache' });
      }
      // The logo: without a key (an <img> cannot send the header), but only on a valid Host (checked above). An SVG gets
      // its own strict CSP, so it can never run script.
      if (filePath === '/logo') {
        const logo = findLogo();
        if (!logo) return send(res, 404, 'text/plain; charset=utf-8', 'No logo.');
        return send(res, 200, logo.type, fs.readFileSync(logo.path), {
          'Cache-Control': 'no-cache',
          ...(logo.type === 'image/svg+xml'
            ? { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" }
            : {}),
        });
      }
      // The mascot's phrases: like /logo without a key, but only on a valid Host (checked above). Only text, no numbers
      // from the queue (they are in /api/state behind the key). An invalid file gives the default set and a log line.
      // With mode off there is nothing to say.
      if (filePath === '/mascot')
        return send(
          res,
          200,
          'application/json; charset=utf-8',
          JSON.stringify({
            mode: MASCOT_MODE,
            phrases: MASCOT_MODE === 'off' ? null : mascotPhrases(),
          }),
          { 'Cache-Control': 'no-store' },
        );
      return send(res, 404, 'text/plain; charset=utf-8', 'Does not exist.');
    }

    if (!correctKey(req))
      return json(res, 401, {
        ok: false,
        message: `The key is missing or old. Open the board again with ${require('./lib/projectRoot.js').cliCommand()} board open.`,
      });

    // Demo mode (lib/demoMode.js refusal): every read that would run gates, git, the network or a start is refused here,
    // before any handler, with "Not in demo mode" (409). The allow-list is the module's; anything not on it is refused.
    if (demoOn && req.method !== 'POST') {
      const no = DEMO.refusal(req.method === 'HEAD' ? 'GET' : req.method, filePath);
      if (no) return json(res, no.status, no.answer);
    }

    // The read routes: each GET /api/ path and its handler in queue-board/api/.
    if (req.method === 'GET' && filePath === '/api/state') return await getState(req, res, url);
    if (req.method === 'GET' && filePath === '/api/follow' && FEATURES.follow) return await getFollow(req, res, url);
    if (req.method === 'GET' && filePath === '/api/since') return await getSince(req, res, url);
    if (req.method === 'GET' && filePath === '/api/schedule') return await getSchedule(req, res, url);
    if (req.method === 'GET' && filePath === '/api/statistics') return await getStatistics(req, res, url);
    if (req.method === 'GET' && filePath === '/api/plans') return await getPlans(req, res, url);
    if (req.method === 'GET' && filePath === '/api/plan-search') return await getPlanSearch(req, res, url);
    if (req.method === 'GET' && filePath === '/api/doc') return await getDoc(req, res, url);
    if (req.method === 'GET' && filePath === '/api/plan-check') return await getPlanCheck(req, res, url);
    if (req.method === 'GET' && filePath === '/api/checks') return await getChecks(req, res, url);
    if (req.method === 'GET' && filePath === '/api/settings') return await getSettings(req, res, url);
    if (req.method === 'GET' && filePath === '/api/task') return await getTask(req, res, url);
    if (req.method === 'GET' && filePath === '/api/archive') return await getArchive(req, res, url);
    if (req.method === 'GET' && filePath === '/api/cloudPackage') return await getCloudPackage(req, res, url);
    if (req.method === 'GET' && filePath === '/api/cloud-bundles') return await getCloudBundles(req, res, url);

    if (req.method !== 'POST') return json(res, 405, { ok: false, message: 'unknown method' });
    // A write call must come from the board itself: Origin and a JSON body. A browser always sends Origin on a POST, so
    // a write without one is a script (curl, node fetch), refused while the key is hidden (board.hideKey): the key
    // alone is not taken as the owner's word. With hideKey false a script without Origin is let through, as before.
    const origin = req.headers.origin;
    if (origin == null && HIDE_KEY)
      return json(res, 403, { ok: false, message: 'a write needs the Origin of the board (the board in a browser sends it)' });
    if (origin != null && !VALID_ORIGIN.has(String(origin)))
      return json(res, 403, { ok: false, message: 'foreign origin' });
    if (!String(req.headers['content-type'] ?? '').startsWith('application/json'))
      return json(res, 415, { ok: false, message: 'application/json only' });
    let b;
    try {
      b = JSON.parse((await readBody(req, filePath === '/api/focus' ? FOCUS_BODY_MAX : BODY_MAX)) || '{}');
    } catch {
      return json(res, 400, { ok: false, message: 'invalid JSON' });
    }
    if (!b || typeof b !== 'object' || Array.isArray(b))
      return json(res, 400, { ok: false, message: 'invalid body' });
    const r = await oneAtATime(() => writeOrDemo(filePath, b));
    return json(res, r.status, r.answer);
  } catch (e) {
    return json(res, 500, { ok: false, message: `internal error (${e?.message ?? e})` });
  }
});

server.on('error', (e) => {
  console.error(
    e?.code === 'EADDRINUSE'
      ? `Port ${PORT} is in use. If a board already runs there, ${require('./lib/projectRoot.js').cliCommand()} board open ` +
          'opens it; otherwise pick another port with --port <nr>.'
      : `Board stopped: ${e?.message ?? e}`,
  );
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  if (!fs.existsSync(FILE)) console.log(`WARNING: could not find the queue ${FILE}.`);
  console.log(`Kanban board for the work queue is running (only on this machine).`);
  const cli = require('./lib/projectRoot.js').cliCommand();
  if (KEY_FILE) writeKeyFile();
  if (!HIDE_KEY) {
    // board.hideKey false (a weakened guard): the link with the key, as before 0l bolk 5.
    console.log(`Open: ${keyLink()}`);
    if (FEATURES.follow) console.log(`Follow up: ${keyLink('/follow')}`);
  } else {
    // The key is never printed: this output is what Claude reads when it starts the board.
    const how = KEY_FILE ? 'the link with the key is in the --key-file file' : `it opens in your browser; ${cli} board open opens it again`;
    console.log(`Open: ${plainLink()} (${how})`);
    if (FEATURES.follow) console.log(`Follow up: ${plainLink('/follow')} (${cli} board open --follow)`);
    // --no-open, and never under a test runner (VITEST): a forgotten --key-file in a test must not pop browser tabs.
    if (!KEY_FILE && !a.includes('--no-open') && !process.env.VITEST)
      openBrowser(keyLink())
        .then((r) => console.log(r.ok ? 'Opened the board in your browser.' : openFailedLine(r.error)))
        .catch(() => {});
  }
  console.log(`Queue: ${FILE}. Ctrl+C stops the board.`);
  // The update check: once now and then once a day (the cache keeps it to one fetch per 24 hours, also across restarts).
  refreshLatest().catch(() => {});
  setInterval(() => refreshLatest().catch(() => {}), U.MAX_AGE_MS).unref();
  // S9: the periodic machine sample (metrics.machineSampleMin, 0 = off by default). The setting is read once a minute,
  // so the gear turns it on or off without a restart; a sample is one `load` row with command "sample".
  try {
    const MSAMPLE = require('./lib/machineSample.js');
    MSAMPLE.startMachineSample({
      minutes: () => MSAMPLE.minutesFrom(KK.config({ fresh: true })),
      append: (row) => require('./lib/timeLogRows.js').appendRows(TIME_LOG, row),
      running: () => (JSON.parse(fs.readFileSync(FILE, 'utf8')).tasks ?? []).filter((o) => o?.status === 'running').length,
    });
  } catch (e) {
    console.error(`the machine sample could not start: ${e?.message ?? e}`); // measurement only, the board runs on
  }
});
