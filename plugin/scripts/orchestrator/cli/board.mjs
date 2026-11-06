// =============================================================
// cli/board.mjs: `ravenseat board-setting`, the board's own switches (not `ravenseat board`, which starts the board), so Claude Code can set what the board shows.
//
//   ravenseat board-setting             the switches and their values (queue.json board wins over queue.config.json board)
//   ravenseat board-setting cloud on|off        show or hide the Cloud tab (board.showCloud; the tab needs features.cloud on too)
//
// A write goes to queue.json (board.<switch>) under the lock, like `limit` and `helpers`; the board's gear (Settings,
// Board) calls this command. The rules are lib/queueConfig.js boardSwitches.
//
// Used by: queue.mjs (dispatch). Tested in: lib/__tests__/queueBoardSwitches.test.ts.
// =============================================================

import { a, CONFIG, die, edit, KK, read } from './context.mjs';

/** `ravenseat board-setting [cloud on|off]` (the usage is at the top of queue.mjs). */
export function cmdBoard() {
  const [, what, mode] = a;
  if (!what) {
    const s = KK.boardSwitches(CONFIG, read());
    const cloudOn = KK.featureOn('cloud', CONFIG);
    console.log(`Cloud tab: ${s.showCloud ? 'shown' : 'hidden'} (board.showCloud${cloudOn ? '' : '; features.cloud is off, so there is no tab either way'})`);
    return;
  }
  if (what !== 'cloud' || !['on', 'off'].includes(mode)) die('use: ravenseat board-setting [cloud on|off]');
  const on = mode === 'on';
  edit((queue) => {
    queue.board = { ...(queue.board && typeof queue.board === 'object' ? queue.board : {}), showCloud: on };
  });
  console.log(
    `Cloud tab ${on ? 'shown' : 'hidden'} on the board (queue.json board.showCloud = ${on}).` +
      (on && !KK.featureOn('cloud', CONFIG) ? ' Note: features.cloud is off in queue.config.json, so the tab stays away until it is on.' : ''),
  );
}
