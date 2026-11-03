// =============================================================
// gateCoverage.test.ts: what a gate run could see beyond the commit (lib/gateCoverage.js), and how an entry says it
// (lib/gateEvidence.js coverage, coverageLine: the functions the receive line uses and a board panel would use).
//
// Locks: (1) the path parse and the count leave the links out; (2) git that fails gives an unknown count, never a zero;
// (3) an entry gets runner and the coverage fields, and entries from before them stay readable with no phrase; (4) the
// phrase says where the run happened, leaves zeros out and names shared links; (5) recordRun with a reason from the caller:
// red, tampered and named, the store kept; together with a changed store both are named.
// =============================================================
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as GC from '../gateCoverage';
import * as GE from '../gateEvidence';

const A = 'a'.repeat(40);
const temporary: string[] = [];
afterAll(() => {
  for (const m of temporary) fs.rmSync(m, { recursive: true, force: true });
});
const folder = () => {
  const f = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-coverage-'));
  temporary.push(f);
  return f;
};

describe('the counts', () => {
  it('splits NUL-separated paths, drops the trailing slash of a collapsed folder, and leaves the links out', () => {
    expect(GC.splitPaths('a.txt\0dist/\0sub\\b.txt\0')).toEqual(['a.txt', 'dist', 'sub/b.txt']);
    expect(GC.splitPaths('')).toEqual([]);
    expect(GC.splitPaths(null)).toEqual([]);
    expect(GC.countOutside(['a', 'node_modules', 'web/node_modules'], ['node_modules', 'web/node_modules'])).toBe(1);
  });

  it('readCoverage: a git that fails gives an unknown count, not a zero', () => {
    const top = folder();
    const c = GC.readCoverage({ top, links: [], git: () => null });
    expect(c).toEqual({ sharedLinks: [], untracked: null, ignoredPresent: null });
    const d = GC.readCoverage({ top, links: [], git: (...a: string[]) => (a.includes('--ignored') ? 'dist/\0' : 'x\0y\0') });
    expect(d).toEqual({ sharedLinks: [], untracked: 2, ignoredPresent: 1 });
  });

  it('lockHash takes the first lockfile there is, and null without one', () => {
    const f = folder();
    expect(GC.lockHash(f)).toBeNull();
    fs.writeFileSync(path.join(f, 'yarn.lock'), 'y');
    const yarn = GC.lockHash(f);
    expect(yarn).toMatch(/^[0-9a-f]{64}$/);
    fs.writeFileSync(path.join(f, 'package-lock.json'), 'p');
    expect(GC.lockHash(f)).not.toBe(yarn);
  });
});

describe('an entry says what it covered', () => {
  const entry = (coverage?: object, mainTree = false) =>
    GE.entry({ kind: 'quick', sha: A, clean: true, exit: 0, gates: ['t'], mainTree, coverage } as never) as Record<string, unknown>;

  it('every new entry has a runner; the counts when known', () => {
    expect(entry()).toMatchObject({ runner: 'local-worktree' });
    expect(entry()).not.toHaveProperty('untracked');
    expect(entry()).not.toHaveProperty('shared_links');
    expect(entry({ sharedLinks: [], untracked: null, ignoredPresent: null })).not.toHaveProperty('untracked');
    expect(entry({ sharedLinks: [{ path: 'node_modules' }], untracked: 2, ignoredPresent: 0 })).toMatchObject({
      shared_links: [{ path: 'node_modules' }],
      untracked: 2,
      ignored_present: 0,
    });
  });

  it('an entry from before these fields stays readable and has no phrase', () => {
    const legacy = { time: 't', by: 'gates.mjs', sha: A, kind: 'quick', ok: true, exit: 0, clean: true, gates: ['t'], failed: [] };
    expect(GE.coverage(legacy)).toBeNull();
    expect(GE.coverageLine(legacy)).toBe('');
    expect(GE.coverageLine(null)).toBe('');
    expect(GE.latest([legacy], { sha: A, commands: ['t'] })).toEqual(legacy);
  });

  it('the data a reader gets, and the phrase', () => {
    const e = entry({ sharedLinks: [{ path: 'node_modules', lock_hash: 'h', target_lock_hash: 'i' }], untracked: 3, ignoredPresent: 1 });
    expect(GE.coverage(e)).toEqual({
      runner: 'local-worktree',
      mainTree: false,
      sharedLinks: [{ path: 'node_modules', lockHash: 'h', lockDiffers: true }],
      untracked: 3,
      ignored: 1,
    });
    expect(GE.coverageLine(e)).toBe("ran locally in the track's worktree, 3 untracked, 1 ignored, shared node_modules (its lockfile differs from the commit's)");
    expect(GE.coverageLine(entry({ sharedLinks: [], untracked: 0, ignoredPresent: 0 }))).toBe("ran locally in the track's worktree");
    expect(GE.coverageLine(entry({ sharedLinks: [], untracked: 1, ignoredPresent: 0 }, true))).toBe('ran locally in the main checkout, 1 untracked');
    // A later runner reads as itself, never as local.
    expect(GE.coverageLine({ ...entry(), runner: 'sandbox' })).toBe('ran in sandbox');
  });
});

describe('recordRun with a reason from the caller', () => {
  const e = () => GE.entry({ kind: 'quick', sha: A, clean: true, exit: 0, gates: ['t'], time: 'run' } as never);

  it('makes the entry red and names it, without touching the store around it', () => {
    const file = path.join(folder(), 'gate-evidence.json');
    GE.writeStore(file, { version: 1, entries: [{ time: 'old', sha: A }] });
    const before = GE.readStoreText(file);
    expect(GE.recordRun({ file, before, entry: e(), tamperReason: 'hook added: x' })).toEqual({ recorded: true, tampered: true, reason: 'hook added: x' });
    const entries = GE.readStore(file).entries;
    expect(entries.map((x: Record<string, unknown>) => x.time)).toEqual(['old', 'run']);
    expect(entries.at(-1)).toMatchObject({ ok: false, exit: 0, tampered: true, tamper_reason: 'hook added: x' });
  });

  it('with a changed store too: the store goes back and both are named', () => {
    const file = path.join(folder(), 'gate-evidence.json');
    GE.writeStore(file, { version: 1, entries: [{ time: 'old', sha: A }] });
    const before = GE.readStoreText(file);
    GE.writeStore(file, { version: 1, entries: [{ time: 'forged', sha: A }] });
    const r = GE.recordRun({ file, before, entry: e(), tamperReason: 'hook added: x' });
    expect(r).toMatchObject({ recorded: true, tampered: true });
    expect(r.reason).toContain('the evidence store changed');
    expect(r.reason).toContain('hook added: x');
    expect(GE.readStore(file).entries.map((x: Record<string, unknown>) => x.time)).toEqual(['old', 'run']);
  });

  it('a changed store alone keeps its result and names itself in the entry', () => {
    const file = path.join(folder(), 'gate-evidence.json');
    const before = GE.readStoreText(file);
    GE.writeStore(file, { version: 1, entries: [{ time: 'forged', sha: A }] });
    expect(GE.recordRun({ file, before, entry: e() })).toEqual({ recorded: true, tampered: true });
    expect(GE.readStore(file).entries.at(-1)).toMatchObject({ tampered: true, tamper_reason: 'the evidence store changed during the run' });
  });
});
