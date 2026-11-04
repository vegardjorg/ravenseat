// Unit test for the decision in cleanup-worktree.mjs (vitest; the include pattern covers .test.mjs).
// Only the pure functions are tested here; the cleanup itself has been shown with a real merge.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';

import {
  isUnder,
  fingerprint,
  shouldCleanUp,
  removeLinkOnly,
  removeFolderTree,
} from '../cleanup-worktree.mjs';

const ok = {
  underWorktreesFolder: true,
  locked: false,
  isCurrentDirectory: false,
  merged: true,
  forNew: false,
  dirty: 0,
  realLinkFolder: null,
};

test('everything in order: clean up', () => {
  expect(shouldCleanUp(ok)).toEqual({ cleanup: true, reason: 'merged, clean and unlocked' });
});

test('a locked worktree is never cleaned up', () => {
  const r = shouldCleanUp({ ...ok, locked: true });
  expect(r.cleanup).toBe(false);
  expect(r.reason).toBe('locked');
});

test('a dirty worktree is not cleaned up (count and boolean)', () => {
  expect(shouldCleanUp({ ...ok, dirty: 3 }).cleanup).toBe(false);
  expect(shouldCleanUp({ ...ok, dirty: 3 }).reason).toMatch(/uncommitted changes \(3\)/);
  expect(shouldCleanUp({ ...ok, dirty: true }).cleanup).toBe(false);
  expect(shouldCleanUp({ ...ok, dirty: false }).cleanup).toBe(true);
});

test('unknown git status (negative or missing) does not count as clean', () => {
  expect(shouldCleanUp({ ...ok, dirty: -1 }).cleanup).toBe(false);
  expect(shouldCleanUp({ ...ok, dirty: undefined }).cleanup).toBe(false);
});

test('not merged: not cleaned up', () => {
  const r = shouldCleanUp({ ...ok, merged: false });
  expect(r.cleanup).toBe(false);
  expect(r.reason).toBe('not merged');
});

test('the current directory is not cleaned up', () => {
  const r = shouldCleanUp({ ...ok, isCurrentDirectory: true });
  expect(r.cleanup).toBe(false);
  expect(r.reason).toBe('is the current directory');
});

test('a real node_modules folder (not a link) stops the cleanup', () => {
  const r = shouldCleanUp({ ...ok, realLinkFolder: 'node_modules' });
  expect(r.cleanup).toBe(false);
  expect(r.reason).toBe('node_modules is not a link');
});

test('outside .claude/worktrees/ is never cleaned up, and that check comes before everything else', () => {
  const r = shouldCleanUp({ ...ok, underWorktreesFolder: false, locked: true });
  expect(r.cleanup).toBe(false);
  expect(r.reason).toBe('not under .claude/worktrees/');
});

test('recently changed (below the minimum age) is not cleaned up', () => {
  expect(shouldCleanUp({ ...ok, forNew: true }).cleanup).toBe(false);
});

test('locked comes before dirty (cheap reason first)', () => {
  expect(shouldCleanUp({ ...ok, locked: true, dirty: 5 }).reason).toBe('locked');
});

test('isUnder: only paths INSIDE the root, never the root itself or a neighbor with the same prefix', () => {
  const root = path.resolve('/x/example/.claude/worktrees');
  expect(isUnder(path.join(root, 'agent-a'), root)).toBe(true);
  expect(isUnder(root, root)).toBe(false);
  expect(isUnder(path.resolve('/x/example/.claude/worktrees-other/agent-a'), root)).toBe(false);
  expect(isUnder(path.resolve('/x/example'), root)).toBe(false);
});


test('fingerprint counts the entries in each shared folder, -1 when it is missing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-fp-'));
  try {
    fs.mkdirSync(path.join(root, 'node_modules', 'a'), { recursive: true });
    fs.mkdirSync(path.join(root, 'node_modules', 'b'), { recursive: true });
    expect(fingerprint(root, ['node_modules', 'web/node_modules'])).toEqual({
      node_modules: 2,
      'web/node_modules': -1,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---- Deleting paths with shell characters (review 2026-11-02, section 4: "folder with & in the path") ----
// `cmd /c rmdir /s /q C:\dev\R&D\...` without quotes splits at `&` and deletes C:\dev\R. The cleanup now uses fs
// (removeLinkOnly, removeFolderTree) with no shell at all. Proven in a temp folder: a sibling "R" that a split command would
// hit, and a link target outside the worktree, both survive.

function shellTrap(name) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cq-rm-'));
  const victim = path.join(base, 'R'); // what `rmdir /s /q <base>\R&D...` would delete after the split
  fs.mkdirSync(victim);
  fs.writeFileSync(path.join(victim, 'keep.txt'), 'keep');
  const target = path.join(base, 'target'); // the main tree's shared folder
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'shared.txt'), 'shared');
  const wt = path.join(base, name, 'wt');
  fs.mkdirSync(path.join(wt, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(wt, 'sub', 'f.txt'), 'x');
  const link = path.join(wt, 'node_modules');
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  return { base, victim, target, wt, link };
}

for (const name of ['R&D', 'R&D app æøå (x) 100%', 'a^b!c']) {
  test(`removeLinkOnly and removeFolderTree are safe with "${name}" in the path`, () => {
    const t = shellTrap(name);
    try {
      removeLinkOnly(t.link);
      expect(fs.existsSync(t.link)).toBe(false);
      expect(fs.readFileSync(path.join(t.target, 'shared.txt'), 'utf8')).toBe('shared');
      removeFolderTree(t.wt);
      expect(fs.existsSync(t.wt)).toBe(false);
      expect(fs.readFileSync(path.join(t.victim, 'keep.txt'), 'utf8')).toBe('keep');
      expect(fs.readFileSync(path.join(t.target, 'shared.txt'), 'utf8')).toBe('shared');
    } finally {
      fs.rmSync(t.base, { recursive: true, force: true });
    }
  });
}

test('removeFolderTree removes a link inside the tree as a link and never empties its target', () => {
  const t = shellTrap('R&D');
  try {
    removeFolderTree(t.wt); // the link is still there (deleteRest only runs when no link points out, this is the fallback)
    expect(fs.existsSync(t.wt)).toBe(false);
    expect(fs.readFileSync(path.join(t.target, 'shared.txt'), 'utf8')).toBe('shared');
  } finally {
    fs.rmSync(t.base, { recursive: true, force: true });
  }
});

test('removeLinkOnly refuses a real folder (never a recursive delete)', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cq-rm-'));
  try {
    const real = path.join(base, 'R&D', 'node_modules');
    fs.mkdirSync(real, { recursive: true });
    fs.writeFileSync(path.join(real, 'a.txt'), 'a');
    expect(() => removeLinkOnly(real)).toThrow();
    expect(fs.readFileSync(path.join(real, 'a.txt'), 'utf8')).toBe('a');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('isUnder sees through another spelling of the same folder (a link here, a short 8.3 path on a Windows runner)', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-alias-'));
  try {
    const real = path.join(base, 'real');
    const worktree = path.join(real, '.claude', 'worktrees', 'a');
    fs.mkdirSync(worktree, { recursive: true });
    const alias = path.join(base, 'alias');
    fs.symlinkSync(real, alias, 'junction');
    expect(isUnder(worktree, path.join(alias, '.claude', 'worktrees'))).toBe(true);
    expect(isUnder(path.join(base, 'other'), path.join(alias, '.claude', 'worktrees'))).toBe(false);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
