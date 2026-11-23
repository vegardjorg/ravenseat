// =============================================================
// codeMode.js: is Claude Code's Code Mode on for this user, and the one doctor row that says what it means for
// Ravenseat (C3 of the Code Mode candidates, owner 23.11; setting codeMode.policy). Measurement and information only.
//
// Code Mode (code.claude.com/docs/en/code-mode, experimental): Claude writes JavaScript that makes several tool calls
// in one REPL step. It is on when CLAUDE_CODE_EXPERIMENTAL_CODE_MODE is 1 in the shell or in the env block of the user
// settings (~/.claude/settings.json; project settings are ignored on purpose), and a 0 in either place keeps it off.
// This file only READS those two places. Ravenseat never sets or clears the flag (owner: integrate with the official
// feature, never work around its security decision).
//
// What it means for Ravenseat, said in the row: each call inside the code still passes the push, write and read guards
// under its own name, and `ravenseat cost` counts the REPL calls on a line of their own (lib/turnTools.js, point 7).
// Code Mode runs only in an interactive terminal session (not the Desktop app, background jobs or Remote Control).
//
// codeMode.policy: warn (default, the row) or off (no row). There is no deny: the stance is to support the feature.
// Friction: none. It never stops anything and costs no tokens.
//
// Pure apart from readState (reads one file, never writes). Tested in lib/__tests__/codeMode.test.ts.
// =============================================================
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const VAR = 'CLAUDE_CODE_EXPERIMENTAL_CODE_MODE';
const POLICIES = Object.freeze(['warn', 'off']);

/** '1' -> true, '0' -> false, anything else -> null (not set, or a value Claude Code does not document). */
function flag(v) {
  const s = v == null ? '' : String(v).trim();
  if (s === '1') return true;
  if (s === '0') return false;
  return null;
}

/**
 * Code Mode on or off, and where it was turned on.
 * @param {{ env: Record<string, string|undefined>, userSettingsText: string|null }} x
 * @returns {{ on: boolean, source: 'environment'|'user settings'|null }}
 */
function codeModeState({ env, userSettingsText }) {
  const shell = flag(env?.[VAR]);
  let user = null;
  if (userSettingsText) {
    try {
      const s = JSON.parse(userSettingsText);
      if (s && typeof s.env === 'object' && s.env) user = flag(s.env[VAR]);
    } catch {
      // error-ignored: user settings that do not parse turn nothing on here (Claude Code reports them itself)
    }
  }
  if (shell === false || user === false) return { on: false, source: null };
  if (shell === true) return { on: true, source: 'environment' };
  if (user === true) return { on: true, source: 'user settings' };
  return { on: false, source: null };
}

/** The user settings file Claude Code reads: <CLAUDE_CONFIG_DIR or ~/.claude>/settings.json. */
function userSettingsFile(env = process.env) {
  return path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json');
}

/** codeModeState from the process environment and the user settings file (read only; a missing file is fine). */
function readState({ env = process.env } = {}) {
  let text = null;
  try {
    text = fs.readFileSync(userSettingsFile(env), 'utf8');
  } catch {
    // error-ignored: no user settings file, so only the environment counts
  }
  return codeModeState({ env, userSettingsText: text });
}

/** codeMode.policy from a config object: off, or warn (default; anything else). */
function policyOf(cfg) {
  return cfg?.codeMode?.policy === 'off' ? 'off' : 'warn';
}

/** The doctor rows: one INFO row while Code Mode is on and the policy is warn, else none. */
function doctorRows({ state, policy }) {
  if (!state?.on || policy === 'off') return [];
  return [
    {
      status: 'INFO',
      name: 'code mode',
      message:
        `Code Mode is on (${VAR} in your ${state.source}): each tool call inside Claude's code still passes the ` +
        'push, write and read guards under its own name, and ravenseat cost counts the REPL calls on a line of their ' +
        'own. Code Mode runs only in an interactive terminal session, not in the Desktop app or background jobs.',
      fix: 'nothing to do; codeMode.policy off hides this line',
    },
  ];
}

module.exports = { VAR, POLICIES, codeModeState, userSettingsFile, readState, policyOf, doctorRows };
