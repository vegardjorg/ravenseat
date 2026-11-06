// =============================================================
// logic/questions.js: proposed tasks, owner questions and resolutions, and owner answers that cannot be lost.
//
// approve and statusAtAdd (proposed), setQuestion, resolve, questionOverview and the logged marks, waitingOnError,
// resolveWaits and ownerAnswerBonus (an answer always reaches the task), answerBlock, and migrBlockText (the migration
// block as text, common for start and pick).
//
// Part of the queueLogic.js split: lib/queueLogic.js re-exports every name, so callers keep requiring queueLogic.js.
// Used by queueLogic.js (the facade) and by logic/select.js, pick.js, external.js.
// Tested in lib/__tests__/queueQuestion.test.ts, queueAnswer.test.ts and queueSaverMode.test.ts (through
// queueLogic.js).
// =============================================================

const { utcText, cutText, addToBonus } = require('./base.js');

// ---- Proposed ----------------------------------------------------------------------------------------------

/**
 * Is `added_by` an agent? The protocol says that agents set their own id: a track (a task id in the queue, also a
 * fix round like "A-4-r2"), a reviewer ("rev-…", "review …") or a fold/investigation agent ("… agent …"). The owner
 * (add-to-queue) and the orchestrator use other labels, and their tasks go straight to waiting.
 */
function isAgentSource(addedBy, tasks = []) {
  const s = String(addedBy ?? '').trim();
  if (!s) return false;
  const ids = new Set(tasks.map((o) => o.id));
  if (ids.has(s)) return true;
  const withoutRound = s.replace(/-(?:r|round)\d+$/i, '');
  if (withoutRound !== s && ids.has(withoutRound)) return true;
  return /^(?:rev|review|fold)\b/i.test(s) || /\bagent\b/i.test(s);
}

/**
 * The status a new task gets in `queue.mjs add`: proposed when an agent added it, otherwise waiting. `approved` (the flag
 * --approved, only for the orchestrator or the owner) gives waiting regardless, for example for a HIGH finding from review.
 */
function statusAtAdd(fresh, tasks = [], { approved = false } = {}) {
  if (approved) return 'waiting';
  return isAgentSource(fresh?.added_by, tasks) ? 'proposed' : 'waiting';
}

/** How many proposals one track may have waiting for the owner. An agent should not be able to bury the owner in work. */
const MAX_OPEN_PER_TRACK = 3;

/**
 * Makes a task from a track's `ravenseat add` a proposal from that track: the branch says who, and the file cannot approve
 * itself. So that a track only has to say what the work is, domain, project and feature follow the track when they are not
 * given, and the class is K. What the task gives itself wins.
 */
function asTrackProposal(task, track, tasks = []) {
  if (!task || typeof task !== 'object' || Array.isArray(task)) return;
  for (const k of ['approved', 'approved_by', 'auto_accepted']) delete task[k];
  task.added_by = track;
  const from = tasks.find((o) => o.id === track);
  for (const k of ['domain', 'project', 'feature']) if (task[k] == null && from?.[k] != null) task[k] = from[k];
  if (task.class == null) task.class = 'K';
}

/** The refusal when a track would pass MAX_OPEN_PER_TRACK open proposals, or null. */
function trackLimitError(track, tasks = [], adding = 0) {
  const open = tasks.filter((o) => o.added_by === track && o.status === 'proposed').length;
  if (open + adding <= MAX_OPEN_PER_TRACK) return null;
  return `${track} has ${open} open proposal(s), and a track may have ${MAX_OPEN_PER_TRACK}. Put the rest in your report.`;
}

/**
 * Approves proposed tasks: proposed → waiting. Changes tasks in `queue` (the caller writes the file under lock).
 * @returns {{ approved: string[], error: string[] }}
 */
function approve(queue, ids, now = new Date().toISOString()) {
  const approved = [];
  const error = [];
  for (const id of ids) {
    const o = (queue.tasks ?? []).find((x) => x.id === id);
    if (!o) error.push(`unknown task ${id}`);
    else if (o.status !== 'proposed') error.push(`${id} is not proposed (status ${o.status})`);
    else {
      o.status = 'waiting';
      o.approved = now;
      approved.push(id);
    }
  }
  return { approved, error };
}

// ---- Owner questions and resolutions -------------------------------------------------------------------
//
// `question`: { "<id>": { type, text, recommendation?, source?, choices?, added_at } } is the text behind the ids in `waiting_on`, so
// the board can show what the owner must answer. `resolutions`: { "<id>": { time, answer, by, logged? } } is the answer with
// a timestamp; the id still sits in `resolved` (that list is what the blockers read). Both fields are optional: an
// old queue.json without them works unchanged. `choices` (optional) is 2-4 short answer options the owner can pick
// with one click on the board or `ravenseat resolve <id> --choice <n|text>`; a question without choices works as before.

/** The types an owner question can have. `condition` is answered with how the condition is fulfilled. */
const QUESTION_TYPES = ['question', 'condition', 'lawyer', 'owner-task'];
const QUESTION_FIELD = new Set(['type', 'text', 'recommendation', 'source', 'choices', 'added_at']);
const QUESTION_MAX_TEXT = 4000;
/** The limits for `choices`: 2-4 options, each at most 60 characters (a button label, not an essay). */
const CHOICES_MIN = 2;
const CHOICES_MAX = 4;
const CHOICE_MAX_TEXT = 60;

/**
 * The errors for a `choices` value (setQuestion). A list of 2-4 strings, each non-empty after trim, at most
 * CHOICE_MAX_TEXT characters, without control characters, and no two the same (ignoring case and whitespace at the ends).
 * @returns {string[]} empty when the list is valid
 */
function choicesError(list) {
  if (!Array.isArray(list)) return [`choices must be a list of ${CHOICES_MIN}-${CHOICES_MAX} short texts`];
  const error = [];
  if (list.length < CHOICES_MIN || list.length > CHOICES_MAX)
    error.push(`choices must have ${CHOICES_MIN}-${CHOICES_MAX} entries (has ${list.length})`);
  const seen = new Set();
  list.forEach((c, i) => {
    const s = typeof c === 'string' ? c.trim() : '';
    if (!s) error.push(`choice ${i + 1} is empty (or not text)`);
    else if (s.length > CHOICE_MAX_TEXT)
      error.push(`choice ${i + 1} is longer than ${CHOICE_MAX_TEXT} characters`);
    else if (/[\u0000-\u001f\u007f]/.test(s)) error.push(`choice ${i + 1} has a control character`);
    else if (seen.has(s.toLowerCase())) error.push(`choice ${i + 1} is a duplicate ("${s}")`);
    seen.add(s.toLowerCase());
  });
  return error;
}

/** Is `choice` the recommended one? Only when the recommendation is exactly the choice's text (ignoring case). */
function isRecommendedChoice(q, choice) {
  const r = typeof q?.recommendation === 'string' ? q.recommendation.trim().toLowerCase() : '';
  return !!r && r === String(choice).trim().toLowerCase();
}

/**
 * The choices numbered, one line each ("1. Yes (recommended)"), for everything that prints a question for the
 * orchestrator or an agent. Empty list when the question has no choices.
 */
function choiceLines(q) {
  if (!Array.isArray(q?.choices)) return [];
  return q.choices.map((c, i) => `${i + 1}. ${c}${isRecommendedChoice(q, c) ? ' (recommended)' : ''}`);
}

/**
 * Finds the choice the owner picked: a number (1-based, "2") or the text of the choice (ignoring case). `q` is the
 * registered question.
 * @returns {{ choice: string|null, error: string|null }}
 */
function pickChoice(q, pick) {
  const list = Array.isArray(q?.choices) ? q.choices : [];
  if (!list.length) return { choice: null, error: 'the question has no choices: answer with --answer "..."' };
  const s = String(pick ?? '').trim();
  const numbered = list.map((c, i) => `${i + 1}. ${c}`).join(', ');
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    if (n >= 1 && n <= list.length) return { choice: list[n - 1], error: null };
    return { choice: null, error: `choice ${s} does not exist (${numbered})` };
  }
  const hit = list.find((c) => c.toLowerCase() === s.toLowerCase());
  return hit
    ? { choice: hit, error: null }
    : { choice: null, error: `unknown choice ${JSON.stringify(s)} (${numbered})` };
}

/** The answer that is stored when the owner picks a choice: the choice's text, plus a free text note when one is given. */
function choiceAnswer(choice, note = null) {
  const n = note == null ? '' : String(note).trim();
  return n ? `${choice} (note: ${n})` : String(choice);
}

/** Valid id for an owner question: not empty, at most 300 characters, without control characters, whitespace at the ends or a leading "-". */
function validQuestionId(id) {
  const s = typeof id === 'string' ? id : '';
  return (
    s.length > 0 &&
    s.length <= 300 &&
    s.trim() === s &&
    !s.startsWith('-') &&
    !/[\u0000-\u001f\u007f]/.test(s)
  );
}

/**
 * Sets or updates owner questions (`queue.mjs question`, `question --file`, `add` with `{ tasks, question }`).
 * All or nothing: if one question is invalid, nothing is changed. A field that is not included is kept from before; `null`
 * removes recommendation, source or choices. `added_at` is set by the tool (the first time the question is registered).
 * `choices` (optional): 2-4 short answer options (choicesError); the texts are stored trimmed.
 * @param {object} queue the queue (changed when the error list is empty)
 * @param {Record<string, { type?: string, text?: string, recommendation?: string|null, source?: string|null,
 *   choices?: string[]|null }>} input
 * @returns {{ set: string[], error: string[] }}
 */
function setQuestion(queue, input, now = new Date().toISOString()) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    return { set: [], error: ['question must be an object: { "<id>": { type, text, … } }'] };
  const error = [];
  const newOnes = {};
  for (const [id, s] of Object.entries(input)) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) {
      error.push(`${id}: must be an object { type, text, recommendation?, source?, choices? }`);
      continue;
    }
    const f = [];
    // A NEW question must have a strict id (QUESTION_ID_PATTERN), so free text never becomes a "question". A
    // question that is already registered can still be updated (validQuestionId).
    if (!validQuestionId(id) || (!queue.question?.[id] && !QUESTION_ID_PATTERN.test(id)))
      f.push('invalid id');
    const unknown = Object.keys(s).filter((k) => !QUESTION_FIELD.has(k));
    if (unknown.length) f.push(`unknown field ${unknown.join(', ')}`);
    const previous = queue.question?.[id] ?? {};
    const type = s.type ?? previous.type ?? 'question';
    if (!QUESTION_TYPES.includes(type)) f.push(`type must be ${QUESTION_TYPES.join(', ')}`);
    const text = s.text ?? previous.text;
    if (typeof text !== 'string' || !text.trim()) f.push('text missing');
    for (const k of ['text', 'recommendation', 'source']) {
      const v = s[k];
      if (v != null && (typeof v !== 'string' || v.length > QUESTION_MAX_TEXT))
        f.push(`${k} must be text (at most ${QUESTION_MAX_TEXT} characters)`);
    }
    if (s.choices != null) f.push(...choicesError(s.choices));
    if (f.length) {
      error.push(`${id}: ${f.join('; ')}`);
      continue;
    }
    const fresh = { type, text: text.trim() };
    for (const k of ['recommendation', 'source']) {
      const v = s[k] !== undefined ? s[k] : previous[k];
      if (typeof v === 'string' && v.trim()) fresh[k] = v.trim();
    }
    const choices = s.choices !== undefined ? s.choices : previous.choices;
    if (Array.isArray(choices) && choices.length) fresh.choices = choices.map((c) => String(c).trim());
    fresh.added_at = previous.added_at ?? now;
    newOnes[id] = fresh;
  }
  if (error.length) return { set: [], error };
  queue.question = { ...(queue.question ?? {}), ...newOnes };
  return { set: Object.keys(newOnes), error: [] };
}

/**
 * `queue.mjs resolve <id…> [--answer "…"] [--choice <n|text>] [--by "…"]`: the ids are put in `resolved` (as before) and in
 * `resolutions` with time, answer and who. Without an answer an earlier resolution is kept unchanged (time and answer are never
 * lost); a new answer replaces it and must be entered in the decision log again (`logged: false`). An empty answer (`--answer ""`)
 * is refused: then everything stops. `choice` picks one of the question's choices (pickChoice; exactly one id): the stored answer is
 * the choice's text, with `answer` as a note when given (choiceAnswer).
 * @returns {{ resolved: string[], error: string[], answer: string|null }} `answer` = the answer that was stored
 */
function resolve(queue, ids, { answer = null, choice = null, by = null, now = new Date().toISOString() } = {}) {
  const list = [...new Set(ids ?? [])];
  const error = list
    .filter((id) => !validQuestionId(id))
    .map((id) => `invalid question id ${JSON.stringify(id)}`);
  if (!list.length) error.push('resolve requires at least one question id');
  let s = answer == null ? null : String(answer).trim();
  if (choice != null) {
    // A choice belongs to one question: picking "2" for several at once would be a guess.
    if (list.length !== 1) error.push('--choice takes exactly one question id');
    else {
      const p = pickChoice(queue.question?.[list[0]], choice);
      if (p.error) error.push(`${list[0]}: ${p.error}`);
      else s = choiceAnswer(p.choice, s);
    }
  } else if (answer != null && !s)
    error.push('the answer is empty: write the answer, or how the condition is fulfilled');
  if (error.length) return { resolved: [], error, answer: null };
  queue.resolved = [...new Set([...(queue.resolved ?? []), ...list])];
  const resolutions = { ...(queue.resolutions ?? {}) };
  for (const id of list) {
    if (resolutions[id] && s == null) continue;
    resolutions[id] = { time: now, answer: s, by: by ? String(by).trim() || null : null };
    if (s != null) resolutions[id].logged = false;
  }
  queue.resolutions = resolutions;
  return { resolved: list, error: [], answer: s };
}

/** Resolutions with an answer that is not entered in the decision log yet (the orchestrator enters them and runs --mark-logged). */
function unlogged(queue) {
  return Object.entries(queue.resolutions ?? {})
    .filter(([, a]) => a && a.answer != null && a.logged !== true)
    .map(([sp, a]) => ({ sp, ...a }))
    .sort((x, y) => String(x.time).localeCompare(String(y.time)) || x.sp.localeCompare(y.sp));
}

/**
 * `queue.mjs resolutions --mark-logged <id…>`: the answers are entered in the decision log. All or nothing (unknown id or
 * a resolution without an answer gives an error).
 * @returns {{ marked: string[], error: string[] }}
 */
function markLogged(queue, ids) {
  const list = [...new Set(ids ?? [])];
  const error = [];
  if (!list.length) error.push('--mark-logged requires at least one question id');
  for (const id of list) {
    const a = queue.resolutions?.[id];
    if (!a) error.push(`${id} is not resolved with a timestamp (ravenseat resolve ${id} --answer "…")`);
    else if (a.answer == null) error.push(`${id} has no answer to enter`);
  }
  if (error.length) return { marked: [], error };
  queue.resolutions = { ...queue.resolutions };
  for (const id of list) queue.resolutions[id] = { ...queue.resolutions[id], logged: true };
  return { marked: list, error: [] };
}

/**
 * Overview for `queue.mjs question`: each question that is registered or that a task waits on, with the text (or
 * null when it is missing), whether it is resolved, and how many pending tasks wait directly on it. Open ones first
 * (most pending first), then resolved ones.
 */
function questionOverview(queue) {
  const resolved = new Set(queue.resolved ?? []);
  const waiting = new Map();
  for (const o of queue.tasks ?? []) {
    if (o.status !== 'waiting' && o.status !== 'proposed') continue;
    for (const sp of o.waiting_on ?? []) {
      if (!waiting.has(sp)) waiting.set(sp, []);
      if (o.status === 'waiting') waiting.get(sp).push(o.id);
    }
  }
  const ids = new Set([...Object.keys(queue.question ?? {}), ...waiting.keys()]);
  return [...ids]
    .map((sp) => {
      const q = queue.question?.[sp];
      return {
        sp,
        type: q?.type ?? 'question',
        text: q?.text ?? null,
        recommendation: q?.recommendation ?? null,
        source: q?.source ?? null,
        choices: Array.isArray(q?.choices) ? q.choices : [],
        resolved: resolved.has(sp),
        answer: queue.resolutions?.[sp]?.answer ?? null,
        tasks: waiting.get(sp) ?? [],
      };
    })
    .sort(
      (x, y) =>
        Number(x.resolved) - Number(y.resolved) ||
        y.tasks.length - x.tasks.length ||
        x.sp.localeCompare(y.sp),
    );
}

/** The ids a task waits on that have no text in `question` (add warns about them). */
function questionWithoutText(tasks, queue) {
  const out = new Set();
  for (const o of tasks)
    for (const sp of o.waiting_on ?? []) if (!queue.question?.[sp]?.text) out.add(sp);
  return [...out];
}

// ---- An owner answer cannot be lost -----------------------------------------------
//
// A task stayed blocked even though the owner had answered twice: `waiting_on` had free text instead of a registered
// question id, so the question did not exist in `question`, was never shown in "Waiting on you", and `resolve` could not hit
// it. Three measures: (1) add and edit refuse a new waiting_on id that is not registered (waitingOnError), (2) fill, show and
// state list loose waits (resolveWaits), (3) resolve with an answer writes the answer into the mission (ownerAnswerBonus).

/** Strict id for an owner question: letters (including Nordic letters), digits, ".", "_" and "-", at most 40 characters, without whitespace. */
const QUESTION_ID_PATTERN = /^[A-Za-z0-9\u00C6\u00D8\u00C5\u00E6\u00F8\u00E5][A-Za-z0-9\u00C6\u00D8\u00C5\u00E6\u00F8\u00E5._-]{0,39}$/;

/** Is the question registered so that the owner can answer it (text and type in `question`)? */
function questionRegistered(queue, sp) {
  const q = Object.hasOwn(queue?.question ?? {}, sp) ? queue.question[sp] : null;
  return !!(q && typeof q.text === 'string' && q.text.trim() && q.type);
}

/**
 * The errors for `waiting_on` on a task (add and edit; all or nothing in the caller). Each id that is not in
 * `earlier` (the task's waiting_on before the change) must match QUESTION_ID_PATTERN and be registered in `queue.question`
 * with text and type. `queue.question` should already contain the questions that are registered in the same call (the add form
 * { tasks, question }). Waits that were already there are not refused (they show as loose waits instead).
 * @returns {string[]}
 */
function waitingOnError(o, queue, { earlier = [] } = {}) {
  const list = o?.waiting_on;
  if (list == null || !Array.isArray(list)) return [];
  const from = new Set(earlier ?? []);
  const error = [];
  for (const sp of list) {
    if (from.has(sp)) continue;
    if (typeof sp !== 'string' || !QUESTION_ID_PATTERN.test(sp))
      error.push(
        `waiting_on ${JSON.stringify(sp)} is not a question id (letters, digits, ".", "_", "-", at most 40 characters, ` +
          'no whitespace). Register the question with an id and text, and wait on the id',
      );
    else if (!questionRegistered(queue, sp))
      error.push(
        `waiting_on ${sp} is not registered with text and type: add it under "question" in the add file, or first ` +
          `ravenseat question ${sp} --text "…" --type <${QUESTION_TYPES.join('|')}>`,
      );
  }
  return error;
}

/**
 * Loose waits: tasks (waiting or proposed) that wait on something the owner cannot answer, or that are blocked by
 * a question that has been answered. `reason`: `freeText` (the id does not match QUESTION_ID_PATTERN), `unregistered` (no
 * text and type in `question`), or `resolved-blocks` (the answer is in `resolutions`, but the id is missing in `resolved`,
 * which is what the blockers read; should not be able to happen). A resolved question without text does not block and is not included.
 * @returns {{ id: string, status: string, sp: string, reason: string }[]}
 */
function resolveWaits(queue) {
  const resolved = new Set(queue?.resolved ?? []);
  const out = [];
  for (const o of queue?.tasks ?? []) {
    if (o.status !== 'waiting' && o.status !== 'proposed') continue;
    for (const sp of Array.isArray(o.waiting_on) ? o.waiting_on : []) {
      if (resolved.has(sp)) continue;
      let reason = null;
      if (Object.hasOwn(queue.resolutions ?? {}, sp)) reason = 'resolved-blocks';
      else if (typeof sp !== 'string' || !QUESTION_ID_PATTERN.test(sp)) reason = 'freeText';
      else if (!questionRegistered(queue, sp)) reason = 'unregistered';
      if (reason) out.push({ id: o.id, status: o.status, sp: String(sp), reason });
    }
  }
  return out;
}

/**
 * The WARNING lines for loose waits (fill, show). Empty list when there are none. `max` limits the detail lines.
 * @param {{ id: string, status: string, sp: string, reason: string }[]} list resolveWaits(queue)
 */
function resolveWaitsLines(list, { max = 10 } = {}) {
  if (!list?.length) return [];
  const what = {
    freeText: 'free text, not a question id: register a question and switch to the id',
    unregistered: 'unregistered: ravenseat question <id> --text "…" --type <type>',
    'resolved-blocks': 'answered, but not in resolved: ravenseat resolve <id> again',
  };
  const taskIds = new Set(list.map((x) => x.id));
  return [
    `NOTICE: ${list.length} loose wait(s) in ${taskIds.size} task(s) (the owner does not see them in "Waiting on you", ` +
      'or an answer blocks anyway):',
    ...list
      .slice(0, max)
      .map(
        (x) =>
          `  ${x.id} (${x.status}) waiting on "${cutText(x.sp, 70)}": ${what[x.reason] ?? x.reason}`,
      ),
    ...(list.length > max
      ? [`  +${list.length - max} more (ravenseat state, the field resolveWaits)`]
      : []),
  ];
}

/**
 * Resolve with an answer writes the answer into the mission: a bonus "OWNER_ANSWER <sp> (<date>): <answer>" on each task that
 * waits on the question and is not done, cancelled or external (same mechanism as `queue.mjs edit --bonus`, so
 * the track block and the prompt get the decision). Idempotent: if the same answer for the same question is already there, it is
 * not added again. Without an answer nothing happens. Mutates the queue.
 * @returns {{ id: string, sp: string }[]} the additions that were made
 */
function ownerAnswerBonus(queue, ids, answer, now = new Date().toISOString()) {
  const s = answer == null ? '' : String(answer).trim();
  if (!s) return [];
  const date = String(now).slice(0, 10);
  const added = [];
  for (const sp of [...new Set(ids ?? [])]) {
    for (const o of queue?.tasks ?? []) {
      if (['done', 'cancelled', 'external'].includes(o.status)) continue;
      if (!(o.waiting_on ?? []).includes(sp)) continue;
      const fromFor = (Array.isArray(o.bonus) ? o.bonus : []).some(
        (t) =>
          typeof t?.text === 'string' &&
          t.text.startsWith(`OWNER_ANSWER ${sp} (`) &&
          t.text.endsWith(`): ${s}`),
      );
      if (fromFor) continue;
      if (!addToBonus(o, `OWNER_ANSWER ${sp} (${date}): ${s}`, now)) added.push({ id: o.id, sp });
    }
  }
  return added;
}

/**
 * The block in the track file with the owner's answer to what the task waited on (`waiting_on` that is resolved), so the track sees
 * the decision and does not build without it. null when the task did not wait on anything resolved.
 */
function answerBlock(o, queue) {
  const resolved = new Set(queue.resolved ?? []);
  const sp = (o.waiting_on ?? []).filter((x) => resolved.has(x));
  if (!sp.length) return null;
  const lines = sp.map((id) => {
    const q = queue.question?.[id];
    const a = queue.resolutions?.[id];
    const what = q?.text ? ` (${q.type ?? 'question'}): "${q.text}"` : '';
    if (a?.answer == null)
      return `- ${id}${what} Resolved${a?.time ? ` ${utcText(a.time)}` : ''}, but the answer is not in the queue: see the decision log.`;
    const word = q?.type === 'condition' || q?.type === 'lawyer' ? 'Fulfilled' : 'Answer';
    return `- ${id}${what} ${word}: "${a.answer}" (${a.by ?? '?'}, ${utcText(a.time)}).`;
  });
  return [
    '**Owner answer to what the task waited on** (binding; from `ravenseat resolve`, entered in the decision log by the orchestrator):',
    ...lines,
  ].join('\n');
}

// ---- Migration block as text (common for start and pick) ------------------------------------------------------

/** "3450–3459" from { from, to }, or null when the task has no migrations. */
function migrBlockText(b) {
  if (b?.from == null) return null;
  return `${b.from}–${b.to}`;
}

module.exports = {
  MAX_OPEN_PER_TRACK,
  asTrackProposal,
  trackLimitError,
  isAgentSource,
  statusAtAdd,
  approve,
  QUESTION_TYPES,
  validQuestionId,
  setQuestion,
  choicesError,
  isRecommendedChoice,
  choiceLines,
  pickChoice,
  choiceAnswer,
  resolve,
  unlogged,
  markLogged,
  questionOverview,
  questionWithoutText,
  QUESTION_ID_PATTERN,
  questionRegistered,
  waitingOnError,
  resolveWaits,
  resolveWaitsLines,
  ownerAnswerBonus,
  answerBlock,
  migrBlockText,
};
