// =============================================================
// cli/batch.mjs: the batch queue: the batch command and its helpers (groups, packing small tasks into one track).
//
// Small tasks with batched: true wait in the batch queue; batch shows the groups and packs one into a track
// (--execute). batchGroupLine is also used by show.
//
// Why a module: queue.mjs was one file of about 6,300 lines. It is now a thin entry point (the usage comment and the
// dispatch on the command word) plus the modules in cli/. The code was moved as it was: same output, exit codes and files.
//
// Used by: queue.mjs (dispatch), cli/view.mjs (batchGroupLine).
// Tested in: lib/__tests__/queueBatch.test.ts, queueBoardBulk.test.ts.
// =============================================================

import fs from 'node:fs';
import path from 'node:path';

import {
  a, checkExpect, cut, die, FOLDER, L, missionRef, positional, read, readMission, val, WIDTH, withLock, write,
} from './context.mjs';

// ---- Batch queue ----------------------------------------------------------------------------------------
/** "K  65 / 90-120 min  [######------]  missing 25 min  (3 tasks)" for a group from queueLogic.batchGroups. */
export function batchGroupLine(g) {
  const width = 12;
  const filled = g.measure ? Math.round(Math.min(g.sum / g.measure.max, 1) * width) : 0;
  const bar = `[${'#'.repeat(filled)}${'-'.repeat(width - filled)}]`;
  const status = g.invalid
    ? `INVALID (${g.class} cannot be packed; take it out with edit --json '{"batched":false}')`
    : g.ready
      ? g.over
        ? 'READY FOR PACKING (over the upper target: becomes several packages)'
        : 'READY FOR PACKING'
      : `missing ${g.measure.min - g.sum} min`;
  const measure = g.measure ? `${g.measure.min}–${g.measure.max}` : '?';
  return `${String(g.class).padEnd(2)} ${`${g.sum} / ${measure} min`.padEnd(17)} ${bar}  ${status}  (${g.count} task(s))`;
}
/**
 * Executes the packing plan under the lock, ALL OR NOTHING: `planFn(queue)` gives [{ id, parts, title, out }] (computed inside the
 * lock). `out` takes a single task out of the batch queue; otherwise queueLogic.batchPack. If one package fails, nothing is written.
 * The mission files are written first (never over an existing one), then the queue file; if the write fails, the files are removed again.
 */
function batchPackExecute(planFn) {
  return withLock(() => {
    const queue = read();
    // The board sends --expect-changed (the queue's version from the preview); exit 6 when the queue has changed since.
    checkExpect(queue);
    const plan = planFn(queue);
    if (!plan.length) die('No groups in the batch queue are ready for packing. Nothing was changed.');
    const now = new Date().toISOString();
    const result = [];
    const files = [];
    for (const p of plan) {
      if (p.out) {
        const o = queue.tasks.find((x) => x.id === p.parts[0]);
        if (!o) die(`Unknown task ${p.parts[0]}. Nothing was changed.`);
        delete o.batched;
        result.push({ out: true, id: o.id, sum: p.sum });
        continue;
      }
      const file = path.join(FOLDER, 'mission', `${p.id}.md`);
      if (fs.existsSync(file)) die(`The mission file already exists: ${file}. Nothing was changed.`);
      if (files.some((f) => f.file === file)) die(`${p.id} appears twice. Nothing was changed.`);
      const texts = new Map();
      const error = [];
      for (const id of p.parts) {
        const o = queue.tasks.find((x) => x.id === id);
        if (!o) continue; // batchPack reports unknown ids
        const t = readMission(o);
        if (t.error) error.push(t.error);
        else texts.set(id, t);
      }
      if (error.length) die(`Nothing packed:\n  ${error.join('\n  ')}`);
      const r = L.batchPack(queue, p.parts, {
        newId: p.id,
        title: p.title,
        mission: missionRef(file),
        by: 'ravenseat batch pack',
        now,
      });
      if (r.error.length) die(`Nothing packed (${p.id ?? 'without id'}):\n  ${r.error.join('\n  ')}`);
      const parts = p.parts.map((id) => queue.tasks.find((x) => x.id === id));
      files.push({ file, text: L.batchMissionText(r.new, parts, texts, now) });
      result.push({ ...r, sum: r.new.content_min });
    }
    const written = [];
    try {
      fs.mkdirSync(path.join(FOLDER, 'mission'), { recursive: true });
      for (const f of files) {
        fs.writeFileSync(f.file, f.text, { flag: 'wx' });
        written.push(f.file);
      }
      write(queue);
    } catch (e) {
      for (const f of written) fs.rmSync(f, { force: true });
      die(`Nothing packed: ${e?.message ?? e}`);
    }
    return result;
  });
}
/** One line per executed package (or task taken out of the batch queue). */
function batchExecutedLine(p) {
  if (p.out) return `${p.id}: taken out of the batch queue (${p.sum} min alone).`;
  return (
    `Packed ${p.new.id} (${p.new.class}, ${p.sum} min, status ${p.new.status}) from ${p.cancelled.join(', ')} ` +
    `(cancelled); mission ${p.new.mission}` +
    (p.redirected.length ? `; depends_on repointed in ${p.redirected.join(', ')}` : '') +
    '.'
  );
}

/** `ravenseat batch` (the usage is at the top of queue.mjs). */
export function cmdBatch() {
  // Batch queue. Without arguments: the groups with their sum against the target. `pack`: one new track from the given ids, or
  // proposals for the ready groups (--auto), executed only with --execute.
  if (a[1] !== 'pack') {
    if (a[1]) die('batch [pack <id> <id> ... --id <new-id> [--title "..."] | pack --auto [--execute]]');
    const queue = read();
    const gr = L.batchGroups(queue);
    if (!gr.length) {
      console.log('The batch queue is empty (add small, non-blocking tasks with "batched": true).');
    } else {
      const n = gr.reduce((s, g) => s + g.count, 0);
      const min = gr.reduce((s, g) => s + g.sum, 0);
      console.log(
        `BATCH_QUEUE: ${n} task(s), ${min} content minutes in ${gr.length} group(s). Target per class: ` +
          Object.entries(L.BATCH_MEASURE)
            .map(([k, m]) => `${k} ${m.min}–${m.max} min`)
            .join(', ') +
          '. Ready for packing from the lower target.',
      );
      let previousPid = null;
      for (const g of gr) {
        if (g.pid !== previousPid) {
          console.log(cut(`\n${g.pid}${g.title ? `  ${g.title}` : ''}`, WIDTH));
          previousPid = g.pid;
        }
        console.log(cut(`  ${batchGroupLine(g)}`, WIDTH));
        for (const f of g.features) {
          console.log(cut(`    ${f.feature} (${f.sum} min)`, WIDTH));
          for (const id of f.ids) {
            const o = g.tasks.find((x) => x.id === id);
            const col = `      ${o.id.padEnd(14)} ${`${o.content_min} min`.padEnd(8)} ${o.status === 'proposed' ? 'proposed ' : ''}`;
            console.log(col + cut(o.title, WIDTH - col.length));
          }
        }
        if (g.common_files.length)
          console.log(cut(`    shared files: ${g.common_files.join(', ')}`, WIDTH));
      }
      if (gr.some((g) => g.ready))
        console.log('\nSuggested packages: ravenseat batch pack --auto (executed with --execute).');
    }
  } else if (a.includes('--auto')) {
    const execute = a.includes('--execute');
    const proposed = L.batchSuggestion(read());
    if (!proposed.length) {
      console.log('No groups in the batch queue are ready for packing.');
    } else if (!execute) {
      console.log(`Proposed (${proposed.length}; execute all with ravenseat batch pack --auto --execute):`);
      for (const f of proposed)
        console.log(
          f.out
            ? `  ${f.pid} ${f.class}: ${f.parts[0]} has ${f.sum} min alone; take it out: ` +
                `ravenseat edit ${f.parts[0]} --json '{"batched":false}'`
            : `  ${f.pid} ${f.class}, ${f.sum} min: ravenseat batch pack ${f.parts.join(' ')} --id ${f.id}`,
        );
    } else {
      // All the proposals in one write under the lock: all or nothing (the proposals are recomputed inside the lock).
      const r = batchPackExecute((queue) => L.batchSuggestion(queue).map((f) => ({ ...f, title: null })));
      for (const p of r) console.log(batchExecutedLine(p));
    }
  } else {
    const ids = positional(2, ['--id', '--title', '--expect-changed', '--by']);
    const newId = val('--id');
    if (!ids.length || !newId) die('batch pack <id> <id> ... --id <new-id> [--title "..."]');
    const r = batchPackExecute(() => [
      { id: newId, parts: ids, title: val('--title') ?? null, out: false },
    ]);
    for (const p of r) console.log(batchExecutedLine(p));
  }
}
