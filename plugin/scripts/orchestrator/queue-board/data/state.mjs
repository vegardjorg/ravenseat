// =============================================================
// queue-board/data/state.mjs: the board's state, the data of GET /api/state (server only, never served).
//
// state() builds what the board draws (queueBoard.board on the queue, plus the mascot, the update banner, the base
// health, the push batch, the checks overview and marker, the switches and the "Not building" catalog), cached on a key
// of everything it reads, so a poll is cheap. Also here: the Checks report (`queue.mjs checks --json`, also GET
// /api/checks), the sensitive zones per task, and missionFor (the mission text, with the same link guard as /api/doc).
//
// Moved out of queue-board.mjs unchanged (SPLIT-1b). stateData(ctx) builds the functions once; the caches live in its
// closure. clearQuick() drops the state cache after a write, clearChecksReport() the Checks report, resetState() all of
// them (demo mode). The live paths and ctx.demoOn are getters on ctx; the other builders are reached through ctx.
//
// Used by: queue-board.mjs (builds ctx; write() and demo mode clear the cache), queue-board/api/ (views.mjs, tasks.mjs,
// settings.mjs, actions.mjs) and queue-board/data/statistics.mjs (sinceData counts the inbox).
// Tested in: lib/__tests__/queueBoardState.test.ts, queueBoardFeatures.test.ts, queueBoardDemo.test.ts and
// __tests__/redteam/rt23-board-guard.test.ts (the mission path guard).
// =============================================================
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const CS = require('../../lib/cloudSetup.js');
const T = require('../../lib/queueBoard.js');
const L = require('../../lib/queueLogic.js');
const S = require('../../lib/queueStatistics.js');
const KK = require('../../lib/queueConfig.js');
const M = require('../../lib/queueMascot.js');
const KAP = require('../../lib/queueCapacity.js');
const OW = require('../../lib/ownerWait.js');
const CATALOG = require('../../lib/catalog.js');
const NOT_BUILDING = require('../../lib/notBuilding.js');
const ZONES = require('../../lib/catalogZones.js');
const DOOR = require('../../lib/doorShow.js');

/** stateData(ctx): the builders bound to the server's context, with their caches in this closure. */
export function stateData(ctx) {
  const { CONFIG, FEATURES, MAIN_TREE, ROOT, BASE, TITLE, MASCOT_MODE, MASCOT_FILE } = ctx;

  /**
   * The accepted zones per task for the board (PG-5), or null when zones.detect is off or no zone exists. The board reads
   * no mission files: the inline mission and the description stand in for the mission text.
   */
  function zonesNow(fresh) {
    if (ctx.demoOn) return null; // the demo has no catalog, and the real one is never read for it
    const zf = ZONES.zonesOnDisk({ root: MAIN_TREE, dataFolder: ctx.FOLDER, cfg: fresh });
    if (zf.empty) return null;
    return (o) => {
      const inline = typeof o.mission === 'string' && !/\.md$/i.test(o.mission.trim()) ? o.mission : '';
      return zf(o, { missionText: [inline, o.description ?? ''].filter(Boolean).join('\n') });
    };
  }

  /** The summary the mascot fills its placeholders from (queueMascot.numbers). null on error (the mascot skips numbers). */
  function mascotNumbers(queue) {
    try {
      const events = ctx.usage();
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

  // ---- The checks overview (`queue.mjs kickstart --json`, lib/kickstart.js) --------------------------------------------
  // It reads git and the files, so it runs in the background at most once a minute, and the board shows the last answer.
  let checksCache = { time: 0, data: null, running: false };
  function checksNow() {
    if (ctx.demoOn) return null; // kickstart reads the repo: never in the demo
    if (!checksCache.running && Date.now() - checksCache.time > 60_000) {
      checksCache.running = true;
      ctx.queueMjs(['kickstart', '--json']).then((r) => {
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
    if (ctx.demoOn) return { key: 'demo', list: [], groups: [] };
    try {
      const dir = path.join(MAIN_TREE, ...CATALOG.DIR.split('/'));
      const ledgerFile = path.join(ctx.FOLDER, CATALOG.LEDGER_FILE);
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
      return require('../../lib/guidance.js').checksPanelOn(JSON.parse(fs.readFileSync(ctx.FILE, 'utf8')));
    } catch {
      return true;
    }
  }

  // ---- The Checks tab (`queue.mjs checks --json`, lib/checksCatalog.js) ---------------------------------------------------
  // Runs when the tab asks, at most once a minute unless the tab asks for a fresh one (Read again, after a write).
  let checksReport = { time: 0, report: null };
  async function checksReportNow(fresh) {
    if (!fresh && checksReport.report && Date.now() - checksReport.time < 60_000) return { ok: true, report: checksReport.report };
    const r = await ctx.queueMjs(['checks', '--json']);
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
    if (!panelOn || ctx.demoOn) return false; // no background checks run in the demo
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
    const mtime = fs.statSync(ctx.FILE).mtimeMs;
    const g = ctx.uncommitted();
    const logo = ctx.findLogo() != null;
    const mascotFile = MASCOT_MODE !== 'off' && ctx.isFile(MASCOT_FILE);
    // With a daily quota, "Next up" needs today's usage (the time log, via the cached statistics).
    const stat = quick?.budget ? ctx.statistics().version : null;
    const update = ctx.updateNotice();
    const updateKey = JSON.stringify(update);
    // The base health: the file's time and the base tip (read with git status, at most once a minute) are in the key.
    const baseHealth = ctx.baseHealthNow();
    const pushBatch = ctx.pushBatchNow(baseHealth);
    // The Checks tab's switch (lib/guidance.js checksPanelOn: its own setting, otherwise the guidance). Off: no overview, so
    // the status line and the first-run card have nothing to say.
    const checksPanel = checksPanelNow();
    const checks = checksPanel ? checksNow() : null;
    const checksMarker = checksMarkerNow(checksPanel);
    const baseKey = JSON.stringify([baseHealth, pushBatch, checks, checksPanel, checksMarker]);
    // Is a `ravenseat wait` listening (its heartbeat is fresh)? Read every time, so the line flips without a queue change.
    const listening = OW.heartbeatState(ctx.FOLDER).listening;
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
    const queue = DOOR.hideStored(JSON.parse(fs.readFileSync(ctx.FILE, 'utf8')), fresh);
    const branches = {};
    for (const o of queue.tasks ?? []) {
      if (o.status !== 'picked') continue;
      const branch = ctx.branchFor(o);
      branches[branch] = ctx.branchInfo(branch);
    }
    const budget = queue.limits?.dailyBudget != null;
    const s = budget ? ctx.statistics() : null;
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
        branchPrefix: ctx.BRANCH_PREFIX,
        // Aging work against p85 for the class (only from queue.json).
        ageLimits: S.ageBounds(queue),
        // SILENT tracks (the badge on the card; cached 60 s).
        silent: ctx.silentNow(queue),
        // SPINNING tracks (a Decisions card after an hour; cached 60 s, as the silent ones).
        spinning: ctx.spinningNow(queue, ctx.silentNow(queue)),
        // "reviews k/n" on a card in Review: the merge gate's verdict (cached on the agents and the receive).
        reviews: ctx.reviewsNow(queue),
        withoutAgent: ctx.withoutAgentNow(queue),
        // Tracks that stand still on a permission prompt (not cached: one small file, and the card should go at once).
        approval: ctx.approvalNow(queue),
        // Tracks that auto mode refused, or that fail the same tool again and again (one small file, not cached either).
        toolTrouble: ctx.toolTroubleNow(queue),
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
      forecast: ctx.boardForecast(showQueue),
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
    if (s && !s.includes('\n') && !ctx.demoOn) {
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

  return {
    checksReportNow,
    state,
    missionFor,
    /** The state is built again on the next poll (after a write). */
    clearQuick() {
      quick = null;
    },
    /** The Checks tab's report is read again on its next fetch. */
    clearChecksReport() {
      checksReport = { time: 0, report: null };
    },
    /** Every cache of this module back to its start value (demo mode switched the paths behind them). */
    resetState() {
      checksCache = { time: 0, data: null, running: false };
      notBuildingCache = { key: null, list: [] };
      checksReport = { time: 0, report: null };
      quick = null;
    },
  };
}
