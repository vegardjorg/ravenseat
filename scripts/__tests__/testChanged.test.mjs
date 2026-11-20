// =============================================================
// testChanged.test.mjs: the pick of scripts/test-changed.mjs on a small fake repo (no git, no disk).
//
// Why: the pick decides which tests run after a change, so a hole in it lets a broken change through quietly. These
// tests pin each way a test can depend on a file (import, process by script name, command word through queue.mjs,
// helper, text read, data file, folder reader) and each rule that falls back to the whole suite.
// =============================================================
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { commandMap, globToRegex, lex, parseNameStatus, pathValue, readConfig, scanCode, selectTests } from '../test-changed.mjs';

const O = 'plugin/scripts/orchestrator';

/** The fake repo: path -> text (null for a file whose text is never read, like an image). */
function repo(extra = {}) {
  const files = {
    'vitest.config.mjs': [
      "export default defineConfig({ test: {",
      "  include: ['plugin/**/__tests__/**/*.test.{ts,mjs}'],",
      "  setupFiles: ['plugin/setup.mjs'],",
      '} });',
    ].join('\n'),
    'package.json': '{}',
    'plugin/setup.mjs': '',
    'README.md': null,
    'plugin/docs/guide.md': null,
    [`${O}/queue.mjs`]: [
      "import { command } from './cli/context.mjs';",
      "if (command === 'merge') {",
      "  await (await import('./cli/merge.mjs')).cmdMerge();",
      "} else if (command === 'show' || command === 'info') {",
      "  (await import('./cli/view.mjs')).cmdShow();",
      '} else {',
      "  console.log('Use: queue <merge|show>');",
      '}',
    ].join('\n'),
    [`${O}/cli/context.mjs`]: "export const command = process.argv[2];",
    // cli modules resolve require('./lib/...') from queue.mjs's folder (createRequire), one folder up
    [`${O}/cli/merge.mjs`]: "const U = require('./lib/util.js');\nexport function cmdMerge() {}",
    [`${O}/cli/view.mjs`]: 'export function cmdShow() {}',
    [`${O}/lib/util.js`]: "'use strict';\nmodule.exports = { x: 1 };",
    [`${O}/lib/other.js`]: "'use strict';\nmodule.exports = {};",
    // a hook script that loads util
    [`${O}/hook-guard.mjs`]: "import { createRequire } from 'node:module';\nconst U = createRequire(import.meta.url)('./lib/util.js');",
    // a library that reads the hook's text (no process): depends on that text only
    [`${O}/lib/hookList.js`]: "const fs = require('fs');\nconst t = fs.readFileSync(path.join(__dirname, '..', 'hook-guard.mjs'), 'utf8');",
    // reads hooks.json as settings, and starts processes (git), so its names are followed as what it runs
    [`${O}/lib/settings.js`]: "const fs = require('fs');\nconst h = JSON.parse(fs.readFileSync('hooks.json', 'utf8'));\nspawnSync('git', ['status']);",
    'plugin/hooks/hooks.json': '{ "hooks": [{ "command": "node \\"${ROOT}/scripts/orchestrator/hook-guard.mjs\\"" }] }',
    // tests
    [`${O}/lib/__tests__/util.test.ts`]: "import U from '../util.js';\nit('x', () => {});",
    [`${O}/lib/__tests__/other.test.ts`]: "import O from '../other.js';",
    [`${O}/lib/__tests__/hookList.test.ts`]: "import H from '../hookList.js';",
    [`${O}/lib/__tests__/settings.test.ts`]: "import S from '../settings.js';",
    [`${O}/__tests__/mergeFlow.test.ts`]: "const Q = path.join(DIR, 'queue.mjs');\nrun(Q, ['merge', '--task', 'A']);",
    [`${O}/__tests__/showFlow.test.ts`]: "const Q = path.join(DIR, 'queue.mjs');\nrun(Q, ['show']);",
    [`${O}/__tests__/hook.test.ts`]: "spawnSync(process.execPath, [path.join(DIR, 'hook-guard.mjs')]);",
    [`${O}/__tests__/helper.ts`]: "export const HOOK = path.join(DIR, 'hook-guard.mjs');",
    [`${O}/__tests__/viaHelper.test.ts`]: "import { HOOK } from './helper';",
    [`${O}/__tests__/hooksJson.test.ts`]: "const h = read(path.join(PLUGIN, 'hooks', 'hooks.json'));",
    [`${O}/__tests__/readme.test.ts`]: "expect(read('README.md')).toContain('x');",
    ...extra,
  };
  return new Map(Object.entries(files));
}

const pick = (paths, files = repo(), opts = {}) =>
  selectTests({ changed: paths.map((p) => (typeof p === 'string' ? { path: p, status: 'M' } : p)), files, ...opts });
const names = (r) => r.tests.map((t) => t.slice(t.lastIndexOf('/') + 1));

describe('the pick: import graph and process graph', () => {
  it('a changed library picks its importers, the tests that start a script loading it, and helpers that name one', () => {
    const r = pick([`${O}/lib/util.js`], repo(), { maxShare: 1 });
    expect(r.mode).toBe('some');
    expect(names(r)).toEqual(
      expect.arrayContaining(['util.test.ts', 'hook.test.ts', 'viaHelper.test.ts', 'mergeFlow.test.ts']),
    );
    // show runs cli/view.mjs, which does not load util; the other library has its own test
    expect(names(r)).not.toContain('showFlow.test.ts');
    expect(names(r)).not.toContain('other.test.ts');
  });

  it('a changed cli module picks only the tests that name queue.mjs together with one of its command words', () => {
    const r = pick([`${O}/cli/view.mjs`]);
    expect(names(r)).toEqual(['showFlow.test.ts']);
    const m = pick([`${O}/cli/merge.mjs`]);
    expect(names(m)).toEqual(['mergeFlow.test.ts']);
  });

  it('a library that reads a script as text depends on that text, not on what the script loads', () => {
    // util changes what hook-guard loads, not hook-guard's text: hookList (reads the text) is not affected
    expect(names(pick([`${O}/lib/util.js`], repo(), { maxShare: 1 }))).not.toContain('hookList.test.ts');
    // hook-guard's own text changed: hookList is
    expect(names(pick([`${O}/hook-guard.mjs`], repo(), { maxShare: 1 }))).toContain('hookList.test.ts');
  });

  it('a data file that names a script is followed for the test that reads it, not for a source reading it as settings', () => {
    const r = pick([`${O}/hook-guard.mjs`], repo(), { maxShare: 1 });
    expect(names(r)).toContain('hooksJson.test.ts');
    expect(names(r)).not.toContain('settings.test.ts');
  });

  it('a script changed only picks the tests that start it (and their helpers)', () => {
    const r = pick([`${O}/hook-guard.mjs`], repo(), { maxShare: 1 });
    expect(names(r)).toEqual(expect.arrayContaining(['hook.test.ts', 'viaHelper.test.ts']));
    expect(names(r)).not.toContain('mergeFlow.test.ts');
  });

  it('a changed test file is picked itself, and only test files changed gives just those', () => {
    const r = pick([`${O}/lib/__tests__/other.test.ts`]);
    expect(r.mode).toBe('some');
    expect(names(r)).toEqual(['other.test.ts']);
  });

  it('a deleted file is still followed by its name', () => {
    const files = repo();
    files.delete(`${O}/hook-guard.mjs`);
    const r = pick([{ path: `${O}/hook-guard.mjs`, status: 'D' }], files, { maxShare: 1 });
    expect(names(r)).toEqual(expect.arrayContaining(['hook.test.ts', 'viaHelper.test.ts']));
  });

  it('a test or helper that lists folders of the repo is picked for every change', () => {
    const files = repo({ [`${O}/__tests__/scan.test.ts`]: "for (const f of fs.readdirSync(path.join(__dirname, '..'))) check(f);" });
    expect(names(pick([`${O}/lib/other.js`], files))).toContain('scan.test.ts');
  });
});

describe('the pick: docs', () => {
  it('a docs-only change runs only the tests that read the changed file', () => {
    const r = pick(['README.md']);
    expect(r.reason).toMatch(/docs only/);
    expect(names(r)).toEqual(['readme.test.ts']);
  });

  it('a doc no test reads gives no tests', () => {
    const r = pick(['plugin/docs/guide.md']);
    expect(r.mode).toBe('none');
    expect(r.tests).toEqual([]);
  });

  it('a test that names the folder of a changed doc reads it', () => {
    const files = repo({ [`${O}/__tests__/docsRead.test.ts`]: "const t = read(path.join(PLUGIN, 'docs', name + '.md'));" });
    expect(names(pick(['plugin/docs/guide.md'], files))).toEqual(['docsRead.test.ts']);
  });

  // TC-1: tests write a README.md fixture into a temp repo, and a helper that does so spread the pick to every test using
  // it (196 of 388 files for a docs-only change). Only a path that can land on the repo's own file counts.
  const fixtureWriter = [
    "const ORCH = path.join(__dirname, '..');",
    "const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'q-'));",
    "fs.writeFileSync(path.join(repo, 'README.md'), 'start\\n');",
    "g(['add', '--', 'README.md']);",
    "expect(lockGaps(['README.md'])).toEqual([]);",
    "spawnSync(process.execPath, [path.join(ORCH, 'hook-guard.mjs')]);",
  ].join('\n');

  it('a test that writes the doc base name into a temp repo is not picked for the repo doc', () => {
    const files = repo({ [`${O}/__tests__/fixture.test.ts`]: fixtureWriter });
    expect(names(pick(['README.md'], files))).toEqual(['readme.test.ts']);
  });

  it('a helper that writes the fixture does not spread the doc to the tests using it', () => {
    const files = repo({
      [`${O}/__tests__/project.ts`]: fixtureWriter,
      [`${O}/__tests__/usesProject.test.ts`]: "import { project } from './project';",
    });
    expect(names(pick(['README.md'], files))).toEqual(['readme.test.ts']);
  });

  it('the readers of the repo doc are still picked: a root-like base, a repo-relative path, a relative path', () => {
    const files = repo({
      // ROOT computed from __dirname up to the repo root
      [`${O}/lib/__tests__/rootJoin.test.ts`]: "const ROOT = join(__dirname, '..', '..', '..', '..', '..');\nreadFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');",
      // a docs folder from __dirname and a list of names read through it
      [`${O}/lib/__tests__/docsList.test.ts`]: "const docs = path.resolve(__dirname, '..', '..', '..', '..', 'docs');\nfor (const f of ['guide.md', 'costs.md']) fs.readFileSync(path.join(docs, f), 'utf8');",
      [`${O}/__tests__/repoPath.test.ts`]: "const t = read('plugin/docs/costs.md');",
      [`${O}/__tests__/relative.test.ts`]: "const t = fs.readFileSync(new URL('../../../../README.md', import.meta.url), 'utf8');",
      // a root-like name the file does not define (imported): cannot tell, so it counts
      [`${O}/__tests__/importedRoot.test.ts`]: "import { PLUGIN_ROOT } from './paths';\nread(path.join(PLUGIN_ROOT, 'docs', 'costs.md'));",
      'CHANGELOG.md': null,
      'plugin/docs/costs.md': null,
    });
    expect(names(pick(['CHANGELOG.md'], files))).toEqual(['rootJoin.test.ts']);
    expect(names(pick(['plugin/docs/costs.md'], files))).toEqual(['importedRoot.test.ts', 'repoPath.test.ts', 'docsList.test.ts']);
    expect(names(pick(['README.md'], files))).toEqual(['readme.test.ts', 'relative.test.ts']);
  });

  it('a path from __dirname that lands on another folder (a fixture) does not count', () => {
    const files = repo({
      [`${O}/__tests__/fixtureDir.test.ts`]: "const FIX = path.join(__dirname, 'fixtures');\nconst t = fs.readFileSync(path.join(FIX, 'README.md'), 'utf8');",
    });
    expect(names(pick(['README.md'], files))).toEqual(['readme.test.ts']);
  });

  it('a test that names docs for a fixture folder is not picked for every docs change', () => {
    const files = repo({
      [`${O}/__tests__/fixtureDocs.test.ts`]: "const repo = mk();\nfs.mkdirSync(path.join(repo, 'docs'));\nexpect(types(['docs/a.txt'])).toBe(1);",
      [`${O}/__tests__/docsDir.test.ts`]: "const DOCS = path.join(__dirname, '..', '..', '..', 'docs');\nfor (const f of list) read(path.join(DOCS, f));",
    });
    expect(names(pick(['plugin/docs/guide.md'], files))).toEqual(['docsDir.test.ts']);
  });

  it('a folder reader is picked for a doc only when it can list the doc folder', () => {
    const files = repo({
      [`${O}/__tests__/scanOrch.test.ts`]: "for (const f of fs.readdirSync(path.join(__dirname, '..'))) check(f);",
      [`${O}/__tests__/scanDocs.test.ts`]: "for (const f of fs.readdirSync(path.join(__dirname, '..', '..', '..', 'docs'))) check(f);",
      [`${O}/__tests__/scanAll.test.ts`]: "const out = git(['ls-files']);\nconst HERE = __dirname;",
      // walkers: the folder comes from the calls that hand it over (a recursive call adds nothing)
      [`${O}/__tests__/walkOrch.test.ts`]: "const ORCH = join(__dirname, '..');\nfunction walk(d) { for (const e of readdirSync(d)) walk(join(d, e)); }\nwalk(ORCH);",
      [`${O}/__tests__/walkRoot.test.ts`]: "const ROOT = join(__dirname, '..', '..', '..', '..');\nfunction walk(d) { for (const e of readdirSync(d)) out.push(...walk(join(d, e))); }\nwalk(ROOT);",
    });
    files.set(`${O}/__tests__/flatPlugin.test.ts`, "const pluginRoot = path.join(__dirname, '..', '..', '..');\nconst before = fs.readdirSync(pluginRoot);");
    files.set(`${O}/__tests__/otherFolder.test.ts`, "import { CLIENT } from './paths';\nconst f = fs.readdirSync(path.join(CLIENT, 'board')).filter(Boolean);");
    const r = names(pick(['plugin/docs/guide.md'], files));
    expect(r).toEqual(['scanAll.test.ts', 'scanDocs.test.ts', 'walkRoot.test.ts']);
    // a flat listing of a folder above the doc sees it only when it is added or removed
    expect(names(pick([{ path: 'plugin/docs/new.md', status: 'A' }], files))).toContain('flatPlugin.test.ts');
    // a code change still picks every folder reader
    expect(names(pick([`${O}/lib/other.js`], files))).toEqual(expect.arrayContaining(['scanOrch.test.ts', 'scanDocs.test.ts', 'scanAll.test.ts']));
  });
});

describe('pathValue: what a path expression points at', () => {
  const at = (src, expr, file = `${O}/lib/__tests__/a.test.ts`) => pathValue(src, expr, file);
  it('follows __dirname, import.meta and consts built from them', () => {
    expect(at("const ROOT = join(__dirname, '..', '..');", 'ROOT')).toEqual({ k: 'path', p: O });
    expect(at('', "path.resolve(__dirname, '..', 'x.md')")).toEqual({ k: 'path', p: `${O}/lib/x.md` });
    expect(at('', "fileURLToPath(new URL('../b.md', import.meta.url))")).toEqual({ k: 'path', p: `${O}/lib/b.md` });
    expect(at('', "path.join(process.cwd(), 'README.md')")).toEqual({ k: 'path', p: 'README.md' });
    expect(at("const D = join(__dirname, '..');", 'join(D, name)')).toEqual({ k: 'tail', p: `${O}/lib` });
  });
  it('a temp folder is not the repo; an unknown upper-case root is "cannot tell"', () => {
    expect(at("const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'x'));", "path.join(repo, 'README.md')")).toBe(null);
    expect(at('', "path.join(p.repo, 'README.md')")).toBe(null);
    expect(at('', "path.join(REPO_ROOT, 'README.md')")).toEqual({ k: 'unknown', lits: ['README.md'] });
  });
});

describe('the pick: FULL', () => {
  for (const f of ['vitest.config.mjs', 'package.json', 'package-lock.json', 'scripts/test-env.mjs', `${O}/queue.mjs`, `${O}/lib/queueLogic.js`, `${O}/cli/context.mjs`, 'plugin/setup.mjs']) {
    it(`${f} changed gives FULL with a reason`, () => {
      const r = pick([f]);
      expect(r.mode).toBe('full');
      expect(r.reason).toMatch(/changed/);
      expect(r.tests.length).toBe(r.total);
    });
  }

  // A file the pick has no rule for (not code, data, a shim or a doc) can change how every test runs: .gitattributes
  // (line endings), .npmrc and .nvmrc (the install and the node version), .gitignore (what git lists). It cannot tell.
  for (const f of ['.gitattributes', '.npmrc', '.nvmrc', '.gitignore', 'LICENSE', 'plugin/tools/settings.toml']) {
    it(`${f} changed (a file type the pick has no rule for) gives FULL with a reason`, () => {
      const r = pick([f, `${O}/lib/other.js`]);
      expect(r.mode).toBe('full');
      expect(r.reason).toContain(f);
      expect(r.tests.length).toBe(r.total);
    });
  }

  it('an unknown file type under a __tests__ or fixtures folder keeps the folder rule (not FULL)', () => {
    const files = repo({ [`${O}/__tests__/data/case.bin`]: null, [`${O}/__tests__/dataRead.test.ts`]: "read(path.join(__dirname, 'data', 'case.bin'));" });
    const r = pick([`${O}/__tests__/data/case.bin`], files);
    expect(r.mode).toBe('some');
    expect(names(r)).toContain('dataRead.test.ts');
  });

  it('a computed import() in an affected source file gives FULL (it cannot be followed)', () => {
    const files = repo({ [`${O}/lib/loader.js`]: "const U = require('./util.js');\nmodule.exports = (n) => import(n);" });
    const r = pick([`${O}/lib/util.js`], files);
    expect(r.mode).toBe('full');
    expect(r.reason).toMatch(/loader\.js.*computed/);
  });

  it('a computed require() in a file the change does not reach does not', () => {
    const files = repo({ [`${O}/lib/loader.js`]: 'module.exports = (n) => require(n);' });
    expect(pick([`${O}/lib/other.js`], files).mode).toBe('some');
  });

  it('the env seam import(pathToFileURL(path.resolve(process.env.X)).href) is not a computed import', () => {
    const files = repo({ [`${O}/lib/util.js`]: 'const m = await import(pathToFileURL(path.resolve(process.env.QUEUE_X)).href);' });
    expect(pick([`${O}/lib/util.js`], files, { maxShare: 1 }).mode).toBe('some');
  });

  it('a pick over 60 % of the test files gives FULL', () => {
    const r = pick([`${O}/lib/util.js`], repo(), { maxShare: 0.2 });
    expect(r.mode).toBe('full');
    expect(r.reason).toMatch(/over 20 %/);
  });

  it('a config whose include list cannot be read gives FULL', () => {
    const files = repo({ 'vitest.config.mjs': 'export default {}' });
    const r = pick([`${O}/lib/other.js`], files);
    expect(r.mode).toBe('full');
    expect(r.reason).toMatch(/include/);
  });
});

describe('the parts', () => {
  it('commandMap reads the dispatch block: command word to cli module', () => {
    const { map, ok } = commandMap(repo().get(`${O}/queue.mjs`));
    expect(ok).toBe(true);
    expect([...map.get('merge')]).toEqual([`${O}/cli/merge.mjs`]);
    expect([...map.get('info')]).toEqual([`${O}/cli/view.mjs`]);
    expect(map.has('Use')).toBe(false);
  });

  it('the dispatch block of the real queue.mjs maps every branch', async () => {
    const fs = await import('node:fs');
    const text = fs.readFileSync(new URL('../../plugin/scripts/orchestrator/queue.mjs', import.meta.url), 'utf8');
    const { map, unmapped } = commandMap(text);
    expect(unmapped.size).toBe(0);
    expect([...map.get('merge')]).toEqual([`${O}/cli/merge.mjs`]);
    expect([...map.get('wiring')]).toEqual([`${O}/cli/wiring.mjs`]);
    // every import('./cli/x.mjs') in the file is in the map
    const imported = new Set([...text.matchAll(/import\('\.\/(cli\/[\w-]+\.mjs)'\)/g)].map((m) => `${O}/${m[1]}`));
    const mapped = new Set([...map.values()].flatMap((s) => [...s]));
    expect([...imported].filter((m) => !mapped.has(m))).toEqual([]);
  });

  it('scanCode: literal imports and requires, not comments; computed ones are reported', () => {
    const s = scanCode(
      [
        "// require('./commented.js')",
        "import a from './a.js';",
        "export * from './b.js';",
        "const c = require('./c.js');",
        'const d = await import(`./d.mjs`);',
        'const e = require(name);',
        "const re = /require\\('x'\\)/;",
        'obj.require(z);',
      ].join('\n'),
    );
    expect(s.specs).toEqual(['./a.js', './b.js', './c.js', './d.mjs']);
    expect(s.computed).toEqual(['require']);
  });

  it('lex: a template literal gives its text and the strings inside ${}', () => {
    const s = scanCode("const cmd = `node ${path.join(HERE, 'gates.mjs')} --task X`;");
    expect(s.strings).toEqual(expect.arrayContaining(['node ', 'gates.mjs', ' --task X']));
    expect(lex('a / b / c').filter((t) => t.t === 'regex')).toEqual([]);
  });

  it('readConfig and globToRegex follow the vitest include list', () => {
    const c = readConfig(repo().get('vitest.config.mjs'));
    expect(c.setupFiles).toEqual(['plugin/setup.mjs']);
    const re = globToRegex(c.include[0]);
    expect(re.test('plugin/x/__tests__/a.test.ts')).toBe(true);
    expect(re.test('plugin/x/__tests__/deep/a.test.mjs')).toBe(true);
    expect(re.test('plugin/x/__tests__/helper.ts')).toBe(false);
    expect(readConfig('nothing here')).toBe(null);
  });

  it('--gate: the base is QUEUE_GATE_BASE from gates.mjs; without it the whole suite (FULL), never a guess', () => {
    const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test-changed.mjs');
    const env = { ...process.env, RAVENSEAT_TEST_RUNS: 'off' };
    delete env.QUEUE_GATE_BASE;
    const none = spawnSync(process.execPath, [SCRIPT, '--gate', '--list'], { encoding: 'utf8', env });
    expect(none.status).toBe(0);
    expect(none.stdout).toMatch(/FULL: no gate base \(QUEUE_GATE_BASE\)/);
    const bogus = spawnSync(process.execPath, [SCRIPT, '--gate', '--list'], { encoding: 'utf8', env: { ...env, QUEUE_GATE_BASE: 'no-such-ref-x' } });
    expect(bogus.status).toBe(0);
    expect(bogus.stdout).toMatch(/FULL: git cannot give the change against no-such-ref-x/);
    // --gate takes its base from the environment only: a ref beside it is a usage error.
    expect(spawnSync(process.execPath, [SCRIPT, '--gate', 'main', '--list'], { encoding: 'utf8', env }).status).toBe(2);
  });

  it('parseNameStatus: a rename gives the old path as deleted and the new one as added', () => {
    expect(parseNameStatus('M\ta.js\nR100\told.js\tnew.js\nA\tb.js\n')).toEqual([
      { path: 'a.js', status: 'M' },
      { path: 'old.js', status: 'D' },
      { path: 'new.js', status: 'A' },
      { path: 'b.js', status: 'A' },
    ]);
  });
});
