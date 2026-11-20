#!/usr/bin/env node
// =============================================================
// scripts/ci-shard-coverage.mjs: the CI check that every test file ran in one of the shards.
//
// Why: .github/workflows/ci.yml splits the Windows suite over shards (`vitest run --shard=i/N`). A split must never let
// a test file stop running quietly: a shard that crashed before its report, a file that fell between shards, or a
// listing that disagrees with what ran. This check is the job (`shards-complete`) that `needs` every shard.
//
// How: the expected files are what `vitest list --filesOnly --json=<file>` finds in the final job's checkout (the same
// discovery vitest uses, from vitest.config.mjs). Each shard writes a vitest JSON report (`--reporter=json
// --outputFile.json=...`) and uploads it. The check fails (exit 1) when:
//   - the listing is empty or cannot be read (it proves nothing then),
//   - there are fewer readable reports than shards, or a report cannot be read,
//   - a report is not green (success false, or a failed file or test),
//   - the shard job's result (`needs.<job>.result`, --needs-result) is not success,
//   - an expected file is in no report, or a report has a file the listing does not know.
// The shards run on Windows and this check on Ubuntu, so the absolute paths differ: the listing is made relative to
// --root, and a report path matches an expected file when it ends with `/<that relative path>`.
//
// Usage: node scripts/ci-shard-coverage.mjs --list <list.json> --root <dir> --reports <dir> --shards <n>
//                                           [--needs-result <success|failure|cancelled|skipped>]
//   --reports  a folder; every *.json file under it (any depth: download-artifact puts each artifact in its own folder)
//              is one shard report.
// Exit code: 0 all ran and green, 1 not, 2 usage error.
// =============================================================
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const slash = (p) => String(p).replace(/\\/g, '/');

/**
 * The check itself, without disk: pure, so the unit test pins every way it fails.
 * @param {{ expected: string[], shards: number, reports: Array<{ file: string, json: any, error?: string }>,
 *   needsResult?: string }} k  expected: repo-relative posix paths; json null when the report could not be read
 * @returns {{ ok: boolean, lines: string[] }}
 */
export function checkShards({ expected, shards, reports, needsResult }) {
  const problems = [];
  const want = [...new Set(expected.map(slash))].sort();
  if (!want.length) problems.push('the listing of test files is empty: nothing to compare with');
  if (needsResult != null && needsResult !== 'success') problems.push(`the shard jobs did not all succeed (result: ${needsResult})`);
  const readable = reports.filter((r) => r.json && typeof r.json === 'object');
  for (const r of reports) if (!readable.includes(r)) problems.push(`${r.file} cannot be read${r.error ? ` (${r.error})` : ''}`);
  if (readable.length < shards) problems.push(`${readable.length} readable shard report(s) for ${shards} shards: a shard left no report`);

  const seen = new Set();
  const unknown = [];
  for (const r of readable) {
    const results = Array.isArray(r.json.testResults) ? r.json.testResults : [];
    const failed = results.filter((t) => t?.status === 'failed').map((t) => slash(t.name));
    const green = r.json.success === true && !r.json.numFailedTestSuites && !r.json.numFailedTests && !failed.length;
    if (!green) problems.push(`${r.file} is not green${failed.length ? `: ${failed.length} failed file(s), first ${failed[0]}` : ''}`);
    for (const t of results) {
      const name = slash(t?.name ?? '');
      const hit = want.find((w) => name === w || name.endsWith(`/${w}`));
      if (hit) seen.add(hit);
      else unknown.push(name);
    }
  }
  const missing = want.filter((w) => !seen.has(w));
  if (missing.length) problems.push(`${missing.length} test file(s) ran in no shard: ${missing.join(', ')}`);
  if (unknown.length) problems.push(`${unknown.length} file(s) ran that the listing does not know: ${unknown.join(', ')}`);

  const lines = problems.map((p) => `FAIL: ${p}`);
  if (!problems.length) lines.push(`OK: ${seen.size} of ${want.length} test files ran in ${readable.length} shards, all green`);
  return { ok: !problems.length, lines };
}

/** Every *.json file under dir, at any depth, sorted. */
function jsonFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...jsonFiles(p));
    else if (e.isFile() && e.name.endsWith('.json')) out.push(p);
  }
  return out.sort();
}

const USAGE = 'Use: node scripts/ci-shard-coverage.mjs --list <list.json> --root <dir> --reports <dir> --shards <n> [--needs-result <r>]';

function main(argv) {
  const opt = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const listFile = opt('--list');
  const root = opt('--root');
  const reportDir = opt('--reports');
  const shards = Number(opt('--shards'));
  if (!listFile || !root || !reportDir || !Number.isInteger(shards) || shards < 1) {
    console.error(USAGE);
    return 2;
  }
  let expected = [];
  try {
    const rootSlash = slash(path.resolve(root)).replace(/\/$/, '');
    const list = JSON.parse(fs.readFileSync(listFile, 'utf8'));
    expected = list.map((x) => {
      const f = slash(path.resolve(root, x.file));
      return f.toLowerCase().startsWith(`${rootSlash.toLowerCase()}/`) ? f.slice(rootSlash.length + 1) : f;
    });
  } catch (e) {
    console.log(`FAIL: the listing ${listFile} cannot be read (${e.message})`);
    return 1;
  }
  let reports = [];
  try {
    reports = jsonFiles(reportDir).map((f) => {
      try {
        return { file: path.basename(f), json: JSON.parse(fs.readFileSync(f, 'utf8')) };
      } catch (e) {
        return { file: path.basename(f), json: null, error: e.message };
      }
    });
  } catch (e) {
    console.log(`FAIL: the report folder ${reportDir} cannot be read (${e.message})`);
    return 1;
  }
  const r = checkShards({ expected, shards, reports, needsResult: opt('--needs-result') });
  for (const l of r.lines) console.log(l);
  return r.ok ? 0 : 1;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = main(process.argv.slice(2));
}
