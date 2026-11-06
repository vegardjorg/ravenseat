// =============================================================
// collect.js: turns a project's raw logs into normalized per-task and per-session records for one experiment.
//
// Inputs (all read-only, paths from the manifest or the command line):
//   queue        the queue file (ravenseat queue.json or a Norwegian ko.json): class, estimate, status, timestamps, cost
//   timeLog      the agent time log (ravenseat times.jsonl from hook-time.mjs, or the Norwegian equivalent): one cumulative
//                "done" row per agent stop, plus gate rows ("gates"/"gate") and compaction rows where the project
//                writes them. ravenseat writes one "gate" row per gates.mjs run (kind, ok, attempt, timed_out) and "compact"
//                rows with scope "session" (main sessions) or "track" (agent_id, compactions); see
//                plugin/scripts/orchestrator/lib/timeLogRows.js
//   transcripts  the Claude Code project folder (~/.claude/projects/<slug>): <session>.jsonl for main sessions and
//                <session>/subagents/agent-<id>.jsonl (+ .meta.json) for subagents. The most complete source: every
//                session, including the orchestrator and manual chats, which the time log never sees
//   load         the load sampler's JSONL (bench/lib/loadSampler.js)
//   human        the human minutes log (`bench.mjs human`): { time, task, arm, minutes, activity }
//   gitRepo      the project repo, for reverted commits (only `git log`, never a write)
//
// Output (`collectAll`): { experiment, collected, tasks[], sessions[], gates[], gateSteps[], load[], human[],
//   queueTasks[], reverts[], warnings[] }. Every number is derived from the sources; nothing is estimated here.
//
// Session types: orchestrator, planning, track, fix, reviewer, helper; `cancelled` marks work on a task that was
// cancelled or abandoned (it keeps its type, and the metrics count it as its own category). See bench/README.md.
//
// The pure parts are exported for the tests (bench/__tests__/collect.test.ts); file walking is in collectAll.
// =============================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const TC = require('../../plugin/scripts/orchestrator/lib/timeCost.js');
const { normalize, bareType } = require('./fields.js');
const P = require('./prices.js');
const { readLoad } = require('./loadSampler.js');

const BUILD_TYPES = new Set(['track', 'track-d']);
const REVIEWER_TYPES = new Set(['reviewer', 'reviewer-security', 'security-rls', 'privacy-sink', 'architecture-guard']);
const HELPER_TYPES = new Set(['reviewer-challenger', 'reviewer-design', 'reviewer-tests', 'reviewer-gap', 'reviewer-docs']);
const FIX_LABEL = /-(?:r|round|runde)\d+$/i;
const FIX_TEXT = /\b(fix round|retterunde|review fixes|review-rettinger)\b/i;
const TIMEOUT = /timeout|timed out|tidsavbrudd/i;

/** Is a "gate" row ravenseat's one-row-per-run format (gates.mjs: kind and attempt) rather than a single gate step? */
const isGateRun = (r) => typeof r.kind === 'string' && r.attempt != null;

/** A task's `fixes` as a list of ids (one id or a list in the queue file; anything else gives []). */
function fixesOf(t) {
  const v = t?.fixes;
  if (typeof v === 'string' && v) return [v];
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x) : [];
}

/** JSONL text into normalized rows (broken lines skipped: the logs are written by several processes). */
function readJsonl(text) {
  return TC.readRows(text).map(normalize);
}

const ms = (iso) => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};
const minutesBetween = (a, b) => {
  const x = ms(a);
  const y = ms(b);
  return x != null && y != null && y >= x ? Math.round(((y - x) / 60000) * 10) / 10 : null;
};

/**
 * Analyzes one transcript (JSONL). Streamed messages repeat the same message.id; each is counted once (last usage
 * wins). Tokens are kept per model so mixed-model sessions are priced right.
 */
function analyzeSession(text) {
  const turns = new Map();
  let first = null;
  let last = null;
  let label = null;
  let compactions = 0;
  let sendMessages = 0;
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = ms(r.timestamp);
    if (ts != null) {
      if (first == null || ts < first) first = ts;
      if (last == null || ts > last) last = ts;
    }
    // Claude Code writes a system row with subtype compact_boundary when a session is compacted.
    if (r.type === 'system' && r.subtype === 'compact_boundary') compactions++;
    const m = r.message;
    if (!m) continue;
    const content = Array.isArray(m.content) ? m.content : [];
    if (r.type === 'user' && !label && !r.isCompactSummary) {
      const t = typeof m.content === 'string' ? m.content : content.map((c) => c?.text ?? '').join(' ');
      label = TC.trackFromText(t);
    }
    if (r.type !== 'assistant') continue;
    for (const c of content) if (c?.type === 'tool_use' && c.name === 'SendMessage') sendMessages++;
    if (m.id && m.usage) turns.set(m.id, { usage: m.usage, model: m.model ?? turns.get(m.id)?.model ?? null });
  }
  const byModel = {};
  let peak = 0;
  let end = null;
  for (const { usage: u, model } of turns.values()) {
    const k = model ?? 'unknown';
    const t = (byModel[k] ??= {
      input: 0,
      output: 0,
      cache_read: 0,
      cache_written: 0,
      cache_written_5m: 0,
      cache_written_1h: 0,
    });
    const written = u.cache_creation_input_tokens ?? 0;
    const five = u.cache_creation?.ephemeral_5m_input_tokens;
    const hour = u.cache_creation?.ephemeral_1h_input_tokens;
    t.input += u.input_tokens ?? 0;
    t.output += u.output_tokens ?? 0;
    t.cache_read += u.cache_read_input_tokens ?? 0;
    t.cache_written += written;
    t.cache_written_5m += five ?? (hour == null ? written : 0);
    t.cache_written_1h += hour ?? 0;
    const ctx = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + written;
    if (ctx > peak) peak = ctx;
    end = ctx;
  }
  return {
    start: first != null ? new Date(first).toISOString() : null,
    end: last != null ? new Date(last).toISOString() : null,
    duration_s: first != null && last != null ? Math.round((last - first) / 1000) : null,
    turns: turns.size,
    tokens_by_model: byModel,
    peak_context: turns.size ? peak : null,
    end_context: end,
    compactions,
    send_messages: sendMessages,
    label,
  };
}

/** Sums tokens over models and prices each model. */
function priceSession(byModel, table) {
  const tokens = { input: 0, output: 0, cache_read: 0, cache_written: 0 };
  let usd = 0;
  let assumed = false;
  let main = null;
  let mainTurns = -1;
  for (const [model, t] of Object.entries(byModel ?? {})) {
    for (const k of Object.keys(tokens)) tokens[k] += Number(t[k] ?? 0) || 0;
    const c = P.costUsd(t, model === 'unknown' ? null : model, table);
    usd += c.usd;
    assumed ||= c.assumed || model === 'unknown';
    const size = (t.input ?? 0) + (t.output ?? 0) + (t.cache_read ?? 0);
    if (size > mainTurns) {
      mainTurns = size;
      main = model;
    }
  }
  return { tokens, usd: Math.round(usd * 10000) / 10000, assumed, model: main };
}

/**
 * The time log split into what the benchmark uses: the last cumulative "done" row per agent (= its total usage),
 * gate runs (one row per gate run with rerun number) and single gate steps (for timeouts), and compactions.
 */
function parseTimeLog(rows) {
  const lastDone = new Map();
  const starts = new Map();
  const gates = [];
  const gateSteps = [];
  const compactions = [];
  for (const r of rows ?? []) {
    if (r.event === 'start' && r.agent_id && !starts.has(r.agent_id)) starts.set(r.agent_id, r);
    if (r.event === 'done' && r.agent_id && r.tokens) {
      const prev = lastDone.get(r.agent_id);
      if (!prev || (ms(r.time) ?? 0) >= (ms(prev.time) ?? 0)) lastDone.set(r.agent_id, r);
    }
    if (r.event === 'gates')
      gates.push({
        time: r.time,
        track: r.track ?? null,
        mode: r.mode ?? null,
        duration_s: Number.isFinite(Number(r.duration_s)) ? Number(r.duration_s) : null,
        green: r.green ?? null,
        rerun_nr: Number.isFinite(Number(r.rerun_nr)) ? Number(r.rerun_nr) : null,
        first_green: r.first_green ?? null,
        concurrent_gates: r.concurrent_gates ?? null,
        free_memory_pct: r.free_memory_pct ?? null,
        load_1m: r.load_1m ?? null,
      });
    // ravenseat's gate run row (one per gates.mjs run): it is a gate run, and also a step so timeouts are counted.
    if (r.event === 'gate' && isGateRun(r)) {
      const attempt = Number.isInteger(Number(r.attempt)) && Number(r.attempt) > 0 ? Number(r.attempt) : 1;
      const duration = Number.isFinite(Number(r.duration_s)) ? Number(r.duration_s) : null;
      const timeout = r.timed_out === true;
      gates.push({
        time: r.time,
        track: r.track ?? null,
        mode: r.kind,
        duration_s: duration,
        green: typeof r.ok === 'boolean' ? r.ok : null,
        rerun_nr: attempt - 1,
        first_green: null,
        concurrent_gates: r.concurrent_gates ?? null,
        free_memory_pct: r.free_memory_pct ?? null,
        load_1m: r.load_1m ?? null,
        branch: r.branch ?? null,
        exit: r.exit ?? null,
        timed_out: timeout,
      });
      gateSteps.push({
        time: r.time,
        track: r.track ?? null,
        gate: r.kind,
        status: timeout ? 'TIMEOUT' : r.ok ? 'GREEN' : 'RED',
        duration_s: duration,
        timeout,
      });
    } else if (r.event === 'gate')
      gateSteps.push({
        time: r.time,
        track: r.track ?? null,
        gate: r.gate ?? null,
        status: r.status ?? null,
        duration_s: Number(r.duration_s) || null,
        timeout: TIMEOUT.test(String(r.status ?? '')) || TIMEOUT.test(String(r.remark ?? '')),
      });
    if (r.event === 'compact')
      compactions.push({
        time: r.time,
        // "session" (a main session), "track" (a track agent, ravenseat's hook-track-context) or null (older rows)
        scope: r.scope ?? null,
        session_id: r.session_id ?? null,
        agent_id: r.agent_id ?? null,
        track: r.track ?? null,
        orchestrator: typeof r.orchestrator === 'boolean' ? r.orchestrator : null,
        compactions: Number.isFinite(Number(r.compactions)) && r.compactions != null ? Number(r.compactions) : null,
        pre_tokens: r.pre_tokens ?? null,
      });
  }
  const agents = [...lastDone.values()].map((r) => ({
    agent_id: r.agent_id,
    agent_type: bareType(r.agent_type || starts.get(r.agent_id)?.agent_type || null),
    label: r.track && r.track !== String(r.agent_id).slice(0, 12) ? r.track : null,
    start: starts.get(r.agent_id)?.time ?? null,
    end: r.time,
    duration_s: r.duration_s ?? null,
    turns: r.modelTurns ?? null,
    model: r.model ?? null,
    tokens: r.tokens,
    peak_context: r.context?.end ?? null, // the time log keeps start/median/end only; end is a lower bound of the peak
  }));
  return { agents, gates, gateSteps, compactions };
}

/** Lists transcript files under a Claude Code project folder. Only files modified at or after `from` (ms) are kept. */
function listTranscripts(dir, { from = null } = {}) {
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  const keep = (p) => {
    try {
      return from == null || fs.statSync(p).mtimeMs >= from;
    } catch {
      return false;
    }
  };
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name.endsWith('.jsonl') && keep(p))
      out.push({ file: p, kind: 'main', id: e.name.slice(0, -6), parent: null, meta: null });
    if (e.isDirectory()) {
      const sub = path.join(p, 'subagents');
      let files = [];
      try {
        files = fs.readdirSync(sub);
      } catch {
        continue;
      }
      for (const f of files) {
        if (!/^agent-.+\.jsonl$/.test(f)) continue;
        const fp = path.join(sub, f);
        if (!keep(fp)) continue;
        let meta = null;
        try {
          meta = JSON.parse(fs.readFileSync(fp.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
        } catch {
          meta = null;
        }
        out.push({ file: fp, kind: 'subagent', id: f.slice(6, -6), parent: e.name, meta });
      }
    }
  }
  return out;
}

/**
 * Classifies a session. `overrides` (manifest settings.sessionTypes) maps an agent type or a session id to a type and
 * wins. Main sessions: listed by a ravenseat arm or spawning build agents = orchestrator; listed by a manual arm or task =
 * track (the human-driven chat does the build); otherwise planning.
 */
function classify(s, { overrides = {}, queueSessions = new Set(), manualSessions = new Set(), spawnsBuild = new Set() } = {}) {
  if (overrides[s.id]) return overrides[s.id];
  if (s.agent_type && overrides[s.agent_type]) return overrides[s.agent_type];
  if (s.kind === 'main') {
    if (manualSessions.has(s.id)) return 'track';
    if (queueSessions.has(s.id) || spawnsBuild.has(s.id)) return 'orchestrator';
    return 'planning';
  }
  const type = s.agent_type;
  if (BUILD_TYPES.has(type)) return FIX_LABEL.test(s.label ?? '') || FIX_TEXT.test(s.description ?? '') ? 'fix' : 'track';
  if (REVIEWER_TYPES.has(type)) return 'reviewer';
  if (HELPER_TYPES.has(type)) return 'helper';
  return s.label ? 'helper' : 'planning';
}

/** Outcome of a task from its queue status, unless the manifest sets one. */
function outcomeFor(task, manual) {
  if (manual) return manual;
  if (!task) return 'unknown';
  if (task.status === 'done') return 'merged';
  if (task.status === 'cancelled') return 'abandoned';
  if (['running', 'review', 'waiting', 'proposed'].includes(task.status)) return 'open';
  return 'unknown';
}

/**
 * Joins everything. Pure: takes already-read data.
 * @param {object} manifest a manifest after withDefaults
 * @param {{ queue?: object|null, timeRows?: object[], transcripts?: object[], load?: object[], human?: object[],
 *   reverts?: object[] }} data  transcripts: [{ id, kind, parent, meta, analysis }]
 */
function build(manifest, data) {
  const warnings = [];
  const settings = manifest.settings ?? {};
  const table = P.priceTable(settings.prices);
  const queue = data.queue ? normalize(data.queue) : null;
  const queueTasks = queue?.tasks ?? [];
  const byId = new Map(queueTasks.map((t) => [t.id, t]));
  if (!queue) warnings.push('no queue file: class, estimate and status come only from the manifest');

  // ---- tasks ----
  const labelToTask = new Map();
  const tasks = manifest.tasks.map((mt) => {
    const q = byId.get(mt.id) ?? null;
    if (queue && !q) warnings.push(`task ${mt.id} is not in the queue file`);
    labelToTask.set(mt.label, mt);
    const replay = !!mt.replay;
    return {
      id: mt.id,
      label: mt.label,
      arm: mt.arm,
      pair: mt.pair,
      stratum: mt.stratum,
      replay,
      class: q?.class ?? mt.class ?? null,
      content_min: q?.content_min ?? mt.content_min ?? null,
      value: q?.value ?? null,
      domain: q?.domain ?? null,
      status: replay ? null : (q?.status ?? null),
      outcome: outcomeFor(replay ? null : q, mt.outcome),
      started: replay ? null : (q?.started ?? null),
      delivered: replay ? null : (q?.delivered ?? null),
      merged: replay ? null : (q?.t_merge ?? (q?.status === 'done' ? q?.done : null) ?? null),
      wall_min: replay ? null : minutesBetween(q?.started, q?.done),
      build_min: replay ? null : minutesBetween(q?.started, q?.delivered),
      queue_usd: replay ? null : (Number.isFinite(Number(q?.cost?.usd)) ? Number(q.cost.usd) : null),
      findings: replay ? null : (q?.findings ?? null),
      diff_lines: replay ? null : (q?.diff_lines ?? null),
      owned_files: Array.isArray(q?.owned_files) ? q.owned_files : [],
      sessions: mt.sessions ?? [],
    };
  });
  const taskByLabel = (label) => {
    if (!label) return null;
    const id = TC.taskIdFor(label, (x) => labelToTask.has(x));
    return id ? labelToTask.get(id) : null;
  };

  // ---- sessions: transcripts first, then time log agents that have no transcript ----
  const armOfSession = new Map();
  const taskOfSession = new Map();
  const queueSessions = new Set();
  const manualSessions = new Set();
  const armKind = new Map(manifest.arms.map((a) => [a.name, a.kind]));
  for (const a of manifest.arms)
    for (const sid of a.sessions ?? []) {
      armOfSession.set(sid, a.name);
      (a.kind === 'ravenseat' ? queueSessions : manualSessions).add(sid);
    }
  for (const mt of manifest.tasks)
    for (const sid of mt.sessions ?? []) {
      armOfSession.set(sid, mt.arm);
      taskOfSession.set(sid, mt);
      if (armKind.get(mt.arm) !== 'ravenseat') manualSessions.add(sid);
    }

  const raw = [];
  const seenAgents = new Set();
  for (const t of data.transcripts ?? []) {
    const a = t.analysis;
    const priced = priceSession(a.tokens_by_model, table);
    const agentType = bareType(t.meta?.agentType ?? t.meta?.agent_type ?? (t.kind === 'main' ? null : 'unknown'));
    const description = t.meta?.description ?? null;
    if (t.kind === 'subagent') seenAgents.add(t.id);
    raw.push({
      id: t.id,
      kind: t.kind,
      parent: t.parent,
      agent_type: agentType,
      description,
      label: a.label ?? (description ? TC.trackFromText(description) : null),
      start: a.start,
      end: a.end,
      duration_s: a.duration_s,
      turns: a.turns,
      tokens: priced.tokens,
      model: priced.model,
      usd: priced.usd,
      assumed_price: priced.assumed,
      peak_context: a.peak_context,
      compactions: a.compactions,
      send_messages: a.send_messages,
      source: 'transcript',
    });
  }
  const tl = parseTimeLog(data.timeRows ?? []);
  for (const g of tl.agents) {
    if (seenAgents.has(g.agent_id)) continue;
    const c = P.costUsd(g.tokens, g.model, table);
    raw.push({
      id: g.agent_id,
      kind: 'subagent',
      parent: null,
      agent_type: g.agent_type,
      description: null,
      label: g.label,
      start: g.start,
      end: g.end,
      duration_s: g.duration_s,
      turns: g.turns,
      tokens: {
        input: Number(g.tokens.input ?? 0),
        output: Number(g.tokens.output ?? 0),
        cache_read: Number(g.tokens.cache_read ?? 0),
        cache_written: Number(g.tokens.cache_written ?? 0),
      },
      model: g.model,
      usd: Math.round(c.usd * 10000) / 10000,
      assumed_price: c.assumed,
      peak_context: g.peak_context,
      compactions: 0,
      send_messages: 0,
      source: 'timeLog',
    });
  }
  // Compactions recorded in the time log (hook rows), for sessions whose transcript shows none (no compact_boundary,
  // or no transcript at all), so a compaction is never counted twice. A main session row counts one each; a track row
  // carries the running count, so the highest count per agent is its total.
  const logged = new Map();
  for (const c of tl.compactions) {
    if (c.scope === 'track' && c.agent_id) {
      const prev = logged.get(c.agent_id) ?? 0;
      logged.set(c.agent_id, Math.max(prev, c.compactions ?? prev + 1));
    } else if (c.session_id) logged.set(c.session_id, (logged.get(c.session_id) ?? 0) + 1);
  }
  for (const [id, n] of logged) {
    const s = raw.find((x) => x.id === id);
    if (s && s.compactions === 0) s.compactions_log = n;
  }
  const spawnsBuild = new Set(raw.filter((s) => s.kind === 'subagent' && BUILD_TYPES.has(s.agent_type)).map((s) => s.parent));
  // A main session ravenseat's compaction hook marked as the bound orchestrator is an orchestrator too.
  for (const c of tl.compactions) if (c.orchestrator === true && c.session_id) spawnsBuild.add(c.session_id);

  const inWindow = (iso) => {
    const t = ms(iso);
    if (t == null) return null;
    const hit = manifest.arms.find((a) => a.window && t >= ms(a.window.from) && t < ms(a.window.to));
    return hit?.name ?? null;
  };
  const sessions = raw.map((s) => {
    const mt = taskOfSession.get(s.id) ?? taskByLabel(s.label) ?? (s.parent ? taskOfSession.get(s.parent) : null) ?? null;
    const arm = mt?.arm ?? armOfSession.get(s.id) ?? (s.parent ? armOfSession.get(s.parent) : null) ?? inWindow(s.start);
    const type = classify(s, { overrides: settings.sessionTypes ?? {}, queueSessions, manualSessions, spawnsBuild });
    return { ...s, task: mt?.id ?? null, task_label: mt?.label ?? null, arm: arm ?? null, session_type: type };
  });
  // A second build agent on the same task (not a handover marked as such) is a fix round.
  const builds = new Map();
  for (const s of sessions.filter((x) => x.session_type === 'track' && x.kind === 'subagent' && x.task_label)) {
    const list = builds.get(s.task_label) ?? [];
    list.push(s);
    builds.set(s.task_label, list);
  }
  for (const list of builds.values()) {
    list.sort((a, b) => (ms(a.start) ?? 0) - (ms(b.start) ?? 0));
    for (const s of list.slice(1)) s.session_type = 'fix';
  }
  const taskByLabelMap = new Map(tasks.map((t) => [t.label, t]));
  for (const s of sessions) {
    const t = s.task_label ? taskByLabelMap.get(s.task_label) : null;
    s.cancelled = !!t && (t.outcome === 'abandoned' || t.outcome === 'failed');
  }
  const unattributed = sessions.filter((s) => !s.arm);
  if (unattributed.length)
    warnings.push(`${unattributed.length} session(s) belong to no arm (outside every window and not linked to a task)`);
  const assumed = [...new Set(sessions.filter((s) => s.assumed_price).map((s) => s.model ?? 'unknown'))];
  if (assumed.length) warnings.push(`no price for model(s) ${assumed.join(', ')}: priced as the default model; set settings.prices`);

  // ---- gates, joined to tasks and to the nearest load sample ----
  const load = (data.load ?? []).slice().sort((a, b) => ms(a.time) - ms(b.time));
  const matchMs = (settings.loadMatchSec ?? 120) * 1000;
  const nearestLoad = (iso) => {
    const t = ms(iso);
    if (t == null || !load.length) return null;
    let best = null;
    let bestD = Infinity;
    for (const l of load) {
      const d = Math.abs(ms(l.time) - t);
      if (d < bestD) {
        bestD = d;
        best = l;
      }
    }
    return bestD <= matchMs ? best : null;
  };
  const withTask = (g) => {
    const mt = taskByLabel(g.track);
    const l = nearestLoad(g.time);
    return {
      ...g,
      task: mt?.id ?? null,
      task_label: mt?.label ?? null,
      arm: mt?.arm ?? inWindow(g.time),
      sample_free_memory_pct: l?.free_memory_pct ?? null,
      sample_cpu_pct: l?.cpu_pct ?? null,
      sample_running_tracks: l?.running_tracks ?? null,
      sample_node_processes: l?.node_processes ?? null,
    };
  };
  const gates = tl.gates.map(withTask);
  const gateSteps = tl.gateSteps.map(withTask);
  if (!gates.length) warnings.push('no gate run rows in the time log: gate reruns and gate durations are unknown');
  if (!load.length) warnings.push('no load samples: load correlation is unknown');

  // ---- human minutes ----
  const human = (data.human ?? []).map((h) => {
    const mt = h.task ? (labelToTask.get(h.task) ?? manifest.tasks.find((t) => t.id === h.task)) : null;
    return { ...h, minutes: Number(h.minutes) || 0, arm: h.arm ?? mt?.arm ?? inWindow(h.time), task: mt?.id ?? h.task ?? null };
  });

  return {
    experiment: manifest.experiment,
    collected: new Date().toISOString(),
    arms: manifest.arms,
    settings,
    tasks,
    sessions,
    gates,
    gateSteps,
    load,
    human,
    queueTasks: queueTasks.map((t) => ({
      id: t.id,
      class: t.class ?? null,
      status: t.status ?? null,
      // ravenseat writes added_at; the Norwegian queue lagt_til (normalized to added)
      added: t.added ?? t.added_at ?? null,
      labels: t.labels ?? [],
      owned_files: Array.isArray(t.owned_files) ? t.owned_files : [],
      depends_on: t.depends_on ?? [],
      // the task(s) this one fixes (ravenseat's `fixes` field): a merged task named here has a defect after merge
      fixes: fixesOf(t),
    })),
    reverts: data.reverts ?? [],
    warnings,
  };
}

/** Parses `git log --format=%H%x09%aI%x09%s` output into revert commits: { sha, time, subject }. */
function parseReverts(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((l) => l.split('\t'))
    .filter((p) => p.length >= 3 && /^Revert\b/i.test(p[2]))
    .map(([sha, time, ...s]) => ({ sha, time, subject: s.join('\t') }));
}

/** Runs a read-only `git log` in the repo for revert commits since `since`. Empty on any error. */
function gitReverts(repo, since) {
  if (!repo) return [];
  const args = ['-C', repo, 'log', '--all', '--format=%H%x09%aI%x09%s'];
  if (since) args.push(`--since=${since}`);
  const r = spawnSync('git', args, { encoding: 'utf8', timeout: 30000, maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? parseReverts(r.stdout) : [];
}

const readText = (p) => {
  try {
    return p ? fs.readFileSync(p, 'utf8') : null;
  } catch {
    return null;
  }
};

// Bump when analyzeSession changes what it returns, so a cached analysis from an older version is not reused.
const ANALYSIS_VERSION = 1;

/**
 * The transcript cache: one analysis per file, reused while the file's size and mtime are unchanged. Reading a month
 * of transcripts can take a quarter of an hour on a busy disk; a daily collect then only parses new or changed files.
 * A missing, unreadable or outdated cache file simply starts empty.
 */
function loadCache(file) {
  if (!file) return null;
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (c?.version === ANALYSIS_VERSION && c.entries && typeof c.entries === 'object') return c;
  } catch {
    // no cache yet
  }
  return { version: ANALYSIS_VERSION, entries: {} };
}

/** Reads every source named in the manifest and builds the records. `maxBytes` skips huge transcripts. */
function collectAll(manifest, { maxBytes = 300 * 1024 * 1024, cacheFile = null } = {}) {
  const s = manifest.sources ?? {};
  const qText = readText(s.queue);
  const windows = manifest.arms.map((a) => a.window).filter(Boolean);
  const from = windows.length ? Math.min(...windows.map((w) => ms(w.from))) : null;
  const transcripts = [];
  const skipped = [];
  const cache = loadCache(cacheFile);
  let cacheHits = 0;
  if (s.transcripts) {
    for (const f of listTranscripts(s.transcripts, { from })) {
      try {
        const st = fs.statSync(f.file);
        if (st.size > maxBytes) {
          skipped.push(f.id);
          continue;
        }
        const hit = cache?.entries[f.file];
        let analysis;
        if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) {
          analysis = hit.analysis;
          cacheHits++;
        } else {
          analysis = analyzeSession(fs.readFileSync(f.file, 'utf8'));
          if (cache) cache.entries[f.file] = { size: st.size, mtimeMs: st.mtimeMs, analysis };
        }
        transcripts.push({ ...f, analysis });
      } catch {
        skipped.push(f.id);
      }
    }
  }
  if (cache && cacheFile) {
    try {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      fs.writeFileSync(cacheFile, JSON.stringify(cache));
    } catch {
      // a cache that cannot be written only costs time on the next run
    }
  }
  const timeRows = [...readJsonl(readText(s.timeLog)), ...readJsonl(readText(s.gates))];
  const out = build(manifest, {
    queue: qText ? JSON.parse(qText) : null,
    timeRows,
    transcripts,
    load: readLoad(readText(s.load)),
    human: TC.readRows(readText(s.human)),
    reverts: gitReverts(s.gitRepo, from ? new Date(from).toISOString() : null),
  });
  if (skipped.length) out.warnings.push(`${skipped.length} transcript(s) skipped (too large or unreadable)`);
  out.transcript_cache_hits = cacheHits;
  if (!s.transcripts) out.warnings.push('no transcripts folder: orchestrator, planning and manual sessions are missing');
  return out;
}

module.exports = {
  BUILD_TYPES,
  REVIEWER_TYPES,
  HELPER_TYPES,
  readJsonl,
  isGateRun,
  fixesOf,
  analyzeSession,
  priceSession,
  parseTimeLog,
  listTranscripts,
  classify,
  outcomeFor,
  build,
  parseReverts,
  gitReverts,
  collectAll,
};
