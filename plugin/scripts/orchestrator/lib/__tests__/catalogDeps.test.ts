// =============================================================
// catalogDeps.test.ts: the dependencies in the catalog (lib/catalogDeps.js, roadmap 0å KD-3,
// plans/katalog-design-stack-avhengigheter-2026-11-18.md § 5.1 and § 5.2).
//
// Locks: (1) the `## Dependencies` table in stack.md is read (package, purpose, docs, note), a broken row is an error,
// a docs cell that is no URL a warning, more than 40 rows a warning, and the Prefer lines still read as before; (2) a
// docs URL template gets {major}, {minor} and {version} from the locked version, and a template it cannot fill is left
// out; (3) the imports of JS/TS, Python, Rust and Go files name the packages; (4) depRows gives the packages the task's
// files import, the table's rows first, each with the locked version (or the installed one), the local path to read
// and the filled docs URL, at most eight; nothing without a version and without a row; (5) the init proposals come
// from local metadata only (node_modules, the venv's METADATA, docs.rs and pkg.go.dev templates) and only for packages
// the code imports; (6) `catalog check` warns when a row names a package in no manifest.
// Pure: the file access is a small in-memory tree.
// =============================================================
import { describe, expect, it } from 'vitest';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const D = require('../catalogDeps.js') as any;
const C = require('../catalog.js') as any;
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

/** An in-memory tree in the shape catalogDeps reads: read, exists and list (root-relative, forward slashes). */
function tree(files: Record<string, string>) {
  const has = (p: string) => Object.hasOwn(files, p);
  return {
    read: (p: string) => (has(p) ? files[p] : null),
    exists: (p: string) => has(p) || Object.keys(files).some((f) => f.startsWith(`${p.replace(/\/$/, '')}/`)),
    list: (d: string) => {
      const pre = d ? `${d.replace(/\/$/, '')}/` : '';
      return [...new Set(Object.keys(files).filter((f) => f.startsWith(pre)).map((f) => f.slice(pre.length).split('/')[0]))];
    },
  };
}

const STACK = [
  '# Stack',
  '',
  '## Prefer',
  '',
  '- validation: zod',
  '',
  '## Dependencies',
  '',
  '| Package | Purpose | Docs | Note |',
  '|---|---|---|---|',
  '| zod | validation of all input | https://zod.dev | v3 API; v4 has another error shape |',
  '| vitest | tests | https://v{major}.vitest.dev/guide/ | |',
  '',
].join('\n');

describe('the Dependencies table', () => {
  it('reads the rows and leaves the Prefer lines as they were', () => {
    const s = C.parseStack(STACK);
    expect(s.prefer).toEqual([{ purpose: 'validation', use: 'zod' }]);
    expect(s.deps.map((r: any) => [r.package, r.purpose, r.docs, r.note])).toEqual([
      ['zod', 'validation of all input', 'https://zod.dev', 'v3 API; v4 has another error shape'],
      ['vitest', 'tests', 'https://v{major}.vitest.dev/guide/', ''],
    ]);
    expect(s.errors).toEqual([]);
    expect(s.warnings).toEqual([]);
  });

  it('a row with the wrong cells is an error, a docs cell that is no URL a warning, over 40 rows a warning', () => {
    const t = D.parseDepsTable(['## Dependencies', '| Package | Purpose | Docs | Note |', '|---|---|---|---|', '| zod | x |', '| a | b | see the wiki | |'].join('\n'));
    expect(t.errors).toEqual([expect.stringMatching(/stack\.md:4: a row needs four cells/)]);
    expect(t.warnings).toEqual([expect.stringMatching(/stack\.md:5: the docs of a is not a link/)]);
    const many = ['## Dependencies', '| Package | Purpose | Docs | Note |', '|---|---|---|---|', ...Array.from({ length: 41 }, (_, i) => `| p${i} | x | | |`)];
    expect(D.parseDepsTable(many.join('\n')).warnings).toEqual([expect.stringMatching(/41 rows; keep it to about 40/)]);
  });

  it('no table gives no rows, and a table under another heading is not read', () => {
    expect(D.parseDepsTable('# Stack\n\n## Prefer\n- a: b\n').rows).toEqual([]);
    expect(D.parseDepsTable('## Other\n| a | b | c | d |\n|---|---|---|---|\n| x | y | | |\n').rows).toEqual([]);
  });
});

describe('fillDocs', () => {
  it('fills {major}, {minor} and {version}, keeps a link without a placeholder, and leaves out one it cannot fill', () => {
    expect(D.fillDocs('https://v{major}.vitest.dev/guide/', '1.2.1')).toBe('https://v1.vitest.dev/guide/');
    expect(D.fillDocs('https://docs.rs/serde/{version}', '1.0.195')).toBe('https://docs.rs/serde/1.0.195');
    expect(D.fillDocs('https://pkg.go.dev/github.com/a/b@{version}', 'v1.9.1')).toBe('https://pkg.go.dev/github.com/a/b@v1.9.1');
    expect(D.fillDocs('https://x.dev/{minor}/', '4.17.21')).toBe('https://x.dev/4.17/');
    expect(D.fillDocs('https://zod.dev', null)).toBe('https://zod.dev');
    expect(D.fillDocs('https://v{major}.vitest.dev', null)).toBeNull();
    expect(D.fillDocs('', '1.0.0')).toBeNull();
  });
});

describe('importsOf', () => {
  it('names the packages a file imports, by language', () => {
    const js = "import { z } from 'zod';\nimport x from './local';\nconst q = require('@tanstack/react-query/build');\nimport('lodash/fp');\nimport fs from 'node:fs';\n";
    expect([...D.importsOf('src/a.ts', js)].sort()).toEqual(['@tanstack/react-query', 'lodash', 'zod']);
    expect([...D.importsOf('app/b.py', 'import requests\nfrom pydantic.fields import Field\nimport os, yaml\n')].sort()).toEqual(['os', 'pydantic', 'requests', 'yaml']);
    expect([...D.importsOf('src/main.rs', 'use serde::Deserialize;\nuse std::io;\nfn f() { tokio::spawn(x); }\n')].sort()).toEqual(['serde', 'std', 'tokio']);
    expect([...D.importsOf('main.go', 'import (\n\t"fmt"\n\tgin "github.com/gin-gonic/gin"\n)\n')].sort()).toEqual(['fmt', 'github.com/gin-gonic/gin']);
    expect([...D.importsOf('README.md', "import x from 'zod'")]).toEqual([]);
  });
});

const NPM = {
  'package.json': JSON.stringify({ dependencies: { zod: '^3.23.0', dayjs: '^1.11.0' }, devDependencies: { vitest: '^1.2.0' } }),
  'package-lock.json': JSON.stringify({ packages: { 'node_modules/zod': { version: '3.23.8' }, 'node_modules/vitest': { version: '1.2.1' }, 'node_modules/dayjs': { version: '1.11.10' } } }),
  'node_modules/zod/package.json': JSON.stringify({ name: 'zod', version: '3.23.8', types: './index.d.ts', homepage: 'https://zod.dev' }),
  'node_modules/zod/index.d.ts': 'export {}',
  'node_modules/vitest/package.json': JSON.stringify({ name: 'vitest', version: '1.2.1', homepage: 'https://github.com/vitest-dev/vitest#readme', description: 'Next generation testing framework' }),
  'node_modules/vitest/README.md': '# vitest',
  'lib/a.ts': "import { z } from 'zod';\nimport dayjs from 'dayjs';\n",
  'lib/a.test.ts': "import { it } from 'vitest';\n",
};

describe('depRows', () => {
  it('the packages the task files import, the table rows first, with the locked version, the local path and the docs', () => {
    const io = tree(NPM);
    const r = D.depRows({ owned_files: ['lib/a.ts', 'lib/a.test.ts'] }, io, { table: C.parseStack(STACK).deps });
    expect(r.rows.map((x: any) => x.name)).toEqual(['zod', 'vitest', 'dayjs']);
    expect(r.rows[0]).toMatchObject({ version: '3.23.8', how: 'locked', path: 'node_modules/zod/index.d.ts', docs: 'https://zod.dev', purpose: 'validation of all input' });
    expect(r.rows[1]).toMatchObject({ version: '1.2.1', path: 'node_modules/vitest/README.md', docs: 'https://v1.vitest.dev/guide/' });
    // dayjs: in no table row and not installed, but locked: the version is what a track needs.
    expect(r.rows[2]).toMatchObject({ version: '1.11.10', how: 'locked', path: null, docs: null });
    expect(r.cut).toBe(0);
  });

  it('a task that imports nothing, or names no files, gets no rows; a folder in the ownership is not read', () => {
    const io = tree(NPM);
    expect(D.depRows({ owned_files: ['lib/none.ts'] }, io, { table: [] }).rows).toEqual([]);
    expect(D.depRows({}, io, { table: [] }).rows).toEqual([]);
    expect(D.depRows({ owned_files: ['lib/'] }, io, { table: [] }).rows).toEqual([]);
  });

  it('no lockfile and nothing installed: only a table row is left, without a version', () => {
    const io = tree({ 'package.json': JSON.stringify({ dependencies: { zod: '^3', dayjs: '^1' } }), 'lib/a.ts': "import 'zod';\nimport 'dayjs';\n" });
    const r = D.depRows({ owned_files: ['lib/a.ts'] }, io, { table: C.parseStack(STACK).deps });
    expect(r.rows).toEqual([expect.objectContaining({ name: 'zod', version: null, docs: 'https://zod.dev' })]);
  });

  it('at most eight rows; the rest is counted as cut', () => {
    const deps = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`p${i}`, '1.0.0']));
    const lock = { packages: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`node_modules/p${i}`, { version: '1.0.0' }])) };
    const io = tree({ 'package.json': JSON.stringify({ dependencies: deps }), 'package-lock.json': JSON.stringify(lock), 'a.js': Object.keys(deps).map((n) => `require('${n}')`).join('\n') });
    const r = D.depRows({ owned_files: ['a.js'] }, io, { table: [] });
    expect(r.rows).toHaveLength(8);
    expect(r.cut).toBe(2);
  });

  it('Python with uv.lock and a venv, Rust with Cargo.lock, Go with go.sum and vendor/', () => {
    const io = tree({
      'pyproject.toml': '[project]\ndependencies = ["requests>=2"]\n',
      'uv.lock': '[[package]]\nname = "requests"\nversion = "2.31.0"\n',
      '.venv/lib/python3.12/site-packages/requests/__init__.py': '',
      'app/x.py': 'import requests\n',
      'Cargo.toml': '[dependencies]\nserde = "1"\n',
      'Cargo.lock': '[[package]]\nname = "serde"\nversion = "1.0.195"\n',
      'src/main.rs': 'use serde::Serialize;\n',
      'go.mod': 'module m\nrequire github.com/gin-gonic/gin v1.9.1\n',
      'go.sum': 'github.com/gin-gonic/gin v1.9.1 h1:x=\n',
      'vendor/github.com/gin-gonic/gin/gin.go': '',
      'cmd/main.go': 'import "github.com/gin-gonic/gin"\n',
    });
    const r = D.depRows({ owned_files: ['app/x.py', 'src/main.rs', 'cmd/main.go'] }, io, { table: [] });
    expect(r.rows.map((x: any) => [x.name, x.version, x.path])).toEqual([
      ['requests', '2.31.0', '.venv/lib/python3.12/site-packages/requests/'],
      ['serde', '1.0.195', null],
      ['github.com/gin-gonic/gin', 'v1.9.1', 'vendor/github.com/gin-gonic/gin/'],
    ]);
  });

  it('a broken lockfile or manifest gives no versions and never throws', () => {
    const io = tree({ 'package.json': '{ nope', 'package-lock.json': '{', 'a.js': "require('zod')" });
    expect(() => D.depRows({ owned_files: ['a.js'] }, io, { table: [] })).not.toThrow();
    expect(D.depRows({ owned_files: ['a.js'] }, io, { table: [] }).rows).toEqual([]);
  });
});

describe('init proposals from local metadata only', () => {
  it('only packages the code imports, with the docs from node_modules and a purpose from the purpose table or the description', () => {
    const io = tree(NPM);
    const rows = D.proposals({ files: Object.keys(NPM), io });
    expect(rows).toEqual([
      { package: 'zod', purpose: 'schema validation', docs: 'https://zod.dev', note: '' },
      { package: 'dayjs', purpose: 'dates and times', docs: '', note: '' },
      { package: 'vitest', purpose: 'test runner', docs: 'https://github.com/vitest-dev/vitest', note: '' },
    ]);
  });

  it('Python from the venv METADATA, Rust from docs.rs and Go from pkg.go.dev, as templates', () => {
    const io = tree({
      'pyproject.toml': '[project]\ndependencies = ["requests>=2"]\n',
      '.venv/lib/python3.12/site-packages/requests-2.31.0.dist-info/METADATA': 'Name: requests\nSummary: Python HTTP for Humans.\nProject-URL: Documentation, https://requests.readthedocs.io\n',
      'app/x.py': 'import requests\n',
      'Cargo.toml': '[dependencies]\nserde = "1"\n',
      'src/main.rs': 'use serde::Serialize;\n',
      'go.mod': 'module m\nrequire github.com/google/uuid v1.6.0\n',
      'cmd/main.go': 'import "github.com/google/uuid"\n',
    });
    const rows = D.proposals({ files: ['app/x.py', 'src/main.rs', 'cmd/main.go'], io });
    expect(rows).toEqual([
      { package: 'requests', purpose: 'HTTP client', docs: 'https://requests.readthedocs.io', note: '' },
      { package: 'serde', purpose: '', docs: 'https://docs.rs/serde/{version}', note: '' },
      { package: 'github.com/google/uuid', purpose: '', docs: 'https://pkg.go.dev/github.com/google/uuid@{version}', note: '' },
    ]);
  });

  it('the table text reads back as the same rows', () => {
    const rows = [{ package: 'zod', purpose: 'a | b', docs: 'https://zod.dev', note: '' }];
    const back = D.parseDepsTable(D.tableText(rows).join('\n'));
    expect(back.errors).toEqual([]);
    expect(back.rows.map((r: any) => [r.package, r.purpose, r.docs])).toEqual([['zod', 'a | b', 'https://zod.dev']]);
  });
});

describe('catalog check and the Dependencies table', () => {
  it('warns when a row names a package that is in no manifest', () => {
    const cat = { exists: true, dir: '/x', stack: C.parseStack(STACK), reuse: null, decisions: [], errors: [], warnings: [] };
    const io = tree({ 'package.json': JSON.stringify({ dependencies: { zod: '1' } }) });
    const r = C.checkCatalog(cat, { files: ['package.json'], readFile: io.read });
    expect(r.warnings).toEqual([expect.stringMatching(/stack\.md: the Dependencies row vitest names a package that is in no manifest/)]);
  });
});
