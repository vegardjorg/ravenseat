// =============================================================
// findingRepeatsFlow.test.ts: the repeat count on class and area end to end, with the real queue.mjs (step 7 of the
// finding format, plans/funnformat-0i-0j-2026-11-15.md section 6 row 7).
//
// Locks: (1) with the proposals off (the default) a class that keeps coming back adds no task, and the Checks tab offers
// the proposals as one low setting card; (2) on: `ravenseat inspection` proposes ONE gate task for the class and area
// (proposed, never approved), a second scan adds nothing, and a cancelled one is not proposed again; (3) the cap is shared:
// three inspection proposals waiting for the owner leave no slot for it; (4) guard failed gives the red marker on the
// Checks tab, and learning.guardFailedMarker off keeps the card without it.
// The rules are in lib/__tests__/findingRepeats.test.ts.
// =============================================================
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

const QUEUE = path.resolve(__dirname, '..', 'queue.mjs');
const ID = ['-c', 'user.name=queue-test', '-c', 'user.email=queue-test@example.invalid'];
const DAY = 86_400_000;

const temporary: string[] = [];
afterAll(() => {
  for (const m of temporary) {
    try {
      fs.rmSync(m, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    } catch {
      /* left for the OS */
    }
  }
});

type Task = { id: string; status: string; title?: string; labels?: string[]; added_by?: string; mission?: string };

/** A finding log row as lib/findingLog.js writes it, `daysAgo` days back. */
function row(id: number, o: Record<string, unknown> = {}) {
  const { daysAgo = 1, ...rest } = o as { daysAgo?: number };
  return {
    id: `F-${id}`,
    time: new Date(Date.now() - daysAgo * DAY).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    class: 'unchecked-error',
    class_source: 'agent',
    confidence: 'high',
    where: { files: ['src/api/save.ts'], line: 4, area: 'src/api' },
    caught_by: 'review:reviewer',
    severity: 'M',
    task: `T-${id}`,
    round: 1,
    item: null,
    cause_task: null,
    signature: null,
    excerpt: 'a result used without its error',
    disposition: null,
    fixed_by: null,
    test_added: null,
    fix: null,
    status: null,
    guard: null,
    counts: true,
    ...rest,
  };
}

function project({ config = {} as object, rows = [] as object[], tasks = [] as object[], files = {} as Record<string, string> } = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'finding-repeats-'));
  temporary.push(folder);
  const repo = path.join(folder, 'repo');
  const data = path.join(folder, 'data');
  for (const d of [repo, data]) fs.mkdirSync(d);
  for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(repo, f), text);
  const globalConfig = path.join(folder, 'global-gitconfig');
  fs.writeFileSync(globalConfig, '');
  const configFile = path.join(folder, 'queue.config.json');
  fs.writeFileSync(configFile, JSON.stringify({ baseBranch: 'main', mode: 'lite', ...config }));
  fs.writeFileSync(path.join(data, 'queue.json'), JSON.stringify({ limits: {}, resolved: [], projects: {}, tasks }));
  fs.writeFileSync(path.join(data, 'findings.jsonl'), rows.map((r) => `${JSON.stringify(r)}\n`).join(''));
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CEILING_DIRECTORIES: folder,
    QUEUE_FOLDER: data,
    QUEUE_CONFIG: configFile,
    QUEUE_ROOT: repo,
    QUEUE_GIT: repo,
    QUEUE_TIME_LOG: path.join(folder, 'times.jsonl'),
    QUEUE_TRANSCRIPTS: path.join(folder, 'transcripts'),
    RAVENSEAT_CLAUDE_DIR: path.join(folder, 'claude'),
    RAVENSEAT_MANAGED_CLAUDE_MD: '',
    RAVENSEAT_INSTRUCTIONS_TOP: repo,
  } as NodeJS.ProcessEnv;
  const g = (args: string[]) => execFileSync('git', ['-C', repo, ...ID, ...args], { env, stdio: 'ignore' });
  g(['init', '-q', '-b', 'main']);
  g(['commit', '-q', '--allow-empty', '-m', 'start']);
  const q = (...args: string[]) => {
    const r = spawnSync(process.execPath, [QUEUE, ...args], { encoding: 'utf8', env, cwd: repo, timeout: 60_000 });
    return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, stdout: r.stdout ?? '' };
  };
  const queue = () => JSON.parse(fs.readFileSync(path.join(data, 'queue.json'), 'utf8')) as { tasks: Task[] };
  const gates = () => queue().tasks.filter((t) => t.labels?.includes('gate'));
  const checks = () => JSON.parse(q('checks', '--json').stdout) as { important: number; suggestions: Record<string, unknown>[] };
  const card = (key: string) => checks().suggestions.find((s) => s.key === key);
  return { q, queue, gates, card, checks };
}

/** The same class in the same area in two separate tasks within the window: due. */
const REPEATED = [row(1, { daysAgo: 20 }), row(2, { daysAgo: 2 })];

describe('the repeat count on class and area', () => {
  it('with the proposals off (the default) adds no task, and offers them as one low card', () => {
    const p = project({ rows: REPEATED });
    const r = p.q('inspection');
    expect(r.code, r.out).toBe(0);
    expect(p.gates()).toEqual([]);
    expect(p.card('learning-proposals')).toMatchObject({ priority: 'low', action: 'setting', state: 'open' });
    expect(p.card('guard-failed')).toBeUndefined();
  });

  it('on: one gate task for the class and area, proposed; not again, and not after a cancel', () => {
    const p = project({ rows: REPEATED, config: { learning: { proposals: true } } });
    const r = p.q('inspection');
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('GATE-1');
    const [t] = p.gates();
    expect(p.gates()).toHaveLength(1);
    expect(t).toMatchObject({ id: 'GATE-1', status: 'proposed', added_by: 'gate agent', title: 'Gate: Unchecked error or result in src/api' });
    expect(t.labels).toContain('finding-log');
    expect(t.mission).toContain('src/api/save.ts:4');
    expect(p.card('learning-proposals')).toBeUndefined();
    p.q('inspection');
    expect(p.gates()).toHaveLength(1);
    expect(p.q('cancel', 'GATE-1').code).toBe(0);
    p.q('inspection');
    expect(p.gates()).toHaveLength(1);
  });

  it('shares the cap: three inspection proposals waiting for the owner leave no slot', () => {
    const insp = [1, 2, 3].map((n) => ({ id: `INSP-${n}`, title: `Guard ${n}`, status: 'proposed', class: 'K', labels: ['guard', 'inspection'] }));
    const p = project({ rows: REPEATED, tasks: insp, config: { learning: { proposals: true } } });
    const r = p.q('inspection');
    expect(r.code, r.out).toBe(0);
    expect(p.gates()).toEqual([]);
  });

  it('the recipe card: the class, the count, the places and a recipe, never the excerpt; off with the inspection queue; gone after a cancel', () => {
    const p = project({ rows: REPEATED, config: { learning: { proposals: true } } });
    const c = p.card('ledger-recipes');
    expect(c).toMatchObject({ priority: 'medium', action: 'ask', state: 'open' });
    const item = (c?.ledger as { items: Record<string, unknown>[] }).items[0];
    expect(item).toMatchObject({ class: 'unchecked-error', area: 'src/api', incidents: 2, files: ['src/api/save.ts'] });
    expect(String(c?.detail)).toMatch(/src\/api\/save\.ts/);
    expect(JSON.stringify(c)).not.toContain('a result used without its error');
    expect(p.checks().important).toBe(project({}).checks().important);
    expect(project({ rows: REPEATED, config: { inspection: { mode: 'off' } } }).card('ledger-recipes')).toBeUndefined();
    // Proposed, then declined: the no is remembered for that class and area, so the card goes.
    expect(p.q('inspection').code).toBe(0);
    expect((p.card('ledger-recipes')?.ledger as { items: { proposal: { state: string } }[] }).items[0].proposal.state).toBe('extend');
    expect(p.q('cancel', 'GATE-1').code).toBe(0);
    expect(p.card('ledger-recipes')).toBeUndefined();
  });

  it('guard failed: the red marker on the Checks tab, and the marker setting off keeps the card without it', () => {
    const rows = [row(1, { daysAgo: 3, guard: 'G-1' })];
    const p = project({ rows });
    const c = p.card('guard-failed');
    expect(c).toMatchObject({ priority: 'high', state: 'open' });
    expect(String(c?.detail)).toContain('G-1');
    const quiet = project({ rows, config: { learning: { guardFailedMarker: false } } });
    expect(quiet.card('guard-failed')).toMatchObject({ priority: 'medium' });
  });
});

describe('Build as gate (0i step 7): the button on the card ledger-recipes', () => {
  const BUILD = { gates: { quick: ['npm run lint'], full: ['npm test'] } };

  it('adds ONE proposed gate task in the GATE series with the gate commands, the places and the criteria; not twice', () => {
    const p = project({ rows: REPEATED, config: BUILD });
    const r = p.q('checks', 'build-gate', 'unchecked-error@src/api');
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('GATE-1');
    const [t] = p.gates();
    expect(p.gates()).toHaveLength(1);
    expect(t).toMatchObject({ id: 'GATE-1', status: 'proposed', added_by: 'gate agent', title: 'Gate: Unchecked error or result in src/api' });
    expect(t.labels).toContain('finding-log');
    for (const s of ['npm run lint', 'npm test', 'src/api/save.ts', 'guards add --from-task GATE-1', '--kind none']) expect(t.mission).toContain(s);
    expect(t.mission).not.toContain('a result used without its error');
    // The card now shows it as proposed, and a second click adds nothing.
    expect((p.card('ledger-recipes')?.ledger as { items: { proposal: { state: string; task: string } }[] }).items[0].proposal).toEqual({ state: 'extend', task: 'GATE-1' });
    const again = p.q('checks', 'build-gate', 'unchecked-error@src/api');
    expect(again.code, again.out).toBe(0);
    expect(again.out).toMatch(/already proposed as GATE-1/i);
    expect(p.gates()).toHaveLength(1);
  });

  it('shares the cap of three: with three proposals waiting it adds nothing and says it waits', () => {
    const insp = [1, 2, 3].map((n) => ({ id: `INSP-${n}`, title: `Guard ${n}`, status: 'proposed', class: 'K', labels: ['guard', 'inspection'] }));
    const p = project({ rows: REPEATED, tasks: insp, config: BUILD });
    const r = p.q('checks', 'build-gate', 'unchecked-error@src/api');
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/cap of three/i);
    expect(p.gates()).toEqual([]);
  });

  it('needs the inspection queue on, a due class and area, and a valid key; a declined one stays declined', () => {
    const off = project({ rows: REPEATED, config: { ...BUILD, inspection: { mode: 'off' } } });
    const r1 = off.q('checks', 'build-gate', 'unchecked-error@src/api');
    expect(r1.code).not.toBe(0);
    expect(r1.out).toContain('inspection.mode');
    expect(off.gates()).toEqual([]);
    const p = project({ rows: REPEATED, config: BUILD });
    const r2 = p.q('checks', 'build-gate', 'null-undefined@src/ui');
    expect(r2.code).not.toBe(0);
    expect(r2.out).toMatch(/not due/i);
    const r3 = p.q('checks', 'build-gate', '--json');
    expect(r3.code).not.toBe(0);
    expect(p.gates()).toEqual([]);
    expect(p.q('checks', 'build-gate', 'unchecked-error@src/api').code).toBe(0);
    expect(p.q('cancel', 'GATE-1').code).toBe(0);
    const r4 = p.q('checks', 'build-gate', 'unchecked-error@src/api');
    expect(r4.code).not.toBe(0);
    expect(r4.out).toMatch(/declined/i);
    expect(p.gates()).toHaveLength(1);
  });
});

describe('recipe precision (0i step 9): accepted and declined per recipe, damping, and the owner choice', () => {
  const NODE = { 'package.json': JSON.stringify({ name: 'x', scripts: { test: 'vitest' } }) };
  /** Five decided proposals from the recipe for Node, in other areas: one accepted, four declined (20 percent). */
  const decided = (accepted: number, declined: number) =>
    [...Array.from({ length: accepted }, () => 'done'), ...Array.from({ length: declined }, () => 'cancelled')].map((status, i) => ({
      id: `GATE-${50 + i}`,
      title: `Gate: Unchecked error or result in src/old${i}`,
      status,
      class: 'K',
      labels: ['gate', 'finding-log'],
      source: `finding-log unchecked-error@src/old${i}`,
      recipe: { id: 'unchecked-error-node', db: false },
    }));
  type Item = { recipe: { id: string } | null; damped?: { id: string }[] };
  const item = (p: ReturnType<typeof project>) => (p.card('ledger-recipes')?.ledger as { items: Item[] }).items[0];
  const precision = (p: ReturnType<typeof project>) =>
    (p.checks() as unknown as { recipePrecision: { recipes: Record<string, unknown>[] } }).recipePrecision;

  it('Build as gate stores the recipe id on the task, and the measure counts it', () => {
    const p = project({ rows: REPEATED, files: NODE });
    expect(item(p).recipe?.id).toBe('unchecked-error-node');
    expect(p.q('checks', 'build-gate', 'unchecked-error@src/api').code).toBe(0);
    expect((p.gates()[0] as unknown as { recipe: unknown }).recipe).toEqual({ id: 'unchecked-error-node', db: false });
    expect(precision(p).recipes).toEqual([expect.objectContaining({ id: 'unchecked-error-node', proposals: 1, pending: 1, rate: null, damped: false })]);
  });

  it('a recipe below 30 percent after five is damped: listed with its numbers, not offered on the card', () => {
    const p = project({ rows: REPEATED, files: NODE, tasks: decided(1, 4) });
    expect(item(p).recipe).toBeNull();
    expect(item(p).damped).toEqual([expect.objectContaining({ id: 'unchecked-error-node' })]);
    expect(precision(p).recipes).toEqual([expect.objectContaining({ id: 'unchecked-error-node', proposals: 5, accepted: 1, declined: 4, rate: 20, damped: true, by: 'auto' })]);
    const r = p.q('checks');
    expect(r.out).toMatch(/Recipe precision/);
    expect(r.out).toMatch(/unchecked-error-node: 5 proposals, 1 accepted \(20%\), damped/);
    // Build as gate now adds the gate without the damped recipe.
    expect(p.q('checks', 'build-gate', 'unchecked-error@src/api').code).toBe(0);
    expect(p.gates().find((t) => t.id === 'GATE-55')).not.toHaveProperty('recipe');
  });

  it('the owner can show a damped recipe again, damp one by hand, and go back to automatic', () => {
    const p = project({ rows: REPEATED, files: NODE, tasks: decided(1, 4) });
    const r = p.q('checks', 'recipe', 'unchecked-error-node', 'show');
    expect(r.code, r.out).toBe(0);
    expect(item(p).recipe?.id).toBe('unchecked-error-node');
    expect(precision(p).recipes[0]).toMatchObject({ damped: false, by: 'owner', override: 'show' });
    expect(p.q('checks', 'recipe', 'unchecked-error-node', 'auto').code).toBe(0);
    expect(precision(p).recipes[0]).toMatchObject({ damped: true, by: 'auto', override: null });
    const fresh = project({ rows: REPEATED, files: NODE });
    expect(fresh.q('checks', 'recipe', 'unchecked-error-node', 'damp').code).toBe(0);
    expect(item(fresh).recipe).toBeNull();
    const bad = fresh.q('checks', 'recipe', 'no-such-recipe', 'show');
    expect(bad.code).not.toBe(0);
    expect(bad.out).toMatch(/no recipe/i);
    expect(fresh.q('checks', 'recipe', 'unchecked-error-node', 'maybe').code).not.toBe(0);
  });

  it('learning.recipeDamping off keeps the recipe on the card whatever its numbers', () => {
    const p = project({ rows: REPEATED, files: NODE, tasks: decided(1, 4), config: { learning: { recipeDamping: false } } });
    expect(item(p).recipe?.id).toBe('unchecked-error-node');
    expect(precision(p).recipes[0]).toMatchObject({ rate: 20, damped: false });
  });

  it("the finding log's own proposal carries the recipe the last Checks read showed", () => {
    const p = project({ rows: REPEATED, files: NODE, config: { learning: { proposals: true } } });
    expect(p.q('checks', '--json').code).toBe(0);
    expect(p.q('inspection').code).toBe(0);
    expect((p.gates()[0] as unknown as { recipe: unknown }).recipe).toEqual({ id: 'unchecked-error-node', db: false });
  });
});
