// =============================================================
// cli/planCheck.mjs: plan check, plan modules, plan backup and plan active.
//
// plan check (documents, changed files since the entry, the index drift), the module overview, the backup to the
// sync folder and the active plan entries.
//
// Why a module: queue.mjs was one file of about 6,300 lines. It is now a thin entry point (the usage comment and the
// dispatch on the command word) plus the modules in cli/. The code was moved as it was: same output, exit codes and files.
//
// Used by: cli/plans.mjs.
// Tested in: lib/__tests__/queuePlan.test.ts, queuePlanMap.test.ts, queuePlanWork.test.ts.
// =============================================================

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  a, byName, CONFIG, cut, die, editLogged, FOLDER, G, HERE, KK, L, MAIN_TREE, P, read, readPlans, readQueueForPlan, S,
  undoHint, val, WIDTH, withLock, writePlans,
} from './context.mjs';
import { docFindingsLine, existsSource, planError, readDoc, SOURCE_ROOT } from './planShared.mjs';

// ---- plan check, plan modules and plan backup ----------------------------------------

/** The .md files under queuePlan.DOCUMENT_FOLDERS (relative paths with slashes), without hidden folders and node_modules. */
function planDocuments() {
  const out = [];
  const go = (rel) => {
    let list;
    try {
      list = fs.readdirSync(path.join(SOURCE_ROOT, rel), { withFileTypes: true });
    } catch {
      return; // the folder does not exist
    }
    for (const d of list) {
      if (d.name.startsWith('.') || d.name === 'node_modules') continue;
      const r = `${rel}/${d.name}`;
      if (d.isDirectory()) go(r);
      else if (d.isFile() && d.name.toLowerCase().endsWith('.md')) out.push(r);
    }
  };
  for (const m of P.DOCUMENT_FOLDERS) go(m);
  return out;
}
const sourceGit = G.makeGit(SOURCE_ROOT);
/**
 * The files (of `files`) that changed in HEAD after the verification: after the commit when it is known, otherwise after the day.
 * An unknown commit or a folder that is not a git repo gives an empty list (nothing to say).
 */
function changedFiles(files, { date, commit }) {
  const safe = typeof commit === 'string' && /^[0-9a-f]{4,40}$/i.test(commit);
  const args = safe
    ? ['log', '--format=', '--name-only', `${commit}..HEAD`, '--', ...files]
    : ['log', '--format=', '--name-only', `--since=${date}T23:59:59`, 'HEAD', '--', ...files];
  const out = sourceGit(args);
  if (out == null) return [];
  return [
    ...new Set(
      out
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ].sort();
}
/**
 * The drift check for the index file (make-index.mjs --check). The index is ordered by the register, so an entry that
 * gets new sources makes it stale; `plan check` shows that as its own point. Read-only. The same data folder as
 * queue.mjs (QUEUE_FOLDER passed on). make-index.mjs skips with exit 0 when the index is turned off (indexFile: null),
 * or the register or the index file is missing.
 * Answer: { status: 'ok' | 'drift' | 'skipped' | 'error', text } (text = the output, short).
 */
function indexDrift() {
  const s = spawnSync(process.execPath, [path.join(HERE, 'make-index.mjs'), '--check'], {
    cwd: KK.config().root,
    encoding: 'utf8',
    env: { ...process.env, QUEUE_FOLDER: FOLDER },
  });
  if (s.error) return { status: 'error', text: `make-index.mjs did not start: ${s.error.message}` };
  const text = `${s.stdout ?? ''}${s.stderr ?? ''}`.trim();
  if (s.status === 1) return { status: 'drift', text };
  if (s.status !== 0) return { status: 'error', text: text || `exit ${s.status}` };
  return { status: /skipping/.test(text) ? 'skipped' : 'ok', text };
}
/** `plan check [--json] [--max N]`: the hygiene of the plan register. Read-only; changes nothing. */
export function planCheck(json) {
  const queue = readQueueForPlan();
  const reg = readPlans();
  const days = S.daysBackward(Date.now(), P.CAPACITY_WINDOW_DAYS);
  const donePerWeek = S.doneInWindow(queue, days).length / (P.CAPACITY_WINDOW_DAYS / 7);
  const r = P.check(reg, queue, {
    documents: planDocuments(),
    existsPath: existsSource,
    readDoc,
    changedFiles,
    donePerWeek,
    projectFor: (o) => L.projectFor(o, queue.projects ?? {}),
  });
  const index = indexDrift();
  if (json) {
    console.log(JSON.stringify({ ok: true, changed: reg.changed ?? null, ...r, index }));
    return;
  }
  const max = Number(val('--max') ?? 15) || 15;
  const chunk = (title, list, line) => {
    if (!list.length) return;
    console.log(`\n${title} (${list.length})`);
    for (const x of list.slice(0, max)) console.log(`  ${cut(line(x), WIDTH - 2)}`);
    if (list.length > max) console.log(`  ... ${list.length - max} more (--max N or --json)`);
  };
  const who = (x) => x.id ?? x.task ?? x.project ?? '';
  console.log(`Plan check: ${reg.entries.length} entries, ${r.count} findings. ${r.capacity.text}`);
  chunk('Unregistered (no entry points to the document)', r.unregistered, (s) => s);
  chunk('Dead paths', r.dead_paths, (x) => `${x.id}: ${x.path}`);
  chunk('Stale', r.stale, (x) => `${x.id}: ${x.reason}`);
  chunk('Built, but not verified (plan verify)', r.not_verified, (s) => s);
  chunk('Status deviation', r.statusDeviation, (x) => `${who(x)}: ${x.reason}`);
  chunk('Rule deviation (the priority rules, not changed automatically)', r.ruleDeviation, (x) => `${x.id}: ${x.reason}`);
  chunk('Gaps', r.gaps, (x) => `${x.id}: ${x.reason}`);
  chunk(
    'Possible duplicates (plan combine)',
    r.duplicates,
    (x) => `${x.ids.join(' + ')}: ${x.reason}`,
  );
  if (r.capacity.without_size.length)
    console.log(`\nNow without size: ${r.capacity.without_size.join(', ')}`);
  // Reference documents and history are registered, but not read for status (not findings).
  if (r.references?.length)
    console.log(
      `\nReference and history (registered, no status check): ${r.references.length} source(s) in ` +
        `${new Set(r.references.map((x) => x.id)).size} entr(ies)`,
    );
  // The consistency checks for documents and agreements.
  if (r.doc_consistency)
    chunk(
      'Documents and agreements (plan doc check --write enters them as problems)',
      r.doc_consistency,
      docFindingsLine,
    );
  // The index against the register (make-index.mjs --check). Drift or an error is shown with the output; fix it with
  // `node scripts/orchestrator/make-index.mjs` (writes the index in this tree).
  if (index.status === 'drift' || index.status === 'error') {
    console.log(`\nIndex against the register (${index.status === 'drift' ? 'DRIFT' : 'ERROR'})`);
    for (const l of index.text.split('\n')) console.log(`  ${cut(l.trim(), WIDTH - 2)}`);
  } else {
    console.log(`\nIndex against the register: ${index.status === 'ok' ? 'OK' : 'skipped (turned off, or no register or index file)'}`);
  }
}
/**
 * `plan modules [--link] [--dry] [--json]`: creates modules (config().modules) that are missing in `areas`;
 * existing ones are not changed. With --link, projects without a module get the proposal in config().projectModuleSuggestion (logged, undone
 * with queue.mjs undo). --dry shows what would have happened.
 */
export function planModules(json) {
  const link = a.includes('--link');
  const perform = (queue) => {
    const plan = P.modulePlan(queue, { link });
    const error = [];
    for (const m of plan.newOnes) {
      const s = L.setArea(queue, m.oid, { title: m.title, description: m.description });
      error.push(...s.error);
    }
    for (const k of plan.link) {
      const reg = L.newRegister(queue.projects, { [k.pid]: { area: k.oid } }, queue.areas);
      if (reg.error.length) error.push(...reg.error);
      else queue.projects = reg.register;
    }
    return { ...plan, error };
  };
  const preview = perform(L.cloneJson(read()));
  if (preview.error.length) die(`Nothing changed:\n  ${preview.error.join('\n  ')}`);
  const empty = !preview.newOnes.length && !preview.link.length;
  const dry = a.includes('--dry');
  const r =
    dry || empty
      ? preview
      : editLogged('plan modules', (queue) => {
          const s = perform(queue);
          if (s.error.length) die(`Nothing changed:\n  ${s.error.join('\n  ')}`);
          return s;
        });
  if (json) {
    console.log(JSON.stringify({ ok: true, dry, newOnes: r.newOnes, exists: r.exists, link: r.link }));
    return;
  }
  const pre = dry ? 'Preview (nothing written): ' : '';
  console.log(
    `${pre}${r.newOnes.length ? `new areas: ${r.newOnes.map((m) => `${m.oid} (${m.title})`).join(', ')}` : 'all areas exist'}`,
  );
  if (r.exists.length)
    console.log(`Already exist (unchanged): ${r.exists.map((m) => m.oid).join(', ')}`);
  if (r.link.length)
    console.log(
      `${pre}projects linked to area: ${r.link.map((k) => `${k.pid} → ${k.oid}`).join(', ')}`,
    );
  if (!dry && !empty && undoHint()) console.log(undoHint());
  if (!link)
    console.log(
      'Projects are linked with cq plan modules --link (proposed) or cq project <pid> --area <oid>.',
    );
}
/**
 * The backup script for the plan register: config().planBackup (path relative to the project root or absolute), null = not
 * set up. QUEUE_PLAN_BACKUP overrides (tests).
 */
const SYNC = process.env.QUEUE_PLAN_BACKUP
  ? path.resolve(process.env.QUEUE_PLAN_BACKUP)
  : CONFIG.planBackup
    ? path.resolve(MAIN_TREE, CONFIG.planBackup)
    : null;
/**
 * `plan backup [--push] [--dry]`: runs the project's backup script (e.g. a script that copies the queue,
 * the plan register and the time log to a separate repo and commits there). The script gets QUEUE_ROOT = the project root and the flag
 * --push passed on. No automatic execution: propose it at the end of a session.
 */
export function planBackup() {
  const push = a.includes('--push');
  if (!SYNC)
    die(
      'plan backup is not set up: set "planBackup" in queue.config.json to the path of a backup script (a node script ' +
        'that gets QUEUE_ROOT = the project root and, if any, --push), or QUEUE_PLAN_BACKUP.',
    );
  const name = path.basename(SYNC);
  if (!fs.existsSync(SYNC))
    die(`Could not find ${SYNC} (planBackup in queue.config.json, or QUEUE_PLAN_BACKUP).`);
  const args = [SYNC, ...(push ? ['--push'] : [])];
  if (a.includes('--dry')) {
    console.log(
      `Preview (nothing run): node ${args.join(' ')} in ${path.dirname(SYNC)}, source ${MAIN_TREE}`,
    );
    return;
  }
  const s = spawnSync(process.execPath, args, {
    cwd: path.dirname(SYNC),
    stdio: 'inherit',
    env: { ...process.env, QUEUE_ROOT: MAIN_TREE },
  });
  if (s.error) die(`${name} did not start: ${s.error.message}`);
  if (s.status !== 0)
    die(`${name} stopped (exit ${s.status}); see the output above.`, s.status ?? 1);
  console.log(
    push
      ? 'Backup done and pushed.'
      : 'Backup done (push with cq plan backup --push).',
  );
}
/**
 * `plan active [<PL-id> [--end] [--by "..."]] [--json]`: "Working now". With an id the cursor
 * { entry, at, by } is set in plans.json (pulse; the last one wins), with --end it is removed. The same lock and atomic writes as the
 * other plan commands, but no changelog (frequent pulses, nothing to undo) and `changed` is not bumped. Without an id
 * the entries under work now are listed (the cursor dies after queuePlan.ACTIVE_SESSION_HOURS hours without a pulse).
 */
export function planActive(json) {
  const id = a[2] && !a[2].startsWith('--') ? a[2] : null;
  if (!id) {
    const activeOnes = P.activeEntries(readPlans());
    if (json) console.log(JSON.stringify({ ok: true, activeOnes }));
    else if (!Object.keys(activeOnes).length) console.log('No plan entries are under work now.');
    else
      for (const [pid, m] of Object.entries(activeOnes))
        console.log(`${pid.padEnd(16)} by ${m.by}, last pulse ${m.at}`);
    return;
  }
  const end = a.includes('--end');
  const r = withLock(() => {
    const reg = readPlans();
    const s = P.setActiveSession(reg, id, { by: byName(), end });
    if (s.error.length) planError(s.error);
    if (s.changed) writePlans(reg, { bump: false });
    return s;
  });
  if (json) console.log(JSON.stringify({ ok: true, entry: id, cursor: r.cursor, changed: r.changed }));
  else if (end)
    console.log(r.changed ? `${id}: the cursor is removed.` : `${id}: had no marker.`);
  else
    console.log(
      `${id}: under work (by ${r.cursor.by}, ${r.cursor.at}); end with cq plan active ${id} --end`,
    );
}
