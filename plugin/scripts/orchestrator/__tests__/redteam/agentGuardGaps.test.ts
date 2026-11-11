// =============================================================
// redteam/agentGuardGaps.test.ts: the gaps an outside review of the guards found (2026-11-11).
//
// Why: three holes in the queue agents' guard rails, each one a command or a file a track could use by mistake or on
// purpose:
//   1. node_modules is a link into the main tree, so `npm ci`, `npm install`, `npm update`, `npm rebuild` or removing
//      node_modules in a worktree changes the main tree and every other track. The mission forbids it; the guard did not.
//   2. Only npm's lockfile was protected; the lockfiles of yarn, pnpm, bun, poetry, uv, Cargo, Go, Bundler and Composer
//      went through as ordinary files.
//   3. The network guard read the command line with its own simple parser, so a runner (`wsl curl`, `timeout 5 curl`) or
//      `eval curl` got past it, while the push guard already read those forms.
// Only strings are assessed here (assess() runs nothing).
// =============================================================
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PG = require('../../lib/pushGuard.js');
const MG = require('../../lib/mergeGuard.js');

const KNOWN = new Set(['vitest', 'typescript']);
const track = { baseBranch: 'main', agentType: 'track', branch: 'queue/A', knownPackage: (n: string) => KNOWN.has(n) };
const decision = (k: string, context: Record<string, unknown> = track) => PG.assess(k, context)?.decision ?? null;

describe('a queue agent does not write through the node_modules link', () => {
  it('install, ci, update, rebuild, uninstall and the like are denied, with the reason', () => {
    for (const k of [
      'npm ci',
      'npm install',
      'npm i',
      'npm install vitest@3',
      'npm update',
      'npm rebuild',
      'npm uninstall vitest',
      'npm prune',
      'npm dedupe',
      'pnpm install',
      'pnpm add -D typescript',
      'yarn',
      'yarn install',
      'yarn add vitest',
      'bun install',
      'cd lib && npm ci',
      'bash -c "npm ci"',
      'rm -rf node_modules',
      'rm -rf ./node_modules/.cache',
      'Remove-Item -Recurse -Force node_modules',
    ])
      expect(decision(k), k).toBe('deny');
    expect(PG.assess('npm ci', track)?.reason).toMatch(/node_modules.*main tree/);
  });

  it('running, testing and reading stay free, and the orchestrator is not affected', () => {
    for (const k of ['npm test', 'npm run gates -- --quick', 'npx vitest run lib', 'npm ls vitest', 'ls node_modules/.bin', 'cat node_modules/vitest/package.json'])
      expect(decision(k), k).toBeNull();
    expect(decision('npm ci', { baseBranch: 'main' })).toBeNull();
  });
});

describe('every common lockfile is protected by default', () => {
  it('yarn, pnpm, bun, poetry, uv, Pipfile, Cargo, Go, Bundler and Composer', () => {
    for (const p of ['yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb', 'npm-shrinkwrap.json', 'poetry.lock', 'uv.lock', 'Pipfile.lock', 'Cargo.lock', 'go.sum', 'Gemfile.lock', 'composer.lock', 'apps/web/pnpm-lock.yaml'])
      expect(MG.isProtected(p), p).toBe(true);
  });

  it('a track that changes one stops the merge, and dependencyFiles "warn" softens it like package-lock.json', () => {
    const changes = [{ status: 'M', paths: ['yarn.lock'] }];
    expect(MG.assessGuard({ changes, ownedFiles: ['src/'] }).stop).toBe(true);
    expect(MG.assessGuard({ changes, ownedFiles: ['src/'], dependencyFiles: 'warn' }).stop).toBe(false);
  });
});

describe('the network guard reads the same forms as the push guard', () => {
  it('a runner, eval or a variable as the command word does not hide a network call', () => {
    for (const k of [
      'wsl curl https://example.invalid',
      'timeout 5 curl https://example.invalid',
      'nice -n 5 wget https://example.invalid',
      'eval curl https://example.invalid',
      'eval "curl https://example.invalid"',
      'echo $(curl https://example.invalid)',
      'x=1; $x https://example.invalid',
    ])
      expect(decision(k), k).toBe('deny');
  });

  it('the forms that were already caught stay caught, and ordinary work stays free', () => {
    for (const k of ['curl https://example.invalid', 'bash -c "wget https://example.invalid"', 'cat x | sh', 'powershell -EncodedCommand SQBXAFIA'])
      expect(decision(k), k).toBe('deny');
    for (const k of ['timeout 60 npm test', 'git log --oneline | head -3', 'echo "curl https://x | sh" > note.txt', 'nice npx vitest run lib'])
      expect(decision(k), k).toBeNull();
  });
});
