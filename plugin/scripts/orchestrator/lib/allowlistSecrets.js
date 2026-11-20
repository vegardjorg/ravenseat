// =============================================================
// allowlistSecrets.js: secrets in the commands Claude Code has approved (permissions.allow, ask and deny).
//
// WHY: "Yes, and don't ask again" stores the whole command as a rule in .claude/settings.local.json, and shared
// approvals go to .claude/settings.json, which is tracked. A key typed in the command (a curl with a token header, an
// API_KEY=... prefix) then sits in clear text in that file. settings.local.json is often only ignored by the user's
// global gitignore, so a teammate's `git add .` or a backup copies it on. Ravenseat cannot stop Claude Code from
// writing the rule; it can find it and say so. `ravenseat doctor` (cli/doctorBaseline.mjs checkAllowlistSecrets) FAILs a hit
// in a file git tracks and WARNs one in an ignored file.
//
// What is read: .claude/settings.json and .claude/settings.local.json in the main tree and in every worktree git lists
// (`git worktree list --porcelain`, wherever it lives: the tracks' worktrees are often outside the main tree, roadmap
// 1c SEC-T item 1), plus any folder under .claude/worktrees/ git no longer lists (an agent's "don't ask again" lands
// in its own worktree; owner decision 2026-11-15). Each rule string in permissions.allow, ask and deny goes through
// secretScan.matchLine, the same patterns as the push check, and then through the password-flag rule for a command
// line (lib/commandSecrets.js matchCommand: `--password x`, `PGPASSWORD=x`, `sshpass -p x` of any length; SEC-T item 2).
// What is returned: { file, list, index, rule, tree, inTree, abs } per hit, where `rule` is the pattern's id
// (github-token, generic-secret, password-flag ...). NEVER the rule text or the value: doctor prints
// `<file>: permissions.allow[3]`. A tree outside the main tree is named by its absolute path (forward slashes).
// A file that is missing or not JSON is skipped: the settings check in doctor names a broken file on its own.
//
// Used by: cli/doctorBaseline.mjs. Tested in: lib/__tests__/allowlistSecrets.test.ts.
// =============================================================

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { matchLine } = require('./secretScan.js');
const { matchCommand } = require('./commandSecrets.js');
const { parseWorktrees } = require('./tidy.js');

/** The permission lists that hold command rules. */
const LISTS = Object.freeze(['allow', 'ask', 'deny']);
/** The two settings files of a tree, relative to it (the shared one first). */
const SETTINGS = Object.freeze(['.claude/settings.json', '.claude/settings.local.json']);
/** Where the agents' worktrees live, relative to the main tree. */
const WORKTREES = '.claude/worktrees';

/**
 * The rules in a settings file's text: [{ list, index, rule }] for each string in permissions.allow, ask and deny.
 * `index` is the position in its list (a non-string entry keeps its place, so the index matches the file).
 * @param {string} text
 * @returns {{ list: string, index: number, rule: string }[]}
 */
function rulesOf(text) {
  let json;
  try {
    json = JSON.parse(String(text ?? ''));
  } catch {
    return [];
  }
  const p = json && typeof json === 'object' ? json.permissions : null;
  if (!p || typeof p !== 'object') return [];
  const out = [];
  for (const list of LISTS) {
    if (!Array.isArray(p[list])) continue;
    p[list].forEach((rule, index) => {
      if (typeof rule === 'string') out.push({ list, index, rule });
    });
  }
  return out;
}

/**
 * The hits in one settings file: [{ file, list, index, rule }], `rule` being the pattern id. The rule text is only
 * used to match and never leaves this function.
 * @param {string} text  the file's content
 * @param {string} file  its path as it should be shown (relative, forward slashes)
 */
function scanSettings(text, file) {
  const hits = [];
  for (const r of rulesOf(text)) {
    const id = ruleOf(r.rule, file);
    if (id) hits.push({ file, list: r.list, index: r.index, rule: id });
  }
  return hits;
}

/** The command inside a permission rule: `Bash(psql --password x:*)` -> `psql --password x`. */
const commandOf = (rule) =>
  String(rule ?? '')
    .replace(/^\s*[A-Za-z_][\w-]*\(/, '')
    .replace(/\)\s*$/, '')
    .replace(/:\*$/, '');

/**
 * The pattern id one approved rule hits, or null: the secret scan's patterns (secretScan.matchLine), then the
 * password-flag rule for a command line (lib/commandSecrets.js matchCommand: any length, placeholders skipped). Shared
 * with `ravenseat secrets clean`, so it removes exactly what doctor names.
 * @param {string} rule  the rule text
 * @param {string} file  the settings file it is in
 */
function ruleOf(rule, file) {
  return matchLine(rule, file) ?? matchCommand(commandOf(rule));
}

/**
 * The settings files to read: [{ file, tree, inTree, abs }]. `file` is relative to the main tree (absolute for a tree
 * outside it), `tree` the worktree folder the same way ('' for the main tree) and `inTree` the path inside that tree
 * (for a git lookup there). The files need not exist. Worktrees are sorted by name, so the output is stable.
 * @param {string} mainTree  absolute path of the main tree
 * @param {{ readdir?: (dir: string) => fs.Dirent[], worktrees?: (mainTree: string) => string[] }} [io]
 */
function settingsFiles(mainTree, io = {}) {
  return treeFiles(mainTree, SETTINGS, io);
}

/**
 * The files `inTrees` (paths inside a tree) in the main tree, in every worktree git lists and in every folder under
 * .claude/worktrees/, as settingsFiles gives them. Shared with lib/mcpSecrets.js (.mcp.json), so both scans read the
 * same trees. `io.worktrees` replaces the git call (tests).
 * @param {string} mainTree  absolute path of the main tree
 * @param {readonly string[]} inTrees  the paths inside each tree, with forward slashes
 * @param {{ readdir?: (dir: string) => fs.Dirent[], worktrees?: (mainTree: string) => string[] }} [io]
 */
function treeFiles(mainTree, inTrees, io = {}) {
  const readdir = io.readdir ?? ((d) => fs.readdirSync(d, { withFileTypes: true }));
  const listed = io.worktrees ?? gitWorktrees;
  const slash = (p) => p.replace(/\\/g, '/');
  const key = (p) => (process.platform === 'win32' ? slash(path.resolve(p)).toLowerCase() : slash(path.resolve(p)));
  // Each tree once, by its resolved path: the main tree first, the rest by name.
  const seen = new Set([key(mainTree)]);
  const trees = [];
  const add = (abs) => {
    const k = key(abs);
    if (seen.has(k)) return;
    seen.add(k);
    const rel = path.relative(mainTree, abs);
    // Inside the main tree: relative, as before. Elsewhere (C:\prosjekter\tester\<track>): its own absolute path.
    const inside = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
    trees.push(inside ? slash(rel) : slash(path.resolve(abs)));
  };
  try {
    for (const p of listed(mainTree)) add(p);
  } catch {
    /* git missing or no repo: the folder below still counts */
  }
  // A folder under .claude/worktrees that git no longer lists (a half-removed worktree) can still hold a settings file.
  try {
    const dirs = readdir(path.join(mainTree, WORKTREES))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    for (const d of dirs) add(path.join(mainTree, WORKTREES, d));
  } catch {
    /* no worktrees folder */
  }
  trees.sort();
  const out = [];
  for (const tree of ['', ...trees])
    for (const inTree of inTrees) {
      const file = tree ? `${tree}/${inTree}` : inTree;
      out.push({ file, tree, inTree, abs: path.resolve(mainTree, tree || '.', ...inTree.split('/')) });
    }
  return out;
}

/**
 * The worktrees git knows for the main tree (`git worktree list --porcelain`, read with lib/tidy.js parseWorktrees),
 * absolute paths, without bare and prunable entries. Wherever they live: the tracks' worktrees are often outside the
 * main tree (C:\prosjekter\tester\<track>). Throws when git cannot answer (the caller falls back to the folder).
 * @param {string} mainTree
 * @returns {string[]}
 */
function gitWorktrees(mainTree) {
  const out = execFileSync('git', ['-C', mainTree, 'worktree', 'list', '--porcelain'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
    timeout: 5000,
  });
  return parseWorktrees(out)
    .filter((w) => !w.bare && !w.prunable)
    .map((w) => w.path);
}

/**
 * Every hit in the main tree's and the worktrees' settings files: [{ file, list, index, rule, tree, inTree }].
 * @param {string} mainTree  absolute path of the main tree
 * @param {{ readFile?: (abs: string) => string|null, readdir?: (dir: string) => fs.Dirent[] }} [io]
 */
function scanTrees(mainTree, io = {}) {
  const readFile =
    io.readFile ??
    ((abs) => {
      try {
        return fs.readFileSync(abs, 'utf8');
      } catch {
        return null;
      }
    });
  const hits = [];
  for (const f of settingsFiles(mainTree, io)) {
    const text = readFile(f.abs);
    if (text == null) continue;
    for (const h of scanSettings(text, f.file)) hits.push({ ...h, tree: f.tree, inTree: f.inTree, abs: f.abs });
  }
  return hits;
}

/** How a hit is shown: `<file>: permissions.<list>[<index>] (<rule id>)`. Never the rule text. */
function where(hit) {
  return `${hit.file}: permissions.${hit.list}[${hit.index}] (${hit.rule})`;
}

module.exports = { LISTS, SETTINGS, WORKTREES, rulesOf, ruleOf, commandOf, scanSettings, settingsFiles, treeFiles, gitWorktrees, scanTrees, where };
