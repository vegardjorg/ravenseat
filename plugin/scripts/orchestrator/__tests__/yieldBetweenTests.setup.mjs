// Runs in every test worker (vitest.config.mjs setupFiles). Lets the worker's event loop turn after each test.
//
// Why: vitest's worker reports progress over RPC with a 60 s timeout. Many tests here call git and node with spawnSync,
// which blocks the worker, and the promises between tests only run microtasks. A file like that can hold the event loop
// past 60 s, so the timer fires before the worker has read the answer that is already waiting: "Timeout calling
// onTaskUpdate" and exit 1, with every test green. One full turn of the loop per test is enough for the answer to be read.
import { afterEach } from 'vitest';

const step = () => new Promise((resolve) => setImmediate(resolve));

/** A full turn: a single setImmediate can run in the current turn without reaching the phase that reads messages. */
async function loopTurn() {
  await step();
  await step();
}

afterEach(loopTurn);
