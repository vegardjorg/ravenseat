// =============================================================
// lib/projectFiles.js: what a plugin update leaves behind in a project.
//
// ravenseat setup copies the docs and the mission template to docs/queue/ and CLAUDE.queue.md. Those are the project's own copies
// (they may be edited), so a plugin update does not touch them, and ravenseat setup keeps them. The mission every agent gets is
// built from the copy, so an old copy gives agents old instructions without any error. The same goes for a status line
// path with the old version in it. This file only compares and words it: ravenseat doctor, ravenseat setup and ravenseat receive say it, and
// the owner decides, since replacing a copy loses any edits in it.
//
// A vendored install (no plugin manifest) is left out: its installer rewrites the Markdown, and it replaces the files
// itself (INSTALL.md).
//
// Used by: cli/doctor.mjs, setup.mjs, cli/merge.mjs. Tested in: lib/__tests__/projectFiles.test.ts.
// =============================================================

const fs = require('node:fs');
const path = require('node:path');
const { PLUGIN_NAMES } = require('./productNames.js');

const MISSION = 'docs/queue/mission-template.md';

/** The plugin's version from its manifest, or null (a vendored install has none). */
function pluginVersion(pluginRoot) {
  try {
    return JSON.parse(fs.readFileSync(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

/** The text with one kind of line ending: git on Windows may have turned a copy into CRLF, which is no real difference. */
const text = (file) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

/**
 * The project's copies against the plugin's files.
 * @returns {null | { version: string, changed: string[], missing: string[], mission: boolean }} null when there is
 *   nothing to compare: not a plugin install, or a project without docs/queue/ (not set up).
 */
function staleFiles(pluginRoot, target) {
  const version = pluginVersion(pluginRoot);
  if (!version || !fs.existsSync(path.join(target, 'docs', 'queue'))) return null;
  const pairs = [['CLAUDE.queue.md', 'CLAUDE.queue.md']];
  try {
    for (const f of fs.readdirSync(path.join(pluginRoot, 'docs')).filter((x) => x.endsWith('.md')).sort())
      pairs.push([`docs/${f}`, `docs/queue/${f}`]);
  } catch {
    return null;
  }
  const changed = [];
  const missing = [];
  for (const [from, to] of pairs) {
    const copy = path.join(target, ...to.split('/'));
    try {
      if (!fs.existsSync(copy)) missing.push(to);
      else if (text(copy) !== text(path.join(pluginRoot, ...from.split('/')))) changed.push(to);
    } catch {
      /* unreadable: nothing to say about that file */
    }
  }
  return { version, changed, missing, mission: changed.includes(MISSION) };
}

/** One sentence about the copies, or null when they match. The mission template comes first: it changes what agents do. */
function staleMessage(s) {
  if (!s || (!s.changed.length && !s.missing.length)) return null;
  const rest = s.changed.filter((f) => f !== MISSION);
  const parts = [];
  if (s.mission) parts.push(`${MISSION} differs from plugin ${s.version}. Agents get their instructions from that copy, so an old one gives them old instructions`);
  if (rest.length) parts.push(`${s.mission ? 'also differing' : `differs from plugin ${s.version}`}: ${rest.join(', ')}`);
  if (s.missing.length) parts.push(`new in plugin ${s.version}, not in the project: ${s.missing.join(', ')}`);
  return parts.join('; ');
}

const STALE_FIX =
  'ravenseat setup --overwrite --dry lists the files, ravenseat setup --overwrite replaces them (your own edits in them are lost; ' +
  'queue.config.json is kept), then commit them. A file you edited on purpose can stay; compare it with the plugin first.';

/**
 * Status lines in the project's settings that run another plugin version than this one.
 * @returns {{ file: string, version: string }[]}
 */
function staleStatusLines(pluginRoot, target) {
  const version = pluginVersion(pluginRoot);
  if (!version) return [];
  const out = [];
  for (const file of ['.claude/settings.json', '.claude/settings.local.json']) {
    let command = '';
    try {
      command = String(JSON.parse(fs.readFileSync(path.join(target, ...file.split('/')), 'utf8'))?.statusLine?.command ?? '');
    } catch {
      continue;
    }
    const m = command.replace(/\\/g, '/').match(new RegExp(`/(?:${PLUGIN_NAMES.join('|')})/([^/]+)/scripts/orchestrator/statusline\\.mjs`));
    if (m && m[1] !== version) out.push({ file, version: m[1] });
  }
  return out;
}

module.exports = { pluginVersion, staleFiles, staleMessage, staleStatusLines, STALE_FIX, MISSION };
