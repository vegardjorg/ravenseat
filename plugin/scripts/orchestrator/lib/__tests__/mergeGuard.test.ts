// =============================================================
// mergeGuard.test.ts: the guard check merge-track.mjs runs before a track branch is merged.
//
// Locks that a change to a protected path (.claude/, scripts/orchestrator/, plugin hooks and agents, queue.config.json,
// package.json …) stops the merge unless the task owns the path, that folder ownership ("/" last) covers subfolders,
// that a rename into (or out of) a protected path is caught, and that files outside the ownership only warn. The last
// block runs merge-track.mjs in a temporary repo: exit 4 before the merge, and --allow-guard lets it through and logs.
// See lib/mergeGuard.js.
// =============================================================
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { assessGuard, foreignOwners, ownershipPulseLines, globMatch, isProtected, migrCovered, ownerNotes, readDiff, taskIdFromBranch } from '../mergeGuard';
import { mergePlan } from '../logic/merge';
import { STANDARD } from '../queueConfig';

const changed = (...paths: string[]) => paths.map((p) => ({ status: 'M', paths: [p] }));
const MIGR = { folder: 'db/migrations', filePattern: '^(\\d+)_.*\\.sql$' };

describe('the floor of the protected paths', () => {
  it('holds when a project empties or replaces the list', () => {
    for (const list of [[], ['docs/']]) {
      for (const p of ['queue.config.json', '.claude/settings.json', 'sub/.claude/x.md', 'CLAUDE.md', 'CLAUDE.queue.md', '.husky/pre-push', 'scripts/orchestrator/queue.mjs'])
        expect(isProtected(p, list), p).toBe(true);
    }
  });
  it('lets the rest of the list go when the project says so', () => {
    expect(isProtected('package.json', [])).toBe(false);
    expect(isProtected('package.json')).toBe(true);
    expect(isProtected('src/a.ts', [])).toBe(false);
  });
});

describe('protected paths: the M3 additions and case (plans/review-2026-11-02.md)', () => {
  it('git hook managers, package manager configs, editor tasks and CLAUDE.md at any level are protected', () => {
    for (const p of [
      '.husky/pre-commit',
      'lefthook.yml',
      '.npmrc',
      'packages/app/.npmrc',
      '.yarnrc.yml',
      '.pnpmfile.cjs',
      '.vscode/tasks.json',
      '.github/workflows/ci.yml',
      'CLAUDE.md',
      'docs/area/CLAUDE.md',
      'CLAUDE.local.md',
      'packages/app/.claude/settings.json',
      '.gitattributes',
    ])
      expect(isProtected(p), p).toBe(true);
    for (const p of ['src/claude.ts', 'docs/CLAUDE-notes.md', 'src/.vscode-like/x.ts', 'npmrc.md'])
      expect(isProtected(p), p).toBe(false);
  });
  it('the match ignores case: .CLAUDE/ and .Claude/ are .claude/ on Windows and macOS', () => {
    for (const p of [
      '.CLAUDE/settings.json',
      '.Claude/agents/x.md',
      '.GitHub/workflows/ci.yml',
      'Package.json',
      'claude.md',
      '.Husky/pre-push',
      'VITEST.config.ts',
    ])
      expect(isProtected(p), p).toBe(true);
    // A custom list matches without case too.
    expect(isProtected('Infra/Secrets.tf', ['infra/'])).toBe(true);
    // The glob helper keeps its case-sensitive default for its other users (the test-weakening check).
    expect(globMatch('*.test.ts', 'A.TEST.TS')).toBe(false);
    expect(globMatch('*.test.ts', 'A.TEST.TS', { ignoreCase: true })).toBe(true);
  });
  it('ownerNotes keeps the warnings and their file lines, and nothing else from the merge output', () => {
    const out = 'Merging\nNOTE A: no owned_files\n  a.txt\n  b.txt\nMerge made\n  1 file changed\nWARNING ownership drift (A): 1 file(s)\n  c.txt\nDone';
    expect(ownerNotes(out)).toEqual(['NOTE A: no owned_files', '  a.txt', '  b.txt', 'WARNING ownership drift (A): 1 file(s)', '  c.txt']);
    expect(ownerNotes('Merged')).toEqual([]);
  });
  it('a task without owned_files gets its changed files as unlisted: no drift and no stop', () => {
    const none = assessGuard({ changes: changed('README.md'), ownedFiles: [] });
    expect(none.unlisted).toEqual(['README.md']);
    expect(none.drift).toEqual([]);
    expect(none.stop).toBe(false);
    expect(assessGuard({ changes: changed('README.md'), ownedFiles: ['src/'] }).unlisted).toEqual([]);
  });
  it('a track that writes .CLAUDE/settings.json without owning it stops the merge', () => {
    const r = assessGuard({ changes: changed('.CLAUDE/settings.json'), ownedFiles: ['src/'] });
    expect(r.stop).toBe(true);
    expect(r.violations.map((v) => v.path)).toEqual(['.CLAUDE/settings.json']);
  });
});

describe('a migration from a task that does not own it stops the merge (NESTE 5)', () => {
  const change = (p: string) => [{ status: 'A', paths: [p] }];
  it('the usual migration folders, also in a subfolder, with no migration flow configured', () => {
    for (const p of [
      'supabase/migrations/1_a.sql',
      'prisma/migrations/2_b/migration.sql',
      'apps/api/prisma/migrations/3_c/migration.sql',
      'db/migrate/4_d.rb',
      'db/migrations/5_e.sql',
      'migrations/6_f.sql',
      'alembic/versions/7_g.py',
      'drizzle/0001_h.sql',
    ]) {
      const g = assessGuard({ changes: change(p) });
      expect(g.stop, p).toBe(true);
      expect(g.violations[0].reason, p).toMatch(/migration/);
    }
  });
  it('the configured folder counts too, whatever its name', () => {
    const g = assessGuard({ changes: change('database/changes/1_a.sql'), migrations: { folder: 'database/changes' } });
    expect(g.stop).toBe(true);
  });
  it('a task with the migration block, or that owns the file, passes', () => {
    const migrations = { folder: 'db/migrations' };
    expect(assessGuard({ changes: change('db/migrations/3601_a.sql'), migrBlock: '3600-3609', migrations }).stop).toBe(false);
    expect(assessGuard({ changes: change('db/migrations/3601_a.sql'), ownedFiles: ['db/migrations/'], migrations }).stop).toBe(false);
  });
  it('only a task with a migration block pushes migrations by itself, also after an overridden guard', () => {
    const migrations = { folder: 'db/migrations', pushCommand: 'npm run db:migrate' };
    const files = ['db/migrations/3601_a.sql'];
    const withBlock = mergePlan({ o: { migr_block: '3600-3609' }, files, migrations });
    expect(withBlock.migrPush).toBe(true);
    const without = mergePlan({ o: {}, files, migrations });
    expect(without.migrPush).toBe(false);
    expect(without.step).not.toContain('migr-push');
    expect(without.notes.join(' ')).toMatch(/NOT pushed/);
  });
  it('ordinary code with a similar name does not stop, and an empty protected list turns it off', () => {
    expect(assessGuard({ changes: change('src/migrations.ts') }).stop).toBe(false);
    expect(assessGuard({ changes: change('src/migrate/index.ts') }).stop).toBe(false);
    expect(assessGuard({ changes: change('migrations/1_a.sql'), protectedPaths: [] }).stop).toBe(false);
  });
});

describe('protected paths (the default list)', () => {
  it('recognises hooks, settings, agents, skills, orchestrator scripts, the queue config and package files', () => {
    for (const p of [
      '.claude/settings.json',
      '.claude/agents/track.md',
      '.claude/skills/queue/SKILL.md',
      '.githooks/pre-commit',
      '.github/workflows/ci.yml',
      '.mcp.json',
      'scripts/orchestrator/merge-track.mjs',
      'scripts/orchestrator/lib/pushGuard.js',
      'plugin/scripts/orchestrator/hook-push-guard.mjs',
      'plugin/hooks/hooks.json',
      'plugin/agents/track-d.md',
      'plugin/skills/queue/SKILL.md',
      'plugin/.claude-plugin/plugin.json',
      'queue.config.json',
      'CLAUDE.queue.md',
      'plugin/CLAUDE.queue.md',
      'plugin/settings.queue.json',
      'package.json',
      'package-lock.json',
      'admin/package.json',
    ])
      expect(isProtected(p), p).toBe(true);
  });
  it('lets ordinary code through', () => {
    for (const p of [
      'src/index.ts',
      'scripts/orchestratorX.mjs',
      'plugin/docs/orchestration.md',
      'docs/mission-template.md',
      'README.md',
      'node_modules/foo/package.json',
      'app/node_modules/x/package.json',
    ])
      expect(isProtected(p), p).toBe(false);
  });
  it('normalises backslash and ./', () => {
    expect(isProtected('.\\.claude\\settings.json')).toBe(true);
    expect(isProtected('./package.json')).toBe(true);
  });
  it('follows a configured list, and an empty list leaves only the floor', () => {
    expect(isProtected('infra/deploy.sh', ['infra/'])).toBe(true);
    expect(isProtected('package.json', ['infra/'])).toBe(false);
    expect(isProtected('package.json', [])).toBe(false);
    expect(STANDARD.protectedPaths).toContain('queue.config.json');
  });
});

describe('assessGuard', () => {
  it('stops a settings.json change without ownership', () => {
    const r = assessGuard({ changes: changed('.claude/settings.json', 'src/x.ts'), ownedFiles: ['src/x.ts'] });
    expect(r.violations.map((b) => b.path)).toEqual(['.claude/settings.json']);
    expect(r.stop).toBe(true);
  });
  it('lets a protected path through when the task owns it, in owned_files or shared_patch', () => {
    const r = assessGuard({
      changes: changed('plugin/agents/track.md', 'plugin/scripts/orchestrator/merge-track.mjs'),
      ownedFiles: ['plugin/agents/track.md'],
      sharedPatch: ['plugin/scripts/orchestrator/merge-track.mjs'],
    });
    expect(r.violations).toEqual([]);
    expect(r.drift).toEqual([]);
    expect(r.stop).toBe(false);
  });
  it('folder ownership with "/" last covers subfolders, but not look-alike names', () => {
    const r = assessGuard({
      changes: changed('.claude/skills/plan/SKILL.md', '.claude/skills-x/a.md'),
      ownedFiles: ['.claude/skills/'],
    });
    expect(r.violations.map((b) => b.path)).toEqual(['.claude/skills-x/a.md']);
  });
  it('file ownership without "/" does not cover a path with the same prefix', () => {
    const r = assessGuard({
      changes: changed('scripts/orchestrator/queue.mjs.bak'),
      ownedFiles: ['scripts/orchestrator/queue.mjs'],
    });
    expect(r.violations).toHaveLength(1);
  });
  it('a rename INTO a protected path is caught (new path), also from an owned file', () => {
    const r = assessGuard({
      changes: readDiff('R100\tsrc/harmless.js\t.githooks/pre-push\n'),
      ownedFiles: ['src/harmless.js'],
    });
    expect(r.violations.map((b) => b.path)).toEqual(['.githooks/pre-push']);
    expect(r.violations[0].reason).toMatch(/renamed from src\/harmless\.js/);
  });
  it('a rename OUT of a protected path is caught (it deletes the protected file)', () => {
    const r = assessGuard({
      changes: readDiff('R090\t.claude/settings.json\tdocs/old.json\n'),
      ownedFiles: ['docs/old.json'],
    });
    expect(r.violations.map((b) => b.path)).toEqual(['.claude/settings.json']);
  });
  it('a copy only counts the target', () => {
    const r = assessGuard({ changes: readDiff('C075\tqueue.config.json\tdocs/example.json\n'), ownedFiles: ['x'] });
    expect(r.violations).toEqual([]);
    expect(r.drift).toEqual(['docs/example.json']);
  });
  it('--allow-guard turns a violation into no stop, but the list is kept', () => {
    const r = assessGuard({ changes: changed('.github/workflows/ci.yml'), allowGuard: true });
    expect(r.violations).toHaveLength(1);
    expect(r.stop).toBe(false);
    expect(r.overridden).toBe(true);
  });
  it('files outside the ownership give a warning (drift), not a stop', () => {
    const r = assessGuard({
      changes: changed('src/x.ts', 'src/other.ts', 'components/y/z.tsx'),
      ownedFiles: ['src/x.ts', 'components/y/'],
    });
    expect(r.drift).toEqual(['src/other.ts']);
    expect(r.stop).toBe(false);
  });
  it('no drift warning when the task has no ownership registered', () => {
    expect(assessGuard({ changes: changed('src/x.ts') }).drift).toEqual([]);
  });
  it("migrations in the task's migr_block count as owned", () => {
    const r = assessGuard({
      changes: changed('db/migrations/3605_x.sql', 'db/migrations/3610_y.sql'),
      ownedFiles: ['src/x.ts'],
      migrBlock: '3600–3609',
      migrations: MIGR,
    });
    expect(r.drift).toEqual(['db/migrations/3610_y.sql']);
  });
});

describe('helpers', () => {
  it('readDiff keeps both paths on rename and copy', () => {
    expect(readDiff('M\ta.txt\nR100\tb.txt\tc.txt\nC075\td\te\nD\tf\n')).toEqual([
      { status: 'M', paths: ['a.txt'] },
      { status: 'R', paths: ['b.txt', 'c.txt'] },
      { status: 'C', paths: ['d', 'e'] },
      { status: 'D', paths: ['f'] },
    ]);
  });
  it('taskIdFromBranch follows the branch prefix', () => {
    expect(taskIdFromBranch('queue/A-1')).toBe('A-1');
    expect(taskIdFromBranch('origin/queue/B-2')).toBe('B-2');
    expect(taskIdFromBranch('wave/4a-track')).toBeNull();
    expect(taskIdFromBranch('q-C', 'q-')).toBe('C');
    expect(taskIdFromBranch('queue/A', '')).toBeNull();
  });
  it('migrCovered understands a shortened and a full end, the folder and the file pattern', () => {
    expect(migrCovered('db/migrations/3609_x.sql', '3600–3609', MIGR)).toBe(true);
    expect(migrCovered('db/migrations/20260926002849_x.sql', '20260926002840–2849', MIGR)).toBe(true);
    expect(migrCovered('db/migrations/20260926009265_x.sql', '20260926009260–20260926009269', MIGR)).toBe(true);
    expect(migrCovered('db/migrations/3599_x.sql', '3600–3609', MIGR)).toBe(false);
    expect(migrCovered('db/other/3605_x.sql', '3600–3609', MIGR)).toBe(false);
    expect(migrCovered('db/migrations/3605_x.txt', '3600–3609', MIGR)).toBe(false);
    expect(migrCovered('db/migrations/3605_x.sql', null, MIGR)).toBe(false);
    expect(migrCovered('db/migrations/3605_x.sql', '3600–3609', { folder: null })).toBe(false);
  });
});

describe("a file another active task owns (ownership 1, plans/ROADMAP.md)", () => {
  const me = { id: 'A', status: 'review', owned_files: ['a.txt'], shared_patch: ['shared/reg.ts'] };
  const tasks = [
    me,
    { id: 'B', status: 'running', owned_files: ['b.txt', 'lib/b/'] },
    { id: 'C', status: 'done', owned_files: ['c.txt'] },
    { id: 'D', status: 'waiting', owned_files: ['d.txt'] },
    { id: 'E', status: 'picked', owned_files: ['e.txt'], shared_patch: ['shared/reg.ts'] },
  ];
  it('names the file and the owner when the owner is running, in review or picked', () => {
    expect(foreignOwners(['a.txt', 'b.txt', 'lib/b/x.ts', 'c.txt', 'd.txt', 'e.txt', 'z.txt'], me, tasks)).toEqual([
      { path: 'b.txt', owner: 'B' },
      { path: 'lib/b/x.ts', owner: 'B' },
      { path: 'e.txt', owner: 'E' },
    ]);
  });
  it("another task's shared_patch is no ownership, and a path the task owns itself is never foreign", () => {
    expect(foreignOwners(['shared/reg.ts', 'a.txt'], me, tasks)).toEqual([]);
    expect(foreignOwners(['b.txt'], { ...me, owned_files: ['b.txt'] }, tasks)).toEqual([]);
  });
  it('a wave track (no task) and an empty queue give nothing; backslashes are normalised', () => {
    expect(foreignOwners(['b.txt'], null, tasks)).toEqual([]);
    expect(foreignOwners(['lib\\b\\y.ts'], me, tasks)).toEqual([{ path: 'lib/b/y.ts', owner: 'B' }]);
    expect(foreignOwners(['b.txt'], me, [])).toEqual([]);
  });
  it('the pulse gets one line per track that changes another task\'s files, and nothing for an unknown diff', () => {
    const files: Record<string, string[] | null> = { A: ['a.txt', 'b.txt', 'e.txt'], B: ['b.txt'], E: null };
    const lines = ownershipPulseLines([{ id: 'A' }, { id: 'B' }, { id: 'E' }], tasks, (t: { id: string }) => files[t.id]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^OWNERSHIP: A changes 2 file\(s\) owned by B, E: b\.txt, e\.txt\. The merge stops on them/);
  });
});

describe('merge-track.mjs in a temporary repo', () => {
  const SCRIPT = path.resolve(__dirname, '..', '..', 'merge-track.mjs');
  const setup = () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ravenseat-merge-guard-'));
    const g = (...a: string[]) => {
      const r = spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
      return r.stdout.trim();
    };
    g('init', '-q', '-b', 'main');
    g('config', 'user.name', 'Merge Guard Test');
    g('config', 'user.email', 'merge-guard@test.local');
    g('config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    g('add', 'a.txt');
    g('commit', '-q', '-m', 'base');
    g('switch', '-q', '-c', 'queue/A');
    fs.mkdirSync(path.join(repo, '.claude'));
    fs.writeFileSync(path.join(repo, '.claude', 'settings.json'), '{"hooks":{}}\n');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\nb\n');
    g('add', '.claude/settings.json', 'a.txt');
    g('commit', '-q', '-m', 'track');
    g('switch', '-q', 'main');
    const data = path.join(repo, 'data');
    fs.mkdirSync(data);
    fs.writeFileSync(
      path.join(data, 'queue.json'),
      JSON.stringify({ tasks: [{ id: 'A', branch: 'queue/A', owned_files: ['a.txt'], shared_patch: [] }] }),
    );
    const env = {
      ...process.env,
      QUEUE_ROOT: repo,
      QUEUE_CONFIG: path.join(repo, 'no-config.json'),
      QUEUE_FOLDER: data,
      QUEUE_TIME_LOG: path.join(data, 'times.jsonl'),
    };
    const run = (...a: string[]) => spawnSync(process.execPath, [SCRIPT, 'queue/A', '--keep-worktree', ...a], {
      cwd: repo,
      encoding: 'utf8',
      env,
    });
    return { repo, g, data, run };
  };

  it('stops with exit 4 before the merge, and --allow-guard merges and logs the override', () => {
    const { repo, g, data, run } = setup();
    try {
      const head = g('rev-parse', 'HEAD');
      const stop = run();
      expect(stop.status).toBe(4);
      expect(stop.stderr).toMatch(/GUARD: queue\/A changes protected paths that the task A does not own/);
      expect(stop.stderr).toMatch(/\.claude\/settings\.json/);
      expect(stop.stderr).not.toMatch(/a\.txt/);
      expect(g('rev-parse', 'HEAD')).toBe(head);
      expect(fs.existsSync(path.join(repo, '.git', 'MERGE_HEAD'))).toBe(false);

      const ok = run('--allow-guard');
      expect(ok.status, ok.stderr).toBe(0);
      expect(ok.stdout).toMatch(/GUARD OVERRIDDEN \(--allow-guard\) for queue\/A/);
      expect(g('rev-parse', 'HEAD')).not.toBe(head);
      const row = JSON.parse(fs.readFileSync(path.join(data, 'times.jsonl'), 'utf8').trim());
      expect(row).toMatchObject({ track: 'A', event: 'guard-overridden', paths: ['.claude/settings.json'] });
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('a file another active task owns stops the merge with exit 4 and names the owner; --allow-guard merges and logs it', () => {
    const { repo, g, data, run } = setup();
    try {
      fs.writeFileSync(
        path.join(data, 'queue.json'),
        JSON.stringify({
          tasks: [
            { id: 'A', status: 'review', branch: 'queue/A', owned_files: ['.claude/'], shared_patch: [] },
            { id: 'B', status: 'running', branch: 'queue/B', owned_files: ['a.txt'] },
          ],
        }),
      );
      const head = g('rev-parse', 'HEAD');
      const stop = run();
      expect(stop.status).toBe(4);
      expect(stop.stderr).toMatch(/OWNERSHIP: queue\/A changes file\(s\) that another active task owns/);
      expect(stop.stderr).toMatch(/a\.txt\s+\(owned by B\)/);
      expect(g('rev-parse', 'HEAD')).toBe(head);

      const ok = run('--allow-guard');
      expect(ok.status, ok.stderr).toBe(0);
      expect(ok.stdout).toMatch(/OWNERSHIP OVERRIDDEN \(--allow-guard\) for queue\/A/);
      const row = JSON.parse(fs.readFileSync(path.join(data, 'times.jsonl'), 'utf8').trim());
      expect(row).toMatchObject({ track: 'A', event: 'guard-overridden', foreign: [{ path: 'a.txt', owner: 'B' }] });
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('the test, lint and type configs (default list, globs)', () => {
  it('protects the runner, lint and type configs at any depth', () => {
    for (const p of [
      'vitest.config.mjs',
      'app/vitest.config.ts',
      'vitest.workspace.ts',
      'jest.config.js',
      'playwright.config.ts',
      'cypress.config.ts',
      'karma.conf.js',
      '.mocharc.yml',
      'tsconfig.json',
      'packages/web/tsconfig.build.json',
      '.eslintrc.cjs',
      'eslint.config.mjs',
      'biome.json',
      'pytest.ini',
      'tox.ini',
      'setup.cfg',
      'conftest.py',
      'tests/unit/conftest.py',
      'pyproject.toml',
      'mypy.ini',
      '.coveragerc',
      '.golangci.yml',
      'crates/core/Cargo.toml',
      'Makefile',
      'justfile',
      '.pre-commit-config.yaml',
      'phpunit.xml.dist',
      '.rspec',
    ])
      expect(isProtected(p), p).toBe(true);
  });
  it('leaves formatter configs, look-alike names and ordinary code alone', () => {
    for (const p of ['.prettierrc', 'src/vitest.config.helper/x.ts', 'src/tsconfig.ts', 'docs/Makefile.md', 'docs/Cargo.lock.md'])
      expect(isProtected(p), p).toBe(false);
  });
  it('globMatch: a bare glob on the name, a glob with a slash on the path from the root, **/ = any folders', () => {
    expect(globMatch('*.config.ts', 'a/b/vite.config.ts')).toBe(true);
    expect(globMatch('ci/*.yml', 'ci/a.yml')).toBe(true);
    expect(globMatch('ci/*.yml', 'x/ci/a.yml')).toBe(false);
    expect(globMatch('ci/*.yml', 'ci/sub/a.yml')).toBe(false);
    expect(globMatch('**/fixtures/*.json', 'fixtures/a.json')).toBe(true);
    expect(globMatch('**/fixtures/*.json', 'a/b/fixtures/a.json')).toBe(true);
    expect(globMatch('tools/', 'tools/x/y.sh')).toBe(true);
    expect(globMatch('tsconfig?.json', 'tsconfig1.json')).toBe(true);
    expect(globMatch('a.b*', 'aXb')).toBe(false); // the dot is literal
  });
  it('a glob entry in owned_files is not needed: the exact path in owned_files owns the config', () => {
    expect(assessGuard({ changes: changed('vitest.config.mjs'), ownedFiles: ['src/a.ts'] }).stop).toBe(true);
    expect(assessGuard({ changes: changed('vitest.config.mjs'), ownedFiles: ['vitest.config.mjs'] }).stop).toBe(false);
  });
});

describe('merge-track.mjs and a test config change', () => {
  const SCRIPT = path.resolve(__dirname, '..', '..', 'merge-track.mjs');
  /** A repo where queue/A changes vitest.config.mjs (and a.txt); `owned` is the task's owned_files, `config` the queue.config.json. */
  const setup = (owned: string[], config: object | null) => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ravenseat-merge-guard-tests-'));
    const g = (...a: string[]) => {
      const r = spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
      return r.stdout.trim();
    };
    g('init', '-q', '-b', 'main');
    g('config', 'user.name', 'Merge Guard Test');
    g('config', 'user.email', 'merge-guard@test.local');
    g('config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    fs.writeFileSync(path.join(repo, 'vitest.config.mjs'), "export default { test: { include: ['**/*.test.ts'] } };\n");
    g('add', 'a.txt', 'vitest.config.mjs');
    g('commit', '-q', '-m', 'base');
    g('switch', '-q', '-c', 'queue/A');
    // The weakening a track might try: collect nothing, so every gate is green.
    fs.writeFileSync(path.join(repo, 'vitest.config.mjs'), "export default { test: { include: [] } };\n");
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\nb\n');
    g('add', 'a.txt', 'vitest.config.mjs');
    g('commit', '-q', '-m', 'track');
    g('switch', '-q', 'main');
    const data = path.join(repo, 'data');
    fs.mkdirSync(data);
    fs.writeFileSync(
      path.join(data, 'queue.json'),
      JSON.stringify({ tasks: [{ id: 'A', branch: 'queue/A', owned_files: owned, shared_patch: [] }] }),
    );
    const configFile = path.join(repo, config ? 'queue.config.json' : 'no-config.json');
    if (config) fs.writeFileSync(configFile, JSON.stringify(config));
    const env = {
      ...process.env,
      QUEUE_ROOT: repo,
      QUEUE_CONFIG: configFile,
      QUEUE_FOLDER: data,
      QUEUE_TIME_LOG: path.join(data, 'times.jsonl'),
    };
    const run = () =>
      spawnSync(process.execPath, [SCRIPT, 'queue/A', '--keep-worktree'], { cwd: repo, encoding: 'utf8', env });
    return { repo, run };
  };

  it('a task without owned_files merges, and the output names what it changed', () => {
    const { repo, run } = setup([], { protectedPaths: [] });
    try {
      const r = run();
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('no owned_files, and this merge changes 2 file(s)');
      expect(r.stdout).toMatch(/^ {2}a\.txt$/m);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    }
  });

  it('the defaults stop a vitest.config change by a task that does not own it', () => {
    const { repo, run } = setup(['a.txt'], null);
    try {
      const r = run();
      expect(r.status).toBe(4);
      expect(r.stderr).toMatch(/vitest\.config\.mjs/);
      expect(r.stderr).toMatch(/can switch checks off/);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
  it('the defaults let it through when the task owns the file', () => {
    const { repo, run } = setup(['a.txt', 'vitest.config.mjs'], null);
    try {
      const r = run();
      expect(r.status, r.stderr).toBe(0);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
  it('an explicit protectedPaths list replaces the defaults (it keeps its own behaviour)', () => {
    // A list without the new entries: the config change is not stopped, as before this default existed.
    const own = setup(['a.txt'], { protectedPaths: ['.claude/', 'package.json'] });
    try {
      expect(own.run().status).toBe(0);
    } finally {
      fs.rmSync(own.repo, { recursive: true, force: true });
    }
    // A list that names the config (or a glob for it) stops it.
    const glob = setup(['a.txt'], { protectedPaths: ['vitest.*'] });
    try {
      expect(glob.run().status).toBe(4);
    } finally {
      fs.rmSync(glob.repo, { recursive: true, force: true });
    }
  });
});
