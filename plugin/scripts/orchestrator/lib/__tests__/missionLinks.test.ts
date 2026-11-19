// =============================================================
// missionLinks.test.ts: the task's documents in the mission's read-first list (roadmap 0p2 step B3).
//
// Why: a task links to its reading material through its plan entry (`plan`) and its own `sources`. Before this step
// the validated link never reached the agent, and a file that exists only in the main tree (gitignored, or not
// committed) was written as a relative path the agent's worktree does not have. Now:
//   - the plan entry's sources with a readable role (plan, investigation, spec; no role counts as plan) come first in
//     the read-first list, an anchor as a line range ("docs/plan.md:5-6");
//   - a task's own `sources` replace the plan's sources (a narrowing);
//   - a file the agent's worktree will not have (not in git at --head) gets its absolute path;
//   - a privatePaths entry with read: false gives a "private, ask the orchestrator for an excerpt" line, never a path;
//   - the cap of 12 is shared between the links and the mission's own paths;
//   - a task without links gets a mission that is byte-identical to before (golden files below).
// Everything runs against a temporary git repo (git ls-tree and check-ignore are real), never the real project.
// =============================================================
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PLUGIN = path.resolve(__dirname, '..', '..', '..', '..');
const ORCH = path.join(PLUGIN, 'scripts', 'orchestrator');
const QUEUE = path.join(ORCH, 'queue.mjs');
const MAKE_MISSION = path.join(ORCH, 'make-mission.mjs');
const temporary: string[] = [];
afterAll(() => {
  for (const m of temporary) fs.rmSync(m, { recursive: true, force: true });
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const TL = require('../taskLinks.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const O = require('../../missionText.js');

/** A document with numbered sections: § 1 is lines 3-4, § 2 lines 6-7. */
const DOC = ['# Plan', '', '## 1. Today', 'text', '', '## 2. The rule', 'text', ''].join('\n');

// ---- Pure: the header lines taskLinks gives the track block -------------------------------------------------------

describe('taskLinks.missionLines: the track block header lines (pure)', () => {
  const files: Record<string, string> = {
    'docs/plan.md': DOC,
    'docs/spec.md': DOC,
    'docs/history.md': DOC,
    'docs/internal/notes.md': DOC,
    'docs/private/secret.md': DOC,
  };
  const ctx = (extra: object = {}) => ({
    register: {
      entries: [
        {
          id: 'PL-A',
          sources: [
            { path: 'docs/plan.md', anchor: '§ 2', role: 'plan' },
            { path: 'docs/spec.md', role: 'spec' },
            { path: 'docs/history.md', role: 'history' },
            { path: 'docs/internal/notes.md', anchor: '1', role: 'investigation' },
            { path: 'docs/private/secret.md', anchor: '#the-rule' },
          ],
        },
      ],
      archive: {},
    },
    readFile: (p: string) => files[p] ?? null,
    isIgnored: (p: string) => p.startsWith('docs/internal/') || p.startsWith('docs/private/'),
    mainRoot: '/main',
    config: { privatePaths: [{ path: 'docs/private', read: false }] },
    ...extra,
  });

  it('plan sources with roles and anchors become line ranges; history is left out; private gives a PRIVATE line', () => {
    expect(TL.missionLines(TL.taskLinks({ plan: 'PL-A' }, ctx()))).toEqual([
      'READ: docs/plan.md:6-7',
      'READ: docs/spec.md',
      'READ: /main/docs/internal/notes.md:3-4',
      'PRIVATE: docs/private/secret.md #the-rule',
    ]);
  });

  it('the task own sources replace the plan sources (a source without a role counts as plan)', () => {
    expect(
      TL.missionLines(TL.taskLinks({ plan: 'PL-A', sources: [{ path: 'docs/spec.md', anchor: '§ 1' }] }, ctx())),
    ).toEqual(['READ: docs/spec.md:3-4']);
  });

  it('a task with only an origin source, or no links at all, gives no lines', () => {
    expect(TL.missionLines(TL.taskLinks({ source: 'docs/plan.md § 2' }, ctx()))).toEqual([]);
    expect(TL.missionLines(TL.taskLinks({}, ctx()))).toEqual([]);
  });

  it('a private link with a numbered anchor is written as § N', () => {
    const c = ctx({ config: { privatePaths: [{ path: 'docs/plan.md', read: false }] } });
    expect(TL.missionLines(TL.taskLinks({ sources: [{ path: 'docs/plan.md', anchor: '2' }] }, c))).toEqual([
      'PRIVATE: docs/plan.md § 2',
    ]);
  });
});

// ---- Pure: the read-first list with links ---------------------------------------------------------------------------

describe('missionText.readFirstList: links first, then the mission paths, one cap (pure)', () => {
  const exists = (p: string) => !p.startsWith('missing/');

  it('without links and with the default placing it is exactly readFirstPaths', () => {
    const text = 'Read docs/a.md § 2 and src/x.js, then missing/y.md and src/x.js:3-9.';
    expect(O.readFirstList(text, exists)).toEqual({ read: O.readFirstPaths(text, exists), private: [] });
  });

  it('the links come first and the cap of 12 is shared with the mission paths', () => {
    const links = Array.from({ length: 10 }, (_, i) => `docs/l${i}.md:1-2`);
    const text = 'Touch src/a.js src/b.js src/c.js src/d.js src/e.js.';
    const r = O.readFirstList(text, exists, { links, privateLinks: ['docs/p.md § 1'] });
    expect(r.read).toEqual([...links, 'src/a.js']);
    expect(r.private).toEqual(['docs/p.md § 1']);
    expect(r.read.length + r.private.length).toBe(O.READ_FIRST_MAX);
  });

  it('a mission path is placed: absolute when the worktree lacks it, a private line when it is private', () => {
    const place = (f: string) => (f === 'docs/only-main.md' ? '/main/docs/only-main.md' : f === 'docs/p.md' ? null : f);
    const r = O.readFirstList('See docs/only-main.md § 2, docs/p.md and src/a.js:3-4.', exists, { place });
    expect(r).toEqual({ read: ['/main/docs/only-main.md § 2', 'src/a.js:3-4'], private: ['docs/p.md'] });
  });

  it('a mission path already read whole by a link is not listed twice', () => {
    const r = O.readFirstList('See docs/spec.md and docs/spec.md § 2 and src/a.js.', exists, {
      links: ['docs/spec.md', 'docs/plan.md:6-7'],
    });
    expect(r.read).toEqual(['docs/spec.md', 'docs/plan.md:6-7', 'src/a.js']);
  });

  it('privateBlock is one line per private document and empty without any', () => {
    expect(O.privateBlock([])).toBe('');
    expect(O.privateBlock(['docs/p.md § 1'])).toBe(
      'Private, ask the orchestrator for an excerpt (do not open it): docs/p.md § 1',
    );
  });
});

// ---- The whole path: queue -> trackFile -> make-mission ----------------------------------------------------------

/**
 * A temporary git repo with a lite queue:
 *   tracked:   docs/plan.md, docs/spec.md, docs/history.md, docs/d0..d10.md, src/a.js .. src/e.js
 *   ignored:   docs/internal/notes.md, docs/private/secret.md (privatePaths read: false)
 *   untracked: docs/fresh.md (exists only in the main tree, not ignored, not committed)
 * and a plan register with PL-A (every kind of source) and PL-CAP (eleven tracked documents).
 */
function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-mission-links-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-mission-links-home-'));
  temporary.push(root, home);
  const g = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
      cwd: root,
      stdio: 'pipe',
      encoding: 'utf8',
    }).trim();
  g('init', '-q', '-b', 'main');
  for (const d of ['docs/internal', 'docs/private', 'src']) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, '.gitignore'), 'docs/internal/\ndocs/private/\ndata/\nout/\n');
  const tracked = ['docs/plan.md', 'docs/spec.md', 'docs/history.md'];
  for (let i = 0; i <= 10; i++) tracked.push(`docs/d${i}.md`);
  for (const f of tracked) fs.writeFileSync(path.join(root, f), DOC);
  for (const c of 'abcde') {
    fs.writeFileSync(path.join(root, 'src', `${c}.js`), '// x\n');
    tracked.push(`src/${c}.js`);
  }
  for (const f of ['docs/internal/notes.md', 'docs/private/secret.md', 'docs/fresh.md'])
    fs.writeFileSync(path.join(root, f), DOC);
  g('add', '.gitignore', ...tracked);
  g('commit', '-q', '-m', 'start');
  const head = g('rev-parse', 'HEAD');

  const data = path.join(root, 'data');
  const out = path.join(root, 'out');
  fs.mkdirSync(data);
  fs.mkdirSync(out);
  const plan = (id: string, sources: object[]) => ({
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
        plan('PL-A', [
          { path: 'docs/plan.md', anchor: '§ 2', role: 'plan' },
          { path: 'docs/history.md', role: 'history' },
          { path: 'docs/internal/notes.md', anchor: '§ 1', role: 'investigation' },
          { path: 'docs/private/secret.md', role: 'spec' },
          { path: 'docs/fresh.md', role: 'plan' },
        ]),
        plan(
          'PL-CAP',
          Array.from({ length: 11 }, (_, i) => ({ path: `docs/d${i}.md`, anchor: '§ 1', role: 'plan' })),
        ),
      ],
      archive: {},
      changelog: [],
    }),
  );
  const task = (id: string, extra: object) => ({
    id,
    title: `Task ${id}`,
    status: 'picked',
    picked_by: 'tester',
    class: 'D',
    estimate_min: 40,
    project: 'p',
    domain: 'x',
    branch: `queue/${id}`,
    owned_files: ['src/a.js'],
    owner_db: [],
    shared_patch: [],
    added: '2026-11-01',
    ...extra,
  });
  const mission = '## Mission\n\nChange src/a.js. Read docs/plan.md § 1 and docs/spec.md first.\n';
  fs.writeFileSync(
    path.join(data, 'queue.json'),
    JSON.stringify({
      projects: { p: { name: 'p' } },
      tasks: [
        task('T-NONE', { mission, source: 'review of X, finding M1' }),
        task('T-ORIGIN', { mission, source: 'docs/plan.md § 2' }),
        task('T-PLAN', { mission: '## Mission\n\nChange src/a.js. Look at docs/fresh.md and docs/private/secret.md.\n', plan: 'PL-A' }),
        task('T-NARROW', { mission, plan: 'PL-A', sources: [{ path: 'docs/spec.md', anchor: '§ 2' }] }),
        task('T-MAIN', {
          mission:
            '## Mission\n\nChange src/a.js. Read docs/fresh.md, docs/internal/notes.md § 2 and docs/private/secret.md.\n',
        }),
        task('T-CAP', {
          mission: '## Mission\n\nTouch src/a.js src/b.js src/c.js src/d.js src/e.js.\n',
          plan: 'PL-CAP',
        }),
      ],
    }),
  );
  const configFile = path.join(root, 'queue.config.json');
  fs.writeFileSync(
    configFile,
    JSON.stringify({
      mode: 'lite',
      baseBranch: 'main',
      loadGuard: { minFreeMemoryPct: null },
      privatePaths: [{ path: 'docs/private', read: false }],
    }),
  );
  const common = path.join(root, 'out', 'common.md');
  fs.writeFileSync(common, 'Protocol: branch __BRANCH__ from __HEAD__, track __TRACK__, block __BLOCK__.\n');
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
  const node = (script: string, ...args: string[]) => {
    const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env, cwd: root });
    return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
  };
  /** The track file for one task (queue.mjs trackFile), then its mission (make-mission.mjs). */
  const missionFor = (id: string) => {
    const track = path.join(out, `track-${id}.md`);
    const t = node(QUEUE, 'trackFile', id, '--out', track);
    expect(t.code, t.err + t.out).toBe(0);
    const m = node(MAKE_MISSION, '--common', common, '--track', track, '--head', head, '--out', out);
    expect(m.code, m.err + m.out).toBe(0);
    const text = fs.readFileSync(path.join(out, `prompt-${id}.md`), 'utf8');
    // The sha varies per run: the full head and its short form (in the queue's outside-work warning) are normalised.
    const mission = text.split(head).join('<HEAD>').split(head.slice(0, 8)).join('<SHA>');
    return { track: fs.readFileSync(track, 'utf8'), text, mission };
  };
  return { root, missionFor };
}

/** The read-first block of a mission: its heading and list, plus the private lines right after it. */
const readFirstOf = (text: string) => {
  const lines = text.split('\n');
  const i = lines.indexOf(O.READ_FIRST_HEADING ?? 'Read these in your first turn, all in the same turn:');
  if (i < 0) return [];
  const out: string[] = [];
  for (let k = i + 1; k < lines.length && lines[k].trim(); k++) out.push(lines[k]);
  return out;
};

// The missions made by the code before this step (main 8876550) for the two tasks without links, with the head sha
// replaced by <HEAD>. The new code must make the very same bytes.
const GOLDEN_NONE =
  '# TRACK T-NONE (Task T-NONE)\n\nRead these in your first turn, all in the same turn:\n- src/a.js\n- docs/plan.md § 1 (line 3–4)\n- docs/spec.md\n\nMigration block: none (the project has no migration flow)\n\nProtocol: branch queue/T-NONE from <HEAD>, track T-NONE, block none (the project has no migration flow).\n\n\n## TRACK T-NONE (Task T-NONE; source: review of X, finding M1; class D, estimate 39 min)\n\n**Ownership in the queue:** files src/a.js; DB none; shared patch none. Do not touch anything other tasks in the queue own; if you need to, report it (SendMessage) instead of editing it.\n\n**WARNING from the queue (work outside the queue): your owned files have changed outside the queue since the task was added (unknown time).** The mission may be outdated. Read the diff before you build on, and write in the report what no longer holds:\n- `src/a.js` in <SHA> "start": `git show <SHA> -- src/a.js`\n\n## Mission\n\nChange src/a.js. Read docs/plan.md § 1 (line 3–4) and docs/spec.md first.\n';
const GOLDEN_ORIGIN =
  '# TRACK T-ORIGIN (Task T-ORIGIN)\n\nRead these in your first turn, all in the same turn:\n- src/a.js\n- docs/plan.md § 1 (line 3–4)\n- docs/spec.md\n- docs/plan.md § 2 (line 6–7)\n\nMigration block: none (the project has no migration flow)\n\nProtocol: branch queue/T-ORIGIN from <HEAD>, track T-ORIGIN, block none (the project has no migration flow).\n\n\n## TRACK T-ORIGIN (Task T-ORIGIN; source: docs/plan.md § 2 (line 6–7); class D, estimate 39 min)\n\n**Ownership in the queue:** files src/a.js; DB none; shared patch none. Do not touch anything other tasks in the queue own; if you need to, report it (SendMessage) instead of editing it.\n\n**WARNING from the queue (work outside the queue): your owned files have changed outside the queue since the task was added (unknown time).** The mission may be outdated. Read the diff before you build on, and write in the report what no longer holds:\n- `src/a.js` in <SHA> "start": `git show <SHA> -- src/a.js`\n\n## Mission\n\nChange src/a.js. Read docs/plan.md § 1 (line 3–4) and docs/spec.md first.\n';

describe('make-mission: the task links in the read-first list (queue -> trackFile -> make-mission)', () => {
  const p = project();
  const abs = (rel: string) => path.join(p.root, rel).replace(/\\/g, '/');

  it('a task without links gives a byte-identical mission', () => {
    const m = p.missionFor('T-NONE');
    expect(m.mission).toBe(GOLDEN_NONE);
    // The track file has no link lines either.
    expect(m.track).not.toMatch(/^(READ|PRIVATE):/m);
  });

  it('a task with only an origin source reads nothing extra (byte-identical as well)', () => {
    const m = p.missionFor('T-ORIGIN');
    expect(m.mission).toBe(GOLDEN_ORIGIN);
    expect(m.track).not.toMatch(/^(READ|PRIVATE):/m);
  });

  it('plan sources come first with line ranges; history is left out; ignored and main-only files are absolute; private is a line', () => {
    const m = p.missionFor('T-PLAN');
    expect(readFirstOf(m.text)).toEqual([
      '- docs/plan.md:6-7',
      `- ${abs('docs/internal/notes.md')}:3-4`,
      `- ${abs('docs/fresh.md')}`,
      '- src/a.js',
      'Private, ask the orchestrator for an excerpt (do not open it): docs/private/secret.md',
    ]);
    expect(m.text).not.toContain('docs/history.md');
    expect(m.text).not.toContain(abs('docs/private/secret.md'));
  });

  it('the task own sources narrow the plan', () => {
    const m = p.missionFor('T-NARROW');
    expect(readFirstOf(m.text)).toEqual([
      '- docs/spec.md:6-7',
      // The mission's own paths follow in their own order (the whole spec.md stays: the link reads only § 2).
      '- src/a.js',
      '- docs/plan.md § 1 (line 3–4)',
      '- docs/spec.md',
    ]);
  });

  it('a mission path the worktree will not have gets a path that works; a private one gets the private line', () => {
    const m = p.missionFor('T-MAIN');
    expect(readFirstOf(m.text)).toEqual([
      '- src/a.js',
      `- ${abs('docs/fresh.md')}`,
      `- ${abs('docs/internal/notes.md')} § 2 (line 6–7)`,
      'Private, ask the orchestrator for an excerpt (do not open it): docs/private/secret.md',
    ]);
    // No link lines: the task has no plan and no sources.
    expect(m.track).not.toMatch(/^(READ|PRIVATE):/m);
  });

  it('the cap of 12 is shared between the plan links and the mission paths', () => {
    const m = p.missionFor('T-CAP');
    const list = readFirstOf(m.text);
    expect(list).toHaveLength(O.READ_FIRST_MAX);
    expect(list.slice(0, 11)).toEqual(Array.from({ length: 11 }, (_, i) => `- docs/d${i}.md:3-4`));
    expect(list[11]).toBe('- src/a.js');
  });
});
