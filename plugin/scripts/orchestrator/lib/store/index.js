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

const fs = require('node:fs');
const path = require('node:path');

const FAM = require('./families.js');
const FB = require('./fileBackend.js');
const QL = require('../queueLock.js');

const LOCK_DIR = '.storeLock';
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
 */
function openStore({ folder, tree = null, lockWaitMs, now, pidAlive, io = null } = {}) {
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

  function withLock(fn) {
    const h = holds.get(lockDir);
    if (h) {
      h.depth++;
      try {
        return fn();
      } finally {
        h.depth--;
      }
    }
    f.mkdirSync(folder, { recursive: true });
    const got = LK.acquire(lockDir, { waitMs });
    if (!got.ok)
      throw new Error(QL.heldMessage({ folder: `${folder} (the store lock, ${LOCK_DIR})`, ravenseat: 'ravenseat', ...got }));
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
          if (depth < SCAN_DEPTH && !(depth === 0 && (e.name === LOCK_DIR || e.name === '.lockState' || e.name === 'demo'))) walk(abs, r, depth + 1);
          continue;
        }
        if (!FAM.isTmpName(e.name)) continue;
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

  return { folder, tree, path: pathOf, readJson, writeJson, update, withLock, nextId, scan, sweepTmp };
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

module.exports = { openStore, sizeText, ageText, LOCK_DIR, ORPHAN_AGE_MS, families: FAM, fileBackend: FB };
