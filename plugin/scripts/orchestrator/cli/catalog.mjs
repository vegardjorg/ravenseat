// =============================================================
// cli/catalog.mjs: `ravenseat catalog`, the project catalog in docs/queue/catalog/ (lib/catalog.js, bolk B3 of the
// scope drift plan, plans/scope-drift-dry-katalog-2026-11-15.md).
//
//   ravenseat catalog init                        creates stack.md (with the generated block from the manifests),
//                                                 reuse.md and decisions/README.md where they are missing; never over
//                                                 a file that is there, except the generated block in stack.md
//   ravenseat catalog show [<D-id>] [--json]      the prefer lines, the reuse rows and the design choices with the
//                                                 status that counts; with an id that choice in full and the plan
//                                                 entries that link to it
//   ravenseat catalog check [--json]              the checks of lib/catalog.js checkCatalog; exit 1 on an error, 0 on
//                                                 warnings only, 0 without a catalog. Read only, so a project can run
//                                                 it as a gate when it wants to (it is none by default)
//   ravenseat catalog accept <D-id> --by owner    the owner accepts a design choice: status accepted in the file and
//                                                 the owner's record in <dataFolder>/catalog-accepted.json
//   ravenseat catalog propose --title --invariant --paths [--supersedes] [--plan] [--why] [--json]
//                                                 writes the next free D-id as status proposed into the main tree's
//                                                 decisions/ and runs check on it (roadmap 0z Z-B); refused from a track
//   ravenseat catalog find <word...> [--json]     searches the code index (exports and @shared blocks), the reuse
//                                                 rows, the design choices and the prefer lines; at most 10 short lines
//   ravenseat catalog index [--json]              builds or refreshes the code index (lib/catalogIndex.js, bolk B5) in
//                                                 <dataFolder>/catalog-index.json and names a @shared tag that is not on
//                                                 an export
//
// find and index read the tree the command runs in, like show and check; the cache is keyed by blob sha, so a track's
// tree and the main tree share it without mixing up. find builds the index on request whatever catalog.index says
// (that setting is about the automatic parts: receive, the missions and V1b).
//
// The owner lock: accept needs --by owner (or theBoard) and is refused from inside a track worktree whatever --by says,
// as `ravenseat surface accept` and `ravenseat owner-log accept` are. init and accept write the MAIN tree's catalog and
// are refused from a track too; the push guard lets a queue agent run only `catalog show` and `catalog check`
// (lib/pushGuard.js AGENT_QUEUE_COMMANDS), and the write guard keeps it off the record file (lib/writeGuard.js).
// show and check read the tree the command runs in, so a track sees its own branch's catalog.
//
// Used by: queue.mjs. Tested in: __tests__/catalogFlow.test.ts.
// =============================================================

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { a, CLI, CONFIG, die, edit, FILE, FOLDER, LM, MAIN_TREE, queueBranchId, read, readPlans, require, ROOT, SF } from './context.mjs';
import { addTask, ensureProject } from './kickstart.mjs';
import { trackBranchHere } from './settings.mjs';

const C = require('./lib/catalog.js');
const CC = require('./lib/catalogChecks.js');
const CI = require('./lib/catalogIndex.js');
const K = require('./lib/kickstart.js');
const RP = require('./lib/reviewPacks.js');

const USAGE = `${CLI} catalog init | show [<D-id>] [--json] | check [--json] | accept <D-id> --by owner | propose --title "..." --invariant "..." --paths "<glob>" [--supersedes <D-id>] [--plan <PL-id>] [--why "..."] [--json] | find <word...> [--json] | index [--json]`;
const json = a.includes('--json');

/** The catalog folder in a tree (the main tree for a write, the current one for a read). */
export const catalogDir = (root) => path.join(root, ...C.DIR.split('/'));

/** The owner's record of the accepted design choices; a missing or broken file reads as empty. */
export function readLedger(folder = FOLDER) {
  try {
    return C.parseLedger(fs.readFileSync(path.join(folder, C.LEDGER_FILE), 'utf8'));
  } catch {
    return C.emptyLedger();
  }
}

function writeLedger(ledger) {
  fs.mkdirSync(FOLDER, { recursive: true });
  const file = path.join(FOLDER, C.LEDGER_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`);
  SF.renameWithRetry(tmp, file);
}

/** The tracked paths of a tree, or null when git cannot list them (the path checks are then skipped). */
function trackedFiles(root) {
  try {
    const out = execFileSync('git', ['-C', root, '-c', 'core.quotepath=off', 'ls-files', '-z'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    });
    return out.split('\0').filter(Boolean);
  } catch {
    return null;
  }
}

/** The plan register's ids, or null when it cannot be read (the plan links are then not checked). */
function planIds() {
  try {
    return new Set(readPlans().entries.map((p) => p.id));
  } catch {
    return null;
  }
}

/** Read-only file access in a tree, the shape the scans take. */
function treeFs(root) {
  const at = (f) => path.join(root, ...String(f).split('/').filter(Boolean));
  return {
    exists: (f) => fs.existsSync(at(f)),
    read: (f) => {
      try {
        return fs.readFileSync(at(f), 'utf8');
      } catch {
        return null;
      }
    },
    list: (d) => {
      try {
        return fs.readdirSync(at(d || '.'));
      } catch {
        return [];
      }
    },
  };
}

/** The generated block of stack.md as init would write it now, from the manifests in `root`. */
export function freshStackBlock(root) {
  const t = treeFs(root);
  const { stacks, checks } = K.detectChecks({ exists: t.exists, read: t.read });
  let packs = [];
  try {
    packs = RP.detectStacks(t).packs;
  } catch {
    packs = []; // error-ignored: the block names no framework rather than a wrong one
  }
  const manifests = ['package.json', ...t.list('').filter((n) => /^requirements[\w.-]*\.txt$/i.test(n))]
    .filter((f) => t.exists(f))
    .map((f) => ({ path: f, text: t.read(f) }));
  return C.stackBlock({ stacks, packs, checks, jobs: C.jobsOf(manifests) });
}

/** The ids of the design choices in a tree's catalog (for the plan link warning), or null without a catalog. */
export function decisionIds(root = ROOT) {
  const cat = C.readCatalog(catalogDir(root));
  if (!cat.exists) return null;
  return new Set(cat.decisions.map((d) => d.decision?.id).filter(Boolean));
}

/** Everything check says about a tree's catalog. */
export function checkTree(root = ROOT) {
  const cat = C.readCatalog(catalogDir(root));
  const r = C.checkCatalog(cat, {
    files: trackedFiles(root),
    readFile: treeFs(root).read,
    ledger: readLedger(),
    planIds: planIds(),
    stackBlock: cat.stack?.block != null ? freshStackBlock(root) : null,
    ravenseat: CLI,
  });
  return { cat, ...r };
}

/** Refuses a write from inside a track worktree, whatever --by says. */
function notFromTrack(what) {
  const track = trackBranchHere() ?? queueBranchId();
  if (track) die(`${CLI} catalog ${what} cannot be run from inside a track worktree (${track}): the catalog is the owner's. Ask the owner (ravenseat question).`);
}

function init() {
  notFromTrack('init');
  const dir = catalogDir(MAIN_TREE);
  const block = freshStackBlock(MAIN_TREE);
  const done = [];
  const kept = [];
  const put = (name, content) => {
    const f = path.join(dir, ...name.split('/'));
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, content);
  };
  const stackFile = path.join(dir, 'stack.md');
  const existing = fs.existsSync(stackFile) ? fs.readFileSync(stackFile, 'utf8') : null;
  const stack = C.stackWithBlock(existing, block);
  if (stack == null) kept.push('stack.md (no generated block in it, so it is left as it is)');
  else if (stack === existing) kept.push('stack.md (the generated block is up to date)');
  else {
    put('stack.md', stack);
    done.push(existing == null ? 'stack.md' : 'stack.md (the generated block refreshed)');
  }
  for (const [name, content] of [['reuse.md', C.REUSE_TEMPLATE], ['decisions/README.md', C.DECISIONS_README]]) {
    if (fs.existsSync(path.join(dir, ...name.split('/')))) kept.push(name);
    else {
      put(name, content);
      done.push(name);
    }
  }
  const rel = path.relative(MAIN_TREE, dir).replace(/\\/g, '/');
  if (done.length) console.log(`Wrote in ${rel}/: ${done.join(', ')}.`);
  for (const k of kept) console.log(`  kept ${k}`);
  console.log(
    `Next: write what to prefer per job in stack.md, the building blocks in reuse.md, and a design choice per file in ` +
      `decisions/. The folder is a protected path: commit it yourself. ${CLI} catalog check checks it.`,
  );
}

/** One row of the overview: id, the status that counts, title. */
const row = (d, ledger) => `  ${String(d.id).padEnd(7)} ${String(C.effectiveStatus(d, ledger) ?? '?').padEnd(11)} ${d.title ?? ''}`;

function show() {
  const id = a.slice(2).find((x) => !x.startsWith('--')) ?? null;
  const cat = C.readCatalog(catalogDir(ROOT));
  const ledger = readLedger();
  const ds = cat.decisions.map((x) => x.decision).filter(Boolean);
  if (id) {
    const d = ds.find((x) => x.id === id);
    if (!d) die(`${id} is not in ${C.DIR}/decisions (${CLI} catalog show lists them).`);
    let linked = [];
    try {
      linked = readPlans().entries.filter((p) => (p.decisions ?? []).includes(id)).map((p) => p.id);
    } catch {
      linked = []; // error-ignored: no register, no links
    }
    const status = C.effectiveStatus(d, ledger);
    if (json) {
      console.log(JSON.stringify({ ok: true, decision: { ...d, status_counts: status }, linked_from: linked }, null, 2));
      return;
    }
    console.log(`${d.id}: ${d.title ?? ''}  (${d.file})`);
    console.log(`status: ${status}${status !== d.status ? ` (the file says ${d.status})` : ''}${d.accepted ? `, accepted ${d.accepted} by ${d.accepted_by ?? '?'}` : ''}`);
    console.log(`invariant: ${d.invariant ?? '(none)'}`);
    console.log(`paths: ${d.paths.join(', ')}`);
    if (d.supersedes) console.log(`supersedes: ${d.supersedes}`);
    if (d.plan) console.log(`plan: ${d.plan}`);
    if (linked.length) console.log(`linked from plan entries: ${linked.join(', ')}`);
    if (d.body.trim()) console.log(`\n${d.body.trim()}`);
    return;
  }
  if (json) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          exists: cat.exists,
          prefer: cat.stack?.prefer ?? [],
          reuse: cat.reuse?.rows ?? [],
          decisions: ds.map((d) => ({ id: d.id, title: d.title, status: d.status, status_counts: C.effectiveStatus(d, ledger), paths: d.paths, invariant: d.invariant })),
        },
        null,
        2,
      ),
    );
    return;
  }
  if (!cat.exists) {
    console.log(`No catalog in ${C.DIR}/ yet. ${CLI} catalog init writes a first draft from the manifests.`);
    return;
  }
  const prefer = cat.stack?.prefer ?? [];
  console.log(`Prefer (stack.md): ${prefer.length ? '' : 'none yet'}`);
  for (const p of prefer) console.log(`  ${p.purpose}: ${p.use}`);
  const reuse = cat.reuse?.rows ?? [];
  console.log(`Reuse (reuse.md): ${reuse.length ? '' : 'none yet'}`);
  for (const r of reuse) console.log(`  ${r.purpose}: ${r.symbol} (${r.file})`);
  console.log(`Design choices (decisions/): ${ds.length ? '' : 'none yet'}`);
  for (const d of ds) console.log(row(d, ledger));
  const problems = cat.errors.length + cat.warnings.length;
  if (problems) console.log(`\n${problems} problem(s) in the files: ${CLI} catalog check.`);
}

function check() {
  const r = checkTree(ROOT);
  if (json) {
    console.log(JSON.stringify({ ok: r.errors.length === 0, exists: r.cat.exists, errors: r.errors, warnings: r.warnings }, null, 2));
    if (r.errors.length) process.exit(1);
    return;
  }
  if (!r.cat.exists) {
    console.log(`No catalog in ${C.DIR}/: nothing to check. ${CLI} catalog init writes a first draft.`);
    return;
  }
  for (const e of r.errors) console.log(`ERROR  ${e}`);
  for (const w of r.warnings) console.log(`WARN   ${w}`);
  const n = r.cat.decisions.length;
  console.log(
    `${r.errors.length} error(s), ${r.warnings.length} warning(s) in ${C.DIR}/ (${n} design choice(s)).${r.errors.length ? ' (exit 1)' : ''}`,
  );
  if (r.errors.length) process.exit(1);
}

function accept() {
  const id = a[2];
  if (!id || id.startsWith('--')) die(USAGE);
  const by = String(a.includes('--by') ? (a[a.indexOf('--by') + 1] ?? '') : '').trim();
  if (!C.OWNER_BY.has(by))
    die(`${CLI} catalog accept needs --by owner: accepting a design choice is the owner's decision. Nothing was changed.`);
  notFromTrack('accept');
  const cat = C.readCatalog(catalogDir(MAIN_TREE));
  const hit = cat.decisions.find((x) => x.decision?.id === id);
  if (!hit) die(`${id} is not in ${C.DIR}/decisions. Nothing was changed.`);
  if (hit.errors.length) die(`${id} has errors; fix them first:\n  ${hit.errors.join('\n  ')}\nNothing was changed.`);
  const r = C.acceptText(hit.source, { by });
  if (r.error) die(`${CLI} catalog accept: ${r.error}. Nothing was changed.`);
  const after = C.parseDecision(hit.name, r.text);
  if (after.errors.length || !after.decision) die(`${CLI} catalog accept: ${after.errors.join('; ')}. Nothing was changed.`);
  // Z-C (roadmap 0z): a choice with supersedes marks the old one superseded in the same step. Checked before anything is
  // written, so a supersedes that points nowhere changes nothing.
  const sup = after.decision.supersedes;
  let old = null;
  if (sup) {
    old = cat.decisions.find((x) => x.decision?.id === sup) ?? null;
    if (!old) die(`${id} supersedes ${sup}, which is not in ${C.DIR}/decisions. Fix the supersedes line first. Nothing was changed.`);
    if (old.decision.status !== 'superseded') {
      const s = C.supersededText(old.source);
      if (s.error) die(`${sup} cannot be marked superseded: ${s.error}. Nothing was changed.`);
      old = { ...old, text: s.text };
    } else old = null; // already superseded: nothing to write
  }
  // The record first: a file that says accepted with no record reads as unconfirmed, which is the safe side.
  writeLedger(C.recordAccept(readLedger(), after.decision, { by }));
  fs.writeFileSync(path.join(catalogDir(MAIN_TREE), 'decisions', hit.name), r.text);
  if (old) fs.writeFileSync(path.join(catalogDir(MAIN_TREE), 'decisions', old.name), old.text);
  console.log(
    `Accepted ${id} (${after.decision.title}). The file says status: accepted, and the record in ${C.LEDGER_FILE} holds ` +
      'this invariant, these paths and this check: a later change to them needs a new accept. Commit the file yourself.',
  );
  if (old) console.log(`${sup} is now superseded (decisions/${old.name}): ${id} replaces it. Commit that file too.`);
}

// ---- propose (roadmap 0z Z-B) -------------------------------------------------------------------------------------

/**
 * Writes a proposed design choice into the MAIN tree's catalog under the next free id, then runs check on the tree.
 * Never accepts and never writes over a file. Throws an Error with the reason when the proposal is broken (nothing is
 * written then). Used by `catalog propose` and by `resolve --keep` (cli/owner.mjs). The caller refuses a track first.
 * @returns {{ id: string, file: string, errors: string[], warnings: string[] }} file relative to the tree; errors and
 *   warnings are check's lines about this choice
 */
export function writeProposal({ title, invariant, paths, supersedes = null, plan = null, why = null }) {
  const dir = catalogDir(MAIN_TREE);
  const decisionsDir = path.join(dir, 'decisions');
  let names = [];
  try {
    names = fs.readdirSync(decisionsDir);
  } catch {
    names = []; // error-ignored: no folder yet, the first id is D-0001
  }
  const id = C.nextDecisionId(names, readLedger());
  const r = C.proposalFile({ id, title, invariant, paths, supersedes, plan, why });
  if (r.errors.length) throw new Error(r.errors.join('; '));
  fs.mkdirSync(decisionsDir, { recursive: true });
  const readme = path.join(decisionsDir, 'README.md');
  if (!fs.existsSync(readme)) fs.writeFileSync(readme, C.DECISIONS_README);
  // wx: a file of that name that came in meanwhile is never written over.
  fs.writeFileSync(path.join(decisionsDir, r.name), r.text, { flag: 'wx' });
  const file = `${C.DIR}/decisions/${r.name}`;
  const mine = (line) => line.includes(id) || line.includes(`decisions/${r.name}`);
  const c = checkTree(MAIN_TREE);
  return { id, file, errors: c.errors.filter(mine), warnings: c.warnings.filter(mine), allErrors: c.errors.length };
}

/** The values of a repeated flag, each also split on commas (`--paths a/**,b/**` or `--paths a/** --paths b/**`). */
const listFlag = (flag) =>
  a
    .flatMap((x, i) => (x === flag ? [a[i + 1] ?? ''] : []))
    .flatMap((v) => String(v).split(','))
    .map((v) => v.trim())
    .filter(Boolean);
const flag = (name) => (a.includes(name) ? String(a[a.indexOf(name) + 1] ?? '') : null);

function propose() {
  notFromTrack('propose');
  const title = flag('--title');
  const invariant = flag('--invariant');
  let paths = listFlag('--paths');
  const supersedes = flag('--supersedes');
  let plan = flag('--plan');
  if (!title || invariant == null || (!paths.length && !supersedes))
    die(`${CLI} catalog propose --title "..." --invariant "<one sentence that can be checked>" --paths "<glob>[,<glob>]" [--supersedes D-0001] [--plan PL-...] [--why "..."]`);
  if (supersedes) {
    // Idea C: a choice that replaces another starts from its paths and plan; the owner narrows them before the accept.
    const old = C.readCatalog(catalogDir(MAIN_TREE)).decisions.find((x) => x.decision?.id === supersedes)?.decision;
    if (!old) die(`${supersedes} is not in ${C.DIR}/decisions, so nothing can supersede it. Nothing was written.`);
    if (!paths.length) paths = old.paths;
    plan ??= old.plan;
  }
  let r;
  try {
    r = writeProposal({ title, invariant, paths, supersedes, plan, why: flag('--why') });
  } catch (e) {
    die(`${CLI} catalog propose: ${e.message}. Nothing was written.`);
  }
  if (json) {
    console.log(JSON.stringify({ ok: true, id: r.id, file: r.file, errors: r.errors, warnings: r.warnings }, null, 2));
    return;
  }
  console.log(`Proposed ${r.id}: ${r.file} (status: proposed; it binds nothing until the owner accepts it).`);
  for (const e of r.errors) console.log(`ERROR  ${e}`);
  for (const w of r.warnings) console.log(`WARN   ${w}`);
  console.log(`catalog check: ${r.errors.length} error(s), ${r.warnings.length} warning(s) for ${r.id}.`);
  console.log(
    `Next: read it and sharpen the invariant and the paths, then ${CLI} catalog accept ${r.id} --by owner. ` +
      'The folder is a protected path: commit the file yourself.',
  );
}

/** The code index of the tree the command runs in, refreshed from the cache; dies when git cannot list the tree. */
function indexHere() {
  const r = CI.refresh(ROOT, { dataFolder: FOLDER, fresh: true });
  if (!r) die(`${CLI} catalog: git cannot list the files of ${ROOT}, so there is no code index.`);
  return r;
}

function index() {
  const { index: idx, stats } = indexHere();
  const problems = Object.entries(idx.files).flatMap(([f, e]) => e.problems.map((p) => `${f}: ${p}`));
  if (json) {
    console.log(JSON.stringify({ ok: true, file: CI.FILE, stats, problems }, null, 2));
    return;
  }
  console.log(
    `Code index: ${stats.files} files, ${stats.scanned} read, ${stats.reused} from the cache; ` +
      `${stats.shared} tagged @shared, ${stats.exports} exports (${CI.FILE} in the data folder).`,
  );
  for (const p of problems.slice(0, 20)) console.log(`  ${p}`);
  if (problems.length > 20) console.log(`  and ${problems.length - 20} more`);
}

function find() {
  const query = a
    .slice(2)
    .filter((x) => !x.startsWith('--'))
    .join(' ')
    .trim();
  if (!query) die(`${CLI} catalog find <word...>: say what to look for, e.g. ${CLI} catalog find date`);
  const { index: idx } = indexHere();
  const cat = C.readCatalog(catalogDir(ROOT));
  const r = CI.search({ index: idx, catalog: cat, query, ledger: readLedger() });
  if (json) {
    console.log(JSON.stringify({ ok: true, query, total: r.total, rows: r.rows }, null, 2));
    return;
  }
  for (const l of CI.findLines(r, { query, index: idx })) console.log(l);
}

export function cmdCatalog() {
  const sub = a[1];
  if (sub === 'init') return init();
  if (sub === 'show') return show();
  if (sub === 'check') return check();
  if (sub === 'accept') return accept();
  if (sub === 'propose') return propose();
  if (sub === 'find') return find();
  if (sub === 'index') return index();
  die(USAGE);
}

// The settings this command reads (config().catalog through lib/catalog.js setupOf): doctor and the plan commands use them.
export const catalogSetup = () => C.setupOf(CONFIG);

// ---- The check rules at receive and merge (lib/catalogChecks.js, bolk B6) ------------------------------------------

/**
 * The check rules of the main tree's catalog tried on a diff, or null when there is nothing to try (catalog.checks off,
 * no catalog, no choice with a check). Read from the main tree like the excerpt, never from the track's branch: a track
 * cannot loosen the rule it is measured against (the folder is also a protected path). Throws on a read error; the
 * callers say so in one line and go on.
 */
export function catalogRules(diff) {
  const setup = C.setupOf(CONFIG);
  if (!setup.checks) return null;
  const cat = C.readCatalog(catalogDir(MAIN_TREE));
  if (!cat.exists) return null;
  const decisions = cat.decisions.map((x) => x.decision).filter((d) => d && d.check != null);
  if (!decisions.length) return null;
  return CC.assess({ decisions, ledger: readLedger(), diff, setup });
}

/**
 * The gate proposals for the rules this delivery broke that were broken in catalog.gateAfter separate tasks (counted
 * from catalog_checks on the tasks and the archive). Only with learning.proposals on; through lib/knownBugGate.js decide,
 * so the same rule again extends its open task, a cancelled one stays declined, and the cap shared with the inspection
 * queue and the GATE lines holds. Always proposed, never approved. Returns the lines to print; never throws.
 */
export function proposeRuleGates(result, { from = null } = {}) {
  const out = [];
  try {
    if (!require('./lib/findingRepeats.js').setupOf(CONFIG).proposals || !fs.existsSync(FILE)) return out;
    const KBG = require('./lib/knownBugGate.js');
    const archived = require('./lib/queueArchive.js').load(FOLDER).tasks;
    const due = CC.dueRules(result, [...(read().tasks ?? []), ...archived], { gateAfter: C.setupOf(CONFIG).gateAfter });
    for (const x of due) {
      const queue = read();
      const known = [...(queue.tasks ?? []), ...archived];
      const d = KBG.decide({ title: CC.gateTitle(x.rule), tasks: known, mode: 'propose' });
      if (d.action === 'extend') {
        const h = x.rule.hits[0];
        const seen = { from, where: h ? `${h.file}:${h.line}` : null, detail: `the check rule of ${x.rule.id} was broken again` };
        const changed = edit((q) => {
          const o = q.tasks.find((t) => t.id === d.task.id);
          if (!o || o.status === 'picked') return false; // a running track has already read its mission
          const mission = KBG.extendedMission(o, seen);
          if (!mission) return false;
          o.mission = mission;
          return true;
        });
        if (changed) out.push(`CATALOG: ${d.task.id} already proposes a lint rule for ${x.rule.id}; the new place was added to it.`);
        continue;
      }
      if (d.action === 'full') {
        out.push(
          `CATALOG: the rule of ${x.rule.id} was broken in ${x.tasks.length} separate tasks, but ${KBG.SHARED_MAX} proposals already wait ` +
            `for you, so no lint rule is proposed yet (${CLI} gate list, ${CLI} inspection).`,
        );
        continue;
      }
      if (d.action !== 'add') continue; // exists or declined: nothing new
      if (!LM.isLite(CONFIG)) ensureProject();
      const id = KBG.nextId(known);
      const task = { ...CC.proposalTask(x, { id, from }), ...(queue.projects?.cicd ? { project: 'cicd' } : {}) };
      const r = addTask(task);
      if (!r.ok) {
        out.push(`CATALOG: the lint proposal for ${x.rule.id} could not be added (${r.output}); nothing is blocked on it.`);
        continue;
      }
      out.push(
        `CATALOG: proposed ${id}: the rule of ${x.rule.id} was broken in ${x.tasks.length} separate tasks (${x.tasks.slice(0, 5).join(', ')}), ` +
          `so it belongs in the project's own lint. ${CLI} approve ${id} lets it be built, ${CLI} cancel ${id} declines it.`,
      );
    }
  } catch (e) {
    out.push(`CATALOG: the lint proposal failed (${e?.message ?? e}); nothing is blocked on it.`);
  }
  return out;
}
