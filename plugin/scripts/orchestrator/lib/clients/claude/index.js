// =============================================================
// clients/claude/index.js: the Claude Code adapter. Turns a mission descriptor (lib/logic/missionDescriptor.js) into
// what the orchestrator session starts a track with: the Agent tool call (subagent_type, model, message), the
// queue-fill.json entry, the fill, start and resume lines and the "same turn" block.
//
// The output is byte-identical to the Claude flow before the adapter split (locked by claudeDispatchCompat.test.ts).
// The Claude facts themselves (agent names, model list, message text) live in ./dispatch.js and the mission text
// pieces in ./mission.js, each with source and date. The transcript paths (folder, slug, agent files) live in
// ./transcript.js, exposed as transcripts, the hook and status line payloads in ./hookInput.js, exposed as hooks, and
// one transcript row as the event the core reads (usage, content blocks, handback, compaction, API error) in
// ./entries.js, exposed as entries (W2b1). The format canary (W4: unknown row types, a newer version, turns without
// usage, unknown API errors, no content) is ./canary.js, exposed as canary.
//
// Each part is loaded the first time it is used (W2c): the hooks that run on every tool call ask the registry for
// hooks, and must not pay for dispatch.js and lib/logic/base.js, which they never call (lib/__tests__/hookWeight.test.ts).
//
// Used by lib/clients/index.js (the registry). Tested in lib/__tests__/clientContract.test.ts and
// claudeDispatchCompat.test.ts.
// =============================================================
'use strict';

/** ./dispatch.js, loaded on first use. */
let dispatchFacts = null;
const D = () => (dispatchFacts ??= require('./dispatch.js'));

/**
 * What Claude Code gives the queue, as data (the core asks these, never the client name).
 *   sandbox           false: the queue's guards are hooks, not an OS sandbox around the agent
 *   resume            true: ravenseat resume starts a new agent on the same branch with a round prompt
 *   usage             true: the transcripts carry token usage (lib/timeCost.js)
 *   hooks             true: the plugin's hooks (push, write, read and end guards) run for every agent
 *   cloud             true: ravenseat cloud starts a track as a Claude Code cloud session
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
 * The Agent tool call for a track: subagent_type (ravenseat:track in a plugin install, track in a vendored one), the model
 * (the descriptor's when it is one the Agent tool takes, otherwise config().models; null = the agent file's) and the
 * message that points at the prompt file.
 * @param {ReturnType<typeof import('../../logic/missionDescriptor.js').missionDescriptor>} d
 */
function dispatch(d) {
  const agent = D().agentForEffort(d.effort);
  const own = typeof d.model === 'string' && D().AGENT_MODELS.includes(d.model) ? d.model : null;
  return {
    subagent_type: require('../../projectRoot.js').agentRef(agent),
    model: own ?? D().modelFor(agent),
    prompt: d.prompt_file,
    message: D().trackMessage(d.track_id, d.prompt_file),
  };
}

/** The queue-fill.json entry: the neutral fields with the Claude ones in between, in the order skills have read. */
function fillEntry(d) {
  const r = require('../../logic/missionDescriptor.js').fillRecord(d);
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

/** The agent part of fill's line per track: "subagent_type=ravenseat:track" plus "  model=sonnet" when one is set. */
function agentLabel(d) {
  const x = dispatch(d);
  return `subagent_type=${x.subagent_type}${x.model ? `  model=${x.model}` : ''}`;
}

/** The agent line `ravenseat start` prints (the thinking level comes from the agent file the effort picks). */
function startLine(d) {
  const x = dispatch(d);
  return `Agent: subagent_type ${x.subagent_type}${x.model ? ` · model=${x.model}` : ''} (thinkingLevel ${d.effort}).`;
}

/** The agent line `ravenseat resume` prints: the agent and the message for the round prompt. */
function resumeLine(d) {
  const x = dispatch(d);
  return `Agent: subagent_type ${x.subagent_type}${x.model ? ` · model=${x.model}` : ''}, message: ${x.message}`;
}

module.exports = {
  id: 'claude',
  // Optional: a fix round can continue the agent that delivered (lib/fixRound.js). An adapter without it always gets a
  // new agent for a fix round.
  get continueLine() {
    return D().continueLine;
  },
  capabilities,
  dispatch,
  fillEntry,
  agentLabel,
  startLine,
  resumeLine,
  // The agents for one orchestrator turn: tracks from dispatch and the Claude helpers (reviewers, triage).
  get sameTurnBlock() {
    return D().sameTurnBlock;
  },
  // The Claude pieces of the mission text (tool names, how to report, context advice): ./mission.js.
  get missionAddendum() {
    return require('./mission.js').missionAddendum;
  },
  // Where the transcripts live and how the core finds and reads them (folder, slug, agent files, tail): ./transcript.js.
  get transcripts() {
    return require('./transcript.js');
  },
  // The hook and status line payloads in the core's names, and the hook answers: ./hookInput.js.
  get hooks() {
    return require('./hookInput.js');
  },
  // One transcript row as the event the core reads (usage, content blocks, handback, compaction, API error): ./entries.js.
  get entries() {
    return require('./entries.js');
  },
  // The format canary (W4): what the last rows of a transcript hold that the adapter does not expect, no content: ./canary.js.
  get canary() {
    return require('./canary.js');
  },
  // Which tool calls are real work and which are bookkeeping, waiting or reads (SPINNING, lib/trackSpin.js): ./work.js.
  get work() {
    return require('./work.js');
  },
};
