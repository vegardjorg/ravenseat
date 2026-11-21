// =============================================================
// checkpoint.js: staged queueing with a checkpoint question (PG-4 of plans/plan-gate-vurdering-2026-11-21.md, owner
// decision 2026-11-21: all eight questions as recommended).
//
// WHY: a large plan went into the queue as fifteen startable tracks before anyone had tried to shoot the idea down. PG-4
// queues stage 1 (1-2 tracks, a thin slice or a spike, with `risk_first` set) and the rest waiting on ONE registered
// question, CP-<plan>, of type condition: "The first part is done. Success measure: …. Continue, adjust or stop?". The rest is
// queued, not held back in a note, so the forecast, the graph and a one-answer start all keep working (owner question 3).
//
// The parts:
//   checkpointSetup(cfg)     plans.checkpoint: off / offer (default) / always. A bad value falls back to offer.
//   stagingOffer(...)        should /add-to-queue stage this? A gated plan (size L or XL, or a sensitive zone,
//                            planGate.needWhy) is offered staging as the recommended answer (offer) or staged without a
//                            question (always). "Smallest version first" (the PG-2 answer) is staged without asking
//                            again: the user already chose it. off: never staged, as before.
//   checkpointQuestion(...)  the question to register with the add: id CP-<plan> (CP-<first stage task> without a plan),
//                            type condition, choices Continue / Adjust / Stop, Continue recommended, and `after` = the
//                            stage-1 tasks. `after` keeps it hidden until they are done (lib/logic/questions.js
//                            questionHidden), so the owner is asked about a result only once the result exists.
//   ownerChoice(...)         after resolve: Continue lets the rest start (resolve and the OWNER_ANSWER bonus already do
//                            that); Adjust parks the rest for a rewrite of their missions (the triage rewrite path);
//                            Stop parks them too, with a reason that says to cancel them. Cancelling is the owner's
//                            act, never automatic.
//
// Why the default is offer: the rest waits for one owner answer, and that stops work, so the owner rule says it is
// never applied silently. Offered as the recommended answer for gated plans, chosen per plan; nothing holds without
// that choice. always is for an owner who wants every large plan staged.
//
// Pure apart from ownerChoice, which changes the queue it is given (the caller holds the lock). Used by cli/plans.mjs
// (`plan checkpoint`) and cli/owner.mjs (resolve). Tested in lib/__tests__/planCheckpoint.test.ts and
// planCheckpointCli.test.ts.
// =============================================================
'use strict';

const G = require('./planGate.js');

const MODES = Object.freeze(['off', 'offer', 'always']);
const STANDARD = Object.freeze({ mode: 'offer' });
/** The answer options, Continue first (the recommendation). Each fits a button (logic/questions.js choicesError). */
const CHOICES = Object.freeze(['Continue', 'Adjust', 'Stop']);
/** The prefix of a checkpoint question id. */
const PREFIX = 'CP-';
/** The longest question id the queue takes (logic/questions.js QUESTION_ID_PATTERN). */
const ID_MAX = 40;

const isObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

/** plans.checkpoint from the configuration, with its own fallback. */
function checkpointSetup(cfg = {}) {
  const plans = isObject(cfg?.plans) ? cfg.plans : {};
  return { mode: MODES.includes(plans.checkpoint) ? plans.checkpoint : STANDARD.mode };
}

/**
 * Should the work be staged?
 * @param {{ mode: string, entry?: object|null, zones?: string[], smallest?: boolean }} o mode: plans.checkpoint; entry:
 *   the plan entry the work belongs to; zones: the accepted zone ids it meets; smallest: the PG-2 answer was "smallest
 *   version first"
 * @returns {{ offer: boolean, ask: boolean, mode: string, why: string|null, text: string, choices: object[] }}
 */
function stagingOffer({ mode = STANDARD.mode, entry = null, zones = [], smallest = false } = {}) {
  const none = (text) => ({ offer: false, ask: false, mode, why: null, text, choices: [] });
  if (mode === 'off') return none('No staging (plans.checkpoint off): add as asked.');
  if (smallest)
    return {
      offer: true,
      ask: false,
      mode,
      why: 'the smallest version first was chosen',
      text: 'Stage it: the smallest version first was chosen, so stage 1 now and the rest waits on one checkpoint question.',
      choices: [],
    };
  const why = entry ? G.needWhy(entry, zones) : null;
  if (!why) return none('No staging: the plan is not large (size L or XL) and meets no sensitive zone. Add as asked.');
  if (mode === 'always')
    return {
      offer: true,
      ask: false,
      mode,
      why,
      text: `Stage it (plans.checkpoint always): ${entry.id} is ${why}.`,
      choices: [],
    };
  return {
    offer: true,
    ask: true,
    mode,
    why,
    text: `${entry.id} is ${why}. Stage it?`,
    choices: [
      {
        key: 'stage',
        label:
          'Stage it (recommended): stage 1 now (1-2 tasks, a thin slice), the rest waits on one checkpoint question ' +
          'that opens when stage 1 is done',
        recommended: true,
      },
      { key: 'all', label: 'Queue it all startable', recommended: false },
    ],
  };
}

/** The checkpoint id: CP-<plan>, or CP-<first stage task> without a plan. */
function checkpointId({ plan = null, stage = [] } = {}) {
  const base = typeof plan === 'string' && plan.trim() ? plan.trim() : (stage ?? [])[0];
  return typeof base === 'string' && base ? `${PREFIX}${base}` : null;
}

/**
 * The question to register with the add (`{ tasks, question: { [id]: question } }`); the rest of the tasks get the id
 * in `waiting_on`.
 * @param {{ plan?: string|null, stage: string[], success?: string|null }} o stage: the stage-1 task ids; success: the
 *   success measure (from the decision section or the request), one line
 * @returns {{ id: string|null, question: object|null, error: string[] }}
 */
function checkpointQuestion({ plan = null, stage = [], success = null } = {}) {
  const list = Array.isArray(stage) ? stage.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : [];
  const error = [];
  if (!list.length) error.push('a checkpoint needs the stage-1 task ids (--stage <id,id>)');
  const id = checkpointId({ plan, stage: list });
  if (id && id.length > ID_MAX) error.push(`the checkpoint id ${id} is over ${ID_MAX} characters; use a shorter plan id`);
  if (error.length) return { id: null, question: null, error };
  const measure = typeof success === 'string' && success.trim() ? success.trim().replace(/[.\s]+$/, '') : null;
  return {
    id,
    question: {
      type: 'condition',
      text: `The first part is done. Success measure: ${measure ?? "the first part's acceptance criteria"}. Continue, adjust or stop?`,
      recommendation: 'Continue',
      choices: [...CHOICES],
      context:
        `The first part (${list.join(', ')}) is merged. Continue starts the rest with your answer in their missions. Adjust ` +
        'parks them so their missions can be rewritten (then ravenseat continue <id>). Stop parks them; cancel them ' +
        'yourself (ravenseat set <id> cancelled).',
      after: list,
    },
    error: [],
  };
}

/**
 * The owner's answer to a checkpoint, under the same lock as the resolve and after it. Mutates the queue.
 * @returns {null | { sp: string, action: 'continue'|'adjust'|'stop'|'none', ids: string[], error: string|null }} null =
 *   not a checkpoint question
 */
function ownerChoice(queue, sp, answer, { by = null, now = new Date().toISOString() } = {}) {
  const q = queue?.question?.[sp];
  if (typeof sp !== 'string' || !sp.startsWith(PREFIX) || !Array.isArray(q?.after)) return null;
  const s = String(answer ?? '').trim().toLowerCase();
  const ids = (queue.tasks ?? [])
    .filter((o) => o.status === 'waiting' && (o.waiting_on ?? []).includes(sp))
    .map((o) => o.id);
  const action = s.startsWith('continue') ? 'continue' : s.startsWith('adjust') ? 'adjust' : s.startsWith('stop') ? 'stop' : 'none';
  if (action === 'continue' || action === 'none' || !ids.length) return { sp, action, ids, error: null };
  const L = require('./queueLogic.js');
  const reason =
    action === 'adjust'
      ? `rewrite the mission after checkpoint ${sp}, then ravenseat continue <id>`
      : `the owner chose stop at checkpoint ${sp}: cancel (ravenseat set <id> cancelled) or ravenseat continue <id>`;
  const p = L.park(queue, ids, { by: by ?? 'owner', reason, now });
  return { sp, action, ids, error: p.error?.length ? p.error.join('; ') : null };
}

module.exports = {
  MODES,
  STANDARD,
  CHOICES,
  PREFIX,
  checkpointSetup,
  stagingOffer,
  checkpointId,
  checkpointQuestion,
  ownerChoice,
};
