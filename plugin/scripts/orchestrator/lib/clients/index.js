// =============================================================
// clients/index.js: the registry of client adapters (Claude Code today; Codex and Antigravity are planned).
//
// adapters, clientIds, clientFor and sameTurnLines.
//
// Why one file: adding a client is a new folder lib/clients/<client>/ (index.js, its facts with source and date, and
// fixtures/descriptor.json) plus ONE line in ADAPTERS below. The core asks an adapter for its format and its
// capabilities, never for the client name (the gate in lib/__tests__/clientNameGate.test.ts).
//
// Every adapter exports { id, capabilities: { sandbox, resume, usage, hooks, cloud, structuredOutput } (booleans),
// dispatch(descriptor), fillEntry(descriptor), agentLabel(descriptor), startLine(descriptor),
// resumeLine(descriptor), sameTurnBlock(agents), missionAddendum(ctx) }, and optionally continueLine({ agent, message })
// when a fix round can continue the agent that delivered (lib/fixRound.js). lib/__tests__/clientContract.test.ts checks each one.
// Used by cli/run.mjs and lib/logic/merge.js (concurrentBlock).
// =============================================================
'use strict';

/** The adapters. The FIRST one is the default (a task or call without a client). */
const ADAPTERS = Object.freeze([require('./claude/index.js')]);

/** The registered client ids, in registry order. */
function clientIds() {
  return ADAPTERS.map((x) => x.id);
}

/**
 * The adapter for a client id. A missing id (null, undefined, '') is the default client, so old tasks and calls keep
 * today's flow. An unknown id throws, so a typo in a task never starts a track in the wrong format.
 * @param {string|null|undefined} [id]
 */
function clientFor(id) {
  if (id == null || id === '') return ADAPTERS[0];
  const found = ADAPTERS.find((x) => x.id === String(id).trim().toLowerCase());
  if (!found)
    throw new Error(`Unknown client "${id}" (known: ${clientIds().join(', ')}). Fix the task's client field or leave it out.`);
  return found;
}

/**
 * The same-turn lines for a set of tracks plus helper agents: each track's adapter dispatches it, and the helpers
 * (reviewers, triage, which run on the default client) join the default client's group. One block per client in the
 * order the clients first appear; with one client that is today's single block.
 * @param {object[]} descriptors mission descriptors (lib/logic/missionDescriptor.js)
 * @param {object[]} [helpers] helper agents in the default client's own format
 */
function sameTurnLines(descriptors = [], helpers = []) {
  const groups = new Map();
  const add = (adapter, x) => {
    if (!groups.has(adapter)) groups.set(adapter, []);
    groups.get(adapter).push(x);
  };
  for (const d of descriptors) {
    const adapter = clientFor(d.client);
    add(adapter, adapter.dispatch(d));
  }
  for (const h of helpers) add(clientFor(), h);
  return [...groups].flatMap(([adapter, list]) => adapter.sameTurnBlock(list));
}

module.exports = { adapters: ADAPTERS, clientIds, clientFor, sameTurnLines };
