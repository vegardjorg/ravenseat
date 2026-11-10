// =============================================================
// fixPlateau.js: the fix-round plateau.
//
// A fix round costs a whole track session. Two signs that the next round will not help:
//   - the branch tip did not move since the previous fix round started (that round committed nothing), or
//   - the failure now is the same as the failure before the previous fix round (same kind, exit and output tail).
// Then the queue asks the owner before the next round, instead of paying for more of the same until the cap.
//
// Pure functions only. cli/run.mjs (cmdResume) reads the tip with git, builds the signature from the same done check
// and gate check it writes into the fix file, and stores both on the new `resumed` entry, so the next round can
// compare. Old entries without the fields never give a plateau.
// =============================================================
'use strict';

const crypto = require('node:crypto');

/**
 * Normalizes one output line so that noise between two runs of the same failure does not count: ANSI colours,
 * durations, clock times, ISO timestamps and hex shas. Plain counts ("2 failed") are kept on purpose: a change there is
 * progress.
 */
function normalizeLine(line) {
  return String(line ?? '')
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .toLowerCase()
    .replace(/\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}(\.\d+)?z?/g, '#ts')
    .replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, '#clock')
    .replace(/\b\d+(\.\d+)?\s?(ms|s|sec|secs|seconds)\b/g, '#t')
    .replace(/\b[0-9a-f]{7,40}\b/g, (m) => (/[a-f]/.test(m) && /\d/.test(m) ? '#h' : m))
    .replace(/\s+/g, ' ')
    .trim();
}

function hashOf(parts) {
  return crypto.createHash('sha1').update(parts.join('\n')).digest('hex').slice(0, 12);
}

/**
 * A short signature of the failure that starts this fix round, or null without one. The done check wins over the gate
 * check, which wins over review findings, the same order as the fix file. Two equal signatures mean the same failure.
 */
function failureSignature({ doneCheck = null, gateCheck = null, findingsText = null } = {}) {
  if (doneCheck) {
    const kind = doneCheck.timedOut ? 'done-timeout' : 'done';
    return `${kind}:${doneCheck.exit ?? '-'}:${hashOf((doneCheck.tail ?? []).map(normalizeLine))}`;
  }
  if (gateCheck) return `gate:${gateCheck.exit ?? '-'}:${hashOf((gateCheck.tail ?? []).map(normalizeLine))}`;
  const f = typeof findingsText === 'string' ? findingsText.trim() : '';
  if (f) return `findings:${hashOf(f.split(/\r?\n/).map(normalizeLine))}`;
  return null;
}

/** The owner question id, within the 40-character id rule (like capQuestionId in doneCheck.js). */
function plateauQuestionId(id, n) {
  const suffix = `.plateau${n}`;
  return `${String(id).slice(0, 40 - suffix.length)}${suffix}`;
}

/**
 * Is the task on a plateau? Compares the round about to start with the LAST fix round that has the fields.
 * @param o the task (o.resumed holds the earlier rounds)
 * @param now { tip, signature } for the round about to start
 * @returns {{ kind: 'tip'|'failure', previous: number, questionId: string } | null}
 */
function plateauOf(o, { tip = null, signature = null } = {}) {
  const fixes = (o?.resumed ?? []).filter((r) => r?.reason === 'fix');
  const prev = [...fixes].reverse().find((r) => r.tip || r.signature);
  if (!prev) return null;
  const questionId = plateauQuestionId(o.id, fixes.length);
  if (tip && prev.tip && tip === prev.tip) return { kind: 'tip', previous: prev.round, questionId };
  if (signature && prev.signature && signature === prev.signature) return { kind: 'failure', previous: prev.round, questionId };
  return null;
}

/** The owner question (the input for queueLogic.setQuestion) on a plateau. */
function plateauQuestion(o, p) {
  const seen =
    p.kind === 'tip'
      ? `fix round ${p.previous} ended with no new commits on the branch`
      : `the check fails with the same failure as before fix round ${p.previous}`;
  return {
    [p.questionId]: {
      type: 'question',
      text:
        `${o.id} (${o.title ?? ''}) looks stuck: ${seen}. Another round of the same is likely to cost a session without ` +
        'progress. Should the queue start another fix round, or do you take it over, split it or cancel it?',
      recommendation:
        'Read the last report and the fix file before another round. Another round: answer with what the agent should do ' +
        `differently (ravenseat resolve ${p.questionId} --answer "…"); give up: ravenseat set ${o.id} cancelled. ` +
        'Turn the check off for the queue with "fixPlateau": false in queue.config.json.',
      source: `fix-round plateau (${o.id})`,
    },
  };
}

/** On unless the config says "fixPlateau": false. */
function plateauOn(cfg = {}) {
  return cfg?.fixPlateau !== false;
}

module.exports = { normalizeLine, failureSignature, plateauQuestionId, plateauOf, plateauQuestion, plateauOn };
