// =============================================================
// redteam/redOnBase-cli.test.ts: red on base (lib/redOnBase.js, gates.redOnBase) end to end through receive.
//
// Why: "red first" was only what the track wrote in its report. With gates.redOnBase set, receive runs the track's new
// or changed test files on the delivered tip (they must pass) and, with the track's code change taken away, one at a time
// (at least one must fail). A test that passes without the change shows nothing about it. The track's worktree is put
// back exactly as it was. Off by default: no line, nothing recorded.
// =============================================================
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { project, task } from './project';

const SUM = 'export const sum = (a, b) => a + b;\n';
const PROVING = [
  "import test from 'node:test';",
  "import assert from 'node:assert';",
  "import { sum } from '../sum.mjs';",
  "test('sum', () => assert.equal(sum(1, 2), 3));",
  '',
].join('\n');
const EMPTY = ["import test from 'node:test';", "test('nothing', () => {});", ''].join('\n');

/** redOnBase null = the key left out of the config (the default, off). */
function setup(testBody: string, redOnBase: unknown = 'node --test {files}') {
  const gates: Record<string, unknown> = { quick: ['node -e "process.exit(0)"'] };
  if (redOnBase !== null) gates.redOnBase = redOnBase;
  const p = project({ config: { gates }, tasks: [task('A')] });
  p.localDelivers('A', 'lib/sum.mjs');
  // The track's real work: the code and its test, one more commit on queue/A.
  const wt = path.join(p.repo, '.claude', 'worktrees', 'agent-A');
  fs.writeFileSync(path.join(wt, 'lib', 'sum.mjs'), SUM);
  fs.mkdirSync(path.join(wt, 'lib', '__tests__'), { recursive: true });
  fs.writeFileSync(path.join(wt, 'lib', '__tests__', 'sum.test.mjs'), testBody);
  p.g(['add', '--', 'lib'], wt);
  p.g(['commit', '-q', '-m', 'sum and its test'], wt);
  return { p, wt };
}

describe('red on base at receive', () => {
  it('a test that fails without the change and passes with it: one quiet line, recorded, worktree put back', () => {
    const { p, wt } = setup(PROVING);
    const r = p.run('receive', 'A');
    expect(r.out).toMatch(/Red on base A: 1 of 1/);
    expect(r.out).not.toMatch(/RED ON BASE A/);
    expect((p.taskOf('A') as { red_on_base?: { verdict: string } }).red_on_base?.verdict).toBe('proven');
    expect(p.g(['status', '--porcelain', '--untracked-files=no'], wt)).toBe('');
    // git may write the file back with CRLF (core.autocrlf on Windows): the content is what counts.
    expect(fs.readFileSync(path.join(wt, 'lib', 'sum.mjs'), 'utf8').replace(/\r\n/g, '\n')).toBe(SUM);
  }, 240_000);

  it('a test that passes without the change too: a warning naming the file', () => {
    const { p, wt } = setup(EMPTY);
    const r = p.run('receive', 'A');
    expect(r.out).toMatch(/RED ON BASE A: .*lib\/__tests__\/sum\.test\.mjs.*pass without/);
    expect((p.taskOf('A') as { red_on_base?: { verdict: string } }).red_on_base?.verdict).toBe('unproven');
    expect(p.g(['status', '--porcelain', '--untracked-files=no'], wt)).toBe('');
  }, 240_000);

  it('off by default: nothing said and nothing recorded', () => {
    const { p } = setup(PROVING, null);
    const r = p.run('receive', 'A');
    expect(r.out).not.toMatch(/Red on base A|RED ON BASE A/);
    expect(p.taskOf('A')).not.toHaveProperty('red_on_base');
  }, 240_000);
});
