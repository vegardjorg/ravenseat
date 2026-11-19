// =============================================================
// cli/taskLinksCheck.mjs: the task link checks of add, edit and doctor (roadmap 0p2 step B2, guards V1 and V2).
//
// lib/taskLinks.js is pure: it finds a task's links (plan sources, its own `sources`, paths in `source`) and checks
// them through helpers it is given. This module gives it the real ones:
//   readFile(rel)   the text of a repo-relative file, from this tree first and then the main tree (the same roots as
//                   the mission's repoFileExists), or null when it is missing, outside the roots or too large;
//   isIgnored(rel)  `git check-ignore -q` in the root the file was found in, once per path (cached per run).
// Both are read-only: no lock, no write, no git command that writes. A helper that throws gives "missing" or "not
// ignored", never an error: a link check must never stop add, edit or doctor.
//
// taskLinks reads private (privatePaths read: false) files to check them. That is fine here (the owner's CLI and
// doctor); it must never run inside a track agent, so nothing a track calls imports this module for that purpose.
//
//   linkProblems(tasks)   [{ id, plan, problems }] for the tasks given (add and edit), [] when links.addWarn is off
//   printLinkWarning(rows, verb)  prints the ONE WARNING line (nothing when there is no problem)
//   checkLinks()          the doctor row `links` (INFO, counts only), [] without a finding or with links.doctor off
//
// Used by: cli/tasks.mjs (add), cli/taskEdit.mjs (edit), cli/doctor.mjs.
// Tested in: lib/__tests__/taskLinksCli.test.ts.
// =============================================================

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { CLI, CONFIG, FILE, MAIN_TREE, readPlans, require, ROOT } from './context.mjs';

const TL = require('./lib/taskLinks.js');

/** A document larger than this is not read for the check (plan documents are small; this keeps doctor fast). */
const READ_MAX_BYTES = 2 * 1024 * 1024;

/**
 * The context for taskLinks: the plan register, the file reader, the gitignore test, the main tree and the config.
 * The reader and the gitignore answers are cached, so a path shared by many tasks costs one read and one git call.
 */
function linkContext() {
  const roots = [...new Set([ROOT, MAIN_TREE].filter(Boolean))];
  const found = new Map(); // rel -> { text, root } | null
  const ignored = new Map(); // rel -> boolean

  /** The file's text and the root it lies in, only for a real file inside one of the roots (symlinks resolved). */
  const locate = (rel) => {
    if (found.has(rel)) return found.get(rel);
    let hit = null;
    if (typeof rel === 'string' && rel && !path.isAbsolute(rel) && !/^[A-Za-z]:/.test(rel)) {
      for (const root of roots) {
        try {
          const base = fs.realpathSync(root);
          const full = fs.realpathSync(path.resolve(base, rel));
          const r = path.relative(base, full);
          if (!r || path.isAbsolute(r) || r.split(path.sep)[0] === '..') continue;
          const st = fs.statSync(full);
          if (!st.isFile() || st.size > READ_MAX_BYTES) continue;
          hit = { text: fs.readFileSync(full, 'utf8'), root: base };
          break;
        } catch {
          // error-ignored: not in this root; try the next one
        }
      }
    }
    found.set(rel, hit);
    return hit;
  };

  let register = { entries: [], archive: {} };
  try {
    register = readPlans();
  } catch {
    // error-ignored: a broken plans.json is plan check's and doctor's queue row's finding; the plan links then count
    // as unknown here
  }

  return {
    register,
    config: CONFIG,
    mainRoot: MAIN_TREE,
    readFile: (rel) => locate(rel)?.text ?? null,
    // Exit 0 = ignored, 1 = not ignored, anything else (no git, not a repo) = not ignored. Asked only for files that
    // exist (taskLinks), in the root the file was found in. A tracked file is never reported as ignored.
    isIgnored: (rel) => {
      if (ignored.has(rel)) return ignored.get(rel);
      const at = locate(rel);
      let yes = false;
      if (at) {
        const r = spawnSync('git', ['check-ignore', '-q', '--', rel], { cwd: at.root, stdio: 'ignore' });
        yes = r.status === 0;
      }
      ignored.set(rel, yes);
      return yes;
    },
  };
}

/**
 * The link problems of the tasks just added or edited, one row per task (also the ones without a problem, so the JSON
 * answer can show "checked, fine"). [] when links.addWarn is off. Never throws.
 * @param {object[]} tasks
 * @returns {{ id: string, plan: string|null, problems: object[] }[]}
 */
export function linkProblems(tasks) {
  if (!TL.linksSetup(CONFIG).addWarn) return [];
  try {
    const ctx = linkContext();
    return (tasks ?? [])
      .filter((t) => t && typeof t === 'object')
      .map((t) => ({ id: t.id, plan: t.plan ?? null, problems: TL.taskLinks(t, ctx).problems }));
  } catch {
    return []; // error-ignored: a link check never stops add or edit
  }
}

/** The rows with at least one problem, without the plan id (the JSON answer's `linkProblems`). */
export const linkProblemsJson = (rows) =>
  rows.filter((r) => r.problems.length).map((r) => ({ id: r.id, problems: r.problems }));

/** Prints the ONE WARNING line for the rows (nothing when no task has a problem). */
export function printLinkWarning(rows, verb) {
  const line = TL.warningLine(rows, { verb, cli: CLI });
  if (line) console.log(line);
}

/**
 * The doctor row `links` (V2): one INFO row with counts over the open tasks, only when there is a finding. Counts only,
 * never a path, an id or a title. Nothing with links.doctor off, without a queue, or without a finding.
 */
export function checkLinks() {
  if (!TL.linksSetup(CONFIG).doctor) return [];
  let tasks = [];
  try {
    tasks = JSON.parse(fs.readFileSync(FILE, 'utf8')).tasks ?? [];
  } catch {
    return []; // no queue yet, or a broken one: the queue row says so
  }
  const ctx = linkContext();
  const totals = TL.doctorTotals(tasks, (t) => TL.taskLinks(t, ctx));
  const message = TL.doctorMessage(totals);
  if (!message) return [];
  return [
    {
      status: 'INFO',
      name: 'links',
      message,
      fix: `${CLI} plan check names the plan sources and anchors; ${CLI} add and edit name a task's own links when written`,
      counts: totals,
    },
  ];
}
