// =============================================================
// writeGuard.js: the write guard for the queue's trusted state files (hook-write-guard.mjs, PreToolUse on
// Write|Edit|NotebookEdit). See docs/orchestration.md.
//
// Why: the gate evidence store (lib/gateEvidence.js) is what `ravenseat push-check` and `ravenseat receive` trust for "the gates were
// green on this sha", and queue.json / base-health.json are what ravenseat merge trusts for status and a red base. A queue
// agent writes them only through the CLI (gates.mjs, queue.mjs), never with the file tools. The hook makes a direct
// Write, Edit or NotebookEdit by a track or a review agent fail with a reason instead of relying on the mission text.
//
// Protected (PROTECTED):
//   - gate-evidence.json and its temporary files (gate-evidence.json.<n>.tmp), ANYWHERE: no track needs such a file.
//   - queue.json, base-health.json and git-surface.json in the data folder only (a project may have its own queue.json elsewhere).
// Guarded agents: track and track-d always, plus the given types (trackGuard.queueAgentTypes(): the reviewers and
// helpers). The orchestrator (no agent_type) and other agent types are never stopped.
//
// Limits, on purpose: Bash can still write the files (the push guard and the tamper checks in gateEvidence.js cover the
// likely paths); this is a guard against mistakes and casual forgery, not a security boundary.
// Pure, no I/O. Tested in lib/__tests__/writeGuard.test.ts.
// =============================================================
'use strict';

const path = require('node:path');

/** The file names the guard protects: where, and what the denial says. */
const PROTECTED = Object.freeze([
  { re: /^gate-evidence\.json(?:\..*)?$/i, anywhere: true, what: 'the gate evidence store', how: 'only gates.mjs writes it (ravenseat gates)' },
  { re: /^queue\.json(?:\..*\.tmp)?$/i, anywhere: false, what: 'the queue', how: 'change it with the ravenseat commands (ravenseat report, ravenseat status ...)' },
  { re: /^base-health\.json(?:\..*\.tmp)?$/i, anywhere: false, what: 'the base health', how: 'only ravenseat merge and the base gate write it' },
  { re: /^git-surface\.json(?:\..*\.tmp)?$/i, anywhere: false, what: 'the accepted git baseline', how: 'only the owner changes it (ravenseat surface accept --by owner)' },
]);

/** Always guarded, whatever the config says. */
const ALWAYS = ['track', 'track-d'];

const bare = (t) => (typeof t === 'string' && t ? t.replace(/^ravenseat:/, '') : null);
const norm = (p) => {
  const r = path.resolve(String(p));
  return process.platform === 'win32' ? r.toLowerCase() : r;
};

/** The file a Write, Edit or NotebookEdit call targets, or null. */
function targetPath(toolInput) {
  const ti = toolInput && typeof toolInput === 'object' ? toolInput : {};
  for (const k of ['file_path', 'notebook_path']) if (typeof ti[k] === 'string' && ti[k]) return ti[k];
  return null;
}

/**
 * The denial for one write, or null (let through).
 * @param {{ agentType: string|null, filePath: string, folder: string, guardedTypes?: Set<string> }} x
 * @returns {{ reason: string } | null}
 */
function assessWrite({ agentType, filePath, folder, guardedTypes = new Set() }) {
  const type = bare(agentType);
  if (!type || !filePath) return null;
  if (!ALWAYS.includes(type) && !guardedTypes.has(type)) return null;
  const abs = norm(filePath);
  const name = path.basename(abs);
  const inFolder = folder ? path.dirname(abs) === norm(folder) : false;
  const hit = PROTECTED.find((p) => p.re.test(name) && (p.anywhere || inFolder));
  if (!hit) return null;
  return {
    reason:
      `Write guard: ${path.basename(filePath)} is ${hit.what}, which a queue agent never writes with the file tools; ${hit.how}. ` +
      'Report what you found in your report instead (a track\'s own gate runs are informational; ravenseat receive reruns them).',
  };
}

module.exports = { PROTECTED, targetPath, assessWrite };
