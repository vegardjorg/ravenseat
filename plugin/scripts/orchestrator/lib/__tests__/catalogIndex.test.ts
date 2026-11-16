// =============================================================
// catalogIndex.test.ts: the generated index of the code's exports and the @shared building blocks (lib/catalogIndex.js,
// bolk B5 of the scope drift plan), `catalog find` and the near names for the reviewer (V1b).
//
// Locks: (1) the scan reads only top-level exports (ESM, exports.x, a module.exports block on one or many lines, an
// alias), never a name inside a function, a string, a template literal or a comment, and a regex literal with a quote or
// a backtick does not throw it off; (2) @shared in the JSDoc right above an exported definition gives a building block
// with its purpose (the first doc line when the tag has none); a tag on a name that is not exported is a problem, not a
// row; the text is one clean line; (3) the sha cache: a file whose blob sha is unchanged is not read again, also after a
// move, and git's blob sha is what blobSha gives; (4) find searches the index, the reuse rows, the design choices and
// the prefer lines, ranks a name hit above a text hit, and stops at the cap; (5) near names: the same words in another
// order, or one small edit in one word with the same first word; never the same name, never the same file, never a
// verb pair like get/set.
// Pure: no git, no files.
// =============================================================
import { describe, expect, it } from 'vitest';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const CI = require('../catalogIndex.js') as any;
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

const names = (r: any) => r.exports.map((e: any) => e.name);

describe('the scan: top-level exports only', () => {
  it('reads ESM exports and leaves the rest', () => {
    const src = [
      "import x from './x.js';",
      '/** Format a date for the UI. */',
      'export function formatDate(d) {',
      '  function inner() {}',
      '  return d;',
      '}',
      'export async function load() {}',
      'export const toDate = (s) => new Date(s);',
      'export const LIMIT = 5;',
      'export class Store {}',
      'export default function namedDefault() {}',
      'function local() {}',
      'export { local as publicLocal };',
      "export { other } from './other.js';",
      'export type Shape = { a: number };',
      'export interface Thing { a: number }',
    ].join('\n');
    const r = CI.scanSource(src);
    expect(names(r)).toEqual(['formatDate', 'load', 'toDate', 'LIMIT', 'Store', 'namedDefault', 'publicLocal']);
    expect(r.exports[0]).toMatchObject({ name: 'formatDate', line: 3, kind: 'function', doc: 'Format a date for the UI.' });
    expect(r.exports.find((e: any) => e.name === 'publicLocal')).toMatchObject({ line: 12, kind: 'function' });
  });

  it('reads CommonJS exports: a block over many lines, a block on one line, exports.x and an alias', () => {
    const many = [
      'const isObject = (v) => v !== null;',
      'function norm(p) { return p; }',
      'function helper() {',
      '  const inside = () => 1;',
      '  return { inside };',
      '}',
      'module.exports = {',
      '  isObject,',
      '  norm, helper,',
      '  renamed: helper,',
      '  method() { return 1; },',
      '  CONST: 3,',
      '};',
    ].join('\n');
    expect(names(CI.scanSource(many))).toEqual(['isObject', 'norm', 'helper', 'renamed', 'method', 'CONST']);
    expect(CI.scanSource(many).exports.find((e: any) => e.name === 'renamed')).toMatchObject({ line: 3, kind: 'function' });
    expect(names(CI.scanSource('function a() {}\nfunction b() {}\nmodule.exports = { a, b: a };\n'))).toEqual(['a', 'b']);
    expect(names(CI.scanSource('exports.one = function () {};\nmodule.exports.two = 2;\n'))).toEqual(['one', 'two']);
  });

  it('is not fooled by strings, template literals, comments and regex literals', () => {
    const src = [
      'const text = `',
      'export function fakeInTemplate() {}',
      '`;',
      "const re = /^`|`$/g; const q = /['\"]/;",
      '/*',
      'export function fakeInComment() {}',
      '*/',
      "const s = 'export function fakeInString() {}';",
      'export function real() { return `${text}`; }',
      'const half = 4 / 2; export const after = 1;',
    ].join('\n');
    expect(names(CI.scanSource(src))).toEqual(['real']);
  });
});

describe('@shared building blocks', () => {
  it('a tag above an exported definition gives the purpose; no text in the tag takes the first doc line', () => {
    const src = [
      '/**',
      ' * Match a path against a glob.',
      ' * @shared match a path against a glob pattern',
      ' * @param {string} g',
      ' */',
      'function globMatch(g, p) { return true; }',
      '/**',
      ' * Normalize a path: forward slashes.',
      ' * @shared',
      ' */',
      'export const normPath = (p) => p;',
      '/** @shared not exported */',
      'function secret() {}',
      'module.exports = { globMatch };',
    ].join('\n');
    const r = CI.scanSource(src);
    expect(r.shared).toEqual([
      { name: 'globMatch', line: 6, purpose: 'match a path against a glob pattern' },
      { name: 'normPath', line: 11, purpose: 'Normalize a path: forward slashes.' },
    ]);
    expect(r.problems).toEqual([expect.stringMatching(/secret.*line 13.*not exported/)]);
  });

  it('a doc with a blank line before the definition does not count, and the text is one clean line', () => {
    expect(CI.scanSource('/** @shared x */\n\nexport function f() {}\n').shared).toEqual([]);
    const r = CI.scanSource('/** @shared use `this`\u0007 <!-- hidden --> please */\nexport function f() {}\n');
    expect(r.shared[0].purpose).toBe('use this hidden please');
  });

  it('only code files outside node_modules and tests are indexed', () => {
    for (const p of ['lib/a.js', 'src/b.ts', 'app/c.tsx', 'x.mjs', 'y.cjs']) expect(CI.isIndexed(p), p).toBe(true);
    for (const p of ['lib/a.test.ts', 'node_modules/x/index.js', 'types/a.d.ts', 'README.md', 'lib/__tests__/a.ts'])
      expect(CI.isIndexed(p), p).toBe(false);
  });
});

describe('the sha cache', () => {
  it('git blob sha', () => {
    expect(CI.blobSha('hello\n')).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
  });

  it('reads only files with a new sha, also after a move', () => {
    const files: Record<string, string> = { 'lib/a.js': 'export function alpha() {}\n', 'lib/b.js': 'export function beta() {}\n' };
    const entries = () => Object.entries(files).map(([path, text]) => ({ path, sha: CI.blobSha(text) }));
    const reads: string[] = [];
    const read = (p: string) => {
      reads.push(p);
      return files[p] ?? null;
    };
    const first = CI.build({ entries: entries(), read, cache: null });
    expect(first.stats).toMatchObject({ files: 2, scanned: 2, reused: 0 });
    expect(reads).toEqual(['lib/a.js', 'lib/b.js']);
    reads.length = 0;
    files['lib/b.js'] = 'export function beta2() {}\n';
    files['lib/moved.js'] = files['lib/a.js'];
    delete files['lib/a.js'];
    const second = CI.build({ entries: entries(), read, cache: CI.parseIndex(JSON.stringify(first.index)) });
    expect(reads).toEqual(['lib/b.js']);
    expect(second.stats).toMatchObject({ files: 2, scanned: 1, reused: 1 });
    expect(Object.keys(second.index.files).sort()).toEqual(['lib/b.js', 'lib/moved.js']);
    expect(second.index.files['lib/moved.js'].exports[0].name).toBe('alpha');
  });

  it('a broken cache reads as empty', () => {
    for (const t of ['', 'nope', '[]', '{"version":9,"files":{}}', '{"version":1,"files":{"a.js":{"sha":"x"}}}'])
      expect(Object.keys(CI.parseIndex(t).files)).toEqual([]);
  });
});

const INDEX = () =>
  CI.build({
    entries: [
      { path: 'lib/dates.ts', sha: '1' },
      { path: 'lib/paths.js', sha: '2' },
    ],
    read: (p: string) =>
      p === 'lib/dates.ts'
        ? '/** @shared format a date for the UI */\nexport function formatDate() {}\n/** Turn text into a date. */\nexport function toDate() {}\n'
        : '/** @shared normalize a path */\nexport function normPath() {}\nexport function readFile() {}\nexport function getUser() {}\n',
    cache: null,
  }).index;

const CATALOG = {
  exists: true,
  stack: { prefer: [{ purpose: 'dates', use: 'dayjs, never moment' }] },
  reuse: { rows: [{ purpose: 'Parse a duration', symbol: 'parseDuration', file: 'src/time.ts', line: 5 }] },
  decisions: [
    { decision: { id: 'D-0001', title: 'Dates through one library', status: 'proposed', paths: ['lib/**'], invariant: 'Dates use dayjs only.' } },
  ],
};

describe('catalog find', () => {
  it('searches all four parts, a name hit first', () => {
    const r = CI.search({ index: INDEX(), catalog: CATALOG, query: 'date' });
    expect(r.rows.map((x: any) => `${x.kind}:${x.name}`)).toEqual([
      'shared:formatDate',
      'export:toDate',
      // The prefer line's job is its name; the design choice only has the word in its text.
      'prefer:dates',
      'decision:D-0001',
    ]);
    expect(CI.search({ index: INDEX(), catalog: CATALOG, query: 'duration' }).rows[0]).toMatchObject({ kind: 'reuse', name: 'parseDuration' });
    // Every word must match.
    expect(CI.search({ index: INDEX(), catalog: CATALOG, query: 'format ui' }).rows.map((x: any) => x.name)).toEqual(['formatDate']);
  });

  it('stops at the cap and says how many more', () => {
    const r = CI.search({ index: INDEX(), catalog: CATALOG, query: 'e', max: 2 });
    expect(r.rows).toHaveLength(2);
    expect(r.total).toBeGreaterThan(2);
    const lines = CI.findLines(r, { query: 'e', index: INDEX() });
    expect(lines.at(-1)).toMatch(/more/);
    expect(lines.length).toBeLessThanOrEqual(12);
  });

  it('no index and no catalog: nothing, and no crash', () => {
    expect(CI.search({ index: null, catalog: null, query: 'x' }).rows).toEqual([]);
  });
});

describe('near names (V1b)', () => {
  it('same words in another order, or one small edit with the same first word', () => {
    const hits = CI.nearNames(
      [
        { name: 'pathNorm', file: 'lib/new.js' },
        { name: 'readFiles', file: 'lib/new.js' },
        { name: 'setUser', file: 'lib/new.js' },
        { name: 'normPath', file: 'lib/other.js' },
        { name: 'formatDate', file: 'lib/dates.ts' },
      ],
      INDEX(),
    );
    // normPath is the same name (the reuse note's job, V1) and formatDate is the same file: neither is a near name.
    expect(hits.map((h: any) => `${h.name}~${h.other}`)).toEqual(['pathNorm~normPath', 'readFiles~readFile']);
    expect(hits[0]).toMatchObject({ otherFile: 'lib/paths.js', line: 2 });
  });

  it('at most max hits, and nothing without an index', () => {
    expect(CI.nearNames([{ name: 'pathNorm', file: 'x.js' }], null)).toEqual([]);
    expect(CI.nearNames([{ name: 'pathNorm', file: 'x.js' }, { name: 'readFiles', file: 'x.js' }], INDEX(), { max: 1 })).toHaveLength(1);
  });
});
