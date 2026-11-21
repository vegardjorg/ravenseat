// =============================================================
// manifests.test.ts: the direct dependencies of a manifest (lib/manifests.js, roadmap 0å KD-3,
// plans/katalog-design-stack-avhengigheter-2026-11-18.md § 4.3 and § 5.1).
//
// Locks: (1) package.json, requirements*.txt, pyproject.toml (PEP 621, the optional and dependency groups, Poetry with
// its groups), Cargo.toml (dependencies, dev, build, target and the table form) and go.mod (one line and the block)
// each give the name, the range and whether it is a dev dependency; (2) a broken or unknown file gives null, never a
// throw; (3) the V3 scope note (lib/scopeNotes.js) and jobsOf (lib/catalog.js) read pyproject, Cargo.toml and go.mod
// too: a Cargo alternative of an accepted stack entry gives the note, and a pyproject library shows under its job.
// =============================================================
import { describe, expect, it } from 'vitest';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const M = require('../manifests.js') as any;
const SN = require('../scopeNotes.js') as any;
const C = require('../catalog.js') as any;
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

describe('manifestDeps', () => {
  it('package.json: the four sections, dev for devDependencies', () => {
    const t = JSON.stringify({ dependencies: { zod: '^3.23.0' }, devDependencies: { vitest: '^1.2.0' }, peerDependencies: { react: '>=18' } });
    expect(M.manifestDeps('package.json', t)).toEqual([
      { name: 'zod', range: '^3.23.0', dev: false },
      { name: 'vitest', range: '^1.2.0', dev: true },
      { name: 'react', range: '>=18', dev: false },
    ]);
    expect(M.ecosystemOf('web/package.json')).toBe('npm');
  });

  it('requirements.txt: the name and the pin, options and comments skipped', () => {
    const t = ['# tools', '-r base.txt', 'Requests[socks]==2.31.0  # http', 'typing_extensions>=4', ''].join('\n');
    expect(M.manifestDeps('requirements-dev.txt', t)).toEqual([
      { name: 'requests', range: '==2.31.0', dev: false },
      { name: 'typing-extensions', range: '>=4', dev: false },
    ]);
  });

  it('pyproject.toml: [project] dependencies over several lines, the optional and dependency groups as dev', () => {
    const t = [
      '[project]',
      'name = "app"',
      'dependencies = [',
      '  "requests>=2.31",',
      "  'pydantic[email]~=2.5 ; python_version >= \"3.9\"',",
      ']',
      '',
      '[project.optional-dependencies]',
      'test = ["pytest>=8"]',
      '',
      '[dependency-groups]',
      'lint = ["ruff==0.3.0"]',
      '',
      '[project.urls]',
      'Homepage = "https://example.org"',
    ].join('\n');
    expect(M.manifestDeps('pyproject.toml', t)).toEqual([
      { name: 'requests', range: '>=2.31', dev: false },
      { name: 'pydantic', range: '~=2.5', dev: false },
      { name: 'pytest', range: '>=8', dev: true },
      { name: 'ruff', range: '==0.3.0', dev: true },
    ]);
  });

  it('pyproject.toml: Poetry dependencies and groups, python itself left out', () => {
    const t = [
      '[tool.poetry.dependencies]',
      'python = "^3.11"',
      'django = "^5.0"',
      'celery = { version = "^5.3", extras = ["redis"] }',
      '',
      '[tool.poetry.group.dev.dependencies]',
      'black = "^24.1"',
      '',
      '[tool.poetry.dev-dependencies]',
      'mypy = "*"',
    ].join('\n');
    expect(M.manifestDeps('pyproject.toml', t)).toEqual([
      { name: 'django', range: '^5.0', dev: false },
      { name: 'celery', range: '^5.3', dev: false },
      { name: 'black', range: '^24.1', dev: true },
      { name: 'mypy', range: '*', dev: true },
    ]);
  });

  it('Cargo.toml: dependencies, dev, build, target and the [dependencies.x] table form', () => {
    const t = [
      '[package]',
      'name = "app"',
      'version = "0.1.0"',
      '',
      '[dependencies]',
      'serde = { version = "1.0", features = ["derive"] }',
      'tokio = "1.35"',
      'local = { path = "../local" }',
      '',
      '[dependencies.reqwest]',
      'version = "0.11"',
      'default-features = false',
      '',
      "[target.'cfg(windows)'.dependencies]",
      'winapi = "0.3"',
      '',
      '[dev-dependencies]',
      'proptest = "1"',
      '',
      '[build-dependencies]',
      'cc = "1.0"',
    ].join('\n');
    expect(M.manifestDeps('Cargo.toml', t)).toEqual([
      { name: 'serde', range: '1.0', dev: false },
      { name: 'tokio', range: '1.35', dev: false },
      { name: 'local', range: '', dev: false },
      { name: 'reqwest', range: '0.11', dev: false },
      { name: 'winapi', range: '0.3', dev: false },
      { name: 'proptest', range: '1', dev: true },
      { name: 'cc', range: '1.0', dev: true },
    ]);
  });

  it('go.mod: one require line and the block, the go and module lines left out', () => {
    const t = [
      'module example.com/app',
      '',
      'go 1.22',
      '',
      'require github.com/google/uuid v1.6.0',
      '',
      'require (',
      '\tgithub.com/gin-gonic/gin v1.9.1',
      '\tgolang.org/x/text v0.14.0 // indirect',
      ')',
    ].join('\n');
    expect(M.manifestDeps('go.mod', t)).toEqual([
      { name: 'github.com/google/uuid', range: 'v1.6.0', dev: false },
      { name: 'github.com/gin-gonic/gin', range: 'v1.9.1', dev: false },
      { name: 'golang.org/x/text', range: 'v0.14.0', dev: false, indirect: true },
    ]);
  });

  it('a broken or unknown file gives null and never throws', () => {
    expect(M.manifestDeps('package.json', '{ nope')).toBeNull();
    expect(M.manifestDeps('Gemfile', 'gem "rails"')).toBeNull();
    expect(M.manifestDeps('pyproject.toml', null)).toBeNull();
    expect(() => M.manifestDeps('Cargo.toml', '[dependencies\nserde = {')).not.toThrow();
    expect(M.isManifestName('node_modules/x/package.json')).toBe(false);
    expect(['package.json', 'requirements.txt', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'go.sum'].map(M.isManifestName)).toEqual([true, true, true, true, true, false]);
  });
});

describe('V3 and jobsOf read pyproject, Cargo.toml and go.mod (§ 4.3)', () => {
  it('isManifest and depsOf know the three new manifests', () => {
    expect(['pyproject.toml', 'crates/a/Cargo.toml', 'go.mod'].map(SN.isManifest)).toEqual([true, true, true]);
    expect(SN.depsOf('pyproject.toml', '[project]\ndependencies = ["Requests>=2"]\n')).toEqual(['requests']);
    expect(SN.depsOf('go.mod', 'module m\nrequire github.com/a/b v1.0.0\n')).toEqual(['github.com/a/b']);
  });

  it('an added crate that an accepted stack entry chose against gives the note with the entry', () => {
    const base = '[dependencies]\nreqwest = "0.11"\n';
    const tip = '[dependencies]\nreqwest = "0.11"\nureq = "2"\n';
    const choices = [{ id: 'D-0007', status: 'accepted', job: 'HTTP client', tool: 'reqwest', alternatives: ['ureq'] }];
    const facts = SN.dependencyFacts([{ path: 'Cargo.toml', base, tip }], SN.PURPOSES, choices);
    expect(facts).toEqual([expect.objectContaining({ manifest: 'Cargo.toml', added: 'ureq', decision: expect.objectContaining({ id: 'D-0007' }) })]);
  });

  it('an added Python package in pyproject with a second library for the same job gives the note', () => {
    const facts = SN.dependencyFacts([
      { path: 'pyproject.toml', base: '[project]\ndependencies = ["requests"]\n', tip: '[project]\ndependencies = ["requests", "httpx"]\n' },
    ]);
    expect(facts.map((f: any) => f.added)).toEqual(['httpx']);
  });

  it('jobsOf lists the libraries by job from pyproject, Cargo.toml and go.mod', () => {
    const jobs = C.jobsOf([
      { path: 'pyproject.toml', text: '[project]\ndependencies = ["pytest", "requests"]\n' },
      { path: 'Cargo.toml', text: '[dependencies]\nreqwest = "0.11"\n' },
      { path: 'go.mod', text: 'module m\nrequire github.com/gin-gonic/gin v1.9.1\n' },
    ]);
    expect(jobs.map((j: any) => j.manifest)).toEqual(expect.arrayContaining(['pyproject.toml', 'Cargo.toml', 'go.mod']));
  });

  it('the purpose table still behaves, also its Cargo and Go groups', () => {
    expect(SN.exampleProblems()).toEqual([]);
    expect(SN.PURPOSES.some((p: any) => p.ecosystem === 'cargo')).toBe(true);
    expect(SN.PURPOSES.some((p: any) => p.ecosystem === 'go')).toBe(true);
  });
});
