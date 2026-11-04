#!/usr/bin/env node
// =============================================================
// setup.mjs: sets a project up for the work queue. Run by the /cq:setup skill as `cq setup`, and reused by
// scripts/install.mjs (vendored install), so both install paths write the same project files.
//
// Usage:
//   cq setup [--dry] [--overwrite] [--claude-md] [--settings] [--ci] [--target <dir>]
//
// What it does (everything is "add to"; existing files are kept unless --overwrite, and queue.config.json is never replaced):
//   1. queue.config.json from <plugin>/queue.config.example.json, when missing, with the current branch and the checks
//      the project's files show (fillConfigFromProject).
//   2. <plugin>/docs/*.md -> docs/queue/ (the mission template there is the project's own copy and may be edited).
//   3. CLAUDE.queue.md (the queue's rules for Claude), when missing.
//   4. .gitignore: the data folder and the agents' worktrees.
//   5. --claude-md: adds the line @CLAUDE.queue.md to CLAUDE.md (creates the file when missing).
//   6. --settings: adds the recommended settings to .claude/settings.json (1 h prompt cache for subagents, compaction
//      at 300k, worktrees from HEAD, the status line statusline.mjs). A plugin cannot set these itself; without the flag
//      they are only listed. A plugin install writes the status line with the plugin's absolute (versioned) path, so
//      run --settings again after a plugin update; a status line of your own is kept.
//   7. --settings in a plugin install records the plugin version in <dataFolder>/setup.json, so the board can show
//      that setup must be run again after an update (lib/queueUpdate.js).
//   8. --ci: writes the GitHub Actions template <plugin>/templates/ci-github.yml to .github/workflows/cq-gates.yml (it
//      runs the project's own gates.quick, with baseBranch filled in). An existing file is NEVER replaced, also not
//      with --overwrite. Opt-in only: /cq:setup asks first.
//   Hooks (install.mjs only, a plugin brings hooks/hooks.json): every hook in settings.queue.json is added next to the
//   project's own, also hooks added in a later version (e.g. hook-track-end.mjs on SubagentStop). The two files must
//   list the same scripts (__tests__/setup.test.ts checks it).
// The target is the project's main tree (lib/projectRoot.js), or --target.
// =============================================================
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The plugin root: two folders above scripts/orchestrator/. */
export const PLUGIN_ROOT = path.resolve(HERE, '..', '..');

/** Where --ci writes the GitHub Actions template (relative to the target). */
export const CI_WORKFLOW = '.github/workflows/cq-gates.yml';

/**
 * The lines .gitignore needs: the queue's data, the agents' worktrees, the personal settings (an absolute path) and
 * local secret files, so one `git add .` does not commit them. A file git already tracks stays tracked; cq doctor names it.
 */
export const GITIGNORE_LINES = [
  'scripts/.queue/',
  '.claude/worktrees/',
  '.claude/settings.local.json',
  '.env',
  '.env.*',
  '!.env.example',
];

/**
 * Sets up `target`. Returns a log { copied, replaced, skipped, notes } and writes nothing when `dry`.
 * @param {object} o
 * @param {string} o.target                 the project's main tree
 * @param {boolean} [o.dry]                 only report
 * @param {boolean} [o.overwrite]           replace existing docs and CLAUDE.queue.md
 * @param {boolean} [o.claudeMd]            add @CLAUDE.queue.md to CLAUDE.md
 * @param {boolean} [o.settings]            add the recommended keys to .claude/settings.json
 * @param {boolean} [o.ci]                  write the GitHub Actions template (never over an existing file)
 * @param {boolean} [o.hooks]               also merge the hooks into .claude/settings.json (vendored install only;
 *                                          a plugin has its own hooks/hooks.json)
 * @param {(text: string) => string} [o.transformMd]  rewrites the Markdown on the way (install.mjs: cq -> node form)
 */
export function setupProject(o) {
  const log = { copied: [], replaced: [], skipped: [], notes: [] };
  const t = path.resolve(o.target);
  const rel = (p) => path.relative(t, p).split(path.sep).join('/');
  const write = (to, text) => {
    if (o.dry) return;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, text);
  };
  /** Copies one file; Markdown goes through transformMd. Existing files are kept unless overwrite. */
  const copy = (from, to, overwrite = o.overwrite) => {
    if (fs.existsSync(to)) {
      if (!overwrite) return void log.skipped.push(rel(to));
      log.replaced.push(rel(to));
    } else log.copied.push(rel(to));
    const text = fs.readFileSync(from, 'utf8');
    write(to, from.endsWith('.md') && o.transformMd ? o.transformMd(text) : text);
  };

  // 1-3: files. queue.config.json holds the project's own options and is never replaced. A new one gets the project's
  // own branch and checks, so a first run does not start on the example's values.
  const configTo = path.join(t, 'queue.config.json');
  const configIsNew = !fs.existsSync(configTo);
  copy(path.join(PLUGIN_ROOT, 'queue.config.example.json'), configTo, false);
  if (configIsNew) {
    const filled = fillConfigFromProject(fs.readFileSync(path.join(PLUGIN_ROOT, 'queue.config.example.json'), 'utf8'), t);
    write(configTo, filled.text);
    log.notes.push(...filled.notes);
  }
  for (const f of fs.readdirSync(path.join(PLUGIN_ROOT, 'docs')).filter((f) => f.endsWith('.md')).sort())
    copy(path.join(PLUGIN_ROOT, 'docs', f), path.join(t, 'docs', 'queue', f));
  copy(path.join(PLUGIN_ROOT, 'CLAUDE.queue.md'), path.join(t, 'CLAUDE.queue.md'));

  // 4: .gitignore
  const gitignorePath = path.join(t, '.gitignore');
  const gitignore = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : '';
  const missing = GITIGNORE_LINES.filter((l) => !gitignore.split(/\r?\n/).some((x) => x.trim() === l));
  if (missing.length) {
    const pre = gitignore && !gitignore.endsWith('\n') ? '\n' : '';
    if (!o.dry)
      fs.appendFileSync(gitignorePath, `${pre}\n# Ravenseat (the queue's data, the agents' worktrees and local secrets)\n${missing.join('\n')}\n`);
    log.notes.push(`.gitignore: added ${missing.join(' ')}`);
  } else log.notes.push('.gitignore: unchanged');

  // 5: CLAUDE.md import line
  const claudeMd = path.join(t, 'CLAUDE.md');
  const hasImport =
    fs.existsSync(claudeMd) && fs.readFileSync(claudeMd, 'utf8').split(/\r?\n/).some((l) => l.trim() === '@CLAUDE.queue.md');
  if (hasImport) log.notes.push('CLAUDE.md: already imports CLAUDE.queue.md');
  else if (o.claudeMd) {
    const old = fs.existsSync(claudeMd) ? fs.readFileSync(claudeMd, 'utf8') : '';
    write(claudeMd, `${old}${old && !old.endsWith('\n') ? '\n' : ''}${old ? '\n' : ''}@CLAUDE.queue.md\n`);
    log.notes.push('CLAUDE.md: added @CLAUDE.queue.md');
  } else log.notes.push('CLAUDE.md: does not import CLAUDE.queue.md (run again with --claude-md, or add the line yourself)');

  // 6: settings
  log.notes.push(...mergeSettings(t, { dry: o.dry, keys: o.settings, hooks: o.hooks }));

  // 7: --settings in a plugin install records the plugin version it set up, so the board can tell when setup has not
  // been run after a plugin update (lib/queueUpdate.js). It lives in the queue's data folder (gitignored).
  if (o.settings && !o.hooks) {
    const note = recordSetupVersion(t, { dry: o.dry });
    if (note) log.notes.push(note);
  }

  // 8: --ci, the GitHub Actions template. Never over an existing workflow.
  if (o.ci) log.notes.push(writeCiTemplate(t, { dry: o.dry }));
  return log;
}

/**
 * The example config with the project's current branch as baseBranch and the checks its files show as gates (the same
 * detector as cq kickstart). Edits the text, so the comments in the example stay. No checks found: empty lists, and a
 * note that says so, never a command that does not exist in the project.
 * @returns {{ text: string, notes: string[] }}
 */
export function fillConfigFromProject(text, target) {
  const K = require('./lib/kickstart.js');
  const notes = [];
  let out = text;
  let branch = null;
  try {
    branch = execFileSync('git', ['-C', target, 'symbolic-ref', '--short', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim();
  } catch {
    /* not git, or a detached HEAD: the example's value stays, and cq doctor says if the branch is missing */
  }
  if (branch) {
    out = out.replace(/("baseBranch":\s*)"[^"]*"/, (_, key) => `${key}${JSON.stringify(branch)}`);
    notes.push(`queue.config.json: baseBranch ${branch} (the current branch)`);
  }
  const { checks } = K.detectChecks({
    exists: (f) => fs.existsSync(path.join(target, f)),
    read: (f) => {
      try {
        return fs.readFileSync(path.join(target, f), 'utf8');
      } catch {
        return null;
      }
    },
  });
  const lists = K.gateLists(checks);
  const list = (name) => {
    out = out.replace(new RegExp(`("${name}":\\s*)\\[[^\\]]*\\]`), (_, key) => `${key}${JSON.stringify(lists[name]).replace(/","/g, '", "')}`);
  };
  list('quick');
  list('full');
  notes.push(
    checks.length
      ? `queue.config.json: gates.quick ${lists.quick.join(', ') || 'empty'}; gates.full ${lists.full.join(', ') || 'empty'} (found in the project; change them if they are wrong)`
      : 'queue.config.json: no check commands found, so the gates are empty and agents run no checks. Add your own, or see cq kickstart.',
  );
  return { text: out, notes };
}

/** Writes the CI template to <target>/CI_WORKFLOW unless it exists. Returns a note for the log. */
export function writeCiTemplate(target, o = {}) {
  const to = path.join(target, ...CI_WORKFLOW.split('/'));
  if (fs.existsSync(to)) return `${CI_WORKFLOW}: kept (already there; setup never overwrites a workflow)`;
  const from = path.join(PLUGIN_ROOT, 'templates', 'ci-github.yml');
  if (!fs.existsSync(from)) return `${CI_WORKFLOW}: not written (no template in this install: ${from})`;
  const KK = require('./lib/queueConfig.js');
  const base = KK.config({ root: target }).baseBranch || 'main';
  if (!o.dry) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, fs.readFileSync(from, 'utf8').split('__BASE_BRANCH__').join(base));
  }
  const others = (() => {
    try {
      return fs.readdirSync(path.dirname(to)).filter((f) => /\.ya?ml$/i.test(f) && f !== path.basename(to));
    } catch {
      return [];
    }
  })();
  const twice = others.length ? `; you already have ${others.join(', ')}: check that they do not run the same checks twice` : '';
  return `${CI_WORKFLOW}: written (runs gates.quick on push to ${base} and on pull requests; add your runtime setup step)${twice}`;
}

/** The record setup --settings writes: <dataFolder>/setup.json. QUEUE_FOLDER overrides the folder, as for queue.mjs. */
export function setupRecordFile(target) {
  const KK = require('./lib/queueConfig.js');
  const folder = process.env.QUEUE_FOLDER ?? path.join(target, KK.config({ root: target }).dataFolder);
  return path.join(folder, 'setup.json');
}

/**
 * Writes { pluginVersion, at } to setupRecordFile(target). Only when the plugin manifest exists (a plugin install).
 * Returns a note for the log, or null.
 */
export function recordSetupVersion(target, o = {}) {
  let version = null;
  try {
    version = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version ?? null;
  } catch {
    return null;
  }
  if (!version) return null;
  const file = setupRecordFile(target);
  const rel = path.relative(target, file).split(path.sep).join('/');
  if (!o.dry) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ pluginVersion: version, at: new Date().toISOString() }, null, 2) + '\n');
    } catch (e) {
      return `setup record: could not write ${rel} (${e.message})`;
    }
  }
  return `setup record: plugin ${version} (${rel})`;
}

/**
 * Merges settings.queue.json into <target>/.claude/settings.json: missing keys are added, existing values are kept, and
 * hooks (only with `hooks`) are added when the same command is not there yet. Without `keys` the keys are only listed.
 */
export function mergeSettings(target, o = {}) {
  const fresh = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'settings.queue.json'), 'utf8'));
  const settingsPath = path.join(target, '.claude', 'settings.json');
  let existing = {};
  if (fs.existsSync(settingsPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch (e) {
      return [`.claude/settings.json: could not read it as JSON (${e.message}); not changed`];
    }
  }
  const changes = [];
  const wanted = [];
  // statusLine (statusline.mjs): a plugin cannot set it, and $CLAUDE_PLUGIN_ROOT is not expanded in project settings,
  // so a plugin install writes the plugin's absolute path. That path holds the user name and the plugin version, so it
  // goes in .claude/settings.local.json (personal, not committed), and one left in settings.json by an earlier setup
  // moves there. A status line that is already ours (it runs scripts/orchestrator/statusline.mjs) is refreshed. Someone
  // else's is kept untouched (no subkeys merged into it).
  const isOurs = (s) => String(s?.command ?? '').includes('scripts/orchestrator/statusline.mjs');
  if (fresh.statusLine && !o.hooks) {
    const localPath = path.join(target, '.claude', 'settings.local.json');
    let local = null;
    try {
      local = fs.existsSync(localPath) ? JSON.parse(fs.readFileSync(localPath, 'utf8')) : {};
    } catch (e) {
      changes.push(`.claude/settings.local.json: could not read it as JSON (${e.message}); status line not set`);
    }
    const shared = existing.statusLine;
    const own = local?.statusLine;
    if (!local) {
      /* said above */
    } else if ((shared !== undefined && !isOurs(shared)) || (own !== undefined && !isOurs(own))) {
      changes.push('statusLine: kept your own (the queue status line is scripts/orchestrator/statusline.mjs)');
    } else {
      const command = `node "${path.join(PLUGIN_ROOT, 'scripts', 'orchestrator', 'statusline.mjs').split(path.sep).join('/')}"`;
      if (own?.command !== command || shared !== undefined) {
        wanted.push(`statusLine=${command} (in .claude/settings.local.json)`);
        if (o.keys) {
          local.statusLine = { ...fresh.statusLine, ...shared, ...own, command };
          delete existing.statusLine;
          fs.mkdirSync(path.dirname(localPath), { recursive: true });
          fs.writeFileSync(localPath, JSON.stringify(local, null, 2) + '\n');
        }
      }
    }
  } else if (fresh.statusLine) {
    const ours = { ...fresh.statusLine };
    const own = existing.statusLine;
    if (own === undefined) {
      wanted.push(`statusLine=${ours.command}`);
      if (o.keys) existing.statusLine = ours;
    } else if (isOurs(own)) {
      if (own.command !== ours.command) {
        wanted.push(`statusLine=${ours.command} (refreshed)`);
        if (o.keys) existing.statusLine = { ...own, command: ours.command };
      }
    } else changes.push('statusLine: kept your own (the queue status line is scripts/orchestrator/statusline.mjs)');
  }
  for (const [key, val] of Object.entries(fresh)) {
    if (key.startsWith('_') || key.startsWith('$') || key === 'hooks' || key === 'statusLine') continue; // comments; hooks below
    if (existing[key] === undefined) {
      wanted.push(`${key}=${JSON.stringify(val)}`);
      if (o.keys) existing[key] = val;
    } else if (typeof val === 'object' && !Array.isArray(val) && typeof existing[key] === 'object') {
      for (const [k, v] of Object.entries(val))
        if (existing[key][k] === undefined) {
          wanted.push(`${key}.${k}=${JSON.stringify(v)}`);
          if (o.keys) existing[key][k] = v;
        }
    }
  }
  if (wanted.length) changes.push(o.keys ? `added ${wanted.join(', ')}` : `recommended, not set (use --settings): ${wanted.join(', ')}`);
  if (o.hooks) {
    // A hook is identified by the queue script it runs (hook-x.mjs), whether it is written in shell form
    // (`command` is the whole command line) or in exec form (`command` is "node" and the script is in `args`).
    // Other hooks (the project's own) are identified by command + args.
    const hookKey = (h) => {
      const line = [h?.command ?? '', ...(Array.isArray(h?.args) ? h.args : [])].join(' ').replace(/\\/g, '/');
      return /scripts\/orchestrator\/(hook-[\w-]+\.mjs)/.exec(line)?.[1] ?? JSON.stringify([h?.command, h?.args ?? null]);
    };
    const keys = (groups) => new Set((groups ?? []).flatMap((g) => (g.hooks ?? []).map(hookKey)));
    existing.hooks = existing.hooks ?? {};
    // Older installs wrote shell form: relative paths (`node scripts/orchestrator/hook-x.mjs`, which break when the
    // session's working directory is not the project root) or `node "$CLAUDE_PROJECT_DIR/scripts/orchestrator/hook-x.mjs"`.
    // Rewrite both to exec form (command "node", the script in args): no shell is started, which on Windows saves the
    // Git Bash start on every call. Only our own exact command lines are rewritten; the other fields (timeout) stay.
    const OLD = /^node (?:scripts\/orchestrator\/|"\$\{?CLAUDE_PROJECT_DIR\}?\/scripts\/orchestrator\/)(hook-[\w-]+\.mjs)"?$/;
    for (const groups of Object.values(existing.hooks))
      for (const g of groups ?? [])
        for (const h of g.hooks ?? []) {
          if (h.args !== undefined) continue; // already exec form
          const m = OLD.exec(h.command ?? '');
          if (!m) continue;
          h.command = 'node';
          h.args = [`\${CLAUDE_PROJECT_DIR}/scripts/orchestrator/${m[1]}`];
          changes.push(`hook made exec form: ${m[1]}`);
        }
    for (const [event, groups] of Object.entries(fresh.hooks ?? {})) {
      const list = (existing.hooks[event] = existing.hooks[event] ?? []);
      const there = keys(list);
      for (const g of groups) {
        const added = (g.hooks ?? []).filter((h) => !there.has(hookKey(h)));
        if (!added.length) continue;
        list.push({ ...g, hooks: added });
        changes.push(`hook ${event}: ${added.map(hookKey).join(', ')}`);
      }
    }
  }
  const touched = (o.keys && wanted.length) || changes.some((c) => c.startsWith('hook'));
  if (touched && !o.dry) {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(existing, null, 2) + '\n');
  }
  return [`.claude/settings.json: ${changes.length ? changes.join('; ') : 'nothing to add'}`];
}

// ---- command line (not when imported by install.mjs) ----
const started = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
const isMain =
  process.platform === 'win32' ? started.toLowerCase() === import.meta.url.toLowerCase() : started === import.meta.url;
if (isMain) {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith('--')));
  const i = args.indexOf('--target');
  const known = ['--dry', '--overwrite', '--claude-md', '--settings', '--ci', '--target'];
  const unknown = [...flags].filter((f) => !known.includes(f));
  if (unknown.length) {
    console.error(`setup: unknown option ${unknown.join(' ')}. Use: cq setup [--dry] [--overwrite] [--claude-md] [--settings] [--ci] [--target <dir>]`);
    process.exit(2);
  }
  const PR = require('./lib/projectRoot.js');
  if (i < 0 && PR.noProjectFolder()) {
    console.error('setup: this folder is not under git yet, so there is no project to set up. The queue needs git: ask Claude to run "git init" and make a first commit, then run setup again.');
    process.exit(2);
  }
  const target = i >= 0 ? path.resolve(args[i + 1]) : PR.roots().main;
  const log = setupProject({
    target,
    dry: flags.has('--dry'),
    overwrite: flags.has('--overwrite'),
    claudeMd: flags.has('--claude-md'),
    settings: flags.has('--settings'),
    ci: flags.has('--ci'),
  });
  console.log(`${flags.has('--dry') ? '[DRY] ' : ''}Set up the work queue in ${target}`);
  console.log(`  copied: ${log.copied.join(', ') || '-'}`);
  if (log.replaced.length) console.log(`  replaced: ${log.replaced.join(', ')}`);
  if (log.skipped.length) console.log(`  kept (already there): ${log.skipped.join(', ')}`);
  for (const n of log.notes) console.log(`  ${n}`);
  // A kept copy may be older than the plugin: the mission every agent gets is built from it.
  if (!flags.has('--overwrite')) {
    const PF = require('./lib/projectFiles.js');
    const stale = PF.staleFiles(PLUGIN_ROOT, target);
    const message = PF.staleMessage(stale);
    if (message) console.log(`  NOTE: ${message}.\n  ${stale.changed.length ? PF.STALE_FIX : 'Run cq setup again to add the new files.'}`);
  }
}
