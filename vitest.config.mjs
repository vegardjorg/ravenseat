// Test setup for Ravenseat (locally and in .github/workflows/ci.yml). The tests live in plugin/scripts/orchestrator/**/__tests__.
// TZ is set here because several rules (night window, day, weekly quota) are computed in Europe/Oslo.
process.env.TZ = process.env.TZ || 'Europe/Oslo';
// The load guard is on by default (loadGuard.minFreeMemoryPct 10): the tests measure a fixed, roomy machine, so a busy
// developer machine never stops a test's start. Tests of the guard set QUEUE_LOAD themselves.
process.env.QUEUE_LOAD = process.env.QUEUE_LOAD || 'free=100';
// The gate queue is off the same way: test files that run gates.mjs must not wait for each other or for the machine's real
// runs. The tests of the queue set QUEUE_GATE_QUEUE=on themselves, with their own root in QUEUE_GATE_QUEUE_DIR.
process.env.QUEUE_GATE_QUEUE = process.env.QUEUE_GATE_QUEUE || 'off';
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['plugin/scripts/orchestrator/**/__tests__/**/*.test.{ts,mjs}', 'bench/**/__tests__/**/*.test.{ts,mjs}'],
    testTimeout: 60000,
    pool: 'forks',
    // Keeps a file of blocking spawnSync tests from timing out vitest's own progress calls (see the file).
    setupFiles: ['plugin/scripts/orchestrator/__tests__/yieldBetweenTests.setup.mjs'],
    // Half the cores: with one worker per core the tests that spawn git and node starve the machine.
    maxWorkers: '50%',
  },
});
