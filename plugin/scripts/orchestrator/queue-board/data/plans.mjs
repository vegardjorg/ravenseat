// =============================================================
// queue-board/data/plans.mjs: the plan register as the Plans room reads it (server only, never served).
//
// plans() is the data of GET /api/plans (queuePlanView.plansData on plans.json and the queue with its archive, the lead
// and decision section read from the plan documents), rebuilt when either file or the minute changes. waitOnPlans is the
// live update (?wait=1, fs.watch on the data folder), and planSearch the full-text search of /api/plan-search.
//
// Moved out of queue-board.mjs unchanged (SPLIT-1b). plansData(ctx) builds the functions once; the caches live in its
// closure. planCache and planSearch are getters (always the current one); remakePlanReaders() makes the document
// readers again on the live source root (demo mode), and resetPlans() drops the cache, closes the watcher and answers
// the waiting calls.
//
// Used by: queue-board.mjs (builds ctx, demo mode) and queue-board/api/ (plans.mjs, planEdits.mjs).
// Tested in: lib/__tests__/queuePlanView.test.ts, queuePlanRead.test.ts, queuePlanWork.test.ts and the other tests that
// start the board server.
// =============================================================
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const T = require('../../lib/queueBoard.js');
const L = require('../../lib/queueLogic.js');
const S = require('../../lib/queueStatistics.js');
const P = require('../../lib/queuePlan.js');
const PRIVACY = require('../../lib/queuePlanView.js');
const KK = require('../../lib/queueConfig.js');
const QARCH = require('../../lib/queueArchive.js');

/** plansData(ctx): the builders bound to the server's context, with their caches in this closure. */
export function plansData(ctx) {
  const { FEATURES } = ctx;

  // ---- The plan register: read only, rebuilt when plans.json or queue.json changes (or every minute,
  // so "stale" and "Working now" expire on their own). Writing to the register never goes via the board in this track.
  let planCache = null;
  // The lead of a plan without a summary, read from its plan document (P3 of plans/plans-tab-ux-review-2026-11-19.md;
  // queueBoard.planLeadReader: the /api/doc guard, cached per file by time and size). One reader for the process, so the
  // cache lives as long as the board.
  // `let`: demo mode makes both again on the demo folder's documents (useDemo), and back.
  let planLead = T.planLeadReader(ctx.SOURCE_ROOT, { fs, path });
  // P5: the full-text search in the plan documents (queueBoard.planDocSearcher: the same source, guard and cap as the
  // lead, passages cached per file by time and size). One searcher for the process, like the lead reader.
  let planSearch = T.planDocSearcher(ctx.SOURCE_ROOT, { fs, path });
  // PG-1/PG-3: the decision section's state for a large plan's detail panel (queueBoard.planDecisionReader: the same
  // guard, cached per file by time and size). The zones are read again with each new plans() answer, so an accepted zone
  // shows within a minute; plans.decisionNote off reads nothing (the caller passes no reader).
  const planDecisionFor = () => {
    let zonesFor = null;
    try {
      // The demo has no catalog: the real project's zones are never read for it.
      if (!ctx.demoOn) zonesFor = require('../../lib/catalogZones.js').zonesOnDisk();
    } catch {
      // error-ignored: a zone only raises attention; the size rule still applies
    }
    const read = T.planDecisionReader(ctx.SOURCE_ROOT, { fs, path }, { zonesFor });
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
    const key = `${mt(ctx.PLAN_FILE)}|${mt(ctx.FILE)}|${ctx.archiveMtime()}|${Math.floor(Date.now() / 60_000)}|${JSON.stringify(view)}`;
    if (planCache?.key === key) return planCache;
    const reg = fs.existsSync(ctx.PLAN_FILE)
      ? P.normalize(JSON.parse(fs.readFileSync(ctx.PLAN_FILE, 'utf8')))
      : P.emptyRegister();
    // With the archived tasks: a plan's status is derived from its linked tasks, so archiving one never changes it.
    const queue = fs.existsSync(ctx.FILE) ? QARCH.withArchive(JSON.parse(fs.readFileSync(ctx.FILE, 'utf8')), ctx.FOLDER) : {};
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
      exists: fs.existsSync(ctx.PLAN_FILE),
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
      planGuard = fs.watch(ctx.FOLDER, (_event, name) => {
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

  return {
    plans,
    waitOnPlans,
    get planCache() {
      return planCache;
    },
    get planSearch() {
      return planSearch;
    },
    /** The lead reader and the searcher again, on the live source root (demo mode switched it). */
    remakePlanReaders() {
      planLead = T.planLeadReader(ctx.SOURCE_ROOT, { fs, path });
      planSearch = T.planDocSearcher(ctx.SOURCE_ROOT, { fs, path });
    },
    /** The cache back to its start value, and the live update off the old data folder. */
    resetPlans() {
      planCache = null;
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
    },
  };
}
