// =============================================================
// scripts/test-run-reporter.mjs: a vitest reporter that only counts (TC-1, 2026-11-19). It prints nothing; the default
// reporter still does all the output, so a run looks and behaves as before.
//
// At the end of a run it has the test count, the failed count and the run time, and then:
//   - RAVENSEAT_TEST_RUN_OUT set (test:changed's own vitest call): writes { tests, failed, modules } as JSON to that file,
//     and test:changed logs the one row of the run (scripts/test-runs.mjs). So a test:changed run is never two rows.
//   - otherwise a plain `npm test` / `npx vitest run`: one row via 'vitest' in the test run log; mode full without file
//     filters on the command line, some with them. Watch mode and CI (env CI) log nothing.
// Every step is in a try/catch: the log is a convenience and never fails or changes a run.
// =============================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendRun } from './test-runs.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The file filters on vitest's command line: the arguments after `run` that are not flags (or a flag's value). */
export function fileFilters(argv) {
  const i = argv.findIndex((a) => a === 'run');
  const args = i >= 0 ? argv.slice(i + 1) : [];
  const out = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a.startsWith('-')) {
      // `--flag value`: skip the value too (a value never starts with a dash; `--flag=value` holds its own)
      if (!a.includes('=') && args[k + 1] && !args[k + 1].startsWith('-') && !/\.(test|spec)\./.test(args[k + 1])) k++;
      continue;
    }
    out.push(a);
  }
  return out;
}

/** Counts the tests of a vitest 3 run: every test case, and the ones in state failed. */
export function countTests(testModules) {
  let tests = 0;
  let failed = 0;
  for (const m of testModules ?? []) {
    for (const t of m.children?.allTests?.() ?? []) {
      tests++;
      if (t.result?.()?.state === 'failed') failed++;
    }
  }
  return { tests, failed, modules: (testModules ?? []).length };
}

export default class TestRunReporter {
  constructor() {
    this.t0 = Date.now();
    this.watch = false;
  }

  onInit(vitest) {
    try {
      this.t0 = Date.now();
      this.watch = Boolean(vitest?.config?.watch);
    } catch {
      // error-ignored: counting only
    }
  }

  onTestRunEnd(testModules, unhandledErrors) {
    try {
      const counts = countTests(testModules);
      const out = process.env.RAVENSEAT_TEST_RUN_OUT;
      if (out) {
        fs.writeFileSync(out, JSON.stringify(counts));
        return;
      }
      if (this.watch || process.env.CI) return;
      const filters = fileFilters(process.argv);
      const errors = (unhandledErrors ?? []).length;
      appendRun(
        {
          time: new Date().toISOString(),
          via: 'vitest',
          mode: filters.length ? 'some' : 'full',
          picked: counts.modules,
          run_s: Math.round((Date.now() - this.t0) / 100) / 10,
          exit: counts.failed || errors ? 1 : 0,
          tests: counts.tests,
          failed: counts.failed,
        },
        { root: ROOT },
      );
    } catch {
      // error-ignored: the log must never fail a run
    }
  }
}
