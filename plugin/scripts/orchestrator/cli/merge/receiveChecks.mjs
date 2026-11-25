// =============================================================
// cli/merge/receiveChecks.mjs: the checks receive runs on a delivery: the gate and done command step (receiveEvidence, with
// its red paths: a fix round or an owner question), red on base, the secret scan of the track's commits, the reuse and
// scope notes, the design choices' check rules, and the control file and outside-the-CLI config warnings.
//
// Why a module: the receive flow in steps (SPLIT-1, see cli/merge.mjs). Moved as it was: same output, exit codes and
// files. receiveEvidence is the part of cmdReceive between the intake and the package, cut at that seam with no change.
//
// Used by: cli/merge.mjs (cmdReceive), cli/merge/receive.mjs, cli/merge/receiveRecord.mjs, cli/merge/mergeChecks.mjs.
// Tested in: __tests__/redteam/redOnBase-cli.test.ts, __tests__/redteam/secretAtReceive-cli.test.ts,
//   __tests__/catalogChecksFlow.test.ts, __tests__/redteam/controlFiles-cli.test.ts, __tests__/queueDoneCheck.test.ts,
//   __tests__/queueGateBroken.test.ts, __tests__/queueAttempt.test.ts, lib/__tests__/scopeNotes.test.ts.
// =============================================================

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  BASE, CLI, CONFIG, die, edit, FOLDER, git, GIT_ROOT, L, pulseCursor, read, require, TIME_LOG, val,
} from '../context.mjs';
import { controlWhere, gitLarge, gitShowAt, logTime, readTimeLog, syncAttempts } from '../tracks.mjs';
import { catalogRules, stackChoicesNow } from '../catalog.mjs';
import { brokenGate, doneCommandRed, GE_MODE, receiveGates, runDoneCommand, trackWordGates } from './evidence.mjs';

const AT = require('./lib/logic/attempt.js');
const GB = require('./lib/gitSurfaceBaseline.js');

/**
 * The gate and done command step of receive (cmdReceive, after the intake): the quick gates bound to the delivered tip,
 * then the done command. A red one does not return (a fix round, exit 1 or 8; an owner question, exit 8; tampered: the
 * owner's stop). Returns { gateCheck, recordAttempt, doneCheck } for the package and the record.
 */
export function receiveEvidence({ id, o0, scratch, branch, folder, attemptLog, trackFound, result }) {
  // The quick gates bound to the delivered tip (receiveGates), BEFORE the done command and any reviewer: the track's own
  // claim is informational only. A PARTIAL track is known to be unfinished, so no gate runs for it.
  // gateEvidence.mode off (owner decision B2): a track that says gates=OK is taken at its word, nothing runs; without
  // that claim receive runs them as in own.
  const trackSaidGreen = GE_MODE === 'off' && /^ok$/i.test(String(result?.gates ?? '').trim()) && result?.status !== 'PARTIAL';
  if (result?.gates != null && result.status !== 'PARTIAL' && !trackSaidGreen)
    console.log(`The track's RESULT gates=${result.gates} is self-reported (informational only; receive checks the tip itself).`);
  const gateCheck =
    result?.status === 'PARTIAL'
      ? { status: 'off' }
      : trackSaidGreen
        ? trackWordGates(branch)
        : receiveGates(o0, { branch, scratch });
  // A run that changed what runs at the next git command (or the evidence store) is the owner's decision: no red path,
  // no blocker, no fix round, no attempt closed. The rerun hits the drift stop while the hook is there, else runs again.
  if (gateCheck.tampered)
    die(GB.tamperedMessage({ what: 'the check run at receive', reason: gateCheck.tampered, ravenseat: CLI, again: `${CLI} receive ${id}` }));
  const recordAttempt = (o, { gateRed = false, doneRed = false } = {}) => {
    if (!o.attempts?.length) return;
    syncAttempts(o, attemptLog);
    o.attempts = AT.recordReceive(o.attempts, {
      sha: gateCheck.record?.tip ?? git(['rev-parse', '--verify', `refs/heads/${branch}`]),
      outcome: AT.receiveOutcome({ status: result?.status ?? null, gateRed, doneRed }),
      evidenceId: gateCheck.record?.evidence_id ?? null,
      now: new Date().toISOString(),
      report: trackFound.report?.path ?? null,
      handover: trackFound.handover?.path ?? null,
    });
  };
  if (gateCheck.status === 'red') {
    // The gate cannot run (lib/gateBroken.js): a missing program on this machine is the owner's, not a fix round.
    const broken = brokenGate(o0, gateCheck);
    const { resolved: brokenResolved = false, ...brokenVerdict } = broken ?? {};
    edit((queue) => {
      const o = queue.tasks.find((x) => x.id === id);
      if (o.status !== 'review') {
        const s = L.setStatus(o, 'review', new Date().toISOString());
        if (s.error) die(s.error);
      }
      if (result) o.result = result;
      o.review_package = folder;
      o.gate_check = gateCheck.record;
      if (trackFound.report) {
        o.report_received = trackFound.report.mtimeMs;
        o.report_seen = Math.max(Number(o.report_seen ?? 0), trackFound.report.mtimeMs);
      }
      o.t_receive ??= new Date().toISOString();
      L.openBlock(o, 'gate-red', { note: `quick gates red at receive (exit ${gateCheck.record.exit ?? '?'})` });
      if (broken) o.gate_broken = brokenVerdict;
      else delete o.gate_broken;
      if (broken && !brokenResolved) {
        // The same setup asks once: the question id carries the setup hash, so a second receive finds it registered.
        if (!queue.question?.[broken.question]) {
          const s = L.setQuestion(queue, require('./lib/gateBroken.js').question(o, brokenVerdict, { cli: CLI }));
          if (s.error.length) die(`Could not register the owner question: ${s.error.join('; ')}`);
        }
        if (!(o.waiting_on ?? []).includes(broken.question)) o.waiting_on = [...(o.waiting_on ?? []), broken.question];
        L.openBlock(o, 'owner-question', {
          note: broken.setup
            ? `the gate cannot run: the clean copy could not be set up (${broken.question})`
            : `the gate cannot run: ${broken.program} not found (${broken.question})`,
        });
      }
      recordAttempt(o, { gateRed: true });
      return o;
    });
    if (!o0.picked_by) pulseCursor(`receive ${id} gates red`);
    if (broken && !brokenResolved && broken.setup) {
      // The clean copy could not be set up (lib/gateClean.js): no gate command ran.
      console.log(
        `GATE CANNOT RUN: ${id}'s gate could not start in a clean copy of the commit (gates.runner clean): ${broken.setup}. ` +
          'A setup problem, so no fix round was started.\n' +
          `Owner question ${broken.question} registered (ravenseat question; blocker owner-question). Fix the setup (or list ` +
          `the file in gates.clean.include, or set gates.runner worktree), then ${CLI} receive ${id} again. A fix round ` +
          `anyway: ${CLI} resolve ${broken.question} --answer "…", then ${CLI} receive ${id}. Off: "gates": { "brokenVerdict": false }.`,
      );
      process.exit(8);
    }
    if (broken && !brokenResolved) {
      console.log(
        `GATE CANNOT RUN: ${id}'s quick gate ${broken.commands.map((c) => `\`${c}\``).join(', ')} needs \`${broken.program}\`, ` +
          'which is not found here, on the delivered tip and on the base. A setup problem, so no fix round was started.\n' +
          `Owner question ${broken.question} registered (ravenseat question; blocker owner-question). Install the tool or fix ` +
          `gates.quick, then ${CLI} receive ${id} again (a changed gates setup forgets this verdict). A fix round anyway: ` +
          `${CLI} resolve ${broken.question} --answer "…", then ${CLI} receive ${id}. Off: "gates": { "brokenVerdict": false }.`,
      );
      process.exit(8);
    }
    doneCommandRed(id, gateCheck.check, { scratch, what: 'quick gate run (ravenseat receive, on the delivered tip)' });
  }
  // The done command (lib/doneCheck.js), BEFORE any reviewer is started: a red one is not a delivery but a fix round.
  // A PARTIAL track is known to be unfinished (a context continuation), so the command is not run for it.
  const doneCheck = result?.status === 'PARTIAL' ? null : runDoneCommand(o0, { branch, scratch, step: 'receive' });
  if (doneCheck?.record.tampered)
    die(GB.tamperedMessage({ what: 'the done command', reason: doneCheck.record.tamper_reason, ravenseat: CLI, again: `${CLI} receive ${id}` }));
  if (doneCheck && !doneCheck.ok) {
    edit((queue) => {
      const o = queue.tasks.find((x) => x.id === id);
      if (o.status !== 'review') {
        const s = L.setStatus(o, 'review', new Date().toISOString());
        if (s.error) die(s.error);
      }
      if (result) o.result = result;
      o.review_package = folder;
      if (gateCheck.record) o.gate_check = gateCheck.record;
      o.done_check = doneCheck.record;
      // The report has been read: it is no longer a new delivery (the fix round's report is the next one).
      if (trackFound.report) {
        o.report_received = trackFound.report.mtimeMs;
        o.report_seen = Math.max(Number(o.report_seen ?? 0), trackFound.report.mtimeMs);
      }
      o.t_receive ??= new Date().toISOString();
      L.openBlock(o, 'gate-red', { note: `done command red at receive (exit ${doneCheck.run.exit ?? '?'})` });
      recordAttempt(o, { doneRed: true });
      return o;
    });
    if (!o0.picked_by) pulseCursor(`receive ${id} done command red`);
    doneCommandRed(id, doneCheck, { scratch });
  }
  return { gateCheck, recordAttempt, doneCheck };
}

/**
 * Red on base (lib/redOnBase.js, gates.redOnBase): the track's new or changed test files must pass on the tip and at
 * least one must fail with the track's code change taken away. Runs in the track's worktree and puts it back. Returns
 * null when the setting is off, else the record for the task (red_on_base). Never stops receive.
 */
export function redOnBaseCheck(o, { branch }) {
  const RB = require('./lib/redOnBase.js');
  const DC = require('./lib/doneCheck.js');
  const set = RB.setup(CONFIG.gates);
  if (!set) return null;
  const at = new Date().toISOString();
  const tip = git(['rev-parse', '--verify', `refs/heads/${branch}`]);
  const fail = (reason) => ({ verdict: 'error', reason, command: set.command, tip, at, files: [], skipped: [] });
  const cwd = val('--done-cwd') ? path.resolve(val('--done-cwd')) : DC.worktreeFor(git(['worktree', 'list', '--porcelain']), branch);
  if (!cwd || !fs.existsSync(cwd)) return fail(`no worktree has ${branch} checked out`);
  const g = (args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 1 << 26 });
  if ((g(['rev-parse', 'HEAD']).stdout ?? '').trim() !== tip) return fail(`${cwd} is not at the tip of ${branch}`);
  if ((g(['status', '--porcelain', '--untracked-files=no']).stdout ?? '').trim()) return fail(`${cwd} has uncommitted changes`);
  const mb = (git(['merge-base', BASE, branch]) ?? '').trim();
  if (!mb) return fail(`no merge base between ${BASE} and ${branch}`);
  const { tests, code, unsafe } = RB.split(gitLarge(['diff', '--name-status', '--no-renames', `${mb}..${branch}`]), CONFIG.testWeakening?.testPaths ?? []);
  const run = (files) =>
    DC.runDoneWhen({
      command: RB.commandFor(set.command, files),
      cwd,
      timeoutSec: set.timeoutSec,
      tailLines: 1,
      processGuard: { cfg: CONFIG, folder: FOLDER, kind: 'done', track: o.id }, // register, track tag, priority (lib/processGuard.js)
    });
  const record = (extra) => ({ command: set.command, tip, at, ...extra });
  if (!tests.length) return record({ verdict: 'no-tests', codeChanged: code.length > 0, files: [], skipped: unsafe });
  const tipRun = run(tests);
  if (!tipRun.ok) return record({ verdict: 'tip-red', files: tests.map((p) => ({ path: p, base: 'not run' })), skipped: unsafe });
  if (!code.length) return record({ verdict: 'tests-only', files: tests.map((p) => ({ path: p, base: 'not run' })), skipped: unsafe });
  const picked = tests.slice(0, set.maxFiles);
  const base = [];
  let reason = null;
  try {
    // The change taken away: what the track changed or deleted gets its merge-base version, what it added goes.
    const back = code.filter((c) => c.status !== 'A').map((c) => c.path);
    for (let i = 0; i < back.length; i += 50) {
      const r = g(['checkout', mb, '--', ...back.slice(i, i + 50)]);
      if (r.status !== 0) throw new Error(`git checkout of the base version failed: ${(r.stderr ?? '').trim().split('\n')[0]}`);
    }
    for (const c of code.filter((x) => x.status === 'A')) fs.rmSync(path.join(cwd, ...c.path.split('/')), { force: true });
    for (const p of picked) base.push({ path: p, ok: run([p]).ok });
  } catch (e) {
    reason = e.message;
  } finally {
    // Back to the tip: receive checked the worktree was clean there, so this undoes only the check's own changes.
    g(['reset', '-q', '--hard', 'HEAD']);
    // A checkout ran here (paths only, but the rule is simple): the path answers kept for this process go (lib/gitFacts.js).
    require('./lib/gitFacts.js').invalidate();
  }
  const head = (g(['rev-parse', 'HEAD']).stdout ?? '').trim();
  const dirty = (g(['status', '--porcelain', '--untracked-files=no']).stdout ?? '').trim();
  if (head !== tip || dirty) return fail(`${cwd} could not be put back to ${String(tip).slice(0, 12)}: look at it before anything else (git status)`);
  if (reason) return fail(reason);
  const verdict = RB.verdict({ tests, code, tip: tipRun, base });
  return record({
    verdict,
    files: base.map((b) => ({ path: b.path, base: b.ok ? 'green' : 'red' })),
    skipped: [...tests.slice(set.maxFiles), ...unsafe],
  });
}

// ---- The secret scan at receive (H5, lib/secretScan.js scanRange) ---------------------------------------------------

/**
 * The track's own commits (<baseBranch>..<branch>, every commit, so a key added and deleted again still counts), with
 * the push check's patterns, exceptions and time limit. WHY here and not only at push: once merged, a key is in the base
 * branch's history; caught now, the track can take it out of its own branch and the base stays clean.
 * Returns null unless secretScan.atReceive is true (off by default, lib/optInChecks.js), else { hits, scanner, incomplete? } (never the matched text).
 */
export function receiveSecretScan(branch) {
  if (CONFIG.secretScan?.atReceive !== true) return null;
  const SS = require('./lib/secretScan.js');
  return SS.scanRange({ cwd: GIT_ROOT, from: `refs/heads/${BASE}`, to: `refs/heads/${branch}`, setup: CONFIG.secretScan });
}

/** One hit as file:line (rule) in <commit>: never the value. */
export const secretWhere = (h) => `${h.file}:${h.line} (${h.rule})${h.commit ? ` in ${h.commit}` : ''}`;

/** The receive lines for the scan: a warning when it did not finish, the SECRET line on hits, nothing when clean or off. */
export function secretScanLines(id, scan) {
  if (!scan) return [];
  const out = [];
  if (scan.incomplete)
    out.push(
      `WARNING: the secret scan at receive did not finish (${scan.incomplete}), so nothing is blocked on it. ` +
        `Look at ${id}'s diff for keys yourself; the push check scans again before the push.`,
    );
  if (scan.hits?.length) {
    const shown = scan.hits.slice(0, 5).map(secretWhere).join(', ');
    out.push(
      `SECRET: possible secret(s) in ${id}'s commits (${scan.scanner} scan): ${shown}${scan.hits.length > 5 ? ` and ${scan.hits.length - 5} more` : ''}. ` +
        `The merge stops on it (block secret-found). Every commit counts, so a fix round takes it out of the branch's history ` +
        `(rewrite the commits that added it), and a real key must be changed. A false alarm: ${CLI} merge ${id} --allow-secret (owner only, logged).`,
    );
  }
  return out;
}

/** The code files V1 looks up on the base (lib/scopeNotes.js reads JS/TS only). */
const SCOPE_CODE = ['*.js', '*.cjs', '*.mjs', '*.jsx', '*.ts', '*.cts', '*.mts', '*.tsx'];

/**
 * The reuse and scope facts for a delivery (lib/scopeNotes.js): { lines, section }. The look-ups run here against the
 * merge base (`base`) and the branch: `git grep -n -w` for a name, `git ls-tree -d` for the folders, `git show` for a
 * manifest. Everything is read, nothing runs from the track. A failure gives one NOTE line and no section; receive
 * goes on.
 */
export function scopeNotesFor(o, { branch, base, diff, changedNames, all = false }) {
  const SN = require('./lib/scopeNotes.js');
  const setup = SN.setupOf(CONFIG);
  try {
    let dirs = null;
    const io = {
      // One git grep for all names (an -e per name): a process per name took seconds on Windows.
      findDefinitions: (names) => {
        if (!base || !names.length) return [];
        const out = gitLarge(['grep', '-n', '-w', '-I', '-F', ...names.flatMap((n) => ['-e', n]), base, '--', ...SCOPE_CODE]);
        const rows = [];
        for (const l of String(out ?? '').split(/\r?\n/)) {
          const m = (l.startsWith(`${base}:`) ? l.slice(base.length + 1) : l).match(/^(.*?):(\d+):(.*)$/);
          if (m) rows.push({ file: m[1], line: Number(m[2]), text: m[3] });
        }
        return rows;
      },
      dirExists: (d) => {
        if (!base) return true;
        dirs ??= new Set(String(gitLarge(['ls-tree', '-r', '-d', '--name-only', base]) ?? '').split(/\r?\n/).filter(Boolean));
        return dirs.has(d);
      },
      readFile: (side, p) => {
        const rev = side === 'base' ? base : branch;
        if (!rev) return null;
        // null only when the path is not in the commit; a git failure throws (lib/gitShow.js), and scopeNotes skips
        // that part with a line in its errors instead of reading the file as missing.
        const t = gitShowAt(rev, p);
        return t == null ? null : String(t);
      },
    };
    // The catalog's stack entries (roadmap 0å KD-2): a dependency note names the one an added package goes against, and
    // an accepted one gives a CATALOG line. A catalog that cannot be read gives the notes as before.
    let choices = [];
    try {
      choices = setup.dependencies ? stackChoicesNow() : [];
    } catch {
      choices = []; // error-ignored: the notes are facts for the reviewer; without the catalog they are as before
    }
    const r = SN.assess({ diff, changedPaths: changedNames, task: o, setup, io, migrations: CONFIG.migrations ?? null, choices });
    return { lines: SN.receiveLines(r, { id: o.id, cli: CLI, all }), section: SN.packageSection(r) };
  } catch (e) {
    return { lines: [`NOTE scope notes (${o.id}): could not be made (${e?.message ?? e}); nothing is blocked on it.`], section: null };
  }
}

/**
 * The check rules of the design choices on a diff (lib/catalogChecks.js through cli/catalog.mjs catalogRules), or null
 * when there is nothing to try. A read error gives one NOTE line in `lines` and no result: receive and merge go on.
 */
export function catalogRulesFor(id, diff) {
  try {
    return { result: catalogRules(diff), lines: [] };
  } catch (e) {
    return { result: null, lines: [`NOTE catalog rules (${id}): could not be tried (${e?.message ?? e}); nothing is blocked on it.`] };
  }
}

/** The names the delivery's added lines define (lib/scopeNotes.js newNames), for the near names (V1b); [] on any error. */
export function reviewNewNames(diff) {
  try {
    const SN = require('./lib/scopeNotes.js');
    return SN.newNames(SN.parseDiff(diff), { ignoreNames: SN.setupOf(CONFIG).ignoreNames });
  } catch {
    return []; // error-ignored: the near names are context for the reviewer, nothing waits on them
  }
}

/**
 * The receive lines for the main tree's control files that changed since the fingerprint `before` (lib/controlFiles.js),
 * leaving out a file that is tracked and clean now: it came in through a commit (another track's merge), which git log
 * shows. Never throws: the check is a warning.
 */
export function controlFileLines(id, before, others = []) {
  try {
    const CF = require('./lib/controlFiles.js');
    const where = controlWhere();
    const changes = CF.compare(before, CF.fingerprint(where));
    if (!changes.length) return [];
    // The names git can know: relative to the main tree, not in .git, and the scripts folder when it lies in the tree.
    const rel = path.relative(where.mainTree, where.scriptsDir).replace(/\\/g, '/');
    const scriptsRel = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : null;
    const asGit = (name) => (name === CF.SCRIPTS_KEY ? scriptsRel : name.startsWith('.git/') ? null : name);
    const names = changes.map((c) => asGit(c.name)).filter(Boolean);
    const committed = new Set();
    if (names.length) {
      const tracked = new Set(String(git(['ls-files', '--', ...names]) ?? '').split(/\r?\n/).filter(Boolean));
      const dirty = String(git(['status', '--porcelain', '--untracked-files=all', '--', ...names]) ?? '')
        .split(/\r?\n/)
        .filter(Boolean)
        .map((l) => l.slice(3).replace(/^"|"$/g, ''));
      for (const c of changes) {
        const g = asGit(c.name);
        if (!g) continue;
        const isTracked = g === scriptsRel ? [...tracked].some((t) => t.startsWith(`${g}/`)) : tracked.has(g);
        const isDirty = dirty.some((d) => d === g || d.startsWith(`${g}/`));
        if (isTracked && !isDirty && c.change !== 'removed') committed.add(c.name);
      }
    }
    const kept = CF.unexplained(changes, { committed });
    if (kept.length) logTime(id, 'control-files-changed', `${kept.length} file(s)`);
    return CF.warningLines(id, kept, { root: where.mainTree, others });
  } catch {
    return []; // error-ignored: the fingerprint is a warning; receive goes on
  }
}

/**
 * The weakened settings no setting-weakened row explains (lib/guardLog.js outsideCli), each logged once as
 * config-changed-outside-cli, as lines. `where` names the command that found it. Never throws.
 */
export function outsideCliLines(where) {
  try {
    const GL = require('./lib/guardLog.js');
    const SV = require('./lib/settingsView.js');
    const queue = fs.existsSync(path.join(FOLDER, 'queue.json')) ? read() : { tasks: [] };
    const view = SV.settingsView({ config: CONFIG, queue, migrations: !!CONFIG.migrations?.folder });
    const weakened = view.categories.flatMap((c) => c.rows).filter((r) => r.weakened).map((r) => ({ key: r.key, value: r.value }));
    if (!weakened.length) return [];
    const keys = GL.outsideCli(weakened, readTimeLog());
    if (!keys.length) return [];
    const TA = require('./lib/timeLogArchive.js');
    for (const key of keys)
      TA.appendText(TIME_LOG, `${JSON.stringify(GL.outsideCliRow(key, weakened.find((w) => w.key === key).value, { where }))}\n`);
    return [
      `CONFIG CHANGED OUTSIDE THE CLI: ${keys.join(', ')} ${keys.length === 1 ? 'is' : 'are'} weakened with no setting-weakened row ` +
        `(queue.config.json was edited by hand or by an agent). Logged as config-changed-outside-cli. If you did not do it, ` +
        `look at queue.config.json; ${CLI} settings set <key> <value> --i-understand --by owner is the way that logs it.`,
    ];
  } catch {
    return []; // error-ignored: a check, never a stop
  }
}
