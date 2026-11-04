// Runs in every test worker (vitest.config.mjs setupFiles). Lets the worker's event loop turn after each test.
//
// Why: vitest's worker reports progress over RPC with a 60 s timeout. Many tests here call git and node with spawnSync,
// which blocks the worker, and the promises between tests only run microtasks. A file like that can hold the event loop
// past 60 s, so the timer fires before the worker has read the answer that is already waiting: "Timeout calling
// onTaskUpdate" and exit 1, with every test green. One turn of the loop per test is enough for the answer to be read.
import { afterEach } from 'vitest';

afterEach(() => new Promise((resolve) => setImmediate(resolve)));
