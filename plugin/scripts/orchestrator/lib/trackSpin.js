// =============================================================
// trackSpin.js: SPINNING, a running track that is busy without progress (roadmap 0æ N3).
//
// Why: SILENT (lib/logic/monitor.js silentTracks) fires when nothing moves at all. A track that keeps calling tools
// but only loads tools, writes to-do lists, sleeps or reads the same file again keeps its transcript fresh, so it is
// never SILENT, while it burns tokens without progress. SPINNING is that case.
//
// The rule: the newest work is older than limits.spinMin minutes (default 15, 0 = off), while the agent still made at
// least MIN_EMPTY_CALLS calls in that time (so it is busy, not silent). Work is a tool call the client adapter calls
// work (lib/clients/claude/work.js: writing, editing, running commands or tests), the FIRST read of a file or command,
// or a commit on the branch. Bookkeeping, waiting and a repeated read are not work. The start time counts as work, so a
// new track always gets the whole limit. A SILENT or delivered track is not SPINNING (SILENT says more).
//
// Shown from the start: a line in show, the orchestrator pulse and the pulse check. After SPIN_CARD_MIN (60, the same
// time as SILENT) it is also a card in decide and the board's Decisions. Never an automatic stop.
//
// The pure part (spinOf, spinningTracks, spinLines) has no I/O; measure() reads the transcript tail for the callers.
// Tested in lib/__tests__/trackSpin.test.ts.
// =============================================================
'use strict';

const SPIN_DEFAULT_MIN = 15;
/** How long a track spins before it becomes a decision card (as SILENT_CARD_MIN). */
const SPIN_CARD_MIN = 60;
/** At least this many calls without work inside the window: fewer is quiet, which SILENT judges. */
const MIN_EMPTY_CALLS = 3;
/** The bytes read from the end of a transcript. */
const TAIL_BYTES = 512 * 1024;

/** limits.spinMin, otherwise the default; 0 turns it off. */
function spinMinFor(queue) {
  const raw = queue?.limits?.spinMin;
  const v = Number(raw);
  return raw != null && Number.isFinite(v) && v >= 0 ? v : SPIN_DEFAULT_MIN;
}

/**
 * The newest work and the calls without work after it, from a transcript's events (the adapter's entries).
 * `classify` is the adapter's callKind. Reads repeat per key across the whole tail read.
 * @returns {{ lastWorkMs: number|null, emptyAfter: number, lastCallMs: number|null }}
 */
function spinOf(events, { classify }) {
  const seen = new Set();
  let lastWorkMs = null;
  let lastCallMs = null;
  let emptyAfter = 0;
  for (const e of events ?? []) {
    if (!Number.isFinite(e?.at)) continue;
    for (const t of e.tools ?? []) {
      let k;
      try {
        k = classify(t);
      } catch {
        k = { kind: 'work' }; // error-ignored: an unknown call counts as work (never a false SPINNING)
      }
      lastCallMs = e.at;
      const work = k.kind === 'work' || (k.kind === 'read' && !seen.has(k.key));
      if (k.kind === 'read') seen.add(k.key);
      if (work) {
        lastWorkMs = e.at;
        emptyAfter = 0;
      } else emptyAfter++;
    }
  }
  return { lastWorkMs, emptyAfter, lastCallMs };
}

/**
 * The SPINNING tracks. `measures` maps id -> spinOf's result (missing = not measured), `lastCommit` id -> ms,
 * `skip` the ids that are SILENT or delivered.
 * @returns {{ id: string, branch: string, spinning_ms: number, empty_calls: number, last_work: string }[]}
 */
function spinningTracks(queue, { candidates, measures = {}, lastCommit = {}, skip = new Set(), now = Date.now(), limitMin } = {}) {
  const limit = limitMin ?? spinMinFor(queue);
  if (!(limit > 0)) return [];
  const out = [];
  for (const o of candidates ?? []) {
    const m = measures[o.id];
    if (!m || skip.has(o.id)) continue;
    const started = Date.parse(o.attempts?.at(-1)?.reserved ?? o.started ?? '');
    const last = Math.max(
      ...[m.lastWorkMs, lastCommit[o.id], started].map(Number).filter(Number.isFinite),
      -Infinity,
    );
    if (!Number.isFinite(last) || now - last < limit * 60_000) continue;
    // Busy: calls without work since then, and the newest one inside the window (otherwise it is quiet, not spinning).
    if (m.emptyAfter < MIN_EMPTY_CALLS || !(m.lastCallMs >= now - limit * 60_000)) continue;
    out.push({ id: o.id, branch: o.branch, spinning_ms: now - last, empty_calls: m.emptyAfter, last_work: new Date(last).toISOString() });
  }
  return out;
}

const minutes = (ms) => `${Math.round(ms / 60_000)} min`;

/** The lines for show and the pulse. Empty when all is well. */
function spinLines(list, { cli = 'ravenseat' } = {}) {
  if (!list?.length) return [];
  return [
    `SPINNING (${list.length}): the agent is busy, but its calls are only bookkeeping, waiting or repeated reads, with no ` +
      `write, command or commit for a while. Nothing is stopped. For each: look at its transcript (${cli} explain <id>); ` +
      `if it is stuck, ${cli} resume <id> --reason context, or stop it (${cli} set <id> waiting).`,
    ...list.map((x) => `  ${x.id}  ${x.branch}  no work for ${minutes(x.spinning_ms)}, ${x.empty_calls} empty call(s) since`),
  ];
}

/**
 * Reads one transcript's tail and measures it (the I/O for the callers). Null when it cannot be read.
 * @param {string} file
 */
function measure(file) {
  try {
    const client = require('./clients/index.js').clientFor();
    if (!client.work?.callKind) return null;
    const tail = client.transcripts.readTail(file, TAIL_BYTES);
    if (!tail?.text) return null;
    const E = client.entries;
    const events = [];
    for (const line of tail.text.split('\n')) {
      if (!line.trim()) continue;
      const raw = E.parse(line);
      if (raw && typeof raw === 'object') events.push(E.entry(raw));
    }
    return spinOf(events, { classify: client.work.callKind });
  } catch {
    return null; // error-ignored: a measure that fails shows nothing, never a false SPINNING
  }
}

module.exports = { SPIN_DEFAULT_MIN, SPIN_CARD_MIN, MIN_EMPTY_CALLS, spinMinFor, spinOf, spinningTracks, spinLines, measure };
