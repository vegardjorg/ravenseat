// =============================================================
// gateClean.test.ts: the rules for a full gate in a clean copy of the exact commit (lib/gateClean.js, gates.runner).
//
// Locks: the settings and their defaults (worktree, link, worktree copy, no include, kinds full, keepOnRed off, sweep
// after 1 h); which runs are which kind (a track's own run is never clean); the include list refuses absolute paths, ..,
// .git and secret files; the evidence line and the hint; and the cleanup: a dependency link is removed BEFORE the folder,
// so the link's target survives, a link pointing out of the copy keeps the folder, and the sweep removes only our own
// names whose process is gone and that are old enough.
// The whole flow with the real gates.mjs is in __tests__/gateCleanFlow.test.ts.
// =============================================================
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const GC = require('../gateClean.js');
const GE = require('../gateEvidence.js');

const made: string[] = [];
const tmp = (prefix = 'gate-clean-unit-') => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(d);
  return d;
};
afterAll(() => {
  for (const d of made) {
    try {
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* left for the OS */
    }
  }
});
const linkType = process.platform === 'win32' ? 'junction' : 'dir';

describe('setup', () => {
  it('defaults: worktree runner, linked dependencies, a worktree copy, nothing included, only the full kind', () => {
    expect(GC.setup({})).toEqual({
      runner: 'worktree',
      dependencies: 'link',
      copy: 'worktree',
      include: [],
      kinds: ['full'],
      keepOnRed: false,
      sweepAfterHours: 1,
    });
  });

  it('reads the set values and falls back to the default for a value it does not know', () => {
    const s = GC.setup({
      gates: { runner: 'clean', clean: { dependencies: 'install', copy: 'archive', kinds: ['full', 'push', 'bogus'], keepOnRed: true, sweepAfterHours: 3 } },
    });
    expect(s).toMatchObject({ runner: 'clean', dependencies: 'install', copy: 'archive', kinds: ['full', 'push'], keepOnRed: true, sweepAfterHours: 3 });
    expect(GC.setup({ gates: { runner: 'sandbox', clean: { dependencies: 'x', copy: 'y', sweepAfterHours: -1 } } })).toMatchObject({
      runner: 'worktree',
      dependencies: 'link',
      copy: 'worktree',
      sweepAfterHours: 1,
    });
  });

  it('names a wrong value for the doctor', () => {
    expect(GC.problems({})).toEqual([]);
    const p = GC.problems({ gates: { runner: 'sandbox', clean: { dependencies: 'x', kinds: ['quick'], include: ['/etc/passwd'], sweepAfterHours: 0 } } });
    expect(p.join('\n')).toMatch(/gates\.runner/);
    expect(p.join('\n')).toMatch(/gates\.clean\.dependencies/);
    expect(p.join('\n')).toMatch(/gates\.clean\.kinds/);
    expect(p.join('\n')).toMatch(/gates\.clean\.include/);
    expect(p.join('\n')).toMatch(/gates\.clean\.sweepAfterHours/);
  });
});

describe('runKind and decide', () => {
  it('a track\'s own run is never a kind; receive\'s run on the delivered tip is full; the merge commit is base; the main checkout\'s full run is push', () => {
    expect(GC.runKind({ mode: 'quick', mainTree: false, evidence: false })).toBe(null);
    expect(GC.runKind({ mode: 'full', mainTree: false, evidence: false })).toBe(null);
    expect(GC.runKind({ mode: 'quick', mainTree: false, evidence: true })).toBe('full');
    expect(GC.runKind({ mode: 'full', mainTree: false, evidence: true })).toBe('full');
    expect(GC.runKind({ mode: 'quick', mainTree: true, evidence: true })).toBe('base');
    expect(GC.runKind({ mode: 'full', mainTree: true, evidence: false })).toBe('push');
    expect(GC.runKind({ mode: 'quick', mainTree: true, evidence: false })).toBe(null);
  });

  it('clean only with the runner on and the kind listed, or with --clean', () => {
    const off = GC.setup({});
    const on = GC.setup({ gates: { runner: 'clean' } });
    expect(GC.decide({ setup: off, kind: 'full', forced: false }).clean).toBe(false);
    expect(GC.decide({ setup: on, kind: 'full', forced: false }).clean).toBe(true);
    expect(GC.decide({ setup: on, kind: 'push', forced: false }).clean).toBe(false);
    expect(GC.decide({ setup: on, kind: null, forced: false }).clean).toBe(false);
    expect(GC.decide({ setup: off, kind: null, forced: true })).toMatchObject({ clean: true, source: '--clean' });
  });
});

describe('the include list', () => {
  it('keeps plain relative paths and refuses absolute ones, .., .git and secret files', () => {
    const r = GC.includeList(['.env.test', 'config/local.json', '/abs', 'C:\\x', '../up', '.git/config', '.npmrc', 'keys/server.pem', '.env', '.env.local', 'id_rsa', 7]);
    expect(r.accepted).toEqual(['.env.test', 'config/local.json']);
    expect(r.refused.map((x: { path: unknown }) => x.path)).toEqual(['/abs', 'C:\\x', '../up', '.git/config', '.npmrc', 'keys/server.pem', '.env', '.env.local', 'id_rsa', 7]);
  });
});

describe('the evidence line and the hint', () => {
  const base = { kind: 'full', sha: 'a'.repeat(40), setupHash: 'h', clean: true, exit: 0, gates: ['npm test'], failed: [], mainTree: false };

  it('a clean run says which runner ran and how the dependencies came in', () => {
    const e = GE.entry({ ...base, runner: 'clean', cleanCopy: { copy: 'worktree', dependencies: 'link' }, coverage: { sharedLinks: [], untracked: 0, ignoredPresent: 0 } });
    expect(e.runner).toBe(GE.RUNNER_CLEAN);
    expect(e.clean_copy).toEqual({ copy: 'worktree', dependencies: 'link' });
    expect(GE.coverageLine(e)).toBe(`ran in a clean copy of ${'a'.repeat(12)}, dependencies linked`);
    const i = GE.entry({ ...base, runner: 'clean', cleanCopy: { copy: 'archive', dependencies: 'install' } });
    expect(GE.coverageLine(i)).toBe(`ran in a clean copy of ${'a'.repeat(12)}, dependencies installed`);
    expect(GC.hint(e, GC.setup({}))).toBe(null);
  });

  it('a worktree run with ignored files or a differing lockfile gets the one hint line, but not when clean is already on', () => {
    const ignored = GE.entry({ ...base, coverage: { sharedLinks: [], untracked: 0, ignoredPresent: 2 } });
    const lock = GE.entry({ ...base, coverage: { sharedLinks: [{ path: 'node_modules', lock_hash: 'x', target_lock_hash: 'y' }], untracked: 0, ignoredPresent: 0 } });
    const plain = GE.entry({ ...base, coverage: { sharedLinks: [{ path: 'node_modules', lock_hash: 'x' }], untracked: 3, ignoredPresent: 0 } });
    expect(GC.hint(ignored, GC.setup({}))).toBe(GC.HINT);
    expect(GC.hint(lock, GC.setup({}))).toBe(GC.HINT);
    expect(GC.hint(plain, GC.setup({}))).toBe(null);
    expect(GC.hint(ignored, GC.setup({ gates: { runner: 'clean' } }))).toBe(null);
    expect(GC.HINT).toContain('`gates.runner clean` would run the full gate on the exact commit');
  });
});

describe('dependencies', () => {
  it('link never installs, install always, auto only when the lockfile differs from the linked folder\'s', () => {
    expect(GC.wantsInstall({ dependencies: 'link', copyLock: 'a', linkedLock: 'b' })).toBe(false);
    expect(GC.wantsInstall({ dependencies: 'install', copyLock: 'a', linkedLock: 'a' })).toBe(true);
    expect(GC.wantsInstall({ dependencies: 'auto', copyLock: 'a', linkedLock: 'a' })).toBe(false);
    expect(GC.wantsInstall({ dependencies: 'auto', copyLock: 'a', linkedLock: 'b' })).toBe(true);
    expect(GC.wantsInstall({ dependencies: 'auto', copyLock: null, linkedLock: 'b' })).toBe(false);
  });

  it('the install command follows the lockfile, and none without one', () => {
    const d = tmp();
    expect(GC.installCommand(d)).toBe(null);
    fs.writeFileSync(path.join(d, 'pnpm-lock.yaml'), '');
    expect(GC.installCommand(d)).toMatch(/^pnpm install --frozen-lockfile/);
    fs.writeFileSync(path.join(d, 'package-lock.json'), '{}');
    expect(GC.installCommand(d)).toMatch(/^npm ci/);
  });
});

describe('the copy name', () => {
  it('pid, the first 8 of the sha and a random part; only that shape is ours', () => {
    const n = GC.copyName({ pid: 4321, sha: 'abcdef0123456789' });
    expect(n).toMatch(/^4321-abcdef01-[0-9a-z]{6}$/);
    expect(GC.parseName(n)).toEqual({ pid: 4321, sha8: 'abcdef01' });
    expect(GC.parseName('logs')).toBe(null);
    expect(GC.parseName('4321-abcdef01')).toBe(null);
  });
});

/** A copy folder as gates.mjs makes it: a dependency link to a folder outside that must survive, and the meta file. */
function fakeCopy(base: string, { pid = 999999, extraLink = false } = {}) {
  const target = tmp('gate-clean-target-');
  fs.writeFileSync(path.join(target, 'keep.txt'), 'must survive');
  const name = GC.copyName({ pid, sha: 'abcdef0123456789' });
  const folder = path.join(base, name);
  fs.mkdirSync(path.join(folder, 'src'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'src', 'a.js'), 'x');
  fs.symlinkSync(target, path.join(folder, 'node_modules'), linkType);
  if (extraLink) fs.symlinkSync(target, path.join(folder, 'src', 'out'), linkType);
  GC.writeMeta(base, name, { pid, sha: 'abcdef0123456789', copy: 'archive', links: ['node_modules'] });
  return { target, folder, name };
}

describe('removeCopy', () => {
  it('removes the dependency link first: the link\'s target and its file survive, the copy is gone', () => {
    const base = tmp();
    const c = fakeCopy(base);
    const r = GC.removeCopy({ base, name: c.name, gitCwd: null });
    expect(r.removed).toBe(true);
    expect(fs.existsSync(c.folder)).toBe(false);
    expect(fs.readFileSync(path.join(c.target, 'keep.txt'), 'utf8')).toBe('must survive');
    expect(fs.existsSync(GC.metaFile(base, c.name))).toBe(false);
  });

  it('a link that points out of the copy and is not ours keeps the whole folder, and the target is untouched', () => {
    const base = tmp();
    const c = fakeCopy(base, { extraLink: true });
    const r = GC.removeCopy({ base, name: c.name, gitCwd: null });
    expect(r.removed).toBe(false);
    expect(r.reason).toMatch(/link/);
    expect(fs.existsSync(c.folder)).toBe(true);
    expect(fs.readFileSync(path.join(c.target, 'keep.txt'), 'utf8')).toBe('must survive');
  });

  it('a real folder where the dependency link should be is never deleted', () => {
    const base = tmp();
    const name = GC.copyName({ pid: 999999, sha: 'abcdef0123456789' });
    const folder = path.join(base, name);
    fs.mkdirSync(path.join(folder, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(folder, 'node_modules', 'x.txt'), 'x');
    GC.writeMeta(base, name, { pid: 999999, sha: 'abcdef0123456789', copy: 'archive', links: ['node_modules'] });
    const r = GC.removeCopy({ base, name, gitCwd: null });
    expect(r.removed).toBe(false);
    expect(r.reason).toMatch(/real folder/);
    expect(fs.existsSync(path.join(folder, 'node_modules', 'x.txt'))).toBe(true);
  });
});

describe('sweep', () => {
  it('removes only our own names whose process is gone and that are older than the limit, links first', () => {
    const base = tmp();
    const old = fakeCopy(base, { pid: 111 });
    const young = fakeCopy(base, { pid: 222 });
    const living = fakeCopy(base, { pid: 333 });
    fs.mkdirSync(path.join(base, 'not-ours'));
    const hourAgo = new Date(Date.now() - 2 * 3_600_000);
    for (const c of [old, living]) {
      fs.utimesSync(GC.metaFile(base, c.name), hourAgo, hourAgo);
      fs.utimesSync(c.folder, hourAgo, hourAgo);
    }
    const r = GC.sweep({ base, gitCwd: null, alive: (pid: number) => pid === 333, afterHours: 1 });
    expect(r.removed).toBe(1);
    expect(fs.existsSync(old.folder)).toBe(false);
    expect(fs.existsSync(young.folder)).toBe(true);
    expect(fs.existsSync(living.folder)).toBe(true);
    expect(fs.existsSync(path.join(base, 'not-ours'))).toBe(true);
    expect(fs.readFileSync(path.join(old.target, 'keep.txt'), 'utf8')).toBe('must survive');
  });

  it('a stale copy that cannot be removed is listed as kept, for the doctor', () => {
    const base = tmp();
    const c = fakeCopy(base, { pid: 111, extraLink: true });
    const hourAgo = new Date(Date.now() - 2 * 3_600_000);
    fs.utimesSync(GC.metaFile(base, c.name), hourAgo, hourAgo);
    fs.utimesSync(c.folder, hourAgo, hourAgo);
    const r = GC.sweep({ base, gitCwd: null, alive: () => false, afterHours: 1 });
    expect(r.removed).toBe(0);
    expect(r.kept.map((k: { name: string }) => k.name)).toEqual([c.name]);
    const line = GC.doctorLine(r, { cli: 'ravenseat' });
    expect(line.status).toBe('WARN');
    expect(line.message).toContain('1');
  });

  it('nothing there is a quiet OK', () => {
    expect(GC.doctorLine({ removed: 0, kept: [] }, { cli: 'ravenseat' }).status).toBe('OK');
  });
});
