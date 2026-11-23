// =============================================================
// cli/merge/blocks.mjs: the smaller commands that finish work: the blocker reasons (block, unblock, blockers), the
// migration number blocks (next-migr, migr) and a picked task's hand-off (deliver, release, deliveries).
//
// Why a module: the receive and merge flow got modules of their own (SPLIT-1, see cli/merge.mjs); these commands are not
// part of that flow. Moved as they were: same output, exit codes and files.
//
// Used by: cli/merge.mjs (the exported command functions, dispatched from queue.mjs).
// Tested in: lib/__tests__/queueBlockers.test.ts, lib/__tests__/queueMigrBlock.test.ts, lib/__tests__/queueExternal.test.ts,
//   __tests__/queueAdopt.test.ts.
// =============================================================

import fs from 'node:fs';
import path from 'node:path';

import { a, branchFor, branchInfo, CLI, die, edit, GIT_ROOT, L, MIGR, positional, read, val } from '../context.mjs';
import { blockList, findDeliveries, highestMigr, scratchpadFor, takenForMigr } from '../tracks.mjs';

/** `ravenseat block` (the usage is at the top of queue.mjs). */
export function cmdBlock() {
  // ---- Blocker reasons (queueLogic.BLOCK_CODES): open one by hand; at most one is open per task ----
  const [id, code] = positional(1, ['--note']);
  if (!id || !code)
    die(`block <id> <code> [--note "..."]   (code: ${L.BLOCK_CODES.map((b) => b.code).join(', ')})`);
  const r = edit((queue) => {
    const o = queue.tasks.find((x) => x.id === id);
    if (!o) die(`Unknown task ${id}`);
    const x = L.openBlock(o, code, { note: val('--note') ?? null });
    if ('error' in x) die(x.error);
    return x;
  });
  if (r.kept) console.log(`${id}: already blocked by ${code} since ${r.block.from}${r.block.note ? ` (${r.block.note})` : ''}`);
  else
    console.log(
      `${id}: blocked by ${code} from ${r.block.from}` +
        `${r.closed ? ` (closed the open ${r.closed.code})` : ''}. Close it with ${CLI} unblock ${id}.`,
    );
}

/** `ravenseat unblock` (the usage is at the top of queue.mjs). */
export function cmdUnblock() {
  const [id] = positional(1);
  if (!id) die('unblock <id>');
  const closed = edit((queue) => {
    const o = queue.tasks.find((x) => x.id === id);
    if (!o) die(`Unknown task ${id}`);
    const c = L.closeBlock(o);
    // The owner closing secret-found by hand is the owner's word on it: the merge no longer stops on the scan's record.
    if (c?.code === 'secret-found') delete o.secret_found;
    return c;
  });
  console.log(closed ? `${id}: ${closed.code} closed (${closed.from} to ${closed.to})` : `${id} has no open blocker.`);
}

/** `ravenseat blockers` (the usage is at the top of queue.mjs). */
export function cmdBlockers() {
  // ---- Per code: count and blocked time in the period, top first (read-only) ----
  const raw = val('--days') ?? '7';
  const days = Number(raw);
  if (!(days > 0)) die('--days must be a number > 0');
  const summary = L.blockerSummary(read(), { days });
  if (a.includes('--json')) console.log(JSON.stringify({ days, blockers: summary }, null, 2));
  else for (const l of L.blockerLines(summary, { days })) console.log(l);
}

/** `ravenseat next-migr` (the usage is at the top of queue.mjs). */
export function cmdNextMigr() {
  // The highest file in the main tree (baseBranch, where merged migrations live) and the highest assigned block in the queue.
  if (!MIGR.folder)
    die('The project has no migration flow (config().migrations.folder is not set); next-migr does not apply.');
  const highFile = highestMigr(GIT_ROOT);
  const newText = a[1];
  if (newText == null) {
    const queue = read();
    console.log(
      `next_migr ${queue.next_migr}; ` +
        `highest migrationFile ${highFile}, highest block ${L.highestBlockNr(queue)}`,
    );
  } else {
    const fresh = Number(newText);
    const previous = edit((queue) => {
      const v = L.nextMigrGuard({
        now: queue.next_migr,
        new: fresh,
        highestFile: highFile,
        highestBlock: L.highestBlockNr(queue),
        taken: takenForMigr(queue, { scratch: scratchpadFor() }),
      });
      if (!v.ok) die(`Nothing changed: ${v.error}`);
      const f = queue.next_migr;
      queue.next_migr = fresh;
      return f;
    });
    console.log(`next_migr ${previous} → ${fresh}`);
  }
}

/** `ravenseat migr` (the usage is at the top of queue.mjs). */
export function cmdMigr() {
  // ---- `migr move <id> <block>` moves the block in the queue and in the prompt files ----
  if (!MIGR.folder)
    die('The project has no migration flow (config().migrations.folder is not set); migr does not apply.');
  const [sub, id, blockArg] = positional(1, ['--scratchpad']);
  if (sub !== 'move' || !id || !blockArg)
    die('migr move <id> <block> [--scratchpad <folder>] [--force]   (block: 3470 or 3470-3479)');
  const scratch = scratchpadFor();
  const r = edit((queue) => {
    const o = queue.tasks.find((x) => x.id === id);
    if (!o) die(`Unknown task ${id}`);
    if (L.MIGR_FREE_STATUS.has(o.status)) die(`${id} is ${o.status}; a finished task is not moved.`);
    const size = Number(MIGR.blockSize) > 0 ? Math.floor(Number(MIGR.blockSize)) : 10;
    const old = L.blockInterval(o.migr_block);
    const tens = old ? (old.to - old.from + 1) / size : Math.max(1, Number(o.migr_tens ?? 0));
    const fresh = L.parseMoveBlock(blockArg, tens, size);
    if (fresh.error) die(`Nothing changed: ${fresh.error}`);
    const hit = takenForMigr(queue, { scratch, except: id }).filter(
      (t) => t.from <= fresh.to && t.to >= fresh.from,
    );
    if (hit.length && !a.includes('--force'))
      die(
        `Nothing changed: ${fresh.from}–${fresh.to} is taken (${blockList(hit)}); --force only on the owner's word`,
      );
    const previous = o.migr_block ?? null;
    o.migr_block = L.migrBlockText(fresh);
    const nextBefore = queue.next_migr;
    queue.next_migr = Math.max(Number(queue.next_migr) || 0, fresh.to + 1);
    const now = new Date().toISOString();
    o.remarks = [...(o.remarks ?? []), `${now} migr move: ${previous ?? 'none'} → ${o.migr_block}`];
    return {
      o: { ...o },
      old,
      fresh,
      previous,
      nextBefore,
      next: queue.next_migr,
      scratchpad: o.scratchpad,
    };
  });
  console.log(`${id}: migr_block ${r.previous ?? 'none'} → ${r.o.migr_block}`);
  if (r.next !== r.nextBefore) console.log(`next_migr ${r.nextBefore} → ${r.next}`);
  // The prompt files (prompt-<id>.md and fix rounds prompt-<id>-rN.md) in the task's scratchpad and in --scratchpad.
  const folders = [...new Set([scratch, r.scratchpad].filter(Boolean).map((m) => path.resolve(m)))];
  const own = (f) => L.promptTask(f, [r.o]) === id;
  let count = 0;
  for (const m of folders) {
    let files = [];
    try {
      files = fs.readdirSync(m).filter((f) => /^prompt-.+\.md$/.test(f) && own(f));
    } catch {
      continue;
    }
    for (const f of files) {
      const p = path.join(m, f);
      const before = fs.readFileSync(p, 'utf8');
      let after = L.moveBlockInText(before, r.old, r.fresh);
      const note = `The migration block has been moved to ${r.o.migr_block} (ravenseat migr move). Use only the new block.`;
      if (!after.includes(note)) after = `${after.replace(/\s*$/, '')}\n\n${note}\n`;
      if (after !== before) {
        fs.writeFileSync(p, after);
        count += 1;
        console.log(`wrote ${p}`);
      }
    }
  }
  if (!count) console.log('Found no prompt file to update (--scratchpad <folder> points there).');
  if (r.o.status === 'running' || r.o.status === 'picked')
    console.log(
      `${id} is running: send the track the new block with SendMessage ("The migration block has been moved to ${r.o.migr_block}").`,
    );
}

/** `ravenseat deliver` (the usage is at the top of queue.mjs). */
export function cmdDeliver() {
  const id = a[1];
  if (!id) die('deliver <id>');
  const r = edit((queue) => {
    const s = L.deliver(queue, id);
    if (s.error) die(s.error);
    return s;
  });
  console.log(
    `${id}: review (delivered by ${r.task.picked_by ?? '?'}). The orchestrator merges ${r.task.branch ?? branchFor(id)}.`,
  );
}

/** `ravenseat release` (the usage is at the top of queue.mjs). */
export function cmdRelease() {
  const id = a[1];
  if (!id) die('release <id>');
  // The commits are counted before the lock (git must not run with the queue file locked). The branch is in the task (queue/<id>).
  const before = read().tasks.find((x) => x.id === id);
  const g = branchInfo(before?.branch ?? branchFor(id));
  const r = edit((queue) => {
    const s = L.release(queue, id, { commits: g.commits });
    if (s.error) die(s.error);
    return s;
  });
  console.log(`${id}: released (was picked by ${r.by ?? '?'}), waiting again.`);
  if (r.warning) console.log(`WARNING: ${r.warning}`);
}

/** `ravenseat deliveries` (the usage is at the top of queue.mjs). */
export function cmdDeliveries() {
  // ---- Adoption: track-result.md files that have not been received (read-only; pulse does the same and remembers what it reported) ----
  const found = findDeliveries(read());
  if (a.includes('--json')) console.log(JSON.stringify(found, null, 2));
  else if (!found.length)
    console.log('No deliveries waiting (no track-result.md newer than the start or the last receive).');
  else
    for (const l of found)
      console.log(
        `${l.id} (${l.taskStatus})  ${l.line}\n  ${l.path}  ${l.new ? 'NEW' : 'reported before'}  → ${CLI} receive ${l.id}`,
      );
}
