// =============================================================
// redteam/focusStop-cli.test.ts: a focus marker (.only, fit, fdescribe) on an added line in a test file stops the merge.
//
// Why: `.only` makes the runner skip every other test in the file (and in some runners the whole run), so the gates go
// green while most tests never ran. Nobody means to merge one. A skip can be intended (a flaky test with an issue link),
// so skips stay a warning (lib/testWeakening.js); focus is the one marker that stops. --allow-focus overrides, logged.
// testWeakening.focusStop false turns the stop off.
// =============================================================
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { project, task } from './project';

function delivered(testBody: string, config: Record<string, unknown> = {}) {
  const p = project({ config, tasks: [task('A')] });
  const scratch = p.localDelivers('A');
  const wt = path.join(p.repo, '.claude', 'worktrees', 'agent-A');
  fs.mkdirSync(path.join(wt, 'lib', '__tests__'), { recursive: true });
  fs.writeFileSync(path.join(wt, 'lib', '__tests__', 'a.test.ts'), testBody);
  p.g(['add', '--', 'lib'], wt);
  p.g(['commit', '-q', '-m', 'a test'], wt);
  const r = p.run('receive', 'A', '--scratchpad', scratch);
  expect(r.code, r.out).toBe(0);
  return p;
}

const ONLY = "import { it } from 'vitest';\nit.only('adds', () => {});\n";
const SKIP = "import { it } from 'vitest';\nit.skip('adds', () => {});\n";

describe('a focus marker stops the merge', () => {
  it('it.only on an added line: STOP, nothing merged', () => {
    const p = delivered(ONLY);
    const m = p.merge('A');
    expect(m.code).not.toBe(0);
    expect(m.out).toMatch(/STOP: A is not merged\. .*focus marker/);
    expect(m.out).toContain('lib/__tests__/a.test.ts');
    expect(p.taskOf('A')?.status).toBe('review');
  }, 240_000);

  it('--allow-focus goes past the stop, logged', () => {
    const p = delivered(ONLY);
    const m = p.run('merge', 'A', '--scratchpad', path.join(p.folder, 'collect', 'A'), '--allow-focus');
    expect(m.out).not.toMatch(/STOP: A is not merged\. .*focus marker/);
    expect(m.out).toContain('focus-overridden');
  }, 240_000);

  it('a skip is only a warning, and focusStop false turns the stop off', () => {
    expect(delivered(SKIP).merge('A').out).not.toMatch(/focus marker/);
    expect(delivered(ONLY, { testWeakening: { focusStop: false } }).merge('A').out).not.toMatch(/STOP: A is not merged\. .*focus marker/);
  }, 240_000);
});
