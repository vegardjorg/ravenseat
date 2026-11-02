// =============================================================
// testWeakening.js: the test-weakening warning `receive` puts in the review package (config().testWeakening).
//
// WHY: a track that cannot make a test pass can get green by skipping it, focusing another one (.only runs nothing
// else), or deleting it. The merge guard protects the runner configs (protectedPaths); this module looks at the tests
// themselves. It only WARNS: a skip can be intended (a flaky test with an issue link), so the reviewers decide. The
// warning is one line in the receive output and a "Test weakening" section in 00-package.md.
//
// What counts (from the task branch's diff against the merge base, the same `git diff <base>...<branch>` receive writes
// to diff.patch):
//   - a deleted test file, and a test file renamed to a path that is no longer a test file (it stops running);
//   - a skip, focus or todo marker (MARKERS) on an ADDED line in a test file. Removed lines never count, and an added
//     line whose trimmed text was also removed somewhere in the diff is a move or a re-indent, not a new marker.
//     Rust tests live inline in src/, so every .rs file is read for #[ignore];
//   - the crude count: test files removed (deleted or moved out) against test files added (new or moved in).
//
// A test file (isTestFile): a name like *.test.*, *.spec.*, test_*.py, *_test.py, *_test.go, *_spec.rb, *Test.java …,
// or a code file under a __tests__/, tests/, test/ or spec/ folder at any depth (fixtures like .json there do not
// count). config().testWeakening.testPaths adds globs (mergeGuard.globMatch rules), .markers adds regular expressions.
//
// Pure logic without I/O; cli/merge.mjs (receive) passes the diff text. Test: lib/__tests__/testWeakening.test.ts.
// =============================================================
'use strict';

const { globMatch } = require('./mergeGuard.js');

/** File names that are tests in their ecosystem, at any depth. */
const TEST_NAMES = [
  /\.(test|spec)\.[^/]+$/i, // JS/TS (foo.test.ts, foo.spec.mjs), also foo.test.py-style names
  /^test_[^/]*\.py$/, // pytest
  /_test\.(py|go)$/, // pytest, go test
  /_spec\.rb$/, // RSpec
  /(Test|Tests|IT)\.(java|kt|scala|groovy)$/, // JUnit, Kotlin
  /(Test|Tests)\.(cs|php|swift)$/, // NUnit/xUnit, PHPUnit, XCTest
];
/** Folders whose code files are tests (a fixture .json or .txt there is not). */
const TEST_DIRS = ['__tests__', 'tests', 'test', 'spec', 'e2e'];
const CODE_EXT = /\.(m?[jt]sx?|cjs|cts|mts|py|go|rs|rb|java|kt|scala|groovy|cs|php|swift|ex|exs)$/i;

/**
 * The markers: family (shown to the reviewer), kind (skip, focus or todo) and the expression on one added line.
 * Kept narrow on purpose: each one is a test framework's own way to not run a test.
 */
const MARKERS = [
  { family: 'js .skip/.only', kind: 'skip', re: /\.(?:skip|skipIf)(?:\.each)?\s*[(`]/ },
  { family: 'js .skip/.only', kind: 'focus', re: /\.only(?:\.each)?\s*[(`]/ },
  { family: 'js .todo', kind: 'todo', re: /\b(?:it|test|describe)\.todo\s*\(/ },
  // The name string as the first argument: a bare fit(data) in a test file is a function call, not a focused test.
  { family: 'js xit/xdescribe', kind: 'skip', re: /(?:^|[^\w.$])x(?:it|describe|test|context)\s*\(\s*['"`]/ },
  { family: 'js fit/fdescribe', kind: 'focus', re: /(?:^|[^\w.$])f(?:it|describe)\s*\(\s*['"`]/ },
  // Jasmine pending() and RSpec `pending "reason"`; a 'pending' status string in an assertion is not one.
  { family: 'pending', kind: 'skip', re: /(?:^|[\s;{(])pending(?:\s*\(|\s+["'])/ },
  { family: 'pytest skip', kind: 'skip', re: /@pytest\.mark\.(?:skip|skipif|xfail)\b|\bpytest\.(?:skip|xfail)\s*\(/ },
  { family: 'unittest skip', kind: 'skip', re: /@unittest\.skip(?:If|Unless)?\b|\.skipTest\s*\(/ },
  { family: 'rust #[ignore]', kind: 'skip', re: /#\[ignore\b/ },
  { family: 'go t.Skip', kind: 'skip', re: /\b[tb]\.Skip(?:f|Now)?\s*\(/ },
  { family: 'junit @Disabled/@Ignore', kind: 'skip', re: /@(?:Disabled|Ignore)\b/ },
  { family: 'dotnet Ignore/Skip', kind: 'skip', re: /\[Ignore\b|\b(?:Fact|Theory)\s*\(\s*Skip\s*=/ },
  { family: 'phpunit markTestSkipped', kind: 'skip', re: /\bmarkTest(?:Skipped|Incomplete)\s*\(/ },
];

/** Common form of a path: forward slashes, no leading ./ */
function norm(p) {
  return String(p ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^(\.\/)+/, '');
}

/**
 * Is the path a test file?
 * @param {string} p
 * @param {string[]} [extra] more globs (config().testWeakening.testPaths)
 */
function isTestFile(p, extra = []) {
  const s = norm(p);
  if (!s || s.startsWith('node_modules/') || s.includes('/node_modules/')) return false;
  const name = s.split('/').pop();
  if (TEST_NAMES.some((re) => re.test(name))) return true;
  const dirs = s.split('/').slice(0, -1);
  if (CODE_EXT.test(name) && dirs.some((d) => TEST_DIRS.includes(d))) return true;
  return (extra ?? []).some((g) => globMatch(g, s));
}

/** Is a marker searched for in this file? Test files, and every .rs file (Rust unit tests live inline in src/). */
function markerFile(p, extra) {
  return isTestFile(p, extra) || /\.rs$/i.test(norm(p));
}

/** A path from a diff header: quotes removed (git quotes unusual names), the a/ or b/ prefix cut, /dev/null = none. */
function headerPath(raw, prefix) {
  let s = String(raw ?? '').replace(/\t.*$/, '').trim();
  if (s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1).replace(/\\(["\\])/g, '$1');
  if (s === '/dev/null') return null;
  if (prefix && s.startsWith(prefix)) s = s.slice(prefix.length);
  return norm(s);
}

/**
 * Parse a unified diff (`git diff`) into files: { from, to, status: 'A'|'D'|'M'|'R', added: [], removed: [] }.
 * Hunk lines are read by the hunk header's counts, so a removed line starting with "--" is never a file header.
 * @param {string} text
 */
function parseDiff(text) {
  const files = [];
  let f = null;
  let oldLeft = 0;
  let newLeft = 0;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (oldLeft > 0 || newLeft > 0) {
      const c = line.charAt(0);
      if (c === '+') {
        f.added.push(line.slice(1));
        newLeft--;
      } else if (c === '-') {
        f.removed.push(line.slice(1));
        oldLeft--;
      } else if (c === '\\') {
        // "\ No newline at end of file": no count
      } else {
        oldLeft--;
        newLeft--;
      }
      continue;
    }
    const start = line.match(/^diff --git (?:"?a\/(.+?)"? "?b\/(.+?)"?)$/);
    if (start || line.startsWith('diff --git ')) {
      f = { from: start ? norm(start[1]) : null, to: start ? norm(start[2]) : null, status: 'M', added: [], removed: [] };
      files.push(f);
      continue;
    }
    if (!f) continue;
    let m;
    if (line.startsWith('new file mode')) f.status = 'A';
    else if (line.startsWith('deleted file mode')) f.status = 'D';
    else if ((m = line.match(/^rename from (.+)$/))) {
      f.from = headerPath(m[1]);
      f.status = 'R';
    } else if ((m = line.match(/^rename to (.+)$/))) {
      f.to = headerPath(m[1]);
      f.status = 'R';
    } else if ((m = line.match(/^--- (.+)$/))) {
      const p = headerPath(m[1], 'a/');
      if (p) f.from = p;
    } else if ((m = line.match(/^\+\+\+ (.+)$/))) {
      const p = headerPath(m[1], 'b/');
      if (p) f.to = p;
    } else if ((m = line.match(/^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/))) {
      oldLeft = m[1] === undefined ? 1 : Number(m[1]);
      newLeft = m[2] === undefined ? 1 : Number(m[2]);
    }
  }
  for (const x of files) {
    if (x.status === 'A') x.from = null;
    if (x.status === 'D') x.to = null;
  }
  return files;
}

/** The extra markers from the config as { family, kind, re }; an invalid expression is left out (doctor reports it). */
function extraMarkers(list) {
  const out = [];
  for (const src of list ?? []) {
    try {
      out.push({ family: `custom /${src}/`, kind: 'skip', re: new RegExp(String(src)) });
    } catch {
      // setupProblems names it
    }
  }
  return out;
}

/**
 * Assess a diff.
 * @param {string} diffText the unified diff of <base>...<branch>
 * @param {{ testPaths?: string[], markers?: string[] }} [setup] config().testWeakening
 * @returns {{ deleted: { path: string, movedTo: string|null }[], markers: { path: string, family: string,
 *   kind: string, line: string }[], testsRemoved: number, testsAdded: number }}
 */
function assess(diffText, setup = {}) {
  const extra = setup?.testPaths ?? [];
  const markers = [...MARKERS, ...extraMarkers(setup?.markers)];
  const files = parseDiff(diffText);
  const deleted = [];
  let testsAdded = 0;
  for (const f of files) {
    const wasTest = f.from ? isTestFile(f.from, extra) : false;
    const isTest = f.to ? isTestFile(f.to, extra) : false;
    if (f.status === 'D' && wasTest) deleted.push({ path: f.from, movedTo: null });
    else if (f.status === 'R' && wasTest && !isTest) deleted.push({ path: f.from, movedTo: f.to });
    if ((f.status === 'A' && isTest) || (f.status === 'R' && isTest && !wasTest)) testsAdded++;
  }
  // Removed lines (trimmed) anywhere in the diff: an added line with the same text is a move, not a new marker.
  const removed = new Map();
  for (const f of files)
    for (const l of f.removed) {
      const t = l.trim();
      removed.set(t, (removed.get(t) ?? 0) + 1);
    }
  const found = [];
  for (const f of files) {
    if (!f.to || !markerFile(f.to, extra)) continue;
    for (const l of f.added) {
      const hit = markers.find((x) => x.re.test(l));
      if (!hit) continue;
      const t = l.trim();
      if ((removed.get(t) ?? 0) > 0) {
        removed.set(t, removed.get(t) - 1);
        continue;
      }
      found.push({ path: f.to, family: hit.family, kind: hit.kind, line: t.slice(0, 160) });
    }
  }
  return { deleted, markers: found, testsRemoved: deleted.length, testsAdded };
}

/** "1 skip marker" / "2 skip markers". */
const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The parts of the summary, empty when nothing was found. */
function parts(r) {
  const out = [];
  for (const kind of ['skip', 'focus', 'todo']) {
    const n = r.markers.filter((x) => x.kind === kind).length;
    if (n) out.push(count(n, `${kind} marker`));
  }
  const gone = r.deleted.filter((d) => !d.movedTo).length;
  const moved = r.deleted.length - gone;
  if (gone) out.push(count(gone, 'deleted test file'));
  if (moved) out.push(count(moved, 'test file moved out of the test paths'));
  return out;
}

/**
 * The one line for the receive output, or null when nothing was found.
 * @param {ReturnType<typeof assess>} r
 */
function summaryLine(r) {
  const p = parts(r);
  return p.length ? `WARN test weakening: ${p.join(', ')} (see 00-package.md)` : null;
}

/**
 * The "Test weakening" section for 00-package.md (markdown lines, starting with an empty line).
 * @param {ReturnType<typeof assess>} r
 * @param {{ max?: number }} [o] the most hits listed per kind
 */
function packageSection(r, { max = 30 } = {}) {
  const lines = ['', '## Test weakening', ''];
  const p = parts(r);
  if (!p.length) {
    lines.push('- None found: no deleted test files and no added skip or focus markers in test files.');
    return lines;
  }
  lines.push(
    `A warning, not a stop: ${p.join(', ')}. Test files removed ${r.testsRemoved}, added ${r.testsAdded}. ` +
      'Check that each one is intended (with a reason in the report), not a way to get the gates green.',
    '',
  );
  for (const d of r.deleted.slice(0, max))
    lines.push(d.movedTo ? `- moved out: \`${d.path}\` -> \`${d.movedTo}\`` : `- deleted: \`${d.path}\``);
  if (r.deleted.length > max) lines.push(`- … and ${r.deleted.length - max} more removed test files`);
  for (const x of r.markers.slice(0, max)) lines.push(`- ${x.kind} (${x.family}) in \`${x.path}\`: \`${x.line.replace(/`/g, "'")}\``);
  if (r.markers.length > max) lines.push(`- … and ${r.markers.length - max} more markers (see diff.patch)`);
  return lines;
}

/**
 * Value problems in config().testWeakening beyond the type check in doctor: markers that are not valid expressions.
 * @param {unknown} setup
 * @returns {string[]}
 */
function setupProblems(setup) {
  if (setup === undefined || setup === null) return [];
  if (typeof setup !== 'object' || Array.isArray(setup)) return ['testWeakening must be an object'];
  const out = [];
  for (const k of ['testPaths', 'markers'])
    if (setup[k] !== undefined && !(Array.isArray(setup[k]) && setup[k].every((x) => typeof x === 'string')))
      out.push(`testWeakening.${k} must be a list of strings`);
  if (Array.isArray(setup.markers))
    for (const src of setup.markers) {
      try {
        new RegExp(String(src));
      } catch {
        out.push(`testWeakening.markers has an invalid regular expression: ${src}`);
      }
    }
  return out;
}

module.exports = {
  MARKERS,
  isTestFile,
  parseDiff,
  assess,
  summaryLine,
  packageSection,
  setupProblems,
};
