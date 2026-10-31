// =============================================================
// fixtures.ts: SYNTHETIC data for the bench tests. Nothing here comes from a real project: ids, times and token
// counts are invented, and they are chosen so the expected numbers are easy to compute by hand.
// =============================================================

export const T0 = Date.parse('2020-01-06T08:00:00.000Z'); // in the past: transcript files are filtered on mtime >= the arm window
export const at = (min: number) => new Date(T0 + min * 60_000).toISOString();

/** One assistant turn as Claude Code writes it in a transcript. */
export function turn(id: string, min: number, usage: Record<string, unknown>, model = 'claude-opus-5-5') {
  return JSON.stringify({ type: 'assistant', timestamp: at(min), message: { id, model, usage, content: [] } });
}

/** A transcript: a mission line naming the task (prompt-<id>.md) and `n` turns of 1M cache read + 1k output each. */
export function transcript(label: string | null, n: number, { startMin = 0, model = 'claude-opus-5-5', compact = 0 } = {}) {
  const lines = [
    JSON.stringify({
      type: 'user',
      timestamp: at(startMin),
      message: { role: 'user', content: label ? `Read prompt-${label}.md and do the work.` : 'Plan the next wave.' },
    }),
  ];
  for (let i = 0; i < n; i++)
    lines.push(turn(`${label ?? 'main'}-${startMin}-${i}`, startMin + i + 1, { input_tokens: 0, output_tokens: 1000, cache_read_input_tokens: 1_000_000 }, model));
  for (let i = 0; i < compact; i++)
    lines.push(JSON.stringify({ type: 'system', subtype: 'compact_boundary', timestamp: at(startMin + n + 1) }));
  return lines.join('\n');
}

// Price of one turn above with the default model: 1M cache read x $0.20 + 1k output x $20 per MTok = $0.22.
export const TURN_USD = 0.22;

/** A synthetic manifest after withDefaults: two arms, two matched pairs. */
export function manifest(extra: Record<string, unknown> = {}) {
  return {
    experiment: 'synthetic',
    arms: [
      { name: 'cq', kind: 'cq', models: {}, maxParallel: 4, sessions: ['orch-1'], window: { from: at(-60), to: at(2000) } },
      { name: 'manual', kind: 'manual-fresh', models: {}, maxParallel: 1, sessions: [], window: { from: at(2000), to: at(5000) } },
    ],
    tasks: [
      { id: 'X-1', label: 'X-1', arm: 'cq', pair: 'p1', stratum: 'K', replay: null, sessions: [], outcome: null },
      { id: 'Y-1', label: 'Y-1', arm: 'manual', pair: 'p1', stratum: 'K', replay: null, sessions: ['chat-y1'], outcome: null },
      { id: 'X-2', label: 'X-2', arm: 'cq', pair: 'p2', stratum: 'D', replay: null, sessions: [], outcome: null },
      { id: 'Y-2', label: 'Y-2', arm: 'manual', pair: 'p2', stratum: 'D', replay: null, sessions: ['chat-y2'], outcome: null },
    ],
    sources: {},
    settings: { seed: 1, bootstrap: 500, defectWindowDays: 14, loadMatchSec: 120, prices: {}, sessionTypes: {} },
    ...extra,
  };
}

/** A synthetic cq-style (English) queue for the manifest above, plus a later fix task for X-2. */
export function queue() {
  return {
    tasks: [
      { id: 'X-1', class: 'K', content_min: 60, status: 'done', started: at(0), delivered: at(40), t_merge: at(55), done: at(55), cost: { usd: 1.1 }, findings: { H: 0, M: 1, L: 2 }, owned_files: ['src/a.ts'] },
      { id: 'X-2', class: 'D', content_min: 40, status: 'done', started: at(10), delivered: at(70), t_merge: at(90), done: at(90), cost: { usd: 2.2 }, owned_files: ['db/b.sql'] },
      { id: 'Y-1', class: 'K', content_min: 60, status: 'done', started: at(2100), delivered: at(2160), done: at(2170), owned_files: ['src/c.ts'] },
      { id: 'Y-2', class: 'D', content_min: 40, status: 'cancelled', started: at(2200), owned_files: ['db/d.sql'] },
      { id: 'X-2-F1', class: 'D', content_min: 20, status: 'waiting', added: at(300), owned_files: ['db/b.sql'] },
      { id: 'OTHER', class: 'K', content_min: 20, status: 'waiting', added: at(300), labels: ['bug'], owned_files: ['src/a.ts'] },
    ],
  };
}

/** Transcripts (already analyzed by the caller) for the manifest above. */
export function transcriptFiles() {
  return [
    { id: 'orch-1', kind: 'main', parent: null, meta: null, text: transcript(null, 10, { startMin: 0, compact: 1 }) },
    { id: 'a1', kind: 'subagent', parent: 'orch-1', meta: { agentType: 'claude-code-queue:track' }, text: transcript('X-1', 5, { startMin: 1 }) },
    { id: 'a2', kind: 'subagent', parent: 'orch-1', meta: { agentType: 'track-d' }, text: transcript('X-2', 10, { startMin: 11 }) },
    { id: 'a3', kind: 'subagent', parent: 'orch-1', meta: { agentType: 'reviewer' }, text: transcript('X-2', 2, { startMin: 71 }) },
    { id: 'a4', kind: 'subagent', parent: 'orch-1', meta: { agentType: 'track-d' }, text: transcript('X-2-r2', 3, { startMin: 75 }) },
    { id: 'chat-y1', kind: 'main', parent: null, meta: null, text: transcript('Y-1', 8, { startMin: 2100 }) },
    { id: 'chat-y2', kind: 'main', parent: null, meta: null, text: transcript('Y-2', 4, { startMin: 2200 }) },
  ];
}

/** Gate run rows in the Norwegian time log format, and English ones, mixed. */
export function timeRows() {
  return [
    { tid: at(30), bolge: 'ko', spor: 'X-1', hendelse: 'gater', varighet_s: 100, modus: 'rask', gronn: false, omkjoring_nr: 0, samtidige_gater: 2, ledig_minne_pct: 40 },
    { tid: at(35), bolge: 'ko', spor: 'X-1', hendelse: 'gater', varighet_s: 120, modus: 'rask', gronn: true, omkjoring_nr: 1, samtidige_gater: 2, ledig_minne_pct: 35 },
    { time: at(60), wave: 'q', track: 'X-2', event: 'gates', duration_s: 600, mode: 'quick', green: true, rerun_nr: 0, concurrent_gates: 10, free_memory_pct: 8 },
    { time: at(61), wave: 'q', track: 'X-2', event: 'gate', gate: 'test', status: 'TIMEOUT', duration_s: 300 },
  ];
}

/** Load samples matching the gate times above. */
export function loadRows() {
  return [
    { time: at(30), free_memory_pct: 40, cpu_pct: 30, running_tracks: 2, node_processes: 10 },
    { time: at(35), free_memory_pct: 35, cpu_pct: 40, running_tracks: 2, node_processes: 12 },
    { time: at(60), free_memory_pct: 8, cpu_pct: 95, running_tracks: 10, node_processes: 60 },
    { time: at(61), free_memory_pct: 7, cpu_pct: 97, running_tracks: 10, node_processes: 61 },
  ];
}
