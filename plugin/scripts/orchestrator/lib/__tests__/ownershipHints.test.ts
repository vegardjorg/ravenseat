// =============================================================
// ownershipHints.test.ts: better ownership from the start (lib/ownershipHints.js). A merged task keeps the files it
// actually changed (changed_files, set by `merge`); `add` compares a new task's owned_files with that history and names
// the files earlier tasks changed together with them, so the owner can add them before the track starts instead of
// meeting them as an ownership stop at merge.
// =============================================================
import { describe, expect, it } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const OH = require('../ownershipHints.js') as {
  MAX_CHANGED: number;
  changedFilesOf: (names: string[]) => string[];
  coChangeHints: (
    o: Record<string, unknown>,
    tasks: Record<string, unknown>[],
  ) => { file: string; seen: number; of: number }[];
  hintLines: (o: Record<string, unknown>, tasks: Record<string, unknown>[]) => string[];
};

const done = (id: string, changed: string[]) => ({ id, status: 'done', changed_files: changed });

describe('changedFilesOf: what merge stores', () => {
  it('normalizes, removes duplicates and caps the list', () => {
    expect(OH.changedFilesOf(['a\\b.ts', './c.ts', 'a/b.ts', ''])).toEqual(['a/b.ts', 'c.ts']);
    const many = Array.from({ length: OH.MAX_CHANGED + 50 }, (_, i) => `f${i}.ts`);
    expect(OH.changedFilesOf(many)).toHaveLength(OH.MAX_CHANGED);
  });
});

describe('coChangeHints: files earlier tasks changed together with this task\'s files', () => {
  const history = [
    done('H1', ['src/route.ts', 'src/route.test.ts', 'docs/routes.md']),
    done('H2', ['src/route.ts', 'src/route.test.ts']),
    done('H3', ['src/route.ts', 'src/route.test.ts', 'other.ts']),
    done('H4', ['unrelated.ts', 'src/route.test.ts']),
    { id: 'H5', status: 'cancelled', changed_files: ['src/route.ts', 'never.ts'] },
    { id: 'H6', status: 'done' },
  ];

  it('names a file changed in at least two of the matching tasks and at least half of them', () => {
    const o = { id: 'NEW', owned_files: ['src/route.ts'] };
    expect(OH.coChangeHints(o, history)).toEqual([{ file: 'src/route.test.ts', seen: 3, of: 3 }]);
  });

  it('leaves out files the task owns already, also through a folder', () => {
    expect(OH.coChangeHints({ id: 'NEW', owned_files: ['src/'] }, history)).toEqual([]);
    expect(OH.coChangeHints({ id: 'NEW', owned_files: ['src/route.ts', 'src/route.test.ts'] }, history)).toEqual([]);
  });

  it('needs two matching tasks, and says nothing without owned_files or history', () => {
    expect(OH.coChangeHints({ id: 'NEW', owned_files: ['unrelated.ts'] }, history)).toEqual([]);
    expect(OH.coChangeHints({ id: 'NEW', owned_files: [] }, history)).toEqual([]);
    expect(OH.coChangeHints({ id: 'NEW', owned_files: ['src/route.ts'] }, [])).toEqual([]);
  });

  it('gives one readable line per task, with at most five files', () => {
    const wide = [1, 2, 3].map((i) => done(`W${i}`, ['core.ts', 'a1.ts', 'a2.ts', 'a3.ts', 'a4.ts', 'a5.ts', 'a6.ts']));
    const lines = OH.hintLines({ id: 'NEW', owned_files: ['core.ts'] }, wide);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^OWNERSHIP HINT NEW: /);
    expect(lines[0]).toContain('a1.ts (3 of 3)');
    expect(lines[0]).toContain('and 1 more');
    expect(lines[0]).toContain('ravenseat edit NEW --files');
    expect(OH.hintLines({ id: 'NEW', owned_files: ['x.ts'] }, wide)).toEqual([]);
  });
});
