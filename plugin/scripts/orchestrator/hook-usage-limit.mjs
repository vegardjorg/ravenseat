#!/usr/bin/env node
// =============================================================
// hook-usage-limit.mjs: StopFailure hook. Saves the pause when a turn ended on the subscription's usage limit.
//
// Reads the hook JSON from stdin, lets lib/usageLimit.js decide from the end of the session's transcript and the status
// line's last reading, and writes <dataFolder>/usage-limit.json. Only the reset time and the kind of limit are kept,
// never anything from the conversation. usageLimit.pause false in queue.config.json turns it off.
//
// The hook must never get in the way: StopFailure cannot block anything anyway, everything is in try/catch, it always
// exits 0, and a guard exits after 8 s regardless.
//
// Smoke test: echo '{"hook_event_name":"StopFailure","error":"rate_limit","transcript_path":"<file>"}' | node hook-usage-limit.mjs
// =============================================================

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// Not a queue project (no queue.config.json): do nothing. A plugin's hooks run in every project the user opens.
if (!require('./lib/projectRoot.js').queueActive()) process.exit(0);

const guard = setTimeout(() => process.exit(0), 8000);
guard.unref();

/** The transcript entry may be written just after the hook starts: two short waits before the status line decides. */
const ATTEMPTS = 3;
const WAIT_MS = 300;

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
  const { config, dataFolder } = require('./lib/queueConfig.js');
  if (config().usageLimit?.pause === false) return;
  const UL = require('./lib/usageLimit.js');
  const { readObserved } = require('./lib/rateLimits.js');
  const input = JSON.parse(await readStdin());
  const folder = dataFolder();
  // Only a rate_limit stop is worth waiting for; any other stop reads the transcript once.
  const attempts = input.error === 'rate_limit' ? ATTEMPTS : 1;
  let rec = null;
  for (let i = 1; i <= attempts && !rec; i++) {
    if (i > 1) await new Promise((r) => setTimeout(r, WAIT_MS));
    const tail = UL.readTail(input.transcript_path);
    if (UL.fromTranscriptTail(tail) || i === attempts) rec = UL.decide(input, { tail, observed: readObserved(folder) });
  }
  if (rec) UL.write(folder, UL.merge(UL.read(folder), rec));
}

main()
  .catch(() => {
    /* never in the way: no pause is saved */
  })
  .finally(() => process.exit(0));
