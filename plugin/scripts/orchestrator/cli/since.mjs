// =============================================================
// cli/since.mjs: `ravenseat since`, what happened while you were away (roadmap 3e AW-4).
//
//   ravenseat since [--window last-seen|24h|7d] [--json] [--mark] [--max <n>]
//
// Why: the morning question "what happened while I was away?" took several commands (cost, decide, the time log), and
// Claude had to read each to answer it. This is one read: the window line, four parts of one line each (Done, Stuck,
// Waiting on you, Spend; a part that could not be read says `not read: <what> -> <why>`) and the latest events, newest
// first, failures marked with x. The numbers and the events are lib/awaySummary.js, the same join as the board's
// "Since you left" band, so the terminal, the board and Claude never disagree.
//
// The window: since last seen (default; the seen mark in <dataFolder>/seen.json, lib/seenMark.js), 24h or 7d. Without a
// mark, or one older than 7 days, it shows the last 24 hours and says so. --mark sets the mark to now AFTER printing,
// so the next run starts here (the board's "Mark seen" does the same). Without --mark nothing is written.
// --json: { window, counts, events, total_events, more, empty, seen }. --max: how many events (default 20; 0 = all).
// Exit codes: 0, 2 on a usage error (nothing is written then).
//
// Used by: queue.mjs (dispatch). Tested in: __tests__/sinceFlow.test.ts.
// =============================================================

import { a, CLI, FOLDER, read, require, TIME_LOG, TK } from './context.mjs';
import { currentInbox } from './decide.mjs';

const AWAY = require('./lib/awaySummary.js');
const SEEN = require('./lib/seenMark.js');
const TA = require('./lib/timeLogArchive.js');
const QARCH = require('./lib/queueArchive.js');

const USE = 'Use: ravenseat since [--window last-seen|24h|7d] [--json] [--mark] [--max <n>]';
/** The events shown by default in the terminal. */
const MAX_DEFAULT = 20;

/** The arguments after the command word, or the reason they are wrong. */
export function parseSinceArgs(args) {
  const out = { window: null, json: false, mark: false, max: MAX_DEFAULT };
  for (let i = 0; i < args.length; i += 1) {
    const x = args[i];
    if (x === '--json') out.json = true;
    else if (x === '--mark') out.mark = true;
    else if (x === '--window' || x === '--max') {
      const v = args[i + 1];
      if (v == null || v.startsWith('--')) return { error: `${x} needs a value` };
      i += 1;
      if (x === '--window') {
        if (!AWAY.WINDOWS.includes(v)) return { error: `--window is ${AWAY.WINDOWS.join(', ')}` };
        out.window = v;
      } else {
        if (!/^\d+$/.test(v)) return { error: '--max is a whole number (0 = all)' };
        out.max = Number(v) || Infinity;
      }
    } else return { error: x.startsWith('-') ? `unknown flag ${x}` : `unexpected argument "${x}"` };
  }
  return out;
}

export function cmdSince() {
  const o = parseSinceArgs(a.slice(1));
  if (o.error) {
    console.error(`${o.error}\n${USE}`);
    process.exitCode = 2;
    return;
  }
  const now = Date.now();
  const seen = SEEN.readSeen(FOLDER);
  const w = AWAY.resolveWindow({ choice: o.window ?? 'last-seen', seen, now });
  // With the archived tasks and the time log's monthly archives (from the window's month on), so no number changes
  // when a task or a row moves to an archive.
  const queue = QARCH.withArchive(read(), FOLDER);
  let rows = [];
  try {
    rows = TK.readRows(TA.readText(TIME_LOG, { from: w.from }));
  } catch {
    rows = []; // no time log yet: the queue's own times still count
  }
  // What waits on the owner now, the same list as `ravenseat decide` and the board (null: it could not be built).
  let waiting = null;
  try {
    waiting = currentInbox(read(), { now }).count;
  } catch {
    waiting = null;
  }
  const s = AWAY.awaySummary({ queue, rows, from: w.from, to: w.to, waiting, max: o.max });
  if (o.json) console.log(JSON.stringify({ window: { ...w, text: AWAY.windowText(w) }, seen, ...s }, null, 2));
  else for (const line of AWAY.summaryLines(s, w, { ravenseat: CLI })) console.log(line);
  if (o.mark) {
    const m = SEEN.writeSeen(FOLDER, { by: 'cli', now });
    if (!o.json) console.log(m.ok ? `Seen mark set to ${AWAY.whenText(now, now)}.` : `The seen mark was not set (${m.error}).`);
  }
}
