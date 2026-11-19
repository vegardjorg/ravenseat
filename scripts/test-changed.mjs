#!/usr/bin/env node
// =============================================================
// scripts/test-changed.mjs: runs only the test files a change can reach, and the whole suite when it cannot tell.
//
// Why: the whole suite (about 389 test files; a full run took about 40 minutes on 19.11.2026) still runs before every
// push; after a commit or a
// merge this picks the test files the change can affect. The rule is safety first: rather too many tests than too few,
// and the whole suite (FULL, with the reason) whenever the script cannot know.
//
// Why not `vitest related` / `--changed`: those follow the import graph only. About half the test files start
// queue.mjs, a hook or gates.mjs as a separate process instead of importing the code, and queue.mjs loads each command's
// module with `await import('./cli/<x>.mjs')` behind a check on the command word. The import graph does not see any of
// that. So this builds its own graph over the repo's text files, with these edges (A -> B: A depends on B):
//   - imports: `import ... from 'x'`, `import 'x'`, `export ... from 'x'`, `import('x')` and `require('x')` with a string
//     literal, and every other string literal starting with ./ or ../ that names a repo file (createRequire(...)('./lib/x.js'),
//     path strings). A relative path is tried from the file's own folder and from each folder above it, because cli/*.mjs
//     resolve `require('./lib/...')` from queue.mjs's folder (cli/context.mjs). An extra edge only adds tests.
//   - name mentions: a file that names another repo file by its base name (`'merge-track.mjs'`, `hook-push-guard.mjs`,
//     `'contextGuard.js'` in a path.join) depends on it. In source files only string literals count (a comment runs
//     nothing), and only in a source that starts processes (spawn, exec, fork) or reads files; in test files, test
//     helpers and shell shims the whole text counts. Three kinds of edge:
//       exec: the file runs or loads the other one; followed transitively.
//       read: a source that reads files but starts no process names another file; counts only when that file itself
//         changed (its text is the input), not for what that file depends on.
//       data: a json, html, css or yml file names a file; followed only for tests and helpers that read the data file.
//   - docs (md, txt, images outside plugin/scripts) are never followed through sources: a docs-only change picks only
//     the tests and helpers that read the repo's own copy of the doc, and otherwise reports "no tests affected". A base
//     name alone is not enough (TC-1): most tests name README.md or costs.md for a fixture they write in a temp folder.
//     The path an expression builds is evaluated over the file's tokens (pathValue, pathFacts): __dirname,
//     import.meta.url, process.cwd(), path.join/resolve, dirname, fileURLToPath, new URL(x, import.meta.url), template
//     strings, and the parameters of the file's own functions through their call sites. A doc counts when a read call
//     (read*, load*, open*, exists*, cat) or a folder listing gets a path that resolves to it or its folder, a repo
//     relative path string names it, or a base the file cannot see (an imported ROOT, an upper case name it does not
//     define) is joined with literals that fit the doc's path. A write call's path argument (writeFileSync, mkdir, git
//     add and the like) never counts, and nor does a base under a temp or fixture folder. When a base cannot be told,
//     the test is kept: safety first. The same test runs for the folder readers and the folder name rule below, when a
//     change is docs only, and a test file's own dependencies spread only to the files that import it or name it in a
//     string (not in a comment).
//   - the command map: queue.mjs's dispatch edges to cli/ are replaced by a map from command word to cli module (read
//     from the dispatch block). A file that names queue.mjs, or the `ravenseat` router (ravenseat.mjs, plugin/bin), depends
//     on queue.mjs itself and on the cli module of every command word it contains. A command word is a string literal
//     that is exactly one word, a word right after queue.mjs or ravenseat in a string, or (in tests) the first word of
//     a string, never a path part such as scripts/orchestrator. The router also runs any top-level
//     script by name or alias, so a file that names it depends on each script whose name appears in it as a word.
//   - folder readers: a test or helper that lists folders relative to itself (readdirSync, globSync, opendirSync,
//     `git ls-files`, or a require/import with a computed path) can read any file, so it is picked for every change.
//     A source file that lists folders relative to itself depends on every added, removed or renamed file and on every
//     non-code file (md, json, html) in its area (plugin/, bench/ or scripts/).
//   - files under __tests__ that are not tests (snapshots, fixtures): every test that names one of the folders between
//     __tests__ and the file is picked as well; the same for a non-code file outside __tests__ (a test that names 'docs'
//     or 'skills' as a path part reads that folder).
// A test file is picked when it changed itself or depends, transitively, on a changed file.
//
// FULL (the whole suite, with the reason) when a changed file is vitest.config.mjs, package.json, package-lock.json, a
// setup file from the config, queue.mjs, lib/queueLogic.js or cli/context.mjs (every command loads those); when an
// affected source file has an import()/require() with a computed argument (it can load anything); when the config's
// include list cannot be read; when git cannot give the change; or when the pick is over 60 % of the test files.
// Known seam, not FULL: `import(pathToFileURL(path.resolve(process.env.X)).href)` loads a module a test supplies
// (QUEUE_CI_GH, QUEUE_MERGE_RUNNING), never a repo file.
//
// Usage: npm run test:changed [-- <ref>] [--list]
//        node scripts/test-changed.mjs --stats [--days N]
//   <ref>   what to compare with (default origin/main): `git diff <ref>...HEAD` plus uncommitted changes (tracked and new)
//   --list  print the pick (one path per line) and do not run vitest
//   --stats the local test run log over the last N days (default 14): runs, full/some/none, median picked share, times
// Exit code: vitest's; 0 when no test is affected; 2 for a usage error.
//
// The run log (scripts/test-runs.mjs, setting testRuns.log, default on): every run, FULL and --list included, appends
// one JSON row to <dataFolder>/test-runs.jsonl (gitignored, capped): time, ref, mode, reason, picked, total, changed,
// pick_s, run_s, exit, tests, failed. The counts come from scripts/test-run-reporter.mjs through RAVENSEAT_TEST_RUN_OUT;
// the same reporter logs a plain `npm test`. A failure to log never changes the exit code.
//
// The pick is a pure function (selectTests) over a list of changed files and the repo's files with their text, so it is
// tested without git: scripts/__tests__/testChanged.test.mjs.
// =============================================================
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { appendRun, DEFAULT_DAYS, enabled, logPath, readRuns, runStats, statsLines } from './test-runs.mjs';

/** Over this share of the test files the pick is not worth it: run everything. */
export const FULL_SHARE = 0.6;

/** Changed files that every test depends on (or that change how the tests run). Paths from the repo root. */
const FULL_FILES = {
  'vitest.config.mjs': 'the vitest config',
  'package.json': 'package.json',
  'package-lock.json': 'package-lock.json',
  'plugin/scripts/orchestrator/queue.mjs': 'queue.mjs (the dispatch every command goes through)',
  'plugin/scripts/orchestrator/lib/queueLogic.js': 'lib/queueLogic.js (the facade every command loads)',
  'plugin/scripts/orchestrator/cli/context.mjs': 'cli/context.mjs (the shared state every command loads)',
};

const QUEUE = 'plugin/scripts/orchestrator/queue.mjs';
const ROUTER = 'plugin/scripts/orchestrator/ravenseat.mjs';
const ORCH = 'plugin/scripts/orchestrator';
const CLI_HELP = 'plugin/scripts/orchestrator/lib/cliHelp.js';

/** Code files: lexed for imports and string literals. */
const CODE_EXT = /\.(js|mjs|cjs|ts|tsx)$/;
/** Text files read whole for name mentions (data and shims). Markdown is not: docs name scripts but run nothing. */
const DATA_EXT = /\.(json|html|css|sh|cmd|yml|yaml)$/;
/** Files without an extension under a bin/ folder are shell shims. */
const SHIM = /(^|\/)bin\/[^/.]+$/;
/** Text that is never code: a change here alone affects only tests that read it. */
const DOC_EXT = /\.(md|txt|png|jpe?g|gif|svg|webp|ico)$/i;
/** A doc: text or an image outside plugin/scripts (where md files can be data the scripts read, e.g. review packs). */
const isDoc = (p) => DOC_EXT.test(p) && !p.startsWith('plugin/scripts/');
/** Resolution order for an import without an extension (TS helpers are imported as './redteam/project'). */
const RESOLVE_EXT = ['', '.ts', '.tsx', '.mjs', '.js', '.cjs', '.json', '/index.ts', '/index.mjs', '/index.js'];
/** Folder names too general to say "this test reads that folder". */
const GENERIC_DIRS = new Set(['plugin', 'bench', 'scripts', 'orchestrator', '__tests__', '.', '..', '']);
/** A test or helper that lists files, or loads a computed path. */
const LISTS_FILES = /\breaddirSync\s*\(|\breaddir\s*\(|\bglobSync\s*\(|\bopendirSync\s*\(|\bls-files\b/;
/** A source file that starts processes, or reads files (then a name in it can be what it runs or reads). */
// `exec(` alone is mostly RegExp.prototype.exec: it counts only as child_process's exec (not after a dot, module imported).
const RUNS_CALL = /\b(spawnSync|spawn|execFileSync|execFile|execSync|fork)\s*\(/;
const runsProcesses = (text) => RUNS_CALL.test(text) || (/child_process/.test(text) && /(^|[^.\w])exec\s*\(/m.test(text));
const READS = /\b(readFileSync|readFile|createReadStream|copyFileSync|cpSync|copyFile)\s*\(/;
const LOCATES_ITSELF = /__dirname|import\.meta|process\.cwd\(\)|\bHERE\b/;

// ---- Lexing --------------------------------------------------------------------------------------------------

/** Tokens after which a `/` starts a regular expression (not a division). */
const REGEX_AFTER_PUNC = new Set('( , = : [ ! & | ? { } ; + - * % < > ~ ^ =>'.split(' '));
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'instanceof', 'yield', 'await']);

/**
 * A small JS/TS lexer: enough to tell code from comments, strings, template literals and regular expressions.
 * Gives the tokens (id, str, tpl, punc). A template literal is one token: its value is the raw text and `interp` says
 * whether it has a ${...} part. It does not need to be exact: a misread only changes which strings are seen, and the
 * test text is matched whole anyway.
 */
export function lex(text) {
  const tokens = [];
  let i = 0;
  const n = text.length;
  const last = () => tokens[tokens.length - 1];
  const regexAllowed = () => {
    const t = last();
    if (!t) return true;
    if (t.t === 'punc') return REGEX_AFTER_PUNC.has(t.v);
    if (t.t === 'id') return REGEX_AFTER_WORD.has(t.v);
    return false;
  };
  while (i < n) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') {
      const e = text.indexOf('\n', i);
      i = e < 0 ? n : e;
    } else if (c === '/' && text[i + 1] === '*') {
      const e = text.indexOf('*/', i + 2);
      i = e < 0 ? n : e + 2;
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      let v = '';
      while (j < n && text[j] !== c && text[j] !== '\n') {
        if (text[j] === '\\') {
          v += text[j + 1] ?? '';
          j += 2;
        } else v += text[j++];
      }
      tokens.push({ t: 'str', v });
      i = j + 1;
    } else if (c === '`') {
      // Read to the closing backtick; ${...} parts are skipped with a brace count (strings inside them included).
      let j = i + 1;
      let v = '';
      let interp = false;
      while (j < n && text[j] !== '`') {
        if (text[j] === '\\') {
          v += text[j + 1] ?? '';
          j += 2;
        } else if (text[j] === '$' && text[j + 1] === '{') {
          interp = true;
          let depth = 1;
          j += 2;
          v += '${';
          while (j < n && depth > 0) {
            const d = text[j];
            if (d === '{') depth++;
            else if (d === '}') depth--;
            else if (d === "'" || d === '"' || d === '`') {
              // a quoted part inside ${}: copy it as is
              const q = d;
              v += text[j++];
              while (j < n && text[j] !== q) {
                if (text[j] === '\\') v += text[j++];
                v += text[j++] ?? '';
              }
            }
            if (depth > 0) v += text[j] ?? '';
            j++;
          }
          v += '}';
        } else v += text[j++];
      }
      tokens.push({ t: 'tpl', v, interp });
      i = j + 1;
    } else if (c === '/' && regexAllowed()) {
      let j = i + 1;
      let inClass = false;
      while (j < n && text[j] !== '\n') {
        if (text[j] === '\\') j += 2;
        else if (text[j] === '[') (inClass = true), j++;
        else if (text[j] === ']') (inClass = false), j++;
        else if (text[j] === '/' && !inClass) break;
        else j++;
      }
      j++;
      while (j < n && /[a-z]/i.test(text[j])) j++;
      tokens.push({ t: 'regex' });
      i = j;
    } else if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w$]/.test(text[j])) j++;
      tokens.push({ t: 'id', v: text.slice(i, j) });
      i = j;
    } else if (/\s/.test(c)) {
      i++;
    } else if (/\d/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w.]/.test(text[j])) j++;
      tokens.push({ t: 'num' });
      i = j;
    } else {
      const two = text.slice(i, i + 2);
      if (two === '=>') {
        tokens.push({ t: 'punc', v: '=>' });
        i += 2;
      } else {
        tokens.push({ t: 'punc', v: c });
        i++;
      }
    }
  }
  return tokens;
}

/**
 * The strings in a template literal: the text between the ${...} parts, and each quoted string inside them
 * (`node ${path.join(HERE, 'gates.mjs')}` gives "node ", "" and "gates.mjs").
 */
function templateParts(raw) {
  const out = [];
  let rest = raw;
  for (;;) {
    const i = rest.indexOf('${');
    if (i < 0) break;
    out.push(rest.slice(0, i));
    const e = rest.indexOf('}', i);
    const inner = rest.slice(i + 2, e < 0 ? rest.length : e);
    for (const m of inner.matchAll(/'([^']*)'|"([^"]*)"/g)) out.push(m[1] ?? m[2]);
    rest = e < 0 ? '' : rest.slice(e + 1);
  }
  out.push(rest);
  return out;
}

/** A literal module path: a quoted string, or a template literal without a ${...} part. */
const literal = (t) => t && (t.t === 'str' || (t.t === 'tpl' && !t.interp));

/**
 * What a code file says about its dependencies: the module specifiers (literal), the other string literals (for name
 * mentions), and every import()/require() whose argument is computed (except the known env seam).
 */
export function scanCode(text) {
  const tokens = lex(text);
  const specs = [];
  const strings = [];
  const computed = [];
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.t === 'str') strings.push(t.v);
    else if (t.t === 'tpl') strings.push(...templateParts(t.v));
    if (t.t !== 'id') continue;
    const prev = tokens[k - 1];
    const next = tokens[k + 1];
    if ((t.v === 'from' || t.v === 'import') && literal(next)) specs.push(next.v);
    if ((t.v === 'import' || t.v === 'require') && next?.t === 'punc' && next.v === '(') {
      if (prev?.t === 'punc' && prev.v === '.') continue; // obj.require(...): a method, not the loader
      if (prev?.t === 'id' && prev.v === 'function') continue; // a function that happens to be called require
      const arg = tokens[k + 2];
      if (literal(arg)) specs.push(arg.v);
      else if (!envSeam(tokens, k + 2)) computed.push(t.v);
    }
  }
  return { specs, strings, computed };
}

/** import(pathToFileURL(path.resolve(process.env.X)).href): a module the test names in an env variable. */
function envSeam(tokens, from) {
  const words = tokens.slice(from, from + 16).map((t) => t.v ?? '');
  const s = words.join(' ');
  return /^pathToFileURL \( path \. resolve \( process \. env \. [A-Z_]+ \) \) \. href \)/.test(s);
}

/**
 * Does a source list a folder found from its own location? Yes when a listing call's argument uses __dirname,
 * import.meta or a name defined (in this file, through any number of steps) from them, or HERE (cli/context.mjs).
 * Gives null (no), or { up }: up is the list of folder levels above the file's own folder that the calls list, when
 * every such call is only "own location plus '..' parts" (readdirSync(path.resolve(__dirname, '..')) gives [1],
 * readdirSync(HERE) gives [0]); up is null when a call adds anything else (then the caller assumes more).
 */
export function listsOwnFolder(text) {
  const located = new Set(['HERE', '__dirname']);
  const defs = [...text.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]*)/g)].map((m) => [m[1], m[2]]);
  for (let changedOne = true; changedOne; ) {
    changedOne = false;
    for (const [name, expr] of defs) {
      if (located.has(name)) continue;
      const ids = expr.match(/[A-Za-z_$][\w$]*/g) ?? [];
      if (/import\.meta/.test(expr) || ids.some((x) => located.has(x))) {
        located.add(name);
        changedOne = true;
      }
    }
  }
  let found = false;
  let up = [];
  for (const m of text.matchAll(/\b(?:readdirSync|readdir|globSync|opendirSync)\s*\(([^;\n]*)/g)) {
    const ids = m[1].match(/[A-Za-z_$][\w$]*/g) ?? [];
    if (!(/import\.meta/.test(m[1]) || ids.some((x) => located.has(x)))) continue;
    found = true;
    // the argument up to the call's closing parenthesis
    let depth = 1;
    let k = 0;
    for (; k < m[1].length && depth > 0; k++) depth += m[1][k] === '(' ? 1 : m[1][k] === ')' ? -1 : 0;
    const arg = m[1].slice(0, k);
    const strs = [...arg.matchAll(/'([^']*)'|"([^"]*)"/g)].map((x) => x[1] ?? x[2]);
    const plain = /^\s*(HERE|__dirname|path\.(resolve|join)\(\s*(HERE|__dirname)\s*(,\s*'\.\.'\s*)*\))\s*\)?\s*$/.test(arg);
    if (up && plain && strs.every((x) => x === '..')) up.push(strs.length);
    else up = null;
  }
  return found ? { up } : null;
}

// ---- Doc reads: does a test read THE REPO'S copy of a doc? ----------------------------------------------------
//
// Tests write files named README.md or docs/x.md into temp repos all the time, so "the test names README.md" says little.
// For a changed doc a test or helper counts only when a path in it can land on the repo's own file. The paths are
// evaluated over the lexer's tokens: __dirname, import.meta.url / dirname, process.cwd() (vitest runs from the repo root)
// and the consts built from them with path.join / resolve / dirname, new URL(x, import.meta.url), fileURLToPath and
// `${X}/...` templates. A value is one of:
//   { k: 'path', p }      a repo path (from the root, posix)
//   { k: 'tail', p }      folder p plus a part the code computes (join(DOCS, f)): any file under p
//   { k: 'unknown', lits } located somewhere in the repo, but not computable (an imported or undefined ROOT-like name,
//                         a path above the root); lits are the literal parts joined to it
//   { k: 'lit', v }       a plain string
//   null                  not a repo location (a temp folder, a parameter, p.repo)
// A lower-case name the file does not define (a parameter like `root`, a field like `p.repo`) is not the repo; an
// upper-case one (ROOT, PLUGIN_ROOT, HERE) or an imported name is "cannot tell", and that keeps picking.

/** Calls that take a path to read. A bare literal passed to one counts (cwd is the repo root, or a helper adds it). */
const READ_CALL = /^(read|load|open|cat|exists|slurp)/i;
/** Calls that list a folder. */
const LIST_CALL = /^(readdirSync|readdir|globSync|glob|opendirSync|opendir)$/;
/** Calls that write or set up a fixture: a literal passed straight to one is the test's own file. */
const WRITE_CALL = /^(write|append|put|commit|track|touch|mkdir|mk|rm|unlink|copy|cp|rename|symlink|link|add|seed|g|git)$|^(write|append|mkdir|copy|rename|symlink)/i;
/** Test framework calls: their literals are titles, not paths. */
const TEST_CALL = new Set(['it', 'test', 'describe', 'each', 'skip', 'only', 'todo', 'beforeAll', 'beforeEach', 'afterAll', 'afterEach']);
/** Keywords where a const's expression has surely ended (tokens carry no newlines). */
const STATEMENT_START = new Set(['const', 'let', 'var', 'function', 'class', 'export', 'import', 'if', 'for', 'while', 'return', 'it', 'test', 'describe', 'beforeAll', 'beforeEach', 'afterAll', 'afterEach', 'expect']);

const isP = (t, v) => t?.t === 'punc' && t.v === v;
/** Is the token at k the b of a.b (a member), not a name after a spread (...walk(d))? */
const afterDot = (tokens, k) => isP(tokens[k - 1], '.') && !(isP(tokens[k - 2], '.') && isP(tokens[k - 3], '.'));

/** The expression starting at k up to a depth-0 , ; or closing bracket (or a statement keyword): the end index. */
function exprEnd(tokens, k, stopAtKeyword = false) {
  let depth = 0;
  for (; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.t === 'punc') {
      if (t.v === '(' || t.v === '[' || t.v === '{') depth++;
      else if (t.v === ')' || t.v === ']' || t.v === '}') {
        if (depth === 0) break;
        depth--;
      } else if ((t.v === ',' || t.v === ';') && depth === 0) break;
    } else if (stopAtKeyword && depth === 0 && t.t === 'id' && STATEMENT_START.has(t.v)) break;
  }
  return k;
}

/** The arguments of the call whose '(' is at k: { args (token spans), end (after the ')') }. */
function argsAt(tokens, k) {
  const args = [];
  let i = k + 1;
  while (i < tokens.length && !isP(tokens[i], ')')) {
    const e = exprEnd(tokens, i);
    if (e > i) args.push(tokens.slice(i, e));
    if (!isP(tokens[e], ',')) {
      i = e;
      break;
    }
    i = e + 1;
  }
  return { args, end: i + 1 };
}

/**
 * The primary expression at k: a literal, a name chain (a.b.c), `new X(...)`, with calls and member accesses after it.
 * Gives { node, end } or null. Nodes: lit, tpl, name, call { callee, args (nodes) }, member { of, prop }, mixed.
 */
function primaryAt(tokens, k) {
  let isNew = false;
  if (tokens[k]?.t === 'id' && tokens[k].v === 'new') (isNew = true), k++;
  const t = tokens[k];
  if (!t) return null;
  let node;
  if (t.t === 'str') (node = { k: 'lit', v: t.v }), k++;
  else if (t.t === 'tpl') (node = t.interp ? { k: 'tpl', v: t.v } : { k: 'lit', v: t.v }), k++;
  else if (t.t === 'id') {
    let name = t.v;
    k++;
    while (isP(tokens[k], '.') && tokens[k + 1]?.t === 'id') (name += '.' + tokens[k + 1].v), (k += 2);
    node = { k: 'name', v: name };
  } else return null;
  for (;;) {
    if (isP(tokens[k], '(')) {
      const { args, end } = argsAt(tokens, k);
      const callee = node.k === 'name' ? (isNew ? 'new ' : '') + node.v : node.k === 'member' ? node.prop : '?';
      node = { k: 'call', callee, args: args.map(toNode), spans: args, of: node.k === 'member' ? node.of : null };
      isNew = false;
      k = end;
    } else if (isP(tokens[k], '.') && tokens[k + 1]?.t === 'id') {
      node = { k: 'member', of: node, prop: tokens[k + 1].v };
      k += 2;
    } else break;
  }
  return { node, end: k };
}

/** A token span as one node: a primary when it covers the whole span, else mixed (with its tokens). */
function toNode(span) {
  const p = primaryAt(span, 0);
  if (p && p.end === span.length) return p.node;
  return { k: 'mixed', span };
}

const PATH_JOIN = /^(path\.)?(posix\.|win32\.)?(join|resolve)$/;
const located = (v) => v && v.k !== 'lit';
/** A normalized repo path, or 'unknown' when it leaves the repo root. */
const norm = (p) => {
  const n = path.posix.normalize(p || '.');
  if (n === '.' || n === './') return '';
  if (n.startsWith('..')) return null;
  return n.replace(/^\.\//, '').replace(/\/$/, '');
};
const joinPath = (a, b) => (a ? `${a}/${b}` : b);

/** The parameter names of the list whose '(' is at k (destructured ones are skipped). */
function paramsAt(tokens, k) {
  const out = [];
  let depth = 0;
  for (let i = k; i < tokens.length; i++) {
    const t = tokens[i];
    if (isP(t, '(') || isP(t, '[') || isP(t, '{')) depth++;
    else if (isP(t, ')') || isP(t, ']') || isP(t, '}')) {
      if (--depth === 0) break;
    } else if (depth === 1 && t.t === 'id' && (isP(tokens[i - 1], '(') || isP(tokens[i - 1], ',') || isP(tokens[i - 1], '.'))) out.push(t.v);
  }
  return out;
}

/**
 * The path context of a code file: its defs (name -> token spans), its imported names, the parameters of its named
 * functions (name -> [{ fn, index }]) and its calls by simple name (name -> argument spans), so a walker's `dir` is
 * resolved through the calls that hand it a folder.
 */
function pathContext(text, file) {
  const tokens = Array.isArray(text) ? text : lex(text);
  const defs = new Map();
  const imported = new Set();
  const params = new Map();
  const calls = new Map();
  const addParams = (fn, k) => {
    paramsAt(tokens, k).forEach((p, index) => {
      if (!params.has(p)) params.set(p, []);
      params.get(p).push({ fn, index });
    });
  };
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.t !== 'id') continue;
    if (t.v === 'function' && tokens[k + 1]?.t === 'id' && isP(tokens[k + 2], '(')) addParams(tokens[k + 1].v, k + 2);
    else if (isP(tokens[k + 1], '(') && !afterDot(tokens, k) && !(tokens[k - 1]?.t === 'id' && tokens[k - 1].v === 'function')) {
      if (!calls.has(t.v)) calls.set(t.v, []);
      calls.get(t.v).push(argsAt(tokens, k + 1).args);
    }
    if ((t.v === 'const' || t.v === 'let' || t.v === 'var') && tokens[k + 1]?.t === 'id' && isP(tokens[k + 2], '=')) {
      const e = exprEnd(tokens, k + 3, true);
      const name = tokens[k + 1].v;
      // const walk = (d) => ..., const walk = async (d) => ..., const walk = function (d) ...
      let f = k + 3;
      if (tokens[f]?.t === 'id' && (tokens[f].v === 'async' || tokens[f].v === 'function')) f++;
      if (isP(tokens[f], '(')) {
        let depth = 0;
        let j = f;
        for (; j < tokens.length; j++) {
          if (isP(tokens[j], '(')) depth++;
          else if (isP(tokens[j], ')') && --depth === 0) break;
        }
        // a type annotation may sit between ) and =>
        if (tokens[f - 1]?.v === 'function' || tokens.slice(j + 1, j + 6).some((x) => isP(x, '=>') || isP(x, '{'))) addParams(name, f);
      }
      if (!defs.has(name)) defs.set(name, []);
      defs.get(name).push(tokens.slice(k + 3, e));
    } else if (t.v === 'import' && !isP(tokens[k + 1], '(')) {
      // import X from / import { a, b as c } from / import * as X from: every name up to `from`
      for (let j = k + 1; j < tokens.length && !(tokens[j].t === 'id' && tokens[j].v === 'from'); j++) {
        if (tokens[j].t === 'id' && tokens[j].v !== 'as' && tokens[j].v !== 'type') imported.add(tokens[j].v);
        if (tokens[j].t === 'str' || isP(tokens[j], ';')) break;
      }
    }
  }
  return { tokens, defs, imported, params, calls, file, memo: new Map() };
}

/**
 * The values one name can have (shadowed consts, a parameter's calls) as one: null when none is a repo location (a
 * temp folder: nothing of the repo to read), the location when all located ones agree, else "cannot tell". A value
 * that is not located adds nothing: that branch reads no repo file.
 */
function combine(vals) {
  const ls = vals.filter(located);
  if (!ls.length) return vals.find((x) => x?.k === 'lit') ?? null;
  const same = ls.every((x) => x.k === ls[0].k && x.p === ls[0].p && ls[0].k !== 'unknown');
  return same ? ls[0] : { k: 'unknown', lits: [] };
}

/** What the calls in this file hand a parameter: one value per call; [unknown] when its function has no call here. */
function paramValues(name, ctx, depth) {
  const vals = [];
  for (const { fn, index } of ctx.params.get(name) ?? []) {
    const sites = ctx.calls.get(fn) ?? [];
    if (!sites.length) return [{ k: 'unknown', lits: [] }];
    for (const args of sites) vals.push(args[index] ? evalNode(toNode(args[index]), ctx, depth + 1) : null);
  }
  return vals;
}

/**
 * paramValues for a walker's listing: the parameter counts as null while its calls are read, so the recursive call
 * (walk(join(d, e.name))) adds nothing; values worked out meanwhile are forgotten, as they assumed that null.
 */
function ownParamValues(name, ctx) {
  const saved = ctx.memo;
  ctx.memo = new Map([[name, null]]);
  try {
    return paramValues(name, ctx, 0);
  } finally {
    ctx.memo = saved;
  }
}

/** What a node points at (see the block above). */
function evalNode(node, ctx, depth = 0) {
  if (!node || depth > 40) return { k: 'unknown', lits: [] };
  switch (node.k) {
    case 'lit':
      return { k: 'lit', v: node.v };
    case 'name':
      return evalName(node.v, ctx, depth);
    case 'member':
      if (['href', 'pathname'].includes(node.prop)) return evalNode(node.of, ctx, depth + 1);
      return located(evalNode(node.of, ctx, depth + 1)) ? { k: 'unknown', lits: [] } : null;
    case 'tpl':
      return evalTemplate(node.v, ctx, depth);
    case 'mixed': {
      // a computed expression: located when any name or call in it is
      const lits = node.span.filter((t) => t.t === 'str').map((t) => t.v);
      for (let i = 0; i < node.span.length; i++) {
        if (afterDot(node.span, i)) continue; // the b of a.b is part of a chain read from a
        const p = primaryAt(node.span, i);
        if (p && p.node.k !== 'lit' && located(evalNode(p.node, ctx, depth + 1))) return { k: 'unknown', lits };
      }
      return null;
    }
    case 'call':
      break;
    default:
      return null;
  }
  const c = node.callee;
  const args = node.args;
  if (c === 'process.cwd') return { k: 'path', p: '' };
  if (PATH_JOIN.test(c)) {
    let acc = args.length ? evalNode(args[0], ctx, depth + 1) : null;
    // path.resolve('x') is from the cwd, which is the repo root under vitest
    if (acc?.k === 'lit' && /resolve$/.test(c)) acc = toRepoPath(acc.v);
    for (const a of args.slice(1)) {
      if (!acc) return null;
      const v = evalNode(a, ctx, depth + 1);
      if (v?.k === 'lit') {
        if (acc.k === 'path') {
          const n = norm(joinPath(acc.p, v.v));
          acc = n === null ? { k: 'unknown', lits: [v.v] } : { k: 'path', p: n };
        } else if (acc.k === 'lit') acc = { k: 'lit', v: path.posix.join(acc.v, v.v) };
        else acc = { ...acc, lits: [...(acc.lits ?? []), v.v] };
      } else if (acc.k === 'path') acc = { k: 'tail', p: acc.p };
      else if (acc.k === 'lit') return null;
    }
    return acc;
  }
  if (/(^|\.)dirname$/.test(c)) {
    const v = evalNode(args[0], ctx, depth + 1);
    if (v?.k === 'path') return { k: 'path', p: dirOf(v.p) };
    return located(v) ? { k: 'unknown', lits: [] } : null;
  }
  if (/(^|\.)(fileURLToPath|pathToFileURL|normalize)$/.test(c)) return evalNode(args[0], ctx, depth + 1);
  if (c === 'new URL') {
    const rel = evalNode(args[0], ctx, depth + 1);
    const baseV = args[1] ? evalNode(args[1], ctx, depth + 1) : null;
    if (baseV?.k === 'path' && rel?.k === 'lit') {
      const n = norm(joinPath(dirOf(baseV.p), rel.v));
      return n === null ? { k: 'unknown', lits: [rel.v] } : { k: 'path', p: n };
    }
    return located(baseV) ? { k: 'unknown', lits: rel?.k === 'lit' ? [rel.v] : [] } : null;
  }
  // any other call: what it returns is not a path this can follow (project(...) gives a temp repo). What it does with a
  // located argument is read in pathFacts (callLits, callVals).
  return null;
}

/** A literal from the cwd (the repo root under vitest) as a repo path; null when it leaves the root. */
function toRepoPath(v) {
  const n = norm(v);
  return n === null ? null : { k: 'path', p: n };
}

function evalName(name, ctx, depth) {
  const own = dirOf(ctx.file);
  if (name === '__dirname' || name === 'import.meta.dirname') return { k: 'path', p: own };
  if (name === '__filename' || name === 'import.meta.url' || name === 'import.meta.filename') return { k: 'path', p: ctx.file };
  const head = name.split('.')[0];
  if (name.includes('.')) {
    // a field (p.repo, h.scratch) of an object a call made is not the repo. Only when every def of the head is located
    // (an object literal of paths) is the field somewhere in it; a shadowed `p` that is once a path has no .folder.
    const heads = ctx.defs.get(head) ?? [];
    return heads.length && heads.every((span) => located(evalNode(toNode(span), ctx, depth + 1))) ? { k: 'unknown', lits: [] } : null;
  }
  if (ctx.memo.has(name)) return ctx.memo.get(name);
  if (ctx.defs.has(name)) {
    ctx.memo.set(name, null); // a cycle gives null
    const v = combine(ctx.defs.get(name).map((span) => evalNode(toNode(span), ctx, depth + 1)));
    ctx.memo.set(name, v);
    return v;
  }
  if (ctx.params.has(name)) {
    // a parameter of a named function: what its calls in this file hand it. A recursive call (walk(join(d, e.name)))
    // gives null and adds nothing; a function with no call here (exported, a callback) cannot tell.
    ctx.memo.set(name, null);
    const v = combine(paramValues(name, ctx, depth));
    ctx.memo.set(name, v);
    return v;
  }
  if (ctx.imported.has(name) || /^[A-Z][A-Z0-9_]*$/.test(name)) return { k: 'unknown', lits: [] };
  return null;
}

/** `${X}/a/b` and the like: the first ${...} part is the base, the text after it is joined; a later ${} is a tail. */
function evalTemplate(raw, ctx, depth) {
  const m = raw.match(/^\$\{([^}]*)\}([^$]*)(\$\{)?/);
  if (!m) return null;
  const inner = lex(m[1]);
  const p = primaryAt(inner, 0);
  const baseV = p && p.end === inner.length ? evalNode(p.node, ctx, depth + 1) : evalNode({ k: 'mixed', span: inner }, ctx, depth + 1);
  if (!located(baseV)) return null;
  const rest = m[2].replace(/^[/\\]+/, '');
  if (baseV.k === 'path') {
    if (m[3]) return { k: 'tail', p: norm(joinPath(baseV.p, rest.replace(/[/\\][^/\\]*$/, ''))) ?? baseV.p };
    const n = rest ? norm(joinPath(baseV.p, rest)) : baseV.p;
    return n === null ? { k: 'unknown', lits: [rest] } : { k: 'path', p: n };
  }
  return { ...baseV, lits: [...(baseV.lits ?? []), ...(rest ? [rest] : [])] };
}

/** For the tests: the value of an expression in a file with the given source. */
export function pathValue(src, expr, file) {
  const ctx = pathContext(src, file);
  const p = primaryAt(lex(expr), 0);
  return p ? evalNode(p.node, ctx) : null;
}

/**
 * What a test or helper can read, for the docs rule: the values of its path expressions (joins, URLs, templates, its
 * consts), the literals passed straight to a read call, the values its listing calls list, and the literals of other
 * calls that also get a located value (readDoc(ROOT, 'costs.md')).
 */
export function pathFacts(text, file) {
  const ctx = pathContext(text, file);
  const { tokens } = ctx;
  const values = [];
  const readLits = new Set();
  const listed = [];
  const callLits = [];
  const callVals = [];
  const written = new Set(); // the first token of each argument of a write call: a path there is the test's own file
  for (const name of ctx.defs.keys()) values.push(evalName(name, ctx, 0));
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.t === 'tpl' && t.interp && !written.has(t)) values.push(evalTemplate(t.v, ctx, 0));
    if (t.t !== 'id' || afterDot(tokens, k)) continue;
    const p = primaryAt(tokens, k);
    // every call in a chain: fs.readdirSync(DIR).filter(...) is a listing, then a filter
    const chain = [];
    for (let n = p?.node; n; n = n.of) if (n.k === 'call') chain.push(n);
    for (const node of chain) visitCall(node, t);
  }
  function visitCall(node, t) {
    const last = node.callee.slice(node.callee.lastIndexOf('.') + 1).replace(/^new /, '');
    if ((PATH_JOIN.test(node.callee) || node.callee === 'new URL') && !written.has(t)) values.push(evalNode(node, ctx));
    const vals = node.args.map((a) => evalNode(a, ctx));
    if (LIST_CALL.test(last)) {
      // a name this file does not define (a callback's `d`) can be handed the repo root: cannot tell.
      // A walker's parameter: each folder its calls hand it (scripts(orchestrator), scripts(repoScripts)), not one
      // combined value, so two known folders stay two known folders
      const a0 = node.args[0];
      const bare = a0?.k === 'name' && !a0.v.includes('.') && !ctx.defs.has(a0.v);
      // deep: the listing goes down into subfolders (a walker, { recursive: true }, a glob), so it can reach the
      // content below a folder it starts from
      const deep = /^glob/.test(last) || node.spans.slice(1).some((s) => s.some((x) => x.t === 'id' && x.v === 'recursive'));
      if (bare && ctx.params.has(a0.v)) listed.push(...ownParamValues(a0.v, ctx).filter(located).map((v) => ({ ...v, deep: true })));
      else if (bare) listed.push({ k: 'unknown', lits: [], deep: true });
      else if (vals[0]) listed.push({ ...vals[0], deep });
    } else if (READ_CALL.test(last)) {
      if (vals[0]?.k === 'lit') readLits.add(vals[0].v);
      else if (vals[0]) values.push(vals[0]);
    } else if (WRITE_CALL.test(last)) {
      for (const s of node.spans) if (s[0]) written.add(s[0]);
    } else if (!TEST_CALL.has(last) && !PATH_JOIN.test(node.callee) && vals.some(located)) {
      // a helper handed a repo location and a name (readDoc(ROOT, 'costs.md'), check(DOCS)): it may read them
      callLits.push(vals.filter((v) => v?.k === 'lit').map((v) => v.v));
      callVals.push(...vals.filter(located));
    }
  }
  // git ls-files over the whole tree: as an argument (['ls-files']) or a command with no path after it
  const lsFiles = scanCode(text).strings.some((s) => s === 'ls-files' || /(^|\s)ls-files(\s+-[-\w=]+)*\s*$/.test(s));
  return { values: values.filter(located), readLits, listed, callLits, callVals, lsFiles };
}

const under = (p, folder) => folder === '' || p === folder || p.startsWith(folder + '/');
/** Do the literal parts fit a repo path? Every segment (not . or ..) is one of the path's, and there is at least one. */
const litsFit = (lits, p) => {
  const segs = lits.flatMap((l) => String(l).split(/[/\\]/)).filter((s) => s && s !== '.' && s !== '..');
  const have = new Set(p.split('/'));
  return segs.length > 0 && segs.every((s) => have.has(s));
};
/** A repo-relative path to p (at least one folder: docs/costs.md, plugin/docs/costs.md) in the text. */
function namesRepoPath(text, p) {
  const segs = p.split('/');
  for (let i = 0; i < segs.length - 1; i++) {
    const tail = segs.slice(i).join('/');
    if (new RegExp(`(^|[^\\w.-])${escapeRe(tail)}(?![\\w-])`).test(text)) return true;
  }
  return false;
}

/** Does this test or helper read the repo's file p (a doc)? See the block above. */
function readsDoc(facts, text, file, p, exists) {
  const b = base(p);
  if (namesRepoPath(text, p)) return true;
  // a relative literal that resolves to the file (from the file's folder or one above it)
  const { strings } = scanCode(text);
  for (const s of strings) if (/^\.\.?\//.test(s) && s.endsWith(b) && resolve(file, s, (x) => x === p || exists(x)).includes(p)) return true;
  for (const v of facts.values) {
    if (v.k === 'path' && v.p === p) return true;
    if (v.k === 'tail' && under(p, v.p)) return true;
    if (v.k === 'unknown' && v.lits.some((l) => base(String(l).replace(/\\/g, '/')) === b) && litsFit(v.lits, p)) return true;
  }
  // a bare literal passed to a read call: from the cwd (the repo root) or through a helper that adds a folder
  for (const l of facts.readLits) if (base(l) === b && (l === b || norm(l) === p)) return true;
  if (facts.callLits.some((lits) => lits.includes(b))) return true;
  return false;
}

/** Does this test or helper read the folder of p (it names one of its folder names)? */
function readsDocFolder(facts, text, p) {
  const dir = dirOf(p);
  // the folder itself by its repo path with at least two parts (plugin/docs, not plugin/docs/other.md: that names a
  // sibling file, which readsDoc handles); a bare 'docs' is too common in fixtures
  if (dir.includes('/') && new RegExp(`(^|[^\\w.-])${escapeRe(dir)}(?![\\w-]|/[\\w.-])`).test(text)) return true;
  for (const v of facts.values) {
    // join(DOCS, f): any file there. A DOCS const only joined with literals reads exactly those (readsDoc).
    if (v.k === 'tail' && under(dir, v.p)) return true;
    if (v.k === 'unknown' && litsFit(v.lits, dir)) return true;
  }
  // the folder handed to a helper (check(DOCS)), or its name with a repo location (readDoc(ROOT, 'docs', f))
  if (facts.callVals.some((v) => (v.k === 'path' || v.k === 'tail') && v.p === dir)) return true;
  const folderNames = dir.split('/').filter((x) => !GENERIC_DIRS.has(x));
  return facts.callLits.some((lits) => lits.some((l) => folderNames.includes(l)));
}

/**
 * Can this folder reader see the doc p? git ls-files does; so does a listing of p's own folder, of a place it cannot
 * compute (unless the literal parts name another folder: join(CLIENT, 'board') is never plugin/docs or above it), and
 * of a folder above p's when it goes down into subfolders. A flat listing of a folder above p's shows only the folder's
 * name, so it changes only when p is added or removed (status not M).
 */
function listsDocFolder(facts, p, status = 'M') {
  if (facts.lsFiles) return true;
  const dir = dirOf(p);
  return facts.listed.some((v) => {
    if (!v || v.k === 'lit') return false;
    if (v.k === 'unknown') return !v.lits.length || litsFit(v.lits, dir);
    if (!under(dir, v.p)) return false;
    return v.p === dir || v.k === 'tail' || v.deep || status !== 'M';
  });
}

// ---- The repo model ------------------------------------------------------------------------------------------

/** The vitest include globs and setup files, read from the config text. Null when they cannot be read. */
export function readConfig(text) {
  if (typeof text !== 'string') return null;
  const block = (name) => {
    const m = text.match(new RegExp(`\\b${name}\\s*:\\s*\\[([^\\]]*)\\]`));
    return m ? [...m[1].matchAll(/'([^']+)'|"([^"]+)"/g)].map((x) => x[1] ?? x[2]) : null;
  };
  const include = block('include');
  if (!include?.length) return null;
  return { include, setupFiles: block('setupFiles') ?? [] };
}

/** A vitest glob (with ** , * and {a,b}) as a regular expression on a repo path. */
export function globToRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      // **/ matches zero or more folders
      if (glob[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else {
        re += '.*';
        i++;
      }
    } else if (c === '*') re += '[^/]*';
    else if (c === '{') {
      const e = glob.indexOf('}', i);
      re += '(?:' + glob.slice(i + 1, e).split(',').map(escapeRe).join('|') + ')';
      i = e;
    } else re += escapeRe(c);
  }
  return new RegExp('^' + re + '$');
}
const escapeRe = (s) => s.replace(/[.+?^$()|[\]\\]/g, '\\$&');

/** The base name of a repo path. */
const base = (p) => p.slice(p.lastIndexOf('/') + 1);
const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
/** The area a file belongs to (plugin, bench, scripts or the root). */
const area = (p) => (p.includes('/') ? p.split('/')[0] : '');
/**
 * Words in a text (identifiers and command words like owner-log). A word that is part of a path (the folder
 * scripts/orchestrator/, cli/merge.mjs) is not a command word, so a word next to / or \ or before a file extension
 * does not count.
 */
/** File-name-like tokens in a text: name.ext, cut at / \ quotes and spaces. */
const namesIn = (text) => new Set(text.match(/[A-Za-z0-9_][A-Za-z0-9_.-]*\.[A-Za-z0-9]+/g) ?? []);

/**
 * The command words in a file's string literals: a string that is one word ([Q, 'merge'], q('start', id)), the word
 * after queue.mjs or ravenseat in a command line (`node ${Q} start A`, 'ravenseat merge --task A'), and, for a test (firstWord),
 * the first word of any string (a helper's run('start A') or a template part " start A").
 */
export function commandWords(strings, { firstWord = false } = {}) {
  const out = new Set();
  for (const t of strings) {
    if (/^[a-z][\w-]*$/.test(t)) out.add(t);
    for (const m of t.matchAll(/(?:queue\.mjs|ravenseat(?:\.mjs|\.cmd)?)["'`]?\s+([a-z][\w-]*)/g)) out.add(m[1]);
    if (firstWord) {
      const m = t.match(/^[\s"'`]*([a-z][\w-]*)/);
      if (m) out.add(m[1]);
    }
  }
  return out;
}

/**
 * The command map from queue.mjs's dispatch block: command word -> cli module paths. A branch that loads a module
 * without a literal command word is returned in `unmapped` (its module is then reached by every file that names
 * queue.mjs).
 */
export function commandMap(queueText) {
  const map = new Map();
  const unmapped = new Set();
  const start = queueText.search(/\bif \(command === /);
  if (start < 0) return { map, unmapped, ok: false };
  const branches = queueText.slice(start).split(/\}\s*else\s+if\s*\(|\}\s*else\s*\{/);
  for (const b of branches) {
    const words = [...b.matchAll(/command\s*===\s*'([\w-]+)'/g)].map((m) => m[1]);
    const mods = [...b.matchAll(/import\(\s*'\.\/(cli\/[\w-]+\.mjs)'\s*\)/g)].map((m) => `${ORCH}/${m[1]}`);
    for (const mod of mods) {
      if (!words.length) unmapped.add(mod);
      for (const w of words) {
        if (!map.has(w)) map.set(w, new Set());
        map.get(w).add(mod);
      }
    }
  }
  return { map, unmapped, ok: map.size > 0 };
}

/** The router's aliases (lib/cliHelp.js ALIASES): alias -> script name. */
function routerAliases(text) {
  const m = text?.match(/const ALIASES\s*=\s*\{([^}]*)\}/);
  const out = new Map();
  if (!m) return out;
  for (const x of m[1].matchAll(/([\w-]+)\s*:\s*'([\w-]+)'/g)) out.set(x[1], x[2]);
  return out;
}

/**
 * The pick.
 * changed: [{ path, status }] (status A, M, D or R; paths from the repo root with /). files: Map path -> text (null for a
 * file whose text is not needed, e.g. an image). Gives { mode: 'full' | 'some' | 'none', reason, tests, total, why }.
 * `why` maps each picked test to one short reason.
 */
export function selectTests({ changed, files, maxShare = FULL_SHARE }) {
  const all = [...files.keys()];
  const config = readConfig(files.get('vitest.config.mjs'));
  if (!config) return full('the include list in vitest.config.mjs cannot be read', []);
  const includeRes = config.include.map(globToRegex);
  const isTest = (p) => includeRes.some((r) => r.test(p));
  const tests = all.filter(isTest).sort();
  const underTests = (p) => /(^|\/)__tests__\//.test(p);
  const isCode = (p) => CODE_EXT.test(p);
  const setupFiles = new Set(config.setupFiles.map((s) => s.replace(/^\.\//, '')));

  // 1. FULL by file
  for (const c of changed) {
    if (FULL_FILES[c.path]) return full(`${FULL_FILES[c.path]} changed`, tests);
    if (setupFiles.has(c.path)) return full(`the setup file ${c.path} changed`, tests);
  }
  const changedTests = changed.filter((c) => isTest(c.path) && c.status !== 'D').map((c) => c.path);
  const changedOther = changed.filter((c) => !isTest(c.path));
  if (!changedOther.length) {
    return result(changedTests, tests, new Map(changedTests.map((t) => [t, 'changed'])), 'only test files changed', maxShare);
  }

  // 2. The graph: deps.get(A) = set of B that A depends on.
  const byBase = new Map();
  for (const p of all) {
    const b = base(p);
    if (!byBase.has(b)) byBase.set(b, []);
    byBase.get(b).push(p);
  }
  // Changed paths that no longer exist (deleted, the old side of a rename) can still be named.
  for (const c of changed) {
    if (!files.has(c.path)) {
      const b = base(c.path);
      if (!byBase.has(b)) byBase.set(b, []);
      byBase.get(b).push(c.path);
    }
  }
  const exists = (p) => files.has(p);
  const deps = new Map();
  const dataDeps = new Map(); // data file -> the files it names (followed only for tests that read the data file)
  const addDataDep = (a, b) => {
    if (a === b) return;
    if (!dataDeps.has(a)) dataDeps.set(a, new Set());
    dataDeps.get(a).add(b);
  };
  const readDeps = new Map(); // source -> the files whose text it reads (not followed further)
  const addReadDep = (a, b) => {
    if (a === b) return;
    if (!readDeps.has(a)) readDeps.set(a, new Set());
    readDeps.get(a).add(b);
  };
  const addDep = (a, b) => {
    if (a === b) return;
    if (!deps.has(a)) deps.set(a, new Set());
    deps.get(a).add(b);
  };
  const computedIn = new Map(); // source file -> the loader word with a computed argument
  const treeReaderTests = new Set();
  const treeReaderSources = new Set();
  const sourceStrings = new Map(); // folder-reading source -> its string literals
  const ownFolderReaders = new Map(); // source -> folder levels it lists (null: unknown), for listings from its own location

  const queueText = files.get(QUEUE);
  const cm = typeof queueText === 'string' ? commandMap(queueText) : { map: new Map(), unmapped: new Set(), ok: false };
  if (typeof queueText === 'string' && !cm.ok) return full('the dispatch block in queue.mjs cannot be read', tests);
  const aliases = routerAliases(files.get(CLI_HELP));
  // Top-level scripts the router can start by name: name -> path.
  const scripts = new Map();
  for (const p of all) {
    if (dirOf(p) === ORCH && p.endsWith('.mjs') && !base(p).startsWith('hook-')) scripts.set(base(p).slice(0, -4), p);
  }
  for (const [alias, name] of aliases) if (scripts.has(name)) scripts.set(alias, scripts.get(name));

  /**
   * The edges a text gives through names: base names, queue.mjs and the router with their command words.
   * `prose`: the texts are one source file's (or json file's) string literals. A file named inside a sentence ("see
   * cli/merge.mjs", "the rules are in docs/queue.md") is a hint to the reader: nothing runs or reads it. So a string
   * counts only when it has no spaces (a path or an argument), or, for a code file, when it is a command line that
   * starts node (`node ${HERE}/gates.mjs --task X`).
   * `use`: what the source file can do with a name: { runs } (it starts processes) and { reads } (it reads files). A
   * source that does neither cannot depend on a code file by its name (a label like by: 'merge.mjs'), and only a source
   * that starts processes runs queue.mjs or the router with a command word.
   */
  const mentionEdges = (p, texts, wordSource, prose = false, use = { runs: true, reads: true }) => {
    // A data file (json, html, css, yml) runs nothing itself: what it names is followed only for a test that reads it
    // (see dataDeps below), not for a source that reads it as settings.
    // A source that reads files but starts no process reads what it names as text (cliHelp.js reads a script's head
    // comment): it depends on that file's text, not on what that file loads (addReadDep).
    const edge = !(isCode(p) || SHIM.test(p)) ? addDataDep : prose && !use.runs ? addReadDep : addDep;
    const names = new Set();
    for (const t of texts) {
      const isPath = !/\s/.test(t);
      const isNodeCommand = /(^|[\s"'`])node(\.exe)?[\s"']/.test(t);
      for (const n of namesIn(t)) if (!prose || isPath || (isNodeCommand && !DOC_EXT.test(n))) names.add(n);
    }
    for (const n of names) {
      if (!use.runs && !use.reads && CODE_EXT.test(n)) continue;
      for (const target of byBase.get(n) ?? []) edge(p, target);
    }
    if (!use.runs) return;
    const namesQueue = names.has('queue.mjs');
    const namesRouter = names.has('ravenseat.mjs') || names.has('ravenseat.cmd') || texts.some((t) => /bin['"`]?\s*[,/]\s*['"`]?ravenseat\b/.test(t));
    if (!namesQueue && !namesRouter) return;
    const words = new Set();
    // The command words: from string literals only, in the forms a command is given in (commandWords). A test's
    // titles and comments are full of words like "start", "next" and "show" that run nothing.
    for (const w of commandWords(wordSource, { firstWord: !prose })) words.add(w);
    if (exists(QUEUE)) edge(p, QUEUE);
    for (const w of words) for (const mod of cm.map.get(w) ?? []) edge(p, mod);
    for (const mod of cm.unmapped) edge(p, mod);
    if (namesRouter) {
      if (exists(ROUTER)) edge(p, ROUTER);
      for (const w of words) if (scripts.has(w)) edge(p, scripts.get(w));
    }
  };

  for (const p of all) {
    const text = files.get(p);
    if (typeof text !== 'string') continue;
    const inTests = underTests(p);
    if (isCode(p)) {
      const { specs, strings, computed } = scanCode(text);
      for (const s of specs) for (const target of resolve(p, s, exists)) addDep(p, target);
      for (const s of strings) {
        if (/^\.\.?\//.test(s)) for (const target of resolve(p, s.split(/[?#]/)[0], exists)) addDep(p, target);
      }
      if (inTests) {
        // tests and helpers: the whole text counts (a comment or a computed string may still name what it runs)
        mentionEdges(p, [text], strings);
        if ((LISTS_FILES.test(text) || computed.length) && LOCATES_ITSELF.test(text)) treeReaderTests.add(p);
        else if (computed.length) treeReaderTests.add(p);
      } else {
        // the dispatch's own edges are the command map, not a dependency of queue.mjs on every cli module
        mentionEdges(p, strings, strings, true, { runs: runsProcesses(text), reads: READS.test(text) });
        if (computed.length) computedIn.set(p, computed[0]);
        if (LISTS_FILES.test(text) && LOCATES_ITSELF.test(text)) {
          treeReaderSources.add(p);
          sourceStrings.set(p, strings);
          const own = listsOwnFolder(text);
          if (own) ownFolderReaders.set(p, own.up);
        }
      }
    } else if (/\.json$/.test(p)) {
      // json: its string values, with the same rule as a source's strings (hooks.json's commands start node)
      const { strings } = scanCode(text);
      mentionEdges(p, strings, strings, true);
    } else if (DATA_EXT.test(p) || SHIM.test(p)) {
      mentionEdges(p, [text], [text]);
    }
  }
  if (deps.has(QUEUE)) for (const d of [...deps.get(QUEUE)]) if (d.startsWith(`${ORCH}/cli/`) && d !== `${ORCH}/cli/context.mjs`) deps.get(QUEUE).delete(d);

  // Folder readers in the source: they depend on added/removed files and non-code files in their area.
  const listingChanges = changed.filter((c) => (c.status !== 'M' || !isCode(c.path)) && !isDoc(c.path));
  // Which folders: the reader's own folder and the one above it (readdirSync(HERE), path.resolve(__dirname, '..')), and
  // every folder whose name is a string or a path part in it (path.join(PLUGIN_ROOT, 'docs'), 'checks-catalog/rules').
  // An import path ('./lib/x.js') names a file to load, not a folder to list, so it does not count.
  for (const s of treeReaderSources) {
    const strings = (sourceStrings.get(s) ?? []).filter((t) => !/^\.\.?\//.test(t) && !CODE_EXT.test(t));
    const own = dirOf(s);
    for (const c of listingChanges) {
      if (area(c.path) !== area(s)) continue;
      // An added or removed code file changes only a listing of the code folders, which a source does with a path
      // from its own location (readdirSync(HERE)); a listing of a folder it was handed (a parameter, a runtime folder)
      // is about data, not about the repo's code.
      if (isCode(c.path) && !ownFolderReaders.has(s)) continue;
      const d = dirOf(c.path);
      const up = ownFolderReaders.get(s);
      if (isCode(c.path) && up) {
        // the exact folders it lists: its own (0), the one above (1), ...
        if (up.some((n) => d === Array.from({ length: n }).reduce((x) => dirOf(x), own))) addDep(s, c.path);
        continue;
      }
      const named = d
        .split('/')
        .filter((x) => !GENERIC_DIRS.has(x))
        .some((x) => strings.some((t) => t === x || t.split(/[/\\]/).includes(x)));
      if (d === own || d === dirOf(own) || named) addDep(s, c.path);
    }
  }

  // 3. Reverse closure from the changed files.
  const rev = new Map();
  for (const [a, bs] of deps) for (const b of bs) {
    if (!rev.has(b)) rev.set(b, new Set());
    rev.get(b).add(a);
  }
  const reason = new Map(); // affected file -> the changed file it reaches
  const queue = [];
  const parent = new Map(); // affected file -> the file it depends on one step closer to the change (for the reason)
  // Docs (md, images) outside plugin/scripts are not followed through the source (the owner's rule: a docs change
  // affects only the tests that read docs, below). Everything else starts the walk.
  const changedDocs = changedOther.filter((c) => isDoc(c.path)).map((c) => c.path);
  for (const c of changedOther) {
    if (isDoc(c.path)) continue;
    reason.set(c.path, c.path);
    queue.push(c.path);
  }
  // A source that reads a changed file's text is affected (and then everything that loads it), but reading a file
  // that is only affected through its own imports changes nothing for the reader.
  const changedSet = new Set(changedOther.filter((c) => !isDoc(c.path)).map((c) => c.path));
  for (const [a, bs] of readDeps) {
    if (reason.has(a)) continue;
    const hit = [...bs].find((b) => changedSet.has(b));
    if (hit) {
      reason.set(a, hit);
      parent.set(a, hit);
      queue.push(a);
    }
  }
  while (queue.length) {
    const x = queue.shift();
    for (const a of rev.get(x) ?? []) {
      if (!reason.has(a)) {
        reason.set(a, reason.get(x));
        parent.set(a, x);
        queue.push(a);
      }
    }
  }
  /** The chain from an affected file to the change, short names: "a -> b -> changed". */
  const chain = (p) => {
    const out = [];
    for (let x = parent.get(p); x; x = parent.get(x)) out.push(base(x));
    return out.join(' -> ');
  };
  // A data file that names an affected file (hooks.json names the hook scripts) affects the tests and helpers that read
  // it directly, and the tests that use those helpers; a source that reads it as settings is not affected through it.
  const viaData = new Map(); // test or helper -> the data file it reads that names an affected file
  for (const [d, named] of dataDeps) {
    const hit = [...named].find((x) => reason.has(x));
    if (!hit) continue;
    for (const a of rev.get(d) ?? []) if (underTests(a) && !reason.has(a) && !viaData.has(a)) viaData.set(a, `${base(d)} names ${base(hit)}`);
  }
  // A changed doc: the tests and helpers that name it and have a path that can land on the repo's file (readsDoc: a
  // README.md written into a temp repo, or a fixture folder's docs/x.md, is the test's own file). Not code: as before.
  const facts = new Map();
  const factsOf = (a) => {
    if (!facts.has(a)) facts.set(a, pathFacts(files.get(a) ?? '', a));
    return facts.get(a);
  };
  const codeText = (a) => isCode(a) && typeof files.get(a) === 'string';
  for (const d of changedDocs) {
    for (const a of rev.get(d) ?? []) {
      if (!underTests(a) || reason.has(a) || viaData.has(a)) continue;
      if (codeText(a) && !readsDoc(factsOf(a), files.get(a), a, d, exists)) continue;
      viaData.set(a, `reads ${d}`);
    }
  }
  // A helper passes this on to everything that depends on it. A test file passes it on only to a file that imports it or
  // names it in a string (runs it): "as in queueFocusB17.test.ts" in a comment loads nothing.
  const loads = (t, h) => {
    const text = files.get(t);
    if (typeof text !== 'string' || !isCode(t)) return true;
    const { specs, strings } = scanCode(text);
    return specs.some((s) => resolve(t, s, exists).includes(h)) || strings.some((s) => namesIn(s).has(base(h)));
  };
  for (const [h, why] of [...viaData]) {
    const users = isTest(h) ? [...(rev.get(h) ?? [])].filter((t) => loads(t, h)) : [h];
    for (const u of users) for (const t of u === h ? dependents(h, rev) : [u, ...dependents(u, rev)]) if (!viaData.has(t)) viaData.set(t, `uses ${base(h)}: ${why}`);
  }

  // A computed import()/require() in an affected source file: it can load anything.
  for (const [p, word] of computedIn) if (reason.has(p)) return full(`${p} has a ${word}() with a computed argument (cannot be followed)`, tests);

  const why = new Map();
  for (const t of changedTests) why.set(t, 'changed');
  for (const t of tests) if (!why.has(t) && reason.has(t)) why.set(t, `depends on ${reason.get(t)}: ${chain(t)}`);
  for (const [t, w] of viaData) if (isTest(t) && !why.has(t)) why.set(t, `reads data: ${w}`);
  // A folder reader is picked for every change, except a docs-only one: then only when it can list a changed doc's folder
  // (listsDocFolder: a listing of the orchestrator's own folder never reaches plugin/docs).
  const onlyDocs = changedOther.every((c) => isDoc(c.path));
  const docStatus = new Map(changedOther.map((c) => [c.path, c.status]));
  const readerFits = (h) => !onlyDocs || !codeText(h) || changedDocs.some((d) => listsDocFolder(factsOf(h), d, docStatus.get(d)));
  for (const t of treeReaderTests) if (isTest(t) && !why.has(t) && readerFits(t)) why.set(t, 'reads folders of the repo');
  // A helper under __tests__ that reads folders passes that on to the tests that import it.
  for (const h of treeReaderTests) if (!isTest(h) && readerFits(h)) for (const t of dependents(h, rev)) if (isTest(t) && !why.has(t)) why.set(t, `uses ${base(h)}, which reads folders`);
  // Non-code files (and files under __tests__ that are not tests): tests that name one of their folders. For a doc the
  // test must also have a path that can reach that folder (readsDocFolder): 'docs' is a common fixture folder name.
  for (const c of changedOther) {
    if (isCode(c.path) && !underTests(c.path)) continue;
    const parts = dirOf(c.path).split('/');
    const from = underTests(c.path) ? parts.lastIndexOf('__tests__') + 1 : 1;
    const dirs = parts.slice(from).filter((d) => !GENERIC_DIRS.has(d));
    if (!dirs.length) continue;
    const re = new RegExp(`(['"\`/])(${dirs.map(escapeRe).join('|')})(['"\`/])`);
    for (const t of tests) {
      if (why.has(t) || !re.test(files.get(t) ?? '')) continue;
      if (isDoc(c.path) && codeText(t) && !readsDocFolder(factsOf(t), files.get(t), c.path)) continue;
      why.set(t, `names the folder of ${c.path}`);
    }
  }
  return result([...why.keys()], tests, why, onlyDocs ?'docs only: no code affected, running the tests that read these files' : null, maxShare);
}

/** Every file that depends (transitively) on h: one walk over the reverse edges. */
function dependents(h, rev) {
  const seen = new Set([h]);
  const stack = [h];
  while (stack.length) {
    for (const a of rev.get(stack.pop()) ?? []) if (!seen.has(a)) seen.add(a), stack.push(a);
  }
  seen.delete(h);
  return seen;
}

/**
 * The repo files a relative specifier can mean: tried from the file's folder and each folder above it (see the head),
 * each with the usual extensions. Bare specifiers (node:fs, vitest) give nothing.
 */
function resolve(from, spec, exists) {
  if (!/^\.\.?\//.test(spec)) return [];
  const out = [];
  let dir = dirOf(from);
  for (;;) {
    const joined = path.posix.normalize(path.posix.join(dir || '.', spec));
    if (!joined.startsWith('..')) {
      for (const ext of RESOLVE_EXT) {
        if (exists(joined + ext)) {
          out.push(joined + ext);
          break;
        }
      }
    }
    if (!dir) break;
    dir = dirOf(dir);
  }
  return out;
}

function full(reason, tests) {
  return { mode: 'full', reason, tests: tests ?? [], total: tests?.length ?? 0, why: new Map() };
}

function result(picked, tests, why, note, maxShare = FULL_SHARE) {
  const sorted = [...new Set(picked)].sort();
  if (tests.length && sorted.length > maxShare * tests.length) {
    return full(`the pick is ${sorted.length} of ${tests.length} test files (over ${Math.round(maxShare * 100)} %)`, tests);
  }
  if (!sorted.length) return { mode: 'none', reason: note ?? 'no test file is affected', tests: [], total: tests.length, why };
  return { mode: 'some', reason: note ?? summary(why), tests: sorted, total: tests.length, why };
}

/** One short "why" for the headline: the counts per kind of reason. */
function summary(why) {
  const kinds = new Map();
  for (const r of why.values()) {
    const k = r === 'changed' ? 'changed' : r.startsWith('depends on') ? 'reach a changed file' : r.startsWith('names the folder') ? 'name a changed folder' : 'read folders';
    kinds.set(k, (kinds.get(k) ?? 0) + 1);
  }
  return [...kinds].map(([k, v]) => `${v} ${k}`).join(', ');
}

// ---- The command ---------------------------------------------------------------------------------------------

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function git(args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}

/** Parses `git diff --name-status` output (renames give both sides: the old one as D, the new one as A). */
export function parseNameStatus(out) {
  const rows = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [st, a, b] = line.split('\t');
    if (st.startsWith('R') || st.startsWith('C')) {
      if (st.startsWith('R')) rows.push({ path: a, status: 'D' });
      rows.push({ path: b, status: 'A' });
    } else rows.push({ path: a, status: st[0] === 'A' || st[0] === 'D' ? st[0] : 'M' });
  }
  return rows;
}

/** The changed files against ref: committed since the merge base, plus uncommitted (tracked and new). Null on error. */
function changedFiles(ref) {
  const committed = git(['diff', '--name-status', '-M', `${ref}...HEAD`]);
  const uncommitted = git(['diff', '--name-status', '-M', 'HEAD']);
  const untracked = git(['ls-files', '--others', '--exclude-standard']);
  if (committed === null || uncommitted === null || untracked === null) return null;
  const byPath = new Map();
  for (const r of [...parseNameStatus(committed), ...parseNameStatus(uncommitted)]) byPath.set(r.path, r);
  for (const p of untracked.split('\n').filter(Boolean)) byPath.set(p, { path: p, status: 'A' });
  return [...byPath.values()];
}

/** The repo's files (tracked and new, not ignored) with the text of the ones the pick reads. */
function repoFiles() {
  const listed = git(['ls-files', '--cached', '--others', '--exclude-standard']);
  if (listed === null) return null;
  const files = new Map();
  for (const p of new Set(listed.split('\n').filter(Boolean))) {
    const abs = path.join(ROOT, p);
    if (!fs.existsSync(abs)) continue; // deleted in the work tree, not yet committed
    const wanted = CODE_EXT.test(p) || DATA_EXT.test(p) || SHIM.test(p);
    let text = null;
    if (wanted) {
      try {
        const st = fs.statSync(abs);
        if (st.isFile() && st.size < 2 * 1024 * 1024) text = fs.readFileSync(abs, 'utf8');
      } catch {
        // error-ignored: an unreadable file is kept without text (it can still be named)
      }
    }
    files.set(p, text);
  }
  return files;
}

const USAGE = 'Use: npm run test:changed [-- <ref>] [--list]   (ref default origin/main)\n' +
  '     node scripts/test-changed.mjs --stats [--days N]   (the local test run log)';

function main(argv) {
  if (argv.includes('--stats')) return stats(argv);
  const list = argv.includes('--list');
  const rest = argv.filter((a) => a !== '--list');
  if (rest.some((a) => a.startsWith('-'))) {
    console.error(USAGE);
    return 2;
  }
  const ref = rest[0] ?? 'origin/main';
  const t0 = Date.now();
  const files = repoFiles();
  const changed = files ? changedFiles(ref) : null;
  let pick;
  if (!files) pick = full('git cannot list the repo files', []);
  else if (!changed) pick = full(`git cannot give the change against ${ref}`, []);
  else pick = selectTests({ changed, files });
  const pickS = (Date.now() - t0) / 1000;
  const secs = pickS.toFixed(1);
  // The one log row of this run (scripts/test-runs.mjs); run fields are added after vitest. Never fails the run.
  const row = {
    time: new Date().toISOString(),
    via: 'test:changed',
    ref,
    mode: pick.mode,
    reason: pick.reason,
    picked: pick.mode === 'full' ? pick.total : pick.tests.length,
    total: pick.total,
    changed: changed?.length,
    pick_s: Math.round(pickS * 10) / 10,
    list: list || undefined,
  };
  if (pick.mode === 'full') {
    console.log(`test:changed: FULL: ${pick.reason} (${secs} s)`);
    if (list) return logged(row, 0);
    return vitest([], row);
  }
  console.log(`test:changed: ${pick.tests.length} of ${pick.total} test files (${changed.length} changed files against ${ref}; ${pick.reason}; ${secs} s)`);
  if (list) {
    for (const t of pick.tests) console.log(`${t}  (${pick.why.get(t)})`);
    return logged(row, 0);
  }
  if (!pick.tests.length) return logged({ ...row, run_s: 0, exit: 0, tests: 0, failed: 0 }, 0);
  console.log(`npx vitest run ${pick.tests.join(' ')}`);
  return vitest(pick.tests, row);
}

/** Appends the row and gives the exit code unchanged (appendRun never throws). */
function logged(row, code) {
  appendRun(row, { root: ROOT });
  return code;
}

/** `--stats [--days N]`: the read view of the test run log. */
function stats(argv) {
  const i = argv.indexOf('--days');
  const days = i >= 0 ? Number(argv[i + 1]) : DEFAULT_DAYS;
  if (!Number.isFinite(days) || days <= 0) {
    console.error(USAGE);
    return 2;
  }
  const file = logPath(ROOT);
  for (const line of statsLines(runStats(readRuns(file), { days }), file)) console.log(line);
  if (!enabled(ROOT)) console.log('  (logging is off: testRuns.log false in queue.config.json or RAVENSEAT_TEST_RUNS=off)');
  return 0;
}

/**
 * Runs vitest from node_modules with node itself (no shell, so no quoting or .cmd differences). Gives its exit code.
 * The counting reporter (scripts/test-run-reporter.mjs) writes the test and failed counts to a temp file named in
 * RAVENSEAT_TEST_RUN_OUT, and the row of this run gets them with the run time and exit code.
 */
function vitest(testFiles, row) {
  const bin = path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
  let out = null;
  try {
    out = path.join(os.tmpdir(), `ravenseat-test-run-${process.pid}-${Date.now()}.json`);
  } catch {
    // error-ignored: no counts then
  }
  const env = out ? { ...process.env, RAVENSEAT_TEST_RUN_OUT: out } : process.env;
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [bin, 'run', ...testFiles], { cwd: ROOT, stdio: 'inherit', env });
  const code = r.status ?? 1;
  let counts = {};
  try {
    if (out && fs.existsSync(out)) {
      counts = JSON.parse(fs.readFileSync(out, 'utf8'));
      fs.rmSync(out, { force: true });
    }
  } catch {
    // error-ignored: the counts are optional
  }
  return logged({ ...row, run_s: Math.round((Date.now() - t0) / 100) / 10, exit: code, tests: counts.tests, failed: counts.failed }, code);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = main(process.argv.slice(2));
}
