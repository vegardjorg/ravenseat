#!/usr/bin/env node
// =============================================================
// hook-track-end.mjs: SubagentStop gate against empty deliveries from the queue's tracks. See docs/orchestration.md.
//
// Why: after an automatic compaction a track can lose the thread and stop without having committed anything and without
// the RESULT line `queue.mjs receive` needs. The orchestrator then has to notice it and start a new agent. Hooks are
// deterministic; the rule in the mission is only advice.
//
// How it works:
//   - Applies only to agent_type `track` and `track-d` (contextGuard.TRACK_AGENT_TYPES; "ravenseat:track" counts as "track");
//     everything else passes at once.
//   - The track is found from the mission at the top of the agent transcript (timeCost.trackFromText), and the branch
//     and head_start from the queue file (<dataFolder>/queue.json in the main tree; QUEUE_FOLDER overrides).
//   - Own commits are counted with `git rev-list --count <branch> ^<head_start> ^<baseBranch>`: commits on the branch
//     that were neither there at the start nor already in the configured base branch (prepare-track can have started the
//     branch on a newer base than head_start, and those merge commits are not the track's own). QUEUE_GIT overrides the
//     repo, as in queue.mjs.
//   - If the agent has no own commits AND no end line (the RESULT line, PARTIAL or REFUSE) in its last message
//     (last_assistant_message, or the last assistant rows, the SubagentHandback call too), it gets `decision: block`
//     with the reason "Finish: commit the work and write the RESULT line (or PARTIAL/REFUSE with the reason)". The
//     rules live in lib/contextGuard.js (assessEndGate, hasEndLine), with tests.
//   - Only once per agent: the state lives in <Temp>/queue-track-end/<agent_id>.json (TRACK_END_STATE overrides the
//     folder), and stop_hook_active always passes. The gate can therefore not loop.
//   - Kept apart from hook-time.mjs on purpose: the time log never blocks, this gate may.
// Fails OPEN: an unknown track, branch or head_start, a git error or any other internal error gives no output and exit 0.
// Smoke test: echo '{"hook_event_name":"SubagentStop","agent_type":"track","agent_id":"x","agent_transcript_path":"<file>"}'
//   | node scripts/orchestrator/hook-track-end.mjs
// =============================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// Not a queue project (no queue.config.json): do nothing. A plugin's hooks run in every project the user opens.
if (!require('./lib/projectRoot.js').queueActive()) process.exit(0);
const KV = require('./lib/contextGuard.js');
const V = require('./lib/trackGuard.js');
const { config, dataFolder } = require('./lib/queueConfig.js');

const guard = setTimeout(() => process.exit(0), 15000);
guard.unref();

const STATE = process.env.TRACK_END_STATE || path.join(os.tmpdir(), 'queue-track-end');

async function readIn() {
  let s = '';
  for await (const chunk of process.stdin) s += chunk;
  return JSON.parse(s || '{}');
}

const stateFile = (id) => path.join(STATE, `${String(id).replace(/[^\w.-]/g, '_')}.json`);

/** A git ref that can never be read as a flag. */
const SAFE_REF = /^[\w][\w./-]*$/;

/** The track's own commits on its branch since the start, or null when it cannot be decided (the gate then lets it pass). */
function ownCommits(track) {
  const k = config();
  const queue = JSON.parse(fs.readFileSync(path.join(dataFolder(), 'queue.json'), 'utf8'));
  const o = (queue.tasks ?? []).find((x) => x.id === track);
  const branch = o?.branch ?? (o ? `${k.branchPrefix ?? 'queue/'}${o.id}` : null);
  const start = o?.head_start;
  const base = k.baseBranch;
  if (!branch || !SAFE_REF.test(branch)) return null;
  if (!start || !/^[0-9a-f]{7,40}$/i.test(start)) return null;
  if (!base || !SAFE_REF.test(base)) return null;
  const r = spawnSync('git', ['rev-list', '--count', branch, `^${start}`, `^${base}`, '--'], {
    cwd: process.env.QUEUE_GIT ?? k.root,
    encoding: 'utf8',
  });
  if (r.status !== 0) return null;
  const n = Number(String(r.stdout).trim());
  return Number.isFinite(n) ? n : null;
}

async function main() {
  // The payload in the core's names (lib/clients/claude/hookInput.js, through the adapter).
  const input = require('./lib/clients/index.js').clientFor().hooks.read(await readIn());
  if (input.event && input.event !== 'SubagentStop') return;
  const agentType = require('./lib/projectRoot.js').bareAgentType(input.agent.type); // "ravenseat:track" -> "track"
  if (!agentType || !KV.TRACK_AGENT_TYPES.has(agentType) || !input.agent.id) return;
  const alreadyBlocked = fs.existsSync(stateFile(input.agent.id));
  if (alreadyBlocked || input.stopActive) return;
  const tp = V.subagentTranscript(input);
  if (!tp) return;
  const track = require('./lib/timeCost.js').trackFromText(V.readHeader(tp));
  if (!track) return;
  const commits = ownCommits(track);
  // The closing text and the transcript tail, where a SubagentHandback call carries the report (F2, 0w W2c).
  const ended = KV.hasEndLine({
    lastMessage: typeof input.lastMessage === 'string' ? input.lastMessage : null,
    text: V.readTail(tp, 512 * 1024),
  });
  const answer = KV.assessEndGate({
    agentType,
    commits,
    hasEndLine: ended,
    alreadyBlocked,
    stopHookActive: Boolean(input.stopActive),
  });
  if (!answer) return;
  // Remember the block BEFORE it is written: if the state cannot be saved, nothing is blocked (no loop).
  // Old state files of earlier agents go (older than 7 days, at most once a day; lib/stateSweep.js, never throws).
  require('./lib/stateSweep.js').sweepState(STATE);
  fs.mkdirSync(STATE, { recursive: true });
  fs.writeFileSync(
    stateFile(input.agent.id),
    JSON.stringify({ agent_id: input.agent.id, track, time: new Date().toISOString() }),
  );
  process.stdout.write(JSON.stringify(answer));
}

main()
  // No process.exit here: stdout must be flushed before the process exits (the guard timer is unref'd).
  .catch(() => undefined); // error-ignored: the gate fails open and must never lock an agent
