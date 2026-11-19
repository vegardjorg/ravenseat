// =============================================================
// taskDescriptionFlow.test.ts: `description`, the task's short human-written summary (roadmap 2c4), through the CLI.
//
// Locks:
//   - add: --description sets it on the one task added, a "description" in --json sets it too, an empty one is not
//     stored, and --description with several tasks is refused (as --accept is);
//   - edit: --description sets and replaces it, --description "" removes it, and null in --json removes it too;
//   - the soft limit: over 320 characters gives ONE WARNING line and the description is stored anyway, in add and
//     edit; --answer-json carries the line as `descriptionWarning` instead (the JSON stays one line);
//   - info shows it (and --json carries it), together with plan, sources (roles and anchors) and source (0p2 B5);
//   - humans only: the track file and the agent's mission are byte-identical with or without a description.
// Runs queue.mjs and make-mission.mjs against temporary queues and git repos. Never the real queue.
// =============================================================
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PLUGIN = path.resolve(__dirname, '..', '..', '..');
const ORCH = path.join(PLUGIN, 'scripts', 'orchestrator');
const QUEUE = path.join(ORCH, 'queue.mjs');
const MAKE_MISSION = path.join(ORCH, 'make-mission.mjs');
const GIT_ID = ['-c', 'user.name=queue-test', '-c', 'user.email=queue-test@example.invalid'];

const temporary: string[] = [];
afterAll(() => {
  for (const m of temporary) fs.rmSync(m, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
});

/** A temporary full-mode queue in a temporary git repo, and a runner for queue.mjs against it. */
function setup() {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-description-'));
  temporary.push(folder);
  const repo = path.join(folder, 'repo');
  fs.mkdirSync(repo);
  const g = (args: string[]) =>
    execFileSync('git', ['-C', repo, ...GIT_ID, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  g(['init', '-q', '-b', 'develop']);
  fs.writeFileSync(path.join(repo, 'README.md'), 'start\n');
  g(['add', '--', 'README.md']);
  g(['commit', '-q', '-m', 'start']);
  const queueFile = path.join(folder, 'queue.json');
  fs.writeFileSync(queueFile, JSON.stringify({ created: '2026-01-01T00:00:00.000Z', limits: {}, next_migr: 3600, resolved: [], tasks: [] }));
  const configFile = path.join(folder, 'queue.config.json');
  fs.writeFileSync(configFile, JSON.stringify({ baseBranch: 'develop' }));
  const env = {
    ...process.env,
    QUEUE_FOLDER: folder,
    QUEUE_CONFIG: configFile,
    QUEUE_ROOT: folder,
    QUEUE_GIT: repo,
    QUEUE_TIME_LOG: path.join(folder, 'times.jsonl'),
    QUEUE_TRANSCRIPTS: path.join(folder, 'transcripts'),
  } as NodeJS.ProcessEnv;
  delete env.QUEUE_SCRATCHPAD;
  delete env.QUEUE_SESSION;
  const run = (...args: string[]) => {
    const r = spawnSync(process.execPath, [QUEUE, ...args], { encoding: 'utf8', env, cwd: folder });
    return { code: r.status, out: r.stdout ?? '', error: r.stderr ?? '' };
  };
  const get = (id: string) =>
    (JSON.parse(fs.readFileSync(queueFile, 'utf8')) as { tasks: Record<string, unknown>[] }).tasks.find((t) => t.id === id);
  return { run, get };
}

const task = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `Task ${id}`,
  domain: `dom-${id}`,
  class: 'K',
  mission: `The mission for ${id}.`,
  value: 6,
  content_min: 100,
  ...extra,
});

const LONG = 'word '.repeat(80).trim(); // 399 characters
const WARN = (id: string, n: number) =>
  `WARNING: ${id}: the description is ${n} characters, over the soft limit of 320; it was saved anyway. ` +
  'Keep it to a short summary; the mission holds the detail.';

describe('add sets the description', () => {
  it('--description sets it on the one task added (trimmed), without a warning', () => {
    const p = setup();
    const r = p.run('add', '--json', JSON.stringify(task('T1')), '--description', '  Users see their streak.  ');
    expect(r.code, r.error + r.out).toBe(0);
    expect(p.get('T1')?.description).toBe('Users see their streak.');
    expect(r.out).not.toContain('description is');
  });

  it('a "description" in --json sets it; an empty one is not stored', () => {
    const p = setup();
    expect(p.run('add', '--json', JSON.stringify(task('T1', { description: 'From the file.' }))).code).toBe(0);
    expect(p.get('T1')?.description).toBe('From the file.');
    expect(p.run('add', '--json', JSON.stringify(task('T2', { description: '   ' }))).code).toBe(0);
    expect(p.get('T2')).not.toHaveProperty('description');
  });

  it('--description with several tasks, or with a description in the task, is refused', () => {
    const p = setup();
    const many = p.run('add', '--json', JSON.stringify([task('T1'), task('T2')]), '--description', 'x');
    expect(many.code).not.toBe(0);
    expect(many.error + many.out).toMatch(/--description sets the description of one task/);
    const both = p.run('add', '--json', JSON.stringify(task('T3', { description: 'a' })), '--description', 'b');
    expect(both.code).not.toBe(0);
    expect(both.error + both.out).toMatch(/--description and "description" in the task/);
    expect(p.get('T1')).toBeUndefined();
  });

  it('a description that is not text is refused', () => {
    const p = setup();
    const r = p.run('add', '--json', JSON.stringify(task('T1', { description: 42 })));
    expect(r.code).not.toBe(0);
    expect(r.error + r.out).toMatch(/description must be text/);
  });

  it('over 320 characters: one WARNING line, stored anyway', () => {
    const p = setup();
    const r = p.run('add', '--json', JSON.stringify(task('T1')), '--description', LONG);
    expect(r.code, r.error).toBe(0);
    expect(r.out.split('\n').filter((l) => l.includes('description is'))).toEqual([WARN('T1', LONG.length)]);
    expect(p.get('T1')?.description).toBe(LONG);
  });

  it('--answer-json carries the warning as descriptionWarning (and leaves it out without one)', () => {
    const p = setup();
    const long = p.run('add', '--json', JSON.stringify(task('T1', { description: LONG })), '--answer-json');
    expect(long.code, long.error).toBe(0);
    const answer = JSON.parse(long.out.trim());
    expect(answer.descriptionWarning).toEqual([WARN('T1', LONG.length)]);
    const short = p.run('add', '--json', JSON.stringify(task('T2', { description: 'Short.' })), '--answer-json');
    expect(JSON.parse(short.out.trim())).not.toHaveProperty('descriptionWarning');
  });
});

describe('edit sets, replaces and removes the description', () => {
  it('--description sets and replaces it; --description "" removes it', () => {
    const p = setup();
    expect(p.run('add', '--json', JSON.stringify(task('T1'))).code).toBe(0);
    const set = p.run('edit', 'T1', '--description', 'First summary.');
    expect(set.code, set.error + set.out).toBe(0);
    expect(set.out).toContain('T1 changed: description');
    expect(p.get('T1')?.description).toBe('First summary.');
    expect(p.run('edit', 'T1', '--description', 'Second summary.').code).toBe(0);
    expect(p.get('T1')?.description).toBe('Second summary.');
    const gone = p.run('edit', 'T1', '--description', '');
    expect(gone.code, gone.error + gone.out).toBe(0);
    expect(p.get('T1')).not.toHaveProperty('description');
  });

  it('null or "" in --json removes it too', () => {
    const p = setup();
    expect(p.run('add', '--json', JSON.stringify(task('T1', { description: 'x' }))).code).toBe(0);
    expect(p.run('edit', 'T1', '--json', '{"description":null}').code).toBe(0);
    expect(p.get('T1')).not.toHaveProperty('description');
    expect(p.run('edit', 'T1', '--json', '{"description":"back"}').code).toBe(0);
    expect(p.run('edit', 'T1', '--json', '{"description":""}').code).toBe(0);
    expect(p.get('T1')).not.toHaveProperty('description');
  });

  it('over 320 characters: one WARNING line, stored anyway; --answer-json carries it', () => {
    const p = setup();
    expect(p.run('add', '--json', JSON.stringify(task('T1'))).code).toBe(0);
    const r = p.run('edit', 'T1', '--description', LONG);
    expect(r.code, r.error).toBe(0);
    expect(r.out.split('\n').filter((l) => l.includes('description is'))).toEqual([WARN('T1', LONG.length)]);
    expect(p.get('T1')?.description).toBe(LONG);
    const j = p.run('edit', 'T1', '--json', JSON.stringify({ description: `${LONG} more` }), '--answer-json');
    expect(j.code, j.error).toBe(0);
    const answer = JSON.parse(j.out.trim());
    expect(answer.changed).toEqual(['description']);
    expect(answer.descriptionWarning).toEqual([WARN('T1', LONG.length + 5)]);
  });

  it('a description that is not text is refused and nothing changes', () => {
    const p = setup();
    expect(p.run('add', '--json', JSON.stringify(task('T1', { description: 'kept' }))).code).toBe(0);
    const r = p.run('edit', 'T1', '--json', '{"description":42}');
    expect(r.code).not.toBe(0);
    expect(p.get('T1')?.description).toBe('kept');
  });
});

describe('info shows the description and the links', () => {
  it('description, plan, sources with roles and anchors, and source; --json carries the description', () => {
    const p = setup();
    const t = task('T1', {
      description: 'Users see their streak.',
      sources: [
        { path: 'README.md', anchor: '§ 1', role: 'spec' },
        { path: 'docs/history.md', role: 'history' },
      ],
      source: 'review of T0, finding M1',
    });
    expect(p.run('add', '--json', JSON.stringify(t)).code).toBe(0);
    const r = p.run('info', 'T1');
    expect(r.code, r.error).toBe(0);
    const lines = r.out.split('\n');
    expect(lines[lines.findIndex((l) => l.startsWith('title: ')) + 1]).toBe('description: Users see their streak.');
    expect(lines).toContain('sources: README.md § 1 (spec); docs/history.md (history)');
    expect(lines).toContain('source: review of T0, finding M1');
    const j = JSON.parse(p.run('info', 'T1', '--json').out);
    expect(j.description).toBe('Users see their streak.');
    expect(p.run('info', 'T1', '--field', 'description').out.trim()).toBe('Users see their streak.');
  });
});

// ---- Humans only: the agent never sees the description ----------------------------------------------------------

/**
 * A lite queue with one picked task T-DESC in a temporary git repo, with or without a description, and its track
 * file (queue.mjs trackFile) and mission (make-mission.mjs). Everything else is the same in both runs.
 */
function missionOf(description: string | null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-description-mission-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-description-home-'));
  temporary.push(root, home);
  const g = (...args: string[]) =>
    execFileSync('git', [...GIT_ID, ...args], { cwd: root, stdio: 'pipe', encoding: 'utf8' }).trim();
  g('init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, '.gitignore'), 'data/\nout/\n');
  fs.writeFileSync(path.join(root, 'src', 'a.js'), '// x\n');
  // A fixed date, so the two repos get the same commit sha and the missions can be compared byte for byte.
  const dated = { ...process.env, GIT_AUTHOR_DATE: '2026-11-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-11-01T00:00:00Z' };
  execFileSync('git', [...GIT_ID, 'add', '.gitignore', 'src/a.js'], { cwd: root, stdio: 'pipe' });
  execFileSync('git', [...GIT_ID, 'commit', '-q', '-m', 'start'], { cwd: root, stdio: 'pipe', env: dated });
  const head = g('rev-parse', 'HEAD');
  const data = path.join(root, 'data');
  const out = path.join(root, 'out');
  fs.mkdirSync(data);
  fs.mkdirSync(out);
  const t: Record<string, unknown> = {
    id: 'T-DESC',
    title: 'Task T-DESC',
    status: 'picked',
    picked_by: 'tester',
    class: 'D',
    estimate_min: 40,
    project: 'p',
    domain: 'x',
    branch: 'queue/T-DESC',
    owned_files: ['src/a.js'],
    owner_db: [],
    shared_patch: [],
    added: '2026-11-01',
    added_at: '2026-11-02T00:00:00.000Z',
    mission: '## Mission\n\nChange src/a.js so the streak shows.\n',
  };
  if (description != null) t.description = description;
  fs.writeFileSync(path.join(data, 'queue.json'), JSON.stringify({ projects: { p: { name: 'p' } }, tasks: [t] }));
  const configFile = path.join(root, 'queue.config.json');
  fs.writeFileSync(configFile, JSON.stringify({ mode: 'lite', baseBranch: 'main', loadGuard: { minFreeMemoryPct: null } }));
  const common = path.join(out, 'common.md');
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
  const node = (script: string, ...args: string[]) => {
    const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env, cwd: root });
    return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
  };
  const track = path.join(out, 'track-T-DESC.md');
  const tr = node(QUEUE, 'trackFile', 'T-DESC', '--out', track);
  expect(tr.code, tr.err + tr.out).toBe(0);
  const m = node(MAKE_MISSION, '--common', common, '--track', track, '--head', head, '--out', out);
  expect(m.code, m.err + m.out).toBe(0);
  // The root folder differs per run; nothing else may.
  const norm = (s: string) => s.split(root).join('<ROOT>').split(root.replace(/\\/g, '/')).join('<ROOT>');
  return {
    head,
    track: norm(fs.readFileSync(track, 'utf8')),
    mission: norm(fs.readFileSync(path.join(out, 'prompt-T-DESC.md'), 'utf8')),
  };
}

describe('humans only: the agent mission does not carry the description', () => {
  it('the track file and the mission are byte-identical with or without a description', () => {
    const without = missionOf(null);
    const withIt = missionOf('A SUMMARY ONLY HUMANS READ, with a line\nbreak and <b>markup</b>.');
    expect(withIt.head).toBe(without.head);
    expect(withIt.track).toBe(without.track);
    expect(withIt.mission).toBe(without.mission);
    expect(withIt.mission).not.toContain('SUMMARY ONLY HUMANS READ');
    expect(withIt.mission).toContain('Change src/a.js so the streak shows.');
  });
});
