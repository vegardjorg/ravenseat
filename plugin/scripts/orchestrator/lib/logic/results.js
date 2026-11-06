// =============================================================
// logic/results.js: the RESULT and FINDINGS lines, the transcripts, the cost per task and the review package.
//
// parseResult, parseFindings and batchFindings; lastAnswer, firstUserMessage and mentionsTask; taskAgentTypes,
// agentsForTask, sumCost and costStatistics (lib/timeCost.js); packageFiles, dbObjectsFromDiff, reviewPackageIndex and
// reviewerPrompt (`queue.mjs receive`).
//
// Part of the queueLogic.js split: lib/queueLogic.js re-exports every name, so callers keep requiring queueLogic.js.
// Used by queueLogic.js (the facade) and by logic/resume.js.
// Tested in lib/__tests__/queueOrchestrator.test.ts and queueHelpers.test.ts (through queueLogic.js).
// =============================================================

const { cfg, baseBranch, queueBranch, WEIGHT, regexSafe, round2 } = require('./base.js');
const { reviewerTypes } = require('./agents.js');
const TK = require('../timeCost.js');

// ---- RESULT and FINDINGS lines ------------------------------------------------------------------------------

/**
 * Finds the first line that starts with `word` (RESULT or FINDINGS). Tolerant: markdown characters (`*`, backtick, `>`,
 * `#`, `-`) around the line and a colon after the word are accepted.
 * @returns {{ line: string, rest: string } | null}
 */
function fixedLine(text, word) {
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const l = raw
      .replace(/[`*]/g, '')
      .replace(/^[\s>#-]+/, '')
      .trim();
    if (l === word || l.startsWith(`${word} `) || l.startsWith(`${word}:`))
      return {
        line: l,
        rest: l.slice(word.length).replace(/^:/, '').trim(),
      };
  }
  return null;
}

/** The `key=value` pairs in the rest of a fixed line; the keys in lowercase. */
function keyValues(rest) {
  const out = {};
  // Keys are lowercased, so camelCase keys (ownerQuestions) are read as lowercase (ownerquestions).
  for (const m of String(rest).matchAll(/([A-Za-z\u00C6\u00D8\u00C5\u00E6\u00F8\u00E5_]+)=(\S*)/g)) out[m[1].toLowerCase()] = m[2];
  return out;
}

/** At most this much of a report's owner questions is printed. */
const QUESTION_TEXT_MAX = 1500;

const numberOrNull = (v) => (v != null && /^\d+$/.test(v) ? Number(v) : null);

/**
 * The track's RESULT line, e.g. `RESULT status=DONE branch=queue/X commits=3 migr=3490-3492 gates=OK
 * probe=red→green(12/12) ownerQuestions=0 edge=-` (`probe`: the tests red before and green after; `edge`: deploy after
 * the merge, `-` = none). Missing line: null (the caller falls back to the current behavior).
 * @returns {null | { line: string, status: string|null, branch: string|null, commits: number|null, migr: string|null,
 *   gates: string|null, probe: string|null, ownerQuestions: number|null, edge: string|null, extra: object }}
 */
function parseResult(text) {
  const f = fixedLine(text, 'RESULT');
  if (!f) return null;
  const kv = keyValues(f.rest);
  const known = ['status', 'branch', 'commits', 'migr', 'gates', 'probe', 'ownerquestions', 'edge'];
  const extra = {};
  for (const [k, v] of Object.entries(kv)) if (!known.includes(k)) extra[k] = v;
  return {
    line: f.line,
    status: kv.status ? kv.status.toUpperCase() : null,
    branch: kv.branch ?? null,
    commits: numberOrNull(kv.commits),
    migr: kv.migr ?? null,
    gates: kv.gates ?? null,
    probe: kv.probe ?? null,
    ownerQuestions: numberOrNull(kv.ownerquestions),
    edge: kv.edge ?? null,
    extra,
  };
}

/** The text under the "Owner questions" heading of a report (up to the next heading), or null. */
function ownerQuestionSection(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const start = lines.findIndex((l) => /^\s*(#{1,6}\s*|\*\*)?owner questions?\b/i.test(l));
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^\s*#{1,6}\s/.test(l));
  const body = (end < 0 ? rest : rest.slice(0, end)).join('\n').trim();
  return body && !/^[-*\s]*(none|-)?\.?$/i.test(body) ? body.slice(0, QUESTION_TEXT_MAX) : null;
}

/**
 * The owner questions a track says it has (`ownerQuestions=<n>` on the RESULT line), for the output and the card in ravenseat
 * decide. null when it says it has none: the number decides, since a report often has the heading with "none" under it.
 * @returns {null | { count: number, text: string|null, note: string }}
 */
function trackQuestion({ result, reportText = null, reply = null }) {
  const count = result?.ownerQuestions ?? 0;
  if (!count) return null;
  const text = ownerQuestionSection(reportText) ?? ownerQuestionSection(reply);
  const first = text?.split(/\r?\n/).map((l) => l.replace(/^[\s*\-\d.)]+/, '').trim()).find(Boolean);
  return { count, text, note: first ?? `${count} owner question(s) in the track's report` };
}

/**
 * The reviewer's FINDINGS line, e.g. `FINDINGS H=0 M=1 L=3 deferrable=L2,L3`. Missing line: null. A missing number
 * becomes 0 when at least one of H/M/L is there.
 * @returns {null | { line: string, H: number, M: number, L: number, deferrable: string[] }}
 */
function parseFindings(text) {
  const f = fixedLine(text, 'FINDINGS');
  if (!f) return null;
  const kv = keyValues(f.rest);
  const h = numberOrNull(kv.h);
  const m = numberOrNull(kv.m);
  const l = numberOrNull(kv.l);
  if (h == null && m == null && l == null) return null;
  const u = String(kv.deferrable ?? '').trim();
  return {
    line: f.line,
    H: h ?? 0,
    M: m ?? 0,
    L: l ?? 0,
    deferrable:
      !u || u === '-'
        ? []
        : u
            .split(',')
            .map((x) => x.trim())
            .filter(Boolean),
  };
}

/** The sum of the review reports' FINDINGS lines (one per reviewer and round). No lines: null. */
function batchFindings(list) {
  const validOnes = (list ?? []).filter(Boolean);
  if (!validOnes.length) return null;
  const out = { H: 0, M: 0, L: 0, deferrable: [], reports: validOnes.length };
  for (const f of validOnes) {
    out.H += f.H;
    out.M += f.M;
    out.L += f.L;
    for (const x of f.deferrable) if (!out.deferrable.includes(x)) out.deferrable.push(x);
  }
  return out;
}

// ---- The transcripts (the track's and the reviewer's last answer) ----------------------------------------------------------

/** The lines in an agent transcript (JSONL) as objects; broken lines are skipped. */
function transcriptRows(text) {
  const out = [];
  for (const l of String(text ?? '').split('\n')) {
    if (!l.trim()) continue;
    try {
      out.push(JSON.parse(l));
    } catch {
      /* half line (the transcript is written while we read) */
    }
  }
  return out;
}

/**
 * The agent's last answer: the last text from the assistant, or the message in a SubagentHandback call (the report
 * is delivered that way when the agent has that tool). Null when the transcript has no answer.
 */
function lastAnswer(text) {
  let last = null;
  for (const r of transcriptRows(text)) {
    if (r.type !== 'assistant' || !Array.isArray(r.message?.content)) continue;
    for (const c of r.message.content) {
      if (c?.type === 'text' && String(c.text ?? '').trim()) last = c.text;
      else if (c?.type === 'tool_use' && c.name === 'SubagentHandback' && c.input?.message)
        last = c.input.message;
    }
  }
  return last;
}

/** The first user message in a transcript (the mission the agent got). */
function firstUserMessage(text) {
  for (const r of transcriptRows(text)) {
    if (r.type !== 'user' || !r.message) continue;
    const m = r.message.content;
    if (typeof m === 'string') return m;
    if (Array.isArray(m)) return m.map((c) => c?.text ?? '').join(' ');
  }
  return null;
}

/**
 * Does the text mention the task id as a whole word? `A-1b` is found in "queue/A-1b" and "A-1b-r2", but not in "A-1b2" or
 * "XA-1b".
 */
function mentionsTask(text, id) {
  return new RegExp(`(^|[^A-Za-z0-9-])${regexSafe(id)}(?![A-Za-z0-9])`).test(String(text ?? ''));
}

// ---- Cost per task ---------------------------------------------------------------------------------------

/** The agent types that count toward a task: tracks and the reviewers (from the setup). */
const taskAgentTypes = () => ['track', 'track-d', ...reviewerTypes()];

/**
 * The agents in the time log (config().timeLog, written by hook-time.mjs from the transcripts) that belong to the
 * task. `secure`: the track label is the task or a fix round of it (timeCost.taskIdFor). `uncertainOnes`: agents
 * without a recognized track label (the label is the agent id) of the types track, track-d and the reviewers, that stopped after `from`
 * and started before `to`; the caller keeps them only when their mission mentions the task (mentionsTask).
 * The rows are cumulative; the last row with tokens per agent is the agent's total usage.
 * @returns {{ secure: {agent: string, type: string, row: object}[], uncertainOnes: {agent: string, type: string, row: object}[] }}
 */
function agentsForTask(rows, id, { from = null, to = null } = {}) {
  const last = new Map();
  const first = new Map();
  const types = new Map();
  for (const r of rows ?? []) {
    if (!r?.agent_id) continue;
    const t = Date.parse(r.time);
    if (!first.has(r.agent_id) || t < first.get(r.agent_id)) first.set(r.agent_id, t);
    if (r.agent_type) types.set(r.agent_id, require('../projectRoot.js').bareAgentType(r.agent_type));
    if (r.event !== 'done' || !r.tokens) continue;
    const f = last.get(r.agent_id);
    if (!f || t >= Date.parse(f.time)) last.set(r.agent_id, r);
  }
  const isId = (s) => s === id;
  const secure = [];
  const uncertainOnes = [];
  for (const [agent, row] of last) {
    const type = types.get(agent) ?? 'unknown';
    const track = row.track ?? null;
    if (track && TK.taskIdFor(track, isId) === id) {
      secure.push({ agent, type, row });
      continue;
    }
    const unknownTrack = !track || agent.startsWith(track);
    if (!unknownTrack || !taskAgentTypes().includes(type)) continue;
    if (from && Date.parse(row.time) < Date.parse(from)) continue;
    if (to && first.get(agent) > Date.parse(to)) continue;
    uncertainOnes.push({ agent, type, row });
  }
  return { secure, uncertainOnes };
}

/**
 * The sum of the usage of the agents that belonged to the task. Each agent has `tokens` and `model` from the transcript
 * (timeCost.analyzeTranscript) or from the last row in the time log; the price is timeCost.costOf (API-equivalent USD,
 * per model when `byModel` is given).
 * @param {{ agent: string, type: string, tokens: object, model?: string|null, byModel?: object|null, turns?: number, source?: string,
 *   minutes?: number|null, findings?: { H: number, M: number, L: number }|null }[]} agents
 * @returns {{ usd: number, tokens: { input: number, output: number, cache_read: number, cache_written: number,
 *   sum: number }, turns: number, agents: { agent: string, type: string, usd: number, source: string }[],
 *   measured: string }}
 */
function sumCost(agents, now = new Date().toISOString()) {
  const tokens = { input: 0, output: 0, cache_read: 0, cache_written: 0, sum: 0 };
  let usd = 0;
  let turns = 0;
  const list = [];
  for (const a of agents ?? []) {
    // Per model when the agent has byModel (each model at its own price), else its one model (older rows).
    const u = TK.costOf({ tokens: a.tokens, model: a.model ?? null, byModel: a.byModel ?? null });
    usd += u;
    turns += Number(a.turns ?? 0) || 0;
    for (const k of ['input', 'output', 'cache_read', 'cache_written']) {
      const n = Number(a.tokens?.[k] ?? 0) || 0;
      tokens[k] += n;
      tokens.sum += n;
    }
    // Per agent also the tokens, the minutes and (for reviewers) the FINDINGS numbers: the helper measurement
    // (queueHelpers.helperStatistics) reads them from cost.agents. Fields without a value are left out.
    const entry = { agent: a.agent, type: a.type, usd: round2(u), source: a.source ?? 'timeLog' };
    entry.tokens = ['input', 'output', 'cache_read', 'cache_written'].reduce(
      (s, k) => s + (Number(a.tokens?.[k] ?? 0) || 0),
      0,
    );
    if (Number.isFinite(Number(a.minutes)) && a.minutes != null) entry.minutes = Math.round(Number(a.minutes) * 10) / 10;
    if (a.findings) entry.findings = { H: a.findings.H, M: a.findings.M, L: a.findings.L };
    list.push(entry);
  }
  return { usd: round2(usd), tokens, turns, agents: list, measured: now };
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * The statistics `queue.mjs cost` shows: finished tasks with measured cost (since `since`), per class and total, with findings
 * from the review.
 * @returns {{ rows: object[], perClass: object[], total: { n: number, usd: number } }}
 */
function costStatistics(queue, { since = null } = {}) {
  const rows = (queue.tasks ?? [])
    .filter((o) => o.status === 'done' && o.cost && Number.isFinite(Number(o.cost.usd)))
    .filter((o) => !since || Date.parse(o.done ?? o.cost.measured) >= Date.parse(since))
    .map((o) => ({
      id: o.id,
      class: o.class,
      done: o.done ?? null,
      usd: Number(o.cost.usd),
      tokens: Number(o.cost.tokens?.sum ?? 0),
      agents: (o.cost.agents ?? []).length,
      findings: o.findings ?? null,
      result: o.result?.status ?? null,
    }))
    .sort((a, b) => String(b.done).localeCompare(String(a.done)));
  const perClass = Object.keys(WEIGHT)
    .map((cls) => {
      const r = rows.filter((x) => x.class === cls);
      const withFindings = r.filter((x) => x.findings);
      return {
        class: cls,
        n: r.length,
        usd: round2(r.reduce((s, x) => s + x.usd, 0)),
        median_usd: r.length ? round2(median(r.map((x) => x.usd))) : null,
        reviewed: withFindings.length,
        H: withFindings.reduce((s, x) => s + x.findings.H, 0),
        M: withFindings.reduce((s, x) => s + x.findings.M, 0),
        L: withFindings.reduce((s, x) => s + x.findings.L, 0),
      };
    })
    .filter((k) => k.n > 0);
  return {
    rows,
    perClass,
    total: { n: rows.length, usd: round2(rows.reduce((s, x) => s + x.usd, 0)) },
  };
}

// ---- Review package (`queue.mjs receive`) -------------------------------------------------------------------------------

/**
 * Which files the package gets in full version from the branch. `nameStatus` is `git diff --name-status --no-renames`, `numstat`
 * is `git diff --numstat --no-renames` (binary files have "-" in the numbers). Deleted and binary files are skipped.
 * @returns {{ copy: string[], skipped: { path: string, reason: string }[] }}
 */
function packageFiles(nameStatus, numstat) {
  const binary = new Set();
  for (const l of String(numstat ?? '').split(/\r?\n/)) {
    const m = l.match(/^-\t-\t(.+)$/);
    if (m) binary.add(m[1]);
  }
  const copy = [];
  const skipped = [];
  for (const l of String(nameStatus ?? '').split(/\r?\n/)) {
    const m = l.match(/^([A-Z])\d*\t(.+)$/);
    if (!m) continue;
    const [, s, filePath] = m;
    if (s === 'D') skipped.push({ path: filePath, reason: 'deleted' });
    else if (binary.has(filePath)) skipped.push({ path: filePath, reason: 'binary' });
    else copy.push(filePath);
  }
  return { copy, skipped };
}

/**
 * Changed DB objects in the diff: `create`/`alter`/`drop` of function, table, policy, trigger, view, index and type on
 * new lines in .sql files under the migration folder (config().migrations.folder). Policies get the table included when it is
 * on the same line. Without a migration folder: empty list.
 * @param {string} diff
 * @param {{ folder?: string|null }} [migrations]
 * @returns {string[]} e.g. "create function public.foo", "create policy "read" on public.bar"
 */
function dbObjectsFromDiff(diff, migrations = cfg().migrations) {
  const folder = migrations?.folder
    ? String(migrations.folder).replace(/\\/g, '/').replace(/\/+$/, '')
    : null;
  if (!folder) return [];
  const fileRe = new RegExp(`^${regexSafe(folder)}/.+\\.sql$`);
  const out = [];
  let file = null;
  const re =
    /^\+\s*(create|alter|drop)\s+(?:or\s+replace\s+)?(?:unique\s+)?(function|procedure|table|policy|trigger|materialized\s+view|view|index|type)\s+(?:if\s+(?:not\s+)?exists\s+)?(?:concurrently\s+)?("[^"]+"|[\w.]+(?:\."[^"]+")?)(.*)$/i;
  for (const l of String(diff ?? '').split(/\r?\n/)) {
    if (l.startsWith('+++ ')) {
      file = l.replace(/^\+\+\+ (b\/)?/, '');
      continue;
    }
    if (!file || !fileRe.test(file) || l.startsWith('+++')) continue;
    const m = l.match(re);
    if (!m) continue;
    const type = m[2].toLowerCase().replace(/\s+/g, ' ');
    let name = `${m[1].toLowerCase()} ${type} ${m[3]}`;
    if (type === 'policy') {
      const on = m[4].match(/\bon\s+([\w."]+)/i);
      if (on) name += ` on ${on[1]}`;
    }
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * The index file in the review package (`00-package.md`): what the task is, the track's RESULT line, the diff statistics, changed
 * DB objects, the test-weakening warning and which files are in the package. The package is PLAIN FILES (a reviewer without Bash cannot read
 * git objects).
 */
function reviewPackageIndex({
  o,
  branch,
  stat,
  dbObjects = [],
  copied = [],
  skipped = [],
  result = null,
  files = {},
  base = baseBranch(),
  migrFolder = cfg().migrations?.folder ?? null,
  reviewers = null,
  testWeakening = null,
}) {
  const lines = [
    `# Review package ${o.id} (${o.class}): ${o.title ?? ''}`,
    '',
    `Branch \`${branch}\`, diff against \`${base}\` (merge-base).` +
      (migrFolder ? ` Migration block: ${o.migr_block ?? 'none'}.` : ''),
    `Track result line: ${result ? `\`${result.line}\`` : "(missing; see the track's answer and report)"}`,
    '',
    '## The files in the package',
    '',
    `- \`diff.patch\`: the whole diff (\`git diff ${base}...<branch>\`).`,
    `- \`files/\`: ${copied.length} changed file(s) in full version from the branch (same paths as in the repo).`,
  ];
  if (files.trackReply)
    lines.push("- `trackReply.md`: the track's last answer (the report to the orchestrator).");
  if (files.report)
    lines.push("- `trackReport.md`: the track's `track-result.md` (self-review, test run, connections).");
  if (files.handover) lines.push('- `handover.md`: the handover from a PARTIAL track.');
  if (files.mission) lines.push("- `mission.md`: the track's mission (its prompt file).");
  if (skipped.length)
    lines.push(`- Not included: ${skipped.map((h) => `\`${h.path}\` (${h.reason})`).join(', ')}.`);
  if (migrFolder) {
    lines.push('', '## Changed DB objects', '');
    if (dbObjects.length) for (const d of dbObjects) lines.push(`- ${d}`);
    else lines.push(`- (none in ${migrFolder})`);
  }
  // The test-weakening section (lib/testWeakening.js packageSection), already as lines; null = the check is off.
  if (Array.isArray(testWeakening)) lines.push(...testWeakening);
  // The reviewers for this task (queueHelpers.reviewersForTask): the fixed ones for the class (the floor), then each
  // helper agent with one line on why it was chosen.
  if (Array.isArray(reviewers)) {
    lines.push('', '## Reviewers', '');
    if (!reviewers.length) lines.push('- (none for this task)');
    for (const x of reviewers)
      lines.push(`- \`${x.type}\`: ${x.fixed ? 'fixed for the class' : 'helper agent'}. why: ${x.reasons.join(', ')}`);
  }
  lines.push('', '## Diff statistics', '', '```', String(stat ?? '').trimEnd(), '```', '');
  return lines.join('\n');
}

/**
 * The short reviewer prompt. "track <id>" in the text ties the reviewer's cost to the task. reviewer-gap also gets the
 * task's acceptance criteria and done command (doneCheck.gapCriteriaBlock), when it has any.
 */
function reviewerPrompt({ o, type, folder }) {
  const sep = String(folder).includes('\\') ? '\\' : '/';
  return [
    `You are ${type} for track ${o.id} (class ${o.class}, branch ${o.branch ?? queueBranch(o.id)}) in the work queue.`,
    `Read the review package: ${folder}${sep}00-package.md first, then diff.patch and the files under files${sep} (full version from the`,
    "branch), and the track's answer and report when they are there. Look things up in the rest of the repo only for a concrete",
    `question, with grep -n and excerpts. At most approx. ${type === 'reviewer-light' ? 15 : 40} turns; rather leave the question open in the report.`,
    'Your answer is at most approx. 1,500 characters. First line in fixed format: FINDINGS H=<count> M=<count> L=<count>',
    'deferrable=<finding codes that can wait, comma-separated, or ->. Then one short point per H and M finding (code,',
    'file:line, fix), L findings only with code and one sentence. Do not repeat the package.',
    // reviewer-gap also gets the fixed criteria and the done command (lib/doneCheck.js), one verdict line per criterion.
    ...(type === 'reviewer-gap' ? [require('../doneCheck.js').gapCriteriaBlock(o)].filter(Boolean) : []),
  ].join('\n');
}

module.exports = {
  parseResult,
  ownerQuestionSection,
  trackQuestion,
  parseFindings,
  batchFindings,
  lastAnswer,
  firstUserMessage,
  mentionsTask,
  taskAgentTypes,
  agentsForTask,
  sumCost,
  costStatistics,
  packageFiles,
  dbObjectsFromDiff,
  reviewPackageIndex,
  reviewerPrompt,
};
