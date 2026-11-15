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
// What is read: .claude/settings.json and .claude/settings.local.json in the main tree and in every folder under
// .claude/worktrees/ (an agent's "don't ask again" lands in its own worktree; owner decision 2026-11-15). Each rule
// string in permissions.allow, ask and deny goes through secretScan.matchLine, the same patterns as the push check, so
// the rules are not duplicated here.
// What is returned: { file, list, index, rule, tree, inTree } per hit, where `rule` is the pattern's id
// (github-token, generic-secret ...). NEVER the rule text or the value: doctor prints `<file>: permissions.allow[3]`.
// A file that is missing or not JSON is skipped: the settings check in doctor names a broken file on its own.
//
// Used by: cli/doctorBaseline.mjs. Tested in: lib/__tests__/allowlistSecrets.test.ts.
// =============================================================

const fs = require('node:fs');
const path = require('node:path');

const { matchLine } = require('./secretScan.js');

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
    const id = matchLine(r.rule, file);
    if (id) hits.push({ file, list: r.list, index: r.index, rule: id });
  }
  return hits;
}

/**
 * The settings files to read: [{ file, tree, inTree, abs }]. `file` is relative to the main tree, `tree` the worktree
 * folder relative to it ('' for the main tree) and `inTree` the path inside that tree (for a git lookup there). The
 * files need not exist. Worktree folders are sorted by name, so the output is stable.
 * @param {string} mainTree  absolute path of the main tree
 * @param {{ readdir?: (dir: string) => fs.Dirent[] }} [io]
 */
function settingsFiles(mainTree, io = {}) {
  const readdir = io.readdir ?? ((d) => fs.readdirSync(d, { withFileTypes: true }));
  const trees = [''];
  try {
    const dirs = readdir(path.join(mainTree, WORKTREES))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    for (const d of dirs) trees.push(`${WORKTREES}/${d}`);
  } catch {
    /* no worktrees folder */
  }
  const out = [];
  for (const tree of trees)
    for (const inTree of SETTINGS) {
      const file = tree ? `${tree}/${inTree}` : inTree;
      out.push({ file, tree, inTree, abs: path.join(mainTree, ...file.split('/')) });
    }
  return out;
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
    for (const h of scanSettings(text, f.file)) hits.push({ ...h, tree: f.tree, inTree: f.inTree });
  }
  return hits;
}

/** How a hit is shown: `<file>: permissions.<list>[<index>] (<rule id>)`. Never the rule text. */
function where(hit) {
  return `${hit.file}: permissions.${hit.list}[${hit.index}] (${hit.rule})`;
}

module.exports = { LISTS, SETTINGS, WORKTREES, rulesOf, scanSettings, settingsFiles, scanTrees, where };
