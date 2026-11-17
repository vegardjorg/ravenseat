// =============================================================
// redteam/rt15-hanging-gate.test.ts: RT-15 "a test that hangs never holds my merge forever" (plans/redteam-plan.md,
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
import { FIXTURE_CAP_MS, project, queueSpace, stillAlive, tmp } from './project';

/**
 * A gate script outside the repo: hangs unless it runs in a queue worktree, or hangs everywhere. A hanging one still
 * ends by itself after FIXTURE_CAP_MS (red, so it never reads as a pass), far beyond every budget here, so a red run of
 * this file cannot leave it running for days.
 */
function hangingGate(everywhere = false) {
  const file = path.join(tmp('rt15-gate-'), 'gate.cjs');
  const hang = `{ setInterval(() => {}, 1000); setTimeout(() => process.exit(1), ${FIXTURE_CAP_MS}); }`;
  fs.writeFileSync(file, everywhere ? `${hang}\n` : `if (!/[\\\\/]worktrees[\\\\/]/.test(process.cwd())) ${hang}\n`);
  return `node "${file}"`;
}

/** The gate's own folder name: unique (mkdtemp), so it marks the gate's processes and nothing else. */
const folderOf = (command: string) => path.basename(path.dirname(command.replace(/^node "|"$/g, '')));

/** The command lines of the gate's processes still alive a moment after the run (a kill can take a moment to land). */
const gateLeftovers = async (command: string) => (await stillAlive(folderOf(command))).map((p) => p.command);

const BUDGET = { baseGate: { enabled: false, timeoutSec: 5 } };

describe('RT-15: a test that hangs never holds my merge forever', () => {
  it('receive: a gate that hangs is red within the time budget, and is ended with everything it started', async () => {
    const gate = hangingGate(true);
    const p = project({ gates: [gate], config: BUDGET });
    p.cloudDelivers('A');
    const c = p.run('cloud', 'collect');
    expect(c.code).not.toBe(0);
    expect(c.out).toMatch(/time budget of 5 s/);
    expect(c.ms).toBeLessThan(60_000);
    expect(await gateLeftovers(gate), 'a process of the hanging gate outlived the budget').toEqual([]);
  }, 120_000);

  it('merge with the base gate\'s own command hanging: the base check stops at the budget and leaves no process behind', async () => {
    // The base check runs its commands through lib/doneCheck.js runDoneWhen (spawnSync), not through gates.mjs: there a
    // timeout used to end only the shell, and on Windows the hanging node it had started lived on with a dead parent.
    const gate = hangingGate();
    const p = project({ config: { baseGate: { timeoutSec: 5, commands: [gate] } } });
    p.cloudDelivers('A');
    expect(p.run('cloud', 'collect').out).toMatch(/Gates GREEN/);
    const m = p.merge('A');
    expect(m.ms, 'the merge must end within the budget, not hang').toBeLessThan(60_000);
    expect(m.code).not.toBe(0);
    expect(p.taskOf('A')?.status).not.toBe('done');
    expect(await gateLeftovers(gate), 'a process of the hanging base check outlived the budget').toEqual([]);
  }, 180_000);

  it('merge with the base gate off: the gates after the merge stop at the budget, red, and nothing of the user\'s is touched', async () => {
    const gate = hangingGate();
    const p = project({ gates: [gate], config: BUDGET });
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
    expect(await gateLeftovers(gate), 'a process of the hanging gate outlived the budget').toEqual([]);
  }, 180_000);
});
