// =============================================================
// logic/validate.js: validation of a new task (validate) and of its project fields (validateNewField).
//
// The required fields, class and status, the project, feature, labels, qa_status, requires and evidence fields. Kept
// apart because pick, external, batch and edit all validate tasks, and the field rules depend on the QA evidence rules.
//
// Part of the queueLogic.js split: lib/queueLogic.js re-exports every name, so callers keep requiring queueLogic.js.
// Used by queueLogic.js (the facade) only.
// Tested in lib/__tests__/queueLogic.test.ts, queueProjectPick.test.ts and queueRequires.test.ts (through
// queueLogic.js).
// =============================================================

const { STATUSES, CLASSES, WITHOUT_PROJECT, QA_STATUSES, PID_PATTERN, LABEL_PATTERN, REQUIRES } = require('./base.js');
const { validateEvidence } = require('./evidence.js');

/**
 * Validates a new task. Returns a list of errors (empty = valid).
 * Required: id, title, domain, class, mission (path to track description or text).
 * `register` (the queue's `projects`): when it has at least one project, an explicit `project` must exist in it.
 */
function validate(o, existing = [], register) {
  const error = [];
  if (!o || typeof o !== 'object') return ['task must be an object'];
  if (!o.id || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/.test(o.id))
    error.push('id missing or has invalid characters');
  if (existing.some((e) => e.id === o.id)) error.push(`id ${o.id} already exists`);
  if (!o.title) error.push('title missing');
  if (!o.domain) error.push('domain missing');
  if (!CLASSES.has(o.class)) error.push(`class must be one of ${[...CLASSES].join(', ')}`);
  if (!o.mission) error.push('mission missing (path to track description or text)');
  if (o.status && !STATUSES.has(o.status)) error.push(`unknown status ${o.status}`);
  for (const field of ['depends_on', 'waiting_on', 'owned_files', 'owner_db', 'shared_patch']) {
    if (o[field] != null && !Array.isArray(o[field])) error.push(`${field} must be a list`);
  }
  if (o.value != null && !(o.value >= 1 && o.value <= 10)) error.push('value must be 1–10');
  // `fixes`: the task(s) this one fixes (lib/fixLinks.js). The shape here; add and edit also check that the ids exist.
  error.push(...require('../fixLinks.js').fixesShapeError(o));
  const emptyRegister = !register || Object.keys(register).length === 0;
  error.push(...validateNewField(o, register, { stringProject: !emptyRegister }));
  return error;
}
/**
 * The project fields (project, feature, labels, qa_status). All are optional. With `stringProject` an
 * explicit project must exist in the register (writeError would otherwise create a new, empty project in the `projects` table).
 */
function validateNewField(o, register, { stringProject = true } = {}) {
  const error = [];
  if (o.project != null) {
    if (typeof o.project !== 'string' || !PID_PATTERN.test(o.project))
      error.push('project must be a short kebab-case id (e.g. api-v2)');
    else if (
      stringProject &&
      o.project !== WITHOUT_PROJECT &&
      !Object.hasOwn(register ?? {}, o.project)
    )
      error.push(
        `unknown project ${o.project} (create it first: cq project ${o.project} --title "…")`,
      );
  }
  // Plan entry the task belongs to (id in scripts/.queue/plans.json; queue.mjs checks that it exists).
  if (o.plan != null && (typeof o.plan !== 'string' || !/^PL-\S+$/.test(o.plan)))
    error.push('plan must be a plan entry id (PL-NAME-1)');
  if (o.feature != null && (typeof o.feature !== 'string' || !o.feature.trim()))
    error.push('feature must be a text (short name, e.g. "Today\'s staffing")');
  if (
    o.labels != null &&
    (!Array.isArray(o.labels) ||
      o.labels.some((e) => typeof e !== 'string' || !LABEL_PATTERN.test(e)))
  )
    error.push('labels must be a list of short lowercase words (e.g. ["visual"])');
  if (
    o.requires != null &&
    (!Array.isArray(o.requires) || o.requires.some((k) => typeof k !== 'string' || !REQUIRES.has(k)))
  )
    error.push(`requires must be a list of ${[...REQUIRES].join(', ')}`);
  if (o.qa_status != null && !QA_STATUSES.has(o.qa_status))
    error.push(`qa_status must be one of ${[...QA_STATUSES].join(', ')}`);
  // How the owner (or the queue itself) sees that the delivery works (config().qa).
  if (o.evidence != null) error.push(...validateEvidence(o.evidence));
  // "put on hold" for one task (queue.mjs park).
  if (o.parked != null) {
    const p = o.parked;
    const valid =
      typeof p === 'object' &&
      !Array.isArray(p) &&
      typeof p.by === 'string' &&
      !!p.by.trim() &&
      typeof p.at === 'string' &&
      Number.isFinite(Date.parse(p.at)) &&
      (p.to == null || (typeof p.to === 'string' && Number.isFinite(Date.parse(p.to)))) &&
      (p.reason == null || typeof p.reason === 'string');
    if (!valid) error.push('parked must be { by, at, reason?, to? } (set with cq park)');
  }
  return error;
}

module.exports = {
  validate,
  validateNewField,
};
