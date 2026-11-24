// =============================================================
// queue-board/data/statistics.mjs: the time log and what is computed from it (server only, never served).
//
// The time log rows (read again only when the log or its archives change), the Statistics tab (statistics(): the
// figures, the reworked sections, blockers, guard decisions, forecast and flow), the usage for the quota, a card's
// History (/api/task), the Timeline (scheduleData, scheduleCaps, planEffectOf for a drop's preview) and "Since you
// left" (sinceData).
//
// Moved out of queue-board.mjs unchanged (SPLIT-1b). statisticsData(ctx) builds the functions once; the caches live in its
// closure and resetStatistics() puts them back to their start values (demo mode). The live paths and ctx.demoOn are
// getters on ctx; the git reads and the state are reached through ctx.
//
// Used by: queue-board.mjs (builds ctx), queue-board/api/ (views.mjs, tasks.mjs, settings.mjs) and queue-board/data/
// (state.mjs: usage, statistics, boardForecast; plans.mjs: archiveMtime).
// Tested in: lib/__tests__/queueBoardMetrics.test.ts, queueBoardState.test.ts, queueBoardTimelineDrag.test.ts and the
// other tests that start the board server.
// =============================================================
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const T = require('../../lib/queueBoard.js');
const L = require('../../lib/queueLogic.js');
const S = require('../../lib/queueStatistics.js');
const SX = require('../../lib/statisticsSections.js');
const FL = require('../../lib/findingLog.js');
const RL = require('../../lib/rateLimits.js');
const TK = require('../../lib/timeCost.js');
const ER = require('../../lib/eventRows.js');
const GL = require('../../lib/guardLog.js');
const ES = require('../../lib/eventStatistics.js');
const P = require('../../lib/queuePlan.js');
const KK = require('../../lib/queueConfig.js');
const KAP = require('../../lib/queueCapacity.js');
const DOOR = require('../../lib/doorShow.js');
const FC = require('../../lib/queueForecast.js');
const DEC = require('../../lib/queueDecisions.js');
const TA = require('../../lib/timeLogArchive.js');
const QARCH = require('../../lib/queueArchive.js');
const AWAY = require('../../lib/awaySummary.js');
const SEEN = require('../../lib/seenMark.js');
const HIST = require('../../lib/taskHistory.js');
const QT = require('../../lib/queueTimeline.js');
const SCHED = require('../../lib/queueSchedule.js');
const UNC = require('../../lib/scheduleUncertainty.js');
const LOADS = require('../../lib/loadSlots.js');

/** statisticsData(ctx): the builders bound to the server's context, with their caches in this closure. */
export function statisticsData(ctx) {
  const { ROOT, REAL } = ctx;

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
      return fs.statSync(QARCH.archiveFile(ctx.FOLDER)).mtimeMs;
    } catch {
      return 0;
    }
  };

  // The usage from the time log (night cost and the weekly quota), computed again only when the time log has changed.
  let usageCache = { key: null, list: [] };
  function usage() {
    const log = timeLogRows();
    if (usageCache.key !== log.key) usageCache = { key: log.key, list: TK.usageEvents(log.rows) };
    return usageCache.list;
  }

  // ---- The statistics: the time log is read only when it has changed, the result is cached -------------
  let logCache = { key: null, rows: [], events: [], error: null };
  function timeLogRows() {
    // The current file and the monthly archives (lib/timeLogArchive.js): the statistics read all of it, so a rotation
    // changes no number; the key changes when either does.
    const key = TA.signature(ctx.TIME_LOG);
    if (key === 'missing') return { key: 'missing', rows: [], events: [], error: 'ENOENT' };
    if (logCache.key !== key) {
      // Only the "done" rows are needed (usage and context); the gate rows (most of them) are dropped at once.
      let text;
      try {
        text = TA.readText(ctx.TIME_LOG);
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
      return fs.existsSync(ctx.PLAN_FILE) ? P.normalize(JSON.parse(fs.readFileSync(ctx.PLAN_FILE, 'utf8'))) : null;
    } catch {
      return null; // error-ignored: the findings are one input of the right-first-time figure
    }
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
        revertedCommits: ctx.revertedNow(),
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
  // Read once at start, in the real data folder (as before the split).
  const FINDINGS_FILE = path.join(REAL.FOLDER, 'findings.jsonl');
  const RATE_FILE = path.join(REAL.FOLDER, RL.FILE);
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
      if (require('../../lib/planPostCheck.js').postCheckSetup(fresh).on) {
        const reg = flowPlans();
        const readDoc = (p) => {
          const r = T.readDocument(ctx.SOURCE_ROOT, p, { fs, path });
          return r.ok ? r.text : null;
        };
        if (reg?.entries?.length)
          postCheck = { entries: reg.entries, measureFor: (e) => require('../../lib/planPostCheck.js').decisionMeasure(e, readDoc) };
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
      out.settings = { machineSampleMin: require('../../lib/machineSample.js').minutesFrom(fresh) };
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
    const extra = [ctx.PLAN_FILE, RATE_FILE, FINDINGS_FILE, ...COMPACT_FILES.map((f) => f[1])].map(mtimeOf).join('|');
    const key = `${log.key}|${fs.statSync(ctx.FILE).mtimeMs}|${archiveMtime()}|${extra}|${TK.dayFor(new Date().toISOString())}`;
    if (statCache?.key === key) return statCache;
    // With the archived tasks, so no figure changes when a task moves to the archive.
    const queue = QARCH.withArchive(JSON.parse(fs.readFileSync(ctx.FILE, 'utf8')), ctx.FOLDER);
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
      const st = fs.statSync(ctx.FILE);
      stamp = `${st.mtimeMs}:${st.size}`;
    } catch {
      /* no queue file: read below fails with its own error */
    }
    const now = Date.now();
    const key = QT.cacheKey({ queueStamp: stamp, settings, now });
    if (scheduleCache.key === key) return scheduleCache.data;
    const queue = JSON.parse(fs.readFileSync(ctx.FILE, 'utf8'));
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
    const seen = SEEN.readSeen(ctx.FOLDER);
    const w = AWAY.resolveWindow({ choice: choice ?? setup.window, seen, from, now });
    // Decided for you carries a delivery's door and blast radius; hidden while mergeDanger.show is off (lib/doorShow.js).
    const queue = DOOR.hideStored(QARCH.withArchive(JSON.parse(fs.readFileSync(ctx.FILE, 'utf8')), ctx.FOLDER), fresh);
    const log = timeLogRows();
    // What waits on the owner now: the same count as "Waiting on you" (null when the state could not be built).
    let waiting = null;
    try {
      waiting = ctx.state().data?.inbox?.count ?? null;
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

  return {
    historyFor,
    archiveMtime,
    usage,
    timeLogRows,
    boardForecast,
    statistics,
    scheduleData,
    planEffectOf,
    sinceData,
    /** Every cache of this module back to its start value (demo mode switched the paths behind them). */
    resetStatistics() {
      usageCache = { key: null, list: [] };
      logCache = { key: null, rows: [], events: [], error: null };
      statCache = null;
      scheduleCache = { key: null, data: null };
      bandCache = { key: null, data: null };
      backtestCache = { key: null, data: null };
    },
  };
}
