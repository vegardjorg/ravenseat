// =============================================================
// redteam/rt03-two-sessions.test.ts: RT-03 "two sessions on the same queue do not start or merge a task twice"
// (plans/redteam-plan.md, R2).
//
// Why: the user forgets an old session and opens a new one, and both pick up the queue. Ravenseat does not elect one
// orchestrator (the docs say to stop the old session first); the promise is smaller and testable: no double start, no
// double merge, no broken queue. Both sessions are real processes started at the same moment, on the real queue lock,
// the real merge lock and real git.
// =============================================================
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expectUserThingsIntact, snapshot, userMess } from './lab';
import { project, SCRIPTS, tmp } from './project';

type P = ReturnType<typeof project>;
type Run = { code: number | null; out: string };

/** The commands as separate processes, all started before any of them ends. */
function together(p: P, runs: string[][]): Promise<Run[]> {
  return Promise.all(
    runs.map(
      (args) =>
        new Promise<Run>((resolve) => {
          const c = spawn(process.execPath, [path.join(SCRIPTS, 'queue.mjs'), ...args], { cwd: p.repo, env: p.env });
          let out = '';
          c.stdout.on('data', (d) => (out += d));
          c.stderr.on('data', (d) => (out += d));
          c.on('close', (code) => resolve({ code, out }));
        }),
    ),
  );
}

/** A green gate that takes 1.5 s, so two runs started together always overlap. */
function slowGate() {
  const file = path.join(tmp('rt03-gate-'), 'gate.cjs');
  fs.writeFileSync(file, 'setTimeout(() => process.exit(0), 1500);\n');
  return `node "${file}"`;
}

const queueOf = (p: P) => JSON.parse(fs.readFileSync(path.join(p.folder, 'queue.json'), 'utf8'));

describe('RT-03: two sessions on the same queue', () => {
  it('start and fill at the same time: the task is started once, with one attempt, and the queue reads', async () => {
    const p = project();
    const runs = await together(p, [['start', 'A'], ['start', 'A'], ['fill', '--ids', 'A'], ['fill', '--ids', 'A'], ['start', 'A']]);
    for (const r of runs) expect(r.out).not.toMatch(/TypeError|SyntaxError|Unexpected end of JSON/);
    const q = queueOf(p);
    expect(q.tasks.map((t: { id: string }) => t.id).sort()).toEqual(['A', 'B']);
    const a = q.tasks.find((t: { id: string }) => t.id === 'A');
    expect(a.status).toBe('running');
    expect(a.attempts.map((x: { id: string }) => x.id)).toEqual(['a1']);
    // Every start that lost says why: the task is running already.
    for (const r of runs.filter((x) => x.code !== 0)) expect(r.out).toMatch(/status running/);
    expect(fs.readdirSync(p.folder)).not.toContain('.lockState');
  }, 120_000);

  it('two tracks received at the same moment: both green, neither reads the other\'s evidence as tampering', async () => {
    const p = project({ gates: [slowGate()] });
    const scratchA = p.localDelivers('A');
    const scratchB = p.localDelivers('B');
    const runs = await together(p, [['receive', 'A', '--scratchpad', scratchA], ['receive', 'B', '--scratchpad', scratchB]]);
    const all = runs.map((r) => r.out).join('\n----\n');
    // Before the evidence lock both went red here, one of them as TAMPERED with a stop for the owner.
    expect(all).not.toMatch(/TAMPERED|left no evidence/);
    for (const r of runs) expect(r.code, all).toBe(0);
    expect(p.taskOf('A')?.status).toBe('review');
    expect(p.taskOf('B')?.status).toBe('review');
  }, 240_000);

  it('both sessions receive and merge the same delivered track: merged once, done once, the user\'s work intact', async () => {
    const p = project({ gates: [slowGate()] });
    userMess(p.repo);
    const scratch = p.localDelivers('A');
    const before = snapshot(p.repo, p.folder);

    const received = await together(p, [['receive', 'A', '--scratchpad', scratch], ['receive', 'A', '--scratchpad', scratch]]);
    const both = received.map((r) => r.out).join('\n----\n');
    expect(both).not.toMatch(/TAMPERED|left no evidence/);
    expect(received.some((r) => r.code === 0), both).toBe(true);
    const merged = await together(p, [['merge', 'A', '--scratchpad', scratch], ['merge', 'A', '--scratchpad', scratch]]);
    const won = merged.filter((r) => r.code === 0);
    expect(won.length, merged.map((r) => r.out).join('\n----\n')).toBeGreaterThanOrEqual(1);
    // The other one either waited and found the task done, or was refused while the first held the merge lock.
    for (const r of merged.filter((x) => x.code !== 0)) expect(r.out).toMatch(/Another ravenseat merge is running in this repo.*nothing was done/s);
    // The second session tries again later, as the message says: the task is done, nothing is merged again.
    const again = p.run('merge', 'A', '--scratchpad', scratch);
    expect(again.code).not.toBe(0);
    expect(again.out).toMatch(/A has status done/);

    // Exactly one merge of queue/A in main, and the task done once.
    const merges = p.g(['log', '--merges', '--format=%s', 'main']).split('\n').filter((s) => s.includes('queue/A'));
    expect(merges).toHaveLength(1);
    expect(p.taskOf('A')?.status).toBe('done');
    expect(fs.readdirSync(p.folder)).not.toContain('.lockState');
    expectUserThingsIntact(before, { untracked: ['.claude/'], branches: ['queue/A'], done: ['A'], files: ['lib/A.ts'] });
  }, 240_000);
});
