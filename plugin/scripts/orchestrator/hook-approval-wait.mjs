#!/usr/bin/env node
// =============================================================
// hook-approval-wait.mjs: Notification hook (matcher permission_prompt). Saves which track agent waits on an approval.
//
// Why: a background track that hits a permission prompt stands still until the owner answers it, and nothing on the
// board said so; it looked like a slow or silent track. Claude Code sends the prompt's Notification to the MAIN
// session's hooks without an agent_id, so the agent is found from the session's subagent transcripts: the one whose last
// tool call has no result yet (lib/approvalWait.js). The board shows it in "Waiting on you" until the transcript moves.
//
// Kept: the agent id, the tool name and the time, in <dataFolder>/approval-waits.json. Never the prompt text.
// The hook must never get in the way: everything is in try/catch, it always exits 0, and a guard exits after 8 s.
//
// Smoke test: echo '{"hook_event_name":"Notification","notification_type":"permission_prompt","transcript_path":"<file>"}' | node hook-approval-wait.mjs
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
  // The matcher already narrows it; a hooks setup without the matcher still only acts on a permission prompt.
  if (input.notification_type && input.notification_type !== 'permission_prompt') return;
  const AW = require('./lib/approvalWait.js');
  const dir = AW.subagentDir(input.transcript_path);
  if (!dir) return;
  // A prompt in the main session itself has no subagent waiting: the owner is looking at that session already.
  const found = AW.waitingAgents(dir);
  if (!found.length) return;
  const { dataFolder } = require('./lib/queueConfig.js');
  const folder = dataFolder();
  AW.write(folder, AW.merge(AW.read(folder), found));
}

main()
  .catch(() => {
    /* never in the way: nothing is saved */
  })
  .finally(() => process.exit(0));
