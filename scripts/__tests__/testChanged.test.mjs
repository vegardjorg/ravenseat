// =============================================================
// testChanged.test.mjs: the pick of scripts/test-changed.mjs on a small fake repo (no git, no disk).
//
// Why: the pick decides which tests run after a change, so a hole in it lets a broken change through quietly. These
// tests pin each way a test can depend on a file (import, process by script name, command word through queue.mjs,
// helper, text read, data file, folder reader) and each rule that falls back to the whole suite.
// =============================================================
import { describe, expect, it } from 'vitest';
import { commandMap, globToRegex, lex, parseNameStatus, readConfig, scanCode, selectTests } from '../test-changed.mjs';

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
});

describe('the pick: FULL', () => {
  for (const f of ['vitest.config.mjs', 'package.json', 'package-lock.json', `${O}/queue.mjs`, `${O}/lib/queueLogic.js`, `${O}/cli/context.mjs`, 'plugin/setup.mjs']) {
    it(`${f} changed gives FULL with a reason`, () => {
      const r = pick([f]);
      expect(r.mode).toBe('full');
      expect(r.reason).toMatch(/changed/);
      expect(r.tests.length).toBe(r.total);
    });
  }

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

  it('parseNameStatus: a rename gives the old path as deleted and the new one as added', () => {
    expect(parseNameStatus('M\ta.js\nR100\told.js\tnew.js\nA\tb.js\n')).toEqual([
      { path: 'a.js', status: 'M' },
      { path: 'old.js', status: 'D' },
      { path: 'new.js', status: 'A' },
      { path: 'b.js', status: 'A' },
    ]);
  });
});
