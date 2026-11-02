#!/usr/bin/env node
// =============================================================
// hook-session-end.mjs: SessionEnd hook that appends the main session's last cost reading to the time log.
//
// Why: the status line (statusline.mjs) writes a `session` row at most every $0.50 or 10 min, so the last part of a
// session's cost would be missing from `cq cost` without a row at the end. The SessionEnd input has no cost of its own
// (session_id, transcript_path, cwd, reason), so the row takes the last reading the status line saved in
// <dataFolder>/session-cost.json (lib/eventRows.js sessionRowFromState):
//   { time, event: "session", session_id, usd, duration_s, api_duration_s, context_tokens, model, orchestrator,
//     trigger: "end", reason }
// orchestrator = the session is the bound one (<dataFolder>/orchestrator.json). No row without a saved reading (no
// status line set up, or no answer yet in the session).
//
// Not a queue project (no queue.config.json): does nothing. Fails OPEN: any error gives no output and exit 0; the
// hook never blocks or delays the end of a session.
// =============================================================
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
if (!require('./lib/projectRoot.js').queueActive()) process.exit(0);

async function main() {
  let s = '';
  for await (const chunk of process.stdin) s += chunk;
  const input = JSON.parse(s || '{}');
  const sessionId = input.session_id ?? null;
  if (!sessionId) return;
  const { dataFolder, timeLog } = require('./lib/queueConfig.js');
  const ER = require('./lib/eventRows.js');
  const folder = dataFolder();
  let orchestrator = false;
  try {
    orchestrator = JSON.parse(fs.readFileSync(path.join(folder, 'orchestrator.json'), 'utf8'))?.session_id === sessionId;
  } catch {
    orchestrator = false; // no cursor: not the orchestrator
  }
  const row = ER.sessionRowFromState(ER.readSessionState(path.join(folder, ER.SESSION_FILE)), sessionId, {
    trigger: 'end',
    orchestrator,
  });
  if (!row) return;
  if (typeof input.reason === 'string' && input.reason) row.reason = input.reason;
  require('./lib/timeLogRows.js').appendRows(timeLog(), row);
}

const guard = setTimeout(() => process.exit(0), 8000);
guard.unref();
main()
  .catch(() => undefined) // error-ignored: a measurement hook must never stop the session end
  .finally(() => process.exit(0));
