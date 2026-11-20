// =============================================================
// planProposal.js: enrichment and confirmation of the plan register's Inbox (P7 of
// plans/plans-tab-ux-review-2026-11-19.md, section 7.3; the owner answered the questions "as recommended").
//
// Why: capturing an idea takes one step (P6, lib/planInbox.js). Sorting it (project, priority with a reason, maturity,
// size, a one-sentence summary, a duplicate to merge with) is work for Claude, but the plan stays the owner's: Claude
// writes a PROPOSAL, never a change, and the owner confirms each item on the board.
//
//   writeProposal    `ravenseat plan propose <id> --file f.json` (the /plans skill's "sort the inbox" step). Stores the
//                    suggestion in the tool-owned field `proposal` { at, by, fields, merge?, outline? } and changes
//                    nothing else. Only for an Inbox item (a captured plan or a new finding). A proposal that could not
//                    be accepted (an unknown project, say) is refused now, so Accept never fails on Claude's mistake.
//                    plans.inboxTriage off refuses it. plans.inboxAutoApply (off by default) applies it at once only
//                    for a captured plan whose proposal keeps the priority later and names no merge.
//   acceptProposal   the board's Accept and "Edit then accept" (`plan accept <id> [--file edits.json] --set-by owner`):
//                    the proposal's fields with the owner's edits on top, in ONE register change (one undo); the inbox
//                    marker and the proposal go; the captured text is kept in `original_text` when the summary is
//                    rewritten. Without a proposal it is the owner sorting by hand (the board's Edit).
//   declineProposal  Decline: the plan is dropped with the owner's reason (`plan decline <id> [--reason]`).
//   mergeProposal    Merge into PL-X: queuePlan.combineTogether (`plan merge <id> --into <PL-X>`); the archive keeps
//                    the captured text.
// Accept, Decline and Merge are the owner's only (role owner): an agent that calls them gets a refusal.
//
// Pure, no I/O: the CLI (cli/planInbox.mjs) does the lock and the write through cli/planShared.mjs editPlans, so each
// action is one changelog entry and the board's Undo is `plan undo --nr`. Tested in lib/__tests__/planProposal.test.ts.
// =============================================================
'use strict';

const P = require('./queuePlan.js');
const V = require('./queuePlanView.js');
const FI = require('./queueFindings.js');
const I = require('./planInbox.js');

const LIMIT = V.PROPOSAL;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => JSON.parse(JSON.stringify(v));
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const OWNER_ONLY =
  'the owner confirms each Inbox item (Accept, Decline or Merge on the board, or --set-by owner when the owner says so)';
const DECLINE_REASON = 'Declined in the inbox.';

/** Is the entry in the Inbox: a captured plan not sorted yet, or a finding nobody has triaged (the board's rule)? */
function inInbox(entry, tasks = []) {
  return I.isInInbox(entry, tasks) || FI.isNewFinding(entry, tasks);
}

/**
 * The fields of a proposal or of the owner's edits, checked: only V.PROPOSAL.FIELDS (never the title, never drop).
 * `edits` allows null (keep the field as it is); a proposal does not.
 * @returns {{ fields: object, error: string[] }}
 */
function fieldsInput(raw, { edits = false } = {}) {
  const error = [];
  const fields = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!LIMIT.FIELDS.includes(k)) {
      error.push(
        k === 'title'
          ? 'the title is the owner\'s own words; a proposal does not change it'
          : `${k} is not a field a proposal can suggest (${LIMIT.FIELDS.join(', ')})`,
      );
      continue;
    }
    if (v === null && edits) {
      fields[k] = null;
      continue;
    }
    if (v == null) continue;
    if (k === 'priority' && !LIMIT.PRIORITIES.includes(v))
      error.push(
        v === 'drop'
          ? 'a proposal does not drop a plan; say why in the summary, and the owner declines it'
          : `priority must be one of ${LIMIT.PRIORITIES.join(', ')}`,
      );
    else if (k === 'summary' && (typeof v !== 'string' || v.trim().length > LIMIT.SUMMARY_MAX))
      error.push(`the summary must be text of at most ${LIMIT.SUMMARY_MAX} characters (one sentence)`);
    else if (k === 'priority_reason' && (typeof v !== 'string' || v.trim().length > LIMIT.REASON_MAX))
      error.push(`priority_reason must be text of at most ${LIMIT.REASON_MAX} characters (one sentence)`);
    fields[k] = typeof v === 'string' ? v.trim() : clone(v);
  }
  return { fields, error };
}

/**
 * The input of `plan propose` ({ ...fields, merge?, outline? }), checked against the register.
 * @returns {{ fields: object, merge: string[], outline: string|null, error: string[] }}
 */
function proposalInput(reg, id, raw) {
  if (!isObject(raw)) return { fields: {}, merge: [], outline: null, error: ['the proposal must be an object'] };
  const { merge: mergeRaw, outline: outlineRaw, ...rest } = raw;
  const { fields, error } = fieldsInput(rest);
  if (fields.priority && fields.priority !== 'later' && !fields.priority_reason)
    error.push('a suggested priority needs priority_reason (one sentence: which priority rule and why)');
  const merge = [];
  if (mergeRaw != null) {
    if (!Array.isArray(mergeRaw) || mergeRaw.some((x) => typeof x !== 'string'))
      error.push('merge must be a list of plan ids');
    else if (mergeRaw.length > LIMIT.MERGE_MAX) error.push(`merge names at most ${LIMIT.MERGE_MAX} plans`);
    else
      for (const m of new Set(mergeRaw)) {
        if (m === id) error.push(`${id} cannot be merged with itself`);
        else if (!(reg.entries ?? []).some((p) => p.id === m)) error.push(`merge: unknown planEntry ${m}`);
        else merge.push(m);
      }
  }
  let outline = null;
  if (outlineRaw != null) {
    if (typeof outlineRaw !== 'string') error.push('the outline must be text');
    else if (outlineRaw.length > LIMIT.OUTLINE_MAX)
      error.push(`the outline is over ${LIMIT.OUTLINE_MAX} characters (a longer plan belongs in a document under sources)`);
    else outline = outlineRaw.replace(/\r\n?/g, '\n').trim() || null;
  }
  if (!error.length && !Object.keys(fields).length && !merge.length && !outline)
    error.push('the proposal suggests nothing (give at least one field, a merge or an outline)');
  return { fields, merge, outline, error };
}

/** The entry, or an error answer: unknown, merged, or not in the Inbox. */
function inboxEntry(reg, id, tasks) {
  const entry = (reg.entries ?? []).find((p) => p.id === id);
  if (!entry)
    return {
      error: [reg.archive?.[id] ? `${id} is merged into ${reg.archive[id].merged_to}` : `unknown planEntry ${id}`],
    };
  if (!inInbox(entry, tasks))
    return { error: [`${id} is not in the inbox (it is sorted already, dropped, or a queue task points to it)`] };
  return { entry, error: [] };
}

/**
 * Accept: the proposal's fields with the owner's `edits` on top (null in an edit keeps the field as it is), applied in
 * one change; the inbox marker and the proposal go. Owner only.
 * @param {object} reg the register (normalized); mutated only when everything is valid
 * @param {string} id
 * @param {object} [edits] the owner's changes from "Edit then accept" (V.PROPOSAL.FIELDS)
 * @param {{ role?: string, projects?: object, question?: object, tasks?: object[], existsPath?: Function,
 *   now?: string, by?: string, auto?: boolean }} ctx  auto: plans.inboxAutoApply (writeProposal), never from a caller
 * @returns {{ error: string[], warnings: string[], entry?: object, applied?: string[] }}
 */
function acceptProposal(reg, id, edits = {}, ctx = {}) {
  if (ctx.role !== 'owner' && ctx.auto !== true) return { error: [`${id}: ${OWNER_ONLY}`], warnings: [] };
  const tasks = ctx.tasks ?? [];
  const found = inboxEntry(reg, id, tasks);
  if (found.error.length) return { error: found.error, warnings: [] };
  const entry = found.entry;
  if (edits != null && !isObject(edits)) return { error: [`${id}: the edits must be an object`], warnings: [] };
  const e = fieldsInput(edits ?? {}, { edits: true });
  if (e.error.length) return { error: e.error.map((x) => `${id}: ${x}`), warnings: [] };
  const want = { ...clone(entry.proposal?.fields ?? {}), ...e.fields };
  for (const [k, v] of Object.entries(want)) if (v === null) delete want[k];
  // auto-apply never touches the priority (it applies only when the proposal keeps later)
  if (ctx.auto === true) for (const k of ['priority', 'now_category', 'priority_reason']) delete want[k];
  const field = {};
  for (const [k, v] of Object.entries(want)) if (!same(v, entry[k])) field[k] = v;
  if (entry.inbox) field.inbox = null;
  const before = entry.summary ?? null;
  let warnings = [];
  if (Object.keys(field).length) {
    const r = P.editEntry(reg, id, field, {
      role: 'owner',
      by: ctx.by,
      projects: ctx.projects ?? {},
      question: ctx.question ?? {},
      existsPath: ctx.existsPath,
      decisionIds: ctx.decisionIds,
      now: ctx.now,
    });
    if (r.error.length) return { error: r.error, warnings: r.warnings ?? [] };
    warnings = r.warnings ?? [];
  }
  const fresh = reg.entries.find((p) => p.id === id);
  delete fresh.proposal;
  // A finding stays "new" while it is later and an idea set by an agent: the owner's Accept is the triage.
  if (FI.isNewFinding(fresh, tasks)) fresh.priority_set_by = 'owner';
  if ('summary' in field && before && fresh.summary !== before && fresh.original_text == null)
    fresh.original_text = before;
  return { error: [], warnings, entry: fresh, applied: Object.keys(field).filter((k) => k !== 'inbox') };
}

/**
 * `plan propose`: stores Claude's suggestion and changes nothing else (unless plans.inboxAutoApply is on and the
 * proposal is a quiet one, see the top of the file).
 * @param {{ by?: string, now?: string, tasks?: object[], projects?: object, question?: object, existsPath?: Function,
 *   triage?: 'on-request'|'idle'|'off', autoApply?: boolean }} ctx
 * @returns {{ error: string[], warnings: string[], entry?: object, applied?: boolean }}
 */
function writeProposal(reg, id, raw, ctx = {}) {
  if (ctx.triage === 'off')
    return { error: ['sorting the inbox is off (plans.inboxTriage off in queue.config.json)'], warnings: [] };
  const tasks = ctx.tasks ?? [];
  const found = inboxEntry(reg, id, tasks);
  if (found.error.length) return { error: found.error, warnings: [] };
  const x = proposalInput(reg, id, raw);
  if (x.error.length) return { error: x.error.map((t) => `${id}: ${t}`), warnings: [] };
  // Would Accept work? Tried on a copy, so a proposal the owner cannot accept is refused now.
  const trial = clone({ entries: reg.entries, archive: reg.archive ?? {}, documents: reg.documents ?? [] });
  const t = trial.entries.find((p) => p.id === id);
  t.proposal = { at: 'x', by: 'x', fields: x.fields };
  const tr = acceptProposal(trial, id, {}, { ...ctx, role: 'owner' });
  if (tr.error.length) return { error: tr.error, warnings: tr.warnings ?? [] };
  const entry = found.entry;
  entry.proposal = {
    at: ctx.now ?? new Date().toISOString(),
    by: typeof ctx.by === 'string' && ctx.by ? ctx.by : 'agent',
    fields: x.fields,
    ...(x.merge.length ? { merge: x.merge } : {}),
    ...(x.outline ? { outline: x.outline } : {}),
  };
  const quiet =
    ctx.autoApply === true &&
    Boolean(entry.inbox) &&
    entry.priority === 'later' &&
    (x.fields.priority == null || x.fields.priority === 'later') &&
    !x.merge.length;
  if (!quiet) return { error: [], warnings: tr.warnings ?? [], entry, applied: false };
  const a = acceptProposal(reg, id, {}, { ...ctx, role: 'owner', auto: true });
  if (a.error.length) return { error: a.error, warnings: a.warnings ?? [] };
  return { error: [], warnings: a.warnings ?? [], entry: a.entry, applied: true };
}

/** Decline: the plan is dropped with the owner's reason (a plain default without one). Owner only. */
function declineProposal(reg, id, { reason } = {}, ctx = {}) {
  if (ctx.role !== 'owner') return { error: [`${id}: ${OWNER_ONLY}`], warnings: [] };
  const found = inboxEntry(reg, id, ctx.tasks ?? []);
  if (found.error.length) return { error: found.error, warnings: [] };
  const why = typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, LIMIT.REASON_MAX) : DECLINE_REASON;
  const field = { priority: 'drop', drop_reason: why, ...(found.entry.inbox ? { inbox: null } : {}) };
  const r = P.editEntry(reg, id, field, {
    role: 'owner',
    by: ctx.by,
    projects: ctx.projects ?? {},
    question: ctx.question ?? {},
    existsPath: ctx.existsPath,
    now: ctx.now,
  });
  if (r.error.length) return r;
  delete reg.entries.find((p) => p.id === id).proposal;
  return { ...r, error: [] };
}

/** Merge into another plan (queuePlan.combineTogether); the archive keeps the captured text. Owner only. */
function mergeProposal(reg, id, to, ctx = {}) {
  if (ctx.role !== 'owner') return { error: [`${id}: ${OWNER_ONLY}`], warnings: [] };
  const found = inboxEntry(reg, id, ctx.tasks ?? []);
  if (found.error.length) return { error: found.error, warnings: [] };
  if (to === id) return { error: [`${id} cannot be merged with itself`], warnings: [] };
  if (!(reg.entries ?? []).some((p) => p.id === to)) return { error: [`unknown planEntry ${to}`], warnings: [] };
  const r = P.combineTogether(reg, to, [id], { now: ctx.now });
  if (r.error.length) return r;
  const arch = reg.archive?.[id];
  if (arch) {
    delete arch.proposal;
    delete arch.inbox;
  }
  return r;
}

// ---- The board ------------------------------------------------------------------------------------------------

const ID = /^PL-[A-Za-z0-9ÆØÅæøå-]{1,60}$/;
const ACTIONS = ['accept', 'decline', 'merge'];

/**
 * POST /api/plan-proposal { action, id, edits?, reason?, to?, expect? } from the board, checked here so the server
 * only runs what this returns: `queue.mjs plan accept|decline|merge` as the owner (--set-by owner, --by theBoard), with
 * --expect-changed when the board sends the version it showed. The edits and the reason go in a file (`file`, written
 * by the server to a temporary path and given to `args(path)`), never on a command line.
 * @returns {{ error: string[], action?: string, id?: string, file?: object|null, args?: (path: string|null) => string[] }}
 */
function boardCall(b) {
  const error = [];
  const s = isObject(b) ? b : {};
  if (!ACTIONS.includes(s.action)) error.push(`action must be one of ${ACTIONS.join(', ')}`);
  const id = typeof s.id === 'string' && ID.test(s.id) ? s.id : null;
  if (!id) error.push('invalid plan entry');
  if (s.expect != null && !Number.isFinite(Date.parse(String(s.expect)))) error.push('invalid expect');
  let file = null;
  let to = null;
  if (s.action === 'accept') {
    if (s.edits != null && !isObject(s.edits)) error.push('the edits must be an object');
    else {
      const e = fieldsInput(s.edits ?? {}, { edits: true });
      error.push(...e.error);
      file = e.fields;
    }
  } else if (s.action === 'decline') {
    if (s.reason != null && typeof s.reason !== 'string') error.push('the reason must be text');
    else if (typeof s.reason === 'string' && s.reason.length > LIMIT.REASON_MAX)
      error.push(`the reason is over ${LIMIT.REASON_MAX} characters (one sentence is enough)`);
    else file = s.reason?.trim() ? { reason: s.reason.trim() } : {};
  } else if (s.action === 'merge') {
    to = typeof s.to === 'string' && ID.test(s.to) ? s.to : null;
    if (!to) error.push('choose the plan to merge into');
    else if (to === id) error.push(`${id} cannot be merged with itself`);
  }
  if (error.length) return { error };
  const tail = ['--set-by', 'owner', '--by', 'theBoard', '--json', ...(s.expect != null ? ['--expect-changed', String(s.expect)] : [])];
  return {
    error: [],
    action: s.action,
    id,
    file,
    args: (path) =>
      s.action === 'merge'
        ? ['plan', 'merge', id, '--into', to, ...tail]
        : ['plan', s.action, id, '--file', String(path), ...tail],
  };
}

module.exports = {
  LIMIT,
  boardCall,
  DECLINE_REASON,
  inInbox,
  proposalInput,
  writeProposal,
  acceptProposal,
  declineProposal,
  mergeProposal,
};
