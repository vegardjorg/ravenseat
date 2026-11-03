// =============================================================
// logic/missionDescriptor.js: the client-neutral mission descriptor that fill, start and resume build for a track
// BEFORE any client format.
//
// missionDescriptor (task -> descriptor), effortFor (class -> effort), fillRecord (the neutral queue-fill.json fields)
// and EXPECTS (what the queue expects back from every track).
//
// Why: the client adapters (lib/clients/<client>/) turn ONE neutral description of a mission into their own format
// (for Claude: subagent_type, model, the agent message and the "same turn" block). The core never builds a client
// format itself, so a new client is a new adapter, not a change in cli/run.mjs (plans: client adapters, "Kontrakt").
//
// Everything here is pure: the task and the paths in, a plain object out. No config, no files, no git.
// Used by cli/run.mjs (fill, start, resume) and lib/clients/<client>/ (the adapters read the descriptor).
// Tested in lib/__tests__/missionDescriptor.test.ts and, through the Claude output, claudeDispatchCompat.test.ts.
// =============================================================
'use strict';

/** What the queue expects back from every track: report.md, handover.md and the RESULT line. */
const EXPECTS = Object.freeze(['report', 'handover', 'result']);

/**
 * The thinking effort for a class: D and D+ are high, K and U medium. The adapter maps it to its own setting (Claude:
 * the agent `track-d` for high, `track` for medium).
 * @param {string} cls the task class (K, D, D+, U)
 */
function effortFor(cls) {
  return cls === 'D' || cls === 'D+' ? 'high' : 'medium';
}

/**
 * The mission descriptor for a track. The optional fields (worktree, model, sandbox, attempt_id) are left out when
 * they are not given, so the descriptor only says what is known. `attempt_id` comes with the attempt model (phase 1).
 * @param {object} task the queue task (id, class, branch, migr_block ...)
 * @param {{ client: string, trackId?: string, role?: string, branch?: string|null, promptFile?: string|null, baseSha?: string|null,
 *   worktree?: string|null, isNew?: boolean, warning?: boolean, model?: string|null, sandbox?: string|null,
 *   attemptId?: string|null }} o
 *   `client` is the adapter id (lib/clients/index.js clientFor resolves it). `trackId` is the track label, `<id>` for
 *   a start and `<id>-r<N>` for a resume round (the report folder and the agent message use it).
 */
function missionDescriptor(task, o) {
  const opt = (key, v) => (v == null ? {} : { [key]: v });
  return {
    task_id: task.id,
    ...opt('attempt_id', o.attemptId),
    track_id: o.trackId ?? task.id,
    role: o.role ?? 'track',
    client: o.client,
    class: task.class,
    ...opt('worktree', o.worktree),
    branch: o.branch ?? task.branch ?? null,
    base_sha: o.baseSha ?? null,
    prompt_file: o.promptFile ?? null,
    expects: [...EXPECTS],
    ...opt('model', o.model),
    effort: effortFor(task.class),
    ...opt('sandbox', o.sandbox),
    migr_block: task.migr_block ?? null,
    new: o.isNew ?? true,
    warning: !!o.warning,
  };
}

/**
 * The neutral fields of one queue-fill.json track entry (the head is the file's own top-level field, from base_sha).
 * The adapter adds its own fields (Claude: subagent_type, model, message) in its fillEntry.
 * @param {ReturnType<typeof missionDescriptor>} d
 */
function fillRecord(d) {
  return {
    id: d.task_id,
    class: d.class,
    prompt: d.prompt_file,
    branch: d.branch,
    migr_block: d.migr_block,
    new: d.new,
    warning: d.warning,
  };
}

module.exports = { EXPECTS, effortFor, missionDescriptor, fillRecord };
