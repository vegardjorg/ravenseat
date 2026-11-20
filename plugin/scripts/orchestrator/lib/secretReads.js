// =============================================================
// secretReads.js: a guarded agent printing secrets in a shell command (roadmap 1c SEC-T item 4).
//
// WHY: `cat .env`, `Get-Content .env.local` or a bare `printenv` in a track puts every key into the agent's transcript,
// which Claude Code keeps on disk for weeks (~/.claude/projects, cleanupPeriodDays, 30 by default) and which any later
// resume, export or share carries on. Nobody sees it happen. The push guard (hook-push-guard.mjs) asks readRule() for
// every guarded agent's shell command and, by guards.secretReads:
//   log    (default) allowed, one row in the time log (lib/guardLog.js: event guard-log, guard secrets, the rule, never
//          the command or a path), counted per track on the Checks tab (counts below, cli/checks.mjs).
//   block  denied, with blockReason(): reference the variable instead of printing it. Not the default: a track that
//          needs a value to debug a connection would stop.
//   off    nothing.
// The main session (the owner) is never touched: the hook only asks for guarded agents (lib/agentGuard.js).
//
// What counts (per segment of the line, split at ; && || | and newlines):
//   env-file-read  cat, type, Get-Content (gc), head, tail, less or more of a .env style file (secretScan.isEnvFile:
//                  .env, .env.local, .env.production; never .env.example, .sample, .template);
//   key-file-read  the same readers on a *.pem or *.key file;
//   env-dump       printenv, env or set with no arguments, and Get-ChildItem (gci, dir, ls) env: with no name.
// Known limits: a read inside `bash -c "..."` or a script file is not seen, and neither is a Read tool call (the read
// guard owns that). A log, not a wall.
//
// Pure, no I/O. Tested in lib/__tests__/secretReads.test.ts.
// =============================================================
'use strict';

const { tokenize } = require('./commandSecrets.js');
const { isEnvFile } = require('./secretScan.js');

const MODES = Object.freeze(['block', 'log', 'off']);
/** The programs that print a file. */
const READERS = new Set(['cat', 'type', 'get-content', 'gc', 'head', 'tail', 'less', 'more']);
/** PowerShell's listing commands (the env: drive lists every variable). */
const LISTERS = new Set(['get-childitem', 'gci', 'dir', 'ls']);
/** The rules a row can carry. */
const RULES = Object.freeze(['env-file-read', 'key-file-read', 'env-dump']);

const unquote = (s) => String(s ?? '').replace(/^(["'])(.*)\1$/s, '$2');
const baseOf = (p) => unquote(p).split(/[\\/]/).pop();
const programOf = (t) => baseOf(t).replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();

/** The setting: 'log' (default), 'block' or 'off'. Anything malformed reads as the default. */
function modeOf(cfg) {
  const m = cfg?.guards?.secretReads;
  return MODES.includes(m) ? m : 'log';
}

/** The rule of one segment (one simple command), or null. */
function segmentRule(segment) {
  const tokens = tokenize(segment).filter((t) => t !== '(' && t !== ')');
  // Leading env assignments and sudo are not the program.
  let i = 0;
  while (i < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]) || /^sudo$/i.test(tokens[i]))) i++;
  if (i >= tokens.length) return null;
  const program = programOf(tokens[i]);
  const args = tokens.slice(i + 1);
  if (READERS.has(program)) {
    for (const a of args) {
      if (/^-/.test(a)) continue;
      const base = baseOf(a);
      if (/^\.env/i.test(base) && isEnvFile(base)) return 'env-file-read';
      if (/\.(pem|key)$/i.test(base)) return 'key-file-read';
    }
    return null;
  }
  if ((program === 'printenv' || program === 'env' || program === 'set') && args.length === 0) return 'env-dump';
  if (LISTERS.has(program)) {
    const paths = args.filter((a) => !/^-/.test(a)).map(unquote);
    if (paths.some((p) => /^env:[\\/]?\*?$/i.test(p))) return 'env-dump';
  }
  return null;
}

/**
 * The rule a command line hits, or null: env-file-read, key-file-read or env-dump. Never the command or a path.
 * @param {string} command
 * @returns {string|null}
 */
function readRule(command) {
  const s = String(command ?? '');
  if (s.length > 8000) return null;
  for (const segment of s.split(/\s*(?:;|&&|\|\||\||\r?\n)\s*/)) {
    const rule = segmentRule(segment.trim());
    if (rule) return rule;
  }
  return null;
}

/** The deny reason under guards.secretReads "block": what to do instead. */
function blockReason(rule) {
  const what = rule === 'env-dump' ? 'printing the environment' : 'printing a secret file';
  return (
    `${what} is blocked for agents (guards.secretReads: block): the values would land in your transcript, which is ` +
    'kept on disk. Reference the variable instead of printing it, for example psql "$DATABASE_URL" or ' +
    'node -r dotenv/config app.js; to check that a variable is set, test it without printing it.'
  );
}

/**
 * The guard log's secret reads per track ("no task" when the agent's task was not found), from `from` (ms) on: logged and blocked rows of
 * guard "secrets". Sorted: most first, then by name. For the Checks tab.
 * @param {object[]} rows  the time log's rows
 * @param {{ from?: number|null }} [o]
 * @returns {{ total: number, byTrack: { track: string, count: number, blocked: number, rules: string[] }[] }}
 */
function counts(rows, { from = null } = {}) {
  const per = new Map();
  let total = 0;
  for (const r of rows ?? []) {
    if (r?.guard !== 'secrets' || (r.event !== 'guard-log' && r.event !== 'guard-deny')) continue;
    const t = Date.parse(r.time ?? '');
    if (from != null && !(t >= from)) continue;
    // The main session is never logged here, so a row without a task is an agent whose task was not found.
    const track = r.track || 'no task';
    const x = per.get(track) ?? { track, count: 0, blocked: 0, rules: new Set() };
    x.count++;
    if (r.event === 'guard-deny') x.blocked++;
    if (RULES.includes(r.rule)) x.rules.add(r.rule);
    per.set(track, x);
    total++;
  }
  const byTrack = [...per.values()]
    .map((x) => ({ ...x, rules: [...x.rules].sort() }))
    .sort((a, b) => b.count - a.count || a.track.localeCompare(b.track));
  return { total, byTrack };
}

module.exports = { MODES, RULES, modeOf, readRule, blockReason, counts };
