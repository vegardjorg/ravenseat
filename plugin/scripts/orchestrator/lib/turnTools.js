// =============================================================
// turnTools.js: the "Turns and tools" block in `ravenseat cost`: how the agents and the orchestrator session spend
// their turns, so a change to how they work (waiting, reading, handing over) can be measured before and after.
// See docs/costs.md ("Turns and tools").
//
// The turns come from the ONE transcript reader, lib/timeCost.js analyzeTranscript with { detail: true } (no second
// parser). Per group (the orchestrator session, other main sessions, and each subagent type) over the cost window:
//   1. CALLS PER TURN: the tool calls in each model turn (a turn = one message id); median and p90 over all turns in the
//      window (a closing text turn counts as 0), and the share of turns with a call that have more than one (parallel).
//   2. SERIAL SINGLE READS: a turn whose calls are all reads is a read turn; a turn with exactly one call that is a read
//      is a single read. A run is consecutive single-read turns; runs of RUN_MIN (3) or more are the "could have been
//      one turn" signal: their turns as a share of all read turns. A read is Read, Grep, Glob, LS, NotebookRead, or Bash
//      whose every command is a reading one (readOnlyBash: cat, head, tail, grep, rg, ls, wc, sed -n, find without
//      -delete, git log/show/diff/status ...; no output redirection, nothing the shell reading cannot see into).
//   3. TOOL OUTPUT: the characters of each tool_result's text (images add nothing), per tool name: count, total and
//      median; top 5 by total. About 4 characters per token (an approximation, never billed tokens).
//   4. CONTEXT THRESHOLD: each turn's context (input + cache read + cache write, as timeCost counts it) against
//      cost.contextThresholdK thousand tokens; the turns' cost (timeCost.costUsd per turn) above and below it.
//   5. NOTIFICATION TURNS: the turns whose last real prompt was a background task notification (timeCost.isNotification),
//      the notifications themselves (episodes) and the turns' cost share: what waking up after a background wait cost.
//   6. ANOTHER REPO (otherRepoCheck): a main session whose tool calls mostly point outside the project. CONSERVATIVE on
//      purpose, it only has to catch a session that clearly did its work elsewhere:
//        - only calls with a path count: file_path / path / notebook_path of a tool, and the absolute paths in a Bash or
//          PowerShell command. A relative path in a file tool counts as inside (it resolves under the session's
//          directory, which is the project's); a shell command without an absolute path does not count at all (its
//          directory can be anywhere after a `cd`);
//        - a call is inside when any of its paths is under a project root (the main tree and its worktrees), else
//          outside when a path is outside and not neutral (temp folders, the Claude config folder, /dev; a neutral
//          folder that holds the project itself is not neutral);
//        - another repo = at least MIN_PATH_CALLS such calls, at least MIN_OUTSIDE_SHARE of them outside, and one
//          other root (the outside path cut to the depth of the project root, so a sibling folder) holding at least
//          half of the outside calls.
//      Such a session is listed apart with its cost and left out of the groups (and, in cli/cost.mjs, of the
//      orchestration totals), never mixed into this project's figures. Its subagents stay where the time log put them.
//
// Measurement only: nothing here stops the queue. Pure functions without I/O (cli/cost.mjs reads the transcripts).
// Tested in lib/__tests__/turnTools.test.ts.
// =============================================================
'use strict';

const TK = require('./timeCost.js');
const SC = require('./shellCommands.js');

/** A run of this many single-read turns or more is a serial run. */
const RUN_MIN = 3;
/** The other-repo heuristic: minimum path calls, minimum outside share, and the share one other root must hold. */
const MIN_PATH_CALLS = 10;
const MIN_OUTSIDE_SHARE = 0.6;
const MIN_ROOT_SHARE = 0.5;
/** The default context threshold in thousands of tokens (cost.contextThresholdK). */
const DEFAULT_THRESHOLD_K = 200;
/** Characters per token for the approximate token figure of the tool output. */
const CHARS_PER_TOKEN = 4;
const TOP_TOOLS = 5;

const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead']);
/** Shell commands that only read. `sed` needs -n and no -i; `find` no -delete; git only its reading subcommands. */
const READ_WORDS = new Set(['cat', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'ls', 'wc', 'file', 'stat', 'tree', 'less', 'more', 'sed', 'find', 'git']);
/** Commands that change nothing and read nothing themselves: allowed next to a read, never one alone. */
const NEUTRAL_WORDS = new Set(['cd', 'pwd', 'echo', 'true', 'sort', 'uniq', 'cut', 'tr', 'nl', 'column']);
const GIT_READ = new Set(['log', 'show', 'diff', 'status', 'blame', 'grep', 'ls-files', 'rev-parse', 'branch', 'describe']);

const round1 = (x) => Math.round(x * 10) / 10;
const pct = (part, all) => (all > 0 ? round1((part / all) * 100) : 0);

/**
 * True when a shell command line only reads (see the header). Unknown or unreadable = false (not a read).
 * @param {string} command
 */
function readOnlyBash(command) {
  const cmd = String(command ?? '');
  if (!cmd.trim()) return false;
  // An output redirection writes a file; the harmless ones (2>&1, >/dev/null, 2>nul) are taken out first.
  const plain = cmd
    .replace(/"[^"]*"|'[^']*'/g, '""')
    .replace(/\d?>&\d/g, '')
    .replace(/(?:\d|&)?>>?\s*(?:\/dev\/null|nul)\b/gi, '');
  if (/>/.test(plain)) return false;
  let list;
  try {
    list = SC.commandList(cmd);
  } catch {
    return false; // error-ignored: an unreadable command is not counted as a read
  }
  if (list.unsure.length || !list.commands.length) return false;
  let reads = 0;
  for (const c of list.commands) {
    if (c.opaque) return false;
    const args = c.t.slice(c.i0 + 1);
    if (NEUTRAL_WORDS.has(c.word)) continue;
    if (!READ_WORDS.has(c.word)) return false;
    if (c.word === 'sed' && (!args.some((x) => /^-[a-z]*n[a-z]*$/i.test(x)) || args.some((x) => /^(?:-[a-z]*i|--in-place)/.test(x))))
      return false;
    if (c.word === 'find' && args.some((x) => /^-(?:delete|exec|execdir|ok|okdir|fprint|fprintf|fls)$/.test(x))) return false;
    if (c.word === 'git' && !GIT_READ.has(SC.gitInvocation(c.t, c.i0)?.sub)) return false;
    reads++;
  }
  return reads > 0;
}

/** True for a read call (Read, Grep, Glob ... or a reading Bash command). */
function isReadCall(c) {
  if (READ_TOOLS.has(c?.name)) return true;
  if (c?.name === 'Bash') return readOnlyBash(c.input?.command);
  return false;
}

/** The cost of one turn's usage at its model's price (the same rules as the transcript total). */
function turnUsd(t) {
  const tokens = TK.emptyTokens();
  TK.addUsage(tokens, t.usage ?? {});
  return TK.costUsd(tokens, t.model ?? TK.DEFAULT_MODEL);
}
const contextOf = (u) => (u?.input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0);

/** An empty accumulator (mergeStats adds two). */
function emptyStats() {
  return {
    transcripts: 0,
    turns: 0,
    hist: {},
    toolTurns: 0,
    parallelTurns: 0,
    readTurns: 0,
    runs: 0,
    runTurns: 0,
    tools: {},
    usd: 0,
    above: { turns: 0, usd: 0 },
    below: { turns: 0, usd: 0 },
    notif: { episodes: 0, turns: 0, usd: 0 },
  };
}

/**
 * The raw counts of one transcript's turns in [from, to) (analyzeTranscript(..., { detail: true }).detail).
 * @param {{ turns: object[], resultChars: Record<string, number> }} detail
 * @param {{ from?: number, to?: number, thresholdTokens?: number }} [o]
 */
function transcriptStats(detail, { from = -Infinity, to = Infinity, thresholdTokens = DEFAULT_THRESHOLD_K * 1000 } = {}) {
  const s = emptyStats();
  s.transcripts = 1;
  const episodes = new Set();
  let run = 0;
  const close = () => {
    if (run >= RUN_MIN) {
      s.runs++;
      s.runTurns += run;
    }
    run = 0;
  };
  for (const t of detail?.turns ?? []) {
    if (!(t.ts != null && t.ts >= from && t.ts < to)) {
      close();
      continue;
    }
    const calls = t.calls ?? [];
    const usd = turnUsd(t);
    s.turns++;
    s.usd += usd;
    s.hist[calls.length] = (s.hist[calls.length] ?? 0) + 1;
    if (calls.length) s.toolTurns++;
    if (calls.length > 1) s.parallelTurns++;
    const reads = calls.filter(isReadCall).length;
    if (calls.length && reads === calls.length) s.readTurns++;
    if (calls.length === 1 && reads === 1) run++;
    else close();
    const side = contextOf(t.usage) > thresholdTokens ? s.above : s.below;
    side.turns++;
    side.usd += usd;
    if (t.origin === 'notification') {
      s.notif.turns++;
      s.notif.usd += usd;
      episodes.add(t.prompt);
    }
    for (const c of calls) {
      const n = detail.resultChars?.[c.id];
      if (n == null) continue;
      const x = (s.tools[c.name] ??= { results: 0, chars: 0, sizes: [] });
      x.results++;
      x.chars += n;
      x.sizes.push(n);
    }
  }
  close();
  s.notif.episodes = episodes.size;
  return s;
}

/** a + b (a new accumulator). */
function mergeStats(a, b) {
  const s = emptyStats();
  for (const x of [a, b]) {
    if (!x) continue;
    for (const k of ['transcripts', 'turns', 'toolTurns', 'parallelTurns', 'readTurns', 'runs', 'runTurns', 'usd']) s[k] += x[k];
    for (const [n, c] of Object.entries(x.hist)) s.hist[n] = (s.hist[n] ?? 0) + c;
    for (const side of ['above', 'below']) {
      s[side].turns += x[side].turns;
      s[side].usd += x[side].usd;
    }
    for (const k of ['episodes', 'turns', 'usd']) s.notif[k] += x.notif[k];
    for (const [name, t] of Object.entries(x.tools)) {
      const y = (s.tools[name] ??= { results: 0, chars: 0, sizes: [] });
      y.results += t.results;
      y.chars += t.chars;
      y.sizes.push(...t.sizes);
    }
  }
  return s;
}

/** The value at quantile q (nearest rank) of a histogram { value: count }. */
function quantile(hist, q) {
  const pairs = Object.entries(hist)
    .map(([v, c]) => [Number(v), c])
    .sort((a, b) => a[0] - b[0]);
  const n = pairs.reduce((x, [, c]) => x + c, 0);
  if (!n) return null;
  const rank = Math.max(1, Math.ceil(q * n));
  let seen = 0;
  for (const [v, c] of pairs) {
    seen += c;
    if (seen >= rank) return v;
  }
  return pairs[pairs.length - 1][0];
}
function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** The figures of an accumulator (the JSON shape of one group). */
function summarize(s, { thresholdK = null } = {}) {
  const k = thresholdK ?? DEFAULT_THRESHOLD_K;
  const top = Object.entries(s.tools)
    .map(([name, t]) => ({
      name,
      results: t.results,
      chars: t.chars,
      median_chars: median(t.sizes),
      approx_tokens: Math.round(t.chars / CHARS_PER_TOKEN),
    }))
    .sort((a, b) => b.chars - a.chars || a.name.localeCompare(b.name))
    .slice(0, TOP_TOOLS);
  return {
    transcripts: s.transcripts,
    turns: s.turns,
    usd: s.usd,
    calls_per_turn: { median: quantile(s.hist, 0.5), p90: quantile(s.hist, 0.9) },
    tool_turns: s.toolTurns,
    parallel_pct: pct(s.parallelTurns, s.toolTurns),
    serial: { runs: s.runs, turns_in_runs: s.runTurns, read_turns: s.readTurns, pct: pct(s.runTurns, s.readTurns) },
    tool_output: { unit: 'chars', chars_per_token: CHARS_PER_TOKEN, top },
    context: {
      threshold_k: k,
      above_turns: s.above.turns,
      below_turns: s.below.turns,
      above_usd: s.above.usd,
      below_usd: s.below.usd,
      above_pct: pct(s.above.usd, s.usd),
    },
    notifications: { episodes: s.notif.episodes, turns: s.notif.turns, usd: s.notif.usd, pct: pct(s.notif.usd, s.usd) },
  };
}

// ---- 6. Another repo ----------------------------------------------------------------------------------------------

/** A path in one form for comparing: forward slashes, `/c/x` as `c:/x`, no trailing slash, lower case on a drive. */
function normPath(p) {
  let n = String(p ?? '').trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  n = n.replace(/^\/([a-zA-Z])(?=\/|$)/, '$1:');
  if (n.length > 1) n = n.replace(/\/$/, '');
  return /^[a-z]:/i.test(n) ? n.toLowerCase() : n;
}
const isAbsolute = (n) => /^[a-z]:\//.test(n) || n.startsWith('/');
const under = (n, root) => n === root || n.startsWith(`${root}/`);

/** The absolute paths in a shell command (Windows drive paths and POSIX paths that start a word). */
function commandPaths(command) {
  const out = [];
  const re = /(?:^|[\s"'=(])((?:[A-Za-z]:[\\/]|\/)[^\s"'|;&<>()]*)/g;
  let m;
  while ((m = re.exec(String(command ?? '')))) if (m[1].length > 1) out.push(m[1]);
  return out;
}

/** The paths a call points at, normalized, and whether they were relative. */
function callPaths(c) {
  const input = c?.input ?? {};
  if (c?.name === 'Bash' || c?.name === 'PowerShell') return commandPaths(input.command).map(normPath);
  return ['file_path', 'path', 'notebook_path']
    .map((k) => input[k])
    .filter((v) => typeof v === 'string' && v.trim())
    .map(normPath);
}

/**
 * Did this main session work in another repo? (the rule is in the header, point 6)
 * @param {{ turns: object[] }} detail
 * @param {{ roots: string[], neutral?: string[], minCalls?: number, minShare?: number }} o
 * @returns {{ other: boolean, inside: number, outside: number, considered: number, outside_pct: number, root: string|null }}
 */
function otherRepoCheck(detail, { roots, neutral = [], minCalls = MIN_PATH_CALLS, minShare = MIN_OUTSIDE_SHARE } = {}) {
  const rs = (roots ?? []).map(normPath).filter(Boolean);
  // A neutral folder that holds the project itself (a project under the temp folder) is not neutral.
  const ns = [...(neutral ?? []), '/tmp', '/dev', '/proc']
    .map(normPath)
    .filter((x) => x && !rs.some((r) => under(r, x)));
  const depth = rs.length ? rs[0].split('/').length : 0;
  let inside = 0;
  let outside = 0;
  const perRoot = new Map();
  for (const t of detail?.turns ?? []) {
    for (const c of t.calls ?? []) {
      const paths = callPaths(c);
      if (!paths.length) continue;
      const shell = c.name === 'Bash' || c.name === 'PowerShell';
      // A relative path in a file tool resolves under the session's own directory: inside.
      if (paths.some((p) => (!shell && !isAbsolute(p)) || rs.some((r) => under(p, r)))) {
        inside++;
        continue;
      }
      const away = paths.filter((p) => isAbsolute(p) && !ns.some((x) => under(p, x)));
      if (!away.length) continue;
      outside++;
      const root = away[0].split('/').slice(0, Math.max(depth, 1)).join('/') || away[0];
      perRoot.set(root, (perRoot.get(root) ?? 0) + 1);
    }
  }
  const considered = inside + outside;
  const [root, n] = [...perRoot.entries()].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
  const other = considered >= minCalls && outside / considered >= minShare && n >= MIN_ROOT_SHARE * outside;
  return { other, inside, outside, considered, outside_pct: pct(outside, considered), root: other ? root : null };
}

// ---- The report ---------------------------------------------------------------------------------------------------

/** The group order: the orchestrator, the other main sessions, then the agent types by cost. */
const GROUP_RANK = { orchestrator: 0, 'main session': 1 };

/**
 * The whole block: per group the figures over [from, to), and the main sessions that worked in another repo apart.
 * @param {{ transcripts: Iterable<{ group: string, session: string|null, main: boolean, detail: object }>, roots: string[],
 *   neutral?: string[], thresholdK?: number, from?: number, to?: number, sessionUsd?: Map<string, number>,
 *   scan?: object }} x  sessionUsd = a main session's cost in the window from the status line, when recorded
 */
function turnsAndTools({ transcripts, roots, neutral = [], thresholdK = DEFAULT_THRESHOLD_K, from = -Infinity, to = Infinity, sessionUsd = new Map(), scan = null }) {
  const thresholdTokens = thresholdK * 1000;
  const groups = new Map();
  const otherRepo = [];
  for (const tr of transcripts ?? []) {
    const stats = transcriptStats(tr.detail, { from, to, thresholdTokens });
    if (tr.main) {
      const o = otherRepoCheck(tr.detail, { roots, neutral });
      if (o.other) {
        const fromLine = sessionUsd.get(tr.session);
        otherRepo.push({
          session: tr.session,
          group: tr.group,
          root: o.root,
          outside: o.outside,
          considered: o.considered,
          usd: fromLine ?? stats.usd,
          usd_source: fromLine != null ? 'status line' : 'transcript',
          turns: stats.turns,
        });
        continue;
      }
    }
    if (!stats.turns) continue;
    groups.set(tr.group, mergeStats(groups.get(tr.group), stats));
  }
  return {
    threshold_k: thresholdK,
    scan,
    groups: [...groups.entries()]
      .map(([group, s]) => ({ group, ...summarize(s, { thresholdK }) }))
      .sort((a, b) => (GROUP_RANK[a.group] ?? 2) - (GROUP_RANK[b.group] ?? 2) || b.usd - a.usd || a.group.localeCompare(b.group)),
    otherRepo: otherRepo.sort((a, b) => b.usd - a.usd),
  };
}

/** 1234 -> "1.2k", 1234567 -> "1.2M". */
function short(x) {
  const n = Number(x) || 0;
  if (n >= 1e6) return `${round1(n / 1e6)}M`;
  if (n >= 1e3) return `${round1(n / 1e3)}k`;
  return String(Math.round(n));
}
const usd = (x) => `$${Number(x).toFixed(2)}`;

/** The compact "Turns and tools" lines for `ravenseat cost`. */
function turnsToolsLines(rep, label) {
  const sc = rep.scan;
  const head =
    `Turns and tools (${label}; tool output in characters, about ${CHARS_PER_TOKEN} per token` +
    (sc ? `; ${sc.files} transcript(s), ${short(sc.bytes)}B read${sc.skipped ? `, ${sc.skipped} skipped over the read budget` : ''}` : '') +
    '):';
  if (!rep.groups.length && !rep.otherRepo.length) return [`${head} no turns in the window.`];
  const out = [head];
  for (const g of rep.groups) {
    const c = g.calls_per_turn;
    const pad = `  ${''.padEnd(16)} `;
    out.push(
      `  ${g.group.padEnd(16)} ${short(g.turns)} turns: calls/turn median ${c.median ?? '?'}, p90 ${c.p90 ?? '?'}; ` +
        `parallel ${g.parallel_pct} %; serial single reads ${g.serial.runs} run(s), ${g.serial.pct} % of read turns`,
    );
    out.push(
      `${pad}cost ${usd(g.usd)}: above ${g.context.threshold_k}k context ${g.context.above_pct} %; ` +
        `after notifications ${g.notifications.pct} % (${g.notifications.turns} turns, ${g.notifications.episodes} notifications)`,
    );
    if (g.tool_output.top.length)
      out.push(
        `${pad}output: ` +
          g.tool_output.top.map((t) => `${t.name} ${short(t.chars)} (median ${short(t.median_chars)})`).join(', '),
      );
  }
  for (const o of rep.otherRepo)
    out.push(
      `  worked in another repo (left out of this project's totals): session ${String(o.session).slice(0, 8)} in ` +
        `${o.root}, ${o.outside} of ${o.considered} path calls outside, ${usd(o.usd)} (${o.usd_source})`,
    );
  return out;
}

module.exports = {
  RUN_MIN,
  MIN_PATH_CALLS,
  MIN_OUTSIDE_SHARE,
  DEFAULT_THRESHOLD_K,
  CHARS_PER_TOKEN,
  readOnlyBash,
  isReadCall,
  emptyStats,
  transcriptStats,
  mergeStats,
  summarize,
  normPath,
  commandPaths,
  otherRepoCheck,
  turnsAndTools,
  turnsToolsLines,
};
