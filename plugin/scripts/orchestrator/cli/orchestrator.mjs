// =============================================================
// cli/orchestrator.mjs: the orchestrator's session commands: compact, orchestrator (the pulse), handover and follow.
//
// compact (the compaction mode), orchestrator (is one active, the pulse with the delivery warning and the auto-accept),
// handover (the two-part handover note, lib/queueHandover.js) and follow (the "Follow up" entries and their reports,
// lib/queueFollow.js). followLines is also printed by show.
//
// Why a module: queue.mjs was one file of about 6,300 lines. It is now a thin entry point (the usage comment and the
// dispatch on the command word) plus the modules in cli/. The code was moved as it was: same output, exit codes and files.
//
// Used by: queue.mjs (dispatch), cli/view.mjs (followLines).
// Tested in: lib/__tests__/queueOrchestrator.test.ts, queueFollow.test.ts, queueHandover.test.ts, contextGuard.test.ts, costGuard.test.ts.
// =============================================================

import fs from 'node:fs';
import path from 'node:path';

import {
  a, autoAcceptIn, autoAcceptRules, CONFIG, CQ, CURSOR, cut, die, edit, F, FOLDER, FOLLOW_FILE, FOLLOW_REPORTS, HO, KK,
  KV, L, missionRef, parallelWarning, positional, pulseCursor, read, readCursor, val, values, WIDTH, withLock, write,
} from './context.mjs';
import { deliveryWarning, findSilent, findWithoutAgent } from './tracks.mjs';
import { findingsLineNow } from './finding.mjs';
import { baseHealthLine } from './baseHealth.mjs';
import { conflictLinesNow } from './conflicts.mjs';

// ---- queue.mjs handover: the ongoing note in two parts ---------------------------------------------------------
/**
 * `handover archive [--dry]` and `handover now`. The orchestrator edits the note by hand (not under the queue lock), so
 * the write is atomic (tmp + rename), and the archive is written BEFORE the note: if the call crashes midway, the lines
 * are in both files (never in neither). The rules live in lib/queueHandover.js.
 */
export function handoverCommand() {
  const sub = a[1];
  const note = path.join(FOLDER, 'handover-ongoing.md');
  const archiveFolder = path.join(FOLDER, 'handover-archive');
  if (sub !== 'archive' && sub !== 'now') die('Use: cq handover <archive [--dry]|now>');
  let text = '';
  try {
    text = fs.readFileSync(note, 'utf8');
  } catch {
    die(`Could not find ${note}`);
  }
  if (sub === 'now') {
    const part = HO.nowPart(text);
    if (part === null) die('The note has no "## Now" section.');
    console.log(part);
    return;
  }
  const dry = a.includes('--dry');
  const now = new Date();
  const r = HO.archive(text, now);
  const months = Object.keys(r.archive).sort();
  if (!dry && r.moved > 0) {
    fs.mkdirSync(archiveFolder, { recursive: true });
    for (const m of months)
      fs.appendFileSync(path.join(archiveFolder, `${m}.md`), HO.archiveAddition(r.archive[m], now));
    const tmp = `${note}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, r.keep);
    fs.renameSync(tmp, note);
  }
  const before = text.replace(/\r\n/g, '\n').split('\n').length;
  const after = r.keep.split('\n').length;
  console.log(
    `${dry ? '(dry run, nothing written) ' : ''}handover archive: ${r.moved} entries ` +
      `(${r.movedLines} lines) ${dry ? 'would be moved' : 'moved'}` +
      (months.length ? ` to handover-archive/${months.map((m) => `${m}.md`).join(', ')}` : '') +
      `; the note ${before} -> ${after} lines; "Now" ${r.nowLines ?? '-'} lines (limit ${HO.NOW_MAX_LINES}).`,
  );
  for (const w of r.warnings) console.log(`WARNING: ${w}`);
}
// ---- queue.mjs follow: the "Follow up" entries in <dataFolder>/follow.json under the queue's lock ------------------
// (FOLLOW_FILE and FOLLOW_REPORTS are defined at the top with the other paths: the dispatch above runs before this line.)
function readFollow() {
  if (!fs.existsSync(FOLLOW_FILE)) return F.emptyRegister();
  return F.normalize(JSON.parse(fs.readFileSync(FOLLOW_FILE, 'utf8')));
}
function writeFollow(reg) {
  reg.changed = new Date().toISOString();
  const tmp = `${FOLLOW_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2) + '\n');
  fs.renameSync(tmp, FOLLOW_FILE);
}
/**
 * Changes the follow-up register under the queue's lock, ALL OR NOTHING: `fn(reg, today)` gives { error, entry }; an error
 * gives exit 1 and no write. Active entries past their end date are stored as to-report in the same write.
 */
function editFollow(fn) {
  return withLock(() => {
    const reg = readFollow();
    const today = F.dayDate(new Date());
    const answer = fn(reg, today);
    if (answer.error?.length) die(`Nothing changed:\n  ${answer.error.join('\n  ')}`);
    F.updateDue(reg, today);
    writeFollow(reg);
    return answer;
  });
}
/** The follow-up lines for show and orchestrator pulse. An error (e.g. a broken follow.json) never stops the command. */
export function followLines({ pulse = false } = {}) {
  if (!KK.featureOn('follow', CONFIG)) return []; // the module is off (features.follow)
  try {
    return F.shortLines(readFollow(), F.dayDate(new Date()), { pulse });
  } catch (e) {
    return [`WARNING: could not read ${FOLLOW_FILE} (${e?.message ?? e}); see ${CQ} follow.`];
  }
}
/** The path to the report file, relative to the main tree when it lives there (like the mission field). */
function followReportPath(id) {
  return missionRef(path.join(FOLLOW_REPORTS, `${id}-report.md`));
}
function writeFollowReport(p) {
  fs.mkdirSync(FOLLOW_REPORTS, { recursive: true });
  const file = path.join(FOLLOW_REPORTS, `${p.id}-report.md`);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, F.reportText(p, { now: new Date().toISOString() }));
  fs.renameSync(tmp, file);
  return file;
}
/** `follow [add|log|show|report|close|extend]`; the rules live in lib/queueFollow.js. */
export function followCommand() {
  const [sub, id] = positional(1, ['--file', '--text', '--value', '--source', '--decision', '--to']);
  const now = new Date().toISOString();
  const today = F.dayDate(new Date());
  if (!sub) {
    for (const l of F.listLines(readFollow(), today)) console.log(cut(l, WIDTH));
    return;
  }
  if (sub === 'add') {
    const file = val('--file');
    if (!file) die(`Use: ${CQ} follow add --file <json>`);
    let input;
    try {
      input = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      die(`Could not read ${file}: ${e?.message ?? e}`);
    }
    const s = editFollow((reg) => F.add(reg, input, { now }));
    console.log(
      `Added ${s.entry.id} (${s.entry.start} -> ${s.entry.end}, ${s.entry.goals.length} goal(s)). ` +
        `Log along the way: ${CQ} follow log ${s.entry.id} --text "..." [--value name=x].`,
    );
    return;
  }
  if (!id) die(`Use: ${CQ} follow ${sub} <id> ...`);
  if (sub === 'show') {
    const p = readFollow().entries.find((x) => x.id === id);
    if (!p) die(`Unknown follow-up entry ${id} (${CQ} follow lists them)`);
    for (const l of F.showLines(p, today)) console.log(l);
  } else if (sub === 'log') {
    const measured = {};
    for (const v of values('--value')) {
      const i = v.indexOf('=');
      if (i <= 0) die(`--value "${v}" must be name=value`);
      measured[v.slice(0, i)] = v.slice(i + 1);
    }
    editFollow((reg) =>
      F.log(reg, id, { text: val('--text'), values: measured, source: val('--source') }, { now }),
    );
    console.log(`Logged in ${id}.`);
  } else if (sub === 'report') {
    // The report file is written under the lock, before the register (status reported); if the write fails, nothing changes.
    const s = editFollow((reg) => {
      const p = reg.entries.find((x) => x.id === id);
      if (!p) return { error: [`Unknown follow-up entry ${id} (${CQ} follow lists them)`] };
      const r = F.markReported(reg, id, followReportPath(id), { now });
      if (!r.error.length) writeFollowReport(p);
      return r;
    });
    console.log(
      `The report is written: ${s.entry.report}. Fill in the sections marked "assessed by the orchestrator", present it ` +
        `to the owner, and close it with ${CQ} follow close ${id} --decision "...".`,
    );
  } else if (sub === 'close') {
    const s = editFollow((reg) => {
      const r = F.close(reg, id, { decision: val('--decision'), cancelled: a.includes('--cancelled') }, { now });
      if (!r.error.length) {
        r.entry.report = followReportPath(id);
        r.entry.reported = r.entry.reported ?? now;
        writeFollowReport(r.entry);
      }
      return r;
    });
    console.log(`${id} is closed (${s.entry.status}); the report with the decision: ${s.entry.report}.`);
    if (s.entry.close_action?.length && s.entry.status !== 'cancelled') {
      console.log('Close action (do it only if the decision calls for it; queue.mjs never does it itself):');
      for (const h of s.entry.close_action) console.log(`  ${h}`);
    }
  } else if (sub === 'extend') {
    const s = editFollow((reg) => F.extend(reg, id, val('--to'), { now }));
    console.log(`${id} is extended to ${s.entry.end}.`);
  } else {
    die(
      `Use: ${CQ} follow [add --file <json> | log <id> | show <id> | report <id> | close <id> | extend <id>]`,
    );
  }
}

/** `cq compact` (the usage is at the top of queue.mjs). */
export function cmdCompact() {
  // ---- Compaction mode for the orchestrator session ----
  // The same lock and validation as `limit autocompact`. The Claude Code side (whether the session compacts by itself) is the
  // owner's setting autoCompactEnabled (plus the 300k window); this command only prints the line and never changes settings files.
  const [, fresh] = a;
  if (fresh) {
    edit((queue) => {
      const r = L.parseLimit('autocompact', fresh);
      if ('error' in r) die(`${r.error}. Use: cq compact [auto|manual]`);
      queue.limits = { ...(queue.limits ?? {}), autocompact: r.val };
      return r;
    });
  }
  const mode = KV.compactMode(read());
  console.log(`Compaction mode: ${KV.modeText(mode)}.`);
  console.log(
    mode === 'auto'
      ? `Claude Code must compact by itself at 300k: Auto-compact is on by default; if you turned it off, run ` +
          `${KV.AUTOCOMPACT_ON} in the orchestrator session (once). The hooks report with a fallback line if it does ` +
          'not happen before the wind-down, and resume the queue after the compaction.'
      : `The hooks give a ready /compact line at about 280k. Claude Code's own compaction must then be off, or it ` +
          `compacts at 300k without asking: run ${KV.AUTOCOMPACT_OFF} (terminal), or set ${KV.AUTOCOMPACT_FILE} ` +
          '(desktop app). /compact keeps working.',
  );
}

/** `cq orchestrator` (the usage is at the top of queue.mjs). */
export function cmdOrchestrator() {
  // ---- Orchestrator cursor ----
  const [under] = positional(1, ['--session', '--event']);
  if (under === 'pulse') {
    const m = pulseCursor(val('--event') ?? 'pulse');
    if (!m) die(`Could not write ${CURSOR}.`);
    console.log(
      `Orchestrator marker: "${m.session}", updated ${m.updated} (expires after 2 h without a new pulse).`,
    );
    const by = L.windDownGuard(m);
    if (by.stop)
      console.log(
        `${by.message}\n(The usual path is compaction, which lifts the wind-down. If this is still a NEW session ` +
          `(emergency rotation), run pulse with a --session name other than "${m.session}".)`,
      );
    // Adoption: report.md files that came since the last pulse (an adopted track does not notify this session).
    deliveryWarning({ update: true });
    // Auto-accept (default off): older proposals that fit the owner's rules now. Only written when something is accepted.
    if (autoAcceptRules(read()).enabled) {
      const acc = withLock(() => {
        const queue = read();
        const r = autoAcceptIn(queue);
        if (r.length) write(queue);
        return r;
      });
      for (const x of acc)
        console.log(`Auto-accepted ${x.id} by the owner's rules (${x.reason}); undo: ${CQ} proposals undo ${x.id}`);
    }
    // Tracks fill marked running whose agent was never started (fill run where nobody read the output).
    for (const l of L.withoutAgentLines(findWithoutAgent(read()))) console.log(l);
    // Tracks with an agent worktree but no sign of life for limits.silentMin minutes.
    for (const l of L.silentLines(findSilent(read()))) console.log(l);
    // Follow up: the pulse repeats due entries every time, until the report is written (cq follow report).
    for (const l of followLines({ pulse: true })) console.log(l);
    // Findings the tracks reported outside their scope (cq finding) that nobody has triaged yet.
    const fl = findingsLineNow();
    if (fl) console.log(fl);
    // The base branch's health (lib/baseHealth.js): one line every round, so a red base is never missed.
    const baseLine = baseHealthLine();
    if (baseLine) console.log(baseLine);
    // Predicted merge conflicts between the track tips and the base (lib/conflictPredict.js): cached per sha pair, so
    // a round where no tip moved costs one for-each-ref and no merge-tree.
    for (const l of conflictLinesNow()) console.log(l);
    // The pulse runs every loop round, so low parallelism is checked now and then even without fill and receive.
    parallelWarning();
  } else if (under === 'stop') {
    fs.rmSync(CURSOR, { force: true });
    console.log('The orchestrator cursor is removed: no orchestrator is active.');
  } else if (!under) {
    const s = L.orchestratorStatus(readCursor());
    if (a.includes('--json')) console.log(JSON.stringify(s, null, 2));
    else if (s.active)
      console.log(
        `ACTIVE ORCHESTRATOR: "${s.session}", last updated ${L.ageText(s.age_ms)} ago (${s.event ?? '-'}). ` +
          'Whoever has picked a task delivers: cq deliver <id>.' +
          (L.windDownGuard(readCursor()).stop
            ? ' The session is in WIND_DOWN (no new starts until it is compacted).'
            : ''),
      );
    else
      console.log(
        `NO ACTIVE ORCHESTRATOR (${s.reason}${s.session ? `; last "${s.session}" ${L.ageText(s.age_ms)} ago` : ''}). ` +
          'Whoever has picked a task merges it themselves (the pick skill).',
      );
  } else {
    die('orchestrator [pulse [--session "<name>"] | stop]');
  }
}
