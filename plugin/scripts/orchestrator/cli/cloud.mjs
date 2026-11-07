// =============================================================
// cli/cloud.mjs: the commands that compare with the remote: cloud, cloud-package, cloud-bundles and external.
//
// cloud* say which tasks suit a cloud session (and package them), from <remote>/<baseBranch> and the local changes.
// cloud send fires a scheduled task (lib/cloudFire.js), only when the owner has set cloud.start to routine and only when someone
// runs it. cloud check reads the pushed branches once; the pulse does the same at most every 5 minutes, so there is no loop here.
// cloud setup and doctor share lib/cloudSetup.js. cloud settings and cloud set read and write the cloud part of queue.config.json.
// cloud collect brings finished sessions home: cloud done, a worktree, prepare-track and receive. Merge stays a step of its own.
// external scans the base branch for changes made outside the queue (and accept/add/done for them).
//
// Why a module: queue.mjs was one file of about 6,300 lines. It is now a thin entry point (the usage comment and the
// dispatch on the command word) plus the modules in cli/. The code was moved as it was: same output, exit codes and files.
//
// Used by: queue.mjs (dispatch).
// Tested in: lib/__tests__/queueCloud.test.ts, queueFeatures.test.ts, queueExternal.test.ts.
// =============================================================

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  a, BASE, branchFor, branchInfo, CLI, CONFIG, cut, die, edit, FOLDER, G, git, GIT_ROOT, gitRead, KK, L, missionFile, positional, PREFIX, read, REMOTE,
  require, uncommittedPaths, val, values, WIDTH,
} from './context.mjs';
import { logTime, minutes } from './tracks.mjs';

const CF = require('./lib/cloudFire.js');
const CS = require('./lib/cloudSetup.js');

/** How often the pulse reads the remote for cloud tracks. */
const CHECK_EVERY_MS = 5 * 60 * 1000;
/** A remote that does not answer must not hold up a pulse. */
const REMOTE_TIMEOUT_MS = 15_000;
const SCRIPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---- queue.mjs cloud: suitability with git --------------------------------------------------------------------
/** <remote>/<baseBranch> and the paths changed locally since it (committed and not pushed, plus uncommitted). */
function cloudContext() {
  const pushedHead =
    gitRead(['rev-parse', '-q', '--verify', `refs/remotes/${REMOTE}/${BASE}`])?.trim() || null;
  const changed = new Set();
  if (pushedHead) {
    const diff = gitRead(['diff', '--name-only', `refs/remotes/${REMOTE}/${BASE}...${BASE}`]);
    for (const s of String(diff ?? '').split('\n')) if (s.trim()) changed.add(s.trim());
  }
  for (const s of uncommittedPaths()) changed.add(s);
  return { pushedHead, changed: [...changed] };
}
/** The mission text and the suitability for one task. */
function cloudAssess(queue, o, context = cloudContext()) {
  const file = missionFile(o);
  const text = file ? fs.readFileSync(file, 'utf8') : String(o.mission ?? '');
  const ownPath = file ? String(o.mission) : null;
  const suitability = L.cloudSuitable(queue, o.id, { ...context, missionText: text, ownPath });
  return { text, ownPath, suitability };
}
/** A cloud start during the usage limit pause would only fail, and it shares the plan's limits: exit 12, as for a local start. */
function usagePauseStop(force) {
  const stop = L.usageLimitGuard();
  if (stop && !force) die(`${stop.message} One cloud start anyway: add --force.`, stop.code);
}

/** The parts of a package, with what makes them unsuitable. Refuses unless --force. */
function cloudParts(queue, ids, usage) {
  const context = cloudContext();
  const parts = ids.map((id) => {
    const o = queue.tasks.find((x) => x.id === id);
    if (!o) die(`Unknown task ${id}`);
    return { o, ...cloudAssess(queue, o, context) };
  });
  const reasons = [
    ...parts.flatMap((d) => d.suitability.reasons.map((g) => `${d.o.id}: ${g}`)),
    ...L.cloudBundleCap(parts.map((d) => d.o)).map((g) => `bundle: ${g}`),
  ];
  if (reasons.length) {
    const text = reasons.join('\n  ');
    if (!a.includes('--force')) die(`Not suitable for the cloud:\n  ${text}\n(${usage})`);
    // To stderr, so the package on stdout is clean (the board copies it).
    console.error(`WARNING: not suitable for the cloud (--force):\n  ${text}`);
  }
  return parts;
}

// ---- Noticing that a cloud track has finished ------------------------------------------------------------------------
/** git against the remote, with a time limit and never a prompt for a password. null when it fails. */
function gitRemote(args) {
  const r = spawnSync('git', args, {
    cwd: GIT_ROOT,
    encoding: 'utf8',
    timeout: REMOTE_TIMEOUT_MS,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** The message of the tip, fetching it first when this repo does not have it yet. */
function tipMessage(branch, sha) {
  if (git(['cat-file', '-e', `${sha}^{commit}`]) == null) {
    if (gitRemote(['fetch', '-q', REMOTE, `+refs/heads/${branch}:refs/remotes/${REMOTE}/${branch}`]) == null) return null;
  }
  return git(['log', '-1', '--format=%B', sha]);
}

/**
 * One read of the remote for the tasks in the cloud: which of their two branches exist, and what the tip says. The state of a
 * task is nothing (no branch yet), pushed (no finish marker yet), done or stop. Fetches a tip it needs; never changes the queue.
 * @returns {{ reachable: boolean, tasks: { id: string, state: string, branch: string|null, sha: string|null, reason: string|null }[] }}
 */
function cloudCheck(queue = read()) {
  const inCloud = queue.tasks.filter(L.isCloud);
  if (!inCloud.length) return { reachable: true, tasks: [] };
  const refs = inCloud.flatMap((o) => L.cloudBranches(o.id)).map((b) => `refs/heads/${b}`);
  const listed = gitRemote(['ls-remote', '--heads', REMOTE, ...refs]);
  if (listed == null) return { reachable: false, tasks: [] };
  const tips = new Map();
  for (const line of listed.split('\n')) {
    const m = /^([0-9a-f]{7,64})\s+refs\/heads\/(.+)$/.exec(line.trim());
    if (m) tips.set(m[2], m[1]);
  }
  const tasks = inCloud.map((o) => {
    const found = L.cloudBranches(o.id).filter((b) => tips.has(b));
    for (const branch of found) {
      const marker = L.cloudMarker(tipMessage(branch, tips.get(branch)), o.id);
      if (marker) return { id: o.id, state: marker.kind, branch, sha: tips.get(branch), reason: marker.reason };
    }
    return found.length
      ? { id: o.id, state: 'pushed', branch: found[0], sha: tips.get(found[0]), reason: null }
      : { id: o.id, state: 'nothing', branch: null, sha: null, reason: null };
  });
  return { reachable: true, tasks };
}

/** The line for one task, with the next step. The stop reason comes from outside, so it stays quoted data. */
function checkLine(t) {
  if (t.state === 'done') {
    const byHand = `${CLI} cloud done ${t.id} --branch ${t.branch}`;
    const mode = CS.cloudSettingsView(CONFIG.cloud).find((s) => s.key === 'collect').value;
    const next =
      mode === 'off'
        ? `Next: ${byHand}`
        : mode === 'auto'
          ? `Run now (cloud.collect is auto): ${CLI} cloud collect ${t.id}. By hand: ${byHand}`
          : `Next, once the owner says yes: ${CLI} cloud collect ${t.id}. By hand: ${byHand}`;
    return `${t.id}: finished in the cloud (${t.branch} at ${t.sha.slice(0, 10)}). ${next}`;
  }
  if (t.state === 'stop')
    return (
      `${t.id}: stopped in the cloud, reason given: "${t.reason ?? 'none'}" (${t.branch}). Next: ${CLI} cloud cancel ${t.id}, and ` +
      `git push ${REMOTE} --delete ${t.branch}. If it needs something only found locally, give the task the label not-cloud.`
    );
  if (t.state === 'pushed')
    return `${t.id}: pushed to ${t.branch} (${t.sha.slice(0, 10)}), no finish marker yet: still working, or look at the session on claude.ai/code.`;
  return `${t.id}: nothing pushed yet.`;
}

/** For the pulse: only what needs doing, at most every CHECK_EVERY_MS, and it never gets in the pulse's way. */
export function cloudPulseLines(now = Date.now()) {
  try {
    const queue = read();
    if (!queue.tasks.some(L.isCloud)) return [];
    const file = path.join(FOLDER, 'cloud-check.json');
    let last = 0;
    try {
      last = Date.parse(JSON.parse(fs.readFileSync(file, 'utf8')).at) || 0;
    } catch {
      /* no earlier check */
    }
    if (now - last < CHECK_EVERY_MS) return [];
    fs.writeFileSync(file, `${JSON.stringify({ at: new Date(now).toISOString() })}\n`);
    // Off hides the cloud, but work that is out there must not vanish with it.
    if (!KK.featureOn('cloud', CONFIG)) return [`Cloud is off, but still out there: ${queue.tasks.filter(L.isCloud).map((o) => o.id).join(', ')}. ${CLI} cloud check, then cloud collect or cloud cancel.`];
    return cloudCheck(queue).tasks.filter((t) => t.state === 'done' || t.state === 'stop').map((t) => `Cloud: ${checkLine(t)}`);
  } catch {
    return [];
  }
}

// ---- Setup ----------------------------------------------------------------------------------------------------------
/** The facts lib/cloudSetup.js needs, read locally. Doctor uses this too, so nothing here writes or goes online. */
export function cloudSetupFacts() {
  const own = CONFIG.cloud ?? {};
  const pushed = git(['rev-parse', '-q', '--verify', `refs/remotes/${REMOTE}/${BASE}`]) != null;
  return {
    remote: REMOTE,
    base: BASE,
    remoteUrl: git(['remote', 'get-url', REMOTE]) || null,
    pushed,
    unpushed: pushed ? Number(git(['rev-list', '--count', `refs/remotes/${REMOTE}/${BASE}..${BASE}`]) ?? 0) || 0 : 0,
    start: own.start ?? 'terminal',
    fireUrlValid: fireUrlOk(own.fireUrl),
    tokenSet: Boolean(process.env[CF.TOKEN_ENV]),
    maxSessions: L.cloudMax(),
    paused: L.usageLimitGuard()?.summary ?? null,
    setupScript: CS.suggestSetupScript(rootFiles()),
    ravenseat: CLI,
  };
}
function rootFiles() {
  try {
    return fs.readdirSync(GIT_ROOT);
  } catch {
    return [];
  }
}
const fireUrlOk = (url) => CF.validFireUrl(url, { allowLoopback: process.env.QUEUE_CLOUD_ALLOW_LOOPBACK === '1' });

/** How claude is logged in (never who), or null when it cannot be read. */
function claudeAuth() {
  const c = CS.claudeCommand();
  const r = spawnSync(c.command, [...c.before, 'auth', 'status'], { encoding: 'utf8', timeout: REMOTE_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    return String(JSON.parse(r.stdout).authMethod ?? '') || null;
  } catch {
    return null;
  }
}

function cloudSetup() {
  const on = KK.featureOn('cloud', CONFIG);
  const facts = { ...cloudSetupFacts(), auth: claudeAuth() };
  const rows = CS.cloudSetupRows(facts);
  console.log(`Cloud tracks are ${on ? 'on' : 'off'}.${on ? '' : ` Turn them on with: ${CLI} cloud on`} This list changes nothing.\n`);
  for (const r of rows) {
    console.log(`${r.status.padEnd(4)}  ${r.name.padEnd(10)}  ${r.message}`);
    if (r.fix) console.log(`${' '.repeat(18)}fix: ${r.fix}`);
  }
  console.log(
    [
      '',
      `To use it: ${CLI} cloud shows what suits the cloud. ${CLI} cloud-start <id> opens a session in your terminal, and from there it runs on its own.`,
      `${CLI} cloud check says when it has finished (the pulse asks too). Then ${CLI} cloud collect <id> fetches it and runs the gates here, and ${CLI} merge <id> merges it, as for a local track.`,
      `What you can set: ${CLI} cloud settings.`,
      '',
      'To start without a terminal (optional, a scheduled task with an API trigger):',
      ...CS.routineSteps(CLI).map((l) => `  ${l}`),
    ].join('\n'),
  );
}

/** Changes the project's queue.config.json, everything else left as it is. */
function changeOwnConfig(change) {
  const file = KK.configFile();
  let text = null;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e?.code !== 'ENOENT') die(`Could not read ${file}: ${e.message}`);
  }
  let own = {};
  if (text != null) {
    try {
      own = JSON.parse(text);
    } catch (e) {
      die(`${file} does not parse (${e.message}). Nothing changed.`);
    }
  }
  const next = `${JSON.stringify(change(own), null, 2)}\n`;
  fs.writeFileSync(file, text?.includes('\r\n') ? next.replace(/\n/g, '\r\n') : next);
  return file;
}

/** `cloud on|off`: the one switch for all of the cloud part. Off keeps the settings, so on again gives the same setup. */
function cloudSwitch(on) {
  const file = changeOwnConfig((own) => ({ ...own, features: { ...(own.features ?? {}), cloud: on } }));
  const tabHidden = KK.boardSwitches(CONFIG, read()).showCloud === false;
  console.log(
    `Cloud is ${on ? 'on' : 'off'} (features.cloud in ${file}).` +
      (on
        ? ` What it needs: ${CLI} cloud setup. What you can set: ${CLI} cloud settings.${tabHidden ? ` The Cloud tab stays hidden, as you set it: ${CLI} board-setting cloud on.` : ''}`
        : ' The tab, the pulse lines and the offer are gone. Your settings are kept.'),
  );
  const out = read().tasks.filter(L.isCloud);
  if (!on && out.length)
    console.log(`Still out there: ${out.map((o) => o.id).join(', ')}. They keep running. ${CLI} cloud check, then cloud collect or cloud cancel, work while it is off.`);
}

/** `cloud settings`: everything that can be set, with its value. Reads the file, so it is right just after a change. */
function cloudSettings() {
  const fresh = KK.config({ fresh: true });
  const on = KK.featureOn('cloud', fresh);
  const rows = CS.cloudSettingsView(fresh.cloud);
  if (a.includes('--json')) return console.log(JSON.stringify({ on, settings: rows.map(({ key, value }) => ({ key, value })) }));
  console.log(`Cloud is ${on ? 'on' : 'off'}. ${on ? `Hide all of it: ${CLI} cloud off.` : `Turn it on: ${CLI} cloud on.`}\n`);
  for (const r of rows) console.log(`${r.key.padEnd(13)} ${String(r.value).padEnd(9)} ${r.help}`);
  console.log(`\nChange one: ${CLI} cloud set <setting> <value>, or the gear on the board. The Cloud tab alone: ${CLI} board-setting cloud on|off.`);
}

/** `cloud set <setting> <value>`. */
function cloudSet(key, text) {
  const r = CS.parseCloudSetting(key, text);
  if (r.error) die(`${r.error}. Nothing changed.`);
  const file = changeOwnConfig((own) => ({ ...own, cloud: { ...(own.cloud ?? {}), [key]: r.value } }));
  console.log(`cloud.${key} is ${r.value} (${file}).`);
}

// ---- cloud collect: bring finished sessions home ----------------------------------------------------------------------
/** The folder a branch is checked out in, or null. */
function worktreeOf(branch) {
  let path_ = null;
  for (const line of String(gitRead(['worktree', 'list', '--porcelain']) ?? '').split(/\r?\n/)) {
    if (line.startsWith('worktree ')) path_ = line.slice('worktree '.length);
    if (line === `branch refs/heads/${branch}`) return path_;
  }
  return null;
}

/** One finished session: cloud done, a worktree, prepare-track, receive. Returns the exit code of the step that stopped it. */
function collectOne(t) {
  const node = (cwd, script, ...args) => spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], { cwd, stdio: 'inherit' }).status ?? 1;
  const QUEUE = 'queue.mjs';
  const done = node(GIT_ROOT, QUEUE, 'cloud', 'done', t.id, '--branch', t.branch, '--sha', t.sha, '--quiet-steps');
  if (done !== 0) return done;
  const local = branchFor(t.id);
  let folder = worktreeOf(local);
  if (!folder) {
    folder = path.join(GIT_ROOT, '.claude', 'worktrees', `cloud-${t.id}`);
    if (git(['worktree', 'add', '-q', folder, local]) == null) {
      console.error(`${t.id}: could not make a worktree for ${local} in ${folder}. The task is in review; do the rest by hand: ${CLI} prepare-track, ${CLI} receive.`);
      return 1;
    }
  }
  const scratch = path.join(FOLDER, 'collect', t.id);
  fs.mkdirSync(scratch, { recursive: true });
  const prepared = node(folder, 'prepare-track.mjs', t.id, '--branch', local, '--continue', '--scratchpad', scratch);
  if (prepared !== 0) return prepared;
  return node(folder, QUEUE, 'receive', t.id, '--scratchpad', scratch);
}

/** `cloud collect [<id> ...] [--dry-run]`: one at a time, so the machine runs one set of gates. A red one does not stop the next. */
function cloudCollect(ids) {
  const r = cloudCheck();
  if (!r.reachable) die(`Could not read ${REMOTE}, so nothing is known about the cloud tracks. Their tasks are unchanged.`);
  const finished = r.tasks.filter((t) => t.state === 'done' && (!ids.length || ids.includes(t.id)));
  for (const id of ids) if (!finished.some((t) => t.id === id)) {
    const t = r.tasks.find((x) => x.id === id);
    console.log(t ? checkLine(t) : `${id}: not in a cloud session.`);
  }
  if (!finished.length) return console.log('Nothing finished in the cloud to collect.');
  if (a.includes('--dry-run')) {
    console.log(`Would collect ${finished.map((t) => t.id).join(', ')}: fetch the branch, make a worktree, run the quick gates here.`);
    return;
  }
  const red = [];
  for (const t of finished) {
    console.log(`\n--- ${t.id} ---`);
    if (collectOne(t) !== 0) red.push(t.id);
  }
  const green = finished.map((t) => t.id).filter((id) => !red.includes(id));
  console.log(`\nCollected: ${green.length ? `${green.join(', ')} (next: what receive said above, then ${CLI} merge <id>)` : 'none'}.${red.length ? ` Stopped: ${red.join(', ')} (see above).` : ''}`);
  if (red.length) process.exitCode = 1;
}

// ---- cloud send: a session without a terminal ---------------------------------------------------------------------
/** Fires the scheduled task once. Only with cloud.start routine: starting something outward is the owner's choice. */
async function cloudSend(ids) {
  const force = a.includes('--force');
  if (!ids.length) die('cloud send <id> [<id> ...] [--force]');
  const own = CONFIG.cloud ?? {};
  if (own.start !== 'routine')
    die(`cloud send needs cloud.start set to "routine" in queue.config.json (it is "${own.start ?? 'terminal'}"). It starts a session on your plan, so it is off until you choose it. See ${CLI} cloud setup, or use ${CLI} cloud-start <id> in a terminal.`);
  if (!fireUrlOk(own.fireUrl))
    die(`cloud.fireUrl must be the trigger's URL, https://api.anthropic.com/v1/claude_code/routines/trig_.../fire. See ${CLI} cloud setup.`);
  const token = process.env[CF.TOKEN_ENV];
  if (!token) die(`The environment variable ${CF.TOKEN_ENV} is not set. See ${CLI} cloud setup.`);
  usagePauseStop(force);
  const unpushed = Number(git(['rev-list', '--count', `refs/remotes/${REMOTE}/${BASE}..${BASE}`]) ?? 0) || 0;
  if (unpushed > 0 && !force)
    die(`${BASE} has ${unpushed} commit(s) not pushed to ${REMOTE}, and the session would start without them. Push ${BASE} first, or use --force.`);
  const queue0 = read();
  const parts = cloudParts(queue0, ids, '--force sends it anyway');
  const pkg = L.cloudBundlePackage(parts, queue0);
  if (pkg.length > CF.FIRE_TEXT_MAX)
    die(`The package is ${pkg.length} characters; the endpoint takes at most ${CF.FIRE_TEXT_MAX}. Send fewer tasks at once, or shorten the mission.`);
  const suitability = Object.fromEntries(parts.map((d) => [d.o.id, d.suitability]));
  // Marked first, under the lock: the cap holds even when two sends race, and a session is never left without its task.
  const started = edit((queue) => {
    const s = L.cloudStart(queue, ids, { suitability, force });
    if (s.error) die(s.error);
    return s;
  });
  for (const x of started.newOnes) logTime(x, 'cloud-start', 'cloud send');
  const r = await CF.fireRoutine({ url: own.fireUrl, token, text: pkg });
  if (r.ok) {
    // The id first: claude -p "..." --cloud <id> needs it for a follow-up, and the address is built from it.
    const execution = r.sessionId ?? r.sessionUrl ?? null;
    if (execution) edit((queue) => void L.cloudStart(queue, ids, { execution, force: true }));
    console.log(`Started in the cloud: ${ids.join(', ')}${r.sessionUrl ?? execution ? ` (${r.sessionUrl ?? execution})` : ''}. ${CLI} cloud check says when it has finished.`);
    return;
  }
  if (r.created === false) {
    edit((queue) => {
      for (const id of started.newOnes) L.cloudCancel(queue, id, { commits: 0 });
    });
    for (const x of started.newOnes) logTime(x, 'cloud-aborted', `cloud send refused: HTTP ${r.status}`);
    die(
      `The endpoint refused (HTTP ${r.status}: ${r.message}), so no session started and ${started.newOnes.join(', ') || 'the tasks'} wait again.` +
        (r.retryAfter ? ` It asks you to wait ${r.retryAfter} s (Retry-After).` : ''),
    );
  }
  die(
    `The answer was unclear (${r.status ? `HTTP ${r.status}: ` : ''}${r.message}), so a session may have started. Not sent again: every accepted call makes a new session. ` +
      `Look on https://claude.ai/code. If there is none: ${ids.map((id) => `${CLI} cloud cancel ${id}`).join('; ')}.`,
  );
}

// ---- queue.mjs external: scanning (read-only) ---------------------------------------------------------------------
function externalWindow(queue) {
  if (a.includes('--all')) {
    const times = queue.tasks
      .filter((o) => !L.isExternalRow(o) && L.COLLISION_STATUSES.includes(o.status))
      .map((o) => Date.parse(o.added_at ?? ''))
      .filter(Number.isFinite);
    const ms = times.length ? Math.min(...times) : Date.now() - 86_400_000;
    return {
      window: { since: new Date(ms).toISOString() },
      text: 'since the oldest task in progress was added',
    };
  }
  const s = val('--since');
  if (s) {
    const m = /^(\d+)\s*([hd])$/i.exec(s);
    if (m) {
      const ms = Number(m[1]) * (m[2].toLowerCase() === 'h' ? 3_600_000 : 86_400_000);
      return { window: { since: new Date(Date.now() - ms).toISOString() }, text: `last ${s}` };
    }
    if (/^\d{4}-\d{2}-\d{2}/.test(s) && Number.isFinite(Date.parse(s)))
      return { window: { since: new Date(Date.parse(s)).toISOString() }, text: `since ${s}` };
    return { window: { from: s }, text: `${s}..${BASE}` };
  }
  if (gitRead(['rev-parse', '-q', '--verify', `refs/remotes/${REMOTE}/${BASE}`]) != null)
    return {
      window: { from: `${REMOTE}/${BASE}` },
      text: `not pushed (${REMOTE}/${BASE}..${BASE})`,
    };
  return {
    window: { since: new Date(Date.now() - 86_400_000).toISOString() },
    text: `last 24 h (could not find ${REMOTE}/${BASE})`,
  };
}
function externalScan() {
  const queue = read();
  // --id <id>: only that one task, with the window from when it was added (the same check start/pick/trackFile do).
  const onlyId = val('--id');
  if (onlyId) {
    const o = queue.tasks.find((x) => x.id === onlyId);
    if (!o) die(`Unknown task ${onlyId}`);
    const v = G.externalForTasks(gitRead, [{ ...o, status: 'waiting' }]).get(onlyId);
    for (const f of v.error) console.log(`WARNING: ${f}`);
    console.log(
      `${onlyId} (${o.status}), added ${o.added_at ?? '?'}: ${v.collisions.length} collision(s), ` +
        `${v.mentioned.length} commit(s) outside the queue that mention the id.`,
    );
    for (const k of v.collisions) console.log(`  ${L.collisionText(k, { withId: false })}`);
    for (const c of v.mentioned)
      console.log(
        `  mentioned in ${c.summary} "${c.subject}"${o.status === 'waiting' ? ` -> completed? ravenseat external accept ${onlyId} ${c.summary}` : ''}`,
      );
    if (!v.collisions.length && !v.mentioned.length)
      console.log('  Nothing outside the queue affects it.');
    return;
  }
  const { window, text } = externalWindow(queue);
  const b = G.externalImage(gitRead, queue, { window });
  if (a.includes('--json')) {
    // Without the message texts (long); subject, files and source are enough.
    const without = (c) => ({
      ...c,
      message: undefined,
      side: (c.side ?? []).map((s) => ({ sha: s.sha, subject: s.subject, source: s.source })),
    });
    console.log(
      JSON.stringify(
        { window: text, ...b, commits: b.commits.map(without), externalOnes: b.externalOnes.map(without) },
        null,
        2,
      ),
    );
    return;
  }
  const max = Number(val('--max') ?? 20) || 20;
  const date = (d) =>
    String(d ?? '')
      .slice(0, 16)
      .replace('T', ' ');
  const fileText = (files, n = 6) =>
    files.length
      ? `${files.slice(0, n).join(', ')}${files.length > n ? ` (+${files.length - n})` : ''}`
      : '(no files)';
  const out = [`Work outside the queue (window: ${text}):`];
  for (const f of b.error) out.push(`WARNING: ${f}`);

  // (a) Commits on baseBranch that do not come from the queue.
  const countOf = (k) => b.commits.filter((c) => c.source === k).length;
  out.push('');
  out.push(
    `(a) Commits on ${BASE} that do not come from the queue: ${b.externalOnes.length} ` +
      `(of ${b.commits.length} on the first-parent line; ${countOf('queue')} from the queue, ${countOf('orchestrator')} from the orchestrator)`,
  );
  const perSha = new Map();
  for (const s of b.consistency) perSha.set(s.sha, [...(perSha.get(s.sha) ?? []), s]);
  for (const c of b.externalOnes.slice(0, max)) {
    out.push(`  ${c.summary}  ${date(c.date)}  ${cut(c.subject, WIDTH - 30)}`);
    out.push(`            files: ${cut(fileText(c.files), WIDTH - 19)}`);
    const side = (c.side ?? []).filter((s) => s.source === 'external');
    if (side.length) out.push(`            merge that brings in ${side.length} commit(s) outside the queue`);
    const mentions = perSha.get(c.sha) ?? [];
    if (mentions.length)
      out.push(`            mentions: ${mentions.map((s) => `${s.id} (${s.status})`).join(', ')}`);
  }
  if (b.externalOnes.length > max) out.push(`  ... and ${b.externalOnes.length - max} older (--max N)`);

  // (b) Branches and worktrees outside the queue branches.
  out.push('');
  out.push(
    `(b) Branches and worktrees outside ${PREFIX}* with commits that are not in ${BASE}: ${b.branches.length}`,
  );
  for (const g of b.branches) {
    out.push(
      `  ${g.name}  ${g.count} commit(s)${g.last ? `, last ${date(g.last)}` : ''}${g.worktree ? `  worktree ${g.worktree}` : ''}`,
    );
    out.push(`            files: ${cut(fileText(g.files), WIDTH - 19)}`);
  }

  // (c) Uncommitted in the main tree.
  const theTrack = b.uncommitted.filter((u) => !u.untracked);
  const untracked = b.uncommitted.filter((u) => u.untracked);
  out.push('');
  out.push(
    `(c) Uncommitted in the main tree: ${theTrack.length} changed, ${untracked.length} untracked${untracked.length && !a.includes('--untracked') ? ' (--untracked shows them)' : ''}`,
  );
  for (const u of [...theTrack, ...(a.includes('--untracked') ? untracked : [])].slice(0, 40))
    out.push(`  ${u.xy.trim().padEnd(2)} ${u.path}`);

  // Registered outside the queue, and tasks without a project or feature.
  out.push('');
  out.push(`Registered outside the queue (external add): ${b.registered.length || 'none'}`);
  for (const o of b.registered)
    out.push(
      cut(
        `  ${o.id}  "${o.external_name}"  ${[...(o.owned_files ?? []), ...(o.owner_db ?? [])].join(', ')}${o.branch ? `  branch ${o.branch}` : ''}`,
        WIDTH,
      ),
    );
  const { withoutProject, withoutFeature } = b.missing;
  // Tasks added without a project or feature (e.g. by another session without /add-to-queue).
  const idText = (ids) => `${ids.slice(0, 8).join(', ')}${ids.length > 8 ? ' ...' : ''}`;
  const missing = [
    withoutProject.length ? `without project ${withoutProject.length} (${idText(withoutProject)})` : null,
    withoutFeature.length ? `without feature ${withoutFeature.length} (${idText(withoutFeature)})` : null,
  ].filter(Boolean);
  if (missing.length) {
    out.push(cut(`Tasks in progress ${missing.join('; ')}.`, WIDTH));
    out.push('  Fix with ravenseat edit-many --file <json> ([{ "id", "project", "feature" }]).');
  }

  // Collisions and consistency.
  out.push('');
  out.push(
    `Collisions with the owned files (running, picked, in review, pending): ${b.collisions.length}`,
  );
  for (const k of b.collisions.slice(0, 30))
    out.push(
      cut(`  ${L.collisionText(k).replace(`${k.id}: `, `${k.id} (${k.status}): `)}`, WIDTH),
    );
  if (b.collisions.length > 30) out.push(`  ... and ${b.collisions.length - 30} more (--json)`);
  const proposed = b.consistency.filter((s) => s.proposed);
  if (proposed.length) {
    out.push('');
    out.push(
      'Consistency: external commits mention pending tasks. Are they completed? Accept only after looking at the commit:',
    );
    for (const s of proposed) out.push(cut(`  ${s.proposed}   "${s.subject}"`, WIDTH));
  }
  console.log(out.join('\n'));
}

/** `ravenseat external` (the usage is at the top of queue.mjs). */
export function cmdExternal() {
  // ---- Work outside the queue ----
  const under = a[1] && !a[1].startsWith('--') ? a[1] : null;
  if (!under) externalScan();
  else if (under === 'add') {
    const name = val('--name');
    const r = edit((queue) => {
      const s = L.externalAdd(queue, {
        name,
        files: values('--files'),
        db: values('--db'),
        branch: val('--branch') ?? null,
      });
      if (s.error) die(s.error);
      return s;
    });
    const owner = [...r.row.owned_files, ...r.row.owner_db].join(', ');
    console.log(
      `${r.new ? 'Registered' : 'Updated'} ${r.row.id} ("${r.row.external_name}"${r.row.branch ? `, branch ${r.row.branch}` : ''}): ` +
        `owns ${owner}. The queue starts nothing that collides until: ravenseat external done "${r.row.external_name}"`,
    );
    for (const x of r.warnings) console.log(`WARNING: ${x}`);
  } else if (under === 'done') {
    const [name] = positional(2);
    const r = edit((queue) => {
      const s = L.externalDone(queue, name);
      if (s.error) die(s.error);
      return s;
    });
    console.log(
      `${r.row.id} ("${r.row.external_name}"): done. The files are free for the queue again. If the work is committed on ${BASE}, ` +
        'ravenseat external shows whether it mentions pending tasks.',
    );
  } else if (under === 'accept') {
    const [id, ref] = positional(2);
    if (!id || !ref) die('external accept <id> <sha>');
    const full = String(gitRead(['rev-parse', '-q', '--verify', `${ref}^{commit}`]) ?? '').trim();
    if (!full) die(`Could not find commit ${ref}.`);
    // Only what is on baseBranch can count as completed (a branch outside the queue is not delivered yet).
    if (gitRead(['merge-base', '--is-ancestor', full, BASE]) == null)
      die(`${ref} is not on ${BASE} (merge it first, or wait).`);
    const message = gitRead(['log', '-1', '--format=%B', full]) ?? '';
    const mentioned = L.mentionedIds(message, [id]).length > 0;
    const r = edit((queue) => {
      const s = L.externalAccept(queue, id, full, { mentioned });
      if (s.error) die(s.error);
      return s;
    });
    console.log(
      `${id}: done (completed outside the queue in ${full.slice(0, 8)})` +
        `${r.qa ? ' · label visual: now in the owner QA list (ravenseat qa)' : ''}` +
        `${mentioned ? '' : ' · NB: the commit message does not mention the id (noted in the remark)'}`,
    );
  } else {
    die(
      'external [--since ...] [--all] | external accept <id> <sha> | external add --name "<session>" --files <...> [--branch <g>] | ' +
        'external done "<name>"',
    );
  }
}

/** `ravenseat cloud-package` (the usage is at the top of queue.mjs). */
export function cmdCloudPackage() {
  // ---- Cloud: the package for a cloud session (cloud-start and cloud send make it themselves; this one shows it) ----
  // One id, or a bundle of at most 4 (total estimate <= about 120 min) done one after the other in the same cloud session.
  const ids = positional(1, ['--out']);
  if (!ids.length) die('cloud-package <id> [<id> ...] [--out <file>] [--force]');
  const queue = read();
  const parts = cloudParts(queue, ids, '--force makes the package anyway');
  const pkg = L.cloudBundlePackage(parts, queue);
  const out = val('--out');
  if (out) {
    fs.writeFileSync(out, `${pkg}\n`);
    console.log(
      `Wrote the cloud package for ${ids.join(', ')} to ${out} (${pkg.length} chars). Start it with ${CLI} cloud-start ${ids.join(' ')} in a terminal, ` +
        `or ${CLI} cloud send ${ids.join(' ')} when cloud.start is routine.`,
    );
  } else process.stdout.write(`${pkg}\n`);
}

/** `ravenseat cloud-bundles` (the usage is at the top of queue.mjs). */
export function cmdCloudBundles() {
  // Proposals for bundles of cloud-suitable tasks (the same project/feature one after the other), by priority.
  const max = Number(val('--max') ?? L.cloudBundleMax());
  const maxMin = Number(val('--max-min') ?? L.CLOUD_BUNDLE_MIN);
  if (!(max >= 1) || !(maxMin > 0)) die('--max and --max-min must be numbers above 0');
  const queue = read();
  const context = cloudContext();
  const register = queue.projects ?? {};
  const candidates = queue.tasks
    .filter((o) => o.status === 'waiting' && cloudAssess(queue, o, context).suitability.suitable)
    .map((o) => ({
      id: o.id,
      project: L.projectFor(o, register),
      feature: o.feature ?? null,
      estimate: L.estimate(o),
      score: L.score(o, queue.tasks, Date.now(), register),
    }));
  const bundles = L.cloudBundles(candidates, { max, maxMin });
  // --json: machine-readable for queueBoard (the "Cloud" view), with a ready command per bundle.
  if (a.includes('--json')) {
    const titleJ = new Map(queue.tasks.map((o) => [o.id, o.title ?? '']));
    console.log(
      JSON.stringify({
        bundles: bundles.map((b) => ({
          ids: b.ids,
          minutes: b.minutes,
          areas: b.areas,
          titles: Object.fromEntries(b.ids.map((id) => [id, titleJ.get(id)])),
          command: `${CLI} ${CONFIG.cloud?.start === 'routine' ? 'cloud send' : 'cloud-start'} ${b.ids.join(' ')}`,
        })),
        sessions: L.cloudSessions(queue),
        max: L.cloudMax(),
        pushed: Boolean(context.pushedHead),
      }),
    );
    process.exit(0);
  }
  if (!bundles.length)
    console.log(
      `No cloud-suitable tasks now${context.pushedHead ? '' : ` (could not find ${REMOTE}/${BASE})`}.`,
    );
  const title = new Map(queue.tasks.map((o) => [o.id, o.title ?? '']));
  bundles.forEach((b, i) => {
    console.log(
      `Bundle ${i + 1}: ${b.ids.length} task(s), ${b.minutes} min · ${b.areas.join(' + ')}`,
    );
    for (const id of b.ids) console.log(cut(`  ${id.padEnd(12)} ${title.get(id)}`, WIDTH));
    console.log(`  → ravenseat cloud-package ${b.ids.join(' ')} --out <file>`);
  });
  const sessions = L.cloudSessions(queue);
  if (bundles.length) console.log(`\n${sessions} cloud session(s) running now (at most ${L.cloudMax()}).`);
}

/** `ravenseat cloud` (the usage is at the top of queue.mjs). */
export function cmdCloud() {
  const [under, id, ...more] = positional(1, ['--run', '--sha', '--branch']);
  const force = a.includes('--force');
  if (under === 'setup') return cloudSetup();
  if (under === 'on' || under === 'off') return cloudSwitch(under === 'on');
  if (under === 'settings') return cloudSettings();
  if (under === 'set') {
    if (!id || !more.length) die('cloud set <setting> <value>. See cloud settings.');
    return cloudSet(id, more[0]);
  }
  if (under === 'collect') return cloudCollect(id ? [id, ...more] : []);
  if (under === 'send')
    return void cloudSend(id ? [id, ...more] : []).catch((e) => die(`cloud send failed: ${e?.message ?? e}`));
  if (under === 'check') {
    const r = cloudCheck();
    if (a.includes('--json')) return console.log(JSON.stringify(r));
    if (!r.reachable) return console.log(`Could not read ${REMOTE}, so nothing is known about the cloud tracks. Their tasks are unchanged.`);
    if (!r.tasks.length) return console.log('Nothing in the cloud now.');
    for (const t of r.tasks) console.log(checkLine(t));
    return;
  }
  if (!under) {
    // Overview: the cloud sessions running, and the pending ones that are suitable.
    const queue = read();
    const inCloud = queue.tasks.filter(L.isCloud);
    console.log(`Cloud sessions (${inCloud.length} of at most ${L.cloudMax()}):`);
    if (!inCloud.length) console.log('  none');
    for (const o of inCloud)
      console.log(
        cut(
          `  ${o.id.padEnd(12)} started ${L.ageText(Date.now() - Date.parse(o.cloud.started))} ago` +
            `${o.cloud.execution ? ` · ${o.cloud.execution}` : ''}  ${o.title ?? ''}`,
          WIDTH,
        ),
      );
    const k = cloudContext();
    const suitable = queue.tasks
      .filter((o) => o.status === 'waiting')
      .filter((o) => cloudAssess(queue, o, k).suitability.suitable)
      .map((o) => ({ o, score: L.score(o, queue.tasks, Date.now(), queue.projects ?? {}) }))
      .sort((x, y) => y.score - x.score || x.o.id.localeCompare(y.o.id));
    console.log(
      `\nSuitable for the cloud now: ${suitable.length}${k.pushedHead ? '' : ` (could not find ${REMOTE}/${BASE})`}`,
    );
    for (const { o } of suitable.slice(0, 15))
      console.log(
        cut(
          `  ${o.id.padEnd(12)} ${String(o.class ?? '?').padEnd(2)} ${`${L.estimate(o)} min`.padEnd(7)} ${o.title ?? ''}`,
          WIDTH,
        ),
      );
    if (suitable.length > 15) console.log(`  ... and ${suitable.length - 15} more`);
    if (suitable.length)
      console.log(`\nStart: ${CLI} ${CONFIG.cloud?.start === 'routine' ? 'cloud send' : 'cloud-start'} <id>. Finished yet? ${CLI} cloud check. What it needs: ${CLI} cloud setup.`);
  } else if (under === 'start') {
    // More ids = a bundle in the same cloud session (the same --run).
    const ids = id ? [id, ...more] : [];
    if (!ids.length) die('cloud start <id> [<id> ...] [--run <session-id|url>] [--force]');
    const execution = val('--run') ?? null;
    if (execution != null && (!execution.trim() || execution.length > 300 || /\s/.test(execution)))
      die('--run must be the session id or link (without whitespace, at most 300 chars)');
    // Suitability needs git (the remote's baseBranch and local changes), so it is computed before the lock.
    const queue0 = read();
    const context = cloudContext();
    const suitability = {};
    for (const x of ids) {
      const o0 = queue0.tasks.find((y) => y.id === x);
      if (!o0) die(`Unknown task ${x}`);
      if (!L.isCloud(o0)) suitability[x] = cloudAssess(queue0, o0, context).suitability;
    }
    // A new start only: setting the run on a session that is already going uses nothing.
    if (Object.keys(suitability).length) usagePauseStop(force);
    const r = edit((queue) => {
      const s = L.cloudStart(queue, ids, { suitability, execution, force });
      if (s.error) die(s.error);
      return s;
    });
    for (const x of r.newOnes) logTime(x, 'cloud-start', execution ? `execution ${execution}` : 'without execution');
    if (r.newOnes.length)
      console.log(
        `Started in the cloud: ${r.newOnes.join(', ')}${execution ? ` (${execution})` : ''}. The cloud creates ${branchFor('<id>')} from ${REMOTE}/${BASE}.`,
      );
    if (r.left.length)
      console.log(
        `Already in the cloud: ${r.left.join(', ')}${execution ? `; the run is set to ${execution}` : ''}.`,
      );
    if (r.overridden.length) console.log(`--force overrode: ${r.overridden.join(' · ')}`);
    console.log(
      `${CLI} cloud check says when it has finished, from the marker on its branch. Then: ${CLI} cloud done <id> [--branch <branch the cloud pushed>] [--sha <sha>]. ` +
        `If it gives up (CLOUD-STOP): ${CLI} cloud cancel <id>.`,
    );
  } else if (under === 'done') {
    if (!id) die('cloud done <id> [--branch <branch>] [--sha <sha>]');
    const o0 = read().tasks.find((x) => x.id === id);
    if (!o0) die(`Unknown task ${id}`);
    if (!L.isCloud(o0)) die(`${id} is not in a cloud session (status ${o0.status}).`);
    const branch = val('--branch') ?? branchFor(id);
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/.test(branch) || branch.includes('..'))
      die(`Invalid branch name: ${branch}`);
    const sha = val('--sha') ?? null;
    if (sha != null && !/^[0-9a-f]{7,40}$/i.test(sha)) die(`Invalid sha: ${sha}`);
    // Fetch the branch the cloud pushed (and baseBranch, so the count is against what is pushed now).
    const fetched = git([
      'fetch',
      '-q',
      REMOTE,
      `+refs/heads/${branch}:refs/remotes/${REMOTE}/${branch}`,
      `+refs/heads/${BASE}:refs/remotes/${REMOTE}/${BASE}`,
    ]);
    if (fetched == null)
      die(
        `Could not find ${branch} on ${REMOTE} (git fetch failed). Did the cloud push to another branch? Use --branch <name>.`,
      );
    const remove = `refs/remotes/${REMOTE}/${branch}`;
    const count =
      Number(git(['rev-list', '--count', `refs/remotes/${REMOTE}/${BASE}..${remove}`]) ?? 0) || 0;
    if (count < 1)
      die(`${REMOTE}/${branch} has no commits above ${REMOTE}/${BASE}; nothing to merge.`);
    // The finish marker is an empty commit, so a count alone would take a session that changed nothing for a delivery.
    if (!git(['diff', '--name-only', `refs/remotes/${REMOTE}/${BASE}...${remove}`]))
      die(`${REMOTE}/${branch} has no changes above ${REMOTE}/${BASE}; nothing to merge. If the session gave up: ${CLI} cloud cancel ${id}.`);
    const tips = git(['rev-parse', remove]);
    if (sha && git(['merge-base', '--is-ancestor', sha, remove]) == null)
      die(`${sha} does not exist on ${REMOTE}/${branch} (tip ${tips?.slice(0, 10)}).`);
    // The local queue branch on the cloud's commits, so merge-track and "Merge branch '<queue branch>'" (the external scan) work as
    // for a local track. If a local queue branch has commits that are not included, we stop instead of overwriting them.
    const local = branchFor(id);
    if (branch !== local) {
      const exists = git(['rev-parse', '-q', '--verify', `refs/heads/${local}`]) != null;
      if (exists && git(['merge-base', '--is-ancestor', `refs/heads/${local}`, remove]) == null)
        die(
          `Local ${local} has commits that are not on ${REMOTE}/${branch}; merge by hand (merge-track.mjs ${REMOTE}/${branch}).`,
        );
      if (git(['branch', '-f', local, remove]) == null)
        die(`Could not set ${local} to ${REMOTE}/${branch} (is it checked out in a worktree?).`);
    } else if (git(['rev-parse', '-q', '--verify', `refs/heads/${local}`]) == null) {
      git(['branch', local, remove]);
    } else if (git(['merge-base', '--is-ancestor', `refs/heads/${local}`, remove]) != null) {
      git(['branch', '-f', local, remove]);
    } else {
      die(`Local ${local} has commits that are not on ${REMOTE}/${branch}; merge by hand.`);
    }
    const r = edit((queue) => {
      const s = L.cloudDone(queue, id, { branch, sha: sha ?? tips });
      if (s.error) die(s.error);
      return s;
    });
    logTime(
      id,
      'cloud-done',
      `${count} commit(s) on ${branch}, ${minutes(r.task.cloud.started, r.task.cloud.done)} min in the cloud`,
    );
    if (a.includes('--quiet-steps')) return void console.log(`${id}: completed in the cloud, review. ${count} commit(s) on ${REMOTE}/${branch}.`);
    console.log(
      [
        `${id}: completed in the cloud, review. ${count} commit(s) on ${REMOTE}/${branch} (tip ${String(tips).slice(0, 10)}).`,
        'Next, as for a local track. The gates run here and the evidence is recorded here, whatever the session says it ran:',
        `  1. git worktree add <folder> ${local}, then in <folder>: ${CLI} prepare-track ${id} --branch ${local} --continue   (the gates need a checkout with the shared links)`,
        `  2. ${CLI} receive ${id} --scratchpad <folder>   (runs the quick gates on the tip, and makes the review package)`,
        `  3. ${CLI} merge ${id}`,
        CONFIG.cloud?.deleteBranch === false
          ? `  4. git push ${REMOTE} --delete ${branch}   (cloud.deleteBranch is off; a session cannot delete branches, and an old one would get in the way of a new attempt)`
          : `  The merge removes ${branch} from ${REMOTE} too (cloud.deleteBranch); a session cannot delete branches, and an old one would get in the way of a new attempt.`,
      ].join('\n'),
    );
  } else if (under === 'cancel') {
    if (!id) die('cloud cancel <id>');
    const before = read().tasks.find((x) => x.id === id);
    const g = branchInfo(before?.branch ?? branchFor(id));
    const r = edit((queue) => {
      const s = L.cloudCancel(queue, id, { commits: g.commits });
      if (s.error) die(s.error);
      return s;
    });
    logTime(id, 'cloud-aborted', '');
    console.log(`${id}: the cloud session is aborted, the task is waiting again.`);
    if (r.warning) console.log(`WARNING: ${r.warning}`);
  } else {
    die('cloud [setup | settings | set <setting> <value> | on | off | start <id> [--run ...] | send <id> | check | collect [<id> ...] [--dry-run] | done <id> [--branch ...] [--sha ...] | cancel <id>]');
  }
}
