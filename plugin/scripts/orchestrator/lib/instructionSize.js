// =============================================================
// instructionSize.js: how much instruction text Claude Code loads, measured the way it loads it.
//
// Why: every line in a CLAUDE.md, a rule without `paths:` and their imports is in the context of every turn, every
// track and every subagent, so a growing set costs tokens all the time and dilutes the model's attention. The number
// that matters is the sum of everything loaded at start, not the root file alone, and Ravenseat multiplies it: each
// track and reviewer is a new session that loads the whole set.
//
// What loads at start (Claude Code's memory docs):
//   - the organization policy file (managed), when it can be read
//   - ~/.claude/CLAUDE.md and ~/.claude/rules/**/*.md without `paths:` (the user's own, its own line in the totals)
//   - CLAUDE.md, .claude/CLAUDE.md and CLAUDE.local.md in the project folder and every folder above it
//   - .claude/rules/**/*.md without `paths:`
//   - AGENTS.md (the nearest) only when none of the CLAUDE files exists on that path
//   - every `@path` import of those, up to four hops, never from a code block or a code span, relative to the importing
//     file, `~` = the home folder. An import saves nothing: it is loaded with the file that names it.
// HTML block comments are stripped before loading (outside code blocks), so they are taken off the count.
// What loads on demand: a rule with `paths:` and a CLAUDE.md in a subfolder, each with its imports. Claude Code cuts such
// a file at 40,000 characters (on a 200K window), so Claude sees only its start.
//
// Units: characters as letters (code points, like `wc -m` and Claude Code's warning), lines of the file as written, and
// tokens as an estimate (chars / 4). Files named CLAUDE.queue.md are Ravenseat's share and shown apart.
//
// The reading is behind a small io object (read, list), so the logic has no I/O of its own, and every path it looked at
// is recorded (`watched`): lib/instructionNotice.js keeps a cache and measures again only when one of them changed.
//
//   measure(opts)       the files loaded at start and on demand, the totals and the share per scope
//   assess(m, limits)   the files over maxLines, the total over maxChars, and the on-demand files that are cut
//   limitsOf(config)    instructionSize.{mode, maxLines, maxChars} with the defaults
//
// Used by: cli/doctorBaseline.mjs (the doctor rows), cli/instructions.mjs (`ravenseat instructions`), cli/checks.mjs (the
// Checks suggestion) and lib/instructionNotice.js (the one-time chat message). Tested in lib/__tests__/instructionSize.test.ts.
// =============================================================
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** Claude Code's target per always-loaded file ("target under 200 lines per CLAUDE.md file", the memory docs). */
const MAX_LINES = 200;
/** Where Claude Code's own start-up warning fires for the loaded set (reported as "> 40.0k"; the number is not documented). */
const MAX_CHARS = 40000;
/** The documented cut-off for a file loaded on demand, with its imports, on a 200K window (150,000 on a 1M window). */
const CUT_CHARS = 40000;
/** Import hops Claude Code follows. */
const MAX_HOPS = 4;
/** Claude Code skips a file over 4 MiB. */
const MAX_BYTES = 4 * 1024 * 1024;
const MODES = ['warn', 'off'];
/** The file that is Ravenseat's own (setup copies it and imports it from CLAUDE.md). */
const RAVENSEAT_FILE = 'claude.queue.md';

/** instructionSize from the config, each field checked: an unknown or broken value reads as its default. */
function limitsOf(config) {
  const own = config?.instructionSize ?? {};
  const whole = (v, d) => (Number.isInteger(v) && v > 0 ? v : d);
  return {
    mode: MODES.includes(own.mode) ? own.mode : 'warn',
    maxLines: whole(own.maxLines, MAX_LINES),
    maxChars: whole(own.maxChars, MAX_CHARS),
  };
}

/** Letters, not UTF-16 units: "æøå" is three, as `wc -m` counts it. */
function letters(text) {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    // The second half of a surrogate pair is the same letter.
    if (c < 0xdc00 || c > 0xdfff) count++;
  }
  return count;
}

/** Lines as an editor shows them (a final newline does not start another one). */
function lineCount(text) {
  if (!text) return 0;
  const count = text.split('\n').length;
  return text.endsWith('\n') ? count - 1 : count;
}

// A fenced code block (``` or ~~~), to the closing fence or the end of the file.
const FENCE = /^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[`~]*[ \t]*$|(?![\s\S]))/gm;

/** The text with every fenced block replaced by a marker, and the blocks, so they can be put back. */
function hideFences(text) {
  const blocks = [];
  const hidden = text.replace(FENCE, (m) => `\u0000${blocks.push(m) - 1}\u0000`);
  return { hidden, blocks };
}

/** What Claude Code loads: HTML block comments outside code blocks are stripped. */
function loadedText(text) {
  const { hidden, blocks } = hideFences(text);
  return hidden.replace(/<!--[\s\S]*?-->/g, '').replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[Number(i)]);
}

/** The `@path` imports in a loaded text, in order: none from a code block or a code span. */
function importsOf(text) {
  const prose = hideFences(text).hidden.replace(/\u0000\d+\u0000/g, '').replace(/(`+)[\s\S]*?\1/g, '');
  const out = [];
  for (const m of prose.matchAll(/(^|[\s(])@([^\s`'"<>()[\]]+)/g)) {
    const p = m[2].replace(/[.,;:!?]+$/, '');
    if (p) out.push(p);
  }
  return out;
}

/** The `paths:` list in a rule's front matter, or null when it has none (the rule then loads at start). */
function pathsOf(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!m) return null;
  const lines = m[1].split(/\r?\n/);
  const unquote = (s) => s.trim().replace(/^['"]|['"]$/g, '').trim();
  for (let i = 0; i < lines.length; i++) {
    const h = /^paths\s*:\s*(.*)$/.exec(lines[i]);
    if (!h) continue;
    const value = h[1].trim();
    let list;
    if (value.startsWith('[')) list = value.replace(/^\[|\]$/g, '').split(',').map(unquote);
    else if (value) list = [unquote(value)];
    else {
      list = [];
      for (let j = i + 1; j < lines.length && /^\s*-\s*/.test(lines[j]); j++) list.push(unquote(lines[j].replace(/^\s*-\s*/, '')));
    }
    list = list.filter(Boolean);
    return list.length ? list : null;
  }
  return null;
}

/** The plain disk: a regular file up to MAX_BYTES as text, a folder's entries; null for anything else. */
const DISK = {
  read(file) {
    try {
      const st = fs.statSync(file);
      if (!st.isFile() || st.size > MAX_BYTES) return null;
      return fs.readFileSync(file, 'utf8');
    } catch {
      return null;
    }
  },
  list(dir) {
    try {
      return fs.readdirSync(dir, { withFileTypes: true }).map((d) => ({ name: d.name, dir: d.isDirectory() }));
    } catch {
      return null;
    }
  },
};

/** The organization policy file on this platform (Claude Code's managed CLAUDE.md). RAVENSEAT_MANAGED_CLAUDE_MD overrides. */
function managedPath(env = process.env, platform = process.platform) {
  if (env.RAVENSEAT_MANAGED_CLAUDE_MD !== undefined) return env.RAVENSEAT_MANAGED_CLAUDE_MD || null;
  if (platform === 'win32') return 'C:\\Program Files\\ClaudeCode\\CLAUDE.md';
  if (platform === 'darwin') return '/Library/Application Support/ClaudeCode/CLAUDE.md';
  return '/etc/claude-code/CLAUDE.md';
}

/** Paths compared without case where the file system ignores it (Windows, macOS). */
const keyOf = (p) => (process.platform === 'win32' || process.platform === 'darwin' ? path.resolve(p).toLowerCase() : path.resolve(p));

/**
 * Measures the instruction set of a project.
 * @param {{ root: string, claudeDir?: string, home?: string, managed?: string|null, top?: string|null,
 *   nested?: string[], keepText?: boolean, io?: { read: (f: string) => string|null, list: (d: string) => {name: string, dir: boolean}[]|null } }} o
 *   root: the folder Claude Code runs in. claudeDir: the user's Claude folder (~/.claude). top: the highest folder the
 *   upward walk visits (tests; the file system root by default). nested: subfolder CLAUDE.md files, found by the caller.
 *   keepText: each entry also holds its text as written (raw).
 */
function measure(o) {
  const root = path.resolve(o.root);
  const claudeDir = path.resolve(o.claudeDir ?? path.join(os.homedir(), '.claude'));
  const home = path.resolve(o.home ?? os.homedir());
  const io = o.io ?? DISK;
  const watched = new Map();
  const watch = (p, kind) => watched.set(keyOf(p), { path: p, kind });
  const read = (p) => {
    watch(p, 'file');
    return io.read(p);
  };
  const list = (d) => {
    watch(d, 'dir');
    return io.list(d);
  };

  const inside = (dir, p) => {
    const r = path.relative(dir, p);
    return r && !r.startsWith('..') && !path.isAbsolute(r) ? r.replace(/\\/g, '/') : null;
  };
  const relOf = (p) => inside(root, p) ?? (inside(claudeDir, p) != null ? `~/.claude/${inside(claudeDir, p)}` : p.replace(/\\/g, '/'));
  const scopeFor = (p, scope) => (path.basename(p).toLowerCase() === RAVENSEAT_FILE ? 'ravenseat' : scope);
  // Each file is read once per measurement, also when a rule is both listed and loaded.
  const texts = new Map();
  const readOnce = (p) => {
    const k = keyOf(p);
    if (!texts.has(k)) texts.set(k, read(p));
    return texts.get(k);
  };

  /** A file and its imports, depth first, each once per `seen`. Returns the entries in load order. */
  function load(file, { scope, kind, seen, depth = 0, via = null }) {
    const key = keyOf(file);
    if (seen.has(key)) return [];
    const raw = readOnce(file);
    if (raw == null) return [];
    seen.add(key);
    const text = loadedText(raw);
    const entry = {
      path: file,
      rel: relOf(file),
      scope: scopeFor(file, scope),
      kind: depth ? 'import' : kind,
      chars: letters(text),
      lines: lineCount(raw),
      via: via ? relOf(via) : null,
      // The text as written, for `ravenseat instructions` (sections, duplicates), so no file is read twice.
      ...(o.keepText ? { raw } : {}),
    };
    const out = [entry];
    if (depth < MAX_HOPS)
      for (const imp of importsOf(text)) {
        const target = imp.startsWith('~/') ? path.join(home, imp.slice(2)) : path.resolve(path.dirname(file), imp);
        out.push(...load(target, { scope, kind, seen, depth: depth + 1, via: file }));
      }
    return out;
  }

  /** The .md files under a rules folder, sorted, as full paths. */
  function rulesIn(dir) {
    const out = [];
    const walk = (d) => {
      const items = list(d);
      if (!items) return;
      for (const it of [...items].sort((x, y) => x.name.localeCompare(y.name))) {
        const p = path.join(d, it.name);
        if (it.dir) walk(p);
        else if (it.name.toLowerCase().endsWith('.md')) out.push(p);
      }
    };
    walk(dir);
    return out;
  }

  const seen = new Set();
  const always = [];
  const onDemand = [];
  const lazy = (file, kind, scope, paths) => {
    const group = load(file, { scope, kind, seen: new Set() });
    if (!group.length) return;
    onDemand.push({
      path: file,
      rel: group[0].rel,
      kind,
      scope: group[0].scope,
      paths,
      chars: group.reduce((s, f) => s + f.chars, 0),
      lines: group[0].lines,
      files: group.length,
      parts: group,
    });
  };
  const rules = (dir, scope) => {
    for (const f of rulesIn(dir)) {
      const text = readOnce(f);
      if (text == null) continue;
      const paths = pathsOf(text);
      if (paths) lazy(f, 'rule', scope, paths);
      else always.push(...load(f, { scope, kind: 'rule', seen }));
    }
  };

  if (o.managed) always.push(...load(o.managed, { scope: 'organization', kind: 'claude-md', seen }));
  always.push(...load(path.join(claudeDir, 'CLAUDE.md'), { scope: 'user', kind: 'claude-md', seen }));
  rules(path.join(claudeDir, 'rules'), 'user');

  // The folders from the top down to the project, as Claude Code loads them (the closest last).
  const chain = [];
  const top = o.top ? path.resolve(o.top) : null;
  for (let d = root; ; d = path.dirname(d)) {
    chain.unshift(d);
    if ((top && keyOf(d) === keyOf(top)) || path.dirname(d) === d) break;
  }
  // ~/.claude/CLAUDE.md is the user's file, counted above (or deliberately not, when claudeDir points elsewhere), so the
  // walk does not count it again when it passes the home folder.
  seen.add(keyOf(path.join(home, '.claude', 'CLAUDE.md')));
  let anyClaude = false;
  for (const d of chain)
    for (const name of ['CLAUDE.md', path.join('.claude', 'CLAUDE.md'), 'CLAUDE.local.md']) {
      const got = load(path.join(d, name), { scope: 'project', kind: 'claude-md', seen });
      if (got.length) anyClaude = true;
      always.push(...got);
    }
  if (!anyClaude)
    for (const d of [...chain].reverse()) {
      const got = load(path.join(d, 'AGENTS.md'), { scope: 'project', kind: 'agents-md', seen });
      if (got.length) {
        always.push(...got);
        break;
      }
    }
  rules(path.join(root, '.claude', 'rules'), 'project');
  for (const f of o.nested ?? []) lazy(path.resolve(f), 'nested', 'project', null);

  const byScope = { organization: 0, user: 0, project: 0, ravenseat: 0 };
  for (const f of always) byScope[f.scope] += f.chars;
  const chars = always.reduce((s, f) => s + f.chars, 0);
  return {
    root,
    always,
    onDemand,
    total: { chars, lines: always.reduce((s, f) => s + f.lines, 0), files: always.length, tokens: Math.round(chars / 4) },
    byScope,
    watched: [...watched.values()],
  };
}

/**
 * The measurement against the limits. overLines: always-loaded files over maxLines. overTotal: the sum over maxChars.
 * cut: on-demand files over CUT_CHARS with their imports (a fact of Claude Code, not a setting). large: any of it.
 */
function assess(m, limits = {}) {
  const maxLines = limits.maxLines ?? MAX_LINES;
  const maxChars = limits.maxChars ?? MAX_CHARS;
  const overLines = (m.always ?? []).filter((f) => f.lines > maxLines);
  const overTotal = (m.total?.chars ?? 0) > maxChars;
  const cut = (m.onDemand ?? []).filter((f) => f.chars > CUT_CHARS);
  return { overLines, overTotal, cut, large: overLines.length > 0 || overTotal || cut.length > 0, maxLines, maxChars };
}

/**
 * The CLAUDE.md files in subfolders (they load on demand), for doctor and `ravenseat instructions`. git lists them when the
 * folder is a repo (fast in a large tree, and ignored folders such as worktrees stay out); otherwise a bounded walk that
 * skips dot folders and dependency and build folders.
 */
function nestedFiles(root) {
  const isNested = (rel) => rel.includes('/') && /(^|\/)CLAUDE(\.local)?\.md$/i.test(rel);
  try {
    const out = require('node:child_process').execFileSync(
      'git',
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ':(glob)**/CLAUDE.md', ':(glob)**/CLAUDE.local.md'],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024, windowsHide: true },
    );
    return [...new Set(out.split('\0').filter((r) => r && isNested(r)))].sort().map((r) => path.join(root, r));
  } catch {
    /* not a git repo: walk */
  }
  const SKIP = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', 'vendor', 'target', 'venv', '__pycache__']);
  const found = [];
  let budget = 20000;
  const walk = (d, rel, depth) => {
    if (depth > 8 || budget <= 0) return;
    let items;
    try {
      items = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      if (--budget <= 0) return;
      const r = rel ? `${rel}/${it.name}` : it.name;
      if (it.isDirectory()) {
        if (!it.name.startsWith('.') && !SKIP.has(it.name)) walk(path.join(d, it.name), r, depth + 1);
      } else if (isNested(r)) found.push(path.join(root, r));
    }
  };
  walk(root, '', 0);
  return found.sort();
}

/** measure() for a project on disk, with the user's real folders (RAVENSEAT_CLAUDE_DIR and RAVENSEAT_INSTRUCTIONS_TOP for tests). */
function measureDisk(root, { env = process.env, nested = false, keepText = false } = {}) {
  return measure({
    root,
    claudeDir: require('./claudeFingerprint.js').claudeDir(env),
    home: os.homedir(),
    managed: managedPath(env),
    top: env.RAVENSEAT_INSTRUCTIONS_TOP || null,
    nested: nested ? nestedFiles(root) : [],
    keepText,
  });
}

/** The auto memory index of the main session (not loaded in tracks): its first 200 lines or 25 KB, or null. */
function memoryOf(root, claudeDir) {
  const file = path.join(claudeDir, 'projects', path.resolve(root).replace(/[^A-Za-z0-9]/g, '-'), 'memory', 'MEMORY.md');
  const raw = DISK.read(file);
  if (raw == null) return null;
  let text = raw.split('\n').slice(0, 200).join('\n');
  if (Buffer.byteLength(text) > 25 * 1024) text = Buffer.from(text).subarray(0, 25 * 1024).toString('utf8');
  return { path: file, chars: letters(text), lines: lineCount(text) };
}

/** 62400 -> "62,400" (the same in every locale, so tests and docs match). */
const n = (x) => String(Math.round(x)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

module.exports = {
  MAX_LINES,
  MAX_CHARS,
  CUT_CHARS,
  MAX_HOPS,
  MODES,
  limitsOf,
  letters,
  lineCount,
  loadedText,
  importsOf,
  pathsOf,
  managedPath,
  measure,
  measureDisk,
  nestedFiles,
  memoryOf,
  assess,
  n,
};
