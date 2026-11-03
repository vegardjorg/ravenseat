// Test setup for Ravenseat (locally and in .github/workflows/ci.yml). The tests live in plugin/scripts/orchestrator/**/__tests__.
// TZ is set here because several rules (night window, day, weekly quota) are computed in Europe/Oslo.
process.env.TZ = process.env.TZ || 'Europe/Oslo';
// The load guard is on by default (loadGuard.minFreeMemoryPct 10): the tests measure a fixed, roomy machine, so a busy
// developer machine never stops a test's start. Tests of the guard set QUEUE_LOAD themselves.
process.env.QUEUE_LOAD = process.env.QUEUE_LOAD || 'free=100';
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['plugin/scripts/orchestrator/**/__tests__/**/*.test.{ts,mjs}', 'bench/**/__tests__/**/*.test.{ts,mjs}'],
    testTimeout: 60000,
    pool: 'forks',
    // Half the cores: with one worker per core the tests that spawn git and node starve the main process, and vitest
    // ends with "Timeout calling onTaskUpdate" (exit 1) although every test passed. Half was clean and ~20% slower.
    maxWorkers: '50%',
  },
});
