// =============================================================
// metrics.js: the benchmark's numbers, computed from the records collect.js builds.
//
// Main measure: USD PER MERGED CHANGE per arm = all usage in the arm (every session type, including the orchestrator,
// planning, fix rounds and cancelled work) divided by the tasks that reached "merged". Not USD per estimated content
// minute: the estimate is a moving denominator, and changing how tasks are estimated would change the measure
// without any change in real cost.
//
//   armSummary      per arm: tasks, merged, USD and tokens by session type, USD per merged change (also per class),
//                   cache share, compactions, context peaks, wall time, human minutes, gate runs and reruns,
//                   timeouts, defects after merge, review findings
//   taskCosts       per task: own USD + an equal share of the arm's overhead (sessions with no task), human minutes,
//                   fix rounds and defects: the unit the paired comparison uses
//   defects         defects after merge per merged task: later fix tasks (id <task>-F/-FIX/-FIKS/-QA, or a bug/fix
//                   label touching the same files) and reverted commits naming the task, within the window
//   loadAnalysis    gate duration and reruns against parallelism and free memory: correlations and level buckets
//   paired          matched pair comparison of two arms on one metric, with bootstrap CIs
//
// Pure. Tested in bench/__tests__/metrics.test.ts.
// =============================================================
'use strict';

const S = require('./stats.js');

const SESSION_TYPES = ['orchestrator', 'planning', 'track', 'fix', 'reviewer', 'helper', 'cancelled'];
const FIX_ID = /-(?:F|FIX|FIKS|QA)\d*(?:$|-)/i;
const BUG_LABEL = /^(bug|fix|defect|feil)$/i;
const LEVELS = [
  { name: '1-2', lo: 1, hi: 2 },
  { name: '3-4', lo: 3, hi: 4 },
  { name: '5-8', lo: 5, hi: 8 },
  { name: '9-12', lo: 9, hi: 12 },
  { name: '13+', lo: 13, hi: Infinity },
];

const ms = (iso) => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};
const r2 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);
const r3 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1000) / 1000);
const sum = (xs) => xs.reduce((a, b) => a + (Number(b) || 0), 0);
/** The bucket a session's usage is counted in: cancelled work is its own category whatever its type. */
const bucketOf = (s) => (s.cancelled ? 'cancelled' : s.session_type);

/** Defects after merge per merged task (see the header). @returns {Map<string, { fixTasks: string[], reverts: string[], count: number }>} */
function defects(records, windowDays = records.settings?.defectWindowDays ?? 14) {
  const out = new Map();
  const windowMs = windowDays * 86400000;
  for (const t of records.tasks) {
    if (t.outcome !== 'merged') continue;
    const m = ms(t.merged);
    const found = { fixTasks: [], reverts: [], count: 0 };
    if (m != null) {
      const inWin = (iso) => {
        const x = ms(iso);
        return x != null && x >= m && x <= m + windowMs;
      };
      const files = new Set(t.owned_files ?? []);
      for (const q of records.queueTasks ?? []) {
        if (q.id === t.id || q.status === 'cancelled' || !inWin(q.added)) continue;
        const byId = q.id.startsWith(`${t.id}-`) && FIX_ID.test(q.id.slice(t.id.length));
        const byFiles =
          (q.labels ?? []).some((l) => BUG_LABEL.test(l)) && (q.owned_files ?? []).some((f) => files.has(f));
        if (byId || byFiles) found.fixTasks.push(q.id);
      }
      const word = new RegExp(`(^|[^A-Za-z0-9_-])${t.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^A-Za-z0-9_-])`);
      for (const r of records.reverts ?? []) if (inWin(r.time) && word.test(r.subject)) found.reverts.push(r.sha);
    }
    found.count = found.fixTasks.length + found.reverts.length;
    out.set(`${t.id}|${t.arm}`, found);
  }
  return out;
}

/** Per task: own USD, overhead share, human minutes, fix rounds, defects. */
function taskCosts(records) {
  const def = defects(records);
  const out = [];
  const arms = new Set(records.tasks.map((t) => t.arm));
  for (const arm of arms) {
    const tasks = records.tasks.filter((t) => t.arm === arm);
    const sessions = records.sessions.filter((s) => s.arm === arm);
    const overhead = sum(sessions.filter((s) => !s.task_label).map((s) => s.usd));
    const humanRows = (records.human ?? []).filter((h) => h.arm === arm);
    const humanOverhead = sum(humanRows.filter((h) => !h.task).map((h) => h.minutes));
    for (const t of tasks) {
      const own = sessions.filter((s) => s.task_label === t.label);
      const ownUsd = sum(own.map((s) => s.usd));
      const humanOwn = sum(humanRows.filter((h) => h.task === t.id).map((h) => h.minutes));
      const d = def.get(`${t.id}|${t.arm}`);
      out.push({
        id: t.id,
        label: t.label,
        arm,
        pair: t.pair,
        stratum: t.stratum,
        class: t.class,
        outcome: t.outcome,
        merged: t.outcome === 'merged' ? 1 : 0,
        own_usd: r2(ownUsd),
        usd: r2(ownUsd + overhead / tasks.length),
        queue_usd: t.queue_usd,
        human_min: r2(humanOwn + humanOverhead / tasks.length),
        wall_min: t.wall_min,
        build_min: t.build_min,
        fix_rounds: own.filter((s) => s.session_type === 'fix').length,
        defects: d ? d.count : null,
        defect_detail: d ?? null,
      });
    }
  }
  return out;
}

/** Gate statistics for a list of gate runs and gate steps. */
function gateStats(gates, steps) {
  const runs = gates.length;
  const reruns = gates.filter((g) => (g.rerun_nr ?? 0) > 0).length;
  const quick = gates.filter((g) => g.mode === 'quick').map((g) => g.duration_s);
  const full = gates.filter((g) => g.mode === 'full').map((g) => g.duration_s);
  return {
    runs,
    reruns,
    rerun_share: runs ? r3(reruns / runs) : null,
    red: gates.filter((g) => g.green === false).length,
    median_quick_s: r2(S.median(quick)),
    median_full_s: r2(S.median(full)),
    median_s: r2(S.median(gates.map((g) => g.duration_s))),
    gate_seconds: r2(sum(gates.map((g) => g.duration_s))),
    rerun_seconds: r2(sum(gates.filter((g) => (g.rerun_nr ?? 0) > 0).map((g) => g.duration_s))),
    timeouts: steps.filter((s) => s.timeout).length,
  };
}

/** The summary per arm (see the header). */
function armSummary(records) {
  const costs = taskCosts(records);
  return records.arms.map((a) => {
    const tasks = records.tasks.filter((t) => t.arm === a.name);
    const merged = tasks.filter((t) => t.outcome === 'merged');
    const sessions = records.sessions.filter((s) => s.arm === a.name);
    const usdByType = Object.fromEntries(SESSION_TYPES.map((k) => [k, 0]));
    const tokensByType = {};
    for (const s of sessions) {
      const b = bucketOf(s);
      usdByType[b] = (usdByType[b] ?? 0) + (Number(s.usd) || 0);
      const t = (tokensByType[b] ??= { sessions: 0, input: 0, output: 0, cache_read: 0, cache_written: 0 });
      t.sessions++;
      for (const k of ['input', 'output', 'cache_read', 'cache_written']) t[k] += Number(s.tokens?.[k] ?? 0) || 0;
    }
    for (const k of Object.keys(usdByType)) usdByType[k] = r2(usdByType[k]);
    const total = sum(sessions.map((s) => s.usd));
    const allTok = Object.values(tokensByType);
    const read = sum(allTok.map((t) => t.cache_read));
    const written = sum(allTok.map((t) => t.cache_written));
    const input = sum(allTok.map((t) => t.input));
    const perClass = {};
    for (const cls of [...new Set(tasks.map((t) => t.class ?? 'unknown'))].sort()) {
      const c = costs.filter((x) => x.arm === a.name && (x.class ?? 'unknown') === cls);
      const m = c.filter((x) => x.merged).length;
      perClass[cls] = { tasks: c.length, merged: m, usd_per_merged: m ? r2(sum(c.map((x) => x.usd)) / m) : null };
    }
    const human = (records.human ?? []).filter((h) => h.arm === a.name);
    const build = sessions.filter((s) => s.session_type === 'track' || s.session_type === 'fix');
    const gates = records.gates.filter((g) => g.arm === a.name);
    const steps = (records.gateSteps ?? []).filter((g) => g.arm === a.name);
    const ac = costs.filter((x) => x.arm === a.name);
    const findings = tasks.map((t) => t.findings).filter(Boolean);
    return {
      arm: a.name,
      kind: a.kind,
      maxParallel: a.maxParallel ?? null,
      models: a.models ?? {},
      tasks: tasks.length,
      merged: merged.length,
      merge_rate: tasks.length ? r3(merged.length / tasks.length) : null,
      usd_total: r2(total),
      usd_per_merged: merged.length ? r2(total / merged.length) : null,
      usd_by_type: usdByType,
      tokens_by_type: tokensByType,
      overhead_share: total > 0 ? r3(sum(sessions.filter((s) => !s.task_label).map((s) => s.usd)) / total) : null,
      cache_read_share: read + written + input > 0 ? r3(read / (read + written + input)) : null,
      per_class: perClass,
      sessions: sessions.length,
      compactions: sum(sessions.map((s) => (s.compactions ?? 0) + (s.compactions_log ?? 0))),
      peak_context_median: S.median(build.map((s) => s.peak_context)),
      peak_context_max: build.length ? Math.max(0, ...build.map((s) => Number(s.peak_context) || 0)) : null,
      wall_min_median: r2(S.median(merged.map((t) => t.wall_min))),
      human_min: r2(sum(human.map((h) => h.minutes))),
      human_min_per_merged: merged.length ? r2(sum(human.map((h) => h.minutes)) / merged.length) : null,
      fix_rounds: sum(ac.map((x) => x.fix_rounds)),
      defects: sum(ac.map((x) => x.defects ?? 0)),
      defects_per_merged: merged.length ? r3(sum(ac.map((x) => x.defects ?? 0)) / merged.length) : null,
      review_high_medium: sum(findings.map((f) => (Number(f.H) || 0) + (Number(f.M) || 0))),
      gates: gateStats(gates, steps),
    };
  });
}

const levelOf = (n) => LEVELS.find((l) => n >= l.lo && n <= l.hi)?.name ?? null;

/** Load against gate duration, reruns and task duration (see the header). */
function loadAnalysis(records) {
  const gates = records.gates.filter((g) => g.duration_s != null);
  const par = (g) => g.sample_running_tracks ?? g.concurrent_gates ?? null;
  const free = (g) => g.free_memory_pct ?? g.sample_free_memory_pct ?? null;
  const rerun = (g) => ((g.rerun_nr ?? 0) > 0 ? 1 : 0);
  const buckets = LEVELS.map((l) => {
    const gs = gates.filter((g) => par(g) != null && levelOf(par(g)) === l.name);
    const steps = (records.gateSteps ?? []).filter(
      (s) => s.sample_running_tracks != null && levelOf(s.sample_running_tracks) === l.name,
    );
    return {
      level: l.name,
      runs: gs.length,
      median_s: r2(S.median(gs.map((g) => g.duration_s))),
      p90_s: r2(S.percentile(gs.map((g) => g.duration_s), 90)),
      rerun_share: gs.length ? r3(sum(gs.map(rerun)) / gs.length) : null,
      timeout_share: steps.length ? r3(steps.filter((s) => s.timeout).length / steps.length) : null,
    };
  }).filter((b) => b.runs > 0);
  // Per task: mean running tracks while it was built, against build minutes per estimated minute and fix rounds.
  const load = records.load ?? [];
  const costs = taskCosts(records);
  const taskRows = records.tasks
    .filter((t) => t.started && t.delivered)
    .map((t) => {
      const a = ms(t.started);
      const b = ms(t.delivered);
      const during = load.filter((l) => ms(l.time) >= a && ms(l.time) <= b);
      const c = costs.find((x) => x.id === t.id && x.arm === t.arm);
      return {
        id: t.id,
        arm: t.arm,
        mean_running: S.mean(during.map((l) => l.running_tracks)),
        min_free_memory: during.length ? Math.min(...during.map((l) => Number(l.free_memory_pct) || 100)) : null,
        slowdown: t.content_min > 0 && t.build_min != null ? t.build_min / t.content_min : null,
        fix_rounds: c?.fix_rounds ?? 0,
      };
    });
  return {
    gate_runs: gates.length,
    corr_parallel_duration: r3(S.spearman(gates.map(par), gates.map((g) => g.duration_s))),
    corr_free_memory_duration: r3(S.spearman(gates.map(free), gates.map((g) => g.duration_s))),
    corr_parallel_rerun: r3(S.spearman(gates.map(par), gates.map(rerun))),
    buckets,
    tasks: taskRows,
    corr_parallel_slowdown: r3(S.spearman(taskRows.map((t) => t.mean_running), taskRows.map((t) => t.slowdown))),
    corr_parallel_fix: r3(S.spearman(taskRows.map((t) => t.mean_running), taskRows.map((t) => t.fix_rounds))),
    samples: load.length,
    min_free_memory: load.length ? Math.min(...load.map((l) => Number(l.free_memory_pct) || 100)) : null,
    max_running: load.length ? Math.max(0, ...load.map((l) => Number(l.running_tracks) || 0)) : null,
  };
}

const METRICS = ['usd', 'wall_min', 'human_min', 'defects', 'fix_rounds', 'merged'];

/**
 * Matched pair comparison: for every pair with one task in `armA` and one in `armB`, the metric's value in each.
 * Gives the mean difference B - A with a bootstrap CI and (for non-negative metrics) the ratio of totals B / A.
 */
function paired(records, armA, armB, metric = 'usd') {
  if (!METRICS.includes(metric)) throw new Error(`unknown metric ${metric} (known: ${METRICS.join(', ')})`);
  const costs = taskCosts(records);
  const byPair = new Map();
  for (const c of costs) {
    if (!c.pair) continue;
    const p = byPair.get(c.pair) ?? {};
    if (c.arm === armA) p.a = c;
    if (c.arm === armB) p.b = c;
    byPair.set(c.pair, p);
  }
  const pairs = [...byPair.entries()]
    .filter(([, p]) => p.a && p.b)
    .map(([pair, p]) => ({ pair, a: p.a[metric], b: p.b[metric], a_id: p.a.id, b_id: p.b.id }));
  const opt = { B: records.settings?.bootstrap ?? 2000, seed: records.settings?.seed ?? 1 };
  const diff = S.pairedBootstrap(pairs, opt);
  const ratio = S.ratioBootstrap(pairs, opt);
  return {
    metric,
    armA,
    armB,
    pairs: pairs.length,
    complete: diff.n,
    mean_diff: r3(diff.estimate),
    ci: [r3(diff.lo), r3(diff.hi)],
    median_diff: r3(S.median(diff.diffs)),
    ratio: r3(ratio.estimate),
    ratio_ci: [r3(ratio.lo), r3(ratio.hi)],
    sd_diff: r3(S.sd(diff.diffs)),
    rows: pairs,
  };
}

module.exports = { SESSION_TYPES, LEVELS, METRICS, defects, taskCosts, gateStats, armSummary, loadAnalysis, paired };
