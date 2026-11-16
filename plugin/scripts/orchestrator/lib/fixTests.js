// =============================================================
// fixTests.js: "a fix needs a red test first" (step 6 of the finding format contract, the learning loop plan section
// 3.5).
//
// Why: a fix whose new test passes without the fix too, or a fix with no test at all, shows nothing about the bug it
// says it fixed. The bug can come back and nothing goes red. Red on base (lib/redOnBase.js) already gives the verdict
// at receive; this file says which tasks are fixes, what the verdict means for them, and when the merge stops.
//
// WHICH TASKS ARE FIXES (fixKind), read from the fields the queue already has, never a new one:
//   qa         a QA fix task (`qa deviation` sets qa_original, and fixes, on <id>-QA<n>);
//   base-fix   the fix task the base gate or the CI watch added (added_by "base gate" or "ci watch");
//   fixes      a task that names the task(s) it fixes (lib/fixLinks.js);
//   finding    a task made from a finding (`ravenseat finding`, plan PL-FINDING-<n>);
//   gate-line  a task whose report has a GATE line: it says it fixed a known bug (lib/knownBugGate.js). Only receive
//              reads the report, so receive keeps the kind on the red_on_base record and merge reads it there.
// The first that holds wins, the most specific first: a QA fix also has `fixes`, and says more as `qa`.
//
// THE VERDICT: only `no-tests` and `unproven` make a fix "fixed without test" (the finding log row's status, which the
// repeat count in step 7 counts twice). `tip-red` already has its own warning, `tests-only` has no change to take away,
// and `error` was not checked: none of them is evidence either way, so none is marked.
//
// THE DEFAULT IS A WARNING: one line at receive (receiveLine), nothing stops. The STRICT MODE is opt-in
// (gates.redOnBaseStrict, off by default, true only when exactly true): merge stops on a fix without a proven red test
// (mergeStop), and `merge --allow-no-test` is the owner's way past it, logged as "no-test-overridden". In the strict mode
// only `proven` passes, and with red on base off there is no verdict, so nothing is proven: the stop names the setting.
//
// THE COMMAND (suggestCommand): Ravenseat does not run a project's tests on a guess, so gates.redOnBase is never set
// for the owner. The suggestion, read from the project's own files, is shown on the Checks card "red-on-base".
//
// Pure, no I/O (suggestCommand reads through the functions it is given). Used by: cli/merge.mjs, cli/checks.mjs,
// lib/findingSources.js. Tested in lib/__tests__/fixTests.test.ts and __tests__/redteam/fixTest-cli.test.ts.
// =============================================================
'use strict';

/** The kinds of fix, in the order fixKind tries them. */
const FIX_KINDS = Object.freeze(['qa', 'base-fix', 'fixes', 'finding', 'gate-line']);
/** The verdicts that make a fix "fixed without test". */
const UNTESTED = Object.freeze(['no-tests', 'unproven']);
/** The status the finding log row gets for such a fix (lib/findingLog.js). */
const FIXED_WITHOUT_TEST = 'fixed-without-test';
/** The `added_by` of the fix tasks the base gate (lib/baseHealth.js) and the CI watch (lib/ciWatch.js) add. */
const BASE_FIX_BY = Object.freeze(['base gate', 'ci watch']);
/** The plan ids `ravenseat finding` gives (lib/eventStatistics.js FINDING_PREFIX). */
const FINDING_PLAN = 'PL-FINDING-';
/** The time log event of the owner's override. */
const OVERRIDE_EVENT = 'no-test-overridden';

/** The ids a task fixes (`fixes`, a string or a list), without itself. */
function fixedIds(o) {
  const v = o?.fixes;
  const list = Array.isArray(v) ? v : typeof v === 'string' ? [v] : [];
  return list.filter((x) => typeof x === 'string' && x && x !== o?.id);
}

/**
 * Which kind of fix the task is, or null when it is none.
 * @param {object} o  the task
 * @param {{ gateLine?: boolean }} [x]  receive found a GATE line in the report
 */
function fixKind(o, { gateLine = false } = {}) {
  if (!o || typeof o !== 'object') return null;
  if (typeof o.qa_original === 'string' && o.qa_original && o.qa_original !== o.id) return 'qa';
  if (BASE_FIX_BY.includes(o.added_by)) return 'base-fix';
  if (fixedIds(o).length) return 'fixes';
  if (typeof o.plan === 'string' && o.plan.startsWith(FINDING_PLAN)) return 'finding';
  if (gateLine || o.red_on_base?.fix === 'gate-line') return 'gate-line';
  return null;
}

/** The task the fix belongs to (the finding log's cause_task), or null. */
function causeOf(o) {
  if (typeof o?.qa_original === 'string' && o.qa_original && o.qa_original !== o.id) return o.qa_original;
  return fixedIds(o)[0] ?? null;
}

/** Is the verdict one that makes a fix "fixed without test"? */
const untested = (verdict) => UNTESTED.includes(verdict);

/** The finding log's test_added from a red_on_base record: the verdict and the test paths, never the output. */
function testAdded(record) {
  if (!record || typeof record !== 'object') return null;
  const files = (Array.isArray(record.files) ? record.files : []).map((f) => f?.path).filter((p) => typeof p === 'string' && p);
  return { verdict: typeof record.verdict === 'string' ? record.verdict : null, files };
}

/** Is the strict mode on? Only exactly true: a missing or odd value is off, the default. */
const strictOn = (config) => config?.gates?.redOnBaseStrict === true;

/**
 * Does receive print the fix line? On unless gates.fixWithoutTestWarning is exactly false (it costs one line and stops
 * nothing). The strict mode keeps it whatever the setting says, since that line is what explains the coming stop.
 */
const fixLineOn = (config) => strictOn(config) || config?.gates?.fixWithoutTestWarning !== false;

/** What the fix is, in a few words, for the lines. */
function why(kind, o) {
  switch (kind) {
    case 'qa':
      return `a QA fix of ${o.qa_original}`;
    case 'base-fix':
      return `the fix task the ${o.added_by} added`;
    case 'fixes':
      return `it fixes ${fixedIds(o).join(', ')}`;
    case 'finding':
      return `made from the finding ${o.plan}`;
    case 'gate-line':
      return 'its report has a GATE line';
    default:
      return 'a fix';
  }
}

/** What red on base said, in words: the verdict, or that it is off. */
const saidOf = (record) => (record?.verdict ? `red on base says ${record.verdict}` : 'red on base is off (gates.redOnBase), so no test was tried');

/**
 * The one line receive prints for a fix without a proven red test, or null. The default mode says it and goes on; the
 * strict mode also says the merge stops. Red on base off: nothing in the default mode (no verdict, nothing to warn
 * about; the Checks card offers the setting), one line in the strict mode, since the merge will stop.
 * @param {string} id
 * @param {{ fix: string|null, task: object, record: object|null, strict?: boolean, cli?: string }} x
 */
function receiveLine(id, { fix, task, record, strict = false, cli = 'ravenseat' }) {
  if (!fix) return null;
  const head = `FIX WITHOUT TEST ${id}: a fix task (${why(fix, task ?? {})}), and ${saidOf(record)}`;
  if (strict) {
    if (record?.verdict === 'proven') return null;
    return (
      `${head}. The merge stops on it (gates.redOnBaseStrict): add a test that fails without the fix in a fix round ` +
      `(${cli} resume ${id} --reason fix), or on the owner's word ${cli} merge ${id} --allow-no-test (logged).`
    );
  }
  if (!record || !untested(record.verdict)) return null;
  return `${head}: nothing shows the fix works. Logged as fixed without test; a test that fails on the base in a fix round proves it.`;
}

/**
 * The text merge stops with in the strict mode, or null (strict off, no fix, or a proven red test).
 * @param {object} o  the task (red_on_base as receive stored it)
 * @param {{ config: object, cli?: string }} x
 */
function mergeStop(o, { config, cli = 'ravenseat' }) {
  if (!strictOn(config)) return null;
  const fix = fixKind(o);
  if (!fix) return null;
  const record = o.red_on_base ?? null;
  if (record?.verdict === 'proven') return null;
  return (
    `STOP: ${o.id} is not merged. It is a fix task (${why(fix, o)}) without a proven red test: ${saidOf(record)}. ` +
    `A fix needs a test that fails without it and passes with it (gates.redOnBaseStrict). Add one in a fix round: ` +
    `${cli} resume ${o.id} --reason fix. On the owner's word only: ${cli} merge ${o.id} --allow-no-test ` +
    `(logged as "${OVERRIDE_EVENT}"). Nothing was done.`
  );
}

/** package.json as an object, or null. */
function packageJson(read) {
  try {
    const v = JSON.parse(read('package.json') ?? '');
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

/**
 * The gates.redOnBase command for the project's test runner, from its own files, or null when the runner is not known.
 * {files} is where receive puts the test files; Go runs packages, so its command takes {dirs}, the folders of the files.
 * @param {{ exists: (f: string) => boolean, read: (f: string) => string|null }} fsLike
 */
function suggestCommand({ exists, read }) {
  const has = (f) => {
    try {
      return !!exists(f);
    } catch {
      return false;
    }
  };
  const text = (f) => {
    try {
      return read(f) ?? '';
    } catch {
      return '';
    }
  };
  if (has('package.json')) {
    const pkg = packageJson(text);
    if (pkg) {
      const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
      const testScript = String(pkg.scripts?.test ?? '');
      if (Object.hasOwn(deps, 'vitest') || /\bvitest\b/.test(testScript)) return 'npx vitest run {files}';
      if (Object.hasOwn(deps, 'jest') || /\bjest\b/.test(testScript)) return 'npx jest {files}';
      if (Object.hasOwn(deps, 'mocha') || /\bmocha\b/.test(testScript)) return 'npx mocha {files}';
      if (/\bnode --test\b/.test(testScript)) return 'node --test {files}';
    }
  }
  if (has('go.mod')) return 'go test {dirs}';
  const pyproject = text('pyproject.toml');
  const pytest =
    /^\[tool\.pytest/m.test(pyproject) ||
    has('pytest.ini') ||
    /^\[tool:pytest\]/m.test(text('setup.cfg')) ||
    /^pytest\b/im.test(text('requirements.txt')) ||
    /^pytest\b/im.test(text('requirements-dev.txt')) ||
    /["']pytest\b/.test(pyproject);
  if (pytest) {
    // The same runner prefix kickstart uses (lib/kickstart.js pythonChecks), so the command finds the project's pytest.
    const prefix = has('uv.lock') ? 'uv run ' : has('poetry.lock') ? 'poetry run ' : '';
    return `${prefix}pytest {files}`;
  }
  return null;
}

module.exports = {
  FIX_KINDS,
  UNTESTED,
  FIXED_WITHOUT_TEST,
  OVERRIDE_EVENT,
  fixKind,
  causeOf,
  untested,
  testAdded,
  strictOn,
  fixLineOn,
  receiveLine,
  mergeStop,
  suggestCommand,
};
