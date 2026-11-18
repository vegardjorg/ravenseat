// =============================================================
// scopeNotes.test.ts: the reuse and scope facts at receive (lib/scopeNotes.js, bolk B1 of the scope drift plan).
//
// Locks: (1) V1 finds the new top-level and exported names a diff adds (JS/TS), skips test files, indented lines,
// moved names and the ignore list, and keeps only base hits that DEFINE the name in another file; (2) V2 names the
// shallowest new folder (depth 1 or 2) only for added files; (3) V3 reads the purpose table as data, each example in it
// behaves, and a new dependency with the same purpose as one the manifest already has is named (a version bump is not);
// (4) V5 says how many changed files lie outside owned_files, shared_patch and reads, and in which folders, and a task
// without ownership gets the folder count instead; (5) every part has its own switch, all on by default, and the output
// is NOTE lines and a package section, never a stop; (6) `receive` prints the lines and writes the "Reuse and scope"
// section, and the switches turn them off. The receive block runs queue.mjs against a temporary queue and git repo, as
// testWeakening.test.ts does. Never the main repo or the real queue.
// =============================================================
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const SN = require('../scopeNotes.js') as any;
const QC = require('../queueConfig.js') as any;
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

/** A unified diff for one added file. */
const addedFile = (file: string, lines: string[]) =>
  [
    `diff --git a/${file} b/${file}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${file}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((l) => `+${l}`),
    '',
  ].join('\n');

/** A unified diff for a changed file: `body` are hunk lines with their own marks (' ', '+', '-'). */
const changedFile = (file: string, body: string[], header = '') => {
  const old = body.filter((l) => !l.startsWith('+')).length;
  const neu = body.filter((l) => !l.startsWith('-')).length;
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -1,${old} +1,${neu} @@${header ? ` ${header}` : ''}`,
    ...body,
    '',
  ].join('\n');
};

describe('the setup', () => {
  it('every part is on by default, and STANDARD holds the same', () => {
    // The four facts on; the opt-in guards on top of drift (V6 driftGap, V7 driftWarn, bolk B7) off.
    const standard = { reuse: true, newFolders: true, dependencies: true, drift: true, ignoreNames: [], folderDepth: 2,
      driftGap: false, driftGapFiles: 4, driftGapShare: 40, driftWarn: false };
    expect(SN.setupOf({})).toEqual(standard);
    expect(QC.STANDARD.scopeNotes).toEqual(standard);
  });
  it('each part has its own switch; a wrong type is the default', () => {
    const s = SN.setupOf({ scopeNotes: { reuse: false, drift: 'no', folderDepth: 0, ignoreNames: ['norm', 3] } });
    expect(s.reuse).toBe(false);
    expect(s.drift).toBe(true);
    expect(s.folderDepth).toBe(2);
    expect(s.ignoreNames).toEqual(['norm']);
  });
  it('setupProblems names what is wrong, for doctor', () => {
    expect(SN.setupProblems(undefined)).toEqual([]);
    expect(SN.setupProblems({})).toEqual([]);
    expect(SN.setupProblems('on')).toEqual(['scopeNotes must be an object']);
    expect(SN.setupProblems({ reuse: 'yes', folderDepth: 9, ignoreNames: 'x' })).toEqual([
      'scopeNotes.reuse must be true or false',
      'scopeNotes.ignoreNames must be a list of names',
      'scopeNotes.folderDepth must be 1, 2 or 3',
    ]);
  });
});

describe('V1: new names that already exist', () => {
  it('finds top-level and exported definitions on added lines', () => {
    const diff = addedFile('lib/b.js', [
      "'use strict';",
      'const isObject = (v) => v !== null && typeof v === "object";',
      'function norm(p) {',
      '  const inner = (x) => x;',
      '  return p;',
      '}',
      'const LIMIT = 5;',
      'export async function loadAll() {}',
      'export const pick = function (x) { return x; };',
      'class Store {}',
      'exports.helper = () => 1;',
      'module.exports = {',
      '  isObject,',
      '  norm,',
      '  shout: (x) => x,',
      '  nested: {',
      '    deep: 1,',
      '  },',
      '};',
    ]);
    const names = SN.newNames(SN.parseDiff(diff)).map((n: { name: string }) => n.name);
    expect(names.sort()).toEqual(['Store', 'helper', 'isObject', 'loadAll', 'nested', 'norm', 'pick', 'shout']);
  });
  it('reads a new entry in an existing module.exports block from the hunk header', () => {
    const diff = changedFile('lib/a.js', ['   one,', '+  twoMore,', ' };'], 'module.exports = {');
    expect(SN.newNames(SN.parseDiff(diff)).map((n: { name: string }) => n.name)).toEqual(['twoMore']);
  });
  it('skips test files, other languages, short names, the built-in and the own ignore list, and moved names', () => {
    const diff = [
      addedFile('lib/__tests__/x.test.ts', ['const setupThing = () => 1;']),
      addedFile('docs/a.md', ['function looksLikeCode() {}']),
      addedFile('lib/c.js', ['function main() {}', 'const ab = () => 1;', 'function skipMe() {}', 'function movedOne() {}']),
      changedFile('lib/old.js', ['-function movedOne() {}', ' const keep = 1;']),
    ].join('');
    const names = SN.newNames(SN.parseDiff(diff), { ignoreNames: ['skipMe'] }).map((n: { name: string }) => n.name);
    expect(names).toEqual([]);
  });
  it('a definition on the base is a definition, a use is not', () => {
    expect(SN.isDefinitionOf('isObject', 'const isObject = (v) => v !== null;')).toBe(true);
    expect(SN.isDefinitionOf('isObject', '  const isObject = function (v) {')).toBe(true);
    expect(SN.isDefinitionOf('norm', 'function norm(p) {')).toBe(true);
    expect(SN.isDefinitionOf('norm', 'export function norm (p) {')).toBe(true);
    expect(SN.isDefinitionOf('Store', 'export default class Store extends Base {')).toBe(true);
    expect(SN.isDefinitionOf('helper', 'module.exports.helper = helper;')).toBe(true);
    expect(SN.isDefinitionOf('isObject', 'if (isObject(x)) return;')).toBe(false);
    expect(SN.isDefinitionOf('list', 'const list = [];')).toBe(false);
    // A parenthesis after = is a function only when an arrow follows (the trial on Ravenseat found this one).
    expect(SN.isDefinitionOf('list', '    const list = (panel.dismissed ?? []).filter((k) => k !== key);')).toBe(false);
    expect(SN.isDefinitionOf('list', '  const list = (dir) => {')).toBe(true);
    expect(SN.isDefinitionOf('pick', 'export const pick = <T,>(x: T): T => x;')).toBe(true);
    expect(SN.isDefinitionOf('load', 'const load = async (a: string): Promise<void> => {')).toBe(true);
    expect(SN.isDefinitionOf('wide', 'const wide = (')).toBe(true);
    expect(SN.isDefinitionOf('norm', 'const normal = (x) => x;')).toBe(false);
  });
  it('names the other files that define it, never the same file, a test file or a file the diff deletes', () => {
    const diff = [
      addedFile('lib/b.js', ['const isObject = (v) => !!v;', 'function freshName() {}']),
      ['diff --git a/lib/gone.js b/lib/gone.js', 'deleted file mode 100644', '--- a/lib/gone.js', '+++ /dev/null', '@@ -1 +0,0 @@', '-x', ''].join('\n'),
    ].join('');
    const base: Record<string, { file: string; line: number; text: string }[]> = {
      isObject: [
        { file: 'lib/a.js', line: 3, text: 'const isObject = (v) => v !== null;' },
        { file: 'lib/a.js', line: 40, text: '  if (isObject(x)) return;' },
        { file: 'lib/b.js', line: 1, text: 'const isObject = (v) => !!v;' },
        { file: 'lib/__tests__/a.test.ts', line: 2, text: 'const isObject = () => 1;' },
        { file: 'lib/gone.js', line: 9, text: 'const isObject = () => 1;' },
        { file: 'lib/c.js', line: 7, text: 'function isObject(v) {' },
      ],
    };
    const asked: string[][] = [];
    const facts = SN.reuseFacts(SN.parseDiff(diff), {
      // One look-up for all names (one git grep with an -e per name): the rows of every name come back together.
      findDefinitions: (names: string[]) => {
        asked.push(names);
        return names.flatMap((n) => base[n] ?? []);
      },
    });
    expect(asked).toEqual([['isObject', 'freshName']]);
    expect(facts).toEqual([{ name: 'isObject', file: 'lib/b.js', others: [{ file: 'lib/a.js', line: 3 }, { file: 'lib/c.js', line: 7 }] }]);
  });
  it('asks git once, for at most maxNames names, and not at all without a new name', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `function name${i}() {}`);
    const asked: string[][] = [];
    SN.reuseFacts(SN.parseDiff(addedFile('lib/many.js', lines)), { findDefinitions: (n: string[]) => (asked.push(n), []), maxNames: 30 });
    expect(asked.length).toBe(1);
    expect(asked[0].length).toBe(30);
    SN.reuseFacts(SN.parseDiff(addedFile('lib/none.js', ['const LIMIT = 5;'])), { findDefinitions: (n: string[]) => (asked.push(n), []) });
    expect(asked.length).toBe(1);
  });
  it('a row of one name never counts for another', () => {
    const diff = addedFile('lib/b.js', ['function norm(p) {}', 'function list() {}']);
    const facts = SN.reuseFacts(SN.parseDiff(diff), {
      findDefinitions: () => [
        { file: 'lib/a.js', line: 1, text: 'function norm(p) { return list(p); }' },
        { file: 'lib/c.js', line: 2, text: 'const x = norm(list);' },
      ],
    });
    expect(facts).toEqual([{ name: 'norm', file: 'lib/b.js', others: [{ file: 'lib/a.js', line: 1 }] }]);
  });
});

describe('V2: a new folder', () => {
  const have = new Set(['lib', 'lib/logic', 'docs']);
  const dirExists = (d: string) => have.has(d);
  it('names the shallowest folder that is not on the base, only for added files', () => {
    const diff = [
      addedFile('newmod/a.js', ['x']),
      addedFile('newmod/deep/b.js', ['x']),
      addedFile('lib/fresh/c.js', ['x']),
      addedFile('lib/logic/inner/d.js', ['x']),
      addedFile('lib/e.js', ['x']),
      addedFile('top.js', ['x']),
      changedFile('lib/changed/f.js', [' x']),
    ].join('');
    expect(SN.newFolderFacts(SN.parseDiff(diff), { dirExists })).toEqual([
      { folder: 'newmod', files: 2 },
      { folder: 'lib/fresh', files: 1 },
    ]);
  });
  it('depth 1 names only new top folders, depth 3 goes one deeper', () => {
    const diff = [addedFile('lib/fresh/c.js', ['x']), addedFile('lib/logic/inner/d.js', ['x'])].join('');
    expect(SN.newFolderFacts(SN.parseDiff(diff), { dirExists, depth: 1 })).toEqual([]);
    expect(SN.newFolderFacts(SN.parseDiff(diff), { dirExists, depth: 3 }).map((f: { folder: string }) => f.folder)).toEqual([
      'lib/fresh',
      'lib/logic/inner',
    ]);
  });
  it('a renamed file into a new folder counts; node_modules never does', () => {
    const diff = [
      'diff --git a/lib/x.js b/moved/x.js',
      'similarity index 100%',
      'rename from lib/x.js',
      'rename to moved/x.js',
      '',
      addedFile('node_modules/pkg/index.js', ['x']),
    ].join('\n');
    expect(SN.newFolderFacts(SN.parseDiff(diff), { dirExists })).toEqual([{ folder: 'moved', files: 1 }]);
  });
});

describe('V3: a new dependency with the same purpose', () => {
  it('the purpose table is data, and each example in it behaves', () => {
    expect(SN.PURPOSES.length).toBeGreaterThanOrEqual(8);
    for (const p of SN.PURPOSES) {
      expect(p.id, 'id').toMatch(/^[a-z-]+$/);
      expect(p.title, p.id).toBeTruthy();
      expect(p.examples?.hit?.length, `${p.id} hit examples`).toBeGreaterThan(0);
      expect(p.examples?.miss?.length, `${p.id} miss examples`).toBeGreaterThan(0);
    }
    expect(SN.exampleProblems()).toEqual([]);
  });
  it('a broken example is found', () => {
    const table = [{ id: 'date', title: 'dates', ecosystem: 'npm', packages: ['moment', 'dayjs'], examples: { hit: [['moment', 'zod']], miss: [] } }];
    expect(SN.exampleProblems(table)).toEqual(['date: the hit example moment + zod gives no note']);
  });
  const pkg = (deps: Record<string, string>, dev: Record<string, string> = {}) =>
    JSON.stringify({ name: 'x', version: '1.0.0', dependencies: deps, devDependencies: dev }, null, 2);
  it('names a new package.json dependency when the manifest already has one for the same job', () => {
    const facts = SN.dependencyFacts([
      { path: 'package.json', base: pkg({ moment: '^2.0.0', zod: '^3.0.0' }, { jest: '^29.0.0' }), tip: pkg({ moment: '^2.0.0', dayjs: '^1.11.0', zod: '^3.0.0', left: '1' }, { jest: '^29.0.0', vitest: '3.2.4' }) },
    ]);
    expect(facts).toEqual([
      { manifest: 'package.json', added: 'dayjs', purpose: 'date', title: 'dates and times', existing: ['moment'] },
      { manifest: 'package.json', added: 'vitest', purpose: 'test-runner', title: 'test runner', existing: ['jest'] },
    ]);
  });
  it('a version bump, a package with another purpose and a new manifest with one per job give nothing', () => {
    expect(
      SN.dependencyFacts([
        { path: 'package.json', base: pkg({ moment: '^2.0.0' }), tip: pkg({ moment: '^2.30.0', zod: '^3.0.0' }) },
        { path: 'app/package.json', base: null, tip: pkg({ axios: '^1.0.0' }) },
      ]),
    ).toEqual([]);
  });
  it('two new packages for the same job in one change are named too', () => {
    const facts = SN.dependencyFacts([{ path: 'package.json', base: pkg({}), tip: pkg({ axios: '^1.0.0', got: '^14.0.0' }) }]);
    expect(facts).toEqual([{ manifest: 'package.json', added: 'got', purpose: 'http', title: 'HTTP client', existing: ['axios'] }]);
  });
  it('requirements.txt is read as names, and an unreadable manifest gives nothing', () => {
    const facts = SN.dependencyFacts([
      { path: 'requirements.txt', base: 'requests==2.31.0\n# comment\n', tip: 'requests==2.31.0\nhttpx[http2]>=0.27\n' },
      { path: 'web/package.json', base: '{ not json', tip: pkg({ dayjs: '1' }) },
    ]);
    expect(facts).toEqual([{ manifest: 'requirements.txt', added: 'httpx', purpose: 'python-http', title: 'HTTP client', existing: ['requests'] }]);
  });
  it('isManifest knows package.json and requirements files, never under node_modules', () => {
    expect(SN.isManifest('package.json')).toBe(true);
    expect(SN.isManifest('apps/web/package.json')).toBe(true);
    expect(SN.isManifest('requirements-dev.txt')).toBe(true);
    expect(SN.isManifest('node_modules/x/package.json')).toBe(false);
    expect(SN.isManifest('package-lock.json')).toBe(false);
  });
});

describe('V5: drift in numbers', () => {
  const changed = ['lib/a.js', 'lib/b.js', 'docs/x.md', 'cli/y.mjs', 'cli/z.mjs', 'README.md'];
  it('counts the files outside owned_files, shared_patch and reads, and the folders the task does not name', () => {
    const d = SN.driftFacts(changed, { owned_files: ['lib/a.js'], shared_patch: ['README.md'], reads: ['docs/'] });
    expect(d).toEqual({ changed: 6, outside: 3, hasOwnership: true, folders: ['cli', 'lib'], unnamed: ['cli'] });
  });
  it('a folder entry and a glob cover their files; a migration in the block counts as owned', () => {
    const d = SN.driftFacts(['src/x/a.ts', 'src/x/b.ts', 'db/migrations/3601_a.sql'], { owned_files: ['src/x/*.ts'], migr_block: '3600-3609' }, {
      migrations: { folder: 'db/migrations', filePattern: '^(\\d+)_' },
    });
    expect(d.outside).toBe(0);
  });
  it('a task without ownership gets the folders it touches', () => {
    const d = SN.driftFacts(changed, {});
    expect(d).toEqual({ changed: 6, outside: 6, hasOwnership: false, folders: ['(root)', 'cli', 'docs', 'lib'], unnamed: [] });
  });
});

describe('the lines and the package section', () => {
  const diff = [
    addedFile('newmod/b.js', ['const isObject = (v) => !!v;']),
    changedFile('package.json', ['-  "dependencies": { "moment": "1" }', '+  "dependencies": { "moment": "1", "dayjs": "1" }']),
  ].join('');
  const io = {
    findDefinitions: (names: string[]) => (names.includes('isObject') ? [{ file: 'lib/a.js', line: 3, text: 'const isObject = (v) => v !== null;' }] : []),
    dirExists: (d: string) => d === 'lib',
    readFile: (side: string, p: string) =>
      p === 'package.json' ? JSON.stringify({ dependencies: side === 'base' ? { moment: '1' } : { moment: '1', dayjs: '1' } }) : null,
  };
  const task = { id: 'A', owned_files: ['newmod/b.js'] };
  const changedPaths = ['newmod/b.js', 'package.json'];

  it('one NOTE line per fact, never a stop', () => {
    const r = SN.assess({ diff, changedPaths, task, setup: SN.setupOf({}), io });
    const lines = SN.noteLines(r, { id: 'A' });
    expect(lines).toEqual([
      'NOTE reuse (A): isObject (new in newmod/b.js) is already defined in lib/a.js:3. Reuse it, or say in the report why it differs.',
      'NOTE new folder (A): newmod/ (1 file) is not on the base. A new module boundary is an architecture choice: was it an owner question?',
      'NOTE dependency (A): dayjs in package.json, and the project already has moment for dates and times.',
      'NOTE drift (A): 1 of 2 changed files is outside owned_files, shared_patch and reads, in 1 folder the task does not name (the root).',
    ]);
    expect(lines.every((l: string) => l.startsWith('NOTE '))).toBe(true);
  });
  it('the package section lists the same facts, and says none were found when the change is clean', () => {
    const r = SN.assess({ diff, changedPaths, task, setup: SN.setupOf({}), io });
    const section = SN.packageSection(r).join('\n');
    expect(section).toContain('## Reuse and scope');
    expect(section).toContain('`duplication`');
    expect(section).toContain('`scope-drift`');
    expect(section).toContain('- reuse: `isObject` (new in `newmod/b.js`) is already defined in `lib/a.js:3`');
    expect(section).toContain('- dependency: `dayjs` in `package.json`, the project already has `moment` (dates and times)');
    const clean = SN.assess({ diff: '', changedPaths: ['newmod/b.js'], task, setup: SN.setupOf({}), io });
    expect(SN.noteLines(clean, { id: 'A' })).toEqual([]);
    expect(SN.packageSection(clean).join('\n')).toContain('None found (checked: reuse, new folders, dependencies, drift).');
  });
  it('each switch turns its part off, and all off gives no section', () => {
    const off = SN.setupOf({ scopeNotes: { reuse: false, newFolders: false, dependencies: false, drift: false } });
    const r = SN.assess({ diff, changedPaths, task, setup: off, io });
    expect(SN.noteLines(r, { id: 'A' })).toEqual([]);
    expect(SN.packageSection(r)).toBeNull();
    const onlyDrift = SN.assess({ diff, changedPaths, task, setup: { ...off, drift: true }, io });
    expect(SN.noteLines(onlyDrift, { id: 'A' }).map((l: string) => l.split(' (')[0])).toEqual(['NOTE drift']);
  });
  it('a task without ownership in one folder gives no drift line; in two or more it gives the scope line', () => {
    const one = SN.assess({ diff: '', changedPaths: ['lib/a.js', 'lib/b.js'], task: { id: 'A' }, setup: SN.setupOf({}), io });
    expect(SN.noteLines(one, { id: 'A' })).toEqual([]);
    const two = SN.assess({ diff: '', changedPaths: ['lib/a.js', 'docs/b.md'], task: { id: 'A' }, setup: SN.setupOf({}), io });
    expect(SN.noteLines(two, { id: 'A' })).toEqual(['NOTE scope (A): the task names no files; the change touches 2 files in 2 folders (docs, lib).']);
  });
  it('at most five reuse lines at receive, the rest in the package', () => {
    const names = Array.from({ length: 7 }, (_, i) => `helper${i}`);
    const many = addedFile('lib/n.js', names.map((n) => `function ${n}() {}`));
    const rows = names.map((n, i) => ({ file: 'lib/old.js', line: i + 1, text: `function ${n}() {}` }));
    const r = SN.assess({ diff: many, changedPaths: ['lib/n.js'], task: { id: 'A', owned_files: ['lib/n.js'] }, setup: SN.setupOf({}), io: { ...io, findDefinitions: () => rows } });
    const lines = SN.noteLines(r, { id: 'A' });
    expect(lines.length).toBe(6);
    expect(lines[5]).toBe('NOTE reuse (A): and 2 more names (see 00-package.md).');
    expect(SN.packageSection(r).filter((l: string) => l.startsWith('- reuse:')).length).toBe(7);
  });
  it('M4: at receive the facts are one NOTE scope line with the counts and where the details are', () => {
    const r = SN.assess({ diff, changedPaths, task, setup: SN.setupOf({}), io });
    expect(SN.receiveLines(r, { id: 'A', cli: 'ravenseat' })).toEqual([
      "NOTE scope (A): 1 name the base already defines (reuse), 1 new folder, 1 dependency for a job the project already covers, 1 of 2 changed files outside the task's files (drift). " +
        'Facts for the reviewer, never a stop: each is in 00-package.md (Reuse and scope), or ravenseat receive A --all prints them.',
    ]);
    // --all gives the detail form, the same lines as noteLines.
    expect(SN.receiveLines(r, { id: 'A', cli: 'ravenseat', all: true })).toEqual(SN.noteLines(r, { id: 'A' }));
    // Every detail the summary leaves out is in the package section.
    const section = SN.packageSection(r).join('\n');
    expect(section).toContain('- reuse: `isObject`');
    expect(section).toContain('- new folder: `newmod/` (1 file), not on the base');
    expect(section).toContain('- dependency: `dayjs`');
    expect(section).toContain('- drift: 1 of 2 changed files is outside owned_files, shared_patch and reads');
  });
  it('M4: a single fact stays its full line, none gives no line, a task without files gets the folder count', () => {
    const off = SN.setupOf({ scopeNotes: { reuse: false, newFolders: false, dependencies: false, drift: false } });
    const onlyDrift = SN.assess({ diff, changedPaths, task, setup: { ...off, drift: true }, io });
    expect(SN.receiveLines(onlyDrift, { id: 'A' })).toEqual(SN.noteLines(onlyDrift, { id: 'A' }));
    expect(SN.receiveLines(onlyDrift, { id: 'A' })).toHaveLength(1);
    const clean = SN.assess({ diff: '', changedPaths: ['newmod/b.js'], task, setup: SN.setupOf({}), io });
    expect(SN.receiveLines(clean, { id: 'A' })).toEqual([]);
    const lite = SN.assess({ diff, changedPaths: ['newmod/b.js', 'package.json', 'docs/x.md'], task: { id: 'A' }, setup: SN.setupOf({}), io });
    expect(SN.receiveLines(lite, { id: 'A', cli: 'rs' })[0]).toMatch(
      /^NOTE scope \(A\): 1 name the base already defines \(reuse\), 1 new folder, 1 dependency for a job the project already covers, 3 files in 3 folders, the task names none \(scope\)\. .* rs receive A --all prints them\.$/,
    );
  });
  it('M4: seven reuse names are still one line at receive, and all seven in the package', () => {
    const names = Array.from({ length: 7 }, (_, i) => `helper${i}`);
    const many = addedFile('lib/n.js', names.map((n) => `function ${n}() {}`));
    const rows = names.map((n, i) => ({ file: 'lib/old.js', line: i + 1, text: `function ${n}() {}` }));
    const r = SN.assess({ diff: many, changedPaths: ['lib/n.js'], task: { id: 'A', owned_files: ['lib/n.js'] }, setup: SN.setupOf({}), io: { ...io, findDefinitions: () => rows } });
    const lines = SN.receiveLines(r, { id: 'A' });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^NOTE scope \(A\): 7 names the base already defines \(reuse\)\./);
    expect(SN.packageSection(r).filter((l: string) => l.startsWith('- reuse:')).length).toBe(7);
  });
  it('a failing lookup never throws: the part is skipped', () => {
    const bad = { ...io, findDefinitions: () => { throw new Error('git broke'); } };
    const r = SN.assess({ diff, changedPaths, task, setup: SN.setupOf({}), io: bad });
    expect(r.reuse).toEqual([]);
    expect(r.errors).toEqual(['reuse: git broke']);
  });
});

// ---- receive: the NOTE lines and the package section --------------------------------------------------------------

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const ID = ['-c', 'user.name=queue-test', '-c', 'user.email=queue-test@example.invalid'];
const temporary: string[] = [];
afterAll(() => {
  for (const m of temporary) fs.rmSync(m, { recursive: true, force: true });
});

describe('queue.mjs receive with the scope notes', () => {
  /** Task A on queue/A writes isObject again in a new folder and adds dayjs next to moment; `config` is queue.config.json. */
  const setup = (config: object, extra: string[] = []) => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-scope-'));
    temporary.push(folder);
    const repo = path.join(folder, 'repo');
    const scratch = path.join(folder, 'scratch');
    fs.mkdirSync(repo);
    fs.mkdirSync(scratch);
    const g = (args: string[]) =>
      execFileSync('git', ['-C', repo, ...ID, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const put = (file: string, text: string) => {
      fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
      fs.writeFileSync(path.join(repo, file), text);
      g(['add', '--', file]);
    };
    g(['init', '-q', '-b', 'main']);
    put('lib/a.js', "'use strict';\nconst isObject = (v) => v !== null && typeof v === 'object';\nmodule.exports = { isObject };\n");
    put('package.json', JSON.stringify({ name: 'p', dependencies: { moment: '^2.0.0' } }, null, 2) + '\n');
    g(['commit', '-q', '-m', 'start']);
    g(['switch', '-q', '-c', 'queue/A']);
    put('newmod/b.js', "'use strict';\nconst isObject = (v) => !!v;\nmodule.exports = { isObject };\n");
    put('package.json', JSON.stringify({ name: 'p', dependencies: { moment: '^2.0.0', dayjs: '^1.11.0' } }, null, 2) + '\n');
    g(['commit', '-q', '-m', 'track A']);
    g(['switch', '-q', 'main']);
    const task = {
      id: 'A',
      title: 'Task A',
      domain: 'dom-A',
      class: 'K',
      status: 'running',
      mission: 'The mission for A.',
      value: 5,
      content_min: 60,
      depends_on: [],
      waiting_on: [],
      owned_files: ['newmod/b.js'],
      started: '2026-01-01T00:00:00.000Z',
      branch: 'queue/A',
      migr_block: null,
      scratchpad: scratch,
    };
    fs.writeFileSync(
      path.join(folder, 'queue.json'),
      JSON.stringify({ created: task.started, limits: {}, next_migr: 3600, resolved: [], tasks: [task] }),
    );
    const configFile = path.join(folder, 'queue.config.json');
    fs.writeFileSync(configFile, JSON.stringify(config));
    fs.mkdirSync(path.join(scratch, 'A'), { recursive: true });
    fs.writeFileSync(
      path.join(scratch, 'A', 'track-result.md'),
      'RESULT status=DONE branch=queue/A commits=1 migr=- gates=OK probe=- ownerQuestions=0 edge=-\n',
    );
    const env = {
      ...process.env,
      QUEUE_FOLDER: folder,
      QUEUE_CONFIG: configFile,
      QUEUE_ROOT: folder,
      QUEUE_GIT: repo,
      QUEUE_TIME_LOG: path.join(folder, 'times.jsonl'),
      QUEUE_TRANSCRIPTS: path.join(folder, 'transcripts'),
    } as NodeJS.ProcessEnv;
    delete env.QUEUE_SCRATCHPAD;
    delete env.QUEUE_SESSION;
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'orchestrator', 'queue.mjs'), 'receive', 'A', ...extra], {
      encoding: 'utf8',
      env,
      cwd: folder,
    });
    const pkg = path.join(scratch, 'rev-A', '00-package.md');
    return { code: r.status, out: r.stdout ?? '', error: r.stderr ?? '', pkg: fs.existsSync(pkg) ? fs.readFileSync(pkg, 'utf8') : '' };
  };

  it('prints one NOTE scope line and writes every fact in the section (M4)', () => {
    const m = setup({});
    expect(m.error).toBe('');
    expect(m.code).toBe(0);
    expect(m.out).toContain(
      "NOTE scope (A): 1 name the base already defines (reuse), 1 new folder, 1 dependency for a job the project already covers, 1 of 2 changed files outside the task's files (drift).",
    );
    expect(m.out).toContain('receive A --all prints them.');
    expect(m.out.split(/\r?\n/).filter((l) => l.startsWith('NOTE '))).toHaveLength(1);
    expect(m.out).not.toContain('NOTE reuse');
    expect(m.pkg).toContain('## Reuse and scope');
    expect(m.pkg).toContain('- reuse: `isObject` (new in `newmod/b.js`) is already defined in `lib/a.js:2`');
    expect(m.pkg).toContain('- new folder: `newmod/` (1 file), not on the base');
    expect(m.pkg).toContain('- dependency: `dayjs` in `package.json`, the project already has `moment` (dates and times)');
    expect(m.pkg).toContain('- drift: 1 of 2 changed files is outside owned_files, shared_patch and reads');
  });
  it('--all prints the NOTE line of each fact and writes the section', () => {
    const m = setup({}, ['--all']);
    expect(m.error).toBe('');
    expect(m.code).toBe(0);
    expect(m.out).not.toContain('NOTE scope (A)');
    expect(m.out).toContain('NOTE reuse (A): isObject (new in newmod/b.js) is already defined in lib/a.js:2.');
    expect(m.out).toContain('NOTE new folder (A): newmod/ (1 file) is not on the base.');
    expect(m.out).toContain('NOTE dependency (A): dayjs in package.json, and the project already has moment for dates and times.');
    expect(m.out).toContain('NOTE drift (A): 1 of 2 changed files is outside owned_files, shared_patch and reads');
    expect(m.pkg).toContain('## Reuse and scope');
    expect(m.pkg).toContain('- reuse: `isObject` (new in `newmod/b.js`) is already defined in `lib/a.js:2`');
  });
  it('the switches turn the lines and the section off', () => {
    const m = setup({ scopeNotes: { reuse: false, newFolders: false, dependencies: false, drift: false } });
    expect(m.code).toBe(0);
    expect(m.out).not.toContain('NOTE reuse');
    expect(m.out).not.toContain('NOTE drift');
    expect(m.out).not.toContain('NOTE scope');
    expect(m.pkg).not.toContain('## Reuse and scope');
    expect(m.pkg).toContain('# Review package A');
  });
});
