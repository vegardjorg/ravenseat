// =============================================================
// ownerWait.test.ts: `cq wait` exits when the owner acts, and only then.
//
// The orchestrator only runs when an agent finishes or the owner types in the session, so a board answer could sit
// unseen. `cq wait` (cli/wait.mjs, rules in lib/ownerWait.js) runs in the background and exits on an owner action. Proven
// where it is enforced: the pure rules in ownerWait.js, and queue.mjs wait spawned as a child process against a queue in
// a temporary folder (never the real one), with short debounce and timeout values:
//   - an owner resolve fires it (exit 0, one OWNER ACTED line, never the answer text),
//   - agent and orchestrator writes and actions from before the start do not; --since moves the start point,
//   - the debounce window batches several actions into one line,
//   - TIMEOUT exits 10,
//   - one waiter at a time (ALREADY WAITING), a stale lock is taken over, the lock and the heartbeat are removed on exit,
//   - the heartbeat file is written, and the board's heartbeatState reads it.
// =============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type Change = { id?: string; pid?: string; field: string; before: unknown; after: unknown };
type Entry = { nr: number; at: string; by: string; action: string; changes: Change[]; undone?: { at: string; by: string } };
type Task = Record<string, unknown> & { id: string };
type Queue = {
  tasks: Task[];
  changelog?: Entry[];
  resolutions?: Record<string, { time: string; answer: string | null; by: string | null }>;
  auto_accepted?: { id: string; at: string }[];
  [k: string]: unknown;
};
type Act = { action: string; id: string };

// eslint-disable-next-line @typescript-eslint/no-require-imports
const W = require('../ownerWait.js') as {
  OWNER_BY: Set<string>;
  HEARTBEAT_FILE: string;
  LISTENING_MAX_AGE_MS: number;
  lastLogNr: (q: Queue) => number;
  snapshot: (q: Queue, o?: { since?: number | null }) => unknown;
  ownerActions: (q: Queue, base: unknown) => Act[];
  actedLine: (acts: Act[]) => string;
  pidAlive: (pid: unknown) => boolean;
  heartbeatState: (folder: string, now?: number) => { listening: boolean; beatAt: string | null };
};

const T0 = '2026-10-01T00:00:00.000Z';
const T1 = '2026-11-01T10:00:00.000Z';
const SECRET = 'the-secret-answer-text';

function task(id: string, x: Record<string, unknown> = {}): Task {
  return {
    id,
    title: `Task ${id}`,
    domain: 'client',
    class: 'K',
    status: 'waiting',
    mission: 'Do it.',
    project: 'tasks',
    feature: 'f',
    value: 5,
    content_min: 30,
    migr_tens: 0,
    depends_on: [],
    waiting_on: [],
    owned_files: [],
    owner_db: [],
    shared_patch: [],
    added_at: T0,
    ...x,
  };
}

/** A queue with: T-1 plain, T-2 waiting on Q1/Q2, T-3 proposed by an agent, T-4 done and waiting on QA. */
function baseQueue(): Queue {
  return {
    created: T0,
    limits: { maxConcurrent: 5, maxDPlus: 2, maxPerDomain: 7 },
    resolved: [],
    projects: { tasks: { title: 'Tasks', prefixes: ['T-'] } },
    tasks: [
      task('T-1'),
      task('T-2', { waiting_on: ['Q1', 'Q2'] }),
      task('T-3', { status: 'proposed', added_by: 'T-1' }),
      task('T-4', { status: 'done', qa_status: 'waiting', done: T0 }),
    ],
    question: {
      Q1: { type: 'question', text: 'Which one?', added_at: T0 },
      Q2: { type: 'question', text: 'And this?', added_at: T0 },
    },
    changed: T0,
  };
}

const entry = (nr: number, by: string, id = 'T-1', action = 'edit'): Entry => ({
  nr,
  at: T1,
  by,
  action,
  changes: [{ id, field: 'value', before: 5, after: 6 }],
});

// ---- The pure rules ----
describe('ownerWait.js: what counts as an owner action', () => {
  it('a changelog entry by owner or theBoard after the start point counts; agents, cq and older entries do not', () => {
    const q = baseQueue();
    q.changelog = [entry(1, 'theBoard')];
    const base = W.snapshot(q);
    q.changelog.push(entry(2, 'T-2'), entry(3, 'cq'), entry(4, 'theBoard', 'T-2', 'cancel'));
    expect(W.ownerActions(q, base)).toEqual([{ action: 'cancel', id: 'T-2' }]);
    // --since 0: the first entry counts too.
    expect(W.ownerActions(q, W.snapshot(baseQueue(), { since: 0 }))).toEqual([
      { action: 'edit', id: 'T-1' },
      { action: 'cancel', id: 'T-2' },
    ]);
  });

  it('resolve, approve, qa ok, qa fail, add and undo by the owner are found; auto and agent ones are not', () => {
    const q = baseQueue();
    q.changelog = [entry(1, 'T-2')];
    const base = W.snapshot(q);
    q.resolutions = {
      Q1: { time: T1, answer: SECRET, by: 'owner' },
      Q2: { time: T1, answer: 'x', by: null },
    };
    q.tasks[2].approved = T1;
    q.tasks[3].qa_ok = T1;
    q.tasks[0].qa_status = 'deviation';
    q.tasks[0].qa_note = SECRET;
    q.tasks.push(task('T-5', { added_by: 'owner' }), task('T-6', { added_by: 'T-1' }));
    q.tasks.push(task('T-1-QA1', { added_by: 'owner', qa_original: 'T-1' }));
    q.changelog[0].undone = { at: T1, by: 'theBoard' };
    const acts = W.ownerActions(q, base);
    expect(acts).toEqual([
      { action: 'undo', id: 'T-1' },
      { action: 'resolve', id: 'Q1' },
      { action: 'qa fail', id: 'T-1' },
      { action: 'approve', id: 'T-3' },
      { action: 'qa ok', id: 'T-4' },
      { action: 'add', id: 'T-5' },
    ]);
    expect(W.actedLine(acts)).toBe('OWNER ACTED: undo T-1; resolve Q1; qa fail T-1; approve T-3; qa ok T-4; add T-5');
    expect(W.actedLine(acts)).not.toContain(SECRET);
  });

  it('an auto-accepted proposal and an auto QA close are not owner actions', () => {
    const q = baseQueue();
    const base = W.snapshot(q);
    q.tasks[2].approved = T1;
    q.auto_accepted = [{ id: 'T-3', at: T1 }];
    q.tasks[3].qa_ok = T1;
    q.tasks[3].qa_ok_by = 'auto';
    expect(W.ownerActions(q, base)).toEqual([]);
  });

  it('heartbeatState: fresh is listening, old or missing or broken is not', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cq-wait-hb-'));
    try {
      expect(W.heartbeatState(dir).listening).toBe(false);
      const file = path.join(dir, W.HEARTBEAT_FILE);
      const now = Date.parse(T1);
      fs.writeFileSync(file, JSON.stringify({ pid: 1, startedAt: T1, beatAt: T1 }));
      expect(W.heartbeatState(dir, now + 30_000).listening).toBe(true);
      expect(W.heartbeatState(dir, now + W.LISTENING_MAX_AGE_MS + 1).listening).toBe(false);
      fs.writeFileSync(file, '{ not json');
      expect(W.heartbeatState(dir).listening).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---- queue.mjs wait as a child process ----
describe('queue.mjs wait', () => {
  const QUEUE_MJS = path.resolve(__dirname, '..', '..', 'queue.mjs');
  let root = '';
  let folder = '';
  let env: NodeJS.ProcessEnv = {};
  const children: ChildProcess[] = [];

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cq-wait-'));
    folder = path.join(root, 'q');
    fs.mkdirSync(folder);
    env = {
      ...process.env,
      QUEUE_ROOT: root,
      QUEUE_FOLDER: folder,
      QUEUE_CONFIG: path.join(root, 'no-config.json'),
      QUEUE_TIME_LOG: path.join(root, 'times.jsonl'),
      QUEUE_GIT: root,
      DISABLE_UPDATES: '1',
    };
  });
  afterEach(async () => {
    // A waiter still running holds the folder open (its cwd) on Windows: stop it and wait for it to close first.
    for (const c of children.splice(0))
      if (c.exitCode == null && c.signalCode == null) {
        const closed = new Promise((r) => c.on('close', r));
        c.kill();
        await closed;
      }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const writeQueue = (q: Queue) => fs.writeFileSync(path.join(folder, 'queue.json'), JSON.stringify(q, null, 2));
  const lockFile = () => path.join(folder, 'wait.lock');
  const beatFile = () => path.join(folder, W.HEARTBEAT_FILE);

  /** Starts queue.mjs with the arguments; `done` resolves with the exit code and the output. */
  function start(...args: string[]) {
    const p = spawn(process.execPath, [QUEUE_MJS, ...args], { cwd: root, env });
    children.push(p);
    let out = '';
    p.stdout!.on('data', (d) => (out += String(d)));
    p.stderr!.on('data', (d) => (out += String(d)));
    const done = new Promise<{ code: number | null; out: string }>((resolve, reject) => {
      p.on('error', reject);
      p.on('close', (code) => resolve({ code, out }));
    });
    return { p, done, out: () => out };
  }
  const cq = async (...args: string[]) => {
    const r = await start(...args).done;
    expect(r.code, r.out).toBe(0);
    return r.out;
  };
  /** Polls until the waiter has written its start line (it then holds the lock and has taken its snapshot). */
  async function started(w: { out: () => string }) {
    const deadline = Date.now() + 30_000;
    while (!/Waiting for the owner/.test(w.out())) {
      if (Date.now() > deadline) throw new Error(`the waiter did not start: ${w.out()}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  it('fires on an owner resolve: one OWNER ACTED line with the id, never the answer text; lock and heartbeat removed', async () => {
    writeQueue(baseQueue());
    const w = start('wait', '--debounce', '0.5', '--timeout', '0.05');
    await started(w);
    expect(fs.existsSync(lockFile())).toBe(true);
    const beat = JSON.parse(fs.readFileSync(beatFile(), 'utf8'));
    expect(beat.pid).toBe(w.p.pid);
    expect(Number.isFinite(Date.parse(beat.startedAt))).toBe(true);
    expect(Number.isFinite(Date.parse(beat.beatAt))).toBe(true);
    expect(W.heartbeatState(folder).listening).toBe(true);
    await cq('resolve', 'Q1', '--answer', SECRET, '--by', 'owner');
    const r = await w.done;
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('OWNER ACTED: resolve Q1\n');
    expect(r.out).toContain('run: cq resolutions --unlogged');
    expect(r.out).not.toContain(SECRET);
    expect(r.out.match(/OWNER ACTED/g)).toHaveLength(1);
    expect(fs.existsSync(lockFile())).toBe(false);
    expect(fs.existsSync(beatFile())).toBe(false);
  });

  it('ignores agent and orchestrator writes and what was there before it started; TIMEOUT exits 10', async () => {
    const q = baseQueue();
    q.changelog = [entry(1, 'theBoard')];
    q.resolutions = { Q2: { time: T0, answer: 'old', by: 'owner' } };
    writeQueue(q);
    const w = start('wait', '--debounce', '0', '--timeout', String(4 / 3600));
    await started(w);
    await cq('edit', 'T-1', '--json', '{"value":7}', '--by', 'T-2');
    await cq('resolve', 'Q1', '--answer', 'from the orchestrator');
    const r = await w.done;
    expect(r.out).not.toContain('OWNER ACTED');
    expect(r.out).toContain('TIMEOUT');
    expect(r.code).toBe(10);
    expect(fs.existsSync(lockFile())).toBe(false);
  });

  it('--since moves the start point: an owner entry already in the changelog fires at once', async () => {
    const q = baseQueue();
    q.changelog = [entry(1, 'theBoard', 'T-1'), entry(2, 'theBoard', 'T-2', 'cancel')];
    writeQueue(q);
    const r = await start('wait', '--since', '1', '--debounce', '0', '--timeout', '0.01').done;
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('OWNER ACTED: cancel T-2\n');
  });

  it('the debounce window batches several owner actions into one line', async () => {
    writeQueue(baseQueue());
    const w = start('wait', '--debounce', '6', '--timeout', '0.05');
    await started(w);
    await cq('resolve', 'Q1', '--answer', SECRET, '--by', 'owner');
    await cq('resolve', 'Q2', '--answer', 'b', '--by', 'theBoard');
    await cq('approve', 'T-3');
    await cq('qa', 'ok', 'T-4');
    await cq('edit', 'T-1', '--json', '{"value":8}', '--by', 'theBoard');
    const r = await w.done;
    expect(r.code, r.out).toBe(0);
    const lines = r.out.split('\n').filter((l) => l.startsWith('OWNER ACTED'));
    expect(lines).toHaveLength(1);
    // The logged edits come first, then resolutions, then the task fields.
    expect(lines[0]).toBe('OWNER ACTED: edit T-1; resolve Q1, Q2; approve T-3; qa ok T-4');
    expect(r.out).not.toContain(SECRET);
  }, 90_000);

  it('one waiter at a time: a second one prints ALREADY WAITING (pid n) and exits 0', async () => {
    writeQueue(baseQueue());
    const w = start('wait', '--timeout', '0.05');
    await started(w);
    const second = await start('wait').done;
    expect(second.code).toBe(0);
    expect(second.out.trim()).toBe(`ALREADY WAITING (pid ${w.p.pid})`);
    // The second one must not have touched the first one's lock.
    expect(JSON.parse(fs.readFileSync(lockFile(), 'utf8')).pid).toBe(w.p.pid);
  });

  it('a stale lock (dead pid) is taken over', async () => {
    const q = baseQueue();
    q.changelog = [entry(1, 'theBoard')];
    writeQueue(q);
    // A pid that existed and is gone: a node process that has exited.
    const gone = spawn(process.execPath, ['-e', '0']);
    await new Promise((r) => gone.on('close', r));
    const deadPid = gone.pid!;
    expect(W.pidAlive(deadPid)).toBe(false);
    fs.writeFileSync(lockFile(), JSON.stringify({ pid: deadPid, startedAt: T0 }));
    const r = await start('wait', '--since', '0', '--debounce', '0', '--timeout', '0.01').done;
    expect(r.code, r.out).toBe(0);
    expect(r.out).not.toContain('ALREADY WAITING');
    expect(r.out).toContain('OWNER ACTED: edit T-1');
    expect(fs.existsSync(lockFile())).toBe(false);
  });
});
