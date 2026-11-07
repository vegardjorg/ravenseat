// =============================================================
// redteam/rt07-interrupted.test.ts: RT-07 "I can close the laptop in the middle, go on working, and resume"
// (plans/redteam-plan.md, R1).
//
// Why: queueFaultInjection kills the merge at fixed points with an injected merge runner. This is the same promise end
// to end with the real merge-track, gates.mjs and git: the merge process tree is killed while its gates run (as a crash
// or a closed laptop would), the user then commits something unrelated on main and edits a file, and `merge --resume`
// finishes the task. A finished task once, merged once, the user's commit kept, the user's edit untouched, no orphan lock.
// =============================================================
import { describe, it, expect } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expectUserThingsIntact, snapshot, userMess } from './lab';
import { project, SCRIPTS, tmp } from './project';

/**
 * A gate that, while the hold file exists, says it has started and then waits for ever; otherwise green. With `afterMerge`
 * it holds only where the track's file already is (the main checkout after the merge), not in the base check before it.
 */
function holdingGate({ afterMerge = true } = {}) {
  const dir = tmp('rt07-gate-');
  const hold = path.join(dir, 'hold');
  const started = path.join(dir, 'started');
  const file = path.join(dir, 'gate.cjs');
  fs.writeFileSync(
    file,
    `const fs = require('fs');\n` +
      `if (fs.existsSync(${JSON.stringify(hold)})${afterMerge ? " && fs.existsSync('lib/A.ts')" : ''}) { fs.writeFileSync(${JSON.stringify(started)}, 'x'); setInterval(() => {}, 1000); }\n`,
  );
  fs.writeFileSync(hold, 'x');
  return { command: `node "${file}"`, hold, started };
}

/** Kills a process and everything it started, without warning: no signal handler runs. */
function killTree(pid: number) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
  else process.kill(-pid, 'SIGKILL');
}

async function waitFor(file: string, ms = 60_000) {
  const until = Date.now() + ms;
  while (!fs.existsSync(file)) {
    if (Date.now() > until) throw new Error(`waited ${ms} ms for ${file}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** A received local track A, and its merge started as its own process tree and killed once the holding gate runs. */
async function killedMerge(afterMerge: boolean) {
  const gate = holdingGate({ afterMerge });
  const p = project({ gates: [gate.command] });
  const scratch = p.localDelivers('A');
  // receive runs the same gate in the worktree: let it pass there.
  fs.rmSync(gate.hold);
  expect(p.run('receive', 'A', '--scratchpad', scratch).code).toBe(0);
  // main moved on while the track ran, so the merged tree is new and the gates after the merge really run (on the same
  // tree as the track tip they are skipped: that run was green already).
  fs.writeFileSync(path.join(p.repo, 'base.txt'), 'main moved on\n');
  p.g(['add', '--', 'base.txt']);
  p.g(['commit', '-q', '-m', 'main moved on', '--', 'base.txt']);
  fs.writeFileSync(gate.hold, 'x');
  const child = spawn(process.execPath, [path.join(SCRIPTS, 'queue.mjs'), 'merge', 'A', '--scratchpad', scratch], {
    cwd: p.repo,
    env: p.env,
    detached: process.platform !== 'win32',
    stdio: 'ignore',
  });
  const exited = new Promise((r) => child.on('exit', r));
  await waitFor(gate.started);
  killTree(child.pid!);
  await exited;
  fs.rmSync(gate.hold);
  expect(p.taskOf('A')?.status).not.toBe('done');
  return { p, scratch };
}

/** The user goes on while the merge is down: an unrelated commit on main, and edits they keep uncommitted. */
function userWorksOn(p: ReturnType<typeof project>) {
  userMess(p.repo);
  fs.writeFileSync(path.join(p.repo, 'user.txt'), 'my own commit\n');
  p.g(['add', '--', 'user.txt']);
  p.g(['commit', '-q', '-m', 'my own work', '--', 'user.txt']);
  return p.g(['rev-parse', 'HEAD']);
}

describe('RT-07: interrupted in the middle, the user works on, and the queue finishes it', () => {
  it('killed in the gates after the merge: --resume marks done once and keeps the user\'s commit and edits', async () => {
    const { p, scratch } = await killedMerge(true);
    // The merge itself had happened before the kill.
    expect(p.g(['show', 'main:lib/A.ts'])).toBe('from the track');
    const userCommit = userWorksOn(p);
    const before = snapshot(p.repo, p.folder);

    const r = p.run('merge', 'A', '--resume', '--scratchpad', scratch);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/took over a stale merge lock/);
    expect(p.taskOf('A')?.status).toBe('done');
    expect(p.g(['merge-base', '--is-ancestor', userCommit, 'main'])).toBe('');
    expectUserThingsIntact(before, { untracked: ['.claude/'], branches: ['queue/A'], done: ['A'] });
  }, 240_000);

  it('killed in the base check before the merge: --resume says so, and a plain merge finishes it once', async () => {
    const { p, scratch } = await killedMerge(false);
    // Nothing was merged before the kill.
    expect(() => p.g(['show', 'main:lib/A.ts'])).toThrow();
    userWorksOn(p);
    const before = snapshot(p.repo, p.folder);

    const resume = p.run('merge', 'A', '--resume', '--scratchpad', scratch);
    expect(resume.code).not.toBe(0);
    expect(resume.out).toMatch(/nothing to resume: the merge itself has not happened.*Run ravenseat merge A \(without --resume\)/s);
    const r = p.run('merge', 'A', '--scratchpad', scratch);
    expect(r.code, r.out).toBe(0);
    expect(p.taskOf('A')?.status).toBe('done');
    expectUserThingsIntact(before, { untracked: ['.claude/'], branches: ['queue/A'], done: ['A'], files: ['lib/A.ts'] });
  }, 240_000);
});
