// =============================================================
// redteam/fixTest-cli.test.ts: "a fix needs a red test first" end to end through receive and merge (lib/fixTests.js).
//
// Why: a fix whose test passes without the fix too (or a fix with no test at all) shows nothing about the bug it says
// it fixed, and the same bug can come back unnoticed. With gates.redOnBase set, receive already knows the verdict; for a
// fix task (here one with `fixes`) it says so in one line and logs the row as "fixed without test", which the repeat
// count reads. The default is that warning only. gates.redOnBaseStrict (opt-in) stops the merge, and --allow-no-test is
// the owner's way past it, logged.
// =============================================================
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { project, task } from './project';

const SUM = 'export const sum = (a, b) => a + b;\n';
// A test that passes with or without the change: it proves nothing about the fix.
const EMPTY = ["import test from 'node:test';", "test('nothing', () => {});", ''].join('\n');

function delivered(gatesExtra: Record<string, unknown> = {}) {
  const gates = { quick: ['node -e "process.exit(0)"'], redOnBase: 'node --test {files}', ...gatesExtra };
  const p = project({ config: { gates }, tasks: [task('A'), task('F', { fixes: ['A'], owned_files: ['lib/F.ts', 'lib/sum.mjs', 'lib/__tests__/sum.test.mjs'] })] });
  const scratch = p.localDelivers('F', 'lib/sum.mjs');
  const wt = path.join(p.repo, '.claude', 'worktrees', 'agent-F');
  fs.writeFileSync(path.join(wt, 'lib', 'sum.mjs'), SUM);
  fs.mkdirSync(path.join(wt, 'lib', '__tests__'), { recursive: true });
  fs.writeFileSync(path.join(wt, 'lib', '__tests__', 'sum.test.mjs'), EMPTY);
  p.g(['add', '--', 'lib'], wt);
  p.g(['commit', '-q', '-m', 'the fix and a test that proves nothing'], wt);
  const r = p.run('receive', 'F', '--scratchpad', scratch);
  expect(r.code, r.out).toBe(0);
  return { p, r };
}

const rowsOf = (folder: string) =>
  fs.readFileSync(path.join(folder, 'findings.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

describe('a fix needs a red test first', () => {
  it('the default: one warning line at receive, the row marked fixed without test, and no stop at merge', () => {
    const { p, r } = delivered();
    expect(r.out).toMatch(/FIX WITHOUT TEST F: .*fixes A/);
    // The fix line replaces the plain red on base warning: one line, not two.
    expect(r.out).not.toMatch(/RED ON BASE F/);
    expect(rowsOf(p.folder)).toMatchObject([
      { caught_by: 'red-on-base', task: 'F', cause_task: 'A', fix: 'fixes', status: 'fixed-without-test', test_added: { verdict: 'unproven' } },
    ]);
    expect(p.merge('F').out).not.toMatch(/STOP: F is not merged\. .*red test/);
  }, 240_000);

  it('gates.fixWithoutTestWarning false: no fix line (the plain red on base line stays), the row is still marked', () => {
    const { p, r } = delivered({ fixWithoutTestWarning: false });
    expect(r.out).not.toMatch(/FIX WITHOUT TEST F/);
    expect(r.out).toMatch(/RED ON BASE F/);
    // The mark is data for the repeat count, not friction, so the warning setting leaves it.
    expect(rowsOf(p.folder)).toMatchObject([{ caught_by: 'red-on-base', task: 'F', status: 'fixed-without-test' }]);
  }, 240_000);

  it('the strict mode (opt-in): the merge stops, nothing merged', () => {
    const { p } = delivered({ redOnBaseStrict: true });
    const m = p.merge('F');
    expect(m.code).not.toBe(0);
    expect(m.out).toMatch(/STOP: F is not merged\. .*red test/);
    expect(m.out).toContain('--allow-no-test');
    expect(p.taskOf('F')?.status).toBe('review');
  }, 240_000);

  it('the strict mode: --allow-no-test goes past the stop, logged', () => {
    const { p } = delivered({ redOnBaseStrict: true });
    const m = p.run('merge', 'F', '--scratchpad', path.join(p.folder, 'collect', 'F'), '--allow-no-test');
    expect(m.out).not.toMatch(/STOP: F is not merged\. .*red test/);
    expect(m.out).toContain('no-test-overridden');
    expect(fs.readFileSync(path.join(p.folder, 'times.jsonl'), 'utf8')).toMatch(/"event":"no-test-overridden"/);
  }, 240_000);
});
