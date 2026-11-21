// =============================================================
// devilsAdvocateCli.test.ts: `plan challenge` through queue.mjs, against a queue in a temporary folder (PG-7).
//   - off (the default): no brief for any plan,
//   - on: an XL plan gets the brief (the decision section, the plan's code, not the investigation); an L plan does not,
//   - --answer appends three objections and the cheapest test under the decision section; a bad answer writes nothing.
// =============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const P = require('../queuePlan.js');

const QUEUE_MJS = join(__dirname, '..', '..', 'queue.mjs');

const DOC = [
  '# Exports',
  '## Investigation',
  'The old exporter is slow, see the notes.',
  '## Decision',
  '**Success measure:** exports open in a spreadsheet.',
  '',
  '## Later',
  'Other things.',
  '',
].join('\n');

describe('plan challenge in the CLI', () => {
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
  const doc = () => readFileSync(join(folder, 'plans', 'ex.md'), 'utf8');
  const turnOn = () => {
    config = join(folder, 'queue.config.json');
    writeFileSync(config, JSON.stringify({ plans: { devilsAdvocate: true } }));
  };

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'plan-challenge-'));
    config = null;
    const projects = { p: { title: 'P', area: 'a' } };
    writeFileSync(
      join(folder, 'queue.json'),
      JSON.stringify({ tasks: [], resolved: [], projects, areas: { a: { title: 'A' } }, question: {}, limits: { maxConcurrent: 5, maxDPlus: 2, maxPerDomain: 7, maxDb: 6 }, next_migr: 100 }),
    );
    mkdirSync(join(folder, 'plans'));
    writeFileSync(join(folder, 'plans', 'ex.md'), DOC);
    const reg = P.emptyRegister('2026-11-21T09:00:00.000Z');
    const sources = [
      { path: 'plans/ex.md', anchor: '#investigation', role: 'investigation' },
      { path: 'plans/ex.md', anchor: '#decision', role: 'decision' },
    ];
    for (const [id, size] of [['PL-XL-1', 'XL'], ['PL-L-1', 'L']]) {
      const r = P.newEntry(
        reg,
        { id, title: id, project: 'p', priority: 'later', priority_reason: 'Rule 8.', maturity: 'planned', size, sources },
        { role: 'agent', projects, question: {} },
      );
      if (r.error.length) throw new Error(r.error.join('; '));
    }
    writeFileSync(join(folder, 'plans.json'), JSON.stringify(reg));
    const add = join(folder, 'add.json');
    writeFileSync(
      add,
      JSON.stringify([{ id: 'XL-1', title: 'Task', domain: 'client', class: 'K', project: 'p', mission: 'Do it.', content_min: 90, owned_files: ['src/export/x.ts'], plan: 'PL-XL-1' }]),
    );
    const r = run(['add', '--file', add]);
    if (r.code) throw new Error(r.error);
  });
  afterEach(() => rmSync(folder, { recursive: true, force: true }));

  it('off by default: no brief', () => {
    const r = json(['plan', 'challenge', 'PL-XL-1']);
    expect(r).toMatchObject({ on: false, brief: null });
    expect(r.offer.offer).toBe(false);
  });

  it('on: the XL plan gets the brief with its section and code, not the investigation; the L plan none', () => {
    turnOn();
    const r = json(['plan', 'challenge', 'PL-XL-1']);
    expect(r.agent).toBe('reviewer-challenger');
    expect(r.brief).toContain('**Success measure:** exports open in a spreadsheet.');
    expect(r.brief).toContain('src/export/x.ts');
    expect(r.brief).not.toContain('plans/ex.md');
    expect(r.brief).not.toContain('old exporter is slow');
    expect(json(['plan', 'challenge', 'PL-L-1']).brief).toBeNull();
  });

  it('--answer appends the block under the decision section; a bad answer writes nothing', () => {
    turnOn();
    const bad = join(folder, 'bad.txt');
    writeFileSync(bad, 'OBJECTION 1: only one\nCHEAPEST TEST: try it');
    const refused = run(['plan', 'challenge', 'PL-XL-1', '--answer', bad]);
    expect(refused.code).not.toBe(0);
    expect(refused.error).toMatch(/OBJECTION 2/);
    expect(doc()).toBe(DOC);
    const good = join(folder, 'good.txt');
    writeFileSync(good, 'OBJECTION 1: a\nOBJECTION 2: b\nOBJECTION 3: c\nCHEAPEST TEST: open one export by hand');
    const r = run(['plan', 'challenge', 'PL-XL-1', '--answer', good]);
    expect(r.code, r.error).toBe(0);
    const text = doc();
    expect(text.indexOf("### Devil's advocate")).toBeGreaterThan(text.indexOf('## Decision'));
    expect(text.indexOf("### Devil's advocate")).toBeLessThan(text.indexOf('## Later'));
    expect(text).toContain('- Cheapest test: open one export by hand');
  });
});
