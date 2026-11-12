'use strict';
// =============================================================
// pushGuardFallback.js: the coarse rule hook-push-guard.mjs falls back to when it has an internal error (a module that
// does not load, a parser that throws). Without it the guard let every command through on a bug in itself, and the
// plugin has no deny list in the settings behind it, so one bug meant no guard at all.
//
// What it stops: the irreversible pushes, the same ones lib/pushGuard.js always denies or asks about. A forced push
// (--force, -f in any short flag group, --force-with-lease, a +refspec), a branch delete (--delete, -d, a :refspec) and
// --mirror. Everything else still fails open: the guard must not stop normal work because of a bug in itself.
//
// Deliberately simple and with NO requires: it must work when the rest of lib/ does not. It splits the command on
// ; & | and newlines, and looks at segments whose first program is git (after VAR=value prefixes, with or without a path,
// quotes or .exe) and whose subcommand is push (after git's own -C <dir>, -c <key=value> and --long=value options).
// It errs toward deny, which only matters in the error case. Test: lib/__tests__/pushGuardFallback.test.ts and
// __tests__/pushGuardFailClosed.test.ts (the hook with a broken lib/pushGuard.js).
// =============================================================

/** git's own options that take the next word as a value (git -C <dir> push). */
const GIT_OPTION_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env']);

/** A word without surrounding quotes. */
function bare(word) {
  return word.replace(/^["']+|["']+$/g, '');
}

/** True for a word naming the git program (git, git.exe, a path to either). */
function isGit(word) {
  const name = bare(word).split(/[\\/]/).pop().toLowerCase();
  return name === 'git' || name === 'git.exe';
}

/**
 * The words of one command segment, split on blanks but keeping a quoted word with spaces together
 * ("C:\Program Files\Git\cmd\git.exe").
 */
function words(segment) {
  return segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
}

/** The push arguments of a segment, or null when the segment is not a git push. */
function pushArgs(segment) {
  const w = words(segment);
  let i = 0;
  while (i < w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[i])) i++; // VAR=value prefixes
  if (i >= w.length || !isGit(w[i])) return null;
  i++;
  while (i < w.length && w[i].startsWith('-')) {
    if (GIT_OPTION_WITH_VALUE.has(w[i])) i += 2;
    else i++;
  }
  if (bare(w[i] ?? '') !== 'push') return null;
  return w.slice(i + 1).map(bare);
}

/** Why a push's arguments are irreversible, or null. */
function irreversible(args) {
  for (const a of args) {
    if (a === '--force' || a.startsWith('--force-with-lease') || a === '--force-if-includes') return 'a forced push';
    if (a === '--delete' || a === '--mirror') return a === '--mirror' ? 'a mirror push' : 'a branch delete';
    if (/^-[A-Za-z]+$/.test(a) && a.includes('f')) return 'a forced push';
    if (/^-[A-Za-z]+$/.test(a) && a.includes('d')) return 'a branch delete';
    if (!a.startsWith('-') && a.startsWith('+')) return 'a forced push';
    if (!a.startsWith('-') && a.startsWith(':') && a.length > 1) return 'a branch delete';
  }
  return null;
}

/**
 * The fallback answer for a command when the guard had an internal error: { decision: 'deny', reason } for an
 * irreversible push, otherwise null (no decision: the command goes on).
 * @param {unknown} command
 * @param {unknown} error the internal error (its message goes in the reason, so the owner sees what broke)
 */
function fallbackAnswer(command, error) {
  if (typeof command !== 'string' || !command.trim()) return null;
  for (const segment of command.split(/[;&|\n]+/)) {
    const args = pushArgs(segment.trim());
    if (!args) continue;
    const what = irreversible(args);
    if (!what) continue;
    const message = String(error && typeof error === 'object' && 'message' in error ? error.message : error).slice(0, 200);
    return {
      decision: 'deny',
      reason:
        `the guard had an internal error (${message}), so it stops ${what} to be safe. ` +
        'Fix the guard (ravenseat doctor shows the hooks), or run the command yourself outside Claude Code if you mean it.',
    };
  }
  return null;
}

module.exports = { fallbackAnswer };
