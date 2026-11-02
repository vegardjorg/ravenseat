// =============================================================
// logic/merge.js: fewer orchestrator turns: merge in one call, fill excerpts, concurrent starts and the report cap.
//
// migrSetup, environmentCheck, migrFiles, mergePlan, executeMerge (merge-track, migrations, gates, set done, fill),
// errorExcerpt, fillExcerpt, concurrentBlock ("Start these in the SAME turn") and reportCapWarning.
//
// Part of the queueLogic.js split: lib/queueLogic.js re-exports every name, so callers keep requiring queueLogic.js.
// Used by queueLogic.js (the facade) only.
// Tested in lib/__tests__/queueOrchestrator.test.ts, queueNoAgent.test.ts and queueModels.test.ts (through
// queueLogic.js).
// =============================================================

const { modelPart } = require('./agents.js');

// ---- Fewer orchestrator turns ----
//
// The decisions behind the commands that save orchestrator turns (the I/O lives in queue.mjs):
//   merge <id>        merge-track → (migrationPush, with environment guard) → gates --quick → (base gate) → set done → fill,
//                     in one call
//   info / activeOnes     fixed lookups instead of `node -e`
//   edit --bonus   text for the mission (the track block) and the remarks, with a timestamp
//   next-migr [<n>]  show or set the next migration number; never backward and never down into a used number
//   "Start these in the SAME turn:" after fill and receive, and the report cap (approx. 1,500 characters) for the agents' answers.
// The migration step exists only when config().migrations has both `folder` and `pushCommand`.

/** The cap for the agent's answer to the orchestrator (characters). The long version is in report.md. */
const REPORT_CAP = 1500;

/** The migration setup from config(), or "off" when the config cannot be read (pure tests without config). */
function migrSetup(migrations) {
  if (migrations !== undefined) return migrations ?? { folder: null };
  try {
    return require('../queueConfig.js').config().migrations ?? { folder: null };
  } catch {
    return { folder: null };
  }
}

/**
 * Is the environment the migrations are pushed to an allowed environment? Without `environmentFile` in the setup there is no guard (ok). With
 * `environmentFile` the content must be in `allowedEnvironment`; if the file is missing or empty, `merge` stops before the push.
 * @param {string|null|undefined} environment the content of the environment file (null when the file is missing)
 * @param {{ environmentFile?: string|null, allowedEnvironment?: string[] }} [migrations]
 * @returns {{ ok: boolean, environment: string, message: string }}
 */
function environmentCheck(environment, migrations) {
  const m = migrSetup(migrations);
  if (!m.environmentFile) return { ok: true, environment: 'without-guard', message: 'no environment file set' };
  const allowedOnes = Array.isArray(m.allowedEnvironment) ? m.allowedEnvironment : [];
  const r = typeof environment === 'string' ? environment.trim() : '';
  if (!r)
    return {
      ok: false,
      environment: 'missing',
      message:
        `Did not find the environment file ${m.environmentFile} (or it is empty). STOP: merge pushes migrations only to an environment in ` +
        `migrations.allowedEnvironment (${allowedOnes.length ? allowedOnes.join(', ') : 'empty list'}).`,
    };
  if (!allowedOnes.includes(r))
    return {
      ok: false,
      environment: 'unknown',
      message:
        `${m.environmentFile} points to "${r}", which is not in migrations.allowedEnvironment ` +
        `(${allowedOnes.length ? allowedOnes.join(', ') : 'empty list'}). STOP: link to the correct environment first.`,
    };
  return { ok: true, environment: r, message: `${r} (allowed)` };
}

/**
 * The migration files in a file list (the paths from `git diff --name-only`): files directly under `migrations.folder` that
 * match `filePattern`. Without a folder: none.
 */
function migrFiles(files, migrations) {
  const m = migrSetup(migrations);
  if (!m.folder) return [];
  const folder = String(m.folder).replace(/\\/g, '/').replace(/\/+$/, '');
  const pattern = new RegExp(m.filePattern ?? '^(\\d+)_.*\\.sql$');
  return (Array.isArray(files) ? files : []).filter((f) => {
    const s = String(f).replace(/\\/g, '/');
    if (!s.startsWith(`${folder}/`)) return false;
    const name = s.slice(folder.length + 1);
    return !name.includes('/') && pattern.test(name);
  });
}

/**
 * Which steps `merge` runs. Migration push when the project has a migration flow (folder + pushCommand) and the branch has
 * migration files; if the diff cannot be read (`files` null), the migration block decides (rather one push too many than one too
 * few). A block without files gives only a note. Without a migration folder there is never a push step.
 * `baseGate` adds the step `base-gate` after the quick gates: the base gate's own commands (lib/baseHealth.js) on the new
 * base tip, only when they are not the quick gates themselves (then the gates step is the base check).
 * @param {{ o: object, files: string[]|null, withoutMigrPush?: boolean, withoutFill?: boolean, base?: string,
 *   migrations?: object, baseGate?: boolean }} x
 * @returns {{ step: string[], migrPush: boolean, migr: string[], notes: string[] }}
 */
function mergePlan({ o, files, withoutMigrPush = false, withoutFill = false, base = 'baseBranch', migrations, baseGate = false }) {
  const m = migrSetup(migrations);
  const notes = [];
  let migr = [];
  let migrPush = false;
  if (m.folder) {
    migr = migrFiles(files, m);
    const hasMigr = Array.isArray(files) ? migr.length > 0 : !!o?.migr_block;
    if (Array.isArray(files) && !migr.length && o?.migr_block)
      notes.push(`migration block ${o.migr_block}, but no migration files in the branch: no push`);
    if (!Array.isArray(files))
      notes.push(`did not find the diff against ${base}; the migration block decides the push`);
    if (hasMigr && !m.pushCommand)
      notes.push(
        'the branch has migrations, but migrations.pushCommand is not set: push them yourself after the merge',
      );
    else if (hasMigr && withoutMigrPush)
      notes.push('migration push skipped (--without-migr-push): the migrations are NOT pushed yet');
    migrPush = hasMigr && !!m.pushCommand && !withoutMigrPush;
  }
  const step = ['merge', ...(migrPush ? ['migr-push'] : []), 'gates', ...(baseGate ? ['base-gate'] : []), 'done'];
  if (!withoutFill) step.push('fill');
  return { step, migrPush, migr, notes };
}

/** The last `n` non-empty lines (the error excerpt when a step stops). */
function errorExcerpt(out, n = 20) {
  return String(out ?? '')
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim())
    .slice(-n);
}

/** The last line that matches the pattern (or the last non-empty one), cut to `max` characters. */
function lastLine(out, pattern = null, max = 140) {
  const lines = errorExcerpt(out, 1000);
  const match = pattern ? lines.filter((l) => pattern.test(l)) : lines;
  const l = (match.length ? match[match.length - 1] : (lines[lines.length - 1] ?? '')).trim();
  return l.length > max ? `${l.slice(0, max - 1)}…` : l;
}

/** Exit codes from `fill` that are not errors: dailyBudget (4), nightPause (5), windDown (6), the machine is full (7). */
const FILL_STOP_CODES = new Set([4, 5, 6, 7]);

/**
 * Runs the steps in `merge` in order and stops at the first error. Does no I/O itself: `run({ step })` runs one
 * step and gives `{ code, out }` (stdout and stderr combined), `readEnvironment()` gives the content of migrations.environmentFile (null when
 * the file is missing), and `guard(environment)` is the push guard for the migration command (null = free). The order, the stop rules
 * and the environment check are here, so they can be tested without git, database or the gates.
 * @param {{ o: object, plan: object, branch: string, currentBranch: string|null, run: Function,
 *   readEnvironment?: Function, guard?: Function, base?: string, migrations?: object, beforeDone?: () => string|null }} x
 * @returns {{ ok: boolean, lines: string[], stop: { step: string, message: string, excerpt: string[] }|null }}
 */
function executeMerge({
  o,
  plan,
  branch,
  currentBranch,
  run,
  readEnvironment = () => null,
  guard = () => null,
  base = 'main',
  migrations,
  beforeDone = () => null,
}) {
  const lines = [...plan.notes.map((n) => `NB: ${n}`)];
  const stop = (step, message, out = '') => ({
    ok: false,
    lines,
    stop: { step, message, excerpt: errorExcerpt(out) },
  });
  if (currentBranch !== base)
    return stop(
      'merge',
      `The main tree is on ${currentBranch ?? 'unknown branch'}, not ${base}. Nothing was done.`,
    );
  for (const step of plan.step) {
    if (step === 'merge') {
      const r = run({ step });
      if (r.code !== 0)
        return stop(
          step,
          `merge-track.mjs ${branch} failed (exit ${r.code}). Nothing after the merge was done; ` +
            'if the merge is still in progress, resolve it or undo with git merge --abort.',
          r.out,
        );
      const wt = lastLine(r.out, /^Worktree:/);
      lines.push(
        `merge: ${lastLine(r.out, /^Merged/)}${/^Worktree:/.test(wt) ? ` · ${wt}` : ''}`,
      );
    } else if (step === 'migr-push') {
      const m = migrSetup(migrations);
      const environment = readEnvironment();
      const ms = environmentCheck(environment, m);
      if (!ms.ok) return stop(step, `Merged, but no migration push: ${ms.message}`);
      const v = guard(environment);
      if (v)
        return stop(
          step,
          `Merged, but no migration push: the push guard says ${v.decision}: ${v.reason}`,
        );
      const r = run({ step });
      if (r.code !== 0)
        return stop(
          step,
          `Merged, but the migration push failed (exit ${r.code}). The gates, set done and fill have not run.`,
          r.out,
        );
      lines.push(
        `migrationPush: OK${m.environmentFile ? ` (environment ${ms.environment})` : ''}: ${lastLine(r.out) || 'no output'}`,
      );
      if (m.environmentFile) {
        const after = environmentCheck(readEnvironment(), m);
        if (!after.ok || after.environment !== ms.environment)
          return stop(step, `The environment changed during the migration push: ${after.message}`);
      }
    } else if (step === 'gates') {
      const r = run({ step });
      if (r.code !== 0)
        return stop(
          step,
          `The gates (--quick) are red after the merge${plan.migrPush ? ' and the migration push' : ''}. The task stays in ` +
            'review; fix it (or send a fix round), and then run set <id> done and fill.',
          r.out,
        );
      lines.push(`gates --quick: ${lastLine(r.out)}`);
    } else if (step === 'base-gate') {
      // A red base gate does NOT stop the flow: the merge is on the base already and the task's own work was green, so
      // the task is set done, and fill still runs, which starts the base fix task the caller added (value 10).
      const r = run({ step });
      lines.push(`base gate: ${r.code === 0 ? '' : 'RED, the base fix task is added: '}${lastLine(r.out)}`);
    } else if (step === 'done') {
      // The invariant before a task is marked done (review 2026-11-02, M6): the track's tip is really in the base.
      // `beforeDone()` gives the reason when it is not (null = fine); then nothing is marked.
      const why = beforeDone();
      if (why) return stop(step, why);
      const r = run({ step });
      if (r.code !== 0) return stop(step, `set ${o.id} done failed (exit ${r.code}).`, r.out);
      lines.push(`done: ${lastLine(r.out, /^Cost |: done/)}`);
    } else if (step === 'fill') {
      const r = run({ step });
      if (FILL_STOP_CODES.has(r.code)) {
        lines.push(`fill: no new ones (exit ${r.code}): ${lastLine(r.out)}`);
        continue;
      }
      if (r.code !== 0)
        return stop(step, `fill failed (exit ${r.code}). ${o.id} is done.`, r.out);
      lines.push(...fillExcerpt(r.out));
    }
  }
  return { ok: true, lines, stop: null };
}

/**
 * From the `fill` output: the FILLED line, one line per track and the agent list "Start these in the SAME turn:"; otherwise the last line
 * (e.g. "Nothing can be started now").
 */
function fillExcerpt(out) {
  const lines = String(out ?? '')
    .split(/\r?\n/)
    .filter((l) => l.trim());
  const i = lines.findIndex((l) => /^FILLED /.test(l));
  // fill only MARKS the tracks running; the agents start only when someone reads this. Said last, where it is seen.
  if (i >= 0)
    return [
      `fill: ${lines[i]}`,
      ...lines.slice(i + 1),
      `NOTE: the tracks above are only marked running. Start the agents now; ${FILL_NOTE}`,
    ];
  return [`fill: ${lines[lines.length - 1] ?? 'no output'}`];
}

const SAME_TURN = 'Start these in the SAME turn:';
/** Why merge must not run where nobody reads it (a background job, a script that chains merges). */
const FILL_NOTE =
  'never run merge where nobody reads the output (in the background or chained in a script): use --without-fill there ' +
  'and run fill yourself afterwards. cq show and the pulse warn about tracks STARTED WITHOUT AGENT.';

/**
 * The agent list the orchestrator starts in ONE turn (in parallel): one line per agent with subagent_type and the message
 * (the track message mentions the prompt file; a reviewer gets the content of the prompt file as the message).
 * `bare: true` keeps the name as it is: a custom helper lives in the project's .claude/agents/, never under the
 * plugin's prefix.
 * @param {{ subagent_type: string, prompt: string, message?: string|null, bare?: boolean }[]} agents
 */
function concurrentBlock(agents) {
  if (!agents?.length) return [];
  const ref = (x) => (x.bare ? x.subagent_type : require('../projectRoot.js').agentRef(x.subagent_type));
  return [
    SAME_TURN,
    ...agents.map((x) =>
      x.message
        ? `  subagent_type=${ref(x)}${modelPart(x.subagent_type)} · message: ${x.message}`
        : `  subagent_type=${ref(x)}${modelPart(x.subagent_type)} · message: the content of ${x.prompt}`,
    ),
  ];
}

/** The warning `receive` gives when the track's answer is over the report cap (null otherwise). */
function reportCapWarning(text, cap = REPORT_CAP) {
  const n = String(text ?? '').trim().length;
  if (n <= cap) return null;
  return (
    `WARNING: trackReply.md is ${n} characters (cap approx. ${cap}). The answer should be the RESULT line, at most 5 lines and the path to ` +
    'report.md; the long version goes in report.md (see docs/mission-template.md, "Report").'
  );
}

module.exports = {
  REPORT_CAP,
  migrSetup,
  environmentCheck,
  migrFiles,
  mergePlan,
  errorExcerpt,
  executeMerge,
  fillExcerpt,
  SAME_TURN,
  concurrentBlock,
  reportCapWarning,
};
