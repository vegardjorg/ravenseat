// =============================================================
// planPostCheckCli.test.ts: PG-6 through queue.mjs, against a queue in a temporary folder.
//   - the last `set <id> done` of a plan with a decision section registers PC-<plan> once ("Met, partly, not met?"),
//     and no task waits on it; an earlier done does not, and a plan without a decision section gets none,
//   - `plan postcheck --json` shows the built plan's row, "no estimate" for an unsized one, and the answer per size,
//   - plans.postCheck false: no question and no rows.
// =============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const P = require('../queuePlan.js');

const QUEUE_MJS = join(__dirname, '..', '..', 'queue.mjs');

const SECTION = [
  '# Exports',
  '## Investigation',
  'What we looked at.',
  '## Decision',
  '**Need and evidence:** asked by three teams.',
  '**Success measure:** exports open in a spreadsheet.',
  '**Cost:** two tracks.',
  '',
].join('\n');

describe('the plan follow-up in the CLI', () => {
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
  const file = (name: string, content: unknown) => {
    const p = join(folder, name);
    writeFileSync(p, JSON.stringify(content));
    return p;
  };
  const task = (id: string, plan: string) => ({
    id,
    title: `Task ${id}`,
    domain: 'client',
    class: 'K',
    project: 'p',
    mission: `Do ${id}.`,
    content_min: 90,
    owned_files: [`src/${id}.ts`],
    plan,
  });
  const done = (id: string) => run(['set', id, 'done', '--without-cost']);

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'plan-postcheck-'));
    config = null;
    const projects = { p: { title: 'P', area: 'a' } };
    writeFileSync(
      join(folder, 'queue.json'),
      JSON.stringify({
        tasks: [],
        resolved: [],
        projects,
        areas: { a: { title: 'A' } },
        question: {},
        limits: { maxConcurrent: 5, maxDPlus: 2, maxPerDomain: 7, maxDb: 6 },
        next_migr: 100,
      }),
    );
    mkdirSync(join(folder, 'plans'));
    writeFileSync(join(folder, 'plans', 'ex.md'), SECTION);
    const reg = P.emptyRegister('2026-11-21T09:00:00.000Z');
    const entries: [string, string | null, object[]][] = [
      ['PL-EX-1', 'L', [{ path: 'plans/ex.md', anchor: '#decision', role: 'decision' }]],
      ['PL-SM-1', null, []],
    ];
    for (const [id, size, sources] of entries) {
      const r = P.newEntry(
        reg,
        { id, title: id, project: 'p', priority: 'later', priority_reason: 'Rule 8.', maturity: 'planned', ...(size ? { size } : {}), sources },
        { role: 'agent', projects, question: {} },
      );
      if (r.error.length) throw new Error(r.error.join('; '));
    }
    writeFileSync(join(folder, 'plans.json'), JSON.stringify(reg));
    const add = run(['add', '--file', file('add.json', [task('EX-1', 'PL-EX-1'), task('EX-2', 'PL-EX-1'), task('SM-1', 'PL-SM-1')])]);
    if (add.code) throw new Error(add.error);
  });
  afterEach(() => rmSync(folder, { recursive: true, force: true }));

  it('the last done of a decided plan registers PC-<plan> once; no task waits on it', () => {
    const first = done('EX-1');
    expect(first.code, first.error).toBe(0);
    expect(readQueue().question['PC-PL-EX-1']).toBeUndefined();
    const last = done('EX-2');
    expect(last.code, last.error).toBe(0);
    expect(last.out).toMatch(/PL-EX-1 is built: owner question PC-PL-EX-1/);
    const q = readQueue().question['PC-PL-EX-1'];
    expect(q.text).toBe('PL-EX-1 is built. Success measure: exports open in a spreadsheet. Met, partly, not met?');
    expect(q.choices).toEqual(['Met', 'Partly', 'Not met']);
    expect(readQueue().tasks.some((o: any) => (o.waiting_on ?? []).includes('PC-PL-EX-1'))).toBe(false);
    // Again (a done set twice): no second question and no line.
    expect(done('EX-2').out).not.toMatch(/owner question PC-/);
    // A plan without a decision section: no question.
    done('SM-1');
    expect(readQueue().question['PC-PL-SM-1']).toBeUndefined();
  });

  it('plan postcheck shows the rows and the answers per size; an unsized plan has no estimate', () => {
    done('EX-1');
    done('EX-2');
    done('SM-1');
    expect(run(['resolve', 'PC-PL-EX-1', '--choice', 'Partly']).code).toBe(0);
    const r = json(['plan', 'postcheck']);
    expect(r.on).toBe(true);
    const ex = r.rows.find((x: any) => x.id === 'PL-EX-1');
    expect(ex).toMatchObject({ size: 'L', estimate_tasks: 7, tasks: 2, actual: 2, success: 'Partly', question: 'PC-PL-EX-1' });
    expect(r.rows.find((x: any) => x.id === 'PL-SM-1')).toMatchObject({ size: null, estimate_tasks: null, question: null });
    expect(r.accuracy.find((g: any) => g.size === 'L')).toMatchObject({ plans: 1, partly: 1, asked: 1 });
    expect(run(['plan', 'postcheck']).out).toMatch(/PL-SM-1 no size: no estimate/);
  });

  it('plans.postCheck false: no question and no rows', () => {
    config = join(folder, 'queue.config.json');
    writeFileSync(config, JSON.stringify({ plans: { postCheck: false } }));
    done('EX-1');
    done('EX-2');
    expect(readQueue().question['PC-PL-EX-1']).toBeUndefined();
    expect(json(['plan', 'postcheck'])).toMatchObject({ on: false, rows: [] });
  });
});
