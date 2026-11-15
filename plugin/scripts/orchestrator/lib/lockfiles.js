// =============================================================
// lockfiles.js: a dependency manifest in git without its lockfile in git.
//
// WHY: without a lockfile in git, every install (each agent's worktree, CI, a teammate) may pick newer versions than
// the ones that were tested, so a red run can come from a library that changed overnight. One rule, two readers: the
// doctor row `lockfile` (cli/doctorBaseline.mjs checkLockfile) and the Checks card lockfile-in-git (cli/checks.mjs,
// condition lockfile-missing), so the two never disagree.
//
//   LOCKS                              manifest -> the lockfiles that pin it (any one is enough). Root only.
//   lockGaps(tracked, existsOnDisk)    [{ manifest, local }] per tracked manifest with no tracked lockfile; `local` is a
//                                      lockfile that is on disk but not in git (null when there is none)
//   hasManifest(tracked)               is any known manifest tracked?
//
// Pure. Tested in: lib/__tests__/lockfiles.test.ts (and doctorBaseline.test.ts for the doctor row).
// =============================================================
'use strict';

const LOCKS = Object.freeze([
  ['package.json', ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock']],
  ['pyproject.toml', ['uv.lock', 'poetry.lock', 'pdm.lock', 'Pipfile.lock', 'requirements.txt']],
  ['Pipfile', ['Pipfile.lock']],
  ['Cargo.toml', ['Cargo.lock']],
  ['go.mod', ['go.sum']],
  ['Gemfile', ['Gemfile.lock']],
  ['composer.json', ['composer.lock']],
]);

/**
 * @param {Set<string>|string[]} tracked  the files git tracks (root-relative, forward slashes)
 * @param {(file: string) => boolean} [existsOnDisk]
 * @returns {{ manifest: string, locks: string[], local: string|null }[]}
 */
function lockGaps(tracked, existsOnDisk = () => false) {
  const set = tracked instanceof Set ? tracked : new Set(tracked ?? []);
  const out = [];
  for (const [manifest, locks] of LOCKS) {
    if (!set.has(manifest) || locks.some((l) => set.has(l))) continue;
    out.push({ manifest, locks, local: locks.find((l) => existsOnDisk(l)) ?? null });
  }
  return out;
}

const hasManifest = (tracked) => {
  const set = tracked instanceof Set ? tracked : new Set(tracked ?? []);
  return LOCKS.some(([m]) => set.has(m));
};

module.exports = { LOCKS, lockGaps, hasManifest };
