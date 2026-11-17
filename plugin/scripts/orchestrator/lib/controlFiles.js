// =============================================================
// controlFiles.js: the main tree's control files, the write guard for them (file tools and shell lines) and the
// fingerprint fill records and receive compares.
//
// Why: a track runs as the owner, so it can write outside its worktree, also in the main tree. A few files there steer
// the orchestrator, the guards or every later session: queue.config.json (every guard setting), .claude/ (the settings,
// hooks, agents and rules Claude Code loads), CLAUDE*.md (the instructions), .git/hooks/ and .git/config (what runs at
// the orchestrator's next git command, and where a push goes), and the plugin's own scripts (the guards themselves).
// The push guard denies every override flag to a queue agent, but a direct write to those files got around all of them
// (plans/ekstern-saas-vurdering-2026-11-15.md, F1). So:
//   - assessControlWrite: a queue agent's Write, Edit or NotebookEdit there is denied (hook-write-guard.mjs);
//   - controlShellReason: so is a shell line that names one and writes (a redirection, cp, mv, sed -i, Set-Content,
//     node -e with writeFileSync ...), and a git config or git remote write, which lands in the shared .git/config
//     (hook-push-guard.mjs, read with lib/shellCommands.js like the push and network guard);
//   - fingerprint and compare: fill and start record a short hash per file, receive names what changed while the track
//     ran (CONTROL FILES CHANGED), leaving out what came in through a commit (git shows that).
// The track's own worktree copy (its .claude/, its CLAUDE.md) is its own branch: free here, and the merge guard's
// protected paths catch it at merge. The main session is never stopped here (asking it is bolk 3's "ask").
//
// Limits, on purpose: this is a guard against a misled agent and casual tampering, not a security boundary. A script
// file the agent wrote and then runs (`node x.js`), a path built from pieces at run time, an unknown variable as the
// folder, or a process that outlives its run are not read. The fingerprint detects, it does not undo, and it cannot
// tell who made a change (the owner may have edited CLAUDE.md while the track ran), so receive warns and never stops.
// A real boundary needs another OS user or protection on the remote (guide.md, "Guarantees and limits").
// Pure except fingerprint. Tested in lib/__tests__/controlFiles.test.ts and __tests__/redteam/controlFiles.test.ts.
// =============================================================
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SC = require('./shellCommands.js');

/** The kinds, as the denial and the warning name them. */
const KIND = Object.freeze({
  config: 'queue.config.json',
  claude: '.claude/',
  instructions: 'CLAUDE*.md',
  hooks: '.git/hooks/',
  gitConfig: '.git/config',
  scripts: "the plugin's scripts",
});
/** What each kind steers, for the denial. */
const WHAT = Object.freeze({
  [KIND.config]: 'the queue config, which holds every guard setting',
  [KIND.claude]: 'the Claude Code setup (settings, hooks, agents, skills, rules) every later session loads',
  [KIND.instructions]: 'the instructions every later session loads',
  [KIND.hooks]: "a git hook, which runs at the orchestrator's next git command",
  [KIND.gitConfig]: 'the shared git config (remotes, hooks path, programs git runs)',
  [KIND.scripts]: "the plugin's own scripts, which are the guards",
});
/** The key the plugin's scripts folder has in the fingerprint: one hash for the whole folder. */
const SCRIPTS_KEY = 'plugin-scripts/';
/** A group with more files than this is hashed as one entry (a large skills folder must not bloat queue.json). */
const MAX_FILES = 400;
/** The folders in the scripts folder that are not code that runs. */
const SCRIPTS_SKIP = new Set(['__tests__', 'node_modules']);

const bare = (t) => (typeof t === 'string' && t ? t.replace(/^ravenseat:/, '') : null);

/** A path made absolute with "/" separators; on Windows Git Bash's /c/x is C:/x. */
function absOf(p, platform = process.platform) {
  let s = String(p ?? '');
  if (platform === 'win32') {
    const gb = /^\/([a-zA-Z])(\/|$)/.exec(s);
    if (gb) s = `${gb[1]}:/${s.slice(3)}`;
  }
  return path.resolve(s).replace(/\\/g, '/').replace(/(.)\/+$/, '$1');
}

/** A path in one form for comparing: absOf, and lower case on Windows (C:\X and c:\x are the same folder). */
function norm(p, platform = process.platform) {
  const r = absOf(p, platform);
  return platform === 'win32' ? r.toLowerCase() : r;
}

/** `inner` is `outer` or inside it (both normalised). */
const inside = (inner, outer) => inner === outer || inner.startsWith(`${outer}/`);

/**
 * The control file kind of a path (KIND), or null.
 * @param {string} file absolute (or relative to the process cwd)
 * @param {{ mainTree: string, scriptsDir?: string|null, configFile?: string|null, platform?: string }} where
 */
function controlKind(file, { mainTree, scriptsDir = null, configFile = null, platform = process.platform } = {}) {
  if (!file || !mainTree) return null;
  const abs = norm(file, platform);
  if (configFile && abs === norm(configFile, platform)) return KIND.config;
  if (scriptsDir && inside(abs, norm(scriptsDir, platform))) return KIND.scripts;
  const main = norm(mainTree, platform);
  if (!abs.startsWith(`${main}/`)) return null;
  const rel = abs.slice(main.length + 1);
  // The agent worktrees live under .claude/worktrees in many setups: a track's own files, never the main tree's.
  if (/^\.claude\/worktrees(\/|$)/i.test(rel)) return null;
  if (/^queue\.config\.json$/i.test(rel)) return KIND.config;
  if (/^\.claude\//i.test(rel)) return KIND.claude;
  if (/^\.git\/config$/i.test(rel)) return KIND.gitConfig;
  if (/^\.git\/hooks\//i.test(rel)) return KIND.hooks;
  if (/^\.git\//i.test(rel)) return null;
  if (/^claude[^/]*\.md$/i.test(path.posix.basename(rel))) return KIND.instructions;
  return null;
}

/** The path as the denial shows it: relative to the main tree when inside it. */
function shown(file, mainTree, platform = process.platform) {
  const main = norm(mainTree, platform);
  const abs = absOf(file, platform);
  return norm(file, platform).startsWith(`${main}/`) ? abs.slice(main.length + 1) : abs;
}

const denial = (kind, name) =>
  `${name} is ${WHAT[kind]} in the main tree, a control file a queue agent never writes (not with the file tools, not ` +
  'with the shell). Change your own worktree\'s copy if the task owns it, or put what should change in your report: ' +
  'the owner decides.';

/**
 * The denial for a Write, Edit or NotebookEdit of a control file by a guarded agent, or null.
 * @param {{ agentType: string|null, filePath: string, mainTree: string, scriptsDir?: string|null, configFile?: string|null,
 *   guardedTypes?: Set<string>, agentGuard?: object, enabled?: boolean, platform?: string }} x
 * @returns {{ reason: string, rule: 'control-file', kind: string } | null}
 */
function assessControlWrite({ agentType, filePath, mainTree, scriptsDir = null, configFile = null, guardedTypes = new Set(), agentGuard, enabled = true, platform }) {
  if (enabled === false || !bare(agentType) || !filePath) return null;
  const AG = require('./agentGuard.js');
  const queueTypes = new Set(['track', 'track-d', ...guardedTypes]);
  if (!AG.isGuarded(agentType, { queueTypes, policy: agentGuard ?? AG.DEFAULTS, subagent: agentGuard?.subagent })) return null;
  const kind = controlKind(filePath, { mainTree, scriptsDir, configFile, platform });
  if (!kind) return null;
  return { reason: `Write guard: ${denial(kind, shown(filePath, mainTree, platform))}`, rule: 'control-file', kind };
}

// ---- The shell --------------------------------------------------------------------------------------------------

/** Commands and calls that write, move, copy over or remove a file (the same family as lib/gateEvidence.js). */
const WRITE_WORDS = [
  'tee', 'cp', 'mv', 'rm', 'ln', 'dd', 'truncate', 'install', 'sponge', 'del', 'erase', 'copy', 'move', 'ren', 'rename',
  'touch', 'set-content', 'add-content', 'out-file', 'clear-content', 'remove-item', 'move-item', 'copy-item', 'new-item',
  'rename-item', 'writefile(?:sync)?', 'appendfile(?:sync)?', 'writealltext', 'appendalltext', 'writeallbytes',
  'rmsync', 'unlink(?:sync)?', 'renamesync', 'copyfile(?:sync)?', 'createwritestream', 'cpsync', 'write_text', 'write_bytes',
];
const WRITES = new RegExp(
  `\\b(?:${WRITE_WORDS.join('|')})\\b|\\bsed\\s+(?:-[a-z]*i|--in-place)|\\bperl\\s+-[a-z]*i|` +
    '\\bgit\\b.*\\b(?:checkout|restore|rm|mv|apply|stash|reset)\\b|\\bopen\\s*\\([^)]*,\\s*[wax]b?\\+?\\s*\\)',
  'i',
);
/** A redirection (> or >>, also &> and *>) and its target word; 2>&1, => and -> are not. */
const REDIRECT = /(?:^|[^0-9=>-])(?:&|\*)?>>?\|?\s*([^\s;|&<>()]+)/g;
/** The words a path can stand in, after quotes are gone. */
const SPLIT = /[\s=(),;|&<>{}[\]+]+/;

/** The variables read as their value, when the hook knows it. */
const VARS = ['CLAUDE_PROJECT_DIR', 'QUEUE_ROOT'];

/** The line with the known variables filled in (bash, PowerShell and cmd forms). */
function withVars(command, env) {
  let s = String(command ?? '');
  for (const v of VARS) {
    const value = env?.[v];
    if (typeof value !== 'string' || !value) continue;
    const r = new RegExp(`\\$\\{${v}\\}|\\$env:${v}\\b|%${v}%|\\$${v}\\b`, 'gi');
    s = s.replace(r, value.replace(/\$/g, '$$$$'));
  }
  return s;
}

/** The words of a form that look like a path (a separator or a dot in it), without trailing punctuation. */
function pathWords(form) {
  return form
    .split(SPLIT)
    .map((w) => w.replace(/^[:`]+|[:.,`]+$/g, ''))
    .filter((w) => w && /[/\\.]/.test(w) && !/^-/.test(w) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(w));
}

const isAbsolute = (w, platform) => (platform === 'win32' ? /^[a-zA-Z]:[\\/]|^\\\\|^\/[a-zA-Z](\/|$)/.test(w) : w.startsWith('/'));

/**
 * The control file a shell line writes, or null. Text-based like lib/gateEvidence.js tamperReason: a path word that
 * resolves to a control file of the main tree (absolute, or relative to the cwd or to a main tree folder named on the
 * line, `cd <main> && ...`, `git -C <main> ...`), together with a write: a redirection to it, or a writing command or
 * call anywhere on the line. A git config or git remote write is a write of the shared .git/config whatever the path.
 * @param {string} command
 * @param {{ cwd: string, mainTree: string, scriptsDir?: string|null, configFile?: string|null,
 *   env?: Record<string, string|undefined>, platform?: string }} ctx
 * @returns {{ reason: string, rule: 'control-file', kind: string } | null}
 */
function controlShellReason(command, { cwd, mainTree, scriptsDir = null, configFile = null, env = {}, platform = process.platform } = {}) {
  if (!command || !mainTree) return null;
  const where = { mainTree, scriptsDir, configFile, platform };
  const git = gitConfigWrite(command);
  if (git) return { reason: `push-guard: ${git}`, rule: 'control-file', kind: KIND.gitConfig };
  const text = withVars(command, env).replace(/["'`]/g, ' ');
  const forms = platform === 'win32' ? [text] : [text, text.replace(/\\(.)/g, '$1')];
  const main = norm(mainTree, platform);
  for (const form of forms) {
    const words = pathWords(form);
    // The folders relative words are read from: the cwd, and any word on the line that is the main tree or one of
    // its control folders (a cd or git -C there).
    const bases = [cwd || process.cwd()];
    for (const w of [...words, ...form.split(SPLIT)]) {
      if (!isAbsolute(w, platform)) continue;
      const n = norm(w, platform);
      if (n === main || n === `${main}/.claude` || n === `${main}/.git` || n === `${main}/.git/hooks`) bases.push(w);
    }
    const resolve = (w) => (isAbsolute(w, platform) ? [w] : bases.map((b) => path.join(absOf(b, platform), w)));
    const kindOf = (w) => {
      for (const p of resolve(w)) {
        const k = controlKind(p, where);
        if (k) return { kind: k, name: shown(p, mainTree, platform) };
      }
      return null;
    };
    // A redirection whose target is a control file: a write whatever the command is.
    for (const r of form.matchAll(REDIRECT)) {
      const hit = kindOf(r[1]);
      if (hit) return { reason: `push-guard: ${denial(hit.kind, hit.name)}`, rule: 'control-file', kind: hit.kind };
    }
    if (!WRITES.test(form)) continue;
    for (const w of words) {
      const hit = kindOf(w);
      if (hit) return { reason: `push-guard: ${denial(hit.kind, hit.name)}`, rule: 'control-file', kind: hit.kind };
    }
  }
  return null;
}

/** git config flags that only read. */
const CONFIG_READ = /^(--get(-all|-regexp|-urlmatch|-color(bool)?)?|-l|--list|--show-origin|--show-scope|--name-only|-z|--null|--type=.*|--bool|--int|--path|--default=.*)$/i;
/** git config flags that write. */
const CONFIG_WRITE = /^(--add|--unset(-all)?|--replace-all|--rename-section|--remove-section|-e|--edit)$/i;
/** git remote subcommands that change the config. */
const REMOTE_WRITE = new Set(['add', 'set-url', 'rename', 'remove', 'rm', 'set-head', 'set-branches', 'prune', 'update']);

/**
 * A git config or git remote command that writes the git config, as a denial reason, or null. A worktree shares the
 * main tree's .git/config (unless extensions.worktreeConfig is on), and --global and --system write the owner's own.
 * --file to another file is free.
 */
function gitConfigWrite(command) {
  for (const c of SC.commandList(command).commands) {
    const g = SC.gitInvocation(c.t, c.i0);
    if (!g) continue;
    const sub = String(g.sub).toLowerCase();
    if (sub === 'remote') {
      const word = g.args.find((x) => !x.startsWith('-'));
      if (word && REMOTE_WRITE.has(word.toLowerCase()))
        return `\`git remote ${word}\` changes the shared git config (.git/config, the main tree's), which a queue agent never writes. Put it in your report: the owner decides.`;
      continue;
    }
    if (sub !== 'config') continue;
    const args = g.args.map(String);
    const fileAt = args.findIndex((x) => x === '--file' || x === '-f' || x.startsWith('--file='));
    if (fileAt >= 0) continue;
    if (args.some((x) => CONFIG_READ.test(x))) continue;
    const positional = args.filter((x) => !x.startsWith('-'));
    const first = (positional[0] ?? '').toLowerCase();
    const subWrite = ['set', 'unset', 'rename-section', 'remove-section', 'edit'].includes(first);
    const subRead = ['get', 'list'].includes(first);
    if (subRead) continue;
    if (args.some((x) => CONFIG_WRITE.test(x)) || subWrite || positional.length >= 2) {
      const scope = args.find((x) => /^--(global|system)$/i.test(x));
      return (
        `\`git config\` that writes ${scope ? `the ${scope.slice(2)} git config` : "the shared git config (.git/config, the main tree's)"} ` +
        'is not for queue agents. Reading it is fine (git config --get). Put what should change in your report: the owner decides.'
      );
    }
  }
  return null;
}

// ---- The fingerprint --------------------------------------------------------------------------------------------

const short = (data) => crypto.createHash('sha256').update(data).digest('hex').slice(0, 16);

/** The files under a folder as sorted relative "/" paths, skipping some names at the top level. Symlinks not followed. */
function filesUnder(root, skipTop = new Set(), skipAny = new Set(), cap = MAX_FILES * 10) {
  const out = [];
  const walk = (rel, depth) => {
    let items;
    try {
      items = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      if (out.length > cap) return;
      if ((depth === 0 && skipTop.has(it.name.toLowerCase())) || skipAny.has(it.name)) continue;
      const r = rel ? `${rel}/${it.name}` : it.name;
      if (it.isDirectory()) walk(r, depth + 1);
      else if (it.isFile()) out.push(r);
    }
  };
  walk('', 0);
  return out.sort();
}

function fileHash(file) {
  try {
    return short(fs.readFileSync(file));
  } catch {
    return 'unreadable';
  }
}

/** .git/config without its [branch "..."] sections: git writes those itself (an upstream, a merge setting). */
function gitConfigText(text) {
  const out = [];
  let skip = false;
  for (const line of String(text).split(/\r?\n/)) {
    const head = /^\s*\[\s*([^\]\s"]+)/.exec(line);
    if (head) skip = head[1].toLowerCase() === 'branch';
    if (!skip && line.trim()) out.push(line.trim());
  }
  return out.join('\n');
}

/** One hash for a group of files under a folder. */
function groupHash(dir, files) {
  const h = crypto.createHash('sha256');
  for (const f of files) h.update(`${f}\0${fileHash(path.join(dir, f))}\n`);
  return h.digest('hex').slice(0, 16);
}

/**
 * The fingerprint now: a short hash per control file of the main tree (the plugin's scripts as one entry).
 * @param {{ mainTree: string, scriptsDir?: string|null, configFile?: string|null, now?: Date }} o
 * @returns {{ root: string, at: string, files: Record<string, string> }}
 */
function fingerprint({ mainTree, scriptsDir = null, configFile = null, now = new Date() }) {
  const files = {};
  const cfg = configFile || path.join(mainTree, 'queue.config.json');
  if (fs.existsSync(cfg)) files['queue.config.json'] = fileHash(cfg);
  try {
    for (const name of fs.readdirSync(mainTree))
      if (/^claude[^/]*\.md$/i.test(name) && fs.statSync(path.join(mainTree, name)).isFile()) files[name] = fileHash(path.join(mainTree, name));
  } catch {
    // no main tree: nothing to record
  }
  const claude = path.join(mainTree, '.claude');
  const inClaude = filesUnder(claude, new Set(['worktrees']));
  if (inClaude.length > MAX_FILES) files['.claude/'] = groupHash(claude, inClaude);
  else for (const f of inClaude) files[`.claude/${f}`] = fileHash(path.join(claude, f));
  const dotGit = path.join(mainTree, '.git');
  try {
    if (fs.statSync(dotGit).isDirectory()) {
      const cfgFile = path.join(dotGit, 'config');
      if (fs.existsSync(cfgFile)) files['.git/config'] = short(gitConfigText(fs.readFileSync(cfgFile, 'utf8')));
      // The hooks as the git surface reads them: Ravenseat's own pre-push block counts as no file (lib/agentPushBlock.js).
      const hooks = require('./gitExecSurface.js').hookFiles(path.join(dotGit, 'hooks'));
      for (const [k, v] of Object.entries(hooks)) if (!k.endsWith('.sample')) files[`.git/hooks/${k}`] = String(v).slice(0, 16);
    }
  } catch {
    // a linked worktree or no git: the git part is left out
  }
  if (scriptsDir && fs.existsSync(scriptsDir)) files[SCRIPTS_KEY] = groupHash(scriptsDir, filesUnder(scriptsDir, new Set(), SCRIPTS_SKIP));
  return { root: path.resolve(mainTree), at: now.toISOString(), files };
}

/**
 * What changed between two fingerprints of the same main tree, sorted. Nothing when one is missing or they are of
 * different trees.
 * @returns {{ name: string, change: 'changed'|'added'|'removed' }[]}
 */
function compare(before, after) {
  if (!before?.files || !after?.files || norm(before.root) !== norm(after.root)) return [];
  const out = [];
  for (const name of [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])].sort()) {
    const a = before.files[name];
    const b = after.files[name];
    if (a === b) continue;
    out.push({ name, change: a == null ? 'added' : b == null ? 'removed' : 'changed' });
  }
  return out;
}

/**
 * The changes git does not explain: a file tracked and clean now came in through a commit (another track's merge),
 * which git log shows. `committed` holds those names.
 */
function unexplained(changes, { committed = new Set() } = {}) {
  return (changes ?? []).filter((c) => !committed.has(c.name));
}

/** The receive lines for the changes. `others` = the tracks that ran at the same time. */
function warningLines(id, changes, { root, others = [] } = {}) {
  if (!changes?.length) return [];
  const what = changes.map((c) => `${c.name} (${c.change})`).join(', ');
  const lines = [
    `CONTROL FILES CHANGED ${id}: ${what} in the main tree ${root} since the track started, outside git. These files ` +
      'steer the guards and every later session. If you did not change them yourself (ravenseat settings set, your own ' +
      'edit), look at them before you merge: a track must never change them.',
  ];
  if (others.length) lines.push(`  ${others.join(', ')} ran at the same time and could have made the change as well.`);
  return lines;
}

module.exports = {
  KIND,
  SCRIPTS_KEY,
  MAX_FILES,
  controlKind,
  assessControlWrite,
  controlShellReason,
  gitConfigWrite,
  fingerprint,
  compare,
  unexplained,
  warningLines,
};
