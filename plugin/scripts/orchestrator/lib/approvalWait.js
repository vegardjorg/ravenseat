// =============================================================
// approvalWait.js: a track that stands still on a permission prompt (blocked on the owner's approval).
//
// THE SIGNAL: Claude Code's Notification hook fires with `notification_type: "permission_prompt"` when a tool call waits
// for approval, also when the call is a background subagent's (tested 2026-11-08: about 6 s after the call, sent to the
// MAIN session's hooks). The input has no agent_id, so hook-approval-wait.mjs finds the agent itself: the subagent
// transcript (<session>/subagents/agent-<id>.jsonl) whose last tool call has no result yet. Only the agent id, the tool
// name and the time are kept, never the prompt text or anything from the conversation.
//
// THE FILE: <dataFolder>/approval-waits.json, { "<agent_id>": { at, tool } }. The board shows a wait as long as the
// agent's transcript has not been written since (an approval or a refusal writes the tool result), and drops one older
// than MAX_AGE_MS. Nothing here blocks or changes the agent.
//
// The transcript rows and the subagent file names are read through the client adapter (clientFor().entries and
// .transcripts, 0w W2b1), never directly.
// Kept apart from queueLogic.js, so the hook loads next to nothing. Used by: hook-approval-wait.mjs, queue-board.mjs.
// =============================================================

const fs = require('node:fs');
// The 'approval-waits' family of the storage layer (lib/store/families.js): written through FileBackend (sync, no lock:
// the hook path stays fast; the read-modify-write race is plan step 6).
const FB = require('./store/fileBackend.js');
const path = require('node:path');

/** The client adapter (0w W2b1): the transcript rows and the subagent file names are its format, read on first use. */
const client = () => require('./clients/index.js').clientFor();

const FILE = 'approval-waits.json';
/** How much of the end of a transcript is read: the last tool call and its result are always near the end. */
const TAIL_BYTES = 64 * 1024;
/** A wait older than this is dropped: a prompt nobody answered for a day is no longer news. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** A transcript written this soon after the notification does not count as an answer (clock and flush slack). */
const SLACK_MS = 1500;
/** The most agents a session can have open at once that are looked at. */
const MAX_AGENTS = 40;

/** The last `bytes` of a file as text, or '' when it cannot be read. */
function readTail(file, bytes = TAIL_BYTES) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** How much of the start of a transcript is read for the mission (the agent's first prompt). */
const HEAD_BYTES = 16 * 1024;

/** The first `bytes` of a file as text, or '' when it cannot be read. */
function readHead(file, bytes = HEAD_BYTES) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * The task an agent works on, from the mission at the start of its transcript (`prompt-<ID>.md` or "track <ID>", the
 * same rule as the time log). Needed because the time log's start row is often written before the transcript exists,
 * and then carries the agent id instead of the task id (seen in the live run of 2026-11-10).
 * @param {string} head the start of the transcript
 * @param {string[]} ids the tasks it can belong to (running or in review)
 * @param {{ trackFromText: Function, taskIdFor: Function }} tc lib/timeCost.js (passed in, so the hook does not load it)
 * @returns {string|null}
 */
function missionTask(head, ids, { trackFromText, taskIdFor }) {
  const track = trackFromText(head);
  if (!track) return null;
  const known = new Set(ids);
  return taskIdFor(track, (x) => known.has(x));
}

/**
 * The tool call at the end of a transcript that has no result yet, or null. Reads the JSONL lines (a first line cut by
 * the tail is skipped) and pairs `tool_use` ids with `tool_result.tool_use_id`.
 * @returns {{ tool: string, id: string } | null}
 */
function pendingToolUse(text) {
  const E = client().entries;
  const open = new Map();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const j = E.parse(line);
    if (j === undefined) continue;
    // Any row with a content list (the call is the assistant's, the result the user's), in the adapter's parts.
    const { parts } = E.entry(j);
    if (!parts) continue;
    for (const p of parts) {
      if (p.kind === 'tool' && p.id) open.set(p.id, String(p.name ?? '?'));
      else if (p.kind === 'result' && p.id) open.delete(p.id);
    }
  }
  const last = [...open.entries()].at(-1);
  return last ? { id: last[0], tool: last[1] } : null;
}

/** The session's subagent transcript folder from the main transcript path (<root>/<session>.jsonl → <root>/<session>/subagents). */
function subagentDir(transcriptPath) {
  if (!transcriptPath) return null;
  return client().transcripts.subagentsDirOf(transcriptPath);
}

/** An agent id as the board keeps it: letters, digits, _ and - only (another file name is not an agent of ours). */
const AGENT_ID = /^[A-Za-z0-9_-]+$/;

/** The agent id of a file in the subagents folder, or null. */
function agentOfFile(name) {
  const id = client().transcripts.agentOfFile(name);
  return id !== null && AGENT_ID.test(id) ? id : null;
}

/**
 * The agents in a session that wait on a tool call: newest transcript first, at most MAX_AGENTS looked at.
 * @returns {{ agent_id: string, tool: string }[]}
 */
function waitingAgents(dir, { readTail: tail = readTail } = {}) {
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => agentOfFile(n) !== null);
  } catch {
    return [];
  }
  const withTime = names
    .map((n) => {
      try {
        return { n, ms: fs.statSync(path.join(dir, n)).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.ms - a.ms)
    .slice(0, MAX_AGENTS);
  const out = [];
  for (const { n } of withTime) {
    const p = pendingToolUse(tail(path.join(dir, n)));
    if (p) out.push({ agent_id: agentOfFile(n), tool: p.tool });
  }
  return out;
}

/** The saved waits ({} when the file is missing or unreadable). */
function read(folder) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(folder, FILE), 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  } catch {
    return {};
  }
}

/** The waits with the new ones added, the ones older than MAX_AGE_MS dropped. */
function merge(waits, found, now = Date.now()) {
  const out = {};
  for (const [id, w] of Object.entries(waits ?? {})) {
    const t = Date.parse(w?.at ?? '');
    if (Number.isFinite(t) && now - t < MAX_AGE_MS) out[id] = w;
  }
  for (const f of found ?? []) out[f.agent_id] = { at: new Date(now).toISOString(), tool: f.tool };
  return out;
}

/** Writes the file whole (a temp file and a rename, so the board never reads half a file; the tmp removed on a failure). */
function write(folder, waits) {
  FB.writeJson(path.join(folder, FILE), waits);
}

/**
 * The tasks that wait on an approval now: a saved wait whose agent belongs to a running task (`agentTask`, from the time
 * log) and whose transcript has not been written since the notification.
 * @param {Record<string, {at: string, tool: string}>} waits
 * @param {{ agentTask: Map<string, string>, taskOf?: (agentId: string) => string|null,
 *   mtimeOf: (agentId: string) => number|null, now?: number }} io  taskOf: the fallback when the time log has no task
 *   for the agent (missionTask on the transcript's start)
 * @returns {{ id: string, tool: string, since: string }[]} one row per task, the oldest wait
 */
function waitingTasks(waits, { agentTask, taskOf = () => null, mtimeOf, now = Date.now() }) {
  const perTask = new Map();
  for (const [agentId, w] of Object.entries(waits ?? {})) {
    const id = agentTask.get(agentId) ?? taskOf(agentId);
    const t = Date.parse(w?.at ?? '');
    if (!id || !Number.isFinite(t) || now - t >= MAX_AGE_MS) continue;
    const m = mtimeOf(agentId);
    if (m != null && m > t + SLACK_MS) continue; // answered: the tool result (or anything later) was written
    const prev = perTask.get(id);
    if (!prev || Date.parse(prev.since) > t) perTask.set(id, { id, tool: String(w.tool ?? '?'), since: w.at });
  }
  return [...perTask.values()].sort((a, b) => a.id.localeCompare(b.id));
}

module.exports = {
  FILE,
  MAX_AGE_MS,
  SLACK_MS,
  readTail,
  readHead,
  missionTask,
  pendingToolUse,
  subagentDir,
  waitingAgents,
  read,
  merge,
  write,
  waitingTasks,
};
