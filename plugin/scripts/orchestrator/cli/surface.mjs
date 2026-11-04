// =============================================================
// cli/surface.mjs: `cq surface`, the owner's view of what in git runs code against the accepted baseline
// (lib/gitSurfaceBaseline.js, <dataFolder>/git-surface.json), and the way to accept a legitimate change.
//   cq surface                     prints whether it matches and each difference with where to look, changes nothing
//   cq surface accept --by owner   accepts the current state; cq receive, cq merge and push-check go on again
// Like the other owner overrides (cli/unlock.mjs): --by is owner or theBoard, it is refused from inside a track worktree
// whatever --by says (a track can type --by owner too), and the push guard denies the whole command to queue agents (it
// is not in lib/pushGuard.js AGENT_QUEUE_COMMANDS, and --by owner is denied by itself).
// Values are never shown: names, full paths of hooks and the file a config key comes from.
//
// Used by: queue.mjs. Tested in: __tests__/gitSurfaceBaseline.test.ts.
// =============================================================

import { execFileSync } from 'node:child_process';
import { a, CQ, die, FOLDER, GIT_ROOT, PREFIX, require, val } from './context.mjs';

const GB = require('./lib/gitSurfaceBaseline.js');
const OWNER_BY = new Set(['owner', 'theBoard']);

/** The track branch the cwd is on, or null (the same question cli/unlock.mjs asks). */
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

function showDifferences() {
  if (GB.mode() !== 'stop') console.log(`gitSurface is ${GB.mode()} in queue.config.json: a difference does not stop anything.`);
  const baseline = GB.read(FOLDER);
  if (!baseline) {
    console.log(`No accepted baseline yet on ${FOLDER}. The next fill, start, resume, receive or merge records the current state.`);
    return;
  }
  const accepted = baseline.unreadable ? '' : ` (accepted ${baseline.accepted_at} by ${baseline.by})`;
  const detail = GB.driftDetail(FOLDER, GIT_ROOT);
  if (!detail) {
    console.log(`The git hooks and config that run code match the accepted baseline${accepted}.`);
    return;
  }
  console.log(`The git hooks and config that run code differ from the accepted baseline${accepted}:`);
  if (!detail.differences.length) for (const c of detail.changes) console.log(`  ${c}`);
  for (const d of detail.differences) {
    console.log(`  ${d.kind.padEnd(19)}${d.name}`);
    console.log(`  ${''.padEnd(19)}${d.where}`);
  }
  if (detail.hint) console.log(`Hint: this ${detail.hint}. It is only a hint; nothing is accepted because of it.`);
  console.log(
    'This is normal after installing a hook tool (husky, lefthook) or changing your git config. If a file above is yours and\n' +
      `you made the change: ${CQ} surface accept --by owner. Otherwise remove it. Values are never shown; to read them:\n` +
      'git config --list --show-origin, and the hook files above. Nothing was changed.',
  );
}

export function cmdSurface() {
  const sub = a[1];
  if (sub === undefined || sub.startsWith('--')) return showDifferences();
  if (sub !== 'accept') die(`${CQ} surface [accept --by owner]`);
  const by = String(val('--by') ?? '').trim();
  if (!OWNER_BY.has(by))
    die(`${CQ} surface accept needs --by owner: accepting what runs at the next git command is the owner's decision. Nothing was changed.`);
  const track = trackBranchHere();
  if (track) die(`${CQ} surface accept cannot be run from inside a track worktree (branch ${track}); ask the owner (cq question).`);
  const before = GB.driftDetail(FOLDER, GIT_ROOT);
  const r = GB.accept(FOLDER, GIT_ROOT, by);
  if (!r.ok) die(`${CQ} surface accept: ${r.error}. Nothing was changed.`);
  console.log(
    before
      ? `Accepted (${before.changes.join('; ')}). The queue goes on with this state.`
      : 'Accepted: this is now the baseline.',
  );
  console.log(`A check that is running right now puts the old baseline back when it ends; if the stop comes back, accept once more.`);
}
