// =============================================================
// demoOffer.js: the demo board offer and the demo banner's texts (owner decision 22.11, see docs/board.md "Demo mode").
//
// A first-time user who opens an empty board can explore a populated demo board ("Pebble", a made-up habit tracker).
// The offer shows while the queue has never had a task: "Show me a demo board", "Not now" (back on the next visit) and
// "Don't show again" (stored per project in <dataFolder>/demo-offer.json, lib/demoMode.js). The first real task ends it.
// After that the row at the bottom of Settings ("Show demo board") opens the demo. board.demoOffer false hides the offer.
//
// Both a CommonJS module (the server, lib/__tests__/demoMode.test.ts) and a script in the browser (queue-board.mjs serves
// it as /demoOffer.js and it sets window.QueueDemo), like queueUpdate.js. Pure: no disk, no network.
// =============================================================
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.QueueDemo = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** sessionStorage key for "Not now": one visit (the browser tab's session), so the next visit shows the offer again. */
  const NOT_NOW_KEY = 'queue-board-demo-not-now';

  /**
   * Does the offer card show? Only on a queue that has never had a task (no task in queue.json and none archived), while
   * board.demoOffer is on, the project has not said "Don't show again", and this visit has not said "Not now".
   * @param {{ setting: boolean, dismissed: boolean, taskCount: number, archivedCount: number, notNow?: boolean }} o
   * @returns {boolean}
   */
  function offerShown(o) {
    if (!o || o.setting !== true || o.dismissed === true || o.notNow === true) return false;
    return Number(o.taskCount ?? 0) === 0 && Number(o.archivedCount ?? 0) === 0;
  }

  const TEXTS = Object.freeze({
    offerTitle: 'Want to see a board with work on it?',
    offerBody:
      'The demo board is a made-up project, Pebble, with tasks in every column, questions to answer and a few days of ' +
      'history. Click around freely: it lives in its own folder, and nothing you do there touches your queue.',
    show: 'Show me a demo board',
    notNow: 'Not now',
    never: "Don't show again",
    neverDone: 'The demo offer is hidden. Settings > Show demo board opens it any time.',
    banner: 'Demo data: nothing here is real',
    bannerInfo:
      'You can answer, approve, edit and move cards. Starting work, git, gates, settings changes and agents are off here, ' +
      'and branches and diffs are empty. Commands you copy run on your real queue.',
    back: 'Back to my board',
    reset: 'Reset demo',
    titlePrefix: 'Demo · ',
    settingsTitle: 'Show demo board',
    settingsInfo:
      'A made-up project with work in every column, in its own folder. Nothing you do there reaches your queue; the ' +
      'banner at the top takes you back.',
  });

  return { NOT_NOW_KEY, offerShown, TEXTS };
});
