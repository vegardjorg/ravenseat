#!/usr/bin/env node
// =============================================================
// make-mission.mjs: makes one mission per track (queue or a parallel wave). See docs/orchestration.md.
//
// Input:
//   --common <file>  the shared protocol (made by make-queue-common.mjs from docs/queue/mission-template.md).
//                   Placeholders: __BRANCH__ __HEAD__ __TRACK__ __BLOCK__
//   --track <file>    the track blocks, each in the form:
//                     =====A-1=====
//                     TITLE: TRACK A-1 (short name)
//                     BRANCH: queue/A-1   (optional; otherwise <branchPrefix><id> from queue.config.json)
//                     BLOCK: 0040–0049 (optional migrationBlock; free text after it is allowed)
//                     CLASS: D+   (optional; otherwise "class X" in the ## TRACK line)
//                     <empty line or anything>
//                     ## TRACK A-1 ... (track content)
//   --head <sha>    the commit tracks start from (or newer)
//   --out <folder>    where prompt-<TRACK>.md is written (default: the same folder as --track)
//
// The text is made in missionText.js:
//   - The class sections in the shared protocol (<!-- class: D D+ --> … <!-- /class -->) are only included when the
//     track class is in the list. An unknown class gives the whole protocol.
//   - Section pointers in the track content ("docs/x.md § 3", "docs/x.md#heading") get "(line A–B)" appended, computed
//     now. Relative paths are looked up from this tree and then mainTree (gitignored documents exist only there).
//   - The prompt starts with "Read these in your first turn, all in the same turn:" and the existing repo paths the
//     track content names (a "Read also" section first, at most 12; missionText.js readFirstPaths). No paths, no block.
//   - The task's documents come first in that list (roadmap 0p2 B3): optional header lines before the "## " heading,
//       READ: <entry>     a link to read ("docs/plan.md:6-7"), written by the queue from the plan entry and `sources`
//       PRIVATE: <label>  a private document (privatePaths read: false): a line that says to ask for an excerpt
//     and the mission's own paths fill what is left under the same cap of 12 (missionText.js readFirstList).
//   - Every relative path in the list is placed for the agent's worktree, which is made from --head: a file that is
//     not in git at --head (gitignored, or not committed) gets its absolute path in the tree that has it, and a file
//     under privatePaths with read: false becomes a private line. Without git (or an unknown --head) paths stay as
//     written. A track block without header lines and with only committed paths gives the same text as before.
//
// Example:
//   node scripts/orchestrator/make-mission.mjs --common scratch/queue-common.md --track scratch/queue-track.md --head 849a5773
// =============================================================

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const O = require('./missionText.js');
const PP = require('./lib/privatePaths.js');
const { config } = require('./lib/queueConfig.js');

const K = config();
// This tree (may be a worktree) and mainTree (config().root is always mainTree).
const ROOT = require('./lib/projectRoot.js').roots().tree;
const MAIN_TREE = K.root;

/** Reads a referenced document: absolute path, otherwise relative to this tree and then mainTree. Null when missing. */
function readDocument(file) {
  const candidates = path.isAbsolute(file) ? [file] : [path.join(ROOT, file), path.join(MAIN_TREE, file)];
  for (const k of candidates) {
    try {
      return fs.readFileSync(k, 'utf8');
    } catch {
      // try the next candidate
    }
  }
  return null;
}

// Is a repo-relative path an existing file in this tree or mainTree (missionText.js repoFileExists: no escapes).
const existsInRepo = O.repoFileExists([ROOT, MAIN_TREE]);
// Which of the two trees holds it (the first one), for the absolute path of a file the agent's worktree will not have.
const rootOfFile = O.repoFileRoot([ROOT, MAIN_TREE]);

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const commonFile = arg('--common');
const trackFile = arg('--track');
const head = arg('--head');
if (!commonFile || !trackFile || !head) {
  console.error('use: make-mission.mjs --common <file> --track <file> --head <sha> [--out <folder>]');
  process.exit(2);
}
const out = arg('--out') ?? path.dirname(trackFile);
const common = fs.readFileSync(commonFile, 'utf8');
const track = fs.readFileSync(trackFile, 'utf8');

// ---- Placing a read-first path for the agent's worktree (roadmap 0p2 B3) -------------------------------------------
//
// The agent gets a new worktree made from --head. A file that exists here but is not in git at --head (gitignored, or
// not committed yet) is missing there, so a relative path would lead nowhere: it gets the absolute path in the tree
// that has it. The answer comes from one `git ls-tree` at --head, read the first time it is needed (only missions with
// a read-first list pay for it).

let headFiles; // undefined = not read yet; null = unknown (no git, unknown --head); otherwise the Set of paths at --head
/** Is the repo-relative path in git at --head? true/false, or null when that cannot be told. */
function inTree(rel) {
  if (headFiles === undefined) {
    try {
      const out = execFileSync('git', ['ls-tree', '-r', '--name-only', '-z', head], {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 256 * 1024 * 1024,
      });
      headFiles = new Set(out.split('\0').filter(Boolean));
    } catch {
      headFiles = null; // error-ignored: no git or an unknown head: every path stays as written (the old behaviour)
    }
  }
  return headFiles ? headFiles.has(rel) : null;
}

/**
 * The path to write for a repo-relative file: null when it is private (privatePaths read: false; the agent gets a
 * line to ask for an excerpt instead), the absolute path when the worktree at --head will not have it, otherwise the
 * same relative path.
 */
function place(rel) {
  const closed = PP.matching(rel, K);
  if (closed && closed.read === false) return null;
  if (inTree(rel) !== false) return rel;
  const root = rootOfFile(rel);
  return root ? path.join(root, rel).replace(/\\/g, '/') : rel;
}

/**
 * A READ header entry ("docs/a.md", "docs/a.md:6-7" or an absolute path) placed like a mission path. Null when the
 * file is private (the queue already sends those as PRIVATE lines; this is the belt to that).
 */
function placeEntry(entry) {
  const m = entry.match(/^(.+?)(:\d+(?:-\d+)?)?$/);
  const file = m ? m[1] : entry;
  if (path.isAbsolute(file) || /^[A-Za-z]:/.test(file)) return entry;
  const at = place(file);
  return at === null ? null : `${at}${m?.[2] ?? ''}`;
}

/** The values of one header key ("READ", "PRIVATE") in the lines above the track's "## " heading. */
const headerValues = (header, key) =>
  header
    .filter((l) => l.startsWith(`${key}:`))
    .map((l) => l.slice(key.length + 1).trim())
    .filter(Boolean);

// Swaps placeholders with split/join, never String.replace (a replacement containing "$'" duplicates text).
const swap = (s, from, to) => s.split(from).join(to);

// Ids may contain hyphens and dots (for example A-1a), not just \w.
const parts = track.split(/^=====([A-Za-z0-9._-]+)=====\r?\n/m).slice(1);
if (parts.length === 0) {
  console.error('found no track blocks (=====ID=====)');
  process.exit(1);
}
for (let i = 0; i < parts.length; i += 2) {
  const id = parts[i];
  const lines = parts[i + 1].split(/\r?\n/);
  const title = (lines.find((l) => l.startsWith('TITLE:')) ?? `TITLE: TRACK ${id}`)
    .slice('TITLE:'.length)
    .trim();
  const block = (lines.find((l) => l.startsWith('BLOCK:')) ?? 'BLOCK: (none)').slice('BLOCK:'.length).trim();
  // Optional BRANCH: line; otherwise <branchPrefix><id> (default queue/<id>).
  const branch = (lines.find((l) => l.startsWith('BRANCH:')) ?? `BRANCH: ${K.branchPrefix}${id}`).slice('BRANCH:'.length).trim();
  const start = lines.findIndex((l) => l.startsWith('## '));
  const raw = lines
    .slice(start >= 0 ? start : 0)
    .join('\n')
    .trim();
  const body = O.sectionPointers(raw, readDocument);
  // The task's documents from the header lines (only above the "## " heading: the mission text below cannot add any).
  const header = start >= 0 ? lines.slice(0, start) : [];
  const links = [];
  const privateLinks = [];
  for (const e of headerValues(header, 'READ')) {
    const placed = placeEntry(e);
    if (placed === null) privateLinks.push(e);
    else links.push(placed);
  }
  privateLinks.push(...headerValues(header, 'PRIVATE'));
  // The files to read in one turn with parallel calls: the task's documents first, then the paths the track block
  // names (only existing paths inside the repo), placed for the agent's worktree, all under the one cap.
  const list = O.readFirstList(raw, existsInRepo, { links, privateLinks, place });
  const readFirst = O.sectionPointers(O.readFirstBlock(list.read), readDocument);
  // Private documents: a line each right under the list (never through sectionPointers: nothing is read from them here).
  const privateText = O.privateBlock(list.private);
  const cls = O.classFromBlock(parts[i + 1]);
  let text = O.filterClass(common, cls);
  text = swap(text, '__BRANCH__', branch);
  text = swap(text, '__HEAD__', head);
  text = swap(text, '__TRACK__', id);
  text = swap(text, '__BLOCK__', block);
  const file = path.join(out, `prompt-${id}.md`);
  const blockLine = block === '(none)' ? '' : `Migration block: ${block}\n\n`;
  const readBlock = [readFirst, privateText].filter(Boolean).join('\n');
  const readLine = readBlock ? `${readBlock}\n\n` : '';
  fs.writeFileSync(file, `# ${title}\n\n${readLine}${blockLine}${text}\n\n${body}\n`);
  // The catalog excerpt's size from its own heading (lib/catalogExcerpt.js), so its cost shows per track.
  const excerpt = require('./lib/catalogExcerpt.js').tokensInMission(body);
  console.log(
    `wrote ${file} (class ${cls ?? 'unknown, whole protocol'}, shared ${text.length} chars` +
      `${excerpt ? `, catalog excerpt about ${excerpt.tokens} of ${excerpt.cap} tokens` : ''})`,
  );
}
