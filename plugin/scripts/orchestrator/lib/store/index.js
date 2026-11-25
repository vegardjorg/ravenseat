// =============================================================
// lib/store/index.js: the Store, Ravenseat's storage layer shaped around operations on records, not files
// (LAGRING-1a, steps 1-3 of plans/lagring-gjennomgang-2026-11-24.md; owner direction 24.11: a middleware layer, so a
// database backend later is a swap, not a rewrite. No database backend is built).
//
//   const st = openStore({ folder, tree })     folder = the data folder, tree = the project tree for git-tracked families
//   st.path(fam)                               where a family lives (callers should need this less and less)
//   st.readJson(fam, { onCorrupt? })           the family's value, with its onCorrupt rule (lib/store/families.js)
//   st.writeJson(fam, value)                   atomic, with the family's backup (lib/store/fileBackend.js)
//   st.update(fam, fn)                         read + fn + write under the store lock; fn gets the value read under the
//                                              lock and returns the new one (keep it pure: a database may retry it)
//   st.withLock(fn)                            runs fn under the store lock (re-entrant in one process)
//   st.nextId(scheme, { atLeast })             the next id of a scheme (D, G), RESERVED in id-reservations.json under the
//                                              lock: a deleted record never frees its id, and two callers that saw the
//                                              same folder still get two ids. atLeast = the lowest number the caller's
//                                              own data allows (the highest id it can see + 1)
//   st.transaction([famA, famB], tx => ...)    several families written as one unit (step 7, TRANSACTIONS in the code):
//                                              the families' locks in LOCK_ORDER (queue, then store), writes staged in
//                                              tx, the commit through <dataFolder>/.journal/<txid>.json. fn must be pure
//   st.recover(families?) / st.journals()      finishes (or lists, for doctor) a commit that stopped part way; one that
//                                              cannot be finished is marked failed and skipped from then on
//   st.dropJournal(id)                         sets a failed journal aside in .journal/failed/ (the owner's command)
//   st.scan()                                  data folder entries the register does not know, and orphaned tmp files
//   st.sweepTmp({ dry })                       removes the orphaned tmp files (dry: lists only)
//
// THE LOCK: <dataFolder>/.storeLock, taken with lib/queueLock.js (the same generation rule and takeover as the queue
// lock; no second lock implementation). A separate folder from the queue lock (.lockState), so a command that already
// holds the queue lock (resolve --keep proposes a design choice) never waits on itself. Order when both are needed: the
// queue lock first, then the store lock; nothing takes them the other way round.
//
// ORPHANED TMP FILES: a tmp file whose pid is not running and that is older than ORPHAN_AGE_MS (a write in progress
// is never one). Doctor only lists them; `ravenseat store sweep --tmp` removes them on the owner's command.
//
// Used by: cli/store.mjs, cli/catalog.mjs, cli/inspection.mjs (guards add), cli/context.mjs (plans), cli/doctor.mjs.
// Tested in: lib/__tests__/store.test.ts, __tests__/storeFlow.test.ts.
// =============================================================
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const FAM = require('./families.js');
const FB = require('./fileBackend.js');
const QL = require('../queueLock.js');
const SF = require('../stateFile.js');

const LOCK_DIR = '.storeLock';
/** The lock folder of each lock kind (a family's `lock`, lib/store/families.js). '.lockState' is cli/context.mjs LOCK. */
const LOCK_DIRS = Object.freeze({ queue: '.lockState', store: LOCK_DIR });
/** The journal folder of transaction() (the 'journal' family). */
const JOURNAL_DIR = FAM.family('journal').dir;
/** Where `ravenseat store journal drop` sets a failed journal aside, inside the journal folder (never recovered or swept). */
const FAILED_DIR = 'failed';
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
/** A tmp file younger than this is left alone even when its pid looks dead (pid reuse, a clock step). */
const ORPHAN_AGE_MS = 10 * 60_000;
/** How deep scan looks for tmp files under the data folder (mission/, handover-archive/, snapshots/ ...). */
const SCAN_DEPTH = 3;

// The store lock this process holds, per lock folder: { me, depth }. Shared by every Store of the same folder in this
// process, so the lock is re-entrant (nextId inside withLock does not wait on itself). A Store opened with an `io` (a
// simulated process on the memory backend) has a map of its own per io, so two simulated processes never share a hold.
const held = new Map();
const heldByIo = new WeakMap();
let exitHook = false;

function releaseAll() {
  for (const [dir, h] of held) QL.release(dir, h.me);
  held.clear();
}

/**
 * Opens a Store on a data folder.
 * @param {{ folder: string, tree?: string, lockWaitMs?: number, now?: () => number, pidAlive?: (pid: number) => boolean,
 *   io?: { fs?: object, now?: () => number, pid?: number, pidAlive?: Function, sleep?: Function, hostname?: string } }} o
 *   io: the backend's io (lib/store/memoryBackend.js mem.io(), or a test's wrapped fs); the real fs, clock and pid
 *   when left out. The file backend and the memory backend run the same code below, only the io differs (step 4).
 *   outerLocks: { queue: () => token|null }, a lock this process already holds outside the store (cli/context.mjs
 *   holds the queue lock with its own token): transaction() uses it instead of waiting on itself, and never releases it.
 *   journalRecover: 'auto' (default) | 'report', the store.journalRecover setting (see TRANSACTIONS below).
 */
function openStore({ folder, tree = null, lockWaitMs, now, pidAlive, io = null, outerLocks = {}, journalRecover = 'auto' } = {}) {
  if (!folder) throw new Error('openStore needs the data folder');
  const f = io?.fs ?? fs;
  now = now ?? io?.now ?? Date.now;
  pidAlive = pidAlive ?? io?.pidAlive ?? QL.pidAlive;
  const pid = io?.pid ?? process.pid;
  const LK = io ? QL.lockOn(io) : QL;
  let holds = held;
  if (io) {
    holds = heldByIo.get(io) ?? new Map();
    heldByIo.set(io, holds);
  }
  const lockDir = path.join(folder, LOCK_DIR);
  const waitMs = lockWaitMs ?? QL.waitMsFrom(process.env.QUEUE_LOCK_WAIT_MS);

  /** The absolute path of a single-file family (or a folder family's folder). */
  function pathOf(name) {
    const f = FAM.family(name);
    const rel = f.file ?? f.dir;
    if (!rel) throw new Error(`storage family "${name}" has no single path (it is matched by name)`);
    const base = f.root === 'tree' ? tree : folder;
    if (!base) throw new Error(`storage family "${name}" lives in the project tree; open the store with { tree }`);
    return path.join(base, ...rel.split('/'));
  }

  const emptyOf = (f) => (f.empty === undefined ? null : JSON.parse(JSON.stringify(f.empty)));

  function readJson(name, o = {}) {
    const fam = FAM.family(name);
    return FB.readJson(pathOf(name), {
      onCorrupt: o.onCorrupt ?? (fam.onCorrupt === 'broken' || fam.onCorrupt === 'skip' ? 'empty' : fam.onCorrupt),
      fallback: o.fallback !== undefined ? o.fallback : emptyOf(fam),
      describe: o.describe,
      cache: o.cache === true,
      fs: f,
    });
  }

  function writeJson(name, value) {
    const fam = FAM.family(name);
    FB.writeJson(pathOf(name), value, { backup: fam.backup === 'prev' ? 'prev' : 'none', fs: f, pid });
  }

  /** The store lock (every family with lock 'store'). */
  function withLock(fn) {
    return withLockOf('store', fn);
  }

  /**
   * Runs fn under one of the locks (kind 'queue' or 'store', LOCK_DIRS), re-entrant in this process. The queue lock held
   * by an outer holder (outerLocks.queue, cli/context.mjs) is used as it is: never taken a second time, never released.
   */
  function withLockOf(kind, fn) {
    const dir = path.join(folder, LOCK_DIRS[kind]);
    const outer = typeof outerLocks?.[kind] === 'function' ? outerLocks[kind]() : null;
    if (outer) {
      if (!LK.isHeld(dir, outer))
        throw new Error(`this command lost the ${kind} lock on ${folder} (${LOCK_DIRS[kind]}) before a store transaction; nothing was written`);
      return fn();
    }
    const h = holds.get(dir);
    if (h) {
      h.depth++;
      try {
        return fn();
      } finally {
        h.depth--;
      }
    }
    f.mkdirSync(folder, { recursive: true });
    const got = LK.acquire(dir, { waitMs });
    if (!got.ok)
      throw new Error(QL.heldMessage({ folder: `${folder} (the ${kind} lock, ${LOCK_DIRS[kind]})`, ravenseat: 'ravenseat', ...got }));
    const lockDir = dir;
    holds.set(lockDir, { me: got.me, depth: 1 });
    if (!io && !exitHook) {
      exitHook = true;
      // process.exit skips finally blocks: a die() inside fn must not leave the lock to the takeover rule.
      process.on('exit', releaseAll);
    }
    try {
      return fn();
    } finally {
      const mine = holds.get(lockDir);
      holds.delete(lockDir);
      if (mine) LK.release(lockDir, mine.me);
    }
  }

  function update(name, fn) {
    return withLock(() => {
      const next = fn(readJson(name));
      if (next !== undefined) writeJson(name, next);
      return next;
    });
  }

  function nextId(scheme, { atLeast = 1 } = {}) {
    if (!FAM.ID_SCHEMES[scheme]) throw new Error(`no id scheme "${scheme}"`);
    return withLock(() => {
      const reg = readReservations();
      const top = Number.isInteger(reg.ids[scheme]?.top) ? reg.ids[scheme].top : 0;
      const n = Math.max(top + 1, Number.isInteger(atLeast) && atLeast > 0 ? atLeast : 1);
      reg.ids[scheme] = { top: n, at: new Date(now()).toISOString() };
      writeJson('id-reservations', reg);
      return FAM.formatId(scheme, n);
    });
  }

  /**
   * The reservations. A broken file: its .prev copy is exactly one write older, so that write may have reserved one more
   * id in any scheme; every scheme's top from the copy is raised by one (a gap, never an id handed out twice). With no
   * good copy either, the caller's own data (atLeast) decides, as before the reservations existed. Warns on stderr.
   */
  function readReservations() {
    const ok = (r) => r && typeof r === 'object' && r.ids && typeof r.ids === 'object' && !Array.isArray(r.ids);
    try {
      const r = readJson('id-reservations', { onCorrupt: 'fail' });
      return ok(r) ? r : { version: 1, ids: {} };
    } catch (e) {
      if (e?.code !== 'ESTORECORRUPT') throw e;
      const prev = FB.readJson(`${pathOf('id-reservations')}.prev`, { onCorrupt: 'empty', fallback: null, fs: f });
      const ids = {};
      if (ok(prev)) for (const [k, v] of Object.entries(prev.ids)) if (Number.isInteger(v?.top)) ids[k] = { ...v, top: v.top + 1 };
      console.error(
        `WARNING: ${pathOf('id-reservations')} does not parse; ids continue from ${ok(prev) ? 'its .prev copy, one higher' : 'the files and records alone'}. The file is rewritten now.`,
      );
      return { version: 1, ids };
    }
  }

  // ---- TRANSACTIONS (step 7) ----------------------------------------------------------------------------------------

  const journalDir = path.join(folder, JOURNAL_DIR);
  const recoverMode = journalRecover === 'report' ? 'report' : 'auto';

  /** A file's bytes, or null when it does not exist (any other read error is thrown). */
  function bytesAt(p) {
    try {
      return f.readFileSync(p);
    } catch (e) {
      if (e?.code === 'ENOENT') return null;
      throw e;
    }
  }

  /** sha256 of a file's bytes, or null when it does not exist (any other read error is thrown). */
  function hashFile(p) {
    const b = bytesAt(p);
    return b === null ? null : sha(b);
  }

  /** The text of a file, or null when it does not exist. */
  function textOf(p) {
    try {
      return String(f.readFileSync(p, 'utf8'));
    } catch (e) {
      if (e?.code === 'ENOENT') return null;
      throw e;
    }
  }

  /** The file a transaction writes for (family, id): a single-file family takes no id, a folder family needs one. */
  function targetOf(name, id) {
    const fam = FAM.family(name);
    if (fam.file) {
      if (id !== undefined) throw new Error(`storage family "${name}" is one file; it takes no id`);
      return pathOf(name);
    }
    if (!fam.dir) throw new Error(`storage family "${name}" has no single path; it cannot be written in a transaction`);
    const ok = typeof id === 'string' && id && id !== '.' && id !== '..' && !/[\\/:\0]/.test(id);
    if (!ok) throw new Error(`storage family "${name}" is a folder: a write needs the id of one file in it, not ${JSON.stringify(id)}`);
    return path.join(pathOf(name), id);
  }

  const rel = (p) => {
    const r = path.relative(folder, p);
    return r && !r.startsWith('..') ? r.replace(/\\/g, '/') : p;
  };

  /** Moves a target of a journal into place: a tmp file over its target, or a removed file into the journal folder. */
  function applyTarget(t) {
    if (t.op === 'remove') SF.renameWithRetry(t.path, t.trash, { fs: f });
    else SF.renameWithRetry(t.tmp, t.path, { fs: f });
  }

  /** Removes a file and ignores a failure (left for doctor's orphan row and the sweep). */
  function drop(p) {
    try {
      f.rmSync(p, { force: true });
    } catch {
      /* left for doctor's orphan row and ravenseat store sweep --tmp */
    }
  }

  /**
   * What a journal left behind needs, without changing anything. Per target, from the hash of what is on disk now:
   *   done      the new content is in place
   *   ready     the target still holds its content from BEFORE the commit, and its tmp file the new content: the
   *             rename can be made. Only then: a rename never goes over content the journal does not know (fix round
   *             jrn-r1, H1; before, a tmp file with the new content was enough, so a later write was written over)
   *   lost      the target still holds its content from before, and the tmp file is gone: it cannot be finished
   *   later     neither before nor after, and the tmp file is gone (for a removal: its copy is in the journal folder):
   *             this commit's content landed and a later write replaced it. Counts as done, never put back
   *   changed   neither before nor after, and the tmp file still waits: a later write came BEFORE this commit's rename
   *   plan done      every target is done or later: only the journal is left to remove
   *   plan forward   no target is lost or changed: the ready ones are renamed (roll forward), in the commit's order
   *   plan back      a target is lost, and every done target can be put back from its .prev (the hash matches)
   *   plan failed    a target is changed (the journal never writes over it, and does not finish the others without
   *                  it: they may depend on it, such as the queue on its archive), or a target is lost and some done
   *                  target cannot be put back. The reason names it; nothing is touched and the journal is kept
   */
  function analyse(file) {
    let j;
    try {
      j = JSON.parse(String(f.readFileSync(file, 'utf8')));
      if (!j || !Array.isArray(j.targets) || !Array.isArray(j.families)) throw new Error('no targets');
    } catch (e) {
      return { id: path.basename(file, '.json'), file, families: [], targets: [], plan: 'failed', reason: `the journal cannot be read (${e?.code ?? e?.message ?? e})` };
    }
    // Marked failed by an earlier recovery (fix round jrn-r2, L2): it stays failed, and nothing is hashed again. A target
    // put back to its bytes from before (a snapshot restore) never turns it back into a roll forward over that restore.
    if (j.failed)
      return {
        id: j.id ?? path.basename(file, '.json'), file, at: j.at ?? null, pid: j.pid ?? null, families: j.families, targets: j.targets, states: [],
        plan: 'failed', marked: true, failedAt: j.failed.at ?? null, reason: String(j.failed.reason ?? 'marked failed'),
      };
    const states = j.targets.map((t) => {
      const cur = hashFile(t.path);
      if (t.op === 'remove') {
        if (cur === null) return 'done';
        if (cur === t.before) return 'ready';
        return t.trash && hashFile(t.trash) === t.before ? 'later' : 'changed';
      }
      if (cur === t.after) return 'done';
      const waiting = !!t.tmp && hashFile(t.tmp) === t.after;
      if (cur === t.before) return waiting ? 'ready' : 'lost';
      return waiting ? 'changed' : 'later';
    });
    const out = { id: j.id ?? path.basename(file, '.json'), file, at: j.at ?? null, pid: j.pid ?? null, families: j.families, targets: j.targets, states };
    const changed = j.targets.filter((_, i) => states[i] === 'changed');
    if (changed.length) {
      const what = changed.map((t) =>
        t.op === 'remove'
          ? `${rel(t.path)} was changed by a later write before this commit removed it`
          : `${rel(t.path)} was changed by a later write before this commit's rename (its new content waits in ${rel(t.tmp)})`,
      );
      return { ...out, plan: 'failed', reason: `${what.join('; ')}: the journal never writes over it, and finishes nothing without it` };
    }
    if (!states.includes('lost')) return { ...out, plan: states.includes('ready') ? 'forward' : 'done' };
    const problems = [];
    j.targets.forEach((t, i) => {
      if (states[i] === 'later') problems.push(`${rel(t.path)} was changed by a later write`);
      if (states[i] !== 'done') return;
      if (t.op === 'remove') {
        if (hashFile(t.trash) !== t.before) problems.push(`${rel(t.path)} was removed and its copy is gone`);
      } else if (t.before === null) problems.push(`${rel(t.path)} had no file before and is not removed by a recovery`);
      else if (hashFile(SF.prevPath(t.path)) !== t.before) problems.push(`${rel(t.path)} has no .prev copy of its state before`);
    });
    const lost = j.targets.filter((_, i) => states[i] === 'lost').map((t) => rel(t.path));
    return problems.length
      ? { ...out, plan: 'failed', reason: `the tmp file of ${lost.join(', ')} is gone and ${problems.join('; ')}` }
      : { ...out, plan: 'back', reason: `the tmp file of ${lost.join(', ')} is gone` };
  }

  /** Carries out what analyse says for one journal (the caller holds the locks of its families). Never throws. */
  function recoverFile(file) {
    let a;
    try {
      a = analyse(file);
      if (a.plan === 'failed') {
        if (!a.marked) markFailed(file, a.reason);
        return { ...a, outcome: 'failed' };
      }
      if (a.plan === 'forward') a.targets.forEach((t, i) => a.states[i] === 'ready' && applyTarget(t));
      if (a.plan === 'back')
        a.targets.forEach((t, i) => {
          if (a.states[i] !== 'done') return;
          if (t.op === 'remove') SF.renameWithRetry(t.trash, t.path, { fs: f });
          else FB.writeText(t.path, f.readFileSync(SF.prevPath(t.path)), { fs: f, pid });
        });
      // Done: the tmp files and removed copies that are left go, and the journal last.
      for (const t of a.targets) {
        if (t.tmp) drop(t.tmp);
        if (t.trash) drop(t.trash);
      }
      f.rmSync(file, { force: true });
      return { ...a, outcome: a.plan };
    } catch (e) {
      return { ...(a ?? { id: path.basename(file, '.json'), file, families: [] }), outcome: 'failed', reason: `the recovery stopped: ${e?.code ?? e?.message ?? e}` };
    }
  }

  /**
   * Marks a journal its recovery cannot finish (plan failed) as failed, in its own file: { failed: { reason, at } } (fix
   * round jrn-r2, L2). From then on a recovery skips it without hashing its targets (queue.json is about 12 MB) and
   * without a warning at every lock take; doctor shows it, doctor --fix leaves it, and the owner sets it aside with
   * `ravenseat store journal drop <id>` (dropJournal). Only a plan analyse found failed is marked: a recovery that
   * stopped on an error (a rename Windows refused) is tried again. A journal that cannot be read is never rewritten.
   */
  function markFailed(file, reason) {
    try {
      const j = JSON.parse(String(f.readFileSync(file, 'utf8')));
      if (!j || typeof j !== 'object' || j.failed) return;
      j.failed = { reason, at: new Date(now()).toISOString() };
      FB.writeText(file, `${JSON.stringify(j, null, 2)}\n`, { fs: f, pid, json: true });
    } catch {
      /* left unmarked: the next recovery works it out again */
    }
  }

  /** The journals in the data folder (file names <txid>.json), oldest first. */
  function journalFiles() {
    try {
      return f
        .readdirSync(journalDir)
        .filter((n) => n.endsWith('.json'))
        .sort()
        .map((n) => path.join(journalDir, n));
    } catch {
      return [];
    }
  }

  /** Every journal left behind with what a recovery would do (read-only: doctor's row). */
  function journals() {
    return journalFiles().map((file) => {
      try {
        const { targets: _t, states: _s, ...a } = analyse(file);
        return a;
      } catch (e) {
        return { id: path.basename(file, '.json'), file, families: [], plan: 'failed', reason: e?.code ?? e?.message ?? String(e) };
      }
    });
  }

  const kindsOf = (names) => FAM.LOCK_ORDER.filter((k) => names.some((n) => (FAM.all().find((x) => x.name === n)?.lock ?? 'store') === k));

  /** Runs fn under the locks of these kinds, taken in LOCK_ORDER. */
  function underLocks(kinds, fn) {
    const take = (i) => (i >= kinds.length ? fn() : withLockOf(kinds[i], () => take(i + 1)));
    return take(0);
  }

  /** One line per result for stderr; failed ones name the way on. */
  function sayRecovered(results) {
    for (const r of results) {
      const what = `journal ${r.id} (${(r.families ?? []).join(', ')})`;
      if (r.outcome === 'forward' || r.outcome === 'done')
        console.error(`NOTE: finished a store commit that stopped part way: ${what}.`);
      else if (r.outcome === 'back') console.error(`NOTE: put back the state before a store commit that stopped part way (${r.reason}): ${what}.`);
      else
        console.error(
          `WARNING: a store commit that stopped part way could not be finished (${r.reason}): ${what}. The journal is kept ` +
            `at ${r.file}; ravenseat doctor shows it, and the owner decides.`,
        );
    }
  }

  /**
   * Recovers the journals left behind (all, or those that share a family with `families`), under the locks of their
   * families. Returns { results: [{ id, file, families, outcome: forward|back|done|failed, reason? }] }. Never throws for
   * a journal: a failed one is kept, with its reason, and marked failed (markFailed): later recoveries skip it.
   */
  function recover(families = null) {
    const results = [];
    for (const file of journalFiles()) {
      let fams = [];
      let marked = false;
      try {
        const j = JSON.parse(String(f.readFileSync(file, 'utf8')));
        fams = j.families ?? [];
        marked = !!j.failed;
      } catch {
        fams = [];
      }
      if (marked) continue; // failed for good (markFailed): only doctor shows it, nothing tries it again
      if (families && !fams.some((n) => families.includes(n))) continue;
      try {
        results.push(underLocks(kindsOf(fams.length ? fams : ['queue']), () => recoverFile(file)));
      } catch (e) {
        results.push({ id: path.basename(file, '.json'), file, families: fams, outcome: 'failed', reason: e?.message ?? String(e) });
      }
    }
    return { results };
  }

  /**
   * transaction(families, fn, { snapshots, pending }): writes several families as one unit. Takes the families' locks
   * in LOCK_ORDER, finishes a journal left behind on them first or refuses (settlePending: journalRecover report, or
   * pending 'refuse', refuses with ESTOREJOURNAL before fn runs), runs fn(tx), and commits what fn staged in the
   * register's commit order (commitFirst families first). fn MUST BE PURE: it may only read through tx and stage writes, because a database backend may
   * run it again; a throw inside it writes nothing. Returns what fn returns.
   *   tx.get(fam, id?)            the value (a staged one first), with the family's empty value and onCorrupt rule
   *   tx.text(fam, id?)           the text, or null when missing
   *   tx.put(fam, id?, value)     stages a write; a string is written as it is, anything else as JSON
   *   tx.update(fam, id?, fn)     put(fn(get))
   *   tx.remove(fam, id?)         stages a removal (the file moves into the journal folder until the commit is done)
   *   tx.append(fam, id?, text)   stages text added at the end (refused for a family a hook appends to without a lock)
   * id: the file in a folder family (handover-archive '2026-11.md'); a single-file family takes none.
   * snapshots: { <family>: tiers } for a family with backup 'tiers' (the queue's rolling copies).
   */
  function transaction(families, fn, o = {}) {
    const fams = [...new Set(families)].sort();
    for (const n of fams) FAM.family(n);
    if (typeof fn !== 'function') throw new Error('transaction needs a function');
    return underLocks(kindsOf(fams), () => {
      settlePending(fams, o);
      const staged = new Map();
      const tx = stager(fams, staged);
      const out = fn(tx);
      commit(fams, staged, o);
      return out;
    });
  }

  /**
   * A journal left behind on these families, before a transaction writes them (fix round jrn-r1, M1): it is finished
   * first (journalRecover auto), or the transaction REFUSES. It never writes past a journal that can still be finished:
   * that write would read the half state, and the journal's renames could later land over it, or find their targets
   * changed and stop for good (a task the commit archived then in neither file). Only a journal whose recovery can no
   * longer finish anything (plan failed: kept for the owner) lets the write go on, with a warning.
   *   o.pending 'refuse': never recover here, only refuse. For a caller that computed its writes from reads made before
   *   the transaction (cli/context.mjs write: it recovers right after it takes the queue lock, before it reads), so a
   *   recovery in between would be written over with content computed from the half state.
   */
  function settlePending(fams, o) {
    if (!journalFiles().length) return;
    const on = () => journals().filter((j) => j.families.some((n) => fams.includes(n)));
    let pending = on();
    if (!pending.length) return;
    const recoverHere = recoverMode === 'auto' && o.pending !== 'refuse';
    if (recoverHere) {
      sayRecovered(recover(fams).results);
      pending = on();
    }
    // A failed one not marked yet (report, or pending 'refuse': no recovery ran here) is marked now and said once;
    // a marked one is doctor's alone (fix round jrn-r2, L2).
    for (const j of pending.filter((x) => x.plan === 'failed' && !x.marked)) {
      markFailed(j.file, j.reason);
      console.error(`WARNING: journal ${j.id} (${j.families.join(', ')}) is left by a store commit that stopped part way and cannot be finished (${j.reason}); ravenseat doctor shows it.`);
    }
    const open = pending.filter((j) => j.plan !== 'failed' && j.plan !== 'done');
    if (!open.length) return;
    const why =
      recoverMode === 'report'
        ? 'store.journalRecover is report, so it is not finished now'
        : 'its recovery did not get through yet';
    const list = open.map((j) => `journal ${j.id} (${j.families.join(', ')})`).join(', ');
    throw Object.assign(
      new Error(
        `${list} is left by a store commit that stopped part way, and ${why}. Nothing is written: this write would go ` +
          'past it. Run ravenseat doctor --fix to finish it (ravenseat doctor shows what it does), then run the command again.',
      ),
      { code: 'ESTOREJOURNAL' },
    );
  }

  /** The tx object of one transaction: reads see the staged writes, writes only stage. */
  function stager(fams, staged) {
    const mine = (name) => {
      if (!fams.includes(name)) throw new Error(`storage family "${name}" is not in this transaction (${fams.join(', ')})`);
      return FAM.family(name);
    };
    // (fam, id?, rest...): a folder family's first argument after the name is the id.
    const split = (name, args) => (mine(name).file ? [undefined, args] : [args[0], args.slice(1)]);
    const text = (name, id) => {
      const p = targetOf(name, id);
      const s = staged.get(p);
      if (s) return s.op === 'remove' ? null : s.text;
      return textOf(p);
    };
    const get = (name, id) => {
      const fam = mine(name);
      const p = targetOf(name, id);
      const s = staged.get(p);
      if (!s) return fam.file ? readJson(name) : FB.readJson(p, { onCorrupt: fam.onCorrupt === 'fail' ? 'fail' : 'empty', fallback: null, fs: f });
      if (s.op === 'remove') return fam.empty === undefined ? null : JSON.parse(JSON.stringify(fam.empty));
      return JSON.parse(s.text);
    };
    const put = (name, id, value) => {
      const p = targetOf(name, id);
      staged.set(p, { family: name, path: p, op: 'put', text: typeof value === 'string' ? value : FB.jsonText(value) });
    };
    return {
      get: (name, id) => get(name, split(name, [id])[0]),
      text: (name, id) => text(name, split(name, [id])[0]),
      put: (name, ...args) => {
        const [id, [value]] = split(name, args);
        put(name, id, value);
      },
      update: (name, ...args) => {
        const [id, [fn]] = split(name, args);
        const next = fn(get(name, id));
        if (next !== undefined) put(name, id, next);
        return next;
      },
      remove: (name, id) => {
        mine(name);
        const p = targetOf(name, id);
        staged.set(p, { family: name, path: p, op: 'remove' });
      },
      append: (name, ...args) => {
        const fam = mine(name);
        if (fam.writers.includes('hook'))
          throw new Error(`storage family "${name}" is appended to by a hook without a lock; it cannot be appended in a transaction`);
        const [id, [add]] = split(name, args);
        put(name, id, `${text(name, id) ?? ''}${String(add)}`);
      },
    };
  }

  /**
   * The commit: every new content to a unique tmp file, the .prev copies and snapshot tiers as for a single write, the
   * journal (families, targets, tmp paths, the hash of each target before and after), then the renames, then the
   * journal is removed. A failure before the journal is written removes the tmp files and changes nothing; a failure
   * after it leaves the journal for the recovery (tried once at once).
   */
  function commit(fams, staged, o) {
    if (!staged.size) return;
    const txid = `${now()}-${pid}-${crypto.randomBytes(4).toString('hex')}`;
    const file = path.join(journalDir, `${txid}.json`);
    // The commit order: the families marked commitFirst in the register (an archive, the owner log) before the rest,
    // then by family name and path. The journal keeps this order, and a recovery renames in it too.
    const rank = (s) => (FAM.family(s.family).commitFirst ? 0 : 1);
    const list = [...staged.values()].sort((x, y) => rank(x) - rank(y) || x.family.localeCompare(y.family) || x.path.localeCompare(y.path));
    const targets = [];
    // Each target is read once (fix round jrn-r1, L1): its hash before and its .prev copy come from the same bytes, so
    // a queue write reads queue.json (about 12 MB) once here, not twice. Kept out of the journal, dropped after use.
    const bytesOf = new Map();
    try {
      for (const s of list) {
        const cur = bytesAt(s.path);
        const before = cur === null ? null : sha(cur);
        if (cur !== null) bytesOf.set(s.path, cur);
        if (s.op === 'remove') {
          if (before !== null) targets.push({ family: s.family, path: s.path, op: 'remove', before, after: null, trash: path.join(journalDir, `${txid}.${targets.length}.removed`) });
          continue;
        }
        const after = sha(Buffer.from(s.text, 'utf8'));
        if (after === before) continue; // nothing changes
        f.mkdirSync(path.dirname(s.path), { recursive: true });
        const t = { family: s.family, path: s.path, op: 'put', tmp: FB.tmpName(s.path, pid), before, after };
        targets.push(t);
        f.writeFileSync(t.tmp, s.text);
      }
      if (!targets.length) return;
      for (const t of targets) {
        if (t.op !== 'put' || t.before === null) continue;
        const backup = FAM.family(t.family).backup;
        if (backup === 'prev' || backup === 'tiers') FB.keepPrevious(t.path, { fs: f, pid, bytes: bytesOf.get(t.path) });
        bytesOf.delete(t.path);
        const tiers = o.snapshots?.[t.family];
        if (backup === 'tiers' && Array.isArray(tiers) && tiers.length) require('../stateSnapshots.js').roll(t.path, tiers, { fs: f });
      }
      f.mkdirSync(journalDir, { recursive: true });
      const journal = { version: 1, id: txid, at: new Date(now()).toISOString(), pid, families: fams, targets };
      FB.writeText(file, `${JSON.stringify(journal, null, 2)}\n`, { fs: f, pid, json: true });
    } catch (e) {
      for (const t of targets) if (t.tmp) drop(t.tmp);
      throw e;
    }
    try {
      for (const t of targets) applyTarget(t);
    } catch (e) {
      const r = recoverFile(file);
      if (r.outcome !== 'forward' && r.outcome !== 'done') {
        e.message = `${e.message} (a store commit of ${fams.join(', ')} stopped part way; the journal ${file} is kept for the recovery, and ravenseat doctor shows it)`;
        throw e;
      }
      return;
    }
    for (const t of targets) if (t.op === 'put' && /\.json$/.test(t.path)) FB.markGood(t.path, f);
    try {
      f.rmSync(file, { force: true });
    } catch (e) {
      // Every target is in place: the commit is complete. The journal left behind reads as done to the next recovery.
      console.error(`WARNING: a store commit is complete, but its journal ${file} could not be removed (${e?.code ?? e?.message ?? e}); the next recovery removes it.`);
      return;
    }
    for (const t of targets) if (t.trash) drop(t.trash);
  }

  /** Is a tmp file left by a crashed write? (pid not running and old enough) */
  const ownPid = pid;
  function orphaned(name, mtimeMs) {
    const pid = FAM.tmpPid(name);
    if (pid == null) return false;
    if (pid === ownPid) return false;
    if (now() - mtimeMs < ORPHAN_AGE_MS) return false;
    return !pidAlive(pid);
  }

  function scan() {
    const unknown = [];
    const orphanTmp = [];
    let top = [];
    try {
      top = f.readdirSync(folder, { withFileTypes: true });
    } catch {
      return { unknown, orphanTmp };
    }
    const inJournal = new Set();
    for (const file of journalFiles())
      try {
        for (const t of JSON.parse(String(f.readFileSync(file, 'utf8'))).targets ?? []) if (t?.tmp) inJournal.add(path.resolve(t.tmp));
      } catch {
        /* an unreadable journal is doctor's own row */
      }
    const walk = (dir, rel, depth) => {
      let list;
      try {
        list = f.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of list) {
        const abs = path.join(dir, e.name);
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          // The lock folders hold tokens, not data; demo/ is a data folder of its own (its own scan).
          // .journal/failed/ holds what the owner set aside (dropJournal): kept as it is, never an orphan to sweep.
          const setAside = depth === 1 && rel === JOURNAL_DIR && e.name === FAILED_DIR;
          if (depth < SCAN_DEPTH && !setAside && !(depth === 0 && (e.name === LOCK_DIR || e.name === '.lockState' || e.name === 'demo'))) walk(abs, r, depth + 1);
          continue;
        }
        if (!FAM.isTmpName(e.name)) continue;
        // A tmp file a journal names is a commit's new content, waiting for its recovery: never an orphan to sweep.
        if (inJournal.has(path.resolve(abs))) continue;
        try {
          const s = f.statSync(abs);
          if (orphaned(e.name, s.mtimeMs)) orphanTmp.push({ path: abs, rel: r, ageMs: now() - s.mtimeMs, size: s.size });
        } catch {
          /* gone meanwhile */
        }
      }
    };
    for (const e of top) {
      if (FAM.isTmpName(e.name)) continue;
      if (!FAM.classify(e.name, e.isDirectory())) unknown.push({ name: e.name, dir: e.isDirectory() });
    }
    walk(folder, '', 0);
    unknown.sort((x, y) => x.name.localeCompare(y.name));
    orphanTmp.sort((x, y) => x.rel.localeCompare(y.rel));
    return { unknown, orphanTmp };
  }

  function sweepTmp({ dry = true } = {}) {
    const listed = scan().orphanTmp;
    if (dry) return { listed, removed: [], failed: [] };
    const removed = [];
    const failed = [];
    for (const t of listed) {
      try {
        // Asked again right before the removal: a tmp file that became a live write's is never touched.
        const s = f.statSync(t.path);
        if (!orphaned(path.basename(t.path), s.mtimeMs)) continue;
        f.rmSync(t.path, { force: true });
        removed.push(t);
      } catch (e) {
        failed.push({ ...t, error: e?.message ?? String(e) });
      }
    }
    return { listed, removed, failed };
  }

  /**
   * Refuses (ESTOREJOURNAL, the transaction's own message) when a journal on these families is still open, and never
   * recovers. For a caller that holds their lock and is about to run its own work (cli/context.mjs withLock, right
   * after its recovery at the lock; fix round jrn-r2, L1): the stop then comes before that work, not at its write.
   */
  const refuseOpen = (families) => settlePending([...new Set(families)].sort(), { pending: 'refuse' });

  /**
   * `ravenseat store journal drop <id>` (fix round jrn-r2, L2): sets a FAILED journal aside, on the owner's command,
   * under the locks of its families. The journal, the tmp files it names (the new content that never landed) and its
   * removed copies move to <dataFolder>/.journal/failed/: nothing is deleted, and nothing there is recovered or swept.
   * A journal a recovery can still finish is refused (doctor --fix finishes it). Returns { ok, moved, error? }.
   */
  function dropJournal(id) {
    const file = journalFiles().find((p) => path.basename(p, '.json') === String(id));
    if (!file) return { ok: false, moved: [], error: `no store journal ${id} in ${journalDir}` };
    let fams = [];
    try {
      fams = JSON.parse(String(f.readFileSync(file, 'utf8'))).families ?? [];
    } catch {
      fams = [];
    }
    return underLocks(kindsOf(fams.length ? fams : ['queue']), () => {
      const a = analyse(file);
      if (a.plan !== 'failed')
        return { ok: false, moved: [], error: `store journal ${id} can still be finished (${a.plan}): ravenseat doctor --fix finishes it; only a failed journal is set aside` };
      const failedDir = path.join(journalDir, FAILED_DIR);
      f.mkdirSync(failedDir, { recursive: true });
      const moved = [];
      const move = (p) => {
        const to = path.join(failedDir, path.basename(p));
        SF.renameWithRetry(p, to, { fs: f });
        moved.push(rel(to));
      };
      for (const t of a.targets ?? []) for (const p of [t.tmp, t.trash]) if (p && bytesAt(p) !== null) move(p);
      move(file);
      return { ok: true, moved };
    });
  }

  return { folder, tree, path: pathOf, readJson, writeJson, update, withLock, nextId, scan, sweepTmp, transaction, recover, journals, refuseOpen, dropJournal };
}

/** "3.2 MB", "12 KB", "512 B". */
function sizeText(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** "3 h", "2 d", "15 min". */
function ageText(ms) {
  const min = Math.round(ms / 60_000);
  if (min < 120) return `${min} min`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} d`;
}

module.exports = { openStore, sizeText, ageText, LOCK_DIR, LOCK_DIRS, JOURNAL_DIR, ORPHAN_AGE_MS, families: FAM, fileBackend: FB };
