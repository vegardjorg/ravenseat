// =============================================================
// explain.js: why one task stands where it stands (`ravenseat explain <ID>`).
//
// The answer is built from the SAME rules the queue starts by, never an own copy: blockersWithPause (dependencies,
// owner questions, file and DB conflicts, parking, paused project, focus), uncommittedCollision, startGuard (usage
// limit, daily quota, night pause, wind-down, load), selectNext (what fill would start now) and the limits in
// spaceUse (slots, D+, DB, per domain). For a running task: when it started, the round, an open block, and the last
// sign of life with its source (measured by the caller, lib/trackActivity.js), against the SILENT limit.
// No I/O here: the caller (cli/explain.mjs) reads git and the transcripts.
// =============================================================

const { blockersWithPause } = require('./ranking.js');
const { uncommittedCollision } = require('./commits.js');

/** "45 min", "2 h 5 min", "3 d 4 h". */
function ageText(ms) {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}

/**
 * Why the task stands where it stands.
 * @param {object} queue
 * @param {string} id
 * @param {{ L: object, now?: number, uncommitted?: string[], dailyUsage?: number, activity?: { ms: number|null,
 *   source: string|null } | null }} io  L = queueLogic (passed in, so this file has no cycle with it)
 * @returns {{ id: string, status: string|null, verdict: string, lines: string[] } | null} null for an unknown task
 */
function explainTask(queue, id, { L, now = Date.now(), uncommitted = [], dailyUsage, activity = null }) {
  const tasks = queue.tasks ?? [];
  const o = tasks.find((x) => x.id === id);
  if (!o) return null;
  const lines = [];
  const head = (verdict) => ({ id, status: o.status ?? null, verdict, lines });
  const since = (iso) => {
    const t = Date.parse(iso ?? '');
    return Number.isFinite(t) ? `${iso} (${ageText(now - t)} ago)` : null;
  };

  if (o.status === 'done' || o.status === 'cancelled') {
    const at = since(o.done ?? o.cancelled ?? o.changed);
    if (at) lines.push(`${o.status === 'done' ? 'Done' : 'Cancelled'} ${at}.`);
    if (o.remark) lines.push(`Remark: ${o.remark}`);
    return head(o.status === 'done' ? 'finished' : 'cancelled');
  }

  if (o.status === 'running' || o.status === 'review') {
    const at = since(o.started);
    if (at) lines.push(`Started ${at}.`);
    const rounds = (o.attempts ?? []).length;
    if (rounds > 1) lines.push(`Round ${rounds} (${rounds - 1} earlier).`);
    const b = L.openBlockOf(o);
    if (b) lines.push(`Open block: ${b.code}${b.note ? ` (${b.note})` : ''}.`);
    if (activity?.ms != null) {
      const limit = L.silentMinFor(queue);
      const quiet = now - activity.ms;
      lines.push(`Last sign of life: ${activity.source ?? '?'} ${ageText(quiet)} ago.`);
      if (o.status === 'running' && limit > 0 && quiet >= limit * 60_000)
        lines.push(`SILENT: nothing for ${ageText(quiet)}, over the ${limit} min limit (limit silentMin).`);
    } else if (o.status === 'running') lines.push('No sign of life found (no commit, track file, time log row or transcript).');
    if (o.status === 'review') return head(b ? `in review, stopped on ${b.code}` : 'in review: waits for receive, review and merge');
    if (b?.code === 'track-question') return head('running, but the track asked you and left');
    return head('running');
  }

  if (o.status !== 'waiting') {
    lines.push(`Status ${o.status}: only a waiting task can be started.`);
    if (o.status === 'proposed') lines.push(`It needs the owner's approval first: ravenseat approve ${id}.`);
    return head(o.status);
  }

  // Waiting: the same checks selectNext makes, in its order.
  const why = blockersWithPause(o, queue);
  for (const w of why) lines.push(`Blocked: ${w}.`);
  const hit = uncommittedCollision(o, uncommitted);
  if (hit) lines.push(`Blocked: ${hit.path} is uncommitted in the main tree and the task owns ${hit.file}.`);
  // Read ownership in "warn" mode is no blocker, but the overlap is named (in "wait" mode it is a blocker above).
  const RC = require('./conflicts.js');
  if (RC.readsMode() === 'warn')
    for (const r of RC.readsOverlaps(o, tasks)) lines.push(`Reads: ${r.text} (reads.mode warn: it starts anyway).`);
  if (why.length || hit) return head('blocked');

  const guard = L.startGuard(queue, dailyUsage, { now });
  if (guard) lines.push(`The queue starts nothing now: ${guard.summary ?? guard.message ?? guard.stop}.`);

  const next = L.selectNext(queue, now, { uncommitted });
  if (next.some((x) => x.id === id)) {
    lines.push(guard ? 'Without that stop it is among the ones fill starts now.' : 'It is among the ones fill starts now.');
    return head(guard ? `ready, held by ${guard.stop}` : 'ready: starts at the next fill');
  }
  // Not selected: the limits, and the place among the ones that wait for a slot.
  const use = L.spaceUse(queue);
  const g = use.limits;
  if (use.available <= 0) lines.push(`All ${g.maxConcurrent} slots are taken (limit maxConcurrent).`);
  if (o.class === 'D+' && use.dPlus >= g.maxDPlus) lines.push(`${use.dPlus} D+ task(s) run already (limit maxDPlus ${g.maxDPlus}).`);
  if (L.hasMigr(o) && use.db >= g.maxDb) lines.push(`${use.db} task(s) with migrations run already (limit maxDb ${g.maxDb}).`);
  if ((use.perDomain.get(o.domain) ?? 0) >= g.maxPerDomain)
    lines.push(`${use.perDomain.get(o.domain)} task(s) in the domain ${o.domain} run already (limit maxPerDomain ${g.maxPerDomain}).`);
  // Its place: what selectNext would start with every slot free.
  const wide = L.selectNext({ ...queue, limits: { ...g, maxConcurrent: tasks.length + 1 } }, now, { uncommitted });
  const place = wide.findIndex((x) => x.id === id);
  if (place >= 0) lines.push(`Place ${place + 1} of ${wide.length} among the tasks that could start (by focus stage, then score).`);
  else lines.push('A task picked ahead of it in the same round conflicts with it (files or DB objects).');
  return head(guard ? `waiting, and held by ${guard.stop}` : 'waiting for a slot');
}

module.exports = { explainTask };
