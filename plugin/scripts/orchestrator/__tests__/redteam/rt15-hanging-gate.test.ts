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
//
// The same promise when the runner itself dies: the process that started a gate command can die without warning (a crash,
// SIGKILL, taskkill without /T, a closed terminal), and the command's time budget dies with it. A hanging command then
// lived on for ever: on POSIX it ran in its own process group (a kill of the parent's group never reached it), and on
// Windows a child outlives a parent that is ended alone. Each runner now starts its command through a guard
// (lib/treeRun.js) that ends the command's whole tree once the runner is gone. One scenario per runner: gates.mjs, the
// treeRun supervisor (lib/doneCheck.js runDoneWhen: the base gate, done_when, red-on-base) and lib/waitRunner.js. Only
// the runner is killed (no tree), and on POSIX also its process group, as a crashed merge's tree would be.
// =============================================================
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expectUserThingsIntact, snapshot, userMess } from './lab';
import { FIXTURE_CAP_MS, killTree, leftovers, ownTree, project, queueSpace, SCRIPTS, stillAlive, tmp } from './project';

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

const posix = process.platform !== 'win32';

/** A command that writes its marker file and then hangs (up to FIXTURE_CAP_MS). Its folder name marks its processes. */
function hangingCommand() {
  const dir = tmp('og-gate-');
  const started = path.join(dir, 'started');
  const file = path.join(dir, 'gate.cjs');
  fs.writeFileSync(
    file,
    `require('fs').writeFileSync(${JSON.stringify(started)}, 'x');\n` +
      `setInterval(() => {}, 1000);\nsetTimeout(() => process.exit(1), ${FIXTURE_CAP_MS});\n`,
  );
  return { file, command: `node "${file}"`, started, mark: path.basename(dir) };
}

async function waitFor(file: string, ms = 60_000) {
  const until = Date.now() + ms;
  while (!fs.existsSync(file)) {
    if (Date.now() > until) throw new Error(`waited ${ms} ms for ${file}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** The processes with `mark` in their command line, once none are left or `ms` has passed. */
async function aliveAfter(mark: string, ms: number) {
  const until = Date.now() + ms;
  let left = leftovers(mark);
  while (left.length && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 500));
    left = leftovers(mark);
  }
  return left;
}

/** Kills the parent without warning: only it, or (POSIX, `group`) its whole process group. No handler runs. */
function killParent(pid: number, group: boolean) {
  if (group) process.kill(-pid, 'SIGKILL');
  else process.kill(pid, 'SIGKILL');
}

/** Starts `args` under node as the parent, waits until the hanging command runs, kills the parent, and lists what lives. */
async function crash(args: string[], gate: ReturnType<typeof hangingCommand>, { group = false, env = process.env, cwd = process.cwd() } = {}) {
  const parent = spawn(process.execPath, args, { cwd, env, detached: posix, stdio: 'ignore' });
  ownTree(parent.pid);
  const exited = new Promise((r) => parent.on('exit', r));
  try {
    await waitFor(gate.started);
  } catch (e) {
    killTree(parent.pid!);
    throw e;
  }
  killParent(parent.pid!, group);
  await exited;
  // The guard looks every second; a tree kill and the process listing take a moment more on Windows.
  const left = await aliveAfter(gate.mark, 15_000);
  for (const p of left) killTree(p.pid); // a red run: the leftover guard would end them anyway
  return left.map((p) => p.command);
}

const kills = posix ? [false, true] : [false];
const how = (group: boolean) => (group ? 'its process group is killed' : 'it alone is killed');

describe('RT-15: a runner that dies without warning takes its hanging command along', () => {
  for (const group of kills) {
    it(`gates.mjs: ${how(group)} while a gate hangs, and the gate does not live on`, async () => {
      const gate = hangingCommand();
      const p = project({ gates: [gate.command] });
      const left = await crash([path.join(SCRIPTS, 'gates.mjs'), '--quick', '--timeout-sec', '600', '--cwd', p.repo], gate, {
        group,
        env: p.env,
        cwd: p.repo,
      });
      expect(left, 'the gate outlived gates.mjs').toEqual([]);
    }, 120_000);

    it(`treeRun runBounded (runDoneWhen): ${how(group)} while the command hangs, and the command does not live on`, async () => {
      const gate = hangingCommand();
      const caller = path.join(tmp('og-caller-'), 'caller.cjs');
      fs.writeFileSync(
        caller,
        `require(${JSON.stringify(path.join(SCRIPTS, 'lib', 'treeRun.js'))}).runBounded(${JSON.stringify(gate.command)}, { cwd: process.cwd(), timeoutMs: 600000 });\n`,
      );
      const left = await crash([caller], gate, { group });
      expect(left, 'the command outlived the caller of runBounded').toEqual([]);
    }, 120_000);

    it(`waitRunner: ${how(group)} while its command hangs, and the command does not live on`, async () => {
      const gate = hangingCommand();
      const dir = tmp('og-wait-');
      const f = (n: string) => path.join(dir, n);
      fs.writeFileSync(f('lock'), 'run-1');
      const left = await crash(
        [path.join(SCRIPTS, 'lib', 'waitRunner.js'), f('done'), f('pid'), '600', f('lock'), 'run-1', '--', gate.file],
        gate,
        { group },
      );
      expect(left, 'the command outlived the wait runner').toEqual([]);
    }, 120_000);
  }
});
