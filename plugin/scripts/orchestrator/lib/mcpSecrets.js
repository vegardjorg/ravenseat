// =============================================================
// mcpSecrets.js: keys written into .mcp.json, the file where Claude Code reads the project's MCP servers.
//
// WHY: an MCP server often needs a key (a GitHub token, a database URL with a password, an API key header). The quick
// way is to paste it into .mcp.json, and .mcp.json is meant to be shared: it is usually tracked, so the key is in the
// repo and its history. Claude Code expands `${VAR}` (and `${VAR:-default}`) in command, args, env, url and headers,
// so the key can stay in the environment instead. This is the sister of lib/allowlistSecrets.js: the same trees (the
// main tree and every folder under .claude/worktrees/), the same patterns (secretScan.matchLine) and the same rules in
// `ravenseat doctor` (cli/doctorBaseline.mjs checkMcpSecrets): FAIL when git tracks the file, WARN when it is only on
// disk. It shares the setting secretScan.allowlist: both look for keys in Claude Code's own config files.
//
// What is read, per server under mcpServers: every value in `env` (as NAME=value), every value in `headers` (as
// Name: value; an Authorization or API key header is also tried as a token value), every string in `args` and the
// `url`. A `${...}` reference is never a hit, also inside a longer value ("Bearer ${TOKEN}").
// What is returned: { file, at, rule, tree, inTree } per hit, `at` being the path in the file
// (mcpServers.github.env.GITHUB_TOKEN, mcpServers.db.args[2]). NEVER the value.
// A file that is missing or not JSON is skipped.
//
// Used by: cli/doctorBaseline.mjs. Tested in: lib/__tests__/mcpSecrets.test.ts.
// =============================================================
'use strict';

const fs = require('node:fs');

const { matchLine } = require('./secretScan.js');
const { treeFiles } = require('./allowlistSecrets.js');

/** The MCP config file of a tree, relative to it. */
const MCP_FILE = '.mcp.json';
/** A `${NAME}` or `${NAME:-default}` reference that Claude Code expands from the environment. */
const REFERENCE = /\$\{[^}]*\}/g;
/** Headers whose whole value is a credential (after an optional scheme such as Bearer or Basic). */
const KEY_HEADER = /^(?:authorization|proxy-authorization|x-api-key|api-key|x-auth-token)$/i;

/** The value with every ${...} reference removed: what is left is what was typed in clear text. */
const literal = (v) => String(v).replace(REFERENCE, '');

/**
 * The places in one .mcp.json text that may hold a key: [{ at, text }], `text` being the line to match. Not exported
 * outside tests: the text holds the value.
 * @param {string} text
 * @returns {{ at: string, text: string, header?: string }[]}
 */
function placesOf(text) {
  let json;
  try {
    json = JSON.parse(String(text ?? ''));
  } catch {
    return [];
  }
  const servers = json && typeof json === 'object' ? json.mcpServers : null;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return [];
  const out = [];
  for (const [name, s] of Object.entries(servers)) {
    if (!s || typeof s !== 'object') continue;
    const base = `mcpServers.${name}`;
    if (s.env && typeof s.env === 'object')
      for (const [k, v] of Object.entries(s.env)) if (typeof v === 'string') out.push({ at: `${base}.env.${k}`, text: `${k}=${literal(v)}` });
    if (s.headers && typeof s.headers === 'object')
      for (const [k, v] of Object.entries(s.headers)) if (typeof v === 'string') out.push({ at: `${base}.headers.${k}`, text: `${k}: ${literal(v)}`, header: k });
    if (Array.isArray(s.args)) s.args.forEach((v, i) => typeof v === 'string' && out.push({ at: `${base}.args[${i}]`, text: literal(v) }));
    if (typeof s.url === 'string') out.push({ at: `${base}.url`, text: literal(s.url) });
  }
  return out;
}

/** The pattern id one place matches, or null. A key header is also tried as `token=<value>` for the generic rule. */
function matchPlace(p, file) {
  const id = matchLine(p.text, file);
  if (id) return id;
  if (p.header && KEY_HEADER.test(p.header)) {
    const value = p.text.slice(p.text.indexOf(':') + 1).trim().replace(/^(?:bearer|basic|token)\s+/i, '');
    if (value) return matchLine(`token=${value}`, file);
  }
  return null;
}

/**
 * The hits in one .mcp.json: [{ file, at, rule }]. The values are only used to match and never leave this function.
 * @param {string} text  the file's content
 * @param {string} file  its path as it should be shown (relative, forward slashes)
 */
function scanMcp(text, file) {
  const hits = [];
  for (const p of placesOf(text)) {
    const id = matchPlace(p, file);
    if (id) hits.push({ file, at: p.at, rule: id });
  }
  return hits;
}

/** The .mcp.json files to read: the main tree's and every worktree's, as allowlistSecrets.treeFiles. */
const mcpFiles = (mainTree, io = {}) => treeFiles(mainTree, [MCP_FILE], io);

/**
 * Every hit in the main tree's and the worktrees' .mcp.json: [{ file, at, rule, tree, inTree }].
 * @param {string} mainTree  absolute path of the main tree
 * @param {{ readFile?: (abs: string) => string|null, readdir?: Function }} [io]
 */
function scanMcpTrees(mainTree, io = {}) {
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
  for (const f of mcpFiles(mainTree, io)) {
    const text = readFile(f.abs);
    if (text == null) continue;
    for (const h of scanMcp(text, f.file)) hits.push({ ...h, tree: f.tree, inTree: f.inTree });
  }
  return hits;
}

/** How a hit is shown: `<file>: <path in the file> (<rule id>)`. Never the value. */
const where = (hit) => `${hit.file}: ${hit.at} (${hit.rule})`;

module.exports = { MCP_FILE, placesOf, scanMcp, mcpFiles, scanMcpTrees, where };
