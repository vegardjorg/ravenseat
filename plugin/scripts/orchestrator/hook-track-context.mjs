#!/usr/bin/env node
// =============================================================
// hook-track-context.mjs: PostToolUse hook, context guard for the queue's track agents. See docs/orchestration.md.
//
// Why: a large part of the track cost accrues when the track context is large, and "deliver PARTIAL at about 300k" was
// only a rule in the mission. hook-context.mjs (UserPromptSubmit) only covers the main sessions; subagents get no
// user messages, so the guard has to sit on the tool calls.
//
// How it works:
//   - Does something only when the hook input has `agent_type` equal to `track` or `track-d` (the field exists only when
//     the hook fires inside a subagent; in the main session it is missing, and the hook exits at once).
//   - Reads the last `usage` in the SUBAGENT's transcript (lib/trackGuard.js, same reading as hook-context.mjs).
//   - Tracks may compact (autoCompactWindow 300k applies to them too, so they compact at about 267k). The PARTIAL
//     message (finish the step, commit, write handover.md and deliver PARTIAL) comes at the SECOND compaction in the
//     transcript (`compact_boundary`), or at the hard limit 280k (TRACK_CONTEXT_WARNING overrides; it only triggers when
//     the window is raised), whichever happens first. After the FIRST compaction one short reminder comes (check the
//     mission path, the branch and what is committed). The rules live in lib/contextGuard.js (assessTrackContext), with
//     tests. The compactions are counted incrementally: the state file remembers the byte position and the count, so
//     each call reads only what is new in the transcript.
//     Once per message per agent: the state lives in <Temp>/queue-track-context-guard/<agent_id>.json (override the
//     folder with TRACK_CONTEXT_STATE).
//   - Each NEW compaction (the count in the state file rises) is logged once in the time log as
//     { time, event: "compact", scope: "track", agent_id, agent_type, track, compactions } (lib/timeLogRows.js), after
//     the state file is written, so a compaction is never logged twice. Once the PARTIAL message is said the transcript
//     is no longer counted, so later compactions of that agent are not logged.
//   - The PARTIAL trigger is logged as one line in the time log (config().timeLog, event "contextGuard", with
//     `compactions` and `cause`; QUEUE_TIME_LOG overrides the file, as in hook-time.mjs). The reminder is not logged.
//   - At about 200k (TRACK_REPORT_WARNING overrides) one reminder comes that the long content belongs in track-result.md and the
//     reply under the report cap (readHint.js, assessReportHint). The marker "report" in the same state file prevents
//     repetition; the reminder is not logged in the time log.
//   - A Bash/PowerShell result over about 15,000 characters (TRACK_BASH_WARNING overrides) gives a soft output hint
//     (| head, grep -m, sed -n 'a,bp'; readHint.js, assessBashHint). At most BASH_HINT_MAX per agent: each hint
//     adds the marker "bash" to the state file. Does not need the transcript. The effect is measured with context-measure.mjs.
//   - A cost threshold per class is NOT included: the class (K/U, D/D+) cannot be read from the agent type without guessing
//     (track = K or U, track-d = D or D+).
// Fails OPEN: any internal error gives no output and exit 0.
// Not async: tested 2026-11-01 (Claude Code 2.1.286), an `async: true` PostToolUse hook that fires inside a subagent
// delivers its additionalContext to the MAIN session, not to the subagent, so the track would never see the PARTIAL
// message. A synchronous hook reaches the subagent. The cost per call is the Node start (the fast exit below).
// hooks.json runs it in exec form (command node + args, no shell), so Windows does not start Git Bash first; tested
// 2026-11-01 (Claude Code 2.1.316), the exec-form hook's additionalContext reaches the subagent too.
// Smoke test: echo '{"agent_type":"track","agent_id":"x","transcript_path":"<file>"}' | node scripts/orchestrator/hook-track-context.mjs
// =============================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

// Fast exit: this hook runs on EVERY tool call in every session, and only queue tracks need it. The input is read
// first and the hook stops before any require (and before queueActive, which looks for the project root) unless
// agent_type is a track (track/track-d, or ravenseat:track/ravenseat:track-d in a plugin install; trackGuard.CONTEXT_TYPES). A main
// session then pays only for the Node start.
let rawInput = '';
for await (const chunk of process.stdin) rawInput += chunk;
let firstInput;
try {
  firstInput = JSON.parse(rawInput || '{}');
} catch {
  process.exit(0); // unreadable input: fail open
}
const require = createRequire(import.meta.url);
if (!/^track(?:-d)?$/.test(String(require('./lib/productNames.js').bareAgentType(firstInput?.agent_type) ?? ''))) process.exit(0);
// Not a queue project (no queue.config.json): do nothing. A plugin's hooks run in every project the user opens.
if (!require('./lib/projectRoot.js').queueActive()) process.exit(0);
const V = require('./lib/trackGuard.js');
const KV = require('./lib/contextGuard.js');
const H = require('./readHint.js');
const { dataFolder, timeLog } = require('./lib/queueConfig.js');

const guard = setTimeout(() => process.exit(0), 8000);
guard.unref();

// Hard limit: only triggers when autoCompactWindow is raised above it.
const THRESHOLD = Number(process.env.TRACK_CONTEXT_WARNING) || KV.TRACK_HARD_LIMIT;
const REPORT_THRESHOLD = Number(process.env.TRACK_REPORT_WARNING) || H.REPORT_THRESHOLD;
const REPORT_KEY = 'report'; // marker in the triggered list for the report reminder
const BASH_THRESHOLD = Number(process.env.TRACK_BASH_WARNING) || H.BASH_THRESHOLD;
const BASH_KEY = 'bash'; // one marker per output hint given
const STATE =
  process.env.TRACK_CONTEXT_STATE || path.join(os.tmpdir(), 'queue-track-context-guard');

/** The hook input, already read and parsed at the top (the fast exit). */
async function readIn() {
  return firstInput;
}

const stateFile = (id) => path.join(STATE, `${String(id).replace(/[^\w.-]/g, '_')}.json`);

function readState(id) {
  try {
    const o = JSON.parse(fs.readFileSync(stateFile(id), 'utf8'));
    const c = o.compact;
    return {
      triggered: Array.isArray(o.triggered) ? o.triggered : [],
      compact: c && Number.isFinite(c.pos) && Number.isFinite(c.n) ? c : { pos: 0, n: 0 },
    };
  } catch {
    return { triggered: [], compact: { pos: 0, n: 0 } };
  }
}

/**
 * The number of compactions in the transcript, counted incrementally from the previous position (whole lines only;
 * lib/trackGuard.js countCompactionsFrom, shared with hook-context.mjs). If the file has shrunk, counting starts over.
 */
function countCompactions(tp, compact) {
  const r = V.countCompactionsFrom(tp, compact);
  return { pos: r.pos, n: r.n };
}

async function main() {
  const input = await readIn();
  const agentType = require('./lib/projectRoot.js').bareAgentType(input.agent_type); // "ravenseat:track" (plugin) -> "track"
  if (!agentType || !V.CONTEXT_TYPES.has(agentType) || !input.agent_id) return; // main session: no effect
  const state = readState(input.agent_id);
  const triggered = state.triggered;
  let compact = state.compact;
  const reportSaid = triggered.includes(REPORT_KEY);
  // Output hint for large Bash/PowerShell results (readHint.js). Reads only the hook input.
  const bashHint = H.assessBashHint({
    agentType,
    tool: input.tool_name,
    command: input.tool_input?.command,
    length: H.outputLength(input.tool_response),
    given: triggered.filter((x) => x === BASH_KEY).length,
    threshold: BASH_THRESHOLD,
  });
  let answer = null;
  let reportHint = null;
  let context = null;
  let tp = null;
  // Everything about the context has been said (PARTIAL and the report reminder): skip reading the transcript.
  if (!(KV.partialSaid(triggered) && reportSaid)) {
    tp = V.subagentTranscript(input);
    if (tp) {
      context = V.lastContext(V.readTail(tp));
      if (!KV.partialSaid(triggered)) {
        try {
          compact = countCompactions(tp, compact);
        } catch {
          // error-ignored: without the count only the hard limit applies
        }
      }
      answer = KV.assessTrackContext({
        agentType,
        compactions: compact.n,
        context,
        hardLimit: THRESHOLD,
        triggered,
      });
      // One reminder about the report cap at about 200k (readHint.js), independent of the context guard.
      reportHint = H.assessReportHint({
        agentType,
        context,
        said: reportSaid,
        threshold: REPORT_THRESHOLD,
      });
    }
  }
  const compactChanged = compact.pos !== state.compact.pos || compact.n !== state.compact.n;
  if (!answer && !reportHint && !bashHint && !compactChanged) return;

  // Remember the trigger BEFORE the message is written, so an error in the logging never gives repeated messages.
  const newTriggered = [...triggered];
  if (bashHint) newTriggered.push(BASH_KEY);
  if (reportHint) newTriggered.push(REPORT_KEY);
  if (answer) newTriggered.push(answer.key);
  fs.mkdirSync(STATE, { recursive: true });
  fs.writeFileSync(
    stateFile(input.agent_id),
    JSON.stringify({ agent_id: input.agent_id, triggered: newTriggered, compact }),
  );
  // One time log row per new compaction (the state above is written first, so a row is never repeated).
  if (compact.n > state.compact.n) {
    try {
      let track = null;
      try {
        track = require('./lib/timeCost.js').trackFromText(V.readHeader(tp));
      } catch {
        track = null;
      }
      const TL = require('./lib/timeLogRows.js');
      TL.appendRows(
        timeLog(),
        TL.trackCompactRows({ agentId: input.agent_id, agentType, track, before: state.compact.n, after: compact.n }),
      );
    } catch {
      // error-ignored: the log is for measurement only; the guard goes on
    }
  }
  if (!answer && !reportHint && !bashHint) return; // only a new count position
  const hint = [bashHint, reportHint].filter(Boolean).join('\n');
  // The reminder after the first compaction is not logged; only the PARTIAL message is a contextGuard event.
  if (!answer || answer.key !== KV.KEY_PARTIAL) {
    const text = [hint, answer?.message].filter(Boolean).join('\n');
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text },
      }),
    );
    return;
  }

  try {
    let wave = 'unknown';
    try {
      wave =
        fs
          .readFileSync(path.join(dataFolder(), 'wave-active'), 'utf8')
          .split(/\r?\n/)[0]
          .trim() || wave;
    } catch {
      // no active wave set
    }
    let track = null;
    try {
      track = require('./lib/timeCost.js').trackFromText(V.readHeader(tp));
    } catch {
      track = null;
    }
    const log = timeLog();
    fs.mkdirSync(path.dirname(log), { recursive: true });
    fs.appendFileSync(
      log,
      JSON.stringify({
        time: new Date().toISOString(),
        wave,
        track: track ?? String(input.agent_id).slice(0, 12),
        event: 'contextGuard',
        agent_id: input.agent_id,
        agent_type: agentType,
        context,
        compactions: answer.compactions,
        cause: answer.cause,
        threshold: answer.cause === 'hard' ? THRESHOLD : null,
        remark:
          answer.cause === 'hard'
            ? `contextGuard at about ${Math.round(context / 1000)}k (hard limit ${Math.round(THRESHOLD / 1000)}k, ` +
              `${answer.compactions} compactions)`
            : `contextGuard at compaction no. ${answer.compactions}`,
      }) + '\n',
    );
  } catch {
    // error-ignored: the log is only for measurement; the message to the agent is what matters
  }

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: hint ? `${hint}\n${answer.message}` : answer.message,
      },
    }),
  );
}

main()
  // No process.exit here: stdout must be flushed before the process exits (the guard timer is unref'd).
  .catch(() => undefined); // error-ignored: the guard fails open and must never stop an agent
