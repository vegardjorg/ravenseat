// =============================================================
// gateQueueView.js: who holds a slot of the machine queue (lib/gateQueue.js) and who waits, for `ravenseat doctor` and
// `ravenseat pulse-check` (roadmap 0s V12).
//
// Why: a run waiting for a slot printed one line to itself, but nobody else could see the queue. When a track looked stuck
// at night, the orchestrator could not tell "waits for a slot" from "hangs". This reads the same folder the queue uses and
// names each live holder (slot, what it runs, pid, age, last heartbeat) and each live waiter in the order they are served.
//
// Display only, and so no setting: it reads, it never removes a ticket or takes a slot over (readLine prune false), it
// never changes an exit code, and doctor shows it as INFO (never WARN or FAIL). Nothing is shown when nothing is held or
// waited for, or when the queue is off.
//
// Pure apart from snapshot(), which reads the folder. Tested in lib/__tests__/gateQueueView.test.ts.
// =============================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const GQ = require('./gateQueue.js');
const { pidAlive } = require('./mergeLock.js');

/** How much of a heavy command a line shows (the command is the agent's own text; a line stays a line). */
const COMMAND_CHARS = 60;

const minutes = (ms) => (Number.isFinite(ms) ? Math.max(0, Math.round(ms / 60_000)) : null);

/**
 * The live holders and waiters of the queue at `root`. Never throws: a folder that cannot be read is an empty queue.
 * @param {{ root: string, slots: number, now?: number, alive?: (pid: number) => boolean, agingMin?: number }} x
 * @returns {{ holders: object[], waiters: object[] }}
 */
function snapshot({ root, slots, now = Date.now(), alive = pidAlive, agingMin = GQ.DEFAULTS.agingMin }) {
  const holders = [];
  const count = Number.isInteger(slots) && slots >= 1 ? slots : 1;
  for (let i = 0; i < count; i++) {
    const seen = GQ.readSlot(path.join(root, `slot-${i}`));
    if (seen.missing || !seen.holder) continue;
    if (GQ.staleReason(seen.holder, { now, alive, mtimeMs: seen.mtimeMs })) continue;
    const h = seen.holder;
    holders.push({
      slot: i + 1,
      pid: h.pid,
      project: h.project,
      kind: h.kind,
      track: h.track,
      command: h.command,
      ageMin: minutes(now - Date.parse(h.started ?? '')),
      beatAgoSec: Number(h.staleSec) > 0 ? Math.max(0, Math.round((now - seen.mtimeMs) / 1000)) : null,
    });
  }
  let tickets = [];
  try {
    if (fs.existsSync(path.join(root, 'waiting'))) tickets = GQ.readLine(root, { now, alive, prune: false });
  } catch {
    tickets = [];
  }
  const waiters = GQ.orderWaiters(tickets, { now, agingMs: agingMin * 60_000 }).map((t, k) => ({
    position: k + 1,
    pid: t.pid,
    project: t.project,
    kind: t.kind,
    track: t.track,
    command: t.command,
    class: t.class,
    waitMin: minutes(now - Date.parse(t.arrived ?? '')),
  }));
  return { holders, waiters };
}

/** What a holder or waiter runs: "full gates of demo (A-1)", or for `ravenseat heavy` "heavy `npm test` of demo". */
function what(x) {
  const cmd = String(x.command ?? '').replace(/\s+/g, ' ').trim();
  const shown = cmd.length > COMMAND_CHARS ? `${cmd.slice(0, COMMAND_CHARS)}…` : cmd;
  const run = x.kind === 'heavy' ? (shown ? `heavy \`${shown}\`` : 'heavy') : `${x.kind ?? '?'} gates`;
  return `${run} of ${x.project ?? '?'}${x.track ? ` (${x.track})` : ''}`;
}

function holderText(h) {
  const beat = h.beatAgoSec != null ? `, heartbeat ${h.beatAgoSec} s ago` : '';
  return `slot ${h.slot}: ${what(h)}, pid ${h.pid ?? '?'}, ${h.ageMin ?? '?'} min${beat}`;
}

function waiterText(w) {
  return `${w.position}. ${w.class ?? '?'} ${what(w)}, pid ${w.pid ?? '?'}, ${w.waitMin ?? '?'} min`;
}

/** The text both views use: the holders, then the waiters in order. null when there is nothing to show. */
function summary(snap, { slots = 1 } = {}) {
  const holders = snap?.holders ?? [];
  const waiters = snap?.waiters ?? [];
  if (!holders.length && !waiters.length) return null;
  const held = holders.length ? holders.map(holderText).join('; ') : `no slot held (${slots} at a time)`;
  const wait = waiters.length ? `waiting: ${waiters.map(waiterText).join('; ')}` : 'nobody waiting';
  return { held, wait, waiting: waiters.length };
}

/**
 * The doctor row: one INFO row with who holds and who waits, or none (nothing held or waited for, the queue off).
 * @param {{ holders: object[], waiters: object[] }} snap snapshot()
 * @param {{ enabled: boolean, slots: number }} o
 */
function doctorRows(snap, { enabled, slots = 1 } = {}) {
  if (!enabled) return [];
  const s = summary(snap, { slots });
  if (!s) return [];
  return [
    {
      status: 'INFO',
      name: 'gatequeue',
      message: `machine queue (${slots} slot${slots === 1 ? '' : 's'}): ${s.held}; ${s.wait}`,
      fix: 'display only; a slot whose process is gone or whose heartbeat stopped is taken over by the next run',
    },
  ];
}

/** The pulse check's one line, or null. Never an ACTION: waiting for a slot is the queue working. */
function pulseLine(snap, { slots = 1 } = {}) {
  const s = summary(snap, { slots });
  if (!s) return null;
  return `GATE QUEUE: ${s.held}; ${s.waiting} waiting${s.waiting ? ` (${s.wait.replace(/^waiting: /, '')})` : ''}.`;
}

module.exports = { COMMAND_CHARS, snapshot, summary, doctorRows, pulseLine };
