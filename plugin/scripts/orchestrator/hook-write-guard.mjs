#!/usr/bin/env node
// =============================================================
// hook-write-guard.mjs: PreToolUse hook (matcher Write|Edit|NotebookEdit), the write guard for the queue's trusted
// state files. The rules and the why live in lib/writeGuard.js; see docs/orchestration.md.
//
// Denies a queue agent (every subagent, lib/agentGuard.js: track, track-d, the reviewers and helpers always) a direct write to the
// gate evidence store (gate-evidence.json, anywhere) and to the data folder's queue.json and base-health.json. The main
// session (no agent_type) is never denied by these rules. Inert without a queue project (no queue.config.json and no
// QUEUE_* variable). The main session's own direct write to a main tree control file asks instead (lib/approvalAsk.js,
// approvals.ask): Claude Code's dialog with the path in the reason, a deny in dontAsk and bypassPermissions.
// It also denies them a write to the main tree's control files (lib/controlFiles.js, controlFiles.guard): queue.config.json,
// .claude/ (not .claude/worktrees/), CLAUDE*.md, .git/hooks/, .git/config and the plugin's own scripts (this folder).
// Every denial is one row in the time log (lib/guardLog.js, guardLog.enabled): guard, rule, agent type, task.
// A track (track, track-d) also gets a soft warning, never a denial, for a write the merge guard or receive flags later:
// a protected path the task does not own, a new skip or focus marker in a test file, a test file that loses its last
// assertion (lib/writeWarn.js), and with scopeNotes.driftWarn on (off by default) a file outside the task's files and
// reads. Once per agent, file and kind.
// Fails OPEN on an internal error (a rule that throws): no output and exit 0. Fails CLOSED on the slow path: no answer
// within 8 s is a deny with how to retry (guards.onHookFailure "allow": no answer), never a timer that exits 0.
// Smoke test: echo '{"agent_type":"track","tool_input":{"file_path":"gate-evidence.json"}}' | node scripts/orchestrator/hook-write-guard.mjs
// =============================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
// Not a queue project: do nothing. A plugin's hooks run in every project the user opens.
const PR = require('./lib/projectRoot.js');
if (!PR.queueActive()) process.exit(0);

// The slow path fails CLOSED (ARK-1 T1, architecture review B): hooks.json marks this hook `"onFailure": "block"` with a
// 10 s limit, so a guard that is too slow to decide must not let the write through. After BUDGET_MS (8 s, inside the
// 10 s) the hook answers with a deny that says what happened and how to retry. guards.onHookFailure "allow"
// (lib/hookFailure.js) keeps the owner's choice: no answer, the write runs. WRITE_GUARD_BUDGET_MS only shortens the
// budget (the tests use it); it can never make the guard wait past Claude Code's own limit.
const BUDGET_MS = Math.min(8000, Math.max(50, Number(process.env.WRITE_GUARD_BUDGET_MS) || 8000));
let answered = false;
const guard = setTimeout(() => {
  if (answered) return;
  answered = true;
  let mode = 'block';
  try {
    mode = require('./lib/hookFailure.js').settingOf(require('./lib/queueConfig.js').config());
  } catch {
    mode = 'block'; // fail-closed: an unreadable setting reads as the default
  }
  if (mode === 'allow') process.exit(0);
  const reason =
    `Write guard: the check did not finish in ${Math.round(BUDGET_MS / 1000)} s (a busy machine or a stalled hook), so the ` +
    'write was stopped instead of let through unchecked. Nothing was written. Try the same write again; if it keeps ' +
    'happening, run `ravenseat doctor`.';
  let text;
  try {
    text = JSON.stringify(require('./lib/clients/claude/hookInput.js').deny('PreToolUse', reason));
  } catch {
    text = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
  }
  // Exit only once stdout is flushed; if it never flushes, Claude Code's own limit blocks the call (onFailure block).
  process.stdout.write(text, () => process.exit(0));
}, BUDGET_MS);
guard.unref();

/** Every answer of main() goes through here, so the budget timer and main never both write. */
function reply(obj) {
  if (answered) return;
  answered = true;
  clearTimeout(guard);
  process.stdout.write(JSON.stringify(obj));
}

async function readIn() {
  let s = '';
  for await (const chunk of process.stdin) s += chunk;
  return JSON.parse(s || '{}');
}

async function main() {
  // The hook payload in the core's names and the hook answers (lib/clients/claude/hookInput.js).
  const HK = require('./lib/clients/index.js').clientFor().hooks;
  const input = HK.read(await readIn());
  const agentType = PR.bareAgentType(input.agent.type);
  // The main session (no agent_id): never denied by the agent rules below, but a direct write to a main tree control
  // file asks (lib/approvalAsk.js, approvals.ask).
  // A main session started with --agent has an agent_type and no agent_id: after the ask it goes on as before.
  if (!(typeof input.agent.id === 'string' && input.agent.id !== '') && mainSessionAsk(HK, input)) return;
  if (!agentType) return;
  const WG = require('./lib/writeGuard.js');
  const file = WG.targetPath(input.tool.input);
  if (!file) return;
  const abs = path.isAbsolute(file) ? file : path.resolve(input.cwd || process.cwd(), file);
  let folder = null;
  try {
    folder = require('./lib/queueConfig.js').dataFolder();
  } catch {
    folder = null; // the store is still guarded anywhere
  }
  const guardedTypes = require('./lib/trackGuard.js').queueAgentTypes();
  // Every subagent is guarded unless agentGuard excepts its type (owner decision B3, lib/agentGuard.js); agent_id is only
  // sent inside a subagent, so a main session started with --agent is not.
  let policy = {};
  try {
    policy = require('./lib/agentGuard.js').policyOf(require('./lib/queueConfig.js').config());
  } catch {
    policy = {}; // an unreadable config: the default, every subagent guarded
  }
  const agentGuard = { ...policy, subagent: typeof input.agent.id === 'string' && input.agent.id !== '' };
  // The queue's state files first, then the main tree's control files (lib/controlFiles.js, controlFiles.guard).
  const answer =
    WG.assessWrite({ agentType: input.agent.type, filePath: abs, folder, guardedTypes, agentGuard }) ??
    controlAnswer(input.agent.type, abs, guardedTypes, agentGuard);
  if (answer) {
    reply(HK.deny('PreToolUse', answer.reason));
    // One row in the time log (lib/guardLog.js): the guard and the rule, never the path or the content.
    require('./lib/guardLog.js').recordHook({ guard: 'write', rule: answer.rule ?? 'state-file', decision: 'deny', input });
    return;
  }
  // Not denied: a track (only track and track-d, not the reviewers) gets a soft warning for a write the merge guard or
  // receive would flag later (lib/writeWarn.js). Never a denial.
  if (agentType !== 'track' && agentType !== 'track-d') return;
  const warnings = trackWarnings(input, abs, folder);
  if (!warnings.length) return;
  reply(HK.context('PreToolUse', warnings.join('\n')));
}

/**
 * The main session's write of a main tree control file: "ask" (Claude Code's own dialog), or a deny in dontAsk and
 * bypassPermissions (lib/approvalAsk.js). approvals.ask false: nothing. Any error: nothing (the guard fails open).
 * Returns true when it answered.
 */
function mainSessionAsk(HK, input) {
  try {
    const WG = require('./lib/writeGuard.js');
    const file = WG.targetPath(input.tool.input);
    if (!file) return false;
    const KK = require('./lib/queueConfig.js');
    const k = KK.config();
    const AA = require('./lib/approvalAsk.js');
    if (!AA.setupOf(k).ask) return false;
    const abs = path.isAbsolute(file) ? file : path.resolve(input.cwd || process.cwd(), file);
    const finding = AA.controlWriteFinding({
      filePath: abs,
      mainTree: k.root,
      scriptsDir: path.dirname(fileURLToPath(import.meta.url)),
      configFile: KK.configFile(k.root),
    });
    if (!finding) return false;
    const answer = AA.forMode(finding, input.permissionMode);
    const reason = `Write guard: ${answer.reason}`;
    reply(answer.decision === 'ask' ? HK.ask('PreToolUse', reason) : HK.deny('PreToolUse', reason));
    try {
      require('./lib/guardLog.js').recordHook({ guard: 'write', rule: answer.rule, decision: answer.decision, input });
    } catch {
      // error-ignored: the decision is written; the row is measurement only
    }
    return true;
  } catch {
    return false; // error-ignored: the guard fails open and must never stop the main session by a bug of its own
  }
}

/**
 * The denial for a write to one of the main tree's control files (lib/controlFiles.js), or null. The plugin's own
 * scripts are the folder this hook lives in. Any error: null (the guard fails open).
 */
function controlAnswer(agentType, abs, guardedTypes, agentGuard) {
  try {
    const KK = require('./lib/queueConfig.js');
    const k = KK.config();
    return require('./lib/controlFiles.js').assessControlWrite({
      agentType,
      filePath: abs,
      mainTree: k.root,
      scriptsDir: path.dirname(fileURLToPath(import.meta.url)),
      configFile: KK.configFile(k.root),
      guardedTypes,
      agentGuard,
      enabled: k.controlFiles?.guard !== false,
    });
  } catch {
    return null;
  }
}

/** The warnings not yet given to this agent for this file and kind (state per agent in WRITE_WARN_STATE). */
function trackWarnings(input, abs, folder) {
  const WW = require('./lib/writeWarn.js');
  const rel = WW.repoRelative(abs);
  if (!rel) return [];
  const TG = require('./lib/trackGuard.js');
  // The task: from the mission at the top of the agent's own transcript (the same rule as the time log).
  const K = require('./lib/queueConfig.js').config();
  let task = null;
  let helperPaths = [];
  let tasks = [];
  try {
    const queue = JSON.parse(fs.readFileSync(path.join(folder, 'queue.json'), 'utf8'));
    tasks = queue.tasks ?? [];
    // The custom helpers' agent files are protected like .claude/, as in merge-track.mjs.
    const HELP = require('./lib/queueHelpers.js');
    helperPaths = HELP.customPaths(HELP.helperSetup(K, queue));
    const tp = TG.subagentTranscript(input);
    const id = tp ? require('./lib/timeCost.js').trackFromText(TG.readHeader(tp)) : null;
    if (id) task = (queue.tasks ?? []).find((o) => o.id === id || o.id === id.replace(/-(?:r|round)\d+$/i, '')) ?? null;
  } catch {
    task = null; // only the test warnings, which need no task
  }
  const ti = input.tool.input ?? {};
  let before = null;
  try {
    before = fs.readFileSync(abs, 'utf8');
  } catch {
    before = null; // a new file
  }
  const tool = String(input.tool.name ?? '');
  const after =
    typeof ti.content === 'string' ? ti.content : tool === 'Edit' || typeof ti.old_string === 'string' ? WW.afterEdit(before, ti) : null;
  const found = WW.assessTrackWrite({
    rel,
    task,
    before,
    after,
    protectedPaths: require('./lib/mergeGuard.js').withPaths(Array.isArray(K.protectedPaths) ? K.protectedPaths : undefined, helperPaths),
    migrations: K.migrations ?? null,
    dependencyFiles: K.dependencyFiles,
    testSetup: K.testWeakening ?? {},
    hotspots: require('./lib/hotspots.js').hotspotsOf(K),
    tasks,
    // V7, opt-in (lib/scopeNotes.js): a file outside the task's files and reads.
    driftWarn: require('./lib/scopeNotes.js').setupOf(K).driftWarn,
  });
  if (!found.length) return [];
  // Once per agent, file and kind: a track that edits the same file ten times reads the warning once.
  const dir = process.env.WRITE_WARN_STATE || path.join(os.tmpdir(), 'queue-write-warn');
  const file = path.join(dir, `${String(input.agent.id ?? 'unknown').replace(/[^\w.-]/g, '_')}.json`);
  let seen = [];
  try {
    seen = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    seen = [];
  }
  const fresh = found.filter((w) => !seen.includes(`${w.kind}:${rel}`));
  if (!fresh.length) return [];
  try {
    // Old state files of earlier agents go (older than 7 days, at most once a day; lib/stateSweep.js, never throws).
    require('./lib/stateSweep.js').sweepState(dir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify([...seen, ...fresh.map((w) => `${w.kind}:${rel}`)].slice(-500)));
  } catch {
    // error-ignored: without the state the warning may come again, which is harmless
  }
  return fresh.map((w) => w.text);
}

main()
  // No process.exit here: stdout must be flushed before the process exits (the guard timer is unref'd).
  .catch(() => undefined) // error-ignored: an internal error fails open and must never stop an agent
  // Decided (an answer or none): the budget timer may no longer answer.
  .finally(() => {
    answered = true;
    clearTimeout(guard);
  });
