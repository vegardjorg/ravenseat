// =============================================================
// trackFlaky.js: the flaky check on a track's gate (config().gates.flakyRerun, default true), the same model as the base
// gate's flaky check (lib/baseHealth.js, "The flaky check").
//
// Why: one flaky red on a track's quick gate cost a whole fix round, with a new agent, while nothing was wrong with the
// code. The base gate already reran its failed commands once before it froze the base; a track's gate had nothing.
//
// The flow (the I/O lives in gates.mjs and cli/merge.mjs receiveGates):
//   - gates.mjs --quick/--full runs every gate command. When some were red, ONLY those run once more, on the same commit
//     (rerunPlan): never in the main checkout (a run there is the merge step's or the push's, and the base gate has its
//     own flaky check, baseGate.flakyRerun), never without a known commit and never on a tree with uncommitted tracked
//     changes (a green rerun must be bound to the commit). At most one rerun per gate run: there is no loop.
//   - The outcome (outcome, with lib/baseHealth.js flakyResult): green on the rerun, with HEAD still on the same commit
//     and the tree still clean, is a green run with `flaky` = the commands that were red the first time. The gate row in
//     the time log and the evidence entry (lib/gateEvidence.js) carry `flaky`, and a `flakyGate` row with the track's id
//     goes to the time log (ravenseat cost Flow counts them). Red again, or a moved HEAD or a dirty tree after the rerun:
//     red as before.
//   - ravenseat receive reads `flaky` from the trusted evidence entry for the delivered tip, keeps it in gate_check
//     (`flaky`, and `flaky_times`: how often each command has been flaky on this track, this time included), files a
//     finding per command (the same title as the base gate's, so it is deduplicated on the command and its count goes up)
//     and prints the FLAKY line (summaryLines). The review package gets a section (packageSection). A command that was
//     flaky on the same track before still counts as green: the count says so instead.
//   - The tamper checks (the evidence store and the git surface) cover the rerun too: they compare after the last
//     command, so a rerun can never turn a tampered run green.
//
// Pure; tested in lib/__tests__/trackFlaky.test.ts and __tests__/trackFlakyGate.test.ts.
// =============================================================
'use strict';

const BH = require('./baseHealth.js');

const commandList = (v) => (Array.isArray(v) ? v.filter((g) => typeof g === 'string' && g.trim()).map((g) => g.trim()) : []);
const short = (sha) => String(sha ?? '').slice(0, 12);
const times = (n) => `${n} time${n === 1 ? '' : 's'}`;

/** The switch: gates.flakyRerun, on unless it is false. */
function setup(cfg = {}) {
  return { enabled: cfg?.gates?.flakyRerun !== false };
}

/**
 * Which commands a red run may run once more: the red ones, each once, in their order. None (with the reason) when the
 * switch is off, in the main checkout, without a known commit or when the tree had uncommitted tracked changes at the
 * start. Nothing red: nothing to rerun and no reason.
 * @param {{ enabled: boolean, mainTree: boolean|null, failed: string[], startSha: string|null, startClean: boolean|undefined }} x
 * @returns {{ commands: string[], reason: string|null }}
 */
function rerunPlan({ enabled, mainTree, failed, startSha, startClean }) {
  const red = [...new Set(commandList(failed))];
  if (!red.length) return { commands: [], reason: null };
  if (!enabled) return { commands: [], reason: 'gates.flakyRerun is false' };
  if (mainTree === true)
    return { commands: [], reason: "a run in the main checkout is the base gate's to rerun (baseGate.flakyRerun)" };
  if (!startSha) return { commands: [], reason: 'the commit the run checked is not known' };
  if (startClean !== true)
    return { commands: [], reason: 'the tree has uncommitted tracked changes, so a green rerun would not be bound to the commit' };
  return { commands: red, reason: null };
}

/**
 * The outcome of the rerun. `first`: the first run's red commands and duration; `rerun`: the commands still red on the
 * rerun and its duration; `after`: HEAD and the cleanliness after the rerun. Green only when nothing is red any more AND
 * HEAD is still `startSha` AND the tree is clean. Uses lib/baseHealth.js flakyResult for the verdict.
 * @returns {{ ok: boolean, flaky?: string[], durationSec: number, reason: string|null }}
 */
function outcome({ first, rerun, startSha, after }) {
  const stillRed = commandList(rerun?.failed);
  let reason = null;
  if (stillRed.length) reason = `red again on the rerun: ${stillRed.join(' ; ')}`;
  else if (!after?.sha || after.sha !== startSha) reason = 'the commit moved during the rerun, so the rerun proves nothing about it';
  else if (after.clean !== true) reason = 'the rerun left uncommitted tracked changes, so it is not bound to the commit';
  const r = BH.flakyResult({
    first: { durationSec: first?.durationSec ?? 0 },
    rerun: { ok: reason === null, failed: stillRed[0] ?? null, exit: reason === null ? 0 : 1, durationSec: rerun?.durationSec ?? 0, tail: [] },
    firstFailed: commandList(first?.failed),
  });
  return { ok: r.ok, ...(r.ok ? { flaky: r.flaky } : {}), durationSec: r.durationSec, reason };
}

/**
 * How many trusted evidence entries (writer orchestrator) of `track` name `command` as flaky. The caller adds the
 * current run when its entry is not in `entries` yet.
 */
function timesOnTrack(entries, { track, command }) {
  return (entries ?? []).filter(
    (e) => e && e.writer === 'orchestrator' && e.track === track && Array.isArray(e.flaky) && e.flaky.includes(command),
  ).length;
}

/** The receive lines: one FLAKY line per command; [] when the record has none. `finding`: the finding id, when filed. */
function summaryLines(id, record, { finding = null } = {}) {
  const list = commandList(record?.flaky);
  return list.map((c) => {
    const n = record?.flaky_times?.[c] ?? 1;
    return (
      `FLAKY ${id}: \`${c}\` was red, then green on a rerun on the same commit ${short(record?.tip)}; counted as green ` +
      `(${times(n)} on this track).${finding ? ` Finding ${finding}.` : ''}`
    );
  });
}

/** The "Flaky gate commands" section of 00-package.md, as lines; [] when nothing was flaky. */
function packageSection(record) {
  const list = commandList(record?.flaky);
  if (!list.length) return [];
  return [
    '',
    '## Flaky gate commands',
    '',
    `The quick gates were green on ${short(record?.tip)} only after a rerun on the same commit:`,
    ...list.map((c) => `- \`${c}\`: red, then green on a rerun (${times(record?.flaky_times?.[c] ?? 1)} on this track)`),
    '',
    'A flaky command can hide a real race or an order dependency. Check that the change does not touch what it tests.',
  ];
}

module.exports = { setup, rerunPlan, outcome, timesOnTrack, summaryLines, packageSection };
