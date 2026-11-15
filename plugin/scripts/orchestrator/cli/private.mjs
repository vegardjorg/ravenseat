// =============================================================
// cli/private.mjs: `ravenseat private add|remove|list`, the project's own private folders and files (H4,
// lib/privatePaths.js, queue.config.json privatePaths).
//
//   ravenseat private list [--json]
//        The paths, whether agents may read them, and the entries that cannot be used.
//   ravenseat private add <path> [--no-read]
//        Adds the path (a folder with a trailing /, or a file) to privatePaths and to the project's .gitignore
//        (setup.mjs gitignoreEdit). From then on the push and merge guard refuse a commit that tracks something under it.
//        --no-read: { "path": ..., "read": false }, and the read guard denies the queue's agents (tracks, reviewers) a
//        Read there; the main session is never stopped. A file git already tracks there stays tracked until
//        `git rm --cached`; this says which. Adding the same path again replaces its entry (so --no-read can be changed).
//   ravenseat private remove <path>
//        Takes the path out of the list. The .gitignore line stays (remove it by hand if git should see the folder again).
// WHY one list: the .gitignore, the guards, the read rule and the cloud's hidden paths (cloudHidden) all read it, so
// they cannot disagree. Filling the list turns the guard on, so an empty list (the default) is off.
// Refused from a track worktree; the push guard denies `private` to queue agents (not in AGENT_QUEUE_COMMANDS).
//
// Used by: queue.mjs. Tested in: __tests__/privateCli.test.ts, redteam/rt31-private-paths.test.ts.
// =============================================================

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

import { a, CLI, CONFIG, die, GIT_ROOT, KK, positional, require, TIME_LOG } from './context.mjs';
import { trackBranchHere } from './settings.mjs';
import { gitignoreNote, writeGitignore } from '../setup.mjs';

const PP = require('./lib/privatePaths.js');
const SV = require('./lib/settingsView.js');

/** Writes privatePaths to queue.config.json (keeps the file's form) and returns the configuration read again. */
function writeList(list) {
  const file = KK.configFile();
  let text = null;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e?.code !== 'ENOENT') die(`private: could not read ${file} (${e.message}). Nothing was changed.`);
  }
  let next;
  try {
    next = SV.setJsonText(text, SV.pathOf('privatePaths'), list);
  } catch (e) {
    die(`private: ${file} is not a JSON object (${e.message}). Nothing was changed.`);
  }
  if (next !== text) fs.writeFileSync(file, next);
  return KK.config({ root: CONFIG.root });
}

/** What git tracks under the path now, [] without git. */
function trackedUnder(p) {
  try {
    return execFileSync('git', ['-C', GIT_ROOT, 'ls-files', '-z', '--', p], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
      .split('\0')
      .filter(Boolean);
  } catch {
    return [];
  }
}

function logRow(event, row) {
  try {
    require('./lib/timeLogArchive.js').appendText(TIME_LOG, `${JSON.stringify({ time: new Date().toISOString(), event, ...row, by: 'owner' })}\n`);
  } catch {
    // error-ignored: the setting is written; the row is a record, not the guard
  }
}

function list() {
  const entries = PP.entries(CONFIG);
  const problems = PP.problems(CONFIG);
  if (a.includes('--json')) {
    console.log(JSON.stringify({ entries, problems }, null, 2));
    return;
  }
  if (!entries.length) console.log(`No private paths. ${CLI} private add <path> [--no-read] adds one.`);
  for (const e of entries) console.log(`  ${e.line}${e.read ? '' : '  (agents may not read it)'}`);
  for (const p of problems) console.log(`not used: ${p}`);
}

function add(p) {
  const read = !a.includes('--no-read');
  let next;
  try {
    next = PP.addEntry(Array.isArray(CONFIG.privatePaths) ? CONFIG.privatePaths : [], p, { read });
  } catch (e) {
    die(`private add: ${e.message}. Nothing was changed.`);
  }
  const cfg = writeList(next);
  const edit = writeGitignore(cfg.root, cfg);
  const entry = PP.matching(PP.projectPath(p), cfg);
  logRow('private-add', { path: entry.line, read });
  console.log(
    `${entry.line} is private: ${gitignoreNote(edit)}, and the push and merge guard refuse a commit that tracks something there` +
      `${read ? '' : '. The queue\'s agents may not read it'}. Off again: ${CLI} private remove ${entry.line}`,
  );
  const tracked = trackedUnder(entry.path);
  if (tracked.length)
    console.log(
      `Already tracked by git: ${tracked.slice(0, 8).join(', ')}${tracked.length > 8 ? ` and ${tracked.length - 8} more` : ''}. ` +
        `Take them out with git rm --cached -r -- ${entry.path} (keeps them on disk) and commit; old commits keep them.`,
    );
}

function remove(p) {
  const target = PP.projectPath(p);
  const before = Array.isArray(CONFIG.privatePaths) ? CONFIG.privatePaths : [];
  const next = PP.removeEntry(before, p);
  if (!target || next.length === before.length) die(`private remove: ${p} is not in privatePaths (${CLI} private list). Nothing was changed.`);
  writeList(next);
  logRow('private-remove', { path: target });
  console.log(`${target} is no longer private. Its .gitignore line stays; remove it by hand if git should see it again.`);
}

/** `ravenseat private ...` (the usage is at the top of queue.mjs). */
export function cmdPrivate() {
  const sub = a[1];
  if (sub === 'list' || sub === undefined || sub === '--json') return list();
  if (sub !== 'add' && sub !== 'remove') return die(`Use: ${CLI} private list [--json] | add <path> [--no-read] | remove <path>`);
  const track = trackBranchHere();
  if (track) die(`${CLI} private ${sub} cannot be run from inside a track worktree (branch ${track}); ask the owner. Nothing was changed.`);
  const p = positional(2)[0];
  if (!p) die(`Name the path: ${CLI} private ${sub} <path>`);
  return sub === 'add' ? add(p) : remove(p);
}
