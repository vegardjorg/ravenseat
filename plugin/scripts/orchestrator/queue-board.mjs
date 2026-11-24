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
// paths (demo mode switches them), serves the static files, the logo, the mascot and /open, runs demo mode, starts the
// server, and maps every /api/ route to its handler (write() for POST, the GET lines in the server). The data the routes
// send is built in queue-board/data/ (SPLIT-1b), one module per group, each with its own caches and reset:
//   tracks.mjs      the git reads (branches, git status, base health, push batch, reverted commits) and the agent
//                   badges (silent, spinning, without an agent, waiting on approval, tool trouble, reviews k/n)
//   state.mjs       state() for GET /api/state, the Checks report, the zones per task, missionFor
//   statistics.mjs  the time log rows, statistics(), usage, a card's History, the Timeline (scheduleData,
//                   planEffectOf) and "Since you left" (sinceData)
//   plans.mjs       plans() for GET /api/plans, the plan document readers, the live update (waitOnPlans)
//   setup.mjs       the update banner, the setup panel, the tidy line, readJson
// The handlers live in queue-board/api/, one module per route group:
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
// Every data module and handler gets `ctx` (built once, just above the server) and a write also the per-call tools
// write() builds. Both folders run only on the server and are never served (STATIC is an allow list).
// =============================================================

import http from 'node:http';
import fs from 'node:fs';
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
import { tracksData } from './queue-board/data/tracks.mjs';
import { stateData } from './queue-board/data/state.mjs';
import { statisticsData } from './queue-board/data/statistics.mjs';
import { plansData } from './queue-board/data/plans.mjs';
import { setupData } from './queue-board/data/setup.mjs';

const require = createRequire(import.meta.url);
const T = require('./lib/queueBoard.js');
const KK = require('./lib/queueConfig.js');
// The mascot's rules (the same file the browser gets at /queueMascot.js).
const M = require('./lib/queueMascot.js');
// The update banner (a newer plugin version, or setup not run after an update). Served to the browser as /queueUpdate.js.
const U = require('./lib/queueUpdate.js');

const CONFIG = KK.config();
// The modules that are on (features in queue.config.json, resolved once at start): sent with the state, so the board
// hides what is off. A change in the file needs a restart of the board, like the rest of the configuration.
const FEATURES = KK.features(CONFIG);
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
// The archive of done tasks (lib/queueArchive.js, owner decision B5): the demo offer counts the real one.
const QARCH = require('./lib/queueArchive.js');

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

// ---- The colors (the neutral palette in lib/queueBoard.js) ----------------------------------------------------------
const THEME_CSS = T.themeCss(T.PALETTE);

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
      ctx.clearQuick();
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

/** Every cache back to its start value (the paths behind them have changed). Each data module resets its own. */
function resetCaches() {
  ctx.resetTracks();
  ctx.resetState();
  ctx.resetStatistics();
  ctx.resetSetup();
  resetPlanCheck();
  demoCountCache = { key: null, count: 0, archived: 0 };
  // The plan cache, and the live update off the old data folder (its waiters are answered).
  ctx.resetPlans();
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
  ctx.remakePlanReaders();
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
    ctx.clearQuick();
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

// ---- The data builders (queue-board/data/) and the route modules (queue-board/api/) ------------------------------
// ctx is what the data builders and the handlers read from this file: the live paths as getters (demo mode switches
// them, so a module reads the value of the moment, as it did when it lived here), the constants and the few helpers that
// stay here. Each data module then adds its builders to it (their caches stay in the module; planCache and planSearch
// stay getters), and writeTools.mjs the write plumbing. It is built once and copies nothing.
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
  get BASE_HEALTH_FILE() {
    return BASE_HEALTH_FILE;
  },
  get GIT_ROOT() {
    return GIT_ROOT;
  },
  get TIME_LOG() {
    return TIME_LOG;
  },
  get demoOn() {
    return demoOn;
  },
  get realConfig() {
    return realConfig;
  },
  BASE, CONFIG, DEMO_PATHS, FEATURES, HERE, MAIN_TREE, MASCOT_FILE, MASCOT_MODE, QUEUE_MJS, REAL, REMOTE, ROOT, TITLE,
  demoNow, escHtml, findLogo, isFile, json, write,
};
// tracks.mjs: git, base health, push batch, the agent badges. state.mjs: state(), the Checks report, missionFor.
// statistics.mjs: the time log, Statistics, History, Timeline, Since you left. plans.mjs: plans() and the live update.
// setup.mjs: the update banner, the setup panel, the tidy line. getOwnPropertyDescriptors keeps a getter a getter.
for (const part of [tracksData, stateData, statisticsData, plansData, setupData])
  Object.defineProperties(ctx, Object.getOwnPropertyDescriptors(part(ctx)));
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
  ctx.refreshLatest().catch(() => {});
  setInterval(() => ctx.refreshLatest().catch(() => {}), U.MAX_AGE_MS).unref();
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
