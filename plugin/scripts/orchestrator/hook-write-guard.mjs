#!/usr/bin/env node
// =============================================================
// hook-write-guard.mjs: PreToolUse hook (matcher Write|Edit|NotebookEdit), the write guard for the queue's trusted
// state files. The rules and the why live in lib/writeGuard.js; see docs/orchestration.md.
//
// Denies a queue agent (track, track-d, the reviewers and helpers: trackGuard.queueAgentTypes()) a direct write to the
// gate evidence store (gate-evidence.json, anywhere) and to the data folder's queue.json and base-health.json. The main
// session (no agent_type) is never stopped. Inert without a queue project (no queue.config.json and no QUEUE_* variable).
// Fails OPEN: any internal error gives no output and exit 0.
// Smoke test: echo '{"agent_type":"track","tool_input":{"file_path":"gate-evidence.json"}}' | node scripts/orchestrator/hook-write-guard.mjs
// =============================================================
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
  if (!answer) return;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: answer.reason },
    }),
  );
}

main()
  // No process.exit here: stdout must be flushed before the process exits (the guard timer is unref'd).
  .catch(() => undefined); // error-ignored: the guard fails open and must never stop an agent
