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

function project({ config = {} as object, rows = [] as object[], tasks = [] as object[] } = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'finding-repeats-'));
  temporary.push(folder);
  const repo = path.join(folder, 'repo');
  const data = path.join(folder, 'data');
  for (const d of [repo, data]) fs.mkdirSync(d);
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
