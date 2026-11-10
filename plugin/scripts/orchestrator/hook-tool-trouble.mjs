#!/usr/bin/env node
// =============================================================
// hook-tool-trouble.mjs: PermissionDenied and PostToolUseFailure hook. Saves that a track agent's tool call was refused
// by auto mode, or failed, so the board can show a track that is refused or loops on a failing tool (lib/toolTrouble.js).
//
// Kept: the agent id, the tool name and the time, in <dataFolder>/tool-trouble.json. Never the reason, the tool input
// or the error text. The main session (no agent_id) is left out: the owner is looking at it already.
// The hook must never get in the way: it prints nothing, everything is in try/catch, it always exits 0, and a guard
// exits after 8 s.
//
// Smoke test: echo '{"hook_event_name":"PostToolUseFailure","agent_id":"a1","tool_name":"Bash"}' | node hook-tool-trouble.mjs
// =============================================================

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// Not a queue project (no queue.config.json): do nothing. A plugin's hooks run in every project the user opens.
if (!require('./lib/projectRoot.js').queueActive()) process.exit(0);

const guard = setTimeout(() => process.exit(0), 8000);
guard.unref();

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    const done = () => resolve(data);
    const t = setTimeout(done, 3000);
    t.unref();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (data += d));
    process.stdin.on('end', () => {
      clearTimeout(t);
      done();
    });
    process.stdin.on('error', done);
  });
}

async function main() {
  const input = JSON.parse((await readStdin()) || '{}');
  if (!input.agent_id) return;
  const TT = require('./lib/toolTrouble.js');
  const { dataFolder } = require('./lib/queueConfig.js');
  const folder = dataFolder();
  const before = TT.read(folder);
  const after = TT.record(before, input);
  if (after !== before) TT.write(folder, after);
}

main()
  .catch(() => {
    /* never in the way: nothing is saved */
  })
  .finally(() => process.exit(0));
