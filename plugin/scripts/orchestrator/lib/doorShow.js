// =============================================================
// doorShow.js: the switch for door and blast radius (mergeDanger.show, friction review 22.11 Top 4).
//
// WHY: door and blast radius (MS-1, lib/mergeDanger.js) cost a few tokens per track report and per review. It is
//   display only and never stops work, so it is on by default: it is what makes a one-way door visible. A project that
//   does not want it turns mergeDanger.show off, and then it is gone everywhere, not just hidden in one place:
//   - the mission leaves the template sentence out (trimTemplate) and says in one line that the two lines are off
//     (OFF_TRACK), since the track agent files ask for them by default;
//   - the reviewer prompt leaves its sentence out and says the same (OFF_REVIEWER);
//   - receive prints no DOOR line, writes no package section and stores no merge_danger (cli/merge.mjs);
//   - a record stored while it was on is hidden from the board, `ravenseat decide` and the PR body (hideStored).
//
//   on(config)               true unless mergeDanger.show is exactly false (a typo keeps the default)
//   hideStored(queue, cfg)   the queue as is while on; while off a shallow copy whose tasks carry no merge_danger
//   trimTemplate(text)       the mission template text without the door and blast radius sentence
//   OFF_TRACK, OFF_REVIEWER  the one line each agent gets while off
//
// Pure: no files, no git. Tested in lib/__tests__/doorShow.test.ts.
// =============================================================
'use strict';

const OFF_TRACK = 'Door and blast radius are off in this project: leave the `Door:` and `Blast radius:` lines out of the report.';
const OFF_REVIEWER = 'Door and blast radius are off in this project: write no `Door:` or `Blast radius:` lines.';

// The sentence in docs/mission-template.md (Report section), with the whitespace before it. Lenient on line breaks, so
// a project copy that was rewrapped still matches; a copy without it is left as it is.
const SENTENCE = /[ \t]*\n?[ \t]*Also `Door: one-way` or `Door: two-way`[\s\S]{0,300}?never a guard\./;

/** On unless the config says exactly false (STANDARD: true). */
function on(config) {
  return config?.mergeDanger?.show !== false;
}

/** While off, the tasks without their stored merge_danger, so no card, decide line or PR body shows an old record. */
function hideStored(queue, config) {
  if (on(config) || !Array.isArray(queue?.tasks)) return queue;
  return {
    ...queue,
    tasks: queue.tasks.map((t) => {
      if (!t || !('merge_danger' in t)) return t;
      const { merge_danger: _hidden, ...rest } = t;
      return rest;
    }),
  };
}

function trimTemplate(text) {
  return String(text).replace(SENTENCE, '');
}

module.exports = { on, hideStored, trimTemplate, OFF_TRACK, OFF_REVIEWER };
