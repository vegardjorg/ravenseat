// =============================================================
// lib/clientCanary.js: the client format canary in the core (roadmap 0w W4): one doctor row, the facts for one card on
// the Checks tab, and the optional shape log. The reading itself is the adapter's (clientFor().canary and
// clientFor().transcripts); this file only words it and decides where it shows.
//
//   setupOf(config)            { on: client.canary (default true), shapeLog: client.shapeLog (default false) }
//   readLatest(mainTree, o)    the canary summary of the newest transcript of the project (a tail only), or null
//   doctorRow(summary, o)      OK (nothing new), INFO (only a newer version), WARN (rows read differently); never FAIL,
//                              and null without a summary
//   facts(summary)             { signal, version, newer, covered, lines } for the Checks card (lib/checksCatalog.js
//                              condition client-format-changed and its detail line)
//   logShapes(folder, summary, o)  appends the shape of each new system API error form to <folder>/client-shapes.jsonl
//                              (keys, types and short codes only), deduplicated and capped; returns how many it wrote
//
// Why it never stops anything: a format change is the client's, not the project's, and the queue keeps working on what
// it can read. A stop would block every track for a row type nobody uses; a quiet miscount would hide it. So it is one
// line and one medium card, and the fix is an update of Ravenseat or a report of the form (no content).
//
// Used by: cli/doctor.mjs (checkCanary), cli/checks.mjs (makeReport). Tested in: lib/__tests__/clientCanary.test.ts.
// =============================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** The shape log beside the queue data, and its cap: a new form is rare, so a full file means something loops. */
const SHAPE_FILE = 'client-shapes.jsonl';
const SHAPE_MAX = 100;
/** How a user updates the plugin (plugin/docs/board.md, Update banner) and where a form is reported. */
const UPDATE = 'claude plugin update ravenseat@ravenseat, then /reload-plugins';
const REPORT = 'https://github.com/vegardjorg/ravenseat/issues';

const adapter = () => require('./clients/index.js').clientFor();

/** The canary settings (lib/queueConfig.js STANDARD.client). */
function setupOf(config) {
  return { on: config?.client?.canary !== false, shapeLog: config?.client?.shapeLog === true };
}

/** The summary of the newest transcript's tail, or null (no folder, no file, unreadable). Never throws. */
function readLatest(mainTree, { env = process.env, home } = {}) {
  try {
    const C = adapter();
    const dir = C.transcripts.transcriptsDir(mainTree, home ? { env, home } : { env });
    const file = C.transcripts.newestTranscript(dir);
    return file ? C.canary.readFile(file) : null;
  } catch {
    return null; // error-ignored: no canary row rather than a crash in doctor or the scan
  }
}

/** The version part of a line: "Claude Code 2.1.330" or nothing when the rows carry no version. */
const versionText = (s) => (s.newest ? `Claude Code ${s.newest}` : 'Claude Code (no version in the rows)');

/** The doctor row, or null without a summary. */
function doctorRow(s, { cli = 'ravenseat' } = {}) {
  if (!s) return null;
  const C = adapter().canary;
  const name = 'canary';
  if (C.hasSignal(s)) {
    const rows = C.news(s).filter((l) => !l.startsWith('Claude Code '));
    const newer = s.newer ? `, newer than the formats the fixtures cover (${s.covered})` : '';
    return {
      status: 'WARN',
      name,
      message: `the newest transcript (${versionText(s)}${newer}) has rows Ravenseat reads differently than expected: ${rows.join('; ')}. Costs or limits may be counted short; nothing is stopped`,
      fix: `update Ravenseat (${UPDATE}); if it stays after an update, report the version and these row types (no content) at ${REPORT}. ${cli} settings set client.canary off hides this row`,
    };
  }
  if (s.newer)
    return {
      status: 'INFO',
      name,
      message: `${versionText(s)} is newer than the formats the fixtures cover (${s.covered}); the last ${s.rows} row(s) of the newest transcript read as expected`,
      fix: null,
    };
  return { status: 'OK', name, message: `${versionText(s)}: the last ${s.rows} row(s) of the newest transcript read as expected`, fix: null };
}

/** The facts the Checks card reads. signal false without a summary. */
function facts(s) {
  if (!s) return { signal: false };
  const C = adapter().canary;
  return { signal: C.hasSignal(s), version: s.newest, newer: s.newer, covered: s.covered, lines: C.news(s) };
}

/** The lines already in the shape log, or an empty list. */
function readShapeLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  } catch {
    return []; // error-ignored: no log yet
  }
}

/** Appends each system API error shape the log does not have yet. Returns how many lines it wrote. */
function logShapes(folder, s, { now = new Date().toISOString() } = {}) {
  const shapes = s?.systemErrorShapes ?? [];
  if (!folder || !shapes.length) return 0;
  const file = path.join(folder, SHAPE_FILE);
  const lines = readShapeLines(file);
  const known = new Set(
    lines.map((l) => {
      try {
        return JSON.stringify(JSON.parse(l).shape);
      } catch {
        return null; // error-ignored: a broken line counts as no shape
      }
    }),
  );
  let room = SHAPE_MAX - lines.length;
  const out = [];
  for (const x of shapes) {
    const key = JSON.stringify(x.shape);
    if (room <= 0 || known.has(key)) continue;
    known.add(key);
    room--;
    out.push(JSON.stringify({ seen: now, version: s.newest ?? null, form: 'system api_error', shape: x.shape }));
  }
  if (out.length) fs.appendFileSync(file, `${out.join('\n')}\n`);
  return out.length;
}

module.exports = { SHAPE_FILE, SHAPE_MAX, setupOf, readLatest, doctorRow, facts, logShapes };
