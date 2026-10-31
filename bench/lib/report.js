// =============================================================
// report.js: the markdown report for one collected experiment.
//
// Sections: data warnings first (a number with a gap behind it must never look complete), then the arms side by
// side, USD and tokens by session type, gates and load, the paired comparisons with bootstrap CIs, and defects
// after merge. The report names task ids from the measured project, so it is written to the results folder outside
// this repo (bench/lib/paths.js), never into it.
//
// Pure: `render(records)` returns a string. Tested in bench/__tests__/report.test.ts.
// =============================================================
'use strict';

const M = require('./metrics.js');

const fmt = (x, d = 2) => (x == null || !Number.isFinite(Number(x)) ? '-' : Number(x).toFixed(d));
const usd = (x) => (x == null ? '-' : `$${fmt(x)}`);
const pct = (x) => (x == null ? '-' : `${fmt(x * 100, 1)} %`);
const ktok = (x) => (x == null ? '-' : `${fmt(x / 1000, 0)}k`);
const row = (cells) => `| ${cells.join(' | ')} |`;
const table = (head, rows) => [row(head), row(head.map(() => '---')), ...rows.map(row)].join('\n');

function render(records, { comparisons = null } = {}) {
  const arms = M.armSummary(records);
  const load = M.loadAnalysis(records);
  const out = [];
  out.push(`# Benchmark report: ${records.experiment}`, '');
  out.push(`Collected ${records.collected}. Tasks ${records.tasks.length}, sessions ${records.sessions.length}, ` +
    `gate runs ${records.gates.length}, load samples ${records.load.length}.`, '');

  out.push('## Data warnings', '');
  out.push(records.warnings.length ? records.warnings.map((w) => `- ${w}`).join('\n') : '- none', '');

  out.push('## Arms', '');
  out.push(
    table(
      ['Arm', 'Kind', 'Parallel', 'Tasks', 'Merged', 'USD total', 'USD per merged change', 'Overhead share',
        'Wall min (median)', 'Human min per merged', 'Fix rounds', 'Defects per merged', 'Review H+M'],
      arms.map((a) => [a.arm, a.kind, a.maxParallel ?? '-', a.tasks, a.merged, usd(a.usd_total), usd(a.usd_per_merged),
        pct(a.overhead_share), fmt(a.wall_min_median, 0), fmt(a.human_min_per_merged, 1), a.fix_rounds,
        fmt(a.defects_per_merged, 3), a.review_high_medium]),
    ),
    '',
  );
  const models = arms.filter((a) => Object.keys(a.models).length);
  if (models.length) {
    out.push('Models per agent: ' + models.map((a) => `${a.arm} ${JSON.stringify(a.models)}`).join('; '), '');
  }

  out.push('### USD per merged change by class', '');
  const classes = [...new Set(arms.flatMap((a) => Object.keys(a.per_class)))].sort();
  out.push(
    table(['Arm', ...classes], arms.map((a) => [a.arm, ...classes.map((c) => {
      const x = a.per_class[c];
      return x ? `${usd(x.usd_per_merged)} (${x.merged}/${x.tasks})` : '-';
    })])),
    '',
  );

  out.push('## Usage by session type', '');
  out.push(
    table(['Arm', ...M.SESSION_TYPES], arms.map((a) => [a.arm, ...M.SESSION_TYPES.map((t) => usd(a.usd_by_type[t]))])),
    '',
  );
  out.push(
    table(
      ['Arm', 'Type', 'Sessions', 'Input', 'Output', 'Cache read', 'Cache written'],
      arms.flatMap((a) => Object.entries(a.tokens_by_type).map(([t, x]) =>
        [a.arm, t, x.sessions, ktok(x.input), ktok(x.output), ktok(x.cache_read), ktok(x.cache_written)])),
    ),
    '',
  );
  out.push(
    table(['Arm', 'Cache read share', 'Compactions', 'Peak context median', 'Peak context max'],
      arms.map((a) => [a.arm, pct(a.cache_read_share), a.compactions, ktok(a.peak_context_median), ktok(a.peak_context_max)])),
    '',
  );

  out.push('## Gates', '');
  out.push(
    table(['Arm', 'Runs', 'Reruns', 'Rerun share', 'Red', 'Median quick s', 'Median full s', 'Gate s total', 'Rerun s', 'Timeouts'],
      arms.map((a) => { const g = a.gates; return [a.arm, g.runs, g.reruns, pct(g.rerun_share), g.red, fmt(g.median_quick_s, 0),
        fmt(g.median_full_s, 0), fmt(g.gate_seconds, 0), fmt(g.rerun_seconds, 0), g.timeouts]; })),
    '',
  );

  out.push('## System load', '');
  out.push(`Samples ${load.samples}, lowest free memory ${fmt(load.min_free_memory, 1)} %, most running tracks ${load.max_running ?? '-'}.`, '');
  out.push(`Spearman: parallelism vs gate duration ${fmt(load.corr_parallel_duration, 3)}, free memory vs gate duration ` +
    `${fmt(load.corr_free_memory_duration, 3)}, parallelism vs rerun ${fmt(load.corr_parallel_rerun, 3)}, ` +
    `parallelism vs build slowdown (build min per estimated min) ${fmt(load.corr_parallel_slowdown, 3)}, ` +
    `parallelism vs fix rounds ${fmt(load.corr_parallel_fix, 3)}.`, '');
  if (load.buckets.length)
    out.push(table(['Running tracks', 'Gate runs', 'Median s', 'P90 s', 'Rerun share', 'Timeout share'],
      load.buckets.map((b) => [b.level, b.runs, fmt(b.median_s, 0), fmt(b.p90_s, 0), pct(b.rerun_share), pct(b.timeout_share)])), '');

  out.push('## Paired comparisons', '');
  const comps = comparisons ?? defaultComparisons(records);
  if (!comps.length) out.push('No pairs across two arms.', '');
  else {
    out.push(table(['A', 'B', 'Metric', 'Pairs', 'Mean diff B-A', '95 % CI', 'Median diff', 'Ratio B/A', 'Ratio CI'],
      comps.map((c) => [c.armA, c.armB, c.metric, c.complete, fmt(c.mean_diff, 3), `${fmt(c.ci[0], 3)} to ${fmt(c.ci[1], 3)}`,
        fmt(c.median_diff, 3), fmt(c.ratio, 3), `${fmt(c.ratio_ci[0], 3)} to ${fmt(c.ratio_ci[1], 3)}`])), '');
    out.push('A CI that contains 0 (difference) or 1 (ratio) means the experiment cannot tell the arms apart on that metric.', '');
  }

  out.push('## Defects after merge', '');
  const costs = M.taskCosts(records).filter((c) => c.defect_detail && c.defect_detail.count > 0);
  out.push(costs.length
    ? table(['Task', 'Arm', 'Fix tasks', 'Reverts'], costs.map((c) => [c.id, c.arm, c.defect_detail.fixTasks.join(', ') || '-',
      c.defect_detail.reverts.map((s) => s.slice(0, 9)).join(', ') || '-']))
    : 'None found in the window.', '');

  out.push('## Tasks', '');
  out.push(table(['Task', 'Arm', 'Pair', 'Class', 'Outcome', 'USD (with overhead)', 'Own USD', 'Queue USD', 'Wall min', 'Human min', 'Fix', 'Defects'],
    M.taskCosts(records).map((c) => [c.id, c.arm, c.pair ?? '-', c.class ?? '-', c.outcome, usd(c.usd), usd(c.own_usd),
      usd(c.queue_usd), fmt(c.wall_min, 0), fmt(c.human_min, 1), c.fix_rounds, c.defects ?? '-'])), '');
  return out.join('\n');
}

/** Every pair of arms on the main metrics (first arm as A). */
function defaultComparisons(records) {
  const names = records.arms.map((a) => a.name);
  const out = [];
  for (let i = 0; i < names.length; i++)
    for (let j = i + 1; j < names.length; j++)
      for (const metric of ['usd', 'wall_min', 'human_min', 'defects']) {
        const c = M.paired(records, names[i], names[j], metric);
        if (c.complete > 0) out.push(c);
      }
  return out;
}

module.exports = { render, defaultComparisons };
