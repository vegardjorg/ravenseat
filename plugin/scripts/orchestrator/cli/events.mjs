// =============================================================
// cli/events.mjs: the thin I/O for the flow, load and push rows (lib/eventRows.js) the commands append to the time
// log, and the reads the views need (the session state, the subagents per session).
//
// Every function here is fail open: an error is swallowed and the command goes on exactly as without the row. The
// rows are measurement only (ravenseat cost, ravenseat limit, the board's Statistics tab).
//
// Used by: cli/run.mjs (fill, start, resume), cli/merge.mjs (merge), cli/baseHealth.mjs (recordVerdict),
//   cli/triage.mjs (triage --verdict), cli/cost.mjs (cost, limit).
// Tested in: __tests__/eventRowsCli.test.ts, lib/__tests__/eventRows.test.ts.
// =============================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { BASE, CONFIG, FOLDER, L, MAIN_TREE, REMOTE, require, TIME_LOG, gitRead } from './context.mjs';

const ER = require('./lib/eventRows.js');
const TL = require('./lib/timeLogRows.js');

/** Appends one or more rows. Never throws. */
export function logEvent(rows) {
  try {
    return TL.appendRows(TIME_LOG, rows);
  } catch {
    return false; // error-ignored: measurement only
  }
}

/**
 * The load row for `fill` or `start`: what was measured, the slots the adaptive rule allows against maxConcurrent,
 * the running tracks, and the load guard's stop (exit 7) when it stops. `load` null = --over-load / --force (nothing
 * measured, logged with override: true). Written BEFORE the guard can stop the command, so a stop is recorded too.
 */
export function logLoad({ command, queue, load }) {
  try {
    const running = (queue?.tasks ?? []).filter((o) => o.status === 'running').length;
    const slots = L.loadSlotsFor(queue, load);
    const guard = load ? L.loadGuard(queue, load) : null;
    logEvent(ER.loadRow({ command, load, slots, guard, running, override: !load }));
  } catch {
    // error-ignored: measurement only
  }
}

/** The file that remembers the newest push entry seen (ms) and its tips, so each push is logged once. */
const PUSH_SEEN = path.join(FOLDER, 'push-seen.json');
/** A first run (no state yet) logs the pushes in the reflog from this far back, at most PUSH_BACKFILL_MAX. */
const PUSH_BACKFILL_MS = 28 * 86_400_000;
const PUSH_BACKFILL_MAX = 100;

/**
 * Logs the pushes of the base branch made since the last check (lib/eventRows.js pushesFromReflog: the reflog of
 * refs/remotes/<remote>/<base>, entries "update by push"). One git call when nothing is new; per new push the batch
 * (pushBatch.readBatch on from..tip) and the base health of the pushed tip. Returns the number logged.
 */
export function detectPushes({ now = Date.now() } = {}) {
  try {
    const ref = `refs/remotes/${REMOTE}/${BASE}`;
    const out = gitRead(['reflog', 'show', '--date=unix', `--format=${ER.REFLOG_FORMAT}`, ref, '--']);
    if (out == null) return 0;
    let seen = null;
    try {
      seen = JSON.parse(fs.readFileSync(PUSH_SEEN, 'utf8'));
    } catch {
      seen = null;
    }
    // The reflog has whole seconds, so the state is the newest push entry's time and the tips at that second (not the
    // time of the check): a push in the same second as the last check is still found, and none is logged twice.
    const entries = ER.parseReflog(out);
    const known = Number.isFinite(seen?.last);
    const since = known ? seen.last : now - PUSH_BACKFILL_MS;
    const tipsAt = new Set(known && Array.isArray(seen.tips) ? seen.tips : []);
    let pushes = ER.pushesFromReflog(entries, { since: since - 1 }).filter((p) => !(p.time === since && tipsAt.has(p.tip)));
    if (!known) pushes = pushes.slice(-PUSH_BACKFILL_MAX);
    const byPush = entries.filter((e) => /^update by push/.test(e.subject));
    const newest = Math.max(known ? seen.last : since, ...byPush.map((e) => e.time));
    const tips = byPush.filter((e) => e.time === newest).map((e) => e.sha);
    if (known && newest === seen.last) for (const t of tipsAt) if (!tips.includes(t)) tips.push(t);
    // The state first: two fills at once then log a push at most twice (the readers deduplicate on tip + time).
    const tmp = `${PUSH_SEEN}.${process.pid}.tmp`;
    fs.mkdirSync(FOLDER, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ last: newest, tips, checked: new Date(now).toISOString() }) + '\n');
    fs.renameSync(tmp, PUSH_SEEN);
    if (!pushes.length) return 0;
    const PB = require('./lib/pushBatch.js');
    const BH = require('./lib/baseHealth.js');
    const setup = PB.pushSetup(CONFIG);
    const state = BH.readState(path.join(FOLDER, 'base-health.json'));
    const rows = pushes.map((p) => {
      const batch = PB.readBatch(gitRead, { from: p.from, to: p.tip, prefix: CONFIG.branchPrefix });
      const health = BH.verdict(state, p.tip);
      const verdict = batch ? PB.batchVerdict({ batch, setup, health, now: p.time }).verdict : null;
      return ER.pushRow({
        time: p.time,
        detectedAt: now,
        remote: REMOTE,
        branch: BASE,
        from: p.from,
        tip: p.tip,
        batch,
        health,
        verdict,
      });
    });
    logEvent(rows);
    return rows.length;
  } catch {
    return 0; // error-ignored: measurement only
  }
}

// The agent transcripts: <projects>/<session>/subagents/agent-<agent_id>.jsonl (as cli/tracks.mjs findTranscript).
const TRANSCRIPTS =
  process.env.QUEUE_TRANSCRIPTS ??
  path.join(os.homedir(), '.claude', 'projects', MAIN_TREE.replace(/[^A-Za-z0-9]/g, '-'));

/** The subagents each session started (lib/eventStatistics.js readAgentsBySession on the transcript folders). */
export function agentsBySession(sessionIds) {
  try {
    return require('./lib/eventStatistics.js').readAgentsBySession(TRANSCRIPTS, sessionIds);
  } catch {
    return new Map(); // error-ignored: nothing subtracted
  }
}
