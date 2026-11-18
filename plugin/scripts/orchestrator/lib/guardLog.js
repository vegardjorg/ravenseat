// =============================================================
// guardLog.js: the guards log what they decide (plans/ekstern-saas-vurdering-2026-11-15.md, bolk 6, measurement only).
//
// Why: an override or a denial that leaves no row cannot be measured. The owner decided to measure for two weeks how
// often the guards stop or ask before deciding on approval with presence (bolk 10), and a track that keeps hitting a
// guard is worth a look whatever the reason. So every deny and ask from the push guard (hook-push-guard.mjs), the write
// guard (hook-write-guard.mjs) and the read guard (hook-read-guard.mjs) appends one row to the time log:
//   { time, wave: "guard", track: <task id or null>, event: "guard-deny"|"guard-ask", guard: "push"|"write"|"read",
//     rule, agent_type ("main" for the main session), agent_id? }
// Never the command, a path or a file's content: the rule is a short word the guard sets, cut to [a-z0-9-] here, so a
// command text cannot ride along even by mistake.
// Where: the time log (config().timeLog, in the data folder, gitignored), so the rows rotate with it once a month
// (lib/timeLogArchive.js, history.rotateTimeLog) and every reader of the log can count them. A row is about 150 bytes;
// a busy day with a hundred denials adds 15 KB.
// counts() is what doctor (row "guards") and the board's Statistics tab show per track. outsideCli() finds a weakened
// setting that no `setting-weakened` row explains: queue.config.json was edited by hand or by an agent, which receive
// and doctor log once as "config-changed-outside-cli".
// guardLog.enabled false: no deny or ask rows (the override rows force-merged and config-changed-outside-cli stay, like
// the other override rows). Turning it off is a weakened guard: the decisions can no longer be seen afterwards.
// Pure except record. Tested in lib/__tests__/guardLog.test.ts.
// =============================================================
'use strict';

const GUARDS = new Set(['push', 'write', 'read']);
const EVENTS = Object.freeze({ deny: 'guard-deny', ask: 'guard-ask' });

/** A short word: lower case, [a-z0-9-] only, at most 40 characters. Anything else becomes "other". */
function word(x) {
  const s = String(x ?? '')
    .toLowerCase()
    .trim();
  return /^[a-z0-9][a-z0-9-]{0,39}$/.test(s) ? s : 'other';
}

const bareType = (t) => (typeof t === 'string' && t ? t.replace(/^[^:]+:/, '') : null);

/**
 * One row. decision "deny" or "ask"; agentType null = the main session.
 * @param {{ guard: string, rule: string, decision: string, agentType?: string|null, agentId?: string|null, task?: string|null, now?: Date }} x
 */
function row({ guard, rule, decision, agentType = null, agentId = null, task = null, now = new Date() }) {
  const r = {
    time: now.toISOString(),
    wave: 'guard',
    track: typeof task === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/.test(task) ? task : null,
    event: EVENTS[decision] ?? EVENTS.deny,
    guard: GUARDS.has(guard) ? guard : 'other',
    rule: word(rule),
    agent_type: word(bareType(agentType) ?? 'main'),
  };
  if (typeof agentId === 'string' && /^[\w.-]{1,80}$/.test(agentId)) r.agent_id = agentId;
  return r;
}

/** Is the guard log on (guardLog.enabled, default true)? */
const enabled = (cfg) => cfg?.guardLog?.enabled !== false;

/**
 * Appends the row to the time log. Never throws: a guard must never stop because its log failed.
 * @param {object} x the row's fields (row())
 * @param {{ log?: string, cfg?: object }} [o] the log file (default config().timeLog) and the config
 */
function record(x, o = {}) {
  try {
    const cfg = o.cfg ?? require('./queueConfig.js').config();
    if (!enabled(cfg)) return false;
    const log = o.log ?? require('./queueConfig.js').timeLog();
    require('./timeLogArchive.js').appendText(log, `${JSON.stringify(row(x))}\n`);
    return true;
  } catch {
    return false; // error-ignored: the log is measurement; the decision stands without it
  }
}

/**
 * The task a hook payload's subagent works on: from the mission at the top of its own transcript (the same rule as the
 * time log, lib/timeCost.js trackFromText). null for the main session or when it cannot be read.
 * @param {{ agent: { id?: string|null, type?: string|null } }} input the payload in the core's names
 */
function taskFor(input) {
  try {
    if (!input?.agent?.id) return null;
    const TG = require('./trackGuard.js');
    const tp = TG.subagentTranscript(input);
    const id = tp ? require('./timeCost.js').trackFromText(TG.readHeader(tp)) : null;
    return id ? id.replace(/-(?:r|round)d+$/i, '') : null;
  } catch {
    return null;
  }
}

/** A hook's decision as a row: the payload gives the agent and the task. Never throws. */
function recordHook({ guard, rule, decision, input }, o = {}) {
  try {
    return record(
      { guard, rule, decision, agentType: input?.agent?.type ?? null, agentId: input?.agent?.id ?? null, task: taskFor(input) },
      o,
    );
  } catch {
    return false; // error-ignored: measurement only
  }
}

/** The override events counted next to the guard decisions. */
const OVERRIDES = ['force-merged', 'config-changed-outside-cli', 'guard-overridden', 'secret-overridden', 'gate-red-overridden', 'base-red-overridden', 'partial-overridden', 'focus-overridden', 'unreviewed-overridden', 'no-test-overridden', 'catalog-overridden', 'setting-weakened'];

/**
 * Deny and ask per track (the main session as "main"), from `from` (ms) on, with the rules seen; and the override
 * events in the same window. Sorted: most denials first, then by name.
 */
function counts(rows, { from = null } = {}) {
  const per = new Map();
  const total = { deny: 0, ask: 0 };
  const over = new Map();
  for (const r of rows ?? []) {
    const t = Date.parse(r?.time ?? '');
    if (from != null && !(t >= from)) continue;
    if (OVERRIDES.includes(r?.event)) {
      over.set(r.event, (over.get(r.event) ?? 0) + 1);
      continue;
    }
    const kind = r?.event === EVENTS.deny ? 'deny' : r?.event === EVENTS.ask ? 'ask' : null;
    if (!kind) continue;
    const track = r.track || 'main';
    const x = per.get(track) ?? { track, deny: 0, ask: 0, rules: new Set() };
    x[kind]++;
    total[kind]++;
    if (r.rule) x.rules.add(r.rule);
    per.set(track, x);
  }
  const byTrack = [...per.values()]
    .map((x) => ({ ...x, rules: [...x.rules].sort() }))
    .sort((a, b) => (a.track === 'main') - (b.track === 'main') || b.deny + b.ask - (a.deny + a.ask) || a.track.localeCompare(b.track));
  const overrides = [...over.entries()].map(([event, count]) => ({ event, count })).sort((a, b) => b.count - a.count || a.event.localeCompare(b.event));
  return { total, byTrack, overrides };
}

/** doctor's sentence for the counts (`days` = the window). */
function doctorText(c, days) {
  const n = c.total.deny + c.total.ask;
  if (!n) return `no guard decisions logged in the last ${days} days`;
  const list = c.byTrack
    .slice(0, 8)
    .map((x) => `${x.track} ${x.deny + x.ask}`)
    .join(', ');
  const more = c.byTrack.length > 8 ? ` and ${c.byTrack.length - 8} more` : '';
  return `${c.total.deny} denied and ${c.total.ask} asked in the last ${days} days: ${list}${more}`;
}

/**
 * The weakened settings no setting-weakened row explains, and none already reported (config-changed-outside-cli with
 * the same value). `weakened` = [{ key, value }] (lib/settingsView.js settingsView().weakened).
 */
function outsideCli(weakened, rows) {
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const seen = (key, value) =>
    (rows ?? []).some((r) => (r?.event === 'setting-weakened' || r?.event === 'config-changed-outside-cli') && r.key === key && same(r.to, value));
  return (weakened ?? []).filter((w) => !seen(w.key, w.value)).map((w) => w.key);
}

/** The row for a weakened setting found outside the CLI; `to` is kept so the same value is reported once. */
function outsideCliRow(key, value, { now = new Date(), where = null } = {}) {
  return { time: now.toISOString(), event: 'config-changed-outside-cli', key, to: value, ...(where ? { where } : {}) };
}

module.exports = { EVENTS, OVERRIDES, row, record, taskFor, recordHook, enabled, counts, doctorText, outsideCli, outsideCliRow };
