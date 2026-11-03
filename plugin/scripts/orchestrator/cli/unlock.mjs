// =============================================================
// cli/unlock.mjs: `cq unlock`, the owner's way to see and release the queue lock (<dataFolder>/.lockState).
//
// A live holder on this machine is never taken over (lib/queueLock.js), so a command that hangs holding the lock stops
// every other command until someone decides. That someone is the owner:
//   cq unlock                      prints the holder, changes nothing
//   cq unlock --force --by owner   releases it. The holder keeps running but stops at its next ownership check: it
//                                  publishes nothing more and leaves the lock alone. Between its check and its rename
//                                  it can still publish once, which is why this is the owner's call and not a rule.
// Like the other owner overrides: --by is owner or theBoard, it is refused from inside a track worktree whatever --by
// says (a track can type --by owner too), and the push guard denies the whole command to queue agents (it is not in
// lib/pushGuard.js AGENT_QUEUE_COMMANDS, and --force and --by owner are denied by themselves).
//
// Used by: queue.mjs. Tested in: lib/__tests__/queueLock.test.ts.
// =============================================================

import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { a, CQ, die, FOLDER, LOCK, PREFIX, require, val } from './context.mjs';

const QL = require('./lib/queueLock.js');
const OWNER_BY = new Set(['owner', 'theBoard']);

/** The track branch the cwd is on, or null (the same question cli/taskEdit.mjs asks for a locked field). */
function trackBranchHere() {
  try {
    const branch = execFileSync('git', ['-C', process.cwd(), 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim();
    return branch.startsWith(PREFIX) && branch.length > PREFIX.length ? branch : null;
  } catch {
    return null; // Not a git tree: not a track worktree either.
  }
}

/** Does this token's process run on this machine right now? */
const runsHere = (t) => t.owner?.hostname === os.hostname() && QL.pidAlive(t.owner.pid);

/** One line per token in the lock, with whether its pid lives when this machine can tell. */
function holderLines(state) {
  const age = `${Math.round(state.ageMs / 1000)} s old`;
  if (!state.tokens.length) return [`  no readable owner (an old lock, or a holder just starting), ${age}`];
  return state.tokens.map((t) => {
    const here = t.owner?.hostname === os.hostname();
    return `  ${QL.holderText(t)}, ${age}: ${!here ? 'cannot be asked from this host' : runsHere(t) ? 'alive' : 'gone'}`;
  });
}

export function cmdUnlock() {
  const force = a.includes('--force');
  if (force && !OWNER_BY.has(String(val('--by') ?? '').trim()))
    die(`${CQ} unlock --force needs --by owner: releasing the lock is the owner's decision. Nothing was changed.`);
  const track = force ? trackBranchHere() : null;
  if (track) die(`${CQ} unlock --force cannot be run from inside a track worktree (branch ${track}); ask the owner (cq question).`);

  const state = QL.readState(LOCK);
  if (!state) {
    console.log(`No lock held on ${FOLDER}.`);
    return;
  }
  console.log(`The lock on ${FOLDER}:`);
  for (const l of holderLines(state)) console.log(l);
  if (!force) {
    console.log(`To release it: ${CQ} unlock --force --by owner. A live holder then stops at its next write.`);
    return;
  }
  const running = state.tokens.some(runsHere);
  const r = QL.forceRelease(LOCK, state);
  console.log(r.removed ? 'Released.' : `Took out ${r.taken} token(s); another process holds the lock now.`);
  if (running) console.log('The holder is still running: it stops at its next ownership check and writes nothing more.');
}
