// =============================================================
// cliHelp.js: the help text for `ravenseat help` and the "Did you mean" line for a mistyped command.
//
// Why: `ravenseat help` used to print about 200 lines regex-filtered from the comment at the top of queue.mjs, and an unknown
// command printed one line with every command. Now `ravenseat help` prints a short hand-written list in groups, `ravenseat help all`
// the full list, `ravenseat help <command>` the lines for one command, and a typo gets a suggestion.
//
// Everything here is pure (strings in, strings out), so it is unit tested in lib/__tests__/cliHelp.test.ts. ravenseat.mjs and
// queue.mjs do the reading of files and the printing.
// =============================================================
'use strict';

/**
 * The short help: a few key commands per group, one line each. `cmd` is the command word ravenseat dispatches on (a queue.mjs
 * command or a ravenseat script/alias); the test checks that every one really exists. Keep it between 10 and 14 commands.
 */
const GROUPS = [
  {
    title: 'Get started',
    commands: [
      { cmd: 'setup', usage: 'setup', text: 'set this project up for the queue (run once)' },
      { cmd: 'add', usage: 'add --file task.json', text: 'add one task or a list' },
      { cmd: 'board', usage: 'board', text: 'start the board (a local web page with the queue)' },
    ],
  },
  {
    title: 'Daily',
    commands: [
      { cmd: 'show', usage: 'show [--full]', text: 'what runs, what can start, and the counts' },
      { cmd: 'next', usage: 'next', text: 'what can start now (changes nothing)' },
      { cmd: 'info', usage: 'info <id>', text: 'a short view of one task' },
      { cmd: 'pick', usage: 'pick <id> --by "<who>"', text: 'do a task yourself, outside the agents' },
    ],
  },
  {
    title: 'Owner',
    commands: [
      { cmd: 'decide', usage: 'decide', text: 'everything waiting on you, most impact first (or /ravenseat:decide)' },
      { cmd: 'resolve', usage: 'resolve <q> --answer "..." | --choice <n>', text: 'answer one; waiting tasks get the answer' },
      { cmd: 'approve', usage: 'approve <id>', text: 'approve a task an agent proposed' },
    ],
  },
  {
    title: 'Orchestrator',
    commands: [
      { cmd: 'takeover', usage: 'takeover', text: 'the status picture for a new orchestrator session' },
      { cmd: 'fill', usage: 'fill --scratchpad <dir>', text: 'start as many tracks as the limits allow' },
      { cmd: 'receive', usage: 'receive <id>', text: 'take in a finished track (ravenseat reruns the quick gates on its tip: gate_check) and build the review package' },
      { cmd: 'merge', usage: 'merge <id>', text: 'merge a reviewed track, run the gates, set it done' },
    ],
  },
];

/**
 * The short help in lite mode ("mode": "lite", lib/liteMode.js): only the core loop and the owner questions. The other
 * commands still work when typed; `ravenseat help all` lists them.
 */
const LITE_GROUPS = [
  {
    title: 'Get started',
    commands: [
      { cmd: 'init', usage: 'init --lite', text: 'create the queue (run once)' },
      { cmd: 'add', usage: 'add "<what to do>"', text: 'add a task; only a title is needed' },
      { cmd: 'show', usage: 'show', text: 'what runs, what can start, and the counts' },
    ],
  },
  {
    title: 'Run it (or let /ravenseat:queue do it)',
    commands: [
      { cmd: 'fill', usage: 'fill --scratchpad <dir>', text: 'start the next tasks as agents' },
      { cmd: 'receive', usage: 'receive <id>', text: 'take in a finished task' },
      { cmd: 'merge', usage: 'merge <id>', text: 'merge it and mark it done' },
    ],
  },
  {
    title: 'Waiting on you',
    commands: [
      { cmd: 'decide', usage: 'decide', text: 'everything waiting on you (or /ravenseat:decide)' },
      { cmd: 'question', usage: 'question', text: 'the questions the agents have for you' },
      { cmd: 'resolve', usage: 'resolve <q> --answer "..."', text: 'answer one; the waiting tasks go on' },
    ],
  },
];

/** The command words queue.mjs dispatches on (`command === '...'`); the test keeps this list in step with queue.mjs. */
const QUEUE_COMMANDS = [
  'activeOnes', 'add', 'approve', 'area', 'areas', 'ask', 'attempt', 'batch', 'board-setting', 'block', 'blockers', 'calibrate', 'cancel', 'capacity', 'checks', 'classify', 'cloud', 'cloud-bundles',
  'cloud-package', 'compact', 'conflicts', 'continue', 'cost', 'decide', 'deliver', 'deliveries', 'diagnose', 'doctor', 'edit', 'edit-many', 'explain', 'external',
  'fill', 'finding', 'focus', 'follow', 'forecast', 'gate', 'guards', 'guidance', 'handover', 'helpers', 'info', 'init', 'inspection', 'instructions', 'kickstart', 'limit', 'machine', 'merge', 'migr', 'mode', 'next', 'next-migr',
  'orchestrator', 'owner-log', 'park', 'pick', 'pickable', 'plan', 'project', 'projects', 'proposals', 'pulse-check', 'qa', 'question', 'rank', 'receive',
  'release', 'resolutions', 'resolve', 'resume', 'set', 'settings', 'show', 'start', 'state', 'surface', 'trackFile', 'triage', 'unblock', 'undo', 'unlock', 'wait', 'wiring',
];

/** Short names ravenseat.mjs maps to a script file (ravenseat board = queue-board.mjs). */
const ALIASES = { queue: 'queue', board: 'queue-board', takeover: 'queue-takeover' };

/** Scripts the other scripts start by themselves (or Claude Code does): listed only under "Internal" in `ravenseat help all`. */
const INTERNAL_SCRIPTS = ['context-measure', 'cost-guard-statistics', 'make-mission', 'make-queue-common', 'statusline'];

/**
 * The short grouped help, as lines. `ravenseat` is the command to show (ravenseat, or node scripts/orchestrator/ravenseat.mjs).
 * `lite`: the core commands only (LITE_GROUPS) and one line on how to switch to full mode.
 */
function shortHelp(ravenseat = 'ravenseat', { lite = false } = {}) {
  const groups = lite ? LITE_GROUPS : GROUPS;
  const all = groups.flatMap((g) => g.commands);
  const width = Math.max(...all.map((c) => `${ravenseat} ${c.usage}`.length)) + 2;
  const out = [lite ? 'ravenseat: the work queue for Claude Code (lite mode).' : 'ravenseat: the work queue for Claude Code.', ''];
  for (const g of groups) {
    out.push(`${g.title}:`);
    for (const c of g.commands) out.push(`  ${`${ravenseat} ${c.usage}`.padEnd(width)}${c.text}`);
    out.push('');
  }
  if (lite) out.push(require('./liteMode.js').switchLine(ravenseat));
  else out.push(`More: ${ravenseat} help all (every command), ${ravenseat} help <command> (one command in full).`);
  return out;
}

const QUEUE_LINE = /^\/\/\s+node scripts\/orchestrator\/queue\.mjs\s+(\S+)/;

/**
 * The usage blocks in the comment at the top of queue.mjs: each `node scripts/orchestrator/queue.mjs <command> ...` line
 * with the indented continuation lines under it (the old filter dropped many of them, so descriptions stopped
 * mid-sentence). Returns [{ command, lines }] with `// ` removed and the long path replaced by `ravenseat`.
 */
function usageBlocks(source, ravenseat = 'ravenseat') {
  const blocks = [];
  let current = null;
  for (const l of String(source).split(/\r?\n/)) {
    const m = QUEUE_LINE.exec(l);
    if (m) {
      current = { command: m[1], lines: [] };
      blocks.push(current);
    } else if (!(current && /^\/\/\s{4,}\S/.test(l))) {
      // A blank comment line, prose (3 spaces) or code ends the block.
      current = null;
      continue;
    }
    current.lines.push(l.replace(/^\/\/ ?/, '').replace('node scripts/orchestrator/queue.mjs', ravenseat));
  }
  return blocks;
}

/** The header comment of a script (between the first two `// ====` lines), without `// `. */
function scriptHeader(source) {
  const lines = String(source).split(/\r?\n/);
  const start = lines.findIndex((l) => /^\/\/ =+/.test(l));
  if (start < 0) return [];
  const out = [];
  for (const l of lines.slice(start + 1)) {
    if (/^\/\/ =+/.test(l) || !l.startsWith('//')) break;
    out.push(l.replace(/^\/\/ ?/, ''));
  }
  return out;
}

/**
 * `ravenseat help all`: the scripts users run, the queue commands in full, and the internal scripts under their own heading.
 * `scripts` = the script names ravenseat.mjs finds (without hooks and ravenseat itself).
 */
function fullHelp(source, scripts, ravenseat = 'ravenseat') {
  const visible = scripts.filter((s) => !INTERNAL_SCRIPTS.includes(s) && s !== 'queue');
  const internal = scripts.filter((s) => INTERNAL_SCRIPTS.includes(s));
  return [
    'ravenseat: the work queue for Claude Code. Every command (the short list: ravenseat help).',
    '',
    `Scripts: ${ravenseat} <script> [args], one of: ${visible.join(', ')}`,
    `  (${ravenseat} board = queue-board, ${ravenseat} takeover = queue-takeover; ${ravenseat} help <script> shows its header)`,
    '',
    'Queue commands (from the top of queue.mjs):',
    ...usageBlocks(source, ravenseat).flatMap((b) => b.lines),
    '',
    `Internal (started by the other scripts or by Claude Code, not by hand): ${internal.join(', ')}`,
  ];
}

/** The lines of one queue command, or null when queue.mjs has no usage line for it. */
function commandHelp(source, command, ravenseat = 'ravenseat') {
  const lines = usageBlocks(source, ravenseat)
    .filter((b) => b.command === command)
    .flatMap((b) => b.lines);
  return lines.length ? lines : null;
}

/** Optimal string alignment distance (Levenshtein plus swapping two neighbors, so "shwo" -> "show" is 1). */
function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/**
 * The known commands closest to `word`, best first (at most `max`). A candidate counts when it is within edit
 * distance 2 (1 for words of 3 letters or less, so "ad" does not suggest half the list), or when `word` (2 letters or
 * more) is the start of it. Case is ignored. Nothing close gives [].
 */
function suggest(word, candidates, max = 3) {
  const w = String(word ?? '').toLowerCase();
  if (!w) return [];
  const limit = w.length <= 3 ? 1 : 2;
  const scored = [];
  for (const c of new Set(candidates)) {
    const k = c.toLowerCase();
    if (k === w) return [c];
    const dist = editDistance(w, k);
    const score = dist <= limit ? dist : w.length >= 2 && k.startsWith(w) ? limit + 0.5 : null;
    if (score !== null) scored.push({ c, score });
  }
  return scored
    .sort((x, y) => x.score - y.score || x.c.localeCompare(y.c))
    .slice(0, max)
    .map((x) => x.c);
}

/** `Unknown command "shwo". Did you mean "show"? See ravenseat help.` (without the middle part when nothing is close). */
function unknownCommandMessage(word, candidates, ravenseat = 'ravenseat') {
  const hits = suggest(word, candidates).map((h) => `"${h}"`);
  // "a", "a" or "b", "a", "b" or "c".
  const list = hits.length > 1 ? `${hits.slice(0, -1).join(', ')} or ${hits[hits.length - 1]}` : hits[0];
  const mean = hits.length ? ` Did you mean ${list}?` : '';
  return `Unknown command "${word}".${mean} See ${ravenseat} help.`;
}

/** Every word ravenseat accepts as a command: the queue commands, the aliases, the scripts and help. */
function knownCommands(scripts = []) {
  return [...QUEUE_COMMANDS, ...Object.keys(ALIASES), ...scripts, 'help'];
}

module.exports = {
  GROUPS,
  LITE_GROUPS,
  QUEUE_COMMANDS,
  ALIASES,
  INTERNAL_SCRIPTS,
  shortHelp,
  usageBlocks,
  scriptHeader,
  fullHelp,
  commandHelp,
  editDistance,
  suggest,
  unknownCommandMessage,
  knownCommands,
};
