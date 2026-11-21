// =============================================================
// planCheckpointCli.test.ts: PG-4 and PG-8 through queue.mjs, against a copy of the queue in a temporary folder.
//   - `plan checkpoint` offers staging for a gated plan and gives the CP-<plan> question; a small plan and `off` do not,
//   - a staged add (stage 1 plus the rest waiting on CP-<plan>) is stored with `after`; `question` lists it as a
//     checkpoint that opens later, and resolve refuses it before stage 1 is done (or takes it with --early),
//   - once stage 1 is done, Adjust parks the rest for a rewrite and Continue lets it start,
//   - `add` prints the large batch line for 5 unplanned tasks, not for 4, not with a plan, not with the setting at 0.
// =============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const P = require('../queuePlan.js');

const QUEUE_MJS = join(__dirname, '..', '..', 'queue.mjs');

describe('staged queueing and the large batch line in the CLI', () => {
  let folder: string;
  let config: string | null;
  const run = (args: string[]) => {
    const env: Record<string, string | undefined> = {
      ...process.env,
      QUEUE_FOLDER: folder,
      QUEUE_GIT: folder,
      QUEUE_TIME_LOG: join(folder, 'times.jsonl'),
      QUEUE_PLAN_SOURCE_ROOT: folder,
    };
    if (config) env.QUEUE_CONFIG = config;
    else delete env.QUEUE_CONFIG;
    try {
      const out = execFileSync(process.execPath, [QUEUE_MJS, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return { code: 0, out, error: '' };
    } catch (e) {
      const x = e as { status: number; stdout: string; stderr: string };
      return { code: x.status, out: String(x.stdout ?? ''), error: String(x.stderr ?? '') };
    }
  };
  const json = (args: string[]) => JSON.parse(run([...args, '--json']).out.trim().split('\n').pop() ?? 'null');
  const readQueue = () => JSON.parse(readFileSync(join(folder, 'queue.json'), 'utf8'));
  const writeQueue = (q: object) => writeFileSync(join(folder, 'queue.json'), JSON.stringify(q));
  const file = (name: string, content: unknown) => {
    const p = join(folder, name);
    writeFileSync(p, JSON.stringify(content));
    return p;
  };
  const task = (id: string, own: object = {}) => ({
    id,
    title: `Task ${id}`,
    domain: 'client',
    class: 'K',
    project: 'p',
    feature: 'export',
    mission: `Do ${id}.`,
    content_min: 90,
    owned_files: [`src/${id}.ts`],
    ...own,
  });
  const useConfig = (o: object) => {
    config = join(folder, 'queue.config.json');
    writeFileSync(config, JSON.stringify(o));
  };

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'plan-checkpoint-'));
    config = null;
    const projects = { p: { title: 'P', area: 'a' } };
    writeQueue({
      tasks: [],
      resolved: [],
      projects,
      areas: { a: { title: 'A' } },
      question: {},
      limits: { maxConcurrent: 5, maxDPlus: 2, maxPerDomain: 7, maxDb: 6 },
      next_migr: 100,
    });
    const reg = P.emptyRegister('2026-11-21T09:00:00.000Z');
    for (const [id, size] of [['PL-EX-1', 'L'], ['PL-SM-1', 'S']]) {
      const r = P.newEntry(
        reg,
        { id, title: id, project: 'p', priority: 'later', priority_reason: 'Rule 8.', maturity: 'planned', size },
        { role: 'agent', projects, question: {} },
      );
      if (r.error.length) throw new Error(r.error.join('; '));
    }
    writeFileSync(join(folder, 'plans.json'), JSON.stringify(reg));
  });
  afterEach(() => rmSync(folder, { recursive: true, force: true }));

  it('plan checkpoint: a large plan is offered staging with the CP question; small and off are not', () => {
    const r = json(['plan', 'checkpoint', '--plan', 'PL-EX-1', '--stage', 'EX-1,EX-2', '--success', 'exports open']);
    expect(r.offer.offer).toBe(true);
    expect(r.offer.ask).toBe(true);
    expect(r.checkpoint.id).toBe('CP-PL-EX-1');
    expect(r.checkpoint.question.after).toEqual(['EX-1', 'EX-2']);
    expect(json(['plan', 'checkpoint', '--plan', 'PL-SM-1']).offer.offer).toBe(false);
    expect(json(['plan', 'checkpoint', '--smallest', '--stage', 'AB-1']).checkpoint.id).toBe('CP-AB-1');
    expect(run(['plan', 'checkpoint', '--plan', 'PL-EX-1']).out).toMatch(/Stage it \(recommended\)/);
    expect(run(['plan', 'checkpoint', '--plan', 'PL-NOPE-1']).code).toBe(1);
    useConfig({ plans: { checkpoint: 'off' } });
    expect(json(['plan', 'checkpoint', '--plan', 'PL-EX-1', '--stage', 'EX-1']).checkpoint).toBeNull();
  });

  it('a staged add: hidden until stage 1 is done, resolve waits for it, Adjust parks and Continue starts the rest', () => {
    const cp = json(['plan', 'checkpoint', '--plan', 'PL-EX-1', '--stage', 'EX-1,EX-2']).checkpoint;
    const tasks = [
      task('EX-1', { plan: 'PL-EX-1', risk_first: 'the export library reads our format' }),
      task('EX-2', { plan: 'PL-EX-1' }),
      ...['EX-3', 'EX-4', 'EX-5'].map((id) => task(id, { plan: 'PL-EX-1', waiting_on: [cp.id] })),
    ];
    const add = run(['add', '--file', file('staged.json', { tasks, question: { [cp.id]: cp.question } })]);
    expect(add.code, add.error).toBe(0);
    expect(readQueue().question[cp.id].after).toEqual(['EX-1', 'EX-2']);
    // A plan entry on every task: no large batch line.
    expect(add.out).not.toMatch(/large batch/);

    expect(run(['question']).out).toMatch(/CP-PL-EX-1 {2}\[condition; checkpoint, opens when EX-1, EX-2 are done; 3 tasks waiting\]/);
    const early = run(['resolve', cp.id, '--choice', 'Continue']);
    expect(early.code).toBe(1);
    expect(early.error + early.out).toMatch(/opens when EX-1, EX-2 are done/);

    // Stage 1 merged.
    const q = readQueue();
    for (const o of q.tasks) if (o.id === 'EX-1' || o.id === 'EX-2') Object.assign(o, { status: 'done', done: new Date().toISOString() });
    writeQueue(q);
    expect(run(['question']).out).toMatch(/CP-PL-EX-1 {2}\[condition; open, 3 tasks waiting\]/);

    const adjust = run(['resolve', cp.id, '--choice', 'Adjust', '--by', 'owner']);
    expect(adjust.code, adjust.error).toBe(0);
    expect(adjust.out).toMatch(/Checkpoint CP-PL-EX-1: parked for a rewrite: EX-3, EX-4, EX-5/);
    const after = readQueue().tasks.filter((o: { id: string }) => ['EX-3', 'EX-4', 'EX-5'].includes(o.id));
    expect(after.every((o: { parked?: { reason: string } }) => /rewrite the mission after checkpoint/.test(o.parked?.reason ?? ''))).toBe(true);
  });

  it('Continue after stage 1 lets the rest start; --early answers before it', () => {
    const cp = json(['plan', 'checkpoint', '--smallest', '--stage', 'AB-1']).checkpoint;
    const tasks = [task('AB-1', { shaped: 'smallest' }), task('AB-2', { shaped: 'smallest', waiting_on: [cp.id] })];
    expect(run(['add', '--file', file('s.json', { tasks, question: { [cp.id]: cp.question } })]).code).toBe(0);
    const r = run(['resolve', cp.id, '--choice', 'Continue', '--early']);
    expect(r.code, r.error).toBe(0);
    expect(r.out).toMatch(/Checkpoint CP-AB-1: continue; AB-2 can start/);
    expect(readQueue().tasks.find((o: { id: string }) => o.id === 'AB-2').parked).toBeUndefined();
  });

  it('add: 5 unplanned tasks warn once, 4 do not, with a plan do not, largeBatchWarn 0 does not', () => {
    const five = run(['add', '--file', file('five.json', ['A1', 'A2', 'A3', 'A4', 'A5'].map((id) => task(id)))]);
    expect(five.code, five.error).toBe(0);
    expect(five.out.match(/WARNING: large batch without a plan entry \(5 tasks/g)?.length).toBe(1);
    expect(five.out).toMatch(/consider \/plans first/);
    expect(run(['add', '--file', file('four.json', ['B1', 'B2', 'B3', 'B4'].map((id) => task(id)))]).out).not.toMatch(/large batch/);
    expect(
      run(['add', '--file', file('planned.json', ['C1', 'C2', 'C3', 'C4', 'C5'].map((id) => task(id, { plan: 'PL-SM-1' })))]).out,
    ).not.toMatch(/large batch/);
    useConfig({ add: { largeBatchWarn: 0 } });
    expect(run(['add', '--file', file('off.json', ['D1', 'D2', 'D3', 'D4', 'D5'].map((id) => task(id)))]).out).not.toMatch(/large batch/);
  });
});
