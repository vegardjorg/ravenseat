// =============================================================
// redteam/rt13-hanging-gate.test.ts: RT-13 "a test that hangs never holds my merge forever" (plans/redteam-plan.md,
// finding 4).
//
// Why: receive always gave the quick gates a time budget, but merge gave it only when the base gate was on and was the
// same as the quick gates (cli/merge.mjs). With the base gate off, or with its own commands, one hanging test after the
// merge held the merge, and with it the queue, for as long as the test hung. Now the gates after the merge always get
// baseGate.timeoutSec: a gate over it is red, and the merge stops in bounded time.
//
// The gate is a small script that hangs in the main checkout and is green in the track's worktree, so receive passes
// and only the gates after the merge hang. baseGate.timeoutSec is 5 s here; the scenario must end well inside a minute.
// =============================================================
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { expectUserThingsIntact, snapshot, userMess } from './lab';
import { project, queueSpace, tmp } from './project';

/** A gate script outside the repo: hangs unless it runs in a queue worktree, or hangs everywhere. */
function hangingGate(everywhere = false) {
  const file = path.join(tmp('rt13-gate-'), 'gate.cjs');
  fs.writeFileSync(
    file,
    everywhere
      ? 'setInterval(() => {}, 1000);\n'
      : "if (!/[\\\\/]worktrees[\\\\/]/.test(process.cwd())) setInterval(() => {}, 1000);\n",
  );
  return `node "${file}"`;
}

const BUDGET = { baseGate: { enabled: false, timeoutSec: 5 } };

describe('RT-13: a test that hangs never holds my merge forever', () => {
  it('receive: a gate that hangs is red within the time budget', () => {
    const p = project({ gates: [hangingGate(true)], config: BUDGET });
    p.cloudDelivers('A');
    const c = p.run('cloud', 'collect');
    expect(c.code).not.toBe(0);
    expect(c.out).toMatch(/time budget of 5 s/);
    expect(c.ms).toBeLessThan(60_000);
  }, 120_000);

  it('merge with the base gate off: the gates after the merge stop at the budget, red, and nothing of the user\'s is touched', () => {
    const p = project({ gates: [hangingGate()], config: BUDGET });
    p.cloudDelivers('A');
    expect(p.run('cloud', 'collect').out).toMatch(/Gates GREEN/);
    userMess(p.repo);
    const before = snapshot(p.repo, p.folder);

    const m = p.merge('A');
    expect(m.ms, 'the merge must end within the budget, not hang').toBeLessThan(60_000);
    expect(m.code).not.toBe(0);
    expect(m.out).toMatch(/time budget of 5 s/);
    expect(p.taskOf('A')?.status).not.toBe('done');
    // The merge commit may stay on main for the fix round (that is how a red gate after the merge works today); the
    // user's own things may not change.
    expectUserThingsIntact(before, { ...queueSpace(), files: ['lib/A.ts'] });
  }, 180_000);
});
