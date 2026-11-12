// =============================================================
// agentGuard.js: which agent types the queue's agent guards apply to (owner decision B3, 2026-11-12).
//
// Why: the push, network, queue CLI and write guards used to apply only to the agent types on a list (track, track-d,
// the reviewers and helpers, trackGuard.queueAgentTypes()). A general-purpose or Explore agent the orchestrator started,
// or the user's own subagent, got none of them (review 2026-11-11, S7). Now every non-empty agent_type is guarded, with
// an exception list for the types the owner names.
//
// The setting (queue.config.json, lib/settingsRegistry.js, category Agent guards):
//   agentGuard.enabled  true (default): every subagent is guarded. false: only the queue's own types (as before B3).
//   agentGuard.except   [] (default): agent types that are not guarded, compared without case, with or without a
//                       plugin prefix ("general-purpose", "myplugin:helper").
// Both are a weakened guard when changed (doctor: AGENT GUARD OFF, and one INFO line per exception).
//
// The floor: the queue's own agent types (track, track-d, every shipped agent, the reviewers and helpers) are always
// guarded. Neither `enabled: false` nor `except` can take them out, so nothing is weaker than it was before B3.
//
// The main session: it has no agent_type and is never guarded. A main session started with `claude --agent <name>` has
// an agent_type but no agent_id (Claude Code sends agent_id only inside a subagent), so the hooks pass
// `subagent: Boolean(agent_id)` and such a session is not guarded unless its type is one of the queue's own. Callers
// that do not know (pure tests) leave `subagent` out, which counts as a subagent.
//
// Pure, no I/O. Tested in lib/__tests__/agentGuard.test.ts.
// =============================================================
'use strict';

/** The defaults (the same values as STANDARD.agentGuard in lib/queueConfig.js). */
const DEFAULTS = Object.freeze({ enabled: true, except: Object.freeze([]) });

/** Always guarded, whatever the config says. */
const TRACK_TYPES = Object.freeze(['track', 'track-d']);

/** The agent type without any plugin prefix ("ravenseat:reviewer" -> "reviewer"), lower case; '' for none. */
const bare = (agentType) => String(agentType ?? '').replace(/^.*:/, '').trim().toLowerCase();

/**
 * The policy from a config (config() or its agentGuard part): { enabled, except } with except as lower-case strings.
 * Anything malformed reads as the default (guarded), never as off.
 * @param {object|null|undefined} k  config() or { agentGuard }
 */
function policyOf(k) {
  const own = k && typeof k === 'object' ? (k.agentGuard ?? k) : {};
  const g = own && typeof own === 'object' && !Array.isArray(own) ? own : {};
  const except = Array.isArray(g.except)
    ? g.except.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim().toLowerCase())
    : [];
  return { enabled: g.enabled !== false, except };
}

/** Is this agent type on the exception list (the full name or the bare one)? */
function isExcepted(agentType, except) {
  const full = String(agentType ?? '').trim().toLowerCase();
  const b = bare(agentType);
  return (except ?? []).some((x) => {
    const e = String(x).toLowerCase();
    return e === full || e === b;
  });
}

/**
 * Is this agent guarded?
 * @param {string|null|undefined} agentType  the hook payload's agent_type
 * @param {{ queueTypes?: Set<string>|string[], policy?: { enabled?: boolean, except?: string[] }, subagent?: boolean }} [o]
 *   queueTypes: the queue's own types beyond track/track-d (trackGuard.queueAgentTypes()), always guarded;
 *   policy: policyOf(config()), default DEFAULTS; subagent: false for a main session started with --agent.
 */
function isGuarded(agentType, { queueTypes, policy, subagent } = {}) {
  const t = bare(agentType);
  if (!t) return false;
  if (TRACK_TYPES.includes(t)) return true;
  const own = new Set([...(queueTypes ?? [])].map((x) => bare(x)));
  if (own.has(t)) return true;
  const p = policyOf({ agentGuard: policy ?? DEFAULTS });
  if (!p.enabled) return false;
  if (subagent === false) return false;
  return !isExcepted(agentType, p.except);
}

/**
 * The doctor lines for the setting (lib/settingsView.js doctorRows): a WARN when it is off, an INFO per exception.
 * @param {object} k config()
 * @returns {{ status: 'WARN'|'INFO', message: string, fix: string|null }[]}
 */
function doctorLines(k, cli = 'ravenseat') {
  const p = policyOf(k);
  const out = [];
  if (!p.enabled)
    out.push({
      status: 'WARN',
      message:
        'AGENT GUARD OFF (agentGuard.enabled: false): agent types outside the queue\'s own (your own subagents, builtins ' +
        'like general-purpose) have no push, network or write guard',
      fix: `fine in your own sandbox; turn it back on with ${cli} settings set agentGuard.enabled on`,
    });
  else
    for (const e of p.except)
      out.push({
        status: 'INFO',
        message: `agentGuard.except: ${e} has no push, network or write guard (the queue's own agent types stay guarded)`,
        fix: null,
      });
  return out;
}

module.exports = { DEFAULTS, TRACK_TYPES, bare, policyOf, isExcepted, isGuarded, doctorLines };
