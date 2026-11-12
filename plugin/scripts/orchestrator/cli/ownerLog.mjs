// =============================================================
// cli/ownerLog.mjs: `ravenseat owner-log`, the owner's view of the owner rows a task relies on against the owner log
// (lib/ownerLog.js, <dataFolder>/owner-log.json, owner decision B2), and the way to confirm rows that were the owner's.
//   ravenseat owner-log <id>                    lists the task's owner rows the log does not have, changes nothing
//                                               (the first use records the rows there are as the baseline)
//   ravenseat owner-log accept <id> --by owner  records them; ravenseat receive and ravenseat merge go on again
// Like ravenseat surface accept (cli/surface.mjs): --by is owner or theBoard, it is refused from inside a track worktree
// whatever --by says, and the push guard denies the whole command to queue agents (it is not in lib/pushGuard.js
// AGENT_QUEUE_COMMANDS, and --by owner is denied by itself). Labels only: never an answer's text.
//
// Used by: queue.mjs. Tested in: __tests__/gateEvidenceFlow.test.ts.
// =============================================================

import { a, CLI, CONFIG, die, FOLDER, queueBranchId, read, require, val, withLock } from './context.mjs';

const OL = require('./lib/ownerLog.js');
const GE = require('./lib/gateEvidence.js');

const USAGE = `${CLI} owner-log <id> | ${CLI} owner-log accept <id> --by owner`;

/** The task, or a stop when it is unknown. */
function taskOrDie(queue, id) {
  if (!id || id.startsWith('--')) die(USAGE);
  if (!(queue.tasks ?? []).some((t) => t?.id === id)) die(`Unknown task ${id}`);
}

function show(id) {
  const queue = read();
  taskOrDie(queue, id);
  if (GE.modeOf(CONFIG) === 'off')
    console.log('gateEvidence.mode is off in queue.config.json: receive and merge do not check owner rows.');
  const r = withLock(() => OL.check(FOLDER, read(), id));
  if (r.baseline) console.log(`Owner log started (${OL.logFile(FOLDER)}): the owner rows in the queue now are its baseline.`);
  if (!r.missing.length) {
    console.log(`Every owner row of ${id} is in the owner log; no owner row of ${id} is missing.`);
    return;
  }
  console.log(`${r.missing.length} owner row(s) of ${id} are in queue.json but not in the owner log:`);
  for (const m of r.missing) console.log(`  - ${m.label}`);
  console.log(
    `If they are yours: ${CLI} owner-log accept ${id} --by owner. If not: take them out of the queue file and find out ` +
      'what wrote them. Nothing was changed.',
  );
}

export function cmdOwnerLog() {
  const sub = a[1];
  if (sub !== 'accept') return show(sub);
  const id = a[2];
  const by = String(val('--by') ?? '').trim();
  if (!OL.OWNER_BY.has(by))
    die(`${CLI} owner-log accept needs --by owner: confirming an owner row is the owner's decision. Nothing was changed.`);
  const track = queueBranchId();
  if (track) die(`${CLI} owner-log accept cannot be run from inside a track worktree (task ${track}); ask the owner (ravenseat question).`);
  const r = withLock(() => {
    const queue = read();
    taskOrDie(queue, id);
    return OL.accept(FOLDER, queue, id, by);
  });
  if (!r.ok) die(`${CLI} owner-log accept: ${r.error}. Nothing was changed.`);
  console.log(
    r.accepted
      ? `Accepted ${r.accepted} owner row(s) of ${id} as yours. ${CLI} receive ${id} and ${CLI} merge ${id} go on again.`
      : `No owner row of ${id} was missing; nothing to accept.`,
  );
}
