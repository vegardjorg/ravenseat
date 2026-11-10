#!/usr/bin/env node
// =============================================================
// hook-write-guard.mjs: PreToolUse hook (matcher Write|Edit|NotebookEdit), the write guard for the queue's trusted
// state files. The rules and the why live in lib/writeGuard.js; see docs/orchestration.md.
//
// Denies a queue agent (track, track-d, the reviewers and helpers: trackGuard.queueAgentTypes()) a direct write to the
// gate evidence store (gate-evidence.json, anywhere) and to the data folder's queue.json and base-health.json. The main
// session (no agent_type) is never stopped. Inert without a queue project (no queue.config.json and no QUEUE_* variable).
// A track (track, track-d) also gets a soft warning, never a denial, for a write the merge guard or receive flags later:
// a protected path the task does not own, a new skip or focus marker in a test file, a test file that loses its last
// assertion (lib/writeWarn.js). Once per agent, file and kind.
// Fails OPEN: any internal error gives no output and exit 0.
// Smoke test: echo '{"agent_type":"track","tool_input":{"file_path":"gate-evidence.json"}}' | node scripts/orchestrator/hook-write-guard.mjs
// =============================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// Not a queue project: do nothing. A plugin's hooks run in every project the user opens.
const PR = require('./lib/projectRoot.js');
if (!PR.queueActive()) process.exit(0);

const guard = setTimeout(() => process.exit(0), 5000);
guard.unref();

async function readIn() {
  let s = '';
  for await (const chunk of process.stdin) s += chunk;
  return JSON.parse(s || '{}');
}

async function main() {
  const input = await readIn();
  const agentType = PR.bareAgentType(input.agent_type);
  if (!agentType) return; // main session: no effect
  const WG = require('./lib/writeGuard.js');
  const file = WG.targetPath(input.tool_input);
  if (!file) return;
  const abs = path.isAbsolute(file) ? file : path.resolve(input.cwd || process.cwd(), file);
  let folder = null;
  try {
    folder = require('./lib/queueConfig.js').dataFolder();
  } catch {
    folder = null; // the store is still guarded anywhere
  }
  const guardedTypes = require('./lib/trackGuard.js').queueAgentTypes();
  const answer = WG.assessWrite({ agentType, filePath: abs, folder, guardedTypes });
  if (answer) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: answer.reason },
      }),
    );
    return;
  }
  // Not denied: a track (only track and track-d, not the reviewers) gets a soft warning for a write the merge guard or
  // receive would flag later (lib/writeWarn.js). Never a denial.
  if (agentType !== 'track' && agentType !== 'track-d') return;
  const warnings = trackWarnings(input, abs, folder);
  if (!warnings.length) return;
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: warnings.join('\n') } }),
  );
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
  const ti = input.tool_input ?? {};
  let before = null;
  try {
    before = fs.readFileSync(abs, 'utf8');
  } catch {
    before = null; // a new file
  }
  const tool = String(input.tool_name ?? '');
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
  });
  if (!found.length) return [];
  // Once per agent, file and kind: a track that edits the same file ten times reads the warning once.
  const dir = process.env.WRITE_WARN_STATE || path.join(os.tmpdir(), 'queue-write-warn');
  const file = path.join(dir, `${String(input.agent_id ?? 'unknown').replace(/[^\w.-]/g, '_')}.json`);
  let seen = [];
  try {
    seen = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    seen = [];
  }
  const fresh = found.filter((w) => !seen.includes(`${w.kind}:${rel}`));
  if (!fresh.length) return [];
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify([...seen, ...fresh.map((w) => `${w.kind}:${rel}`)].slice(-500)));
  } catch {
    // error-ignored: without the state the warning may come again, which is harmless
  }
  return fresh.map((w) => w.text);
}

main()
  // No process.exit here: stdout must be flushed before the process exits (the guard timer is unref'd).
  .catch(() => undefined); // error-ignored: the guard fails open and must never stop an agent
