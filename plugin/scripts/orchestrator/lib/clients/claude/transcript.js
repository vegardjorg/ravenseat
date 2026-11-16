// =============================================================
// clients/claude/transcript.js: where Claude Code keeps its transcripts, and how the queue finds and reads the files
// (roadmap 0w W2a; the fact is transcriptPath.layout in ./facts.js).
//
// The layout (undocumented apart from the hook examples, confirmed 2026-11-16):
//   <home>/.claude/projects/<slug>/<session id>.jsonl                       a main session
//   <home>/.claude/projects/<slug>/<session id>/subagents/agent-<id>.jsonl  a subagent of that session
// where slug is the main tree path with every character outside A-Z, a-z and 0-9 replaced by "-". QUEUE_TRANSCRIPTS
// overrides the folder (tests). CLAUDE_CONFIG_DIR is not read here: the core never read it for transcripts, and
// changing that is a decision of its own, not part of the move.
//
// slug, transcriptsDir, agentTranscriptPath and sessionOfTranscript are pure; findAgentTranscript,
// readAgentTranscript, listSubagents, listTranscripts, readSlice and readTail read the disk and never throw (a read
// error gives null or an empty list, as the callers did before the move).
//
// Why one file: the core had five copies of the folder rule and four of the agent-<id>.jsonl search (cli/ask.mjs,
// cli/events.mjs, cli/tracks.mjs, hook-context.mjs, lib/trackActivity.js) and two more listings of the subagent files
// (cli/cost.mjs, lib/eventStatistics.js); when Claude Code moves the files, fix it here.
// Used through the adapter (lib/clients/claude/index.js transcripts; the core asks clientFor().transcripts). Tested in
// lib/__tests__/claudeTranscript.test.ts and, for the core's behaviour, claudeTranscriptPaths.test.ts.
// =============================================================
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** The subagent file name: agent-<id>.jsonl (the id is everything between). */
const AGENT_FILE = /^agent-(.+)\.jsonl$/;
const SUBAGENTS = 'subagents';

/** The folder name Claude Code gives a project: every character outside A-Z, a-z and 0-9 becomes "-". */
function slug(mainTree) {
  return String(mainTree).replace(/[^A-Za-z0-9]/g, '-');
}

/**
 * The transcripts folder of a main tree: QUEUE_TRANSCRIPTS when it is set (an empty value counts as set, as before),
 * else <home>/.claude/projects/<slug>.
 * @param {string} mainTree
 * @param {{ env?: Record<string, string|undefined>, home?: string }} [o]
 */
function transcriptsDir(mainTree, { env = process.env, home = os.homedir() } = {}) {
  return env.QUEUE_TRANSCRIPTS ?? path.join(home, '.claude', 'projects', slug(mainTree));
}

/** <dir>/<session>/subagents/agent-<id>.jsonl */
function agentTranscriptPath(dir, session, agentId) {
  return path.join(dir, session, SUBAGENTS, `agent-${agentId}.jsonl`);
}

/** The path to an agent's transcript: the first session folder (readdir order) that has it, or null. */
function findAgentTranscript(dir, agentId) {
  let sessions;
  try {
    sessions = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return null; // error-ignored: no transcripts folder, no transcript
  }
  for (const d of sessions) {
    const p = agentTranscriptPath(dir, d.name, agentId);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** The text of an agent's transcript, or null when it is missing, unreadable or larger than maxBytes. */
function readAgentTranscript(dir, agentId, { maxBytes = Infinity } = {}) {
  try {
    const p = findAgentTranscript(dir, agentId);
    if (!p) return null;
    return fs.statSync(p).size > maxBytes ? null : fs.readFileSync(p, 'utf8');
  } catch {
    return null; // error-ignored: the caller falls back to the time log
  }
}

/** The subagent transcripts of one session: [{ agent, file }] in readdir order, empty without a subagents folder. */
function listSubagents(dir, session) {
  let names;
  try {
    names = fs.readdirSync(path.join(dir, session, SUBAGENTS));
  } catch {
    return []; // error-ignored: a session without subagents
  }
  const out = [];
  for (const n of names) {
    const m = AGENT_FILE.exec(n);
    if (m) out.push({ agent: m[1], file: path.join(dir, session, SUBAGENTS, n) });
  }
  return out;
}

/**
 * Every transcript in the folder, in readdir order: a main session { file, session, main: true } and, under a session
 * folder, each subagent { file, session, agent, main: false }. Empty when the folder cannot be read.
 */
function listTranscripts(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return []; // error-ignored: no transcripts folder
  }
  const out = [];
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith('.jsonl')) out.push({ file: path.join(dir, e.name), session: e.name.slice(0, -6), main: true });
    else if (e.isDirectory())
      for (const s of listSubagents(dir, e.name)) out.push({ file: s.file, session: e.name, agent: s.agent, main: false });
  }
  return out;
}

/** The session a subagent transcript belongs to: <root>/<session>/subagents/agent-<id>.jsonl gives <session>. */
function sessionOfTranscript(p) {
  const parts = String(p ?? '').split(/[\\/]+/);
  const i = parts.lastIndexOf(SUBAGENTS);
  return i > 0 ? parts[i - 1] : null;
}

/** `length` bytes of a file from `start` as UTF-8 (a cut multibyte character only spoils one line), or null. */
function readSlice(filePath, start, length) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(length);
    const n = fs.readSync(fd, buf, 0, length, start);
    return buf.subarray(0, n).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd != null) fs.closeSync(fd);
  }
}

/** The last `bytes` of a file: { text, fromStart, size } (fromStart = the whole file was read), or null. */
function readTail(filePath, bytes) {
  try {
    const size = fs.statSync(filePath).size;
    const start = Math.max(0, size - bytes);
    const text = readSlice(filePath, start, size - start);
    return text == null ? null : { text, fromStart: start === 0, size };
  } catch {
    return null;
  }
}

module.exports = {
  slug,
  transcriptsDir,
  agentTranscriptPath,
  findAgentTranscript,
  readAgentTranscript,
  listSubagents,
  listTranscripts,
  sessionOfTranscript,
  readSlice,
  readTail,
};
