// =============================================================
// heavyCommand.js: which shell lines of a track are heavy test runs that should go through the machine queue, and what
// the PreToolUse hook says about them (roadmap 0s V10; idea A in plans/coral-tester-ressurser-2026-11-17.md).
//
// Why: the machine queue (lib/gateQueue.js) only saw `gates.mjs --quick/--full`. A track that ran `npm test`,
// `npx vitest run` or a red team run directly went past it, and that load is what gave vitest's onTaskUpdate timeouts
// and the red team probes that ran out of time while four tracks worked at once. `ravenseat heavy -- <command>`
// (cli/heavy.mjs) takes a slot and runs the command; this module tells the hook when a track should have used it.
//
// The rule: one simple command of the line (lib/shellCommands.js commandList, so `cd x && npm test` and a wrapped
// `bash -c "..."` count) is a test runner: npm/pnpm/yarn/bun test, `npm run test*` or `redteam*` (not the report), vitest,
// jest or playwright (bare, through npx/pnpx/bunx/npm exec, or a node_modules path run by node), or
// scripts/test-changed.mjs. `--version` and `--help` are not runs. A line that already calls `ravenseat heavy` is never
// flagged again.
//
// The setting processGuard.heavyQueue: warn (default) gives the agent one line of context and the command runs; deny
// refuses it with the exact wrapped command to run instead; off says nothing. The hook only builds the answer: it never
// waits for a slot itself (its limit in hooks.json is 10 s, and a waiting hook blocks the call with no progress shown).
//
// Pure. Used by hook-push-guard.mjs. Tested in lib/__tests__/heavyCommand.test.ts and __tests__/heavyFlow.test.ts.
// =============================================================
'use strict';

const SC = require('./shellCommands.js');

const MODES = Object.freeze(['warn', 'deny', 'off']);
/** Package manager script names that run tests. */
const TEST_SCRIPT = /^(test|redteam)(:.+)?$/;
/** Script names under that pattern that only read results. */
const NOT_A_RUN = new Set(['redteam:report']);
/** Test runners as programs. */
const RUNNERS = new Set(['vitest', 'jest', 'playwright']);
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const PACKAGE_RUNNERS = new Set(['npx', 'pnpx', 'bunx']);
/** A script path run by node that is a test run: a runner's entry file in node_modules, or test:changed. */
const NODE_SCRIPT = /(^|[\\/])node_modules[\\/](\.bin[\\/])?(vitest|jest|playwright)([\\/]|\.|$)|(^|[\\/])test-changed\.mjs$/i;

/** processGuard.heavyQueue in effect: warn, deny or off; anything else is warn. */
function modeOf(cfg) {
  const v = String(cfg?.processGuard?.heavyQueue ?? 'warn').trim().toLowerCase();
  return MODES.includes(v) ? v : 'warn';
}

/** The label of one simple command when it is a heavy test run, or null. */
function matchOne(t, i0) {
  const word = SC.commandWord(t[i0]);
  const rest = t.slice(i0 + 1);
  if (rest.some((x) => x === '--version' || x === '--help' || x === '-v' || x === '-h')) return null;
  const words = rest.filter((x) => !x.startsWith('-'));
  const runner = (name) => {
    const w = SC.commandWord(name);
    return RUNNERS.has(w) ? w : null;
  };
  if (PACKAGE_MANAGERS.has(word)) {
    const [a, b] = words;
    if (['test', 't', 'tst'].includes(a)) return `${word} test`;
    if ((a === 'run' || a === 'run-script') && TEST_SCRIPT.test(b ?? '') && !NOT_A_RUN.has(b)) return `${word} run ${b}`;
    // yarn and pnpm run a script by its bare name: `yarn redteam`.
    if (word !== 'npm' && TEST_SCRIPT.test(a ?? '') && !NOT_A_RUN.has(a)) return `${word} ${a}`;
    if (a === 'exec' || a === 'dlx' || a === 'x') return runner(b);
    return null;
  }
  if (PACKAGE_RUNNERS.has(word)) return runner(words[0]);
  if (RUNNERS.has(word)) return word;
  if (word === 'node' || word === 'bun') {
    const m = NODE_SCRIPT.exec(words[0] ?? '');
    if (m) return m[3] ? m[3].toLowerCase() : 'test:changed';
  }
  return null;
}

/**
 * Does the line call `ravenseat heavy` at its top level? commandList reads the wrapper's inner command in its place (so
 * the guards judge what really runs), which is why the segments are looked at here.
 */
function wrapped(command) {
  try {
    return SC.segments(String(command ?? '')).some((seg) => {
      const t = SC.stripRedirects(SC.tokens(seg.text));
      const i0 = SC.firstWordIndex(t);
      return i0 < t.length && SC.queueCall(t, i0)?.name === 'heavy';
    });
  } catch {
    return false;
  }
}

/**
 * Is this shell line a heavy test run that is not already wrapped? { label } or null.
 * @param {string} command the Bash or PowerShell line
 */
function heavyMatch(command) {
  let read;
  try {
    read = SC.commandList(String(command ?? ''));
  } catch {
    return null; // a line the reader cannot take is no hint: the other guards judge it
  }
  if (wrapped(command)) return null;
  for (const c of read.commands) {
    const label = matchOne(c.t, c.i0);
    if (label) return { label };
  }
  return null;
}

/**
 * The hook's answer for a matched line: { decision: 'context' | 'deny', text } or null (off).
 * @param {{ command: string, match: { label: string }, mode: string, cli?: string }} x
 */
function answer({ command, match, mode, cli = 'ravenseat' }) {
  if (!match || mode === 'off') return null;
  const wrapped = `${cli} heavy -- ${String(command).trim()}`;
  const why =
    `${match.label} is a heavy test run. Run it through the machine queue so parallel tracks take turns instead of ` +
    `slowing each other into timeouts: \`${wrapped}\` (it waits for a free slot, runs the command and gives its exit ` +
    'code back).';
  if (mode === 'deny') return { decision: 'deny', text: `${why} Refused by processGuard.heavyQueue deny; run the line above instead.` };
  return { decision: 'context', text: `${why} This run goes ahead (processGuard.heavyQueue warn).` };
}

module.exports = { MODES, modeOf, heavyMatch, answer };
