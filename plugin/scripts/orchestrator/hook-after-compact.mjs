#!/usr/bin/env node
// =============================================================
// hook-after-compact.mjs: SessionStart hook (matcher `compact`) that adds the queue state and a resume instruction
// back after the orchestrator session has been compacted. See docs/orchestration.md.
//
// Why: compaction is the default for the orchestrator session (hook-context.mjs proposes /compact with focus at about 280k,
// every time; a new session is only an emergency measure). The summary loses details and drifts more with every compaction.
// This hook therefore adds the most fragile parts back as additionalContext, read from the source and not from the
// summary:
//   - the resume instruction: read the running handover note, `queue.mjs orchestrator pulse`, take in delivered tracks,
//     `queue.mjs fill` and start what it lists, without waiting for the owner,
//   - the queue view from `queue.mjs show` (short view: active ones, startable and counts),
//   - open owner questions (queueLogic.questionOverview, the ones not resolved),
//   - number of unpushed commits: `git rev-list --count <remote>/<baseBranch>..<baseBranch>` in mainTree,
//   - how many compactions the session has behind it, and the mode (limits.autocompact, `queue.mjs compact auto|manual`),
//   - the "Now" part of the handover note (at most 40 lines, lib/queueHandover.js), never the whole note.
// The text is built and trimmed (about 3k tokens) in lib/contextGuard.js (afterCompactText), with tests.
//
// Automatic resume: an automatic compaction
// in the middle of a turn continues the turn by itself, so the instruction works at once. A SessionStart hook can NOT start
// a new turn after a manual /compact (initialUserMessage is read only at startup), so then the instruction applies to the
// reply to the first message.
//
// PreCompact (same file, hook_event_name = PreCompact): writes the focus for the summary
// (contextGuard.forCompactInstruction) to stdout for the bound orchestrator session. Claude Code adds stdout from a
// PreCompact hook to the compaction instruction, also on automatic compaction. The hook NEVER blocks a
// compaction (exit 2 would stop it, and with a small autocompact window the session could then lock up). Requires that
// PreCompact is registered in .claude/settings.json.
//
// Only the active orchestrator: the cursor <dataFolder>/orchestrator.json must be bound to this session (session_id =
// session_id, see contextGuard.orchestratorBinding). All other sessions (tracks, reviewers, the owner's own) get nothing.
// If the orchestrator had gone into wind-down (the emergency brake at 350k), it is lifted for the session regardless of
// the number of compactions: compaction is the normal way out of wind-down, and queue.mjs next/start/fill must then work again.
//
// Time log: EVERY main session's compaction (not only the orchestrator's) appends one row to the time log
// (config().timeLog; QUEUE_TIME_LOG overrides): { time, event: "compact", scope: "session", session_id, orchestrator }
// (lib/timeLogRows.js), with orchestrator = this session is the bound one. Track compactions are logged by
// hook-track-context.mjs. It also appends a `session` row (trigger compact) with the session's last cost reading the
// status line saved in <dataFolder>/session-cost.json (lib/eventRows.js), when there is one.
//
// Fails OPEN: any internal error gives no output and exit 0.
// =============================================================
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
// Not a queue project (no queue.config.json): do nothing. A plugin's hooks run in every project the user opens.
if (!require('./lib/projectRoot.js').queueActive()) process.exit(0);
const KV = require('./lib/contextGuard.js');
const L = require('./lib/queueLogic.js');
const { config, dataFolder, timeLog } = require('./lib/queueConfig.js');
const TL = require('./lib/timeLogRows.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const K = config();
// Main tree (config().root is always mainTree, also from a worktree) and the data folder (QUEUE_FOLDER overrides).
const MAIN_TREE = K.root;
const QUEUE_FOLDER = dataFolder();
const CURSOR = path.join(QUEUE_FOLDER, 'orchestrator.json');
const QUEUE_FILE = path.join(QUEUE_FOLDER, 'queue.json');
// Same override as queue.mjs (QUEUE_GIT) for the git root, so the tests never read the real repo.
const GIT_ROOT = process.env.QUEUE_GIT ?? MAIN_TREE;
const MAX_TRANSCRIPT = 300 * 1024 * 1024;

async function readIn() {
  let s = '';
  for await (const chunk of process.stdin) s += chunk;
  return JSON.parse(s || '{}');
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/** Output from `queue.mjs show` (short view is the default), or a short error text. */
function queueShow() {
  try {
    return execFileSync(process.execPath, [path.join(HERE, 'queue.mjs'), 'show'], {
      encoding: 'utf8',
      timeout: 15_000,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, COLUMNS: '110' },
    });
  } catch {
    return '(cq show failed; run it yourself)';
  }
}

/** Number of commits on baseBranch that are not pushed, or null if git does not answer. */
function unpushed() {
  try {
    const out = execFileSync(
      'git',
      ['-C', GIT_ROOT, 'rev-list', '--count', `${K.remote}/${K.baseBranch}..${K.baseBranch}`],
      {
        encoding: 'utf8',
        timeout: 5_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    const n = Number(out.trim());
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * The "Now" part of the running handover note (lib/queueHandover.js), cut at 40 lines; null when the note has no
 * "## Now" section, undefined when there is no note. Only this part goes into the context: the whole note can be
 * thousands of lines, and the archive is read with grep when needed.
 */
function handoverNow() {
  let text;
  try {
    text = fs.readFileSync(path.join(QUEUE_FOLDER, 'handover-ongoing.md'), 'utf8');
  } catch {
    return undefined;
  }
  return require('./lib/queueHandover.js').nowPart(text, 40);
}

function compactions(filePath) {
  try {
    if (!filePath || fs.statSync(filePath).size > MAX_TRANSCRIPT) return 0;
    return KV.countCompactions(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return 0;
  }
}

/** The session row with the last saved cost reading (lib/eventRows.js). Fail open. */
function logSessionCost({ sessionId, orchestrator }) {
  try {
    const ER = require('./lib/eventRows.js');
    const row = ER.sessionRowFromState(ER.readSessionState(path.join(QUEUE_FOLDER, ER.SESSION_FILE)), sessionId, {
      trigger: 'compact',
      orchestrator,
    });
    if (row) TL.appendRows(timeLog(), row);
  } catch {
    // error-ignored: measurement only
  }
}

async function main() {
  const input = await readIn();
  const sessionId = input.session_id ?? null;
  if (input.hook_event_name === 'PreCompact') {
    // Focus for the summary, only for the bound orchestrator session. Never blocks (always exit 0).
    if (KV.afterCompactBound({ cursor: readJson(CURSOR), sessionId }))
      process.stdout.write(KV.forCompactInstruction());
    return;
  }
  // The matcher in settings.json is `compact`; the check here makes the hook safe also without a matcher.
  if (input.source !== 'compact') return;
  const cursor = readJson(CURSOR);
  const bound = KV.afterCompactBound({ cursor, sessionId });
  // One compaction row for every main session. Fail open: the log is for measurement only.
  try {
    TL.appendRows(timeLog(), TL.sessionCompactRow({ sessionId, orchestrator: bound }));
  } catch {
    // error-ignored: the re-injection below is what matters
  }
  logSessionCost({ sessionId, orchestrator: bound });
  if (!bound) return;

  const revoke = KV.withoutWindDown(cursor, sessionId);
  if (revoke.changed) {
    try {
      const tmp = `${CURSOR}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(revoke.cursor, null, 2) + '\n');
      fs.renameSync(tmp, CURSOR);
    } catch {
      // error-ignored: the wind-down then remains; queue.mjs orchestrator pulse --session resets it
    }
  }

  const queue = readJson(QUEUE_FILE);
  const question = queue ? L.questionOverview(queue).filter((r) => !r.resolved) : [];
  const text = KV.afterCompactText({
    show: queueShow(),
    question,
    unpushed: unpushed(),
    base: K.baseBranch,
    compactions: compactions(input.transcript_path),
    windDownRevoked: revoke.changed,
    mode: KV.compactMode(queue),
    g: KV.limits(process.env),
    now: handoverNow(),
  });
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text },
    }),
  );
}

main().catch(() => process.exit(0));
