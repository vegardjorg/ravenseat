// The plan gate through the CLI (cli/plans.mjs, lib/planGate.js): `plan edit … maturity=ready` on a large plan warns
// (advisory) or refuses (block), `--skip-decision` records a skip, `plan get` shows the decision state, and
// `plan shape --tasks <n>` prints the shape-first question above the threshold only.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const P = require('../queuePlan.js');

const QUEUE_MJS = join(__dirname, '..', '..', 'queue.mjs');

const NOTE = [
  '# Export',
  '## 9. Decision',
  ...[
    'Need and evidence',
    'Success measure',
    'Non-goals',
    'Alternatives',
    'Cost',
    'Stop criteria',
    'Strongest case against',
    'Cheapest test',
  ].flatMap((h) => [`### ${h}`, 'text']),
].join('\n');

describe('plan gate in the CLI', () => {
  let folder: string;
  let config: string | null;
  const run = (args: string[], json = true) => {
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
      const out = execFileSync(process.execPath, [QUEUE_MJS, ...args, ...(json ? ['--json'] : [])], {
        env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { code: 0, out, data: json ? JSON.parse(out.trim().split('\n').pop() ?? 'null') : null };
    } catch (e) {
      const x = e as { status: number; stdout: string };
      let data = null;
      try {
        data = JSON.parse(String(x.stdout ?? '').trim().split('\n').pop() ?? 'null');
      } catch {
        data = null;
      }
      return { code: x.status, out: String(x.stdout ?? ''), data };
    }
  };
  const entry = () => JSON.parse(readFileSync(join(folder, 'plans.json'), 'utf8')).entries[0];

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'plan-gate-'));
    config = null;
    const projects = { p: { title: 'P', area: 'a' } };
    writeFileSync(
      join(folder, 'queue.json'),
      JSON.stringify({ changed: '2026-11-21T08:00:00.000Z', tasks: [], projects, areas: { a: { title: 'A' } }, question: {}, resolved: [] }),
    );
    mkdirSync(join(folder, 'docs'));
    writeFileSync(join(folder, 'docs', 'export.md'), NOTE);
    const reg = P.emptyRegister('2026-11-21T09:00:00.000Z');
    const r = P.newEntry(
      reg,
      { id: 'PL-EX-1', title: 'Export', project: 'p', priority: 'later', priority_reason: 'Rule 8.', maturity: 'planned', size: 'L' },
      { role: 'agent', projects, question: {} },
    );
    if (r.error.length) throw new Error(r.error.join('; '));
    writeFileSync(join(folder, 'plans.json'), JSON.stringify(reg));
  });
  afterEach(() => rmSync(folder, { recursive: true, force: true }));

  const useConfig = (o: object) => {
    config = join(folder, 'queue.config.json');
    writeFileSync(config, JSON.stringify(o));
  };

  it('advisory (default): ready is saved with one warning naming the missing section', () => {
    const r = run(['plan', 'edit', 'PL-EX-1', '--field', 'maturity=ready']);
    expect(r.code).toBe(0);
    expect(r.data.warnings.join(' ')).toMatch(/size L and set to ready with no decision section/);
    expect(entry().maturity).toBe('ready');
  });

  it('block refuses and changes nothing; a skip with a reason lets it through and shows in plan get', () => {
    useConfig({ plans: { readyCheck: 'block' } });
    const r = run(['plan', 'edit', 'PL-EX-1', '--field', 'maturity=ready']);
    expect(r.code).toBe(1);
    expect(r.data.error[0]).toMatch(/refused \(plans.readyCheck block\)/);
    expect(entry().maturity).toBe('planned');
    const s = run(['plan', 'edit', 'PL-EX-1', '--skip-decision', 'two tracks in practice', '--field', 'maturity=ready']);
    expect(s.code).toBe(0);
    expect(entry().decision_skip.reason).toBe('two tracks in practice');
    const g = run(['plan', 'get', 'PL-EX-1'], false);
    expect(g.out).toContain('Decision: skipped (two tracks in practice)');
  });

  it('with a full decision section: silent, and plan get says done (JSON carries the state)', () => {
    const src = JSON.stringify({ sources: [{ path: 'docs/export.md', anchor: '§ 9', role: 'decision' }] });
    expect(run(['plan', 'edit', 'PL-EX-1', '--set', src]).code).toBe(0);
    const r = run(['plan', 'edit', 'PL-EX-1', '--field', 'maturity=ready']);
    expect(r.data.warnings).toEqual([]);
    expect(run(['plan', 'get', 'PL-EX-1'], false).out).toContain('Decision: done');
    expect(run(['plan', 'get', 'PL-EX-1']).data.entries[0].decision.state).toBe('done');
  });

  it('plans.readyCheck off: no warning', () => {
    useConfig({ plans: { readyCheck: 'off' } });
    expect(run(['plan', 'edit', 'PL-EX-1', '--field', 'maturity=ready']).data.warnings).toEqual([]);
  });

  it('plan shape: 6 tasks ask, 3 do not, a plan entry does not, off never does', () => {
    const six = run(['plan', 'shape', '--tasks', '6']);
    expect(six.data.question.choices.map((c: { key: string }) => c.key)).toEqual(['shape', 'smallest', 'all']);
    expect(run(['plan', 'shape', '--tasks', '3']).data.question).toBeNull();
    expect(run(['plan', 'shape', '--tasks', '9', '--plan', 'PL-EX-1']).data.question).toBeNull();
    expect(run(['plan', 'shape', '--tasks', '2', '--zones', 'D-0001']).data.question.why).toMatch(/D-0001/);
    expect(run(['plan', 'shape', '--tasks', '6'], false).out).toMatch(/Shape it first \(recommended\)/);
    useConfig({ shape: { nudge: 'off' } });
    expect(run(['plan', 'shape', '--tasks', '20']).data.question).toBeNull();
  });
});
