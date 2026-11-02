// =============================================================
// queueTriage.js: the intake triage. A cheap, read-only check of an old task against the current code before a full
// track starts on it. See docs/orchestration.md ("Intake triage").
//
// Why: tasks sit in the queue for days. By the time one starts, the code may already do it, it may no longer make
// sense, or its mission may point at files that moved. A whole track on such a task wastes an agent run; one short
// read-only agent (the `triage` helper, plugin/agents/triage.md) answers first.
//
// The parts:
//   - triageSetup(config, queue): is triage on, and the rule's numbers. The switch is the helper switch (`cq helpers
//     on|off triage`, the board's Helper agents tab, `helpers.triage.enabled`); the rule is `triage` in
//     queue.config.json. Lite mode: off unless the owner switched it on in the queue.
//   - needsTriage(o, queue, ...): THE rule. A waiting task needs a verdict when it was added or last edited at least
//     minAgeDays ago, or when an agent added it (a proposal, approved) and it was never triaged. Never for fix tasks
//     or continuations (a task that has been started before, has a branch, or fixes another task). A verdict newer than
//     the last edit (and younger than minAgeDays) satisfies it.
//   - triageCandidates(queue, ...): the startable tasks that need a verdict, in ranked order. `fill` skips them (other
//     tasks take the slots) and prints the triage step for the first few instead.
//   - recordVerdict(queue, id, ...): `cq triage <id> --verdict ready|done|stale|adjust`. ready: startable. adjust: the
//     note goes into the mission as an addition (the bonus, like an owner answer), then startable. done and stale: an
//     owner question with choices; the task never starts or closes by itself.
//   - ownerChoice(queue, questionId, answer): the owner's answer to that question (`cq resolve <q> --choice <n>`):
//     close (cancelled), keep (startable) or rewrite (parked until the mission is rewritten and `cq continue`).
//   - triagePrompt / triageMessage: the prompt file and the short message the orchestrator starts the agent with.
//   - verdictStatistics(queue): the verdict counts for the helper measurement (cq helpers, the board).
//
// Pure logic (no file I/O), tested in lib/__tests__/queueTriage.test.ts.
// =============================================================
'use strict';

/** The helper's agent name (plugin/agents/triage.md, queueHelpers.CATALOG). */
const TRIAGE = 'triage';

/** The verdicts, in the order the docs and the help list them. */
const VERDICTS = Object.freeze(['ready', 'done', 'stale', 'adjust']);

/** The rule's defaults (`triage` in queue.config.json overrides them field by field). */
const DEFAULTS = Object.freeze({
  // A task added or last edited this many days ago or more needs a verdict. null turns the age rule off.
  minAgeDays: 3,
  // A task an agent added (a proposal or finding that was approved) needs a verdict once, whatever its age.
  agentAdded: true,
  // At most this many triage steps per `fill` (the others wait for the next fill; they never block other tasks).
  maxPerFill: 3,
  // A triage step that was printed is not printed again for this many minutes (the agent may still be running).
  askAgainMin: 60,
});

/** The task fields whose change counts as an edit of what the track would do (the changelog). */
const CONTENT_FIELDS = new Set(['title', 'mission', 'owned_files', 'owned_db', 'shared_patch', 'done_when', 'acceptance', 'bonus']);

const DAY_MS = 86_400_000;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const ms = (s) => (s ? Date.parse(s) : NaN);
const lazyL = () => require('./queueLogic.js');

/**
 * Is triage on, and the rule's numbers.
 * @param {object} config config() (queue.config.json merged with the defaults)
 * @param {object|null} [queue] queue.json (the helper switch there wins)
 * @returns {{ on: boolean, why: string|null, minAgeDays: number|null, agentAdded: boolean, maxPerFill: number,
 *   askAgainMin: number }}
 */
function triageSetup(config, queue = null) {
  const HELP = require('./queueHelpers.js');
  const h = HELP.helperSetup(config, queue)[TRIAGE];
  const lite = require('./liteMode.js').isLite(config);
  let why = null;
  if (!h) why = 'the triage helper is not in the setup';
  else if (!h.enabled) why = 'switched off (cq helpers on triage)';
  // Lite mode keeps the core loop: triage only when the owner switched it on in the queue itself.
  else if (lite && !(h.switchedInQueue && h.wantedOn)) why = 'off in lite mode (cq helpers on triage)';
  return { on: !why, why, ...ruleSetup(config) };
}

/** The rule's numbers only (`triage` in queue.config.json over DEFAULTS), without the switch. */
function ruleSetup(config) {
  const t = isObject(config?.triage) ? config.triage : {};
  const num = (v, d, { nullable = false } = {}) => {
    if (nullable && v === null) return null;
    const n = Number(v);
    return v !== undefined && v !== null && Number.isFinite(n) && n >= 0 ? n : d;
  };
  return {
    minAgeDays: num(t.minAgeDays, DEFAULTS.minAgeDays, { nullable: true }),
    agentAdded: typeof t.agentAdded === 'boolean' ? t.agentAdded : DEFAULTS.agentAdded,
    maxPerFill: Math.floor(num(t.maxPerFill, DEFAULTS.maxPerFill)),
    askAgainMin: num(t.askAgainMin, DEFAULTS.askAgainMin),
  };
}

/** Is this bonus the queue's own triage bookkeeping (the adjust note, or the owner's answer to a triage question)? */
const ownTriageText = (text) => /^(?:TRIAGE |OWNER_ANSWER triage-)/.test(String(text ?? ''));

/**
 * When the task's content was last changed (ms), or NaN when nothing says. The latest of: added, approved (a
 * proposal), each addition to the mission (bonus) except the triage's own, the changelog entries that change a
 * content field (CONTENT_FIELDS) of this task, and `missionMtimeMs` (the mission file, when the caller read it).
 */
function lastEdit(o, queue, { missionMtimeMs = null } = {}) {
  const times = [ms(o?.added_at), ms(o?.approved)];
  for (const b of Array.isArray(o?.bonus) ? o.bonus : []) if (!ownTriageText(b?.text)) times.push(ms(b?.time));
  for (const e of Array.isArray(queue?.changelog) ? queue.changelog : []) {
    if (e?.undone) continue;
    if ((e?.changes ?? []).some((c) => c?.id === o?.id && CONTENT_FIELDS.has(c.field))) times.push(ms(e.at));
  }
  if (Number.isFinite(missionMtimeMs)) times.push(missionMtimeMs);
  const ok = times.filter(Number.isFinite);
  return ok.length ? Math.max(...ok) : NaN;
}

/** Did an agent add the task (a proposal that was approved, or added_by an agent)? */
function agentAdded(o, tasks = []) {
  return !!o?.approved || lazyL().isAgentSource(o?.added_by, tasks);
}

/** A fix task or a continuation: started before, has a branch, resumed, or fixes another task. Never triaged. */
function continuation(o) {
  return !!(o?.started || o?.branch || (Array.isArray(o?.resumed) && o.resumed.length) || (Array.isArray(o?.fixes) && o.fixes.length) || (typeof o?.fixes === 'string' && o.fixes));
}

/** When the latest verdict counts from (ms): the verdict, or the owner's "keep" after it. NaN without a verdict. */
function verdictTime(o) {
  const t = o?.triage;
  if (!isObject(t)) return NaN;
  return Math.max(...[ms(t.at), ms(t.kept_at)].filter(Number.isFinite), -Infinity);
}

/**
 * THE rule: does this task need a triage verdict before it may start as a track?
 * @param {object} o the task
 * @param {object} queue
 * @param {{ now?: number, setup?: object, missionMtimeMs?: number|null }} [c] setup = triageSetup(config, queue)
 * @returns {{ need: boolean, reason: string|null }}
 */
function needsTriage(o, queue, { now = Date.now(), setup, missionMtimeMs = null } = {}) {
  const no = { need: false, reason: null };
  if (!setup?.on || o?.status !== 'waiting' || continuation(o)) return no;
  const edited = lastEdit(o, queue, { missionMtimeMs });
  const verdict = verdictTime(o);
  const days = setup.minAgeDays;
  if (Number.isFinite(verdict) && !(Number.isFinite(edited) && edited > verdict)) {
    // A verdict newer than the last edit: it holds until it is itself minAgeDays old.
    if (days == null || now - verdict < days * DAY_MS) return no;
    return { need: true, reason: `the last verdict (${o.triage.verdict}) is ${Math.floor((now - verdict) / DAY_MS)} days old` };
  }
  if (days != null && Number.isFinite(edited) && now - edited >= days * DAY_MS)
    return { need: true, reason: `added or last edited ${Math.floor((now - edited) / DAY_MS)} days ago` };
  if (setup.agentAdded && !isObject(o.triage) && agentAdded(o, queue?.tasks ?? []))
    return { need: true, reason: `added by an agent (${o.approved ? 'approved proposal' : o.added_by})` };
  return no;
}

/**
 * The tasks that need a verdict and would otherwise be startable now (waiting, no blockers, not parked, paused or
 * outside the focus, no uncommitted owned file), in ranked order. `asked` = the step was printed less than
 * askAgainMin ago (the agent may be running); `fill` skips those in the print, but never starts them either.
 * @returns {{ id: string, reason: string, asked: boolean }[]}
 */
function triageCandidates(queue, { now = Date.now(), setup, uncommitted = [], missionMtimeMs = () => null } = {}) {
  if (!setup?.on) return [];
  const L = lazyL();
  const tasks = queue?.tasks ?? [];
  const k = L.rankingContext(queue, now);
  return tasks
    .filter((o) => o.status === 'waiting' && L.blockers(o, tasks, queue.resolved).length === 0 && !L.uncommittedCollision(o, uncommitted))
    .map((o) => ({ o, r: L.ranking(o, queue, k), t: needsTriage(o, queue, { now, setup, missionMtimeMs: missionMtimeMs(o) }) }))
    .filter((x) => !x.r.out && x.t.need)
    .sort(L.compareRanking)
    .map(({ o, t }) => ({
      id: o.id,
      reason: t.reason,
      asked: Number.isFinite(ms(o.triage_asked)) && now - ms(o.triage_asked) < setup.askAgainMin * 60_000,
    }));
}

/** The owner question id for a done/stale verdict: triage-<id>, then triage-<id>-2 ... (a resolved id stays resolved). */
function questionIdFor(queue, id) {
  const taken = (q) => Object.hasOwn(queue?.question ?? {}, q) || (queue?.resolved ?? []).includes(q);
  const base = `triage-${id}`.slice(0, 37);
  if (!taken(base)) return base;
  for (let n = 2; n < 100; n++) if (!taken(`${base}-${n}`)) return `${base}-${n}`;
  return null;
}

/** The choices of the owner question for a done/stale verdict (the first is the recommendation). */
function choicesFor(verdict) {
  return [verdict === 'done' ? 'Close as done' : 'Close as stale', 'Keep and start anyway', 'Rewrite'];
}

/**
 * Records a verdict (`cq triage <id> --verdict ...`). Mutates the queue (the caller writes it under the lock).
 *   ready   the task may start.
 *   adjust  the note is added to the mission (bonus "TRIAGE adjust (<date>): <note>"), then the task may start.
 *   done    an owner question `triage-<id>` with choices (Close as done, Keep and start anyway, Rewrite); the task
 *   stale   waits on it (waiting_on) and never closes without the owner.
 * done, stale and adjust need a note (the evidence: file:line, why, or the corrected paths).
 * @returns {{ error: string|null, task?: object, question?: string|null }}
 */
function recordVerdict(queue, id, { verdict, note = null, by = null, head = null, now = new Date().toISOString() } = {}) {
  const L = lazyL();
  const o = (queue?.tasks ?? []).find((x) => x.id === id);
  if (!o) return { error: `unknown task ${id}` };
  if (!VERDICTS.includes(verdict)) return { error: `--verdict must be ${VERDICTS.join(', ')}` };
  if (o.status !== 'waiting') return { error: `${id} has status ${o.status}; a verdict is for a waiting task` };
  const text = note == null ? '' : String(note).replace(/\s+/g, ' ').trim();
  if (verdict !== 'ready' && !text)
    return { error: `--verdict ${verdict} needs --note "..." (${verdict === 'done' ? 'the evidence, file:line' : verdict === 'stale' ? 'why it no longer makes sense' : 'the corrected note or moved paths'})` };
  if (text.length > 1500) return { error: 'the note is longer than 1,500 characters; keep it short' };
  let question = null;
  if (verdict === 'done' || verdict === 'stale') {
    question = questionIdFor(queue, id);
    if (!question) return { error: `no free question id for ${id}` };
    const choices = choicesFor(verdict);
    const s = L.setQuestion(
      queue,
      {
        [question]: {
          type: 'question',
          text:
            `Intake triage of ${id} ("${String(o.title ?? id).slice(0, 120)}") says ${verdict === 'done' ? 'it is already done' : 'it is stale'}: ` +
            `${text.slice(0, 1200)}${/[.!?]$/.test(text.slice(0, 1200)) ? '' : '.'} Close it, start it anyway, or rewrite the mission?`,
          recommendation: choices[0],
          source: `triage helper (${TRIAGE})`,
          choices,
        },
      },
      now,
    );
    if (s.error.length) return { error: s.error.join('; ') };
    o.waiting_on = [...new Set([...(o.waiting_on ?? []), question])];
    L.openBlock(o, 'owner-question', { now: Date.parse(now), note: `triage ${verdict} (${question})` });
  }
  if (verdict === 'adjust') {
    const f = L.addToBonus(o, `TRIAGE adjust (${String(now).slice(0, 10)}): ${text}`, now);
    if (f) return { error: f };
  }
  const record = { verdict, at: now, ...(text ? { note: text } : {}), ...(by ? { by: String(by) } : {}), ...(head ? { head: String(head) } : {}), ...(question ? { question } : {}) };
  o.triage = record;
  o.triage_log = [...(Array.isArray(o.triage_log) ? o.triage_log : []), record].slice(-10);
  delete o.triage_asked;
  o.remarks = [...(Array.isArray(o.remarks) ? o.remarks : []), `${now} triage: ${verdict}${text ? `: ${text.slice(0, 200)}` : ''}`];
  return { error: null, task: o, question };
}

/**
 * The owner's answer to a triage question (`cq resolve <q> --choice <n>`, also from the board). Called under the same
 * lock as the resolve, after it. Mutates the queue.
 *   Close as done / Close as stale   the task is cancelled (the owner's own choice, with a remark).
 *   Keep and start anyway            the task may start (the verdict counts as kept from now).
 *   Rewrite                          the task is parked until the mission is rewritten (cq edit) and `cq continue`.
 * A free-text answer does nothing here (the orchestrator reads it and acts).
 * @returns {{ id: string, action: 'close'|'keep'|'rewrite'|'none', error?: string|null }|null} null = not a triage question
 */
function ownerChoice(queue, questionId, answer, { by = null, now = new Date().toISOString() } = {}) {
  const L = lazyL();
  const o = (queue?.tasks ?? []).find((x) => x?.triage?.question === questionId);
  if (!o) return null;
  const s = String(answer ?? '').trim().toLowerCase();
  const done = () => L.closeBlock(o, { now: Date.parse(now) });
  if (o.status !== 'waiting') return { id: o.id, action: 'none', error: `${o.id} has status ${o.status}` };
  if (s.startsWith('close as')) {
    const st = L.setStatus(o, 'cancelled', now);
    if (st.error) return { id: o.id, action: 'none', error: st.error };
    done();
    o.remarks = [...(o.remarks ?? []), `${now} cancelled by the owner's answer to ${questionId} (${o.triage.verdict})`];
    return { id: o.id, action: 'close', error: null };
  }
  if (s.startsWith('keep and start')) {
    done();
    o.triage = { ...o.triage, kept_at: now, ...(by ? { kept_by: String(by) } : {}) };
    return { id: o.id, action: 'keep', error: null };
  }
  if (s.startsWith('rewrite')) {
    done();
    const p = L.park(queue, [o.id], { by: by ?? 'owner', reason: `rewrite the mission after triage (${questionId}), then cq continue ${o.id}`, now });
    return { id: o.id, action: 'rewrite', error: p.error?.length ? p.error.join('; ') : null };
  }
  return { id: o.id, action: 'none', error: null };
}

/** The short message the orchestrator starts the triage agent with. "track <id>" ties its cost to the task. */
function triageMessage(id, promptPath) {
  return (
    `You are the triage helper for track ${id} in the work queue (read only, a short check before the track starts). ` +
    `Your mission is in ${promptPath}: read it first. Answer with the TRIAGE line first, at most approx. 800 characters.`
  );
}

/**
 * The triage prompt file: the task, its mission and owned files, and the answer format. `missionText` is the mission
 * (the file's text when the mission is a path); `head` the base branch's commit the check is against.
 */
function triagePrompt(o, { reason, base, head = null, missionText = null, missionPath = null, cq = 'cq' } = {}) {
  const list = (x) => (Array.isArray(x) && x.length ? x.map((f) => `- \`${f}\``).join('\n') : '- (none listed)');
  const bonus = (Array.isArray(o.bonus) ? o.bonus : []).map((b) => `- ${b.time}: ${b.text}`);
  return [
    `# Intake triage: ${o.id}`,
    '',
    `You are the \`${TRIAGE}\` helper for task ${o.id} ("${o.title ?? o.id}"), class ${o.class ?? '?'}. It needs a check`,
    `before a track starts on it: ${reason}. Check the mission against the CURRENT code on \`${base}\`` +
      `${head ? ` (commit ${String(head).slice(0, 12)})` : ''}, in the main tree. Read only.`,
    '',
    `- Added ${o.added_at ?? '?'} by ${o.added_by ?? '?'}${o.approved ? `, approved ${o.approved}` : ''}.`,
    '',
    '## Owned files',
    '',
    list(o.owned_files),
    ...(Array.isArray(o.owned_db) && o.owned_db.length ? ['', '## Owned DB objects', '', list(o.owned_db)] : []),
    '',
    '## Mission',
    '',
    ...(missionPath ? [`(from \`${missionPath}\`)`, ''] : []),
    '~~~~',
    String(missionText ?? o.mission ?? '(no mission text)').trimEnd(),
    '~~~~',
    ...(bonus.length ? ['', '## Additions to the mission (newest last)', '', ...bonus] : []),
    '',
    '## Answer',
    '',
    'First line exactly one of:',
    '',
    '- `TRIAGE ready`: still needed, and the mission fits the code as it is now.',
    '- `TRIAGE done`: the code already does it. Then the evidence, `file:line` for each point.',
    '- `TRIAGE stale`: it no longer makes sense (the feature is gone, replaced, or decided against). Then why.',
    '- `TRIAGE adjust`: still needed, but the mission is off. Then a short corrected note: the moved file paths, the',
    '  part that is already done, what to do instead. It is added to the mission as it is, so write it for the track.',
    '',
    'Then at most 5 short lines. The orchestrator records it:',
    `\`${cq} triage ${o.id} --verdict <ready|done|stale|adjust> --note "<your note>"\`.`,
  ].join('\n');
}

/**
 * The verdict counts over every task's triage log, for the helper measurement: { ready, done, stale, adjust, total,
 * saved } (saved = done + stale: track runs the check stopped).
 */
function verdictStatistics(queue, { since = null } = {}) {
  const out = { ready: 0, done: 0, stale: 0, adjust: 0, total: 0, saved: 0 };
  const from = since ? Date.parse(since) : NaN;
  for (const o of queue?.tasks ?? [])
    for (const r of Array.isArray(o?.triage_log) ? o.triage_log : []) {
      if (!VERDICTS.includes(r?.verdict)) continue;
      if (Number.isFinite(from) && !(ms(r.at) >= from)) continue;
      out[r.verdict] += 1;
      out.total += 1;
    }
  out.saved = out.done + out.stale;
  return out;
}

/** The rule in words, for `cq helpers` and the board ("When: ..."). */
function whenText(setup) {
  const parts = [];
  if (setup.minAgeDays != null) parts.push(`a task added or last edited ${setup.minAgeDays}+ days ago`);
  if (setup.agentAdded) parts.push('a task an agent added (once)');
  if (!parts.length) return 'When: no rule set (triage.minAgeDays null and triage.agentAdded false), so it never runs.';
  return `When: before fill starts ${parts.join(' or ')}; never fix tasks or continuations. At most ${setup.maxPerFill} per fill.`;
}

module.exports = {
  TRIAGE,
  VERDICTS,
  DEFAULTS,
  triageSetup,
  ruleSetup,
  lastEdit,
  agentAdded,
  continuation,
  needsTriage,
  triageCandidates,
  questionIdFor,
  choicesFor,
  recordVerdict,
  ownerChoice,
  triageMessage,
  triagePrompt,
  verdictStatistics,
  whenText,
};
