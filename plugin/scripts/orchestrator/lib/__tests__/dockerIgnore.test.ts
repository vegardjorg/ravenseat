// =============================================================
// dockerIgnore.test.ts: a container build in the main tree must keep .claude/ and the data folder out of its context
// (lib/dockerIgnore.js, the doctor row "dockerignore"; roadmap 1c SEC-T item 3).
//
// Why: `docker build .` sends the whole folder to the builder, and a `COPY . .` puts .claude/ (personal settings, the
// worktrees) and the queue's data folder into the image, where anyone who pulls it can read them. Advice only: WARN.
// =============================================================
import { describe, expect, it } from 'vitest';

/* eslint-disable @typescript-eslint/no-require-imports */
const DI = require('../dockerIgnore');

describe('containerFiles: which root files are a container build', () => {
  it('Dockerfile, Dockerfile.dev, api.Dockerfile and Containerfile count; other names do not', () => {
    expect(DI.containerFiles(['Dockerfile', 'README.md', 'api.Dockerfile', 'Containerfile', 'Dockerfile.dev', 'docker-compose.yml', 'dockerfile-notes.txt'])).toEqual([
      'Containerfile',
      'Dockerfile',
      'Dockerfile.dev',
      'api.Dockerfile',
    ]);
    expect(DI.containerFiles(['package.json', '.dockerignore'])).toEqual([]);
  });
});

describe('excludes: does a .dockerignore keep a folder out', () => {
  it('the folder itself, with a slash, a leading slash, a glob, or everything', () => {
    for (const text of ['.claude', '.claude/', '/.claude', './.claude/', '.claude/**', '.*', '*', '**', '**/.claude', '# notes\n\n  .claude  \n'])
      expect(DI.excludes(text, '.claude'), JSON.stringify(text)).toBe(true);
  });

  it('not: another folder, a comment, a file inside only, or a later negation of the folder', () => {
    for (const text of ['', 'node_modules', '# .claude', '.claude/settings.local.json', '.claude\n!.claude', '*\n!.claude/'])
      expect(DI.excludes(text, '.claude'), JSON.stringify(text)).toBe(false);
  });

  it('a nested data folder by its path', () => {
    expect(DI.excludes('.queue/data/', '.queue/data')).toBe(true);
    expect(DI.excludes('.queue/', '.queue/data')).toBe(true);
    expect(DI.excludes('data/', '.queue/data')).toBe(false);
  });
});

describe('facts: what the doctor row says', () => {
  it('nothing to say without a container file', () => {
    expect(DI.facts({ names: ['README.md'], dockerignore: null, folders: ['.claude', 'data'] })).toBeNull();
  });

  it('no .dockerignore: every folder is missing; one that only keeps some: the rest', () => {
    expect(DI.facts({ names: ['Dockerfile'], dockerignore: null, folders: ['.claude', 'data'] })).toEqual({
      files: ['Dockerfile'],
      hasIgnore: false,
      missing: ['.claude', 'data'],
    });
    expect(DI.facts({ names: ['Dockerfile'], dockerignore: 'node_modules\n.claude/\n', folders: ['.claude', 'data'] })).toEqual({
      files: ['Dockerfile'],
      hasIgnore: true,
      missing: ['data'],
    });
  });
});
