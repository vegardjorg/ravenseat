// =============================================================
// cli/update.mjs: the update notice for CLI users (roadmap 0u3) and `ravenseat update`.
//
// The board has shown a banner for a new version since 0.3 (lib/queueUpdate.js). Without the board nobody heard about
// one, so `ravenseat show` and `ravenseat doctor` now say it in one line:
//   ravenseat X is out (you have Y): claude plugin update ravenseat@ravenseat, then ravenseat setup --settings
// The rules (all in lib/queueUpdate.js, cliNotice):
//   - show only reads <dataFolder>/update-check.json, the board's cache. It never waits on the network: a cache older
//     than 24 hours starts a detached `ravenseat update refresh` (the board's latestVersion, same 3 s timeout), so the
//     answer is there next time. At most once a day per version in show (the `shown` stamp in the same file).
//   - doctor prints it as an INFO row every time, and when the cache is old it checks directly (3 s timeout): doctor
//     already reads the machine and the setup, and is run on purpose.
//   - quiet in --json, in an agent (a worktree, or QUEUE_AGENT_ROLE / QUEUE_ROLE), in CI (CI=true) and in hooks
//     (QUEUE_HOOK); never in the other commands, so agent output stays clean.
//   - off with updates.check false (the old name board.updateCheck false still works), DISABLE_UPDATES or
//     CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC. Off never stops any work.
//
// `ravenseat update`                  what is known: installed, the newest seen, when it was checked, what is dismissed
// `ravenseat update dismiss [<ver>]`  hides the notice for that version (default: the newest known) in show, doctor and on
//                                     the board (the same `dismissed` field the board's X writes) until a newer one is out
// `ravenseat update refresh`          internal: the background refresh show starts (silent, exit 0)
//
// Used by: queue.mjs (dispatch), cli/view.mjs (show), cli/doctor.mjs (doctor).
// Tested in: lib/__tests__/queueUpdateCli.test.ts (rules), lib/__tests__/queueUpdateNotice.test.ts (end to end).
// =============================================================

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { a, CLI, CONFIG, FOLDER, HERE, MAIN_TREE, ROOT, require } from './context.mjs';

const U = require('./lib/queueUpdate.js');

/** <dataFolder>/update-check.json: the board's cache, also the CLI's dismissal and "shown" stamp. */
export const UPDATE_FILE = path.join(FOLDER, 'update-check.json');

/** The running install: { mode: 'plugin'|'vendored', version } (version null when it cannot be read). */
export function installInfo() {
  try {
    const src = require('./lib/queueBoard.js').setupSources(HERE, MAIN_TREE, (f) => fs.existsSync(f));
    const file = src.manifest ?? path.join(HERE, 'ravenseat-version.json');
    return { mode: src.mode, version: JSON.parse(fs.readFileSync(file, 'utf8')).version ?? null };
  } catch {
    return { mode: 'plugin', version: null };
  }
}

/** Why this run keeps quiet (json, agent, ci, hook), or null. A worktree is an agent's (tracks run in one). */
const quiet = () => U.quietReason({ argv: a, env: process.env, inWorktree: ROOT !== MAIN_TREE });

/**
 * The line for `ravenseat show`, or null. Reads the cache only; starts a background refresh when it is old. Records
 * that it was shown, so the next show the same day stays quiet. Never throws, never waits.
 */
export function showUpdateLine() {
  try {
    const inst = installInfo();
    const n = U.cliNotice({
      surface: 'show',
      config: CONFIG,
      env: process.env,
      fs,
      cacheFile: UPDATE_FILE,
      installed: inst.version,
      mode: inst.mode,
      quiet: quiet(),
    });
    if (n.refresh && U.networkAllowed(process.env))
      U.startRefresh({ spawn, execPath: process.execPath, script: path.join(HERE, 'queue.mjs'), fs, cacheFile: UPDATE_FILE });
    if (n.line) U.markShown(fs, UPDATE_FILE, n.version);
    return n.line;
  } catch {
    return null;
  }
}

/**
 * doctor's rows: one INFO row when a newer version is out and not dismissed, otherwise none. With an old cache it
 * checks directly first (the board's latestVersion, 3 s timeout). Never WARN or FAIL, never throws.
 */
export async function doctorUpdateRows() {
  try {
    const q = quiet();
    if (q) return [];
    const inst = installInfo();
    const o = { surface: 'doctor', config: CONFIG, env: process.env, fs, cacheFile: UPDATE_FILE, installed: inst.version, mode: inst.mode };
    if (U.cliNotice(o).refresh && U.networkAllowed(process.env) && typeof globalThis.fetch === 'function')
      await U.latestVersion({ ...o, fetch: globalThis.fetch, url: U.manifestUrl(process.env) });
    const n = U.cliNotice(o);
    if (!n.line) return [];
    return [{ status: 'INFO', name: 'update', message: n.line, fix: `${CLI} update dismiss hides it until a newer version is out` }];
  } catch {
    return [];
  }
}

/** `ravenseat update [dismiss [<version>] | refresh]` (the usage is at the top of queue.mjs). */
export async function cmdUpdate() {
  const sub = a[1];
  if (sub === 'refresh') {
    // The background refresh: silent, and never an error exit (nobody reads it).
    try {
      if (U.networkAllowed(process.env) && typeof globalThis.fetch === 'function')
        await U.latestVersion({ config: CONFIG, env: process.env, cacheFile: UPDATE_FILE, fs, fetch: globalThis.fetch, url: U.manifestUrl(process.env) });
    } catch {
      /* the next show tries again */
    }
    return;
  }
  const known = U.readCache(fs, UPDATE_FILE);
  if (sub === 'dismiss') {
    const version = a[2] && !a[2].startsWith('-') ? a[2] : known?.latest ?? null;
    if (!version) {
      console.log('No newer version is known yet; nothing to dismiss.');
      return;
    }
    if (!U.parse(version)) {
      console.error(`Not a version: ${version} (expected for example 1.2.3).`);
      process.exit(1);
    }
    if (!U.dismiss(fs, UPDATE_FILE, version)) {
      console.error(`Could not write ${UPDATE_FILE}.`);
      process.exit(1);
    }
    console.log(`The notice about ravenseat ${version} is hidden in show, doctor and on the board until a newer version is out.`);
    return;
  }
  if (sub && sub !== 'status') {
    console.error('Use: ravenseat update [dismiss [<version>]]');
    process.exit(1);
  }
  const inst = installInfo();
  const state = U.readState(fs, UPDATE_FILE);
  const off = U.disabledReason(CONFIG, process.env);
  console.log(`Installed: ravenseat ${inst.version ?? 'unknown'} (${inst.mode}).`);
  console.log(
    known
      ? `Newest seen: ${known.latest}, checked ${new Date(known.checkedAt).toISOString()}.`
      : 'Newest seen: not checked yet (ravenseat show starts a check in the background, doctor checks directly).',
  );
  if (U.dismissedVersion(fs, UPDATE_FILE)) console.log(`Dismissed: ${state.dismissed} (ravenseat update dismiss).`);
  if (off) console.log(`The check is off: ${off}.`);
}
