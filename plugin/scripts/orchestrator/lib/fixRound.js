// =============================================================
// fixRound.js: a fix round as a continuation of the agent that delivered, instead of a new agent.
//
// Why: `ravenseat resume <id> --reason fix` used to write a mission for a NEW agent `<id>-r<N>` that carried the whole
// original mission again, and the new agent built its picture of the track from scratch. When the agent that
// delivered is still addressable and its prompt cache is still warm, sending it only the fix list is much cheaper: it
// already knows the mission, the files and its own commits.
//
// The rule (continuation): reason fix, the client can continue an agent, the task is not a cloud session, the newest
// build agent the time log ties to the task has stopped (not killed), its transcript is found and lies in the bound
// orchestrator session (when one is bound), a worktree still has the branch checked out, it was last active within
// fixRound.continueWithinMin minutes (default 60, 0 = off), and its context at the last stop is under
// fixRound.continueMaxContextK thousand tokens (default 200, 0 = no cap; a track compacts at about 267k, so a fuller
// one would compact soon and lose the cache it was continued for). Last active is the newest of its last time log row
// and its transcript's mtime. Otherwise a new agent, with the reason in the output.
//
// Pure, no I/O: the CLI (cli/run.mjs cmdResume) reads the rows, the transcript and the worktrees and passes them in.
// Tested in lib/__tests__/fixRound.test.ts and, end to end, __tests__/queueFixContinue.test.ts.
// =============================================================
'use strict';

const TK = require('./timeCost.js');

/** The defaults of the fixRound settings (queueConfig.js STANDARD.fixRound holds the same values). */
const DEFAULTS = Object.freeze({ continueWithinMin: 60, continueMaxContextK: 200 });

/** The fixRound settings from the config: numbers >= 0, otherwise the default. */
function fixRoundSetup(config) {
  const own = config?.fixRound ?? {};
  const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d);
  return {
    continueWithinMin: num(own.continueWithinMin, DEFAULTS.continueWithinMin),
    continueMaxContextK: num(own.continueMaxContextK, DEFAULTS.continueMaxContextK),
  };
}

/**
 * The agent that delivered last: the build agent (track, track-d) whose newest row is the newest among the agents the
 * time log ties to the task (the track label `<id>` or a fix round `<id>-r<N>`). A reviewer's label is the task id too,
 * so only build agents count.
 * @returns {null | { agent: string, track: string, lastMs: number, stopped: boolean, killed: boolean, context: number|null }}
 */
function lastTrackAgent(rows, taskId) {
  const byAgent = new Map();
  for (const r of rows ?? []) {
    if (!r?.agent_id || !TK.isBuildAgent(r.agent_type)) continue;
    const t = Date.parse(r.time ?? '');
    if (!Number.isFinite(t)) continue;
    const x = byAgent.get(r.agent_id) ?? { ours: false, track: null, last: null, lastT: -Infinity };
    if (r.track && TK.taskIdFor(r.track, (y) => y === taskId) === taskId) {
      x.ours = true;
      x.track = r.track;
    }
    if (t >= x.lastT) {
      x.last = r;
      x.lastT = t;
    }
    byAgent.set(r.agent_id, x);
  }
  let best = null;
  for (const [agent, x] of byAgent) {
    if (!x.ours) continue;
    if (!best || x.lastT >= best.lastMs) {
      const end = x.last.event === 'done' ? x.last.context?.end : null;
      best = {
        agent,
        track: x.track,
        lastMs: x.lastT,
        stopped: x.last.event === 'done',
        killed: x.last.event === 'done' && x.last.killed === true,
        context: typeof end === 'number' && Number.isFinite(end) ? end : null,
      };
    }
  }
  return best;
}

/** The session a subagent transcript belongs to: <root>/<session>/subagents/agent-<id>.jsonl gives <session>. */
function sessionOfTranscript(p) {
  const parts = String(p ?? '').split(/[\\/]+/);
  const i = parts.lastIndexOf('subagents');
  return i > 0 ? parts[i - 1] : null;
}

/**
 * Continue the agent that delivered, or start a new one? See the rule at the top.
 * @param {{ reason: string, agent: ReturnType<typeof lastTrackAgent>, transcript: { path: string, mtimeMs: number }|null,
 *   orchestratorSession: string|null, worktree: string|null, canContinue: boolean, cloud: boolean, newAgent: boolean,
 *   setup: ReturnType<typeof fixRoundSetup>, now: number }} x
 * @returns {{ mode: 'continue'|'new', why: string, agent?: string, ageMin?: number, contextK?: number|null }}
 */
function continuation(x) {
  const fresh = (why) => ({ mode: 'new', why });
  const { setup, agent } = x;
  if (x.reason !== 'fix') return fresh('not a fix round');
  if (x.newAgent) return fresh('asked for a new agent (--new-agent)');
  if (!setup?.continueWithinMin) return fresh('continuation is off (fixRound.continueWithinMin is 0)');
  if (!x.canContinue) return fresh("the task's client cannot continue an agent");
  if (x.cloud) return fresh('the track runs as a cloud session');
  if (!agent) return fresh('no track agent for the task in the time log');
  if (!agent.stopped) return fresh('the agent that delivered has not stopped');
  if (agent.killed) return fresh('the agent that delivered was killed');
  if (!x.transcript?.path) return fresh("the agent's transcript was not found");
  const session = sessionOfTranscript(x.transcript.path);
  if (x.orchestratorSession && session && session !== x.orchestratorSession)
    return fresh('the agent belongs to another session (SendMessage cannot reach it from here)');
  if (!x.worktree) return fresh('no worktree has the branch checked out any more');
  const lastMs = Math.max(agent.lastMs ?? -Infinity, x.transcript.mtimeMs ?? -Infinity);
  const ageMin = Math.max(0, Math.round((x.now - lastMs) / 60_000));
  if (ageMin > setup.continueWithinMin) return fresh(`last active ${ageMin} min ago (over ${setup.continueWithinMin})`);
  const contextK = agent.context != null ? Math.round(agent.context / 1000) : null;
  if (contextK != null && setup.continueMaxContextK > 0 && contextK > setup.continueMaxContextK)
    return fresh(`context about ${contextK}k (over ${setup.continueMaxContextK}k)`);
  return {
    mode: 'continue',
    agent: agent.agent,
    ageMin,
    contextK,
    why: `last active ${ageMin} min ago${contextK != null ? `, context about ${contextK}k` : ''}`,
  };
}

/** The gates line: what to rerun before the report (the quick gates and the done command, when set). */
function gateLines({ quick = [], done = null } = {}) {
  const parts = [];
  if (quick.length) parts.push(`the quick gates (${quick.map((c) => `\`${c}\``).join(', ')})`);
  if (done) parts.push(`the done command \`${done}\``);
  return parts.length
    ? `Rerun before you report: ${parts.join(' and ')}.`
    : 'No quick gates or done command are set: run the tests that cover your change.';
}

/**
 * The fix brief for a continued agent (written to <scratch>/fix-<id>-r<N>.md): only what is new to it. The agent still
 * has the mission, its ownership and its commits in context, so none of that is repeated.
 */
function continueBrief({
  id,
  round,
  branch,
  worktree,
  reportFolder,
  findingsFile = null,
  reviewFolder = null,
  reviewFiles = [],
  work = [],
  gates = {},
}) {
  return [
    `# Fix round ${round} for ${id} (continuation of the same agent)`,
    '',
    `Branch \`${branch}\`, your worktree \`${worktree}\`. Keep working there: the commits you made are kept, do not redo them.`,
    'Your mission, ownership and "Do NOT touch" from the first message still apply.',
    '',
    ...(findingsFile ? [`The findings to fix: ${findingsFile}`] : []),
    ...(reviewFolder && reviewFiles.length ? [`The reviewers' files: ${reviewFolder} (${reviewFiles.join(', ')})`] : []),
    ...(findingsFile || (reviewFolder && reviewFiles.length) ? [''] : []),
    ...work,
    '',
    gateLines(gates),
    '',
    `Then commit, and write track-result.md in ${reportFolder} again with the RESULT line as the FIRST line. It covers the`,
    `whole track (branch=${branch}, commits = all on the branch ahead of the base). Your answer starts with the same RESULT line.`,
    '',
  ].join('\n');
}

/** The short message for the continued agent: it points to the brief, which holds the fix list. */
function continueMessage({ id, round, briefFile }) {
  return (
    `Fix round ${round} for ${id}: read ${briefFile} and fix what it lists, on the same branch in your worktree. ` +
    'Rerun the gates it names, commit, then write track-result.md in your folder again (RESULT line first) and answer with that RESULT line.'
  );
}

module.exports = {
  DEFAULTS,
  fixRoundSetup,
  lastTrackAgent,
  sessionOfTranscript,
  continuation,
  gateLines,
  continueBrief,
  continueMessage,
};
