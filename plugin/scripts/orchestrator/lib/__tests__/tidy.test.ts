// =============================================================
// tidy.test.ts: `ravenseat tidy` (lib/tidy.js and cli/tidy.mjs), roadmap 1b.
//
// Why: tidy deletes folders and branches, which cannot be undone. Each rule that keeps something has its own test
// here, against temporary repos under the OS temp folder (never the real project): dirty, not merged, locked and
// active-task worktrees stay, also with --yes; a junction's target is never followed; a folder with another link inside
// is skipped and named; no terminal and no --yes deletes nothing; only `git branch -d`, so an unmerged branch stays;
// the main checkout is never touched.
// On Windows the links are junctions (cmd /c mklink /J), elsewhere directory symlinks: the same rule, the link kind the
// platform has.
// =============================================================
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const T = require('../tidy.js');

const QUEUE = path.resolve(__dirname, '..', '..', 'queue.mjs');
const WIN = process.platform === 'win32';
const temporary: string[] = [];
afterAll(() => {
  // Links first, as links (never a recursive delete through a junction), then the folders.
  for (const m of temporary) {
    try {
      const stack = [m];
      while (stack.length) {
        const d = stack.pop() as string;
        for (const n of fs.readdirSync(d)) {
          const p = path.join(d, n);
          const st = fs.lstatSync(p);
          if (st.isSymbolicLink()) T.removeLinkOnly(p);
          else if (st.isDirectory()) stack.push(p);
        }
      }
      fs.rmSync(m, { recursive: true, force: true });
    } catch {
      // best effort in the temp folder
    }
  }
});

/** A link to a folder: a junction on Windows (as prepare-track makes), a directory symlink elsewhere. */
function link(at: string, target: string) {
  if (WIN) execFileSync('cmd', ['/c', 'mklink', '/J', at, target], { stdio: 'pipe' });
  else fs.symlinkSync(target, at, 'dir');
}

/** A temporary project: a repo on main with one commit, a data folder, a config, and a folder for worktrees. */
function project() {
  const top = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ravenseat-tidy-')));
  temporary.push(top);
  const root = path.join(top, 'repo');
  fs.mkdirSync(root);
  const g = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: root, stdio: 'pipe', encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(root, 'README.md'), 'x\n');
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules\ndata/\n');
  g('add', 'README.md', '.gitignore');
  g('commit', '-q', '-m', 'start');
  // The shared folder the worktrees link to, as the main tree's node_modules, with a sentinel file.
  const shared = path.join(root, 'node_modules');
  fs.mkdirSync(shared);
  fs.writeFileSync(path.join(shared, 'sentinel.txt'), 'keep me\n');
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, 'queue.json'), JSON.stringify({ tasks: [], projects: {} }));
  const configFile = path.join(root, 'queue.config.json');
  fs.writeFileSync(configFile, JSON.stringify({ baseBranch: 'main', tidy: { minAgeHours: 0 } }));
  const wts = path.join(top, 'tester');
  fs.mkdirSync(wts);

  /** A worktree on a new branch; merged: its commit is merged into main; withLink: a node_modules junction. */
  const worktree = (name: string, { merged = true, commit = true, withLink = true } = {}) => {
    const wt = path.join(wts, name);
    g('worktree', 'add', '-q', wt, '-b', name, 'main');
    const gw = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: wt, stdio: 'pipe' });
    if (commit) {
      fs.writeFileSync(path.join(wt, `${name}.txt`), `${name}\n`);
      gw('add', `${name}.txt`);
      gw('commit', '-q', '-m', name);
      if (merged) g('merge', '-q', '--no-ff', '-m', `merge ${name}`, name);
    }
    if (withLink) link(path.join(wt, 'node_modules'), shared);
    return wt;
  };
  const opts = (extra: object = {}) => ({ main: root, base: 'main', prefix: 'queue/', tasks: [], cwd: root, minAgeHours: 0, sharedLinks: ['node_modules'], dataFolder: data, ...extra });
  const env = { ...process.env, QUEUE_ROOT: root, QUEUE_FOLDER: data, QUEUE_CONFIG: configFile, QUEUE_GIT: root, QUEUE_TIME_LOG: path.join(data, 'times.jsonl') };
  const cli = (...args: string[]) => {
    const r = spawnSync(process.execPath, [QUEUE, 'tidy', ...args], { encoding: 'utf8', env, cwd: root, input: '' });
    return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  const branches = () => g('branch', '--format=%(refname:short)').split('\n').map((s) => s.trim()).filter(Boolean);
  return { top, root, g, wts, shared, data, worktree, opts, cli, branches };
}

describe('ravenseat tidy: what is never deleted', () => {
  it('dirty, not merged, locked and active-task worktrees stay; a merged, clean one goes', () => {
    const p = project();
    const gone = p.worktree('queue/done-1'.replace('/', '-'));
    const dirty = p.worktree('dirty-1');
    fs.writeFileSync(path.join(dirty, 'wip.txt'), 'not committed\n');
    const unmerged = p.worktree('unmerged-1', { merged: false });
    const locked = p.worktree('locked-1');
    p.g('worktree', 'lock', locked);
    const active = p.worktree('queue/A-1'.replace('/', '-'));
    const tasks = [{ id: 'A-1', status: 'running', branch: 'queue-A-1' }];

    const picture = T.scan(p.opts({ tasks }));
    const by = (wt: string) => picture.worktrees.find((w: { path: string }) => w.path.toLowerCase() === wt.toLowerCase());
    expect(by(gone).removable).toBe(true);
    expect(by(dirty).reason).toMatch(/uncommitted/);
    expect(by(unmerged).reason).toBe('not merged');
    expect(by(locked).reason).toBe('locked');
    expect(by(active).reason).toMatch(/active task A-1/);

    const r = T.execute(p.opts({ tasks }));
    expect(fs.existsSync(gone)).toBe(false);
    for (const wt of [dirty, unmerged, locked, active]) expect(fs.existsSync(wt), wt).toBe(true);
    expect(fs.existsSync(path.join(dirty, 'wip.txt'))).toBe(true);
    expect(r.skipped.map((s: { reason: string }) => s.reason).join(' | ')).toMatch(/not merged/);
  });

  it('the same rules hold through the command with --yes', () => {
    const p = project();
    const gone = p.worktree('merged-2');
    const dirty = p.worktree('dirty-2');
    fs.writeFileSync(path.join(dirty, 'wip.txt'), 'x\n');
    const unmerged = p.worktree('unmerged-2', { merged: false });
    const locked = p.worktree('locked-2');
    p.g('worktree', 'lock', locked);
    const r = p.cli('--execute', '--yes');
    expect(r.code, r.out).toBe(0);
    expect(fs.existsSync(gone), r.out).toBe(false);
    for (const wt of [dirty, unmerged, locked]) expect(fs.existsSync(wt), `${wt}\n${r.out}`).toBe(true);
    expect(r.out).toMatch(/Removed/);
    expect(r.out).toMatch(/not merged/);
  });

  it('a junction target is never followed: the sentinel in the shared folder survives', () => {
    const p = project();
    const wt = p.worktree('linked-3');
    expect(fs.existsSync(path.join(wt, 'node_modules', 'sentinel.txt'))).toBe(true);
    const r = T.execute(p.opts());
    expect(r.stopped).toBeNull();
    expect(fs.existsSync(wt)).toBe(false);
    expect(fs.readFileSync(path.join(p.shared, 'sentinel.txt'), 'utf8')).toBe('keep me\n');
  });

  it('a folder with another link inside is skipped, named, and left as it was', () => {
    const p = project();
    const wt = p.worktree('extra-4');
    const outside = path.join(p.top, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'other-sentinel.txt'), 'x\n');
    // Under data/ (ignored), so the worktree is clean and only the link can stop it.
    fs.mkdirSync(path.join(wt, 'data'));
    link(path.join(wt, 'data', 'other'), outside);
    const r = T.execute(p.opts());
    const s = r.skipped.find((x: { name: string }) => x.name.includes('extra-4'));
    expect(s?.reason).toMatch(/another link inside: data\/other/);
    expect(fs.existsSync(wt)).toBe(true);
    // Left exactly as it was: its node_modules link is still there too.
    expect(fs.lstatSync(path.join(wt, 'node_modules')).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(outside, 'other-sentinel.txt'))).toBe(true);
    expect(p.branches()).toContain('extra-4');
  });

  it('no terminal and no --yes: nothing is deleted, and it says so', () => {
    const p = project();
    const wt = p.worktree('merged-5');
    p.g('branch', 'queue/M-5');
    const r = p.cli('--execute');
    expect(r.out).toMatch(/Nothing was deleted/);
    expect(fs.existsSync(wt)).toBe(true);
    expect(p.branches()).toEqual(expect.arrayContaining(['merged-5', 'queue/M-5']));
  });

  it('only git branch -d: an unmerged queue branch stays, a merged one with no worktree goes', () => {
    const p = project();
    p.g('branch', 'queue/M-6');
    p.g('checkout', '-q', '-b', 'queue/U-6');
    fs.writeFileSync(path.join(p.root, 'u6.txt'), 'x\n');
    p.g('add', 'u6.txt');
    p.g('commit', '-q', '-m', 'u6');
    p.g('checkout', '-q', 'main');
    const picture = T.scan(p.opts());
    expect(picture.branches.map((b: { name: string }) => b.name)).toEqual(['queue/M-6']);
    T.execute(p.opts());
    const left = p.branches();
    expect(left).not.toContain('queue/M-6');
    expect(left).toContain('queue/U-6');
    expect(left).toContain('main');
  });

  it('a branch of an active task with no worktree stays', () => {
    const p = project();
    p.g('branch', 'queue/C-7');
    T.execute(p.opts({ tasks: [{ id: 'C-7', status: 'review' }] }));
    expect(p.branches()).toContain('queue/C-7');
  });

  it('the main checkout and the worktree the command runs in are never touched', () => {
    const p = project();
    const here = p.worktree('here-8');
    const before = fs.readdirSync(p.root).sort();
    const picture = T.scan(p.opts({ cwd: here }));
    expect(picture.worktrees[0].isMain).toBe(true);
    expect(picture.worktrees[0].removable).toBe(false);
    const w = picture.worktrees.find((x: { path: string }) => x.path.toLowerCase() === here.toLowerCase());
    expect(w.reason).toBe('the command runs in it');
    T.execute(p.opts({ cwd: here }));
    expect(fs.existsSync(here)).toBe(true);
    expect(fs.readdirSync(p.root).sort()).toEqual(before);
    expect(fs.readFileSync(path.join(p.shared, 'sentinel.txt'), 'utf8')).toBe('keep me\n');
    expect(p.branches()).toContain('main');
  });

  it('a fresh worktree below tidy.minAgeHours stays (no commits yet looks merged)', () => {
    const p = project();
    const fresh = p.worktree('fresh-9', { commit: false });
    const picture = T.scan(p.opts({ minAgeHours: 3 }));
    const w = picture.worktrees.find((x: { path: string }) => x.path.toLowerCase() === fresh.toLowerCase());
    expect(w.merged).toBe(true);
    expect(w.reason).toMatch(/changed recently/);
  });
});

describe('ravenseat tidy: listing, demo folders and the doctor text', () => {
  it('the read-only list removes nothing and gives counts and sizes per group', () => {
    const p = project();
    const wt = p.worktree('merged-10');
    const demo = path.join(p.wts, 'board-demo');
    fs.mkdirSync(demo);
    fs.writeFileSync(path.join(demo, 'a.txt'), 'x'.repeat(2048));
    const r = p.cli();
    expect(r.code, r.out).toBe(0);
    expect(fs.existsSync(wt)).toBe(true);
    expect(fs.existsSync(demo)).toBe(true);
    expect(r.out).toMatch(/Worktrees that can be removed: 1/);
    expect(r.out).toMatch(/Demo folders: 1/);
    expect(r.out).toMatch(/Nothing was changed/);
  });

  it('demo folders are deleted only with --demo --execute', () => {
    const p = project();
    const wt = p.worktree('merged-11');
    // Demo folders are found next to the worktrees that are left, so one stays (not merged).
    p.worktree('unmerged-11', { merged: false });
    const demo = path.join(p.wts, 'x-shots');
    fs.mkdirSync(demo);
    T.execute(p.opts());
    expect(fs.existsSync(wt)).toBe(false);
    expect(fs.existsSync(demo)).toBe(true);
    const r = T.execute(p.opts({ demo: true }));
    expect(r.removed.map((x: { kind: string }) => x.kind)).toEqual(['demo folder']);
    expect(fs.existsSync(demo)).toBe(false);
  });

  it('GOS-1 is not built: clean-gate copies are only counted, never deleted', () => {
    const p = project();
    const copies = path.join(p.data, 'clean-gate', '123-abc');
    fs.mkdirSync(copies, { recursive: true });
    const picture = T.scan(p.opts());
    expect(picture.cleanCopies).toMatchObject({ built: false, count: 1 });
    T.execute(p.opts());
    expect(fs.existsSync(copies)).toBe(true);
  });

  it('the doctor text is null with nothing to remove, and names the command otherwise', () => {
    expect(T.doctorText({ worktrees: 0, branches: 0 })).toBeNull();
    const d = T.doctorText({ worktrees: 2, worktreeBytes: 3 * 1024 * 1024, branches: 1 });
    expect(d.message).toBe('2 merged, clean worktree(s) (3.0 MB) and 1 merged branch(es) with no worktree can be removed');
    expect(d.fix).toMatch(/ravenseat tidy --execute/);
  });

  it('doctor shows one INFO row with the count, and none with tidy.doctor false', () => {
    const p = project();
    p.worktree('merged-12');
    const doctor = () => {
      const r = spawnSync(process.execPath, [QUEUE, 'doctor', '--json'], {
        encoding: 'utf8',
        cwd: p.root,
        env: { ...process.env, QUEUE_ROOT: p.root, QUEUE_FOLDER: p.data, QUEUE_CONFIG: path.join(p.root, 'queue.config.json'), QUEUE_GIT: p.root, QUEUE_TIME_LOG: path.join(p.data, 'times.jsonl'), QUEUE_TRANSCRIPTS: path.join(p.data, 'transcripts') },
      });
      return (JSON.parse(r.stdout).checks as { status: string; name: string; message: string }[]).filter((c) => c.name === 'tidy');
    };
    const rows = doctor();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('INFO');
    expect(rows[0].message).toMatch(/^1 merged, clean worktree\(s\)/);
    fs.writeFileSync(path.join(p.root, 'queue.config.json'), JSON.stringify({ baseBranch: 'main', tidy: { minAgeHours: 0, doctor: false } }));
    expect(doctor()).toHaveLength(0);
  });

  it('tidy.afterMerge removes only the merged branch\'s own worktree', () => {
    const p = project();
    const mine = p.worktree('queue-T-13');
    const other = p.worktree('other-13');
    const lines = T.tidyBranch('queue-T-13', p.opts());
    expect(lines.join('\n')).toMatch(/removed/);
    expect(fs.existsSync(mine)).toBe(false);
    expect(fs.existsSync(other)).toBe(true);
    expect(fs.readFileSync(path.join(p.shared, 'sentinel.txt'), 'utf8')).toBe('keep me\n');
  });

  it('parses git worktree list --porcelain', () => {
    const list = T.parseWorktrees(
      'worktree C:/r\nHEAD abc\nbranch refs/heads/main\n\nworktree C:/t/x\nHEAD def\nbranch refs/heads/x\nlocked reason\n\nworktree C:/t/y\nHEAD 123\ndetached\nprunable gitdir file points to non-existent location\n',
    );
    expect(list.map((w: { branch: string | null }) => w.branch)).toEqual(['main', 'x', null]);
    expect(list[1].locked).toBe(true);
    expect(list[2]).toMatchObject({ detached: true, prunable: true });
  });
});
