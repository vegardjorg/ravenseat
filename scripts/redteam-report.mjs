#!/usr/bin/env node
// =============================================================
// scripts/redteam-report.mjs: runs the red team tests and writes their result into plugin/docs/redteam.md.
//
// Why: the result section on the red team page must come from a test run, never be typed by hand (a hand-written
// result goes stale and cannot be trusted). This runs `vitest run` on the red team folder with the JSON reporter, and
// replaces what is between the two markers in redteam.md with: when and where it ran (date in UTC, commit, whether the
// tree had uncommitted changes, Node and OS), a table per test file, and every test in a collapsed list.
//
// One test (docs.test.ts, "the generated result covers every red team test file") checks this very result, so it
// cannot run in the main pass. The script runs it on its own right after the page is written and puts its real result
// on the page, so the page never shows an unexplained skip. It then runs it once more against the final page.
//
// Usage: npm run redteam:report. Exit code 1 when a test failed (the page is still written, with FAIL on it).
// =============================================================
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = 'plugin/scripts/orchestrator/__tests__/redteam';
const PAGE = path.join(ROOT, 'plugin', 'docs', 'redteam.md');
const START = '<!-- redteam-result:start -->';
const END = '<!-- redteam-result:end -->';

/** Runs git in the repo and gives its trimmed output, or '' when it fails (no git, not a repo). */
function git(args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
}

/** One test's result as the page shows it. */
const word = (t) => (t.status === 'passed' ? 'PASS' : t.status === 'failed' ? 'FAIL' : 'SKIPPED');

/** One file's result: FAIL when a test failed, PASS when the rest passed (skipped ones are counted), else SKIPPED. */
function verdict(tests) {
  if (tests.some((t) => t.status === 'failed')) return 'FAIL';
  const skipped = tests.filter((t) => t.status !== 'passed').length;
  if (tests.length > skipped) return skipped ? `PASS (${skipped} skipped)` : 'PASS';
  return 'SKIPPED';
}

/** Text that goes into a markdown table cell: no pipes, no line breaks. */
const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

/** The self-check in docs.test.ts: its title starts with this. */
const SELF_CHECK = 'the generated result covers every red team test file';

/**
 * Runs vitest with the JSON reporter and gives the parsed result, or null when vitest wrote none.
 * `args` are fixed strings from this file; nothing comes from outside. shell: true so `npx` resolves to npx.cmd on
 * Windows. `report` sets RAVENSEAT_REDTEAM_REPORT=1, which makes docs.test.ts skip its self-check.
 */
function vitest(args, report, quiet) {
  const out = path.join(os.tmpdir(), `ravenseat-redteam-${process.pid}-${Date.now()}.json`);
  const env = { ...process.env };
  if (report) env.RAVENSEAT_REDTEAM_REPORT = '1';
  else delete env.RAVENSEAT_REDTEAM_REPORT;
  const run = spawnSync('npx', ['vitest', 'run', ...args, '--reporter=json', `--outputFile=${out}`], {
    cwd: ROOT,
    encoding: 'utf8',
    shell: true,
    stdio: ['ignore', quiet ? 'ignore' : 'inherit', 'inherit'],
    env,
  });
  if (!fs.existsSync(out)) return { json: null, status: run.status };
  const json = JSON.parse(fs.readFileSync(out, 'utf8'));
  fs.rmSync(out, { force: true });
  return { json, status: run.status };
}

/** Runs only the self-check against the page as it is now; gives 'passed', 'failed' or null when it did not run. */
function selfCheck() {
  const { json } = vitest([`${DIR}/docs.test.ts`, '-t', `"${SELF_CHECK}"`], false, true);
  const t = (json?.testResults ?? []).flatMap((f) => f.assertionResults ?? []).find((a) => a.title.startsWith(SELF_CHECK));
  return t && (t.status === 'passed' || t.status === 'failed') ? t.status : null;
}

function main() {
  const t0 = Date.now();
  const { json, status } = vitest([DIR], true, false);
  if (!json) {
    console.error(`redteam-report: vitest wrote no result (exit ${status}); the page is unchanged.`);
    process.exit(1);
  }
  const wall = Math.round((Date.now() - t0) / 1000);

  // One row per test file, in file name order, so the page diff stays small from run to run.
  const files = json.testResults
    .map((f) => {
      const tests = f.assertionResults ?? [];
      // The top describe titles of the file, in order, once each (flows.test.ts has three, lab.test.ts two).
      const describe = [...new Set(tests.map((t) => t.ancestorTitles?.[0]).filter(Boolean))].join('; ');
      const ms = tests.reduce((s, t) => s + (t.duration ?? 0), 0);
      return { stem: path.basename(f.name).replace(/\.test\.ts$/, ''), describe, tests, ms };
    })
    .sort((a, b) => a.stem.localeCompare(b.stem));

  const sha = git(['rev-parse', '--short', 'HEAD']) || 'unknown';
  const dirty = git(['status', '--porcelain', '--untracked-files=no']) ? ' (with uncommitted changes)' : '';
  const when = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const meta = { sha, dirty, when, wall };

  // Write once with the self-check skipped, run it against that page, then write again with its real result.
  writePage(files, meta);
  const self = files.flatMap((f) => f.tests).find((t) => t.title.startsWith(SELF_CHECK));
  if (self && self.status !== 'passed' && self.status !== 'failed') {
    const result = selfCheck();
    if (result) {
      self.status = result;
      writePage(files, meta);
      // The second write changes only the counts and that one line; check the final page as well.
      if (result === 'passed' && selfCheck() !== 'passed') {
        self.status = 'failed';
        writePage(files, meta);
      }
    }
  }

  const all = files.flatMap((f) => f.tests);
  const passed = all.filter((t) => t.status === 'passed').length;
  const failed = all.filter((t) => t.status === 'failed').length;
  console.log(`redteam-report: ${passed}/${all.length} passed; wrote the result into plugin/docs/redteam.md.`);
  process.exit(failed ? 1 : 0);
}

/** Replaces the result section of the red team page with the given run. */
function writePage(files, { sha, dirty, when, wall }) {
  const all = files.flatMap((f) => f.tests);
  const passed = all.filter((t) => t.status === 'passed').length;
  const failed = all.filter((t) => t.status === 'failed').length;
  const skipped = all.length - passed - failed;

  const lines = [
    START,
    `Generated by \`npm run redteam:report\`; do not edit by hand. Last run ${when} UTC on commit \`${sha}\`${dirty},`,
    `Node ${process.versions.node} on ${process.platform}. ${all.length} tests: ${passed} passed, ${failed} failed` +
      `${skipped ? `, ${skipped} skipped` : ''}. The run took ${wall} s on the clock; the files run in parallel, so the times`,
    'per file below add up to more. The check of this very result (in docs) runs on its own right after the result is',
    'written, since it cannot check a result that does not exist yet.',
    '',
    '| File | Scenario | Tests | Result | Time |',
    '| --- | --- | --- | --- | --- |',
    ...files.map(
      (f) => `| \`${f.stem}\` | ${cell(f.describe)} | ${f.tests.length} | ${verdict(f.tests)} | ${(f.ms / 1000).toFixed(1)} s |`,
    ),
    '',
    '<details><summary>Every test</summary>',
    '',
    ...files.flatMap((f) => [
      `**${f.stem}**`,
      '',
      ...f.tests.map((t) => `- ${word(t)}: ${cell(t.title)}`),
      '',
    ]),
    '</details>',
    END,
  ];

  const page = fs.readFileSync(PAGE, 'utf8');
  const a = page.indexOf(START);
  const b = page.indexOf(END);
  if (a < 0 || b < a) {
    console.error(`redteam-report: the markers ${START} and ${END} are missing in ${PAGE}.`);
    process.exit(1);
  }
  const eol = page.includes('\r\n') ? '\r\n' : '\n';
  fs.writeFileSync(PAGE, page.slice(0, a) + lines.join(eol) + page.slice(b + END.length));
}

main();
