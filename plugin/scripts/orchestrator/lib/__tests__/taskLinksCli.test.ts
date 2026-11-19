// =============================================================
// taskLinksCli.test.ts: the task link checks wired into the CLI (roadmap 0p2 step B2, guards V1 to V3).
//
// Why: a task links to its reading material through its plan entry and its own `sources`; a path in `source` is origin.
// A link that is dead, an anchor that finds no heading, or a gitignored document is cheapest to fix right when it is
// written, and easy to miss later. So:
//   V1  add and edit print ONE WARNING line for such a link (the task is saved anyway, exit code unchanged); with
//       --answer-json the problems go into the JSON answer and no line is printed; links.addWarn false turns it off.
//   V2  doctor has one INFO row `links` with counts for open tasks, only when there is a finding; links.doctor false
//       turns it off. Counts only, never a path or a title.
//   V3  plan check reports a plan source whose anchor finds no heading (before this, the miss was a silent null).
// Everything runs against a temporary git repo (git check-ignore is real), never the real project.
// =============================================================
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PLUGIN = path.resolve(__dirname, '..', '..', '..', '..');
const QUEUE = path.join(PLUGIN, 'scripts', 'orchestrator', 'queue.mjs');
const temporary: string[] = [];
afterAll(() => {
  for (const m of temporary) fs.rmSync(m, { recursive: true, force: true });
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const TL = require('../taskLinks.js');

/** A plan document with numbered sections. */
const PLAN_DOC = ['# Plan', '', '## 1. Today', 'text', '', '## 2. The rule', 'text', ''].join('\n');

type Check = { status: string; name: string; message: string; fix: string | null; counts?: Record<string, number> };

/**
 * A temporary git repo with a lite queue: docs/plan.md (tracked), docs/internal/notes.md (exists, gitignored), and a
 * plan register with one good entry, one whose anchor misses, one with a dead source and one with a gitignored source.
 */
function project(config: Record<string, unknown> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-task-links-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-task-links-home-'));
  temporary.push(root, home);
  const g = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
      cwd: root,
      stdio: 'pipe',
      encoding: 'utf8',
    });
  g('init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(root, 'docs', 'internal'), { recursive: true });
  fs.writeFileSync(path.join(root, '.gitignore'), 'docs/internal/\ndata/\n');
  fs.writeFileSync(path.join(root, 'docs', 'plan.md'), PLAN_DOC);
  fs.writeFileSync(path.join(root, 'docs', 'internal', 'notes.md'), PLAN_DOC);
  g('add', '.gitignore', 'docs/plan.md');
  g('commit', '-q', '-m', 'start');
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, 'queue.json'), JSON.stringify({ tasks: [], projects: {} }));
  const entry = (id: string, sources: object[]) => ({
    id,
    title: `Entry ${id}`,
    priority: 'later',
    maturity: 'idea',
    sources,
    created: '2026-11-01',
  });
  fs.writeFileSync(
    path.join(data, 'plans.json'),
    JSON.stringify({
      version: 1,
      entries: [
        entry('PL-GOOD', [{ path: 'docs/plan.md', anchor: '§ 2', role: 'plan' }]),
        entry('PL-ANCHOR', [{ path: 'docs/plan.md', anchor: '§ 9', role: 'plan' }]),
        entry('PL-DEAD', [{ path: 'docs/gone.md', role: 'plan' }]),
        entry('PL-IGNORED', [{ path: 'docs/internal/notes.md', role: 'plan' }]),
      ],
      archive: {},
      changelog: [],
    }),
  );
  const configFile = path.join(root, 'queue.config.json');
  fs.writeFileSync(
    configFile,
    JSON.stringify({ mode: 'lite', baseBranch: 'main', loadGuard: { minFreeMemoryPct: null }, ...config }),
  );
  const env = {
    ...process.env,
    QUEUE_ROOT: root,
    QUEUE_FOLDER: data,
    QUEUE_CONFIG: configFile,
    QUEUE_GIT: root,
    QUEUE_HOOKS: path.join(PLUGIN, 'hooks', 'hooks.json'),
    QUEUE_TIME_LOG: path.join(data, 'times.jsonl'),
    HOME: home,
    USERPROFILE: home,
  };
  delete (env as Record<string, string | undefined>).QUEUE_PLAN_SOURCE_ROOT;
  const run = (...args: string[]) => {
    const r = spawnSync(process.execPath, [QUEUE, ...args], { encoding: 'utf8', env, cwd: root });
    return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
  };
  const add = (task: object, ...extra: string[]) => run('add', '--json', JSON.stringify(task), ...extra);
  const doctor = () => JSON.parse(run('doctor', '--json').out) as { checks: Check[] };
  const tasks = () => JSON.parse(fs.readFileSync(path.join(data, 'queue.json'), 'utf8')).tasks as { id: string }[];
  return { root, data, run, add, doctor, tasks };
}

/** The WARNING lines about task links in an output. */
const linkWarnings = (out: string) => out.split('\n').filter((l) => l.startsWith('WARNING: task links'));

describe('taskLinks: the warning line and the doctor totals (pure)', () => {
  it('one line for all problems, with the plan id and the kind of each', () => {
    const line = TL.warningLine(
      [
        { id: 'T-1', plan: 'PL-A', problems: [{ kind: 'dead', path: 'docs/gone.md', anchor: null, from: 'plan' }] },
        { id: 'T-2', plan: null, problems: [{ kind: 'anchor', path: 'docs/a.md', anchor: '§ 9', from: 'sources' }] },
        { id: 'T-3', plan: null, problems: [] },
      ],
      { verb: 'added' },
    );
    expect(line).toMatch(/^WARNING: task links: /);
    expect(line).not.toContain('\n');
    expect(line).toContain('T-1: PL-A source docs/gone.md is missing');
    expect(line).toContain('T-2: sources docs/a.md § 9 finds no heading');
    expect(line).not.toContain('T-3');
    expect(line).toContain('added anyway');
  });

  it('no line when no task has a problem', () => {
    expect(TL.warningLine([{ id: 'T-1', plan: null, problems: [] }], { verb: 'added' })).toBeNull();
  });

  it('linksSetup: both on by default, false turns each off', () => {
    expect(TL.linksSetup({})).toEqual({ addWarn: true, doctor: true });
    expect(TL.linksSetup({ links: { addWarn: false } })).toEqual({ addWarn: false, doctor: true });
    expect(TL.linksSetup({ links: { doctor: false, addWarn: 'yes' } })).toEqual({ addWarn: true, doctor: false });
  });

  it('doctorTotals adds up open tasks only, and counts nothing-to-read only for a task that links somewhere', () => {
    const results = new Map<string, { counts: Record<string, unknown> }>([
      ['A', { counts: { dead: 1, anchorMiss: 0, ignored: 0, private: 0, nothingToRead: true } }],
      ['B', { counts: { dead: 0, anchorMiss: 2, ignored: 1, private: 1, nothingToRead: false } }],
      ['C', { counts: { dead: 0, anchorMiss: 0, ignored: 0, private: 0, nothingToRead: true } }],
      ['D', { counts: { dead: 5, anchorMiss: 5, ignored: 5, private: 5, nothingToRead: true } }],
    ]);
    const t = TL.doctorTotals(
      [
        { id: 'A', status: 'waiting', plan: 'PL-X' },
        { id: 'B', status: 'active', sources: [{ path: 'docs/a.md' }] },
        { id: 'C', status: 'waiting' }, // links nowhere: nothing to read is normal, not a finding
        { id: 'D', status: 'done', plan: 'PL-X' }, // closed: not counted
      ],
      (task: { id: string }) => results.get(task.id),
    );
    expect(t).toEqual({ tasks: 3, dead: 1, anchorMiss: 2, ignored: 1, private: 1, nothingToRead: 1 });
    expect(TL.doctorMessage(t)).toBe(
      'open tasks: 1 dead link(s), 2 anchor(s) without a heading, 1 gitignored source(s), 1 private link(s), ' +
        '1 task(s) with nothing to read (3 open task(s) checked)',
    );
  });

  it('doctorMessage is null without a finding (private links alone are no finding)', () => {
    expect(TL.doctorMessage({ tasks: 4, dead: 0, anchorMiss: 0, ignored: 0, private: 2, nothingToRead: 0 })).toBeNull();
  });
});

describe('ravenseat add and edit: one WARNING line for a broken task link (V1)', () => {
  it('a dead plan source, an anchor that misses and a gitignored source each give the line; the task is added', () => {
    const p = project();
    for (const [id, plan, text] of [
      ['T-DEAD', 'PL-DEAD', 'PL-DEAD source docs/gone.md is missing'],
      ['T-ANCHOR', 'PL-ANCHOR', 'PL-ANCHOR source docs/plan.md § 9 finds no heading'],
      ['T-IGN', 'PL-IGNORED', 'PL-IGNORED source docs/internal/notes.md is gitignored'],
    ]) {
      const r = p.add({ id, title: `Task ${id}`, plan });
      expect(r.code, r.err).toBe(0);
      const lines = linkWarnings(r.out);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(`${id}: ${text}`);
    }
    expect(p.tasks().map((t) => t.id)).toEqual(['T-DEAD', 'T-ANCHOR', 'T-IGN']);
  }, 60_000);

  it('a task source and a path in source are checked too, in the same single line', () => {
    const p = project();
    const r = p.add({
      id: 'T-OWN',
      title: 'Own sources',
      sources: [{ path: 'docs/plan.md', anchor: '§ 7' }],
      source: 'review of docs/missing-review.md',
    });
    expect(r.code, r.err).toBe(0);
    const lines = linkWarnings(r.out);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('T-OWN: sources docs/plan.md § 7 finds no heading');
    expect(lines[0]).toContain('T-OWN: source text docs/missing-review.md is missing');
  }, 60_000);

  it('no line when the links are fine', () => {
    const p = project();
    const r = p.add({ id: 'T-OK', title: 'Fine', plan: 'PL-GOOD', sources: [{ path: 'docs/plan.md', anchor: '1' }] });
    expect(r.code, r.err).toBe(0);
    expect(linkWarnings(r.out)).toEqual([]);
  }, 60_000);

  it('--answer-json puts the problems in the JSON answer and prints no line', () => {
    const p = project();
    const r = p.add({ id: 'T-J', title: 'Json', plan: 'PL-DEAD' }, '--answer-json');
    expect(r.code, r.err).toBe(0);
    expect(linkWarnings(r.out)).toEqual([]);
    const answer = JSON.parse(r.out.trim().split('\n').pop() as string);
    expect(answer.ok).toBe(true);
    expect(answer.added).toEqual([expect.objectContaining({ id: 'T-J' })]);
    expect(answer.linkProblems).toEqual([
      { id: 'T-J', problems: [{ kind: 'dead', path: 'docs/gone.md', anchor: null, from: 'plan' }] },
    ]);
  }, 60_000);

  it('links.addWarn false turns the line off', () => {
    const p = project({ links: { addWarn: false } });
    const r = p.add({ id: 'T-OFF', title: 'Off', plan: 'PL-DEAD' });
    expect(r.code, r.err).toBe(0);
    expect(linkWarnings(r.out)).toEqual([]);
  }, 60_000);

  it('edit warns when it writes a broken link, and --answer-json carries it; an unrelated edit says nothing', () => {
    const p = project();
    expect(p.add({ id: 'T-E', title: 'Edit me', plan: 'PL-GOOD' }).code).toBe(0);
    const bad = p.run('edit', 'T-E', '--json', JSON.stringify({ sources: [{ path: 'docs/nope.md' }] }));
    expect(bad.code, bad.err).toBe(0);
    const lines = linkWarnings(bad.out);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('T-E: sources docs/nope.md is missing');
    expect(lines[0]).toContain('changed anyway');
    const js = p.run('edit', 'T-E', '--json', JSON.stringify({ sources: [{ path: 'docs/nope2.md' }] }), '--answer-json');
    expect(linkWarnings(js.out)).toEqual([]);
    expect(JSON.parse(js.out.trim()).linkProblems).toEqual([
      { id: 'T-E', problems: [{ kind: 'dead', path: 'docs/nope2.md', anchor: null, from: 'sources' }] },
    ]);
    // The link is still broken, but this edit did not touch it: no line.
    const other = p.run('edit', 'T-E', '--json', JSON.stringify({ value: 7 }));
    expect(other.code, other.err).toBe(0);
    expect(linkWarnings(other.out)).toEqual([]);
  }, 60_000);
});

describe('ravenseat doctor: the links row (V2)', () => {
  it('counts for open tasks, never a path or a task id', () => {
    const p = project({ links: { addWarn: false } });
    expect(p.add({ id: 'D-1', title: 'Dead', plan: 'PL-DEAD' }).code).toBe(0);
    expect(p.add({ id: 'D-2', title: 'Anchor', plan: 'PL-ANCHOR' }).code).toBe(0);
    expect(p.add({ id: 'D-3', title: 'Ignored', plan: 'PL-IGNORED' }).code).toBe(0);
    expect(p.add({ id: 'D-4', title: 'Good', plan: 'PL-GOOD' }).code).toBe(0);
    const rows = p.doctor().checks.filter((c) => c.name === 'links');
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('INFO');
    expect(rows[0].counts).toEqual({ tasks: 4, dead: 1, anchorMiss: 1, ignored: 1, private: 0, nothingToRead: 1 });
    expect(rows[0].message).toContain('1 dead link(s)');
    expect(rows[0].message).toContain('1 anchor(s) without a heading');
    expect(rows[0].message).toContain('1 gitignored source(s)');
    expect(rows[0].message).toContain('1 task(s) with nothing to read');
    for (const secret of ['docs/', 'PL-', 'D-1', 'Dead']) expect(rows[0].message).not.toContain(secret);
  }, 120_000);

  it('a queue of tasks without any links (inline mission, acceptance, done_when) gives no warning and no row', () => {
    // Many projects keep everything in the queue: no plan, no sources, no path in source. That is normal, not a gap.
    const p = project();
    for (const id of ['Q-1', 'Q-2']) {
      const r = p.add({
        id,
        title: `Queue only ${id}`,
        mission: 'Do the thing described here, inline.',
        acceptance: ['the thing is done'],
        done_when: 'node -e "process.exit(0)"',
        source: 'owner 19.11',
      });
      expect(r.code, r.err).toBe(0);
      expect(linkWarnings(r.out)).toEqual([]);
    }
    const ed = p.run('edit', 'Q-1', '--json', JSON.stringify({ source: 'owner, follow-up' }));
    expect(ed.code, ed.err).toBe(0);
    expect(linkWarnings(ed.out)).toEqual([]);
    expect(p.doctor().checks.filter((c) => c.name === 'links')).toEqual([]);
  }, 120_000);

  it('silent when every link is fine, and with links.doctor false', () => {
    const p = project();
    expect(p.add({ id: 'G-1', title: 'Good', plan: 'PL-GOOD' }).code).toBe(0);
    expect(p.add({ id: 'G-2', title: 'No links' }).code).toBe(0);
    expect(p.doctor().checks.filter((c) => c.name === 'links')).toEqual([]);
    const off = project({ links: { doctor: false, addWarn: false } });
    expect(off.add({ id: 'O-1', title: 'Dead', plan: 'PL-DEAD' }).code).toBe(0);
    expect(off.doctor().checks.filter((c) => c.name === 'links')).toEqual([]);
  }, 120_000);
});

describe('ravenseat plan check: an anchor without a heading (V3)', () => {
  it('names the entry, the path and the anchor, in the text and in --json', () => {
    const p = project();
    const js = p.run('plan', 'check', '--json');
    expect(js.code, js.err).toBe(0);
    const r = JSON.parse(js.out);
    expect(r.anchor_misses).toEqual([{ id: 'PL-ANCHOR', path: 'docs/plan.md', anchor: '§ 9' }]);
    const text = p.run('plan', 'check');
    expect(text.out).toContain('Anchors without a heading (1)');
    expect(text.out).toContain('PL-ANCHOR: docs/plan.md § 9');
  }, 60_000);
});
