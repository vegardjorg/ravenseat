// =============================================================
// ciShardCoverage.test.mjs: the CI check that every test file ran in one of the Windows shards
// (scripts/ci-shard-coverage.mjs, the `shards-complete` job in .github/workflows/ci.yml).
//
// Why: splitting the suite over shards must never let a test file stop running quietly. The check passes only when the
// shards' vitest JSON reports together name every file `vitest list --filesOnly` finds, every shard passed and every
// shard left a report. These tests pin each way it must fail (exit 1) and the one way it passes.
// =============================================================
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkShards } from '../ci-shard-coverage.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ci-shard-coverage.mjs');
const EXPECTED = ['plugin/a/__tests__/a.test.ts', 'plugin/a/__tests__/b.test.ts', 'scripts/__tests__/c.test.mjs'];

/** A vitest JSON report for the given files (absolute paths on a Windows runner), green unless told otherwise. */
function report(files, { success = true, failedFile = null } = {}) {
  return {
    success,
    numFailedTestSuites: failedFile ? 1 : 0,
    numFailedTests: failedFile ? 1 : 0,
    testResults: files.map((f) => ({ name: `D:/a/repo/repo/${f}`, status: f === failedFile ? 'failed' : 'passed' })),
  };
}

describe('checkShards: the pure check', () => {
  it('passes when the reports together name every file and every shard passed', () => {
    const r = checkShards({
      expected: EXPECTED,
      shards: 2,
      reports: [
        { file: 'vitest-shard-1.json', json: report(EXPECTED.slice(0, 2)) },
        { file: 'vitest-shard-2.json', json: report(EXPECTED.slice(2)) },
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.lines.at(-1)).toMatch(/OK: 3 of 3 test files ran in 2 shards/);
  });

  it('a file that is in no shard report fails and is named', () => {
    const r = checkShards({
      expected: EXPECTED,
      shards: 2,
      reports: [
        { file: 'vitest-shard-1.json', json: report(EXPECTED.slice(0, 1)) },
        { file: 'vitest-shard-2.json', json: report(EXPECTED.slice(2)) },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.lines.join('\n')).toContain('plugin/a/__tests__/b.test.ts');
  });

  it('a failed shard fails, also when every file is seen', () => {
    const r = checkShards({
      expected: EXPECTED,
      shards: 2,
      reports: [
        { file: 'vitest-shard-1.json', json: report(EXPECTED.slice(0, 2), { success: false, failedFile: EXPECTED[1] }) },
        { file: 'vitest-shard-2.json', json: report(EXPECTED.slice(2)) },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.lines.join('\n')).toMatch(/vitest-shard-1\.json.*not green/);
  });

  it('a missing or unreadable shard report fails', () => {
    const r = checkShards({
      expected: EXPECTED,
      shards: 3,
      reports: [
        { file: 'vitest-shard-1.json', json: report(EXPECTED) },
        { file: 'vitest-shard-2.json', json: null, error: 'Unexpected end of JSON input' },
      ],
    });
    expect(r.ok).toBe(false);
    const text = r.lines.join('\n');
    expect(text).toMatch(/vitest-shard-2\.json.*cannot be read/);
    expect(text).toMatch(/1 readable shard report\(s\) for 3 shards/);
  });

  it('a shard job that did not succeed fails (needs result), even with green reports', () => {
    const r = checkShards({
      expected: EXPECTED,
      shards: 1,
      needsResult: 'cancelled',
      reports: [{ file: 'vitest-shard-1.json', json: report(EXPECTED) }],
    });
    expect(r.ok).toBe(false);
    expect(r.lines.join('\n')).toMatch(/cancelled/);
  });

  it('an empty expected list fails: a listing that found nothing proves nothing', () => {
    const r = checkShards({ expected: [], shards: 1, reports: [{ file: 'vitest-shard-1.json', json: report([]) }] });
    expect(r.ok).toBe(false);
  });

  it('a file a shard ran that the listing does not know fails: the listing and the shards disagree', () => {
    const r = checkShards({
      expected: EXPECTED.slice(0, 2),
      shards: 1,
      reports: [{ file: 'vitest-shard-1.json', json: report(EXPECTED) }],
    });
    expect(r.ok).toBe(false);
    expect(r.lines.join('\n')).toContain('scripts/__tests__/c.test.mjs');
  });
});

describe('the command: exit codes', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ravenseat-shard-coverage-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Writes the listing (as `vitest list --filesOnly --json` does, absolute paths under root) and the reports. */
  function setUp(reports) {
    const root = path.join(dir, 'ws').replace(/\\/g, '/');
    fs.writeFileSync(path.join(dir, 'list.json'), JSON.stringify(EXPECTED.map((f) => ({ file: `${root}/${f}` }))));
    const rdir = path.join(dir, 'reports');
    fs.mkdirSync(rdir);
    for (const [name, json] of Object.entries(reports)) {
      const sub = path.join(rdir, name.replace(/\.json$/, ''));
      fs.mkdirSync(sub);
      fs.writeFileSync(path.join(sub, name), typeof json === 'string' ? json : JSON.stringify(json));
    }
    return { root, rdir };
  }
  const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

  it('exit 0 when every file ran and every shard is green', () => {
    const { root, rdir } = setUp({ 'vitest-shard-1.json': report(EXPECTED.slice(0, 1)), 'vitest-shard-2.json': report(EXPECTED.slice(1)) });
    const r = run(['--list', path.join(dir, 'list.json'), '--root', root, '--reports', rdir, '--shards', '2', '--needs-result', 'success']);
    expect(r.stdout + r.stderr).toMatch(/OK: 3 of 3/);
    expect(r.status).toBe(0);
  });

  it('exit 1 when a file is in no shard report', () => {
    const { root, rdir } = setUp({ 'vitest-shard-1.json': report(EXPECTED.slice(0, 1)), 'vitest-shard-2.json': report(EXPECTED.slice(2)) });
    const r = run(['--list', path.join(dir, 'list.json'), '--root', root, '--reports', rdir, '--shards', '2']);
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toContain('plugin/a/__tests__/b.test.ts');
  });

  it('exit 1 when a shard failed', () => {
    const { root, rdir } = setUp({
      'vitest-shard-1.json': report(EXPECTED.slice(0, 1), { success: false, failedFile: EXPECTED[0] }),
      'vitest-shard-2.json': report(EXPECTED.slice(1)),
    });
    const r = run(['--list', path.join(dir, 'list.json'), '--root', root, '--reports', rdir, '--shards', '2']);
    expect(r.status).toBe(1);
  });

  /** A rerun keeps the first attempt's artifacts: writes each report in its own artifact folder (name given). */
  function setUpAttempts(folders) {
    const { root, rdir } = setUp({});
    for (const [folder, [name, json]] of Object.entries(folders)) {
      fs.mkdirSync(path.join(rdir, folder));
      fs.writeFileSync(path.join(rdir, folder, name), JSON.stringify(json));
    }
    return { root, rdir };
  }

  it('a rerun: only the newest attempt of each shard counts, so a red first attempt does not fail a green rerun', () => {
    const { root, rdir } = setUpAttempts({
      'vitest-shard-1-attempt-1': ['vitest-shard-1.json', report(EXPECTED.slice(0, 1))],
      'vitest-shard-2-attempt-1': ['vitest-shard-2.json', report(EXPECTED.slice(1), { success: false, failedFile: EXPECTED[1] })],
      'vitest-shard-2-attempt-2': ['vitest-shard-2.json', report(EXPECTED.slice(1))],
    });
    const r = run(['--list', path.join(dir, 'list.json'), '--root', root, '--reports', rdir, '--shards', '2', '--needs-result', 'success']);
    expect(r.stdout + r.stderr).toMatch(/OK: 3 of 3/);
    expect(r.status).toBe(0);
  });

  it('a rerun: a red newest attempt still fails, also when an older attempt was green', () => {
    const { root, rdir } = setUpAttempts({
      'vitest-shard-1-attempt-1': ['vitest-shard-1.json', report(EXPECTED.slice(0, 1))],
      'vitest-shard-2-attempt-1': ['vitest-shard-2.json', report(EXPECTED.slice(1))],
      'vitest-shard-2-attempt-10': ['vitest-shard-2.json', report(EXPECTED.slice(1), { success: false, failedFile: EXPECTED[1] })],
    });
    const r = run(['--list', path.join(dir, 'list.json'), '--root', root, '--reports', rdir, '--shards', '2']);
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toContain('not green');
  });

  it('ci.yml names each shard artifact with the run attempt, which newestAttempts reads', () => {
    const yml = fs.readFileSync(path.join(path.dirname(SCRIPT), '..', '.github', 'workflows', 'ci.yml'), 'utf8');
    expect(yml).toContain('name: vitest-shard-${{ matrix.shard }}-attempt-${{ github.run_attempt }}');
  });

  it('exit 1 when a report is broken JSON, exit 2 on a usage error', () => {
    const { root, rdir } = setUp({ 'vitest-shard-1.json': '{ broken' });
    expect(run(['--list', path.join(dir, 'list.json'), '--root', root, '--reports', rdir, '--shards', '1']).status).toBe(1);
    expect(run(['--shards', '1']).status).toBe(2);
  });
});
