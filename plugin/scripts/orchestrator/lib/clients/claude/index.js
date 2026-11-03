// =============================================================
// clients/claude/index.js: the Claude Code adapter. Turns a mission descriptor (lib/logic/missionDescriptor.js) into
// what the orchestrator session starts a track with: the Agent tool call (subagent_type, model, message), the
// queue-fill.json entry, the fill, start and resume lines and the "same turn" block.
//
// The output is byte-identical to the Claude flow before the adapter split (locked by claudeDispatchCompat.test.ts).
// The Claude facts themselves (agent names, model list, message text) live in ./dispatch.js and the mission text
// pieces in ./mission.js, each with source and date.
//
// Used by lib/clients/index.js (the registry). Tested in lib/__tests__/clientContract.test.ts and
// claudeDispatchCompat.test.ts.
// =============================================================
'use strict';

const D = require('./dispatch.js');
const { fillRecord } = require('../../logic/missionDescriptor.js');

/**
 * What Claude Code gives the queue, as data (the core asks these, never the client name).
 *   sandbox           false: the queue's guards are hooks, not an OS sandbox around the agent
 *   resume            true: cq resume starts a new agent on the same branch with a round prompt
 *   usage             true: the transcripts carry token usage (lib/timeCost.js)
 *   hooks             true: the plugin's hooks (push, write, read and end guards) run for every agent
 *   cloud             true: cq cloud starts a track as a Claude Code cloud session
 *   structuredOutput  false: the answer is free text with a RESULT line, not a schema
 */
const capabilities = Object.freeze({
  sandbox: false,
  resume: true,
  usage: true,
  hooks: true,
  cloud: true,
  structuredOutput: false,
});

/**
 * The Agent tool call for a track: subagent_type (cq:track in a plugin install, track in a vendored one), the model
 * (the descriptor's when it is one the Agent tool takes, otherwise config().models; null = the agent file's) and the
 * message that points at the prompt file.
 * @param {ReturnType<typeof import('../../logic/missionDescriptor.js').missionDescriptor>} d
 */
function dispatch(d) {
  const agent = D.agentForEffort(d.effort);
  const own = typeof d.model === 'string' && D.AGENT_MODELS.includes(d.model) ? d.model : null;
  return {
    subagent_type: require('../../projectRoot.js').agentRef(agent),
    model: own ?? D.modelFor(agent),
    prompt: d.prompt_file,
    message: D.trackMessage(d.track_id, d.prompt_file),
  };
}

/** The queue-fill.json entry: the neutral fields with the Claude ones in between, in the order skills have read. */
function fillEntry(d) {
  const r = fillRecord(d);
  const x = dispatch(d);
  return {
    id: r.id,
    class: r.class,
    subagent_type: x.subagent_type,
    model: x.model,
    prompt: r.prompt,
    message: x.message,
    branch: r.branch,
    migr_block: r.migr_block,
    new: r.new,
    warning: r.warning,
  };
}

/** The agent part of fill's line per track: "subagent_type=cq:track" plus "  model=sonnet" when one is set. */
function agentLabel(d) {
  const x = dispatch(d);
  return `subagent_type=${x.subagent_type}${x.model ? `  model=${x.model}` : ''}`;
}

/** The agent line `cq start` prints (the thinking level comes from the agent file the effort picks). */
function startLine(d) {
  const x = dispatch(d);
  return `Agent: subagent_type ${x.subagent_type}${x.model ? ` · model=${x.model}` : ''} (thinkingLevel ${d.effort}).`;
}

/** The agent line `cq resume` prints: the agent and the message for the round prompt. */
function resumeLine(d) {
  const x = dispatch(d);
  return `Agent: subagent_type ${x.subagent_type}${x.model ? ` · model=${x.model}` : ''}, message: ${x.message}`;
}

module.exports = {
  id: 'claude',
  capabilities,
  dispatch,
  fillEntry,
  agentLabel,
  startLine,
  resumeLine,
  // The agents for one orchestrator turn: tracks from dispatch and the Claude helpers (reviewers, triage).
  sameTurnBlock: D.sameTurnBlock,
  // The Claude pieces of the mission text (tool names, how to report, context advice): ./mission.js.
  missionAddendum: require('./mission.js').missionAddendum,
};
