// =============================================================
// cli/secrets.mjs: `ravenseat secrets clean`, removes the approved commands that hold a key (H1, S5).
//
//   ravenseat secrets clean [--dry-run] [--yes]
//        Finds the rules in permissions.allow, ask and deny of .claude/settings.json and .claude/settings.local.json (main
//        tree and every worktree git lists, also outside the main tree) that lib/allowlistSecrets.js finds a key in
//        (ruleOf: the patterns and the password-flag rule), the same reading as `ravenseat doctor`.
//        --dry-run: names each one as <file>: permissions.allow[3] (rule id) and changes nothing.
//        Without --yes: the same list, nothing changed, exit 1.
//        --yes: copies each file to <dataFolder>/secrets-backup/<time>/ first (ignored by git with the data folder), then
//        removes those rules and writes the file back with its own indentation and line endings.
// The rule text and the value are NEVER printed or logged: only the file, the list, the index and the pattern's id.
// WHY a copy: the rule may be one the owner still needs in another form; the copy keeps it until they have moved the key
// to an environment variable or a password manager (and the copy holds the key, so it is said to delete it then).
// Removing a rule does not change the key: one in a file git tracks is in the history, and must be changed.
// Refused from a track worktree; the push guard denies `secrets` to queue agents (not in AGENT_QUEUE_COMMANDS).
//
// Used by: queue.mjs. Tested in: __tests__/secretsCleanCli.test.ts.
// =============================================================

import fs from 'node:fs';
import path from 'node:path';

import { a, CLI, die, FOLDER, MAIN_TREE, require, TIME_LOG } from './context.mjs';
import { trackBranchHere } from './settings.mjs';

const AS = require('./lib/allowlistSecrets.js');

/** The indentation of a JSON text (the first indented line), default two spaces. */
function indentOf(text) {
  const m = /\n([ \t]+)\S/.exec(text);
  return m ? m[1] : 2;
}

/**
 * The file's text without the rules that hold a key (found again in this very text, so an index never points at a rule
 * that moved). Returns { text, removed } or null when nothing is left to remove or the file is not JSON.
 */
function cleaned(text, file) {
  let json;
  try {
    json = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    return null;
  }
  const p = json?.permissions;
  if (!p || typeof p !== 'object') return null;
  let removed = 0;
  for (const list of AS.LISTS) {
    if (!Array.isArray(p[list])) continue;
    // The same reading as the scan (lib/allowlistSecrets.js ruleOf: the patterns, then the password-flag rule).
    const keep = p[list].filter((rule) => !(typeof rule === 'string' && AS.ruleOf(rule, file)));
    removed += p[list].length - keep.length;
    p[list] = keep;
  }
  if (!removed) return null;
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  const out = JSON.stringify(json, null, indentOf(text)).replace(/\n/g, eol) + (/\r?\n$/.test(text) ? eol : '');
  return { text: (text.startsWith('﻿') ? '﻿' : '') + out, removed };
}

function clean() {
  const hits = AS.scanTrees(MAIN_TREE);
  if (!hits.length) {
    console.log('No approved command with a key in it (permissions in .claude/settings*.json, also the agents\' worktrees). Nothing to do.');
    return;
  }
  const lines = hits.map((h) => `  ${AS.where(h)}`);
  const files = [...new Set(hits.map((h) => h.file))];
  if (a.includes('--dry-run')) {
    console.log(`Would remove ${hits.length} rule(s) from ${files.length} file(s), after a copy in ${path.join(FOLDER, 'secrets-backup')}:\n${lines.join('\n')}\nNothing was changed.`);
    return;
  }
  if (!a.includes('--yes'))
    die(
      `${hits.length} approved command(s) hold a key:\n${lines.join('\n')}\n` +
        `${CLI} secrets clean --yes removes them, after a copy of each file in ${path.join(FOLDER, 'secrets-backup')}. Nothing was changed.`,
    );
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(FOLDER, 'secrets-backup', stamp);
  let total = 0;
  for (const file of files) {
    // The hit's own absolute path: a worktree outside the main tree is named by its absolute path (lib/allowlistSecrets.js).
    const abs = hits.find((h) => h.file === file)?.abs ?? path.resolve(MAIN_TREE, ...file.split('/'));
    let text;
    try {
      text = fs.readFileSync(abs, 'utf8');
    } catch (e) {
      console.log(`  ${file}: could not read it (${e.code ?? e.message}); left as it is.`);
      continue;
    }
    const next = cleaned(text, file);
    if (!next) continue;
    // The copy first: without it nothing is changed in this file.
    try {
      fs.mkdirSync(backup, { recursive: true });
      fs.writeFileSync(path.join(backup, file.replace(/[\\/:]/g, '__')), text);
    } catch (e) {
      die(`secrets clean: could not copy ${file} to ${backup} (${e.message}). ${file} was not changed.`);
    }
    fs.writeFileSync(abs, next.text);
    total += next.removed;
    console.log(`  ${file}: removed ${next.removed} rule(s)`);
  }
  try {
    require('./lib/timeLogArchive.js').appendText(TIME_LOG, `${JSON.stringify({ time: new Date().toISOString(), event: 'secrets-clean', removed: total, files, by: 'owner' })}\n`);
  } catch {
    // error-ignored: the files are cleaned; the row is a record
  }
  console.log(
    `Removed ${total} rule(s). The copies are in ${backup} (ignored by git; they hold the keys, so delete them once the keys are changed). ` +
      'Change each key that was there: a file git tracks keeps it in its history. Pass keys as an environment variable or from a password manager instead.',
  );
}

/** `ravenseat secrets ...` (the usage is at the top of queue.mjs). */
export function cmdSecrets() {
  if (a[1] !== 'clean') return die(`Use: ${CLI} secrets clean [--dry-run] [--yes]`);
  const track = trackBranchHere();
  if (track) die(`${CLI} secrets clean cannot be run from inside a track worktree (branch ${track}); ask the owner. Nothing was changed.`);
  return clean();
}
