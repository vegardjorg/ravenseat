// =============================================================
// clients/claude/dispatch.js: the Claude Code facts for starting a track: agent names, the model list, the agent
// message and the "Start these in the SAME turn" block.
//
// agentTypeFor, agentForEffort, AGENT_MODELS, modelFor, modelPart, trackMessage, SAME_TURN and sameTurnBlock.
//
// Source: the Claude flow as it was in lib/logic/agents.js and lib/logic/merge.js before the client adapter split,
// the agent files agents/track.md and agents/track-d.md (their frontmatter sets the effort), and the Claude Code
// subagent docs (https://docs.claude.com/en/docs/claude-code/sub-agents: the Agent tool takes subagent_type, model
// and the message). Verified 2026-11-03 (plans: client adapters, "Verifiserte fakta" 4 and 5). When Claude Code
// changes a name or the model list, fix it here and only here.
//
// Pure apart from reading the config (cfg) and the install mode (lib/projectRoot.js agentRef: cq:track in a plugin
// install, track in a vendored one).
// Used by clients/claude/index.js (the adapter) and lib/logic/agents.js (re-exports for the queueLogic.js facade).
// Tested in lib/__tests__/queueOrchestrator.test.ts, queueModels.test.ts (through queueLogic.js),
// clientContract.test.ts and claudeDispatchCompat.test.ts.
// =============================================================
'use strict';

const { cfg } = require('../../logic/base.js');
const { effortFor } = require('../../logic/missionDescriptor.js');

/** The agent for an effort: high on `track-d`, medium on `track` (the agent files set the thinking level). */
function agentForEffort(effort) {
  return effort === 'high' ? 'track-d' : 'track';
}

/** The agent type for a track by class: D and D+ on `track-d` (high), K and U on `track` (medium). */
function agentTypeFor(cls) {
  return agentForEffort(effortFor(cls));
}

/** The models the Agent tool takes (config().models). */
const AGENT_MODELS = ['opus', 'sonnet', 'haiku', 'fable'];

/**
 * The model set for an agent in config().models, or null (the agent file's own model). An unknown value counts as
 * not set, so a typo never starts an agent with a model the Agent tool refuses.
 * @param {string} agent the agent name without the plugin prefix (track, reviewer-docs ...)
 */
function modelFor(agent) {
  let m;
  try {
    m = cfg().models?.[String(agent ?? '').replace(/^[^:]+:/, '')];
  } catch {
    return null; // no config: the agent file decides
  }
  const v = typeof m === 'string' ? m.trim().toLowerCase() : null;
  return v && AGENT_MODELS.includes(v) ? v : null;
}

/** " · model=sonnet" for a start line when the agent has a model set, otherwise "". */
function modelPart(agent) {
  const m = modelFor(agent);
  return m ? ` · model=${m}` : '';
}

/**
 * The short message the orchestrator starts the track agent with; the mission is in the prompt file. "track <id>" and
 * "prompt-<id>.md" in the text are what timeCost.trackFromText recognizes the track by (the cost per task).
 */
function trackMessage(id, promptPath) {
  return (
    `You are track ${id} in the work queue (continuous queue, wave "queue"). Your mission is in ${promptPath} and is ` +
    'binding: read it first and follow the protocol there. Your answer to the orchestrator is at most approx. 1,500 characters: ' +
    'RESULT line first, at most 5 lines, then the path to report.md (the long version is there).'
  );
}

const SAME_TURN = 'Start these in the SAME turn:';

/**
 * The agent list the orchestrator starts in ONE turn (in parallel): one line per agent with subagent_type and the message
 * (the track message mentions the prompt file; a reviewer gets the content of the prompt file as the message).
 * `bare: true` keeps the name as it is: a custom helper lives in the project's .claude/agents/, never under the
 * plugin's prefix. An agent that carries `model` (a track from dispatch) shows that model; the others (reviewers,
 * triage helpers) get the one config().models sets for their type.
 * @param {{ subagent_type: string, prompt: string, message?: string|null, bare?: boolean, model?: string|null }[]} agents
 */
function sameTurnBlock(agents) {
  if (!agents?.length) return [];
  const ref = (x) => (x.bare ? x.subagent_type : require('../../projectRoot.js').agentRef(x.subagent_type));
  const part = (x) => ('model' in x ? (x.model ? ` · model=${x.model}` : '') : modelPart(x.subagent_type));
  return [
    SAME_TURN,
    ...agents.map((x) =>
      x.message
        ? `  subagent_type=${ref(x)}${part(x)} · message: ${x.message}`
        : `  subagent_type=${ref(x)}${part(x)} · message: the content of ${x.prompt}`,
    ),
  ];
}

module.exports = {
  agentForEffort,
  agentTypeFor,
  AGENT_MODELS,
  modelFor,
  modelPart,
  trackMessage,
  SAME_TURN,
  sameTurnBlock,
};
