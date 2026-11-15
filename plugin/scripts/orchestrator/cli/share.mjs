// =============================================================
// cli/share.mjs: `ravenseat share on|off|status`, the queue's own files in git (H3, lib/queueShare.js).
//
//   ravenseat share status [--json]
//        Off or on, the files in share.include, the repo's visibility (lib/repoVisibility.js, asked again when the cached
//        answer is older than 24 h), and what git already tracks in the data folder.
//   ravenseat share on [--include <file> ...] [--yes] [--public-ok]
//        Explains what becomes visible and to whom, and changes nothing without --yes (exit 1). In a repo that is public
//        or of unknown visibility it needs --public-ok as well. With them: share.queueData true and share.include in
//        queue.config.json, the .gitignore gets <dataFolder>/* and !<dataFolder>/<file> per file (setup.mjs
//        gitignoreEdit), and a "share-on" row goes to the time log. --include replaces the list (default: the list now,
//        else queue.json and plans.json); a file that can never be shared (the time log, missions, reports, transcript
//        extracts, the owner's answers, locks, evidence, the board key, setup-tips.json) is refused with the reason.
//   ravenseat share off
//        share.queueData false, the exceptions leave the .gitignore, a "share-off" row. Files already tracked stay
//        tracked until `git rm --cached`; this says which.
// WHY explicit: on means anyone with access to the repo, and every fork, reads the queue and the plan register; in a
// public repo that is anyone. So it is never a side effect of another setting: `settings set` cannot write
// share.queueData (the row is read only), and `checks turn-on share-backup` (the board's "Turn on", the owner's click) is
// offered only in a private repo and goes through enableShare below.
// Refused from a track worktree like the other owner commands; the push guard denies `share` to queue agents (it is not
// in lib/pushGuard.js AGENT_QUEUE_COMMANDS).
//
// Used by: queue.mjs, cli/checks.mjs (turn-on). Tested in: __tests__/shareCli.test.ts, redteam/rt30-share-guard.test.ts.
// =============================================================

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

import { a, CLI, CONFIG, die, FOLDER, GIT_ROOT, KK, require, TIME_LOG, values } from './context.mjs';
import { trackBranchHere } from './settings.mjs';
import { gitignoreNote, writeGitignore } from '../setup.mjs';

const QS = require('./lib/queueShare.js');
const RV = require('./lib/repoVisibility.js');
const SV = require('./lib/settingsView.js');

/** The repo's visibility: the cache while fresh, else asked (a short time limit; never an error). */
export async function visibilityNow({ refresh = false } = {}) {
  return RV.current({ folder: FOLDER, remoteUrl: RV.remoteUrlOf(GIT_ROOT, CONFIG.remote), refresh });
}

/** What git tracks in the data folder now (repo-relative), [] without git. */
function trackedInData(cfg = CONFIG) {
  const df = QS.dataFolderOf(cfg);
  if (!df) return [];
  try {
    return execFileSync('git', ['-C', GIT_ROOT, 'ls-files', '-z', '--', df], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
      .split('\0')
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Writes the share keys to queue.config.json (keeps the file's form) and returns the configuration read again. */
function writeShare(fields) {
  const file = KK.configFile();
  let text = null;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e?.code !== 'ENOENT') die(`share: could not read ${file} (${e.message}). Nothing was changed.`);
  }
  let next = text;
  try {
    for (const [key, value] of Object.entries(fields)) next = SV.setJsonText(next, SV.pathOf(`share.${key}`), value);
  } catch (e) {
    die(`share: ${file} is not a JSON object (${e.message}). Nothing was changed.`);
  }
  if (next !== text) fs.writeFileSync(file, next);
  return KK.config({ root: CONFIG.root });
}

/** The audit row in the time log (like setting-weakened): who turned sharing on or off, with what. */
function logShare(event, row) {
  try {
    require('./lib/timeLogArchive.js').appendText(TIME_LOG, `${JSON.stringify({ time: new Date().toISOString(), event, ...row })}\n`);
  } catch (e) {
    console.log(`WARNING: the ${event} row could not be written to the time log (${e.message}).`);
  }
}

const whoReads = (visibility) =>
  RV.isPrivate(visibility)
    ? 'everyone with access to the repo, and every fork of it'
    : visibility === 'public'
      ? 'anyone: the repo is public'
      : 'possibly anyone: the repo\'s visibility is not known (another host, no network or not signed in), which counts as public';

/** The text `share on` shows before it changes anything. */
function explain(include, visibility, df) {
  return [
    `share on puts these files from ${df}/ in git: ${include.join(', ')}.`,
    `Who can read them once pushed: ${whoReads(visibility)}. Old commits keep them after share off.`,
    'Everything else in the folder stays ignored: the time log, missions and prompt files, reports, transcript extracts, ' +
      "the owner's answers and questions, locks, the gate evidence, the board key and setup-tips.json can never be shared.",
    `Nothing is committed for you: after share on, git add ${include.map((f) => `${df}/${f}`).join(' ')} when you want them in.`,
  ].join('\n');
}

/**
 * Turns sharing on: the config, the .gitignore and the audit row. The caller has checked the confirmation. Returns
 * the lines to print. Used by `share on --yes` and by `checks turn-on share-backup` (private repo only).
 */
export function enableShare({ include, publicOk = false, visibility = null, by = 'ravenseat' }) {
  const cfg = writeShare({ queueData: true, include, publicOk });
  const edit = writeGitignore(cfg.root, cfg);
  logShare('share-on', { include, visibility, publicOk, by });
  const df = QS.dataFolderOf(cfg);
  return [
    `share: on (${include.join(', ')}). ${gitignoreNote(edit)}.`,
    `To put them in git: git add ${include.map((f) => `${df}/${f}`).join(' ')}, then commit. Off again: ${CLI} share off.`,
  ];
}

async function shareOn() {
  const s = QS.shareOf(CONFIG);
  const asked = values('--include').flatMap((x) => x.split(',')).map((x) => x.trim()).filter(Boolean);
  const include = asked.length ? asked : s.include.length ? s.include : [...QS.STANDARD_INCLUDE];
  const problems = include.map((f) => QS.includeProblem(f, CONFIG)).filter(Boolean);
  if (problems.length) die(`share on: refused. ${problems.join('. ')}. Nothing was changed.`);
  const df = QS.dataFolderOf(CONFIG);
  if (!df) die('share on: the data folder (dataFolder) is outside the project, so git cannot hold its files. Nothing was changed.');
  const vis = (await visibilityNow()).visibility;
  const text = explain([...new Set(include)], vis, df);
  const publicOk = a.includes('--public-ok');
  if (!RV.isPrivate(vis) && !publicOk)
    die(
      `${text}\n\nThis repo is ${vis === 'public' ? 'public' : 'not known to be private'}, so share on needs --public-ok as well: ` +
        `${CLI} share on${asked.length ? ` --include ${include.join(' ')}` : ''} --public-ok --yes. Nothing was changed.`,
    );
  if (!a.includes('--yes'))
    die(`${text}\n\nNothing was changed. To turn it on: ${CLI} share on${asked.length ? ` --include ${include.join(' ')}` : ''}${publicOk ? ' --public-ok' : ''} --yes`);
  for (const l of enableShare({ include: [...new Set(include)], publicOk: publicOk && !RV.isPrivate(vis), visibility: vis, by: 'owner' })) console.log(l);
}

function shareOff() {
  const cfg = writeShare({ queueData: false, publicOk: false });
  const edit = writeGitignore(cfg.root, cfg);
  logShare('share-off', { by: 'owner' });
  console.log(`share: off. The whole data folder is private again. ${gitignoreNote(edit)}.`);
  const tracked = trackedInData(cfg);
  if (tracked.length)
    console.log(
      `Still tracked by git: ${tracked.join(', ')}. The push guard refuses a commit that changes them; take them out with ` +
        `git rm --cached -- ${tracked.join(' ')} (keeps them on disk) and commit. Old commits keep them.`,
    );
}

async function shareStatus() {
  const s = QS.shareOf(CONFIG);
  const vis = await visibilityNow();
  const tracked = trackedInData();
  const breaches = QS.breaches(tracked, CONFIG).map((b) => b.file);
  const status = {
    on: s.on,
    include: s.include,
    publicOk: s.publicOk,
    problems: s.problems,
    visibility: vis.visibility,
    checkedAt: vis.checkedAt ?? null,
    tracked,
    notAllowed: breaches,
    pushRefused: QS.publicReason(CONFIG, vis, CLI),
  };
  if (a.includes('--json')) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }
  console.log(`share: ${s.on ? `on (${s.include.join(', ')})` : 'off (the whole data folder is private)'}`);
  console.log(`repo visibility: ${vis.visibility}${vis.checkedAt ? ` (checked ${vis.checkedAt})` : ''}${RV.isPrivate(vis.visibility) ? '' : ', counted as public'}`);
  for (const p of s.problems) console.log(`not used: ${p}`);
  if (tracked.length) console.log(`tracked in the data folder: ${tracked.join(', ')}`);
  if (breaches.length) console.log(`the push guard refuses commits with: ${breaches.join(', ')} (git rm --cached -- <file>)`);
  if (status.pushRefused) console.log(`push refused: ${status.pushRefused}`);
  if (!s.on && RV.isPrivate(vis.visibility))
    console.log(`This repo is private: ${CLI} share on keeps queue.json and the plan register in git as a backup (it explains first).`);
}

/** `ravenseat share ...` (the usage is at the top of queue.mjs). */
export async function cmdShare() {
  const sub = a[1];
  if (sub === 'status' || sub === undefined || sub === '--json') return shareStatus();
  if (sub !== 'on' && sub !== 'off') return die(`Use: ${CLI} share status [--json] | on [--include <file> ...] [--public-ok] [--yes] | off`);
  const track = trackBranchHere();
  if (track) die(`${CLI} share ${sub} cannot be run from inside a track worktree (branch ${track}); ask the owner. Nothing was changed.`);
  return sub === 'on' ? shareOn() : shareOff();
}
