// =============================================================
// claudeFingerprint.js: a fingerprint of the owner's own Claude setup (~/.claude), taken at start and compared at
// receive.
//
// Why: a track runs as the owner, so it can write outside its worktree, also in ~/.claude: the user settings and
// their hooks, the user's agents, commands and skills, and the plugin manifests. git never sees that folder, so no
// merge guard can catch a change there. start records a hash per entry on a narrow list; receive compares and names
// what changed. It only warns: the owner may have changed the setup themself while the track ran.
//
// Only hashes are stored (on the task, field claude_fp), never content: the settings can hold tokens.
// The list is narrow on purpose. Transcripts (projects/), the plugin cache, todos and other state change all the time
// and would make the warning noise.
// No queue state here; cli/tracks.mjs (markStarted) and cli/merge.mjs (receive) call it.
// =============================================================

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** Files, and folders (ending in "/") hashed with everything in them, relative to the Claude folder. */
const ENTRIES = [
  'settings.json',
  'settings.local.json',
  'CLAUDE.md',
  'keybindings.json',
  'plugins/installed_plugins.json',
  'plugins/known_marketplaces.json',
  'agents/',
  'commands/',
  'skills/',
  'hooks/',
];
/** A folder with more files than this gets the marker "too-many" instead of a hash (a hook folder is small). */
const MAX_FILES = 2000;

/** The Claude folder: RAVENSEAT_CLAUDE_DIR (tests), then Claude Code's own CLAUDE_CONFIG_DIR, then ~/.claude. */
function claudeDir(env = process.env) {
  return env.RAVENSEAT_CLAUDE_DIR || env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

const sha = (data) => crypto.createHash('sha256').update(data).digest('hex');

/** The files under a folder, as sorted relative paths with "/" (symlinks are not followed). */
function filesUnder(root) {
  const out = [];
  const walk = (rel) => {
    let items;
    try {
      items = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      if (out.length > MAX_FILES) return;
      const r = rel ? `${rel}/${it.name}` : it.name;
      if (it.isDirectory()) walk(r);
      else if (it.isFile()) out.push(r);
    }
  };
  walk('');
  return out.sort();
}

/** The hash of one entry, null when it is missing. A folder's hash covers each file's path and content. */
function entryHash(dir, name) {
  const full = path.join(dir, name);
  try {
    if (!name.endsWith('/')) return fs.statSync(full).isFile() ? sha(fs.readFileSync(full)) : null;
    if (!fs.statSync(full).isDirectory()) return null;
  } catch {
    return null;
  }
  const files = filesUnder(full);
  if (files.length > MAX_FILES) return 'too-many';
  const h = crypto.createHash('sha256');
  for (const f of files) {
    let content;
    try {
      content = fs.readFileSync(path.join(full, f));
    } catch {
      content = Buffer.from('unreadable');
    }
    h.update(`${f}\0${sha(content)}\n`);
  }
  return h.digest('hex');
}

/**
 * The fingerprint now.
 * @returns {{ dir: string, at: string, entries: Record<string, string|null> }}
 */
function fingerprint({ dir = claudeDir(), now = new Date() } = {}) {
  const entries = {};
  for (const name of ENTRIES) entries[name] = entryHash(dir, name);
  return { dir, at: now.toISOString(), entries };
}

/**
 * What changed between two fingerprints of the same folder, in the list's order. Nothing when one is missing or they
 * are of different folders (the owner moved CLAUDE_CONFIG_DIR: not a track's doing to warn about).
 * @returns {{ name: string, change: 'changed'|'added'|'removed' }[]}
 */
function compare(before, after) {
  if (!before?.entries || !after?.entries || before.dir !== after.dir) return [];
  const out = [];
  for (const name of ENTRIES) {
    if (!(name in before.entries) || !(name in after.entries)) continue;
    const a = before.entries[name];
    const b = after.entries[name];
    if (a === b) continue;
    out.push({ name, change: a == null ? 'added' : b == null ? 'removed' : 'changed' });
  }
  return out;
}

/** The receive lines for the changes. `others` = the tracks that ran at the same time (they could have done it too). */
function warningLines(id, changes, { dir, others = [] } = {}) {
  if (!changes?.length) return [];
  const what = changes.map((c) => `${c.name} (${c.change})`).join(', ');
  const lines = [
    `CLAUDE SETUP CHANGED ${id}: ${what} in ${dir} since the track started. git does not see this folder, so no merge guard catches it. ` +
      'If you did not change it yourself, look at it before you merge: a track must never change your own setup.',
  ];
  if (others.length) lines.push(`  ${others.join(', ')} ran at the same time and could have made the change as well.`);
  return lines;
}

module.exports = { ENTRIES, MAX_FILES, claudeDir, fingerprint, compare, warningLines };
