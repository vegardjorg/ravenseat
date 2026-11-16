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

import { a, CLI, CONFIG, die, FOLDER, MAIN_TREE, queueBranchId, readPlans, require, ROOT, SF } from './context.mjs';
import { trackBranchHere } from './settings.mjs';

const C = require('./lib/catalog.js');
const K = require('./lib/kickstart.js');
const RP = require('./lib/reviewPacks.js');

const USAGE = `${CLI} catalog init | show [<D-id>] [--json] | check [--json] | accept <D-id> --by owner`;
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
  // The record first: a file that says accepted with no record reads as unconfirmed, which is the safe side.
  writeLedger(C.recordAccept(readLedger(), after.decision, { by }));
  fs.writeFileSync(path.join(catalogDir(MAIN_TREE), 'decisions', hit.name), r.text);
  console.log(
    `Accepted ${id} (${after.decision.title}). The file says status: accepted, and the record in ${C.LEDGER_FILE} holds ` +
      'this invariant, these paths and this check: a later change to them needs a new accept. Commit the file yourself.',
  );
}

export function cmdCatalog() {
  const sub = a[1];
  if (sub === 'init') return init();
  if (sub === 'show') return show();
  if (sub === 'check') return check();
  if (sub === 'accept') return accept();
  die(USAGE);
}

// The settings this command reads (config().catalog through lib/catalog.js setupOf): doctor and the plan commands use them.
export const catalogSetup = () => C.setupOf(CONFIG);
