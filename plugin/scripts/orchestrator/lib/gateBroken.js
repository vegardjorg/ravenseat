// =============================================================
// gateBroken.js: "the gate cannot run" is not the same as "the gate is red".
//
// Why: when a quick gate's own program is not installed on this machine (sh exit 127 "not found", cmd.exe "is not
// recognized", 9009, PowerShell "The term ... is not recognized", spawn ENOENT), a fix round cannot help: the agent
// cannot install a tool on the owner's machine, and every round burns a whole track session for the same red line.
// That is a setup problem, so `ravenseat receive` stops the fix round and asks the owner at once.
//
// The narrow rule (to avoid false hits):
//   - the program the output says is missing must be the FIRST program of the red gate command (the word the shell
//     starts, after any NAME=value assignments). A tool missing deeper inside a script is not this verdict.
//   - "Cannot find module" (the track's own code requires a file that is not there) is always a code failure.
//   - the same command run on the base (the main checkout, a short budget) must fail the same way: the program is missing
//     there too. A tool that only the track's change took away is the track's to fix.
// The verdict is tied to the hash of the gates setup (lib/gateEvidence.js setupHash): the question id carries it, so a
// changed gates setup forgets the old verdict by itself, and the same setup asks only once.
// With the question resolved by the owner, a fix round runs as before (the owner's answer allows it).
//
// Setting: gates.brokenVerdict (default true; false = every red gate gives a fix round, as before).
// Pure, no I/O: cli/merge.mjs reads the gate log, runs the base check and registers the question.
// Tested in lib/__tests__/gateBroken.test.ts and __tests__/queueGateBroken.test.ts.
// =============================================================
'use strict';

/** The time budget for the one command on the base: a missing program fails in milliseconds. */
const BASE_CHECK_SEC = 30;

/** On unless gates.brokenVerdict is false. */
function on(config) {
  return config?.gates?.brokenVerdict !== false;
}

/** A program name as the shells compare it: the base name, lower case, without a Windows launcher extension. */
function normalizeProgram(name) {
  const base = String(name ?? '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .split(/[\\/]/)
    .pop();
  return base.toLowerCase().replace(/\.(exe|cmd|bat|com|ps1)$/, '');
}

/**
 * The first program of a shell command: the first word after leading NAME=value assignments, quotes taken off.
 * Null when the command starts with shell syntax (a bracket, a redirect) instead of a program.
 */
function firstProgram(command) {
  const words = String(command ?? '').trim().match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  let i = 0;
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++;
  const w = words[i];
  if (!w || /^[(<>|&;{]/.test(w)) return null;
  const p = normalizeProgram(w);
  return p || null;
}

// The shells' own "cannot start this program" lines. Each captures the program name.
const MISSING_PATTERNS = [
  // sh / dash: "sh: 1: foo: not found"; bash: "bash: foo: command not found", "/bin/sh: line 1: foo: command not found"
  /^[^\n]*?([^\s:'"]+): (?:command )?not found\s*$/gm,
  // zsh: "zsh: command not found: foo"
  /command not found: ([^\s'"]+)/g,
  // cmd.exe: "'foo' is not recognized as an internal or external command"
  /'([^'\r\n]+)' is not recognized as an internal or external command/g,
  // PowerShell: "The term 'foo' is not recognized as the name of a cmdlet" (also "as a name of")
  /The term '([^'\r\n]+)' is not recognized as (?:the |a )?name of a cmdlet/g,
  // Node and others: "spawn foo ENOENT"
  /spawn ([^\s'"]+) ENOENT/g,
];

/** Every program the output says could not be started, normalized. */
function missingPrograms(output) {
  const text = String(output ?? '');
  const out = new Set();
  for (const re of MISSING_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      const p = normalizeProgram(m[1]);
      if (p) out.add(p);
    }
  }
  return [...out];
}

/**
 * Could the shell not start this gate command's own program? The program name, or null.
 * Null for a green run, a timeout, any "Cannot find module" and a missing program that is not the first one.
 * @param {{ command: string, exit: number|null, output: string, timedOut?: boolean }} run
 */
function cannotRun({ command, exit, output, timedOut = false }) {
  if (exit === 0 || timedOut) return null;
  const text = String(output ?? '');
  if (/Cannot find module/i.test(text)) return null;
  const program = firstProgram(command);
  if (!program) return null;
  return missingPrograms(text).includes(program) ? program : null;
}

/**
 * The first run of each command from a gates.mjs --log file ("===== <command> (exit N, S s) =====" sections; the
 * flaky rerun's sections are left out). [{ command, exit, output }].
 */
function logSections(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const out = [];
  let cur = null;
  const head = /^===== (.+) \((rerun, )?exit (-?\d+|unknown)(?:, [^)]*)?\) =====$/;
  for (const line of lines) {
    const m = head.exec(line);
    if (m) {
      // A rerun, or a command seen before: its lines are not the first run's.
      const fresh = !m[2] && !out.some((s) => s.command === m[1]);
      cur = fresh ? { command: m[1], exit: m[3] === 'unknown' ? null : Number(m[3]), output: '' } : null;
      if (cur) out.push(cur);
      continue;
    }
    if (cur) cur.output += `${line}\n`;
  }
  return out;
}

/**
 * The red commands of the run whose own program could not start: [{ command, program }]. Only commands that are in
 * `commands` (the configured quick gates) count.
 */
function candidates(logText, commands) {
  const want = new Set((commands ?? []).map((c) => String(c).trim()));
  const out = [];
  for (const s of logSections(logText)) {
    if (!want.has(s.command.trim())) continue;
    const program = cannotRun(s);
    if (program) out.push({ command: s.command, program });
  }
  return out;
}

/** The owner question id: the task id and the first 8 hex of the gates setup hash (at most 40 characters). */
function questionId(id, setupHash) {
  const suffix = `.nogate${String(setupHash ?? '').slice(0, 8)}`;
  return `${String(id).slice(0, 40 - suffix.length)}${suffix}`;
}

/**
 * The verdict: the candidates that the base run confirmed (the same program missing there). `baseRuns` maps a command
 * to its base run { exit, output, timedOut }. Null when none is confirmed.
 * @returns {null | { commands: string[], program: string, setup_hash: string, question: string, at: string }}
 */
function verdict({ id, found, baseRuns, setupHash, now = new Date().toISOString() }) {
  const sure = (found ?? []).filter((c) => {
    const b = baseRuns?.[c.command];
    return b && cannotRun({ command: c.command, ...b }) === c.program;
  });
  if (!sure.length) return null;
  return {
    commands: sure.map((c) => c.command),
    program: sure[0].program,
    setup_hash: setupHash,
    question: questionId(id, setupHash),
    at: now,
  };
}

/** The owner question (the input for queueLogic.setQuestion). */
function question(o, v, { cli = 'ravenseat' } = {}) {
  const list = v.commands.map((c) => `\`${c}\``).join(', ');
  return {
    [v.question]: {
      type: 'question',
      text:
        `${o.id} (${o.title ?? ''}): the quick gate ${list} cannot run: the program \`${v.program}\` is not found, on the ` +
        'delivered tip and on the base branch. That is a setup problem on this machine, not a fault in the track\'s code, ' +
        'so no fix round was started. Install the tool, or change gates.quick?',
      recommendation:
        `Install \`${v.program}\` (or fix the command in gates.quick in queue.config.json), then run ${cli} receive ${o.id} ` +
        'again: a changed gates setup forgets this verdict by itself. To let a fix round run anyway: ' +
        `${cli} resolve ${v.question} --answer "…", then ${cli} receive ${o.id}.`,
      source: `gate cannot run (${o.id})`,
    },
  };
}

module.exports = { BASE_CHECK_SEC, on, normalizeProgram, firstProgram, missingPrograms, cannotRun, logSections, candidates, questionId, verdict, question };
