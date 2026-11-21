'use strict';
// =============================================================
// zeroTests.js: "green, but no tests ran" (GS-1). Pure: no files, no processes.
//
// A green gate that ran nothing is the quietest false green: a test filter that matches no test, a test folder that moved,
// or a runner that exits 0 when it finds no files. This module reads the TAIL of a green command's output for the
// zero-test line of the common runners and says which runner and which signal it saw.
//
// Where it is used:
//   - gates.mjs: each green quick or full gate command (and a green flaky rerun). The hits go into the gate evidence entry
//     (`zero_tests`, lib/gateEvidence.js) and on screen as a NOTE line.
//   - ravenseat receive (cli/merge.mjs): the hits from the evidence become `gate_check.zeroTests`, a green done command's
//     tail is read the same way into `done_check.zeroTests`; one NOTE line, a section in 00-package.md.
//   - the board (lib/queueBoard.js): a small "no tests ran" badge on the card and a "Tests" fact in the panel.
//
// It is a caveat, never a stop: a docs-only task can be green with no tests at all, and the owner decides what it means.
// That is also why there is no setting: it only adds a line (display), so nothing needs turning off.
//
// What counts as a signal (after colour codes are removed, one line at a time):
//   vitest/jest  "No test files found", "No tests found", a summary "Tests  0 passed" / "Tests: 0 total", or a summary
//                where every test was skipped or todo
//   mocha        "0 passing"
//   pytest       "no tests ran", "collected 0 items"
//   go           "[no test files]", "[no tests to run]", "testing: warning: no tests to run"
//   cargo        "running 0 tests"
//   rspec        "0 examples, 0 failures"
//   unittest     "Ran 0 tests"
// A positive count anywhere in the same tail ("12 passed", "Ran 3 tests", "running 5 tests", "4 examples", a go "ok"
// line) cancels the signal: then only some files or packages had no tests, and tests did run.
// =============================================================

/** How many lines from the end are read by default. The summary of every runner above is in its last lines. */
const DEFAULT_TAIL_LINES = 80;
/** The gates a hit can come from (which gate, for the texts). */
const GATES = new Set(['quick', 'full', 'done_when']);
const GATE_TEXT = { quick: 'quick gate', full: 'full gate', done_when: 'done command' };
const TEXT_MAX = 200;

/** The zero-test rules, in the order they are tried. `signal` is a fixed label: the output itself is never kept. */
const RULES = [
  { runner: 'vitest', signal: 'No test files found', re: /\bNo test files found\b/i },
  { runner: 'jest', signal: 'No tests found', re: /\bNo tests found\b/i },
  { runner: 'vitest/jest', signal: 'Tests 0', re: /^\s*Tests:?\s+(?:0 passed|0 total|no tests)\b/im },
  {
    runner: 'vitest/jest',
    signal: 'all tests skipped',
    re: /^\s*Tests:?\s+(?:\d+\s+(?:skipped|todo)\b[\s,|]*)+(?:\(\d+\)|\d+\s+total)?\s*$/im,
  },
  { runner: 'mocha', signal: '0 passing', re: /^\s*0 passing\b/im },
  { runner: 'pytest', signal: 'no tests ran', re: /\bno tests ran\b/i },
  { runner: 'pytest', signal: 'collected 0 items', re: /\bcollected 0 items\b/i },
  { runner: 'go', signal: 'no tests to run', re: /\[no tests to run\]|testing: warning: no tests to run/i },
  { runner: 'go', signal: 'no test files', re: /\[no test files\]/i },
  { runner: 'cargo', signal: 'running 0 tests', re: /^\s*running 0 tests\s*$/im },
  { runner: 'rspec', signal: '0 examples', re: /^\s*0 examples, 0 failures\b/im },
  { runner: 'unittest', signal: 'Ran 0 tests', re: /^\s*Ran 0 tests\b/im },
];

/** Proof that tests did run: any one of these in the tail cancels a zero-test signal. */
const POSITIVE = [
  /\b[1-9]\d*\s+(?:passed|passing)\b/i,
  /^\s*Ran [1-9]\d* tests?\b/im,
  /^\s*running [1-9]\d* tests?\b/im,
  /\b[1-9]\d* examples?, \d+ failures?\b/i,
  // go: "ok  <pkg>  0.02s" or "(cached)", but not "ok ... [no tests to run]"
  /^ok\s+\S+\s+(?:[\d.]+s|\(cached\))\s*$/im,
  /^--- PASS\b/m,
];

/** Colour codes and other terminal escapes out, CRLF to LF. */
function plain(text) {
  // eslint-disable-next-line no-control-regex
  return String(text).replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r\n?/g, '\n');
}

/**
 * The zero-test signal in the tail of one command's output, or null (no signal, or tests did run).
 * @param {string} text the command's output (stdout and stderr)
 * @param {{ tailLines?: number }} [opts]
 * @returns {null | { runner: string, signal: string }}
 */
function detect(text, { tailLines = DEFAULT_TAIL_LINES } = {}) {
  if (typeof text !== 'string' || !text) return null;
  const lines = plain(text).replace(/\s+$/, '').split('\n');
  const tail = lines.slice(-Math.max(1, Number(tailLines) || DEFAULT_TAIL_LINES)).join('\n');
  if (POSITIVE.some((re) => re.test(tail))) return null;
  const hit = RULES.find((r) => r.re.test(tail));
  return hit ? { runner: hit.runner, signal: hit.signal } : null;
}

const short = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, TEXT_MAX) : null);

/** The hits list as stored (gate_check.zeroTests, done_check.zeroTests, the evidence entry): known gates, short strings. */
function clean(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const z of list) {
    if (!z || typeof z !== 'object' || !GATES.has(z.gate)) continue;
    const command = short(z.command);
    const signal = short(z.signal);
    if (!command || !signal) continue;
    out.push({ gate: z.gate, command, runner: short(z.runner) ?? '?', signal });
  }
  return out;
}

/** All hits of a task: the gate record and the done command record, only when green (red is red, no caveat needed). */
function ofTask(o) {
  const from = (rec) => (rec && rec.ok === true ? clean(rec.zeroTests) : []);
  return [...from(o?.gate_check), ...from(o?.done_check)];
}

const where = (z) => `${GATE_TEXT[z.gate] ?? z.gate}: ${z.signal}`;

/** The one NOTE line at receive, or null. Never a stop. */
function receiveLine(id, list) {
  const l = clean(list);
  if (!l.length) return null;
  return (
    `NOTE ${id}: green, but no tests ran (${l.map((z) => `${where(z)} in \`${z.command}\``).join('; ')}). ` +
    'Check that the delivery needs no tests, or that the test filter matches them.'
  );
}

/** The section in 00-package.md, as lines; [] for none. */
function packageSection(list) {
  const l = clean(list);
  if (!l.length) return [];
  return [
    '',
    '## Green, but no tests ran',
    '',
    'These commands were green, but their output says no test ran (a filter that matched nothing, or no test files):',
    ...l.map((z) => `- ${GATE_TEXT[z.gate] ?? z.gate} \`${z.command}\`: ${z.runner} said "${z.signal}"`),
    '',
    'A caveat, not a stop. Check whether the change should have tests that ran.',
  ];
}

/** The board's texts (badge, tooltip, panel fact), or null for none. */
function boardText(list) {
  const l = clean(list);
  if (!l.length) return null;
  return {
    badge: 'no tests ran',
    title: `Green, but no tests ran: ${l.map(where).join('; ')}`,
    fact: `Green, but no tests ran (${l.map(where).join('; ')})`,
  };
}

module.exports = { DEFAULT_TAIL_LINES, RULES, detect, clean, ofTask, receiveLine, packageSection, boardText };
