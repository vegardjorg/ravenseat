// =============================================================
// lockfiles.test.ts: a tracked manifest without a tracked lockfile (lib/lockfiles.js).
//
// Why: one rule feeds both doctor's lockfile row and the Checks card lockfile-in-git, so the two never disagree.
// =============================================================
import { describe, expect, it } from 'vitest';

import { hasManifest, lockGaps } from '../lockfiles';

describe('lockGaps', () => {
  it('names a tracked manifest with no tracked lockfile, and the lockfile that is only on disk', () => {
    expect(lockGaps(['package.json', 'src/a.ts'], (f) => f === 'package-lock.json')).toEqual([
      expect.objectContaining({ manifest: 'package.json', local: 'package-lock.json' }),
    ]);
    expect(lockGaps(new Set(['Cargo.toml']))).toEqual([expect.objectContaining({ manifest: 'Cargo.toml', local: null })]);
  });

  it('any one lockfile is enough, and no manifest means no gap', () => {
    expect(lockGaps(['package.json', 'pnpm-lock.yaml', 'go.mod', 'go.sum'])).toEqual([]);
    expect(lockGaps(['README.md'])).toEqual([]);
    expect(hasManifest(['README.md'])).toBe(false);
    expect(hasManifest(['pyproject.toml'])).toBe(true);
  });
});
