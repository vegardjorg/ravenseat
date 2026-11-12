// =============================================================
// cli/settings.mjs: `ravenseat settings`, every setting from the registry (lib/settingsRegistry.js) grouped in its
// category, and `ravenseat settings set`, the one writer for a setting (plans/innstillinger-vurdering-2026-11-12.md).
//   ravenseat settings [<category>] [--advanced] [--all] [--changed] [--json]
//        Read only. Basic rows first; --advanced adds the advanced ones, marked [advanced]. In lite, a full-only row is
//        left out and counted ("+ 2 full mode only (--all)"); --all shows it with the reason. --changed lists only what
//        differs from the default. The first line names the weakened guards.
//   ravenseat settings set <key> <value> [--i-understand --by owner]
//        Writes one row with edit "set" to the file its store names: queue.config.json (the project's; the file keeps its
//        form, lib/settingsView.js setJsonText) or queue.json (one person's, under the queue lock). A value that weakens
//        a guard (the row's `weakens`, and weaker than the value now) needs --i-understand --by owner: without them the
//        warning texts are printed, nothing is written and the exit code is 1. With them the change is written and a
//        "setting-weakened" row goes to the time log (key, old and new value, who). A stronger value needs no flag.
// Like the other owner commands (cli/surface.mjs, cli/unlock.mjs): `set` is refused from inside a track worktree whatever
// the flags say, and the push guard denies `settings` to queue agents (it is not in lib/pushGuard.js
// AGENT_QUEUE_COMMANDS, and --by owner is denied by itself). Without that refusal an agent could write the main tree's
// queue.config.json (config() finds the main tree from a worktree too) and switch off its own guard.
// The old commands (limit, guidance, checks, board-setting, cloud set, helpers, proposals, mode) are unchanged.
//
// Used by: queue.mjs (and the board's /api/setting). Tested in: __tests__/settingsCli.test.ts.
// =============================================================

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { a, CLI, CONFIG, die, edit, FILE, KK, PREFIX, read, require, TIME_LOG } from './context.mjs';

const R = require('./lib/settingsRegistry.js');
const SV = require('./lib/settingsView.js');
const PR = require('./lib/queueProposals.js');

const USAGE = `${CLI} settings [<category>] [--advanced] [--all] [--changed] [--json] | ${CLI} settings set <key> <value> [--i-understand --by owner]`;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The track branch the cwd is on, or null (the same question cli/surface.mjs and cli/unlock.mjs ask). */
function trackBranchHere() {
  try {
    const branch = execFileSync('git', ['-C', process.cwd(), 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim();
    return branch.startsWith(PREFIX) && branch.length > PREFIX.length ? branch : null;
  } catch {
    return null; // Not a git tree: not a track worktree either.
  }
}

/** The queue for reading; a queue that does not exist yet reads as empty (the settings still show). */
function queueOrEmpty() {
  return fs.existsSync(FILE) ? read() : { tasks: [] };
}

function showSettings() {
  const flags = new Set(a.slice(1).filter((x) => x.startsWith('--')));
  const category = a.slice(1).find((x) => !x.startsWith('--')) ?? null;
  const view = SV.settingsView({ config: CONFIG, queue: queueOrEmpty(), migrations: !!CONFIG.migrations?.folder });
  if (flags.has('--json')) {
    console.log(JSON.stringify(view, null, 2));
    return;
  }
  const lines = SV.cliLines(view, {
    cli: CLI,
    advanced: flags.has('--advanced'),
    all: flags.has('--all'),
    changed: flags.has('--changed'),
    category,
  });
  if (category && lines.length === 1) die(lines[0]);
  console.log(lines.join('\n'));
}

/** Appends the setting-weakened row; a failure stops the change (every weakening is logged, or none is made). */
function logWeakened(row, from, to, by) {
  try {
    fs.appendFileSync(
      TIME_LOG,
      `${JSON.stringify({ time: new Date().toISOString(), event: 'setting-weakened', key: row.key, from, to, by, store: row.store })}\n`,
    );
  } catch (e) {
    die(`settings set: could not write the setting-weakened row to ${TIME_LOG} (${e.message}). Nothing was changed.`);
  }
}

/**
 * Checks the change against the weakening rule. Returns true when it weakens (and the owner confirmed); exits 1 with the
 * warning when it weakens without the flags.
 */
function confirmed(row, value, now, raw) {
  const standard = SV.standardOf(row, { config: CONFIG, mode: CONFIG.mode === 'lite' ? 'lite' : 'full' });
  if (!SV.needsConfirm(row, value, { now, standard })) return false;
  const by = String(a[a.indexOf('--by') + 1] ?? '').trim();
  if (a.includes('--i-understand') && a.includes('--by') && by === 'owner') return true;
  die(SV.warningLines(row, SV.valueText(row, value), { cli: CLI, raw }).join('\n'));
  return false;
}

/** Writes a queue.json row under the lock, in the form the queue reads it. */
function setQueueValue(queue, row, value) {
  const k = row.key;
  if (k.startsWith('limits.')) queue.limits = { ...(queue.limits ?? {}), [k.slice('limits.'.length)]: value };
  else if (k === 'checksPanel.mode') queue.checksPanel = { ...(queue.checksPanel ?? {}), mode: value ? 'on' : 'off' };
  else if (k.startsWith('proposals.autoAccept.')) {
    const field = k.slice('proposals.autoAccept.'.length);
    const error = PR.rulesError({ [field]: value });
    if (error.length) die(`Nothing changed: ${error.join('; ')}`);
    const own = isObject(queue.proposals?.autoAccept) ? queue.proposals.autoAccept : {};
    queue.proposals = { ...(queue.proposals ?? {}), autoAccept: { ...own, [field]: value } };
  } else Object.assign(queue, SV.setPath(queue, SV.pathOf(k), value));
}

function setSetting() {
  const [, , key, raw] = a;
  if (key == null || raw == null || key.startsWith('--') || raw.startsWith('--')) die(`Use: ${CLI} settings set <key> <value>`);
  // Refused from a track worktree before anything is read: an agent never changes its own guards.
  const track = trackBranchHere();
  if (track)
    die(`${CLI} settings set cannot be run from inside a track worktree (branch ${track}); ask the owner (ravenseat question). Nothing was changed.`);
  const row = R.rowFor(key);
  if (!row) die(`unknown setting ${key}. See ${CLI} settings --all.`);
  const by = a.includes('--by') ? String(a[a.indexOf('--by') + 1] ?? '').trim() : 'ravenseat';

  if (row.store === 'queue') {
    const done = edit((queue) => {
      const p = SV.parseValue(row, raw, { limits: queue.limits });
      if ('error' in p) die(p.error);
      const now = SV.valueOf(row, { config: CONFIG, queue });
      if (confirmed(row, p.value, now, raw)) logWeakened(row, now, p.value, by);
      setQueueValue(queue, row, p.value);
      return p.value;
    });
    console.log(`${key} = ${SV.valueText(row, done)} (${SV.STORE_TEXT.queue}).`);
    return;
  }

  const p = SV.parseValue(row, raw);
  if ('error' in p) die(p.error);
  const now = SV.valueOf(row, { config: CONFIG, queue: {} });
  const weak = confirmed(row, p.value, now, raw);
  const file = KK.configFile();
  let text = null;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e?.code !== 'ENOENT') die(`settings set: could not read ${file} (${e.message}). Nothing was changed.`);
  }
  let next;
  try {
    next = SV.setJsonText(text, SV.pathOf(key), p.value);
  } catch (e) {
    die(`settings set: ${file} is not a JSON object (${e.message}). Nothing was changed.`);
  }
  if (next === text) {
    console.log(`${key} = ${SV.valueText(row, p.value)} already (nothing changed).`);
    return;
  }
  if (weak) logWeakened(row, now, p.value, by);
  try {
    fs.writeFileSync(file, next);
  } catch (e) {
    die(`settings set: could not write ${file} (${e.message}).`);
  }
  console.log(`${key} = ${SV.valueText(row, p.value)} (${SV.STORE_TEXT.config}).`);
}

export function cmdSettings() {
  const sub = a[1];
  if (sub === 'set') return setSetting();
  if (sub === 'help') {
    console.log(USAGE);
    return;
  }
  return showSettings();
}
