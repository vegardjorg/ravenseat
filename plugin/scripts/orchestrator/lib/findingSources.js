// =============================================================
// findingSources.js: what each existing source writes to the finding log (lib/findingLog.js) when it catches a failure
// (step 4 of the finding format contract, plans/funnformat-0i-0j-2026-11-15.md section 6).
//
// Why: the gates, CI, the base gate, the done command, red on base, the secret scan, the GATE line, `ravenseat finding`
// and the fix links each kept what they caught in their own place (the time log, a task field, the plan register). A
// class that keeps coming back could not be seen across them. Each source now also writes one row in the same form, so
// later steps (classification, repeats, guards) read one log.
//
// The rules every source follows:
//   - one row per failure the source already detected; no source runs anything extra for the log (no git, no network);
//   - `class` is the class the line gave (the GATE line), else `other`; the rule class (lib/failureRules.js, step 5) is
//     set by findingLog.append from `rule_hints`: what the source already saw (an event, the red command), never a new
//     run. The hints are read there and never stored;
//   - the excerpt is built from what the source already kept (the normalized first error line, a verdict, rule names),
//     never raw output or a secret's value, and findingLog.makeRow masks and caps it once more;
//   - writing is passive: no output on success, at most one WARNING line when a write fails, and never a stop (record).
// The severity per source is fixed here (SEVERITY), as data the later steps can read: a red base or a secret is H, a
// flaky command or an unproven test is L (logged, not counted), the rest M.
//
// The builders are pure and return finding log inputs (or [] / null when there is nothing to log); record() is the only
// part with I/O. Used by: gates.mjs, cli/ciWatch.mjs, cli/baseHealth.mjs, cli/merge.mjs, cli/finding.mjs, cli/tasks.mjs,
// cli/taskEdit.mjs, cli/owner.mjs. Tested in lib/__tests__/findingSources.test.ts.
// =============================================================
'use strict';

const FS = require('./failureSignature.js');

/** The severity each source logs with (see the header). */
const SEVERITY = Object.freeze({
  gate: 'M',
  flaky: 'L',
  ci: 'M',
  baseGate: 'H',
  doneCheck: 'M',
  tampered: 'H',
  redOnBaseTipRed: 'M',
  redOnBaseUnproven: 'L',
  secret: 'H',
  gateLine: 'M',
  finding: 'M',
  fixes: 'M',
  qa: 'M',
});

/** How long a source waits for another writer's lock: short, so a busy log never slows a gate down. */
const WAIT_MS = 2000;

const str = (v) => (typeof v === 'string' ? v.trim() : '');

/** A place `file:line` (or `file`) as { files, line }. */
function place(where) {
  const s = str(where);
  if (!s) return { files: [], line: null };
  const m = /^(.*?):(\d+)$/.exec(s);
  return m ? { files: [m[1]], line: Number(m[2]) } : { files: [s], line: null };
}

/** The rows for one red `gate` row of the time log: one per red command, with the inspection queue's signature. */
function fromGateRow(row) {
  return FS.fromGateRow(row).map((o) => ({
    caught_by: 'gate',
    severity: SEVERITY.gate,
    class: 'other',
    signature: o.id,
    excerpt: o.excerpt ? `${o.name}: ${o.excerpt}` : `${o.name}: red`,
    task: o.task,
    rule_hints: { command: o.name },
  }));
}

/** The rows for one `flakyGate` row: one per command. The base gate's runs are `base-gate`, a track's are `gate`. */
function fromFlakyRow(row) {
  if (row?.event !== 'flakyGate' || !Array.isArray(row.commands)) return [];
  const base = /^(base gate|quick gates after a merge)/.test(str(row.source));
  return row.commands
    .filter((c) => str(c))
    .map((c) => ({
      caught_by: base ? 'base-gate' : 'gate',
      severity: SEVERITY.flaky,
      class: 'other',
      excerpt: `flaky: ${str(c)} was red, then green on a rerun on the same commit`,
      task: row.task ?? null,
      rule_hints: { event: 'flaky', command: str(c) },
    }));
}

/**
 * The rows for one `ciWatch` row: one per failed job, only for the verdict `check` (a failed check). An infrastructure
 * failure is no defect in the code, so it is not logged.
 */
function fromCiRow(row) {
  if (row?.event !== 'ciWatch' || row.verdict !== 'check') return [];
  return FS.fromCiRow(row).map((o) => ({
    caught_by: 'ci',
    severity: SEVERITY.ci,
    class: 'other',
    signature: o.id,
    excerpt: o.excerpt ? `${o.name}: ${o.excerpt}` : `${o.name}: red`,
    task: row.task ?? null,
    // The job name ("ci: <workflow> / <job> / <step>") is what CI says about the command; its kind is read from it.
    rule_hints: { command: o.name },
  }));
}

/** The rows for a time log row the gates, CI or the flaky check wrote ([] for every other row). */
function fromTimeRow(row) {
  if (row?.event === 'gate') return fromGateRow(row);
  if (row?.event === 'flakyGate') return fromFlakyRow(row);
  if (row?.event === 'ciWatch') return fromCiRow(row);
  return [];
}

/**
 * The row for a red base that got a new base fix task (BASE-fiks). `run` is the base gate run (failed, tail, timedOut);
 * the excerpt and the signature are built as for a track gate, from the tail the base gate already kept.
 * @param {{ run: object|null, causeId?: string|null, madeRedBy?: { task?: string }|null }} x
 */
function baseFix({ run, causeId = null, madeRedBy = null }) {
  const command = str(run?.failed) || 'base gate';
  const excerpt = FS.gateExcerpt({ command, output: (run?.tail ?? []).join('\n'), timedOut: !!run?.timedOut });
  return {
    caught_by: 'base-gate',
    severity: SEVERITY.baseGate,
    class: 'other',
    signature: FS.signatureId(command, excerpt),
    excerpt: excerpt ? `${command}: ${excerpt}` : `${command}: red`,
    task: causeId ?? madeRedBy?.task ?? null,
    cause_task: madeRedBy?.task ?? null,
    rule_hints: { command },
  };
}

/**
 * The row for a red done command (done_when) at receive or merge, or null when it was green. A tampered run is H: the
 * command changed the git hooks or the config.
 * @param {{ id: string, command: string, run: object, tamperReason?: string|null }} x
 */
function doneCheck({ id, command, run, tamperReason = null }) {
  if (run?.ok) return null;
  if (tamperReason) {
    return { caught_by: 'done-check', severity: SEVERITY.tampered, class: 'other', excerpt: `tampered: ${tamperReason}`, task: id };
  }
  const excerpt = FS.gateExcerpt({ command, output: (run?.tail ?? []).join('\n'), timedOut: !!run?.timedOut });
  return {
    caught_by: 'done-check',
    severity: SEVERITY.doneCheck,
    class: 'other',
    excerpt: excerpt ? `done command: ${excerpt}` : 'done command: red',
    task: id,
    rule_hints: { command },
  };
}

/** The row for the red on base verdict on a task (red_on_base), or null: only `unproven` and `tip-red` are failures. */
function redOnBase({ id, record }) {
  const v = record?.verdict;
  if (v !== 'unproven' && v !== 'tip-red') return null;
  const files = (record.files ?? []).map((f) => f?.path).filter(Boolean);
  return {
    caught_by: 'red-on-base',
    severity: v === 'unproven' ? SEVERITY.redOnBaseUnproven : SEVERITY.redOnBaseTipRed,
    class: 'other',
    excerpt:
      v === 'unproven'
        ? 'red on base: unproven, the new tests pass without the change'
        : 'red on base: tip-red, the new tests are red on the delivered tip',
    files,
    test_added: files[0] ?? null,
    task: id,
    // unproven: the new tests pass without the change, so they prove nothing (a weak test). tip-red names no class.
    rule_hints: v === 'unproven' ? { event: 'unproven' } : {},
  };
}

/**
 * The row for the secret scan's hits at receive (secret_found), or null. Only the paths, the line of a single hit and
 * the rule names: never a matched value.
 */
function secretFound({ id, found }) {
  const hits = Array.isArray(found?.hits) ? found.hits : [];
  if (!hits.length) return null;
  const files = [...new Set(hits.map((h) => h?.file).filter(Boolean))];
  const rules = [...new Set(hits.map((h) => str(h?.rule)).filter(Boolean))].slice(0, 5);
  const count = Number.isInteger(found.count) ? found.count : hits.length;
  return {
    caught_by: 'secret-scan',
    severity: SEVERITY.secret,
    class: 'other',
    excerpt: `${count} secret hit(s) at receive${rules.length ? ` (rules: ${rules.join(', ')})` : ''}`,
    files,
    line: hits.length === 1 && Number.isInteger(hits[0].line) && hits[0].line > 0 ? hits[0].line : null,
    task: id,
    rule_hints: { event: 'secret' },
  };
}

/** The row for a GATE line at receive (lib/knownBugGate.js parseGate): the class the line gave, the place, the sentence. */
function gateLine({ id, gate }) {
  if (!gate) return null;
  const p = place(gate.where);
  return {
    caught_by: 'gate-line',
    severity: SEVERITY.gateLine,
    class: str(gate.class) || 'other',
    class_source: 'agent',
    excerpt: str(gate.text) || str(gate.title) || 'a known bug the track fixed',
    files: p.files,
    line: p.line,
    task: id,
  };
}

/** The row for `ravenseat finding` (an idea in the plan register): the title as the excerpt, the files and the cause. */
function finding({ title, task = null, files = [], causes = [] }) {
  return {
    caught_by: 'finding',
    severity: SEVERITY.finding,
    class: 'other',
    class_source: 'agent',
    excerpt: str(title) || 'a finding outside the scope',
    files: Array.isArray(files) ? files : [],
    task,
    cause_task: Array.isArray(causes) && causes.length ? causes[0] : null,
  };
}

/**
 * The rows for a fix task that names the task(s) it fixes (`fixes`): one per fixed task, a defect after merge. The
 * excerpt is built from the ids only: a title is free text the log does not need.
 * @param {{ id: string, fixes: string[] }} x
 */
function fixLinks({ id, fixes }) {
  return (Array.isArray(fixes) ? fixes : [])
    .filter((c) => str(c) && c !== id)
    .map((c) => ({
      caught_by: 'post-merge',
      severity: SEVERITY.fixes,
      class: 'other',
      excerpt: `fix task ${id} fixes ${c}, a defect after merge`,
      task: id,
      cause_task: c,
    }));
}

/** The row for a QA deviation (`qa deviation`, which adds the fix task <id>-QA<n> with fixes = [id]). Ids only. */
function qaDeviation({ id, fixId }) {
  return {
    caught_by: 'qa',
    severity: SEVERITY.qa,
    class: 'other',
    excerpt: `QA deviation on ${id}, fix task ${fixId}`,
    task: fixId,
    cause_task: id,
  };
}

/** The key that makes two rows the same report: the source, the task, the places and the (cleaned) excerpt. */
const sameKey = (r) => JSON.stringify([r.caught_by, r.task, r.where?.files ?? [], r.where?.line ?? null, r.excerpt]);

/**
 * The inputs the log does not have yet (`once`). For what is read again from the same report or task (the GATE line,
 * red on base, the secret hits at a second receive of the same delivery): one report is one finding, however often
 * receive runs. A gate or done command that runs again is a new run, so those sources never pass `once`.
 */
function notSeen(root, list) {
  const FLOG = require('./findingLog.js');
  const seen = new Set(FLOG.read(root).rows.map(sameKey));
  return list.filter((x) => {
    try {
      return !seen.has(sameKey(FLOG.makeRow(x)));
    } catch {
      return true; // invalid: append refuses it and the caller gets the warning
    }
  });
}

/**
 * Writes the rows. Never throws and never stops the caller: a failed build or write gives at most one WARNING line
 * (through `warn`), and nothing on success. `inputs` may be a function, so an error while building is caught too.
 * @param {object|object[]|(() => object|object[])} inputs
 * @param {{ root?: string|null, warn?: (line: string) => void, append?: Function, waitMs?: number, once?: boolean }} [o]
 * @returns {{ written: number, failed: number }}
 */
function record(inputs, { root = null, warn = (l) => console.log(l), append = null, waitMs = WAIT_MS, once = false } = {}) {
  let list;
  let firstError = null;
  try {
    list = [].concat((typeof inputs === 'function' ? inputs() : inputs) ?? []).filter(Boolean);
  } catch (e) {
    list = [];
    firstError = e;
  }
  let written = 0;
  let failed = firstError ? 1 : 0;
  if (list.length && once) {
    try {
      list = notSeen(root, list);
    } catch {
      // error-ignored: an unreadable log is no reason to skip the row; append says what is wrong with the file
    }
  }
  if (list.length) {
    // Loaded only when there is something to write, so a green run never touches the log module.
    const write = append ?? require('./findingLog.js').append;
    for (const x of list) {
      try {
        write(root, x, { waitMs });
        written += 1;
      } catch (e) {
        failed += 1;
        firstError ??= e;
      }
    }
  }
  if (failed) {
    try {
      const why = String(firstError?.message ?? firstError ?? 'unknown error').slice(0, 160);
      warn(`WARNING: the finding log did not get ${failed} row(s) (${why}); nothing else changed.`);
    } catch {
      // error-ignored: the warning is the most the log may cost the caller
    }
  }
  return { written, failed };
}

module.exports = {
  SEVERITY,
  WAIT_MS,
  fromGateRow,
  fromFlakyRow,
  fromCiRow,
  fromTimeRow,
  baseFix,
  doneCheck,
  redOnBase,
  secretFound,
  gateLine,
  finding,
  fixLinks,
  qaDeviation,
  record,
};
