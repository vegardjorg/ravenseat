// =============================================================
// queueFocusLimit.test.ts: one focus step limit for `focus set`, `focus add` and the board's plan save (QA-1c Q12).
//
// Before, only the board's "Save focus" refused more than 50 steps, while `focus set` and `focus add` had no limit, so
// an owner who ran 50+ focus tasks from the CLI could no longer save the plan from the board. Now all three share one
// sanity cap (queueLogic.FOCUS_STEPS_MAX, 500; not a setting) with the same message (FOCUS_STEPS_ERROR), and the pause
// changes in one plan keep their own small limit.
//
// What the tests prove:
//   - the logic: setFocus, addFocusStep and saveFocusPlan take 51 steps and exactly the limit, refuse the limit + 1 with
//     the same message, and change nothing when they refuse; the pause changes keep their own limit and message,
//   - the CLI: `ravenseat focus set` with 51 steps and with the limit works, with the limit + 1 it is refused with the
//     message; `focus add` up to the limit works, one more is refused; `focus save --file` the same,
//   - the board API: POST /api/focus { plan } with 51 steps and with the limit previews and saves (also when the body
//     is larger than the old 16 KB request cap), and the limit + 1 is refused with the same message.
// Every queue is synthetic and lives in a temporary folder (never the real queue).
// =============================================================
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import net from 'node:net';
import { tmpdir } from 'os';
import { join } from 'path';
import { boardOpen, keyFileArgs } from './boardKey';

/* eslint-disable @typescript-eslint/no-require-imports */
const L = require('../queueLogic.js') as {
  FOCUS_STEPS_MAX: number;
  FOCUS_STEPS_ERROR: string;
  FOCUS_PLAN_MAX: number;
  setFocus: (queue: unknown, input: unknown, now?: string) => any;
  addFocusStep: (queue: unknown, raw: string | string[], option?: unknown) => any;
  saveFocusPlan: (queue: unknown, input: unknown, now?: string) => any;
};
/* eslint-enable @typescript-eslint/no-require-imports */

const ORCH = join(__dirname, '..', '..');
const QUEUE_MJS = join(ORCH, 'queue.mjs');
const iso = new Date(Date.now() - 86_400_000).toISOString();
const MAX = L.FOCUS_STEPS_MAX;

/**
 * A long task id (37 characters), so that a plan with the limit of steps is well over the old 16 KB request cap of
 * the board: 500 x `"task:<id>",` is about 22 KB.
 */
const id = (n: number) => `LIMITSTEPS-PADDINGPADDINGPADDING-${String(n).padStart(4, '0')}`;
const step = (n: number) => `task:${id(n)}`;
const steps = (from: number, count: number) => Array.from({ length: count }, (_, i) => step(from + i));

function task(n: number) {
  return {
    id: id(n),
    title: `Task ${n}`,
    project: 'limit',
    domain: `limit-${n}`,
    class: 'K',
    value: 5,
    content_min: 30,
    status: 'waiting',
    depends_on: [],
    waiting_on: [],
    owned_files: [`file/${n}.ts`],
    owner_db: [],
    shared_patch: [],
    mission: `scripts/.queue/mission/${n}.md`,
    added_by: 'test',
    added_at: iso,
  };
}

/** MAX + 5 waiting tasks, so every test can ask for the limit + 1 steps; optionally with a focus already set. */
function makeQueue(order: string[] | null = null): any {
  return {
    created: iso,
    limits: { maxConcurrent: 5, maxDPlus: 2, maxPerDomain: 5, maxDb: 2 },
    tasks: Array.from({ length: MAX + 5 }, (_, i) => task(i + 1)),
    projects: { limit: { title: 'Limit test', prefixes: ['LIMITSTEPS-'] } },
    areas: {},
    question: [],
    resolutions: [],
    changelog: [],
    ...(order ? { focus: { from: iso, rest: 'fill', order, drag_with_dependencies: true } } : {}),
  };
}

describe('the shared limit', () => {
  it('is 500, a sanity cap, and the old FOCUS_PLAN_MAX name is the same number', () => {
    expect(MAX).toBe(500);
    expect(L.FOCUS_PLAN_MAX).toBe(MAX);
    expect(L.FOCUS_STEPS_ERROR).toMatch(/at most 500 steps/);
  });
});

describe('the logic: set, add and the plan save share the limit and the message', () => {
  it('setFocus takes 51 steps and the limit, and refuses the limit + 1 with nothing changed', () => {
    for (const n of [51, MAX]) {
      const q = makeQueue();
      const r = L.setFocus(q, { order: steps(1, n) });
      expect(r.error, `${n} steps`).toEqual([]);
      expect(q.focus.order).toHaveLength(n);
    }
    const q = makeQueue();
    const r = L.setFocus(q, { order: steps(1, MAX + 1) });
    expect(r.error).toEqual([L.FOCUS_STEPS_ERROR]);
    expect(q.focus).toBeUndefined();
  });

  it('addFocusStep goes up to the limit, and refuses a step past it (one or several) with nothing changed', () => {
    const q = makeQueue(steps(1, 50));
    expect(L.addFocusStep(q, step(51)).error).toEqual([]);
    expect(q.focus.order).toHaveLength(51);
    expect(L.addFocusStep(q, steps(52, MAX - 51)).error).toEqual([]);
    expect(q.focus.order).toHaveLength(MAX);
    const before = JSON.stringify(q);
    expect(L.addFocusStep(q, step(MAX + 1)).error).toEqual([L.FOCUS_STEPS_ERROR]);
    expect(JSON.stringify(q)).toBe(before);
    // Several at once that would pass the limit: refused as a whole.
    const q2 = makeQueue(steps(1, MAX - 1));
    expect(L.addFocusStep(q2, steps(MAX, 2)).error).toEqual([L.FOCUS_STEPS_ERROR]);
    expect(q2.focus.order).toHaveLength(MAX - 1);
  });

  it('saveFocusPlan takes 51 steps and the limit, and refuses the limit + 1 with the same message', () => {
    for (const n of [51, MAX]) {
      const q = makeQueue();
      expect(L.saveFocusPlan(q, { order: steps(1, n) }).error, `${n} steps`).toEqual([]);
      expect(q.focus.order).toHaveLength(n);
    }
    const q = makeQueue();
    expect(L.saveFocusPlan(q, { order: steps(1, MAX + 1) }).error).toEqual([L.FOCUS_STEPS_ERROR]);
    expect(q.focus).toBeUndefined();
  });

  it('the pause changes keep their own limit and their own message', () => {
    const q = makeQueue();
    const many = Array.from({ length: 51 }, (_, i) => `p${i}`);
    const r = L.saveFocusPlan(q, { order: steps(1, 3), pause: many });
    // The cap comes first; the unknown project ids are named after it (they are not in the register).
    expect(r.error[0]).toMatch(/at most 50 pause changes/);
    expect(r.error).not.toContain(L.FOCUS_STEPS_ERROR);
    expect(q.focus).toBeUndefined();
  });
});

describe('the CLI: focus set, focus add and focus save', () => {
  let folder: string;
  function run(args: string[]): { code: number; out: string; error: string } {
    try {
      const out = execFileSync(process.execPath, [QUEUE_MJS, ...args], {
        env: { ...process.env, QUEUE_FOLDER: folder, QUEUE_GIT: folder, QUEUE_TIME_LOG: join(folder, 'times.jsonl') },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { code: 0, out, error: '' };
    } catch (e) {
      const x = e as { status: number; stdout: string; stderr: string };
      return { code: x.status, out: x.stdout ?? '', error: x.stderr ?? '' };
    }
  }
  const readQueue = () => JSON.parse(readFileSync(join(folder, 'queue.json'), 'utf8'));
  const writeQueue = (q: unknown) => writeFileSync(join(folder, 'queue.json'), JSON.stringify({ ...(q as object), next_migr: 1000 }, null, 2));
  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'queue-focus-limit-'));
    writeQueue(makeQueue());
  });
  afterEach(() => rmSync(folder, { recursive: true, force: true }));

  it('focus set takes 51 steps and the limit; the limit + 1 is refused with the message', () => {
    const r51 = run(['focus', 'set', ...steps(1, 51)]);
    expect(r51.code, r51.error).toBe(0);
    expect(readQueue().focus.order).toHaveLength(51);
    const rMax = run(['focus', 'set', ...steps(1, MAX)]);
    expect(rMax.code, rMax.error).toBe(0);
    expect(readQueue().focus.order).toHaveLength(MAX);
    const over = run(['focus', 'set', ...steps(1, MAX + 1)]);
    expect(over.code).not.toBe(0);
    expect(over.error + over.out).toContain(L.FOCUS_STEPS_ERROR);
    expect(readQueue().focus.order).toHaveLength(MAX);
  }, 60_000);

  it('focus add goes past 50 and up to the limit; one more is refused with the message', () => {
    writeQueue(makeQueue(steps(1, 50)));
    const r = run(['focus', 'add', step(51), '--json']);
    expect(r.code, r.error).toBe(0);
    expect(readQueue().focus.order).toHaveLength(51);
    writeQueue(makeQueue(steps(1, MAX - 1)));
    expect(run(['focus', 'add', step(MAX), '--json']).code).toBe(0);
    expect(readQueue().focus.order).toHaveLength(MAX);
    const over = run(['focus', 'add', step(MAX + 1), '--json']);
    expect(over.code).toBe(1);
    expect(JSON.parse(over.out.trim().split('\n').pop() ?? '{}').error).toEqual([L.FOCUS_STEPS_ERROR]);
    expect(readQueue().focus.order).toHaveLength(MAX);
  }, 60_000);

  it('focus save --file takes the limit and refuses the limit + 1 with the message', () => {
    const plan = join(folder, 'plan.json');
    writeFileSync(plan, JSON.stringify({ order: steps(1, MAX), pause: [], continue: [] }));
    const ok = run(['focus', 'save', '--file', plan, '--json']);
    expect(ok.code, ok.error).toBe(0);
    expect(readQueue().focus.order).toHaveLength(MAX);
    writeFileSync(plan, JSON.stringify({ order: steps(1, MAX + 1), pause: [], continue: [] }));
    const over = run(['focus', 'save', '--file', plan, '--json']);
    expect(over.code).toBe(1);
    expect(JSON.parse(over.out.trim().split('\n').pop() ?? '{}').error).toEqual([L.FOCUS_STEPS_ERROR]);
  }, 60_000);
});

describe('the board API: POST /api/focus { plan }', () => {
  let root = '';
  let board: ChildProcess | null = null;
  let base = '';
  let key = '';
  const KF = keyFileArgs();
  const queueFile = () => join(root, 'q', 'queue.json');
  const post = async (body: object) => {
    const r = await fetch(`${base}/api/focus`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, 'x-queue-key': key },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: (await r.json()) as any };
  };
  /** Preview, then save with the preview's version, as the board's "Save focus" does. */
  const save = async (order: string[]) => {
    const plan = { order, pause: [], continue: [] };
    const dry = await post({ plan, dry: true });
    if (dry.status !== 200 || !dry.body.can) return { dry, saved: null };
    const saved = await post({ plan, expect: dry.body.changed });
    return { dry, saved };
  };

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'ravenseat-focus-limit-'));
    const folder = join(root, 'q');
    mkdirSync(folder);
    const env = {
      ...process.env,
      QUEUE_ROOT: root,
      QUEUE_FOLDER: folder,
      QUEUE_CONFIG: join(root, 'no-config.json'),
      QUEUE_TIME_LOG: join(root, 'times.jsonl'),
      QUEUE_GIT: root,
      DISABLE_UPDATES: '1',
    };
    execFileSync(process.execPath, [QUEUE_MJS, 'init'], { cwd: root, env, stdio: 'ignore' });
    const start = JSON.parse(readFileSync(queueFile(), 'utf8'));
    writeFileSync(queueFile(), JSON.stringify({ ...start, ...makeQueue() }, null, 2));
    const port = await new Promise<number>((done) => {
      const s = net.createServer().listen(0, '127.0.0.1', () => {
        const p = (s.address() as net.AddressInfo).port;
        s.close(() => done(p));
      });
    });
    board = spawn(process.execPath, [join(ORCH, 'queue-board.mjs'), '--port', String(port), ...KF.args], {
      cwd: root,
      env,
    });
    await new Promise<void>((done, fail) => {
      let out = '';
      const t = setTimeout(() => fail(new Error(`no start line: ${out}`)), 60_000);
      board!.stdout!.on('data', (d) => {
        out += String(d);
        const m = boardOpen(out, KF.file);
        if (m) {
          clearTimeout(t);
          base = m[1];
          key = m[2];
          done();
        }
      });
    });
  }, 120_000);

  afterAll(async () => {
    if (board && board.exitCode == null) {
      const gone = new Promise((done) => board!.once('exit', done));
      board.kill();
      await gone;
    }
    if (root) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    rmSync(join(KF.file, '..'), { recursive: true, force: true });
  });

  it('saves a plan of 51 steps', async () => {
    const { dry, saved } = await save(steps(1, 51));
    expect(dry.status, JSON.stringify(dry.body)).toBe(200);
    expect(dry.body.can).toBe(true);
    expect(saved?.status, JSON.stringify(saved?.body)).toBe(200);
    expect(JSON.parse(readFileSync(queueFile(), 'utf8')).focus.order).toHaveLength(51);
  }, 60_000);

  it('saves a plan of exactly the limit, a body over the old 16 KB cap', async () => {
    const order = steps(1, MAX);
    expect(JSON.stringify({ plan: { order } }).length).toBeGreaterThan(16_384);
    const { dry, saved } = await save(order);
    expect(dry.status, JSON.stringify(dry.body)).toBe(200);
    expect(saved?.status, JSON.stringify(saved?.body)).toBe(200);
    expect(JSON.parse(readFileSync(queueFile(), 'utf8')).focus.order).toHaveLength(MAX);
  }, 60_000);

  it('refuses the limit + 1 with the same message, and nothing changes', async () => {
    const r = await post({ plan: { order: steps(1, MAX + 1), pause: [], continue: [] }, dry: true });
    expect(r.status).toBe(400);
    expect(r.body.message).toBe(L.FOCUS_STEPS_ERROR);
    const save = await post({ plan: { order: steps(1, MAX + 1), pause: [], continue: [] } });
    expect(save.status).toBe(400);
    expect(save.body.message).toBe(L.FOCUS_STEPS_ERROR);
    expect(JSON.parse(readFileSync(queueFile(), 'utf8')).focus.order).toHaveLength(MAX);
  }, 60_000);
});
