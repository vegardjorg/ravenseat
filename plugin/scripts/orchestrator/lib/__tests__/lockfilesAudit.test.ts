// =============================================================
// lockfilesAudit.test.ts: lib/lockfiles.js auditPackages, every package a lockfile pins (transitive too) with where it
// came from (origin) and whether it is only for development, for the dependency audit (roadmap 0å KD-4).
//
// Locks: (1) each lockfile format gives its packages with origin public only for the public registry; (2) workspace,
// file:, link:, git and local paths, and another registry, are never public; (3) a version that is not a plain version
// is never public; (4) dev flags where the format has them; (5) broken input gives null, never a throw.
// =============================================================
import { describe, expect, it } from 'vitest';

const L = require('../lockfiles.js');
const pick = (r: any, name: string) => r.packages.filter((p: any) => p.name === name);

describe('auditPackages', () => {
  it('package-lock v3: nested copies too, link and other registries are not public, dev flags', () => {
    const t = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { name: 'my-app', version: '1.0.0' },
        'node_modules/lodash': { version: '4.17.20', resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.20.tgz' },
        'node_modules/a/node_modules/lodash': { version: '3.10.1', resolved: 'https://registry.npmjs.org/lodash/-/lodash-3.10.1.tgz', dev: true },
        'node_modules/vitest': { version: '2.0.0', resolved: 'https://registry.npmjs.org/vitest/-/vitest-2.0.0.tgz', dev: true },
        'node_modules/@acme/ui': { version: '1.2.0', resolved: 'https://npm.acme.example/@acme/ui/-/ui-1.2.0.tgz' },
        'node_modules/shared': { resolved: 'packages/shared', link: true },
        'packages/shared': { name: 'shared', version: '0.0.1' },
        'node_modules/fromgit': { version: '1.0.0', resolved: 'git+ssh://git@github.com/x/fromgit.git#abc' },
        'node_modules/local': { version: '1.0.0', resolved: 'file:../local' },
      },
    });
    const r = L.auditPackages('package-lock.json', t);
    expect(r.ecosystem).toBe('npm');
    expect(pick(r, 'lodash')).toEqual([
      { name: 'lodash', version: '4.17.20', origin: 'public', dev: false },
      { name: 'lodash', version: '3.10.1', origin: 'public', dev: true },
    ]);
    expect(pick(r, 'vitest')[0].dev).toBe(true);
    expect(pick(r, '@acme/ui')[0].origin).toBe('other-registry');
    expect(pick(r, 'shared')).toEqual([]);
    expect(pick(r, 'fromgit')[0].origin).toBe('git');
    expect(pick(r, 'local')[0].origin).toBe('local');
    expect(pick(r, 'my-app')).toEqual([]);
  });

  it('pnpm-lock v9: the packages section, git and directory resolutions are not public', () => {
    const t = [
      "lockfileVersion: '9.0'",
      'importers:',
      '  .:',
      '    dependencies:',
      '      zod:',
      '        specifier: ^3.23.0',
      '        version: 3.23.8',
      'packages:',
      '  zod@3.23.8:',
      '    resolution: {integrity: sha512-x}',
      "  '@types/node@20.1.0':",
      '    resolution: {integrity: sha512-y}',
      '  react-dom@18.2.0(react@18.2.0):',
      '    resolution: {integrity: sha512-z}',
      '  private@1.0.0:',
      '    resolution: {tarball: https://npm.acme.example/private/-/private-1.0.0.tgz}',
      '  fromgit@https://codeload.github.com/x/y/tar.gz/abc:',
      '    resolution: {tarball: https://codeload.github.com/x/y/tar.gz/abc}',
      '  repo@1.0.0:',
      '    resolution: {type: git, repo: https://github.com/x/repo, commit: abc}',
      'snapshots:',
      '  zod@3.23.8: {}',
    ].join('\n');
    const r = L.auditPackages('pnpm-lock.yaml', t);
    expect(r.packages.filter((p: any) => p.origin === 'public').map((p: any) => `${p.name}@${p.version}`)).toEqual([
      'zod@3.23.8',
      '@types/node@20.1.0',
      'react-dom@18.2.0',
    ]);
    expect(pick(r, 'private')[0].origin).toBe('other-registry');
    expect(pick(r, 'repo')[0].origin).toBe('git');
    expect(pick(r, 'fromgit').every((p: any) => p.origin !== 'public')).toBe(true);
  });

  it('pnpm-lock v6: /name@version keys and dev: true', () => {
    const t = ["lockfileVersion: '6.0'", 'packages:', '  /vitest@1.0.0:', '    resolution: {integrity: sha512-x}', '    dev: true', '  /zod@3.0.0:', '    resolution: {integrity: sha512-y}', '    dev: false'].join('\n');
    const r = L.auditPackages('pnpm-lock.yaml', t);
    expect(r.packages).toEqual([
      { name: 'vitest', version: '1.0.0', origin: 'public', dev: true },
      { name: 'zod', version: '3.0.0', origin: 'public', dev: false },
    ]);
  });

  it('yarn v1 and berry: resolved and resolution decide the origin', () => {
    const v1 = [
      'lodash@^4.17.0:',
      '  version "4.17.20"',
      '  resolved "https://registry.yarnpkg.com/lodash/-/lodash-4.17.20.tgz#abc"',
      '"@acme/x@^1.0.0":',
      '  version "1.0.0"',
      '  resolved "https://npm.acme.example/@acme/x/-/x-1.0.0.tgz"',
    ].join('\n');
    const r1 = L.auditPackages('yarn.lock', v1);
    expect(r1.packages).toEqual([
      { name: 'lodash', version: '4.17.20', origin: 'public', dev: null },
      { name: '@acme/x', version: '1.0.0', origin: 'other-registry', dev: null },
    ]);
    const berry = [
      '__metadata:',
      '  version: 6',
      '"zod@npm:^3.0.0":',
      '  version: 3.23.8',
      '  resolution: "zod@npm:3.23.8"',
      '"app@workspace:.":',
      '  version: 0.0.0-use.local',
      '  resolution: "app@workspace:."',
      '"lib@link:../lib":',
      '  version: 0.0.0-use.local',
      '  resolution: "lib@link:../lib::locator=app"',
    ].join('\n');
    const r2 = L.auditPackages('yarn.lock', berry);
    expect(r2.packages.filter((p: any) => p.origin === 'public')).toEqual([{ name: 'zod', version: '3.23.8', origin: 'public', dev: null }]);
    expect(r2.packages.some((p: any) => p.name === 'app' && p.origin === 'public')).toBe(false);
  });

  it('bun.lock: the default registry is public, another one is not, workspaces are left out', () => {
    const t = '{\n  "lockfileVersion": 1,\n  "packages": {\n    "zod": ["zod@3.23.8", "", {}, "sha512-x"],\n    "priv": ["priv@1.0.0", "https://npm.acme.example/priv-1.0.0.tgz", {}, "sha"],\n    "ws": ["ws@workspace:packages/ws"],\n  },\n}\n';
    const r = L.auditPackages('bun.lock', t);
    expect(r.packages).toEqual([
      { name: 'zod', version: '3.23.8', origin: 'public', dev: null },
      { name: 'priv', version: '1.0.0', origin: 'other-registry', dev: null },
    ]);
  });

  it('uv.lock: pypi.org is public; editable, virtual, git, path and another index are not', () => {
    const t = [
      'version = 1',
      '[[package]]',
      'name = "My_App"',
      'version = "0.1.0"',
      'source = { editable = "." }',
      '[[package]]',
      'name = "Requests"',
      'version = "2.31.0"',
      'source = { registry = "https://pypi.org/simple" }',
      '[[package]]',
      'name = "internal"',
      'version = "1.0.0"',
      'source = { registry = "https://pypi.acme.example/simple" }',
      '[[package]]',
      'name = "fromgit"',
      'version = "1.0.0"',
      'source = { git = "https://github.com/x/y?rev=abc" }',
      '[[package]]',
      'name = "nosource"',
      'version = "1.0.0"',
    ].join('\n');
    const r = L.auditPackages('uv.lock', t);
    expect(r.ecosystem).toBe('python');
    expect(r.packages.map((p: any) => [p.name, p.origin])).toEqual([
      ['my-app', 'local'],
      ['requests', 'public'],
      ['internal', 'other-registry'],
      ['fromgit', 'git'],
      ['nosource', 'unknown'],
    ]);
  });

  it('poetry.lock: no source table is PyPI; a source table of any type is not public; category dev', () => {
    const t = [
      '[[package]]',
      'name = "django"',
      'version = "4.2.0"',
      'category = "main"',
      '[[package]]',
      'name = "pytest"',
      'version = "7.0.0"',
      'category = "dev"',
      '[[package]]',
      'name = "corp"',
      'version = "1.0.0"',
      '[package.source]',
      'type = "legacy"',
      'url = "https://pypi.acme.example/simple"',
      '[[package]]',
      'name = "gitpkg"',
      'version = "1.0.0"',
      '[package.source]',
      'type = "git"',
    ].join('\n');
    const r = L.auditPackages('poetry.lock', t);
    expect(r.packages).toEqual([
      { name: 'django', version: '4.2.0', origin: 'public', dev: false },
      { name: 'pytest', version: '7.0.0', origin: 'public', dev: true },
      { name: 'corp', version: '1.0.0', origin: 'other-registry', dev: null },
      { name: 'gitpkg', version: '1.0.0', origin: 'git', dev: null },
    ]);
  });

  it('Cargo.lock: crates.io is public; no source (the workspace) and git are not', () => {
    const t = [
      '[[package]]',
      'name = "my-crate"',
      'version = "0.1.0"',
      '[[package]]',
      'name = "serde"',
      'version = "1.0.190"',
      'source = "registry+https://github.com/rust-lang/crates.io-index"',
      '[[package]]',
      'name = "tokio"',
      'version = "1.35.0"',
      'source = "sparse+https://index.crates.io/"',
      '[[package]]',
      'name = "forked"',
      'version = "0.2.0"',
      'source = "git+https://github.com/x/forked?rev=abc#abc"',
    ].join('\n');
    const r = L.auditPackages('Cargo.lock', t);
    expect(r.ecosystem).toBe('cargo');
    expect(r.packages.map((p: any) => [p.name, p.origin])).toEqual([
      ['my-crate', 'local'],
      ['serde', 'public'],
      ['tokio', 'public'],
      ['forked', 'git'],
    ]);
  });

  it('go.sum: the module versions that are built (not the /go.mod-only lines)', () => {
    const t = [
      'golang.org/x/text v0.3.0 h1:abc=',
      'golang.org/x/text v0.3.0/go.mod h1:def=',
      'golang.org/x/text v0.1.0/go.mod h1:old=',
      'github.com/acme/tool v1.2.0 h1:ghi=',
    ].join('\n');
    const r = L.auditPackages('go.sum', t);
    expect(r.packages).toEqual([
      { name: 'golang.org/x/text', version: 'v0.3.0', origin: 'public', dev: null },
      { name: 'github.com/acme/tool', version: 'v1.2.0', origin: 'public', dev: null },
    ]);
  });

  it('the same package and version once; dev only when every copy is dev', () => {
    const t = JSON.stringify({
      packages: {
        'node_modules/x': { version: '1.0.0', resolved: 'https://registry.npmjs.org/x/-/x-1.0.0.tgz', dev: true },
        'node_modules/a/node_modules/x': { version: '1.0.0', resolved: 'https://registry.npmjs.org/x/-/x-1.0.0.tgz' },
      },
    });
    expect(L.auditPackages('package-lock.json', t).packages).toEqual([{ name: 'x', version: '1.0.0', origin: 'public', dev: false }]);
  });

  it('broken or unknown input gives null, never a throw', () => {
    expect(L.auditPackages('package-lock.json', '{not json')).toBeNull();
    expect(L.auditPackages('Gemfile.lock', 'GEM')).toBeNull();
    expect(L.auditPackages('yarn.lock', '')).toBeNull();
    expect(L.auditPackages('package-lock.json', 'a\u0000b')).toBeNull();
  });
});
