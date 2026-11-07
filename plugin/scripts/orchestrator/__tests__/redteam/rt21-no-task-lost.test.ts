// =============================================================
// redteam/rt21-no-task-lost.test.ts: RT-21 "no task disappears, none is doubled, none is done without proof"
// (plans/redteam-plan.md, R2).
//
// Why: a queue file that still parses is not the same as a queue that still has all the work. A queue of 20 tasks with
// mixed dependencies gets many changes at the same moment, as real processes: starts (one twice, one of a task that may
// not start yet), new tasks added, an edit, a cancel and a real merge of a delivered track. Then the same queue after a
// crash in the middle of a write: the lock of a process that is gone and its half-written temporary file. Afterwards every
// task is there exactly once, in a state that can be explained, and the only done task is the one merged into main.
// The crash is the trace it leaves, not a random kill (rule: no random process kills).
// =============================================================
import { describe, it, expect } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expectUserThingsIntact, snapshot } from './lab';
import { project, SCRIPTS, task } from './project';

type P = ReturnType<typeof project>;
type Run = { code: number | null; out: string };
type Task = { id: string; status: string; value?: number; attempts?: { id: string }[]; depends_on?: string[] };

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

/** T01..T20, each in its own domain; every fourth waits on the one three before it, T19 and T20 on two. */
const twenty = () =>
  Array.from({ length: 20 }, (_, i) => {
    const n = i + 1;
    const id = `T${String(n).padStart(2, '0')}`;
    const dep = (k: number) => `T${String(k).padStart(2, '0')}`;
    const depends_on = n === 19 || n === 20 ? [dep(1), dep(2)] : n % 4 === 0 ? [dep(n - 3)] : [];
    return task(id, { domain: `d${n}`, depends_on });
  });

const queueOf = (p: P) => JSON.parse(fs.readFileSync(path.join(p.folder, 'queue.json'), 'utf8')) as { tasks: Task[] };
const newTask = (p: P, id: string) => {
  const f = path.join(p.folder, `add-${id}.json`);
  fs.writeFileSync(f, JSON.stringify([task(id, { domain: `n-${id}`, content_min: 120 })]));
  return ['add', '--file', f];
};

/** The ids, each with how often it occurs: every one must be 1. */
function countIds(tasks: Task[]) {
  const n = new Map<string, number>();
  for (const t of tasks) n.set(t.id, (n.get(t.id) ?? 0) + 1);
  return n;
}

describe('RT-21: no task disappears, none is doubled, none is done without proof', () => {
  it('20 tasks and many changes at the same moment, a merge among them: every task once, only the merged one done', async () => {
    const p = project({ tasks: twenty() });
    // Room for every start below: a start refused by the limit on concurrent tracks is right, but not what this tests.
    expect(p.run('limit', 'maxConcurrent', '10').code).toBe(0);
    const scratch = p.localDelivers('T05');
    expect(p.run('receive', 'T05', '--scratchpad', scratch).code).toBe(0);
    const tip = p.g(['rev-parse', 'queue/T05']);
    const before = snapshot(p.repo, p.folder);

    const runs = await together(p, [
      ['start', 'T01'],
      ['start', 'T02'],
      ['start', 'T03'],
      ['start', 'T01'],
      ['start', 'T04'],
      newTask(p, 'N1'),
      newTask(p, 'N2'),
      newTask(p, 'N3'),
      ['edit', 'T10', '--json', JSON.stringify({ value: 9 })],
      ['cancel', 'T20'],
      ['merge', 'T05', '--scratchpad', scratch],
    ]);
    const all = runs.map((r, i) => `#${i} code=${r.code}\n${r.out}`).join('\n----\n');
    for (const r of runs) expect(r.out, all).not.toMatch(/TypeError|SyntaxError|Unexpected end of JSON|ENOENT/);

    const tasks = queueOf(p).tasks;
    const ids = countIds(tasks);
    expect([...ids.values()].every((n) => n === 1), all).toBe(true);
    expect([...ids.keys()].sort()).toEqual([...twenty().map((t) => t.id), 'N1', 'N2', 'N3'].sort());
    const t = (id: string) => tasks.find((x) => x.id === id)!;

    // Every state is the one its command explains.
    for (const id of ['T01', 'T02', 'T03']) {
      expect(t(id).status, all).toBe('running');
      expect(t(id).attempts?.map((x) => x.id)).toEqual(['a1']);
    }
    expect(t('T04').status).toBe('waiting');
    expect(runs[4].out).toMatch(/T04 cannot be started: waiting on T01/);
    expect(runs.filter((r, i) => i <= 3 && r.code !== 0).map((r) => r.out).join('')).toMatch(/T01 cannot be started: status running/);
    expect(t('T10').value).toBe(9);
    expect(t('T20').status).toBe('cancelled');
    // The only done task is the merged one, and its work is in main.
    expect(tasks.filter((x) => x.status === 'done').map((x) => x.id)).toEqual(['T05']);
    expect(p.g(['merge-base', '--is-ancestor', tip, 'main'])).toBe('');
    // The merge's last step fills free slots, so more tasks may be running than the three started here. Each running task
    // has one attempt and only done dependencies; every other one still waits.
    const done = new Set(tasks.filter((x) => x.status === 'done').map((x) => x.id));
    for (const x of tasks.filter((y) => !['T05', 'T20'].includes(y.id))) {
      expect(['waiting', 'running'], x.id).toContain(x.status);
      if (x.status !== 'running') continue;
      expect(x.attempts?.length, x.id).toBe(1);
      for (const d of x.depends_on ?? []) expect(done.has(d), `${x.id} runs while ${d} is not done`).toBe(true);
    }
    expect(fs.readdirSync(p.folder)).not.toContain('.lockState');

    expectUserThingsIntact(before, {
      untracked: ['.claude/'],
      branches: ['queue/T05'],
      done: ['T05'],
      files: ['lib/T05.ts'],
      added: ['N1', 'N2', 'N3'],
    });
  }, 240_000);

  it('done by hand without proof is allowed but warned about, with the tasks it frees (finding 9)', () => {
    const p = project({ tasks: [task('A'), task('B', { depends_on: ['A'] }), task('C'), task('D')] });
    // Never started, nothing on a branch.
    const never = p.run('set', 'A', 'done');
    expect(never.code).toBe(0);
    expect(never.out).toMatch(/WARNING: A is set done by hand, but the queue never started it.*B wait\(s\) on it and can start now/);
    // Started, with a commit on its branch that is not in main.
    p.localDelivers('C');
    const open = p.run('set', 'C', 'done');
    expect(open.out).toMatch(/WARNING: C is set done by hand, but branch queue\/C has 1 commit\(s\) that are not in main.*set C review, then .* merge C/);
    // Started, and its branch merged by hand: that is proof enough, no warning.
    p.localDelivers('D');
    p.g(['merge', '-q', '--no-ff', '--no-edit', 'queue/D']);
    const merged = p.run('set', 'D', 'done');
    expect(merged.code).toBe(0);
    expect(merged.out).not.toMatch(/WARNING: D/);
    // Done again is no news.
    expect(p.run('set', 'A', 'done').out).not.toMatch(/WARNING/);
  }, 120_000);

  it('after a crash in the middle of a write: the dead lock is taken over, the half file ignored, nothing lost', async () => {
    const p = project({ tasks: twenty() });
    const queueFile = path.join(p.folder, 'queue.json');
    const was = fs.readFileSync(queueFile, 'utf8');
    // What a process killed in the middle of a write leaves: its lock token and its half-written temporary file.
    const dead = spawnSync(process.execPath, ['-e', '']).pid!;
    const lock = path.join(p.folder, '.lockState');
    fs.mkdirSync(lock);
    fs.writeFileSync(
      path.join(lock, 'owner-1.json'),
      JSON.stringify({ generation: 1, pid: dead, nonce: 'crashed', hostname: os.hostname(), started: new Date().toISOString() }),
    );
    const half = `${queueFile}.${dead}.tmp`;
    fs.writeFileSync(half, was.slice(0, Math.floor(was.length / 2)));

    const runs = await together(p, [['start', 'T01'], ['start', 'T02'], newTask(p, 'N1'), ['cancel', 'T20']]);
    const all = runs.map((r, i) => `#${i} code=${r.code}\n${r.out}`).join('\n----\n');
    for (const r of runs) expect(r.code, all).toBe(0);

    const tasks = queueOf(p).tasks;
    expect([...countIds(tasks).values()].every((n) => n === 1)).toBe(true);
    expect(tasks).toHaveLength(21);
    expect(tasks.find((x) => x.id === 'T01')?.status).toBe('running');
    expect(tasks.find((x) => x.id === 'T02')?.status).toBe('running');
    expect(tasks.find((x) => x.id === 'T20')?.status).toBe('cancelled');
    expect(tasks.filter((x) => x.status === 'done')).toEqual([]);
    expect(fs.readdirSync(p.folder)).not.toContain('.lockState');
    // The half file never became the queue; doctor names it, so it is not left unnoticed.
    expect(fs.readFileSync(half, 'utf8')).toBe(was.slice(0, Math.floor(was.length / 2)));
    const doctor = p.run('doctor');
    expect(doctor.out).toMatch(new RegExp(`INFO\\s+queue\\s+left over from an interrupted write: queue\\.json\\.${dead}\\.tmp`));
  }, 240_000);
});
