// =============================================================
// flakyObserved.js: how often a gate command was red and then green on the same commit, read from the time log.
//
// WHY: a flaky test (red now, green on the next run, with no change in between) costs a rerun every time, and in a
// queue it can also block a track or send an agent looking for a bug that is not there. The time log already has one
// row per gate run (lib/timeLogRows.js gateRow: the commands, the red ones, and the commit `sha` when the run checked
// exactly one commit). The Checks card flaky-tests is low by default and medium once this finds one, with the count.
//
// The rule: per track (or branch when the track is unknown) and per command, in the order of the log: a run where the
// command was red on commit X, and the next run of that command for the same track also on X and green. A run on
// another commit in between ends the pair (a new commit is a change). A run without a sha (the tree changed during it)
// counts for nothing. A row's own `flaky` list (gates.mjs reran it and it turned green) counts too, once per commit.
// Each command and commit counts once, however many times it flipped.
//
//   gateRows(text)        the gate rows of a time log's text (JSON lines; broken lines are skipped)
//   flakyFlips(rows)      [{ command, sha }] each observed flip, once
//
// Pure. Used by: cli/checks.mjs. Tested in: lib/__tests__/flakyObserved.test.ts.
// =============================================================
'use strict';

/** The gate rows of a time log's text, in file order. */
function gateRows(text) {
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!line.includes('"gate"')) continue;
    try {
      const row = JSON.parse(line);
      if (row && row.event === 'gate') out.push(row);
    } catch {
      // a broken line: skipped
    }
  }
  return out;
}

/**
 * @param {object[]} rows  gate rows (lib/timeLogRows.js gateRow), in file order
 * @returns {{ command: string, sha: string }[]}
 */
function flakyFlips(rows) {
  const seen = new Set();
  const out = [];
  const add = (command, sha) => {
    const k = `${sha}\0${command}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ command, sha });
  };
  // The last run of each command per track: { sha, red }.
  const last = new Map();
  for (const r of rows ?? []) {
    const who = r.track ?? r.branch ?? '';
    const sha = typeof r.sha === 'string' && r.sha ? r.sha : null;
    for (const c of Array.isArray(r.flaky) ? r.flaky : []) if (sha && typeof c === 'string') add(c, sha);
    const failed = new Set(Array.isArray(r.failed) ? r.failed : []);
    for (const c of Array.isArray(r.gates) ? r.gates : []) {
      if (typeof c !== 'string') continue;
      const key = `${who}\0${c}`;
      const before = last.get(key);
      const red = failed.has(c);
      if (sha && before && before.sha === sha && before.red && !red) add(c, sha);
      last.set(key, { sha, red });
    }
  }
  return out;
}

module.exports = { gateRows, flakyFlips };
