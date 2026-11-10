// =============================================================
// toolTrouble.js: a track whose tool calls auto mode refuses, or that fails the same tool again and again.
//
// THE SIGNALS (Claude Code hooks, docs checked 2026-11-10):
//   - PermissionDenied: auto mode refused a tool call. It does not fire for a "No" in a dialog, a PreToolUse deny or
//     a deny rule. One refusal is worth a card: the track may now work around it or stand still.
//   - PostToolUseFailure: a tool that started failed (a thrown error or an MCP error). An interrupt is left out. One
//     failure is normal work; THREE of the same tool within WINDOW_MS is a card (a track looping on a failing command).
// Both fire inside subagents with agent_id; an event without one is the main session, which the owner already sees.
//
// THE FILE: <dataFolder>/tool-trouble.json, { "<agent_id>": { denied: [{at, tool}], failed: [{at, tool}] } }. Only the
// agent id, the tool name and the time are kept: never the reason, the tool input or the error text (they can hold
// anything the agent read). Events older than WINDOW_MS drop off, and each list keeps the last MAX_EVENTS.
//
// Kept apart from queueLogic.js, so the hook loads next to nothing. Used by: hook-tool-trouble.mjs, queue-board.mjs.
// Tested in __tests__/queueToolTrouble.test.ts.
// =============================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const FILE = 'tool-trouble.json';
/** How long an event counts: trouble an hour old is no longer news on the board. */
const WINDOW_MS = 30 * 60 * 1000;
/** The most events kept per agent and kind. */
const MAX_EVENTS = 20;
/** Failures of the same tool within the window that make a card. */
const FAIL_CARD = 3;
/** The most agents kept in the file (the newest). */
const MAX_AGENTS = 60;

const recent = (list, now) =>
  (Array.isArray(list) ? list : []).filter((e) => {
    const t = Date.parse(e?.at ?? '');
    return Number.isFinite(t) && now - t <= WINDOW_MS;
  });

/**
 * The state with one hook event added. Anything that is not a subagent's refusal or failure leaves it as it is.
 * @param {Record<string, {denied?: {at:string,tool:string}[], failed?: {at:string,tool:string}[]}>} state
 * @param {object} input the hook's stdin
 */
function record(state, input, now = Date.now()) {
  const agent = typeof input?.agent_id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(input.agent_id) ? input.agent_id : null;
  const kind =
    input?.hook_event_name === 'PermissionDenied' ? 'denied' : input?.hook_event_name === 'PostToolUseFailure' ? 'failed' : null;
  if (!agent || !kind || (kind === 'failed' && input.is_interrupt === true)) return state ?? {};
  const tool = String(input.tool_name ?? '?').slice(0, 80);
  const out = {};
  for (const [id, x] of Object.entries(state ?? {})) {
    const d = recent(x?.denied, now);
    const f = recent(x?.failed, now);
    if (d.length || f.length) out[id] = { denied: d, failed: f };
  }
  const cur = out[agent] ?? { denied: [], failed: [] };
  cur[kind] = [...cur[kind], { at: new Date(now).toISOString(), tool }].slice(-MAX_EVENTS);
  delete out[agent];
  out[agent] = cur; // last written goes last, so the cap keeps the newest agents
  const ids = Object.keys(out);
  for (const id of ids.slice(0, Math.max(0, ids.length - MAX_AGENTS))) delete out[id];
  return out;
}

/** The saved state ({} when the file is missing or unreadable). */
function read(folder) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(folder, FILE), 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  } catch {
    return {};
  }
}

/** Writes the file whole (a temp file and a rename, so the board never reads half a file). */
function write(folder, state) {
  fs.mkdirSync(folder, { recursive: true });
  const tmp = path.join(folder, `${FILE}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  fs.renameSync(tmp, path.join(folder, FILE));
}

/**
 * The tasks with tool trouble now. The agent is mapped to its task as for approval waits (lib/approvalWait.js).
 * @returns {{ id: string, denied: {count:number,tool:string,last:string}|null,
 *   failing: {count:number,tool:string,last:string}|null }[]}
 */
function troubleTasks(state, { agentTask, taskOf = () => null, now = Date.now() }) {
  const perTask = new Map();
  for (const [agentId, x] of Object.entries(state ?? {})) {
    const d = recent(x?.denied, now);
    const f = recent(x?.failed, now);
    if (!d.length && !f.length) continue;
    const id = agentTask.get(agentId) ?? taskOf(agentId);
    if (!id) continue;
    const row = perTask.get(id) ?? { id, deniedAll: [], failedAll: [] };
    row.deniedAll.push(...d);
    row.failedAll.push(...f);
    perTask.set(id, row);
  }
  const out = [];
  for (const { id, deniedAll, failedAll } of perTask.values()) {
    const byTime = (a, b) => Date.parse(a.at) - Date.parse(b.at);
    deniedAll.sort(byTime);
    let denied = null;
    if (deniedAll.length) {
      const last = deniedAll.at(-1);
      denied = { count: deniedAll.length, tool: last.tool, last: last.at };
    }
    // The tool that failed most in the window; on a tie the one that failed last.
    const counts = new Map();
    for (const e of failedAll.sort(byTime)) counts.set(e.tool, { count: (counts.get(e.tool)?.count ?? 0) + 1, last: e.at });
    let failing = null;
    for (const [tool, c] of counts)
      if (c.count >= FAIL_CARD && (!failing || c.count > failing.count || (c.count === failing.count && c.last > failing.last)))
        failing = { count: c.count, tool, last: c.last };
    if (denied || failing) out.push({ id, denied, failing });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

module.exports = { FILE, WINDOW_MS, MAX_EVENTS, FAIL_CARD, record, read, write, troubleTasks };
