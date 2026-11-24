// =============================================================
// lib/store/memoryBackend.js: the in-memory backend of the storage layer (LAGRING step 4,
// plans/lagring-gjennomgang-2026-11-24.md "Backends": MemoryBackend = virtual clock, injectable failures, deterministic
// scheduler, so races are tested exactly; one contract suite runs on both backends).
//
// WHAT IT IS: a small synchronous file system in memory with the calls the storage layer makes (read, write with the
// `wx` flag, append, rename, rm, rmdir, mkdir, stat, readdir, exists, and the fd calls a tail read uses). The Store,
// FileBackend, lib/stateFile.js and lib/queueLock.js run on it unchanged, through their `fs` option: the memory backend
// tests the real write path and the real lock rule, not a copy of them.
//
//   const mem = createMemory({ now: 1_700_000_000_000 })
//   const st = openStore({ folder: '/data', io: mem.io(pid) })   one "process" per pid; mem.spawn() gives a live pid
//   mem.advance(ms) / mem.now()                                  the virtual clock (file mtimes, lock ages, waits)
//   mem.kill(pid)                                                that process is gone (its locks can be taken over)
//   mem.fault({ op, match, code, times })                        the next matching op throws (ENOSPC, EPERM, ...)
//   mem.before({ op, match, times }, fn)                         runs fn right before a matching op: the deterministic
//                                                                scheduler. A race test puts the other "process"'s whole
//                                                                operation exactly between two steps of the first one.
//   mem.files() / mem.text(p)                                    what is stored (for assertions)
//
// ops: read, write, append, rename, rm, rmdir, mkdir, stat, readdir. `match` is a RegExp or a function on the path (for
// rename: the source path). A fault or a hook with times (default 1) is used up after that many matches.
//
// LIMITS, on purpose: paths are resolved with path.resolve, so '/data' is a drive path on Windows (never touched: nothing
// is written to disk). No permissions, no symlinks, no file handles that outlive a call. Waiting (queueLock's poll)
// advances the virtual clock instead of sleeping, so a test with a held lock ends at once.
//
// Used by: lib/__tests__/storeContract.test.ts. Never by the CLI.
// =============================================================
'use strict';

const path = require('node:path');

/** A Node-style error with a code. */
function fsError(code, op, p) {
  const e = new Error(`${code}: ${op} '${p}' (memory backend)`);
  e.code = code;
  e.syscall = op;
  e.path = p;
  return e;
}

/**
 * A new in-memory store world.
 * @param {{ now?: number, hostname?: string }} [o]
 */
function createMemory({ now: start = Date.UTC(2026, 10, 24, 12), hostname = 'memory-host' } = {}) {
  let clock = start;
  /** path -> { data: Buffer, mtimeMs } */
  const files = new Map();
  /** path -> { mtimeMs } */
  const dirs = new Map();
  const alive = new Set();
  let nextPid = 1000;
  const faults = [];
  const hooks = [];

  const norm = (p) => path.resolve(String(p));
  const parentOf = (p) => path.dirname(p);
  const touchDir = (p) => {
    const d = dirs.get(p);
    if (d) d.mtimeMs = clock;
  };
  const matches = (m, p) => (m == null ? true : m instanceof RegExp ? m.test(p.replace(/\\/g, '/')) : !!m(p));

  /** Runs the hooks and faults for an op before it happens. */
  function gate(op, p) {
    for (const h of hooks) {
      if (h.times > 0 && h.op === op && matches(h.match, p)) {
        h.times--;
        h.fn(p);
      }
    }
    for (const f of faults) {
      if (f.times > 0 && f.op === op && matches(f.match, p)) {
        f.times--;
        throw fsError(f.code, op, p);
      }
    }
  }

  function ensureParent(p, op) {
    const parent = parentOf(p);
    if (parent !== p && !dirs.has(parent)) throw fsError('ENOENT', op, p);
  }

  // The root of every drive exists.
  const rootOf = (p) => path.parse(p).root;

  function mkdirP(p) {
    const chain = [];
    let cur = p;
    while (!dirs.has(cur) && cur !== rootOf(cur)) {
      if (files.has(cur)) throw fsError('ENOTDIR', 'mkdir', cur);
      chain.push(cur);
      cur = parentOf(cur);
    }
    if (!dirs.has(cur)) dirs.set(cur, { mtimeMs: clock });
    for (const d of chain.reverse()) {
      dirs.set(d, { mtimeMs: clock });
      touchDir(parentOf(d));
    }
  }

  const children = (p) => {
    const out = new Map();
    const prefix = p.endsWith(path.sep) ? p : p + path.sep;
    for (const k of [...files.keys(), ...dirs.keys()]) {
      if (k === p || !k.startsWith(prefix)) continue;
      const rest = k.slice(prefix.length);
      if (!rest || rest.includes(path.sep)) continue;
      out.set(rest, dirs.has(k) ? 'dir' : 'file');
    }
    return out;
  };

  const statObj = (isDir, mtimeMs, size) => ({
    mtimeMs,
    mtime: new Date(mtimeMs),
    size,
    isDirectory: () => isDir,
    isFile: () => !isDir,
  });

  const toBuf = (data, enc) => (Buffer.isBuffer(data) ? Buffer.from(data) : Buffer.from(String(data), typeof enc === 'string' ? enc : 'utf8'));
  const encOf = (o) => (typeof o === 'string' ? o : o?.encoding ?? null);

  // fd table for openSync/readSync/fstatSync/closeSync (a tail read of a log)
  const fds = new Map();
  let nextFd = 3;

  const fs = {
    readFileSync(p0, o) {
      const p = norm(p0);
      gate('read', p);
      const f = files.get(p);
      if (!f) throw fsError(dirs.has(p) ? 'EISDIR' : 'ENOENT', 'open', p);
      const enc = encOf(o);
      return enc ? f.data.toString(enc) : Buffer.from(f.data);
    },
    writeFileSync(p0, data, o) {
      const p = norm(p0);
      gate('write', p);
      ensureParent(p, 'open');
      if (dirs.has(p)) throw fsError('EISDIR', 'open', p);
      const flag = typeof o === 'object' && o ? o.flag : undefined;
      if (flag === 'wx' && files.has(p)) throw fsError('EEXIST', 'open', p);
      const isNew = !files.has(p);
      files.set(p, { data: toBuf(data, encOf(o)), mtimeMs: clock });
      if (isNew) touchDir(parentOf(p));
    },
    appendFileSync(p0, data, o) {
      const p = norm(p0);
      gate('append', p);
      ensureParent(p, 'open');
      const f = files.get(p);
      const add = toBuf(data, encOf(o));
      if (f) {
        f.data = Buffer.concat([f.data, add]);
        f.mtimeMs = clock;
      } else {
        files.set(p, { data: add, mtimeMs: clock });
        touchDir(parentOf(p));
      }
    },
    renameSync(a0, b0) {
      const a = norm(a0);
      const b = norm(b0);
      gate('rename', a);
      const f = files.get(a);
      if (!f) throw fsError('ENOENT', 'rename', a);
      ensureParent(b, 'rename');
      if (dirs.has(b)) throw fsError('EISDIR', 'rename', b);
      files.delete(a);
      files.set(b, { data: f.data, mtimeMs: f.mtimeMs });
      touchDir(parentOf(a));
      touchDir(parentOf(b));
    },
    copyFileSync(a0, b0) {
      const a = norm(a0);
      const b = norm(b0);
      gate('write', b);
      const f = files.get(a);
      if (!f) throw fsError('ENOENT', 'copyfile', a);
      ensureParent(b, 'copyfile');
      files.set(b, { data: Buffer.from(f.data), mtimeMs: clock });
      touchDir(parentOf(b));
    },
    rmSync(p0, o = {}) {
      const p = norm(p0);
      gate('rm', p);
      if (files.delete(p)) {
        touchDir(parentOf(p));
        return;
      }
      if (dirs.has(p)) {
        if (!o.recursive) throw fsError('ERR_FS_EISDIR', 'rm', p);
        const prefix = p + path.sep;
        for (const k of [...files.keys()]) if (k.startsWith(prefix)) files.delete(k);
        for (const k of [...dirs.keys()]) if (k === p || k.startsWith(prefix)) dirs.delete(k);
        touchDir(parentOf(p));
        return;
      }
      if (!o.force) throw fsError('ENOENT', 'rm', p);
    },
    unlinkSync(p0) {
      fs.rmSync(p0);
    },
    rmdirSync(p0) {
      const p = norm(p0);
      gate('rmdir', p);
      if (!dirs.has(p)) throw fsError(files.has(p) ? 'ENOTDIR' : 'ENOENT', 'rmdir', p);
      if (children(p).size) throw fsError('ENOTEMPTY', 'rmdir', p);
      dirs.delete(p);
      touchDir(parentOf(p));
    },
    mkdirSync(p0, o = {}) {
      const p = norm(p0);
      gate('mkdir', p);
      if (o.recursive) return mkdirP(p);
      if (dirs.has(p) || files.has(p)) throw fsError('EEXIST', 'mkdir', p);
      ensureParent(p, 'mkdir');
      dirs.set(p, { mtimeMs: clock });
      touchDir(parentOf(p));
    },
    statSync(p0) {
      const p = norm(p0);
      gate('stat', p);
      const f = files.get(p);
      if (f) return statObj(false, f.mtimeMs, f.data.length);
      const d = dirs.get(p);
      if (d || p === rootOf(p)) return statObj(true, d?.mtimeMs ?? start, 0);
      throw fsError('ENOENT', 'stat', p);
    },
    existsSync(p0) {
      const p = norm(p0);
      return files.has(p) || dirs.has(p);
    },
    readdirSync(p0, o = {}) {
      const p = norm(p0);
      gate('readdir', p);
      if (!dirs.has(p)) throw fsError(files.has(p) ? 'ENOTDIR' : 'ENOENT', 'scandir', p);
      const list = [...children(p).entries()].sort((x, y) => x[0].localeCompare(y[0]));
      if (!o.withFileTypes) return list.map(([n]) => n);
      return list.map(([name, kind]) => ({ name, isDirectory: () => kind === 'dir', isFile: () => kind === 'file' }));
    },
    openSync(p0, flags = 'r') {
      const p = norm(p0);
      gate('read', p);
      if (!files.has(p)) {
        if (!/[wa]/.test(String(flags))) throw fsError('ENOENT', 'open', p);
        fs.writeFileSync(p, '');
      }
      const fd = nextFd++;
      fds.set(fd, p);
      return fd;
    },
    fstatSync(fd) {
      const p = fds.get(fd);
      if (!p) throw fsError('EBADF', 'fstat', String(fd));
      return fs.statSync(p);
    },
    readSync(fd, buf, offset, length, position) {
      const p = fds.get(fd);
      if (!p) throw fsError('EBADF', 'read', String(fd));
      const data = files.get(p)?.data ?? Buffer.alloc(0);
      const from = position ?? 0;
      const n = Math.max(0, Math.min(length, data.length - from));
      data.copy(buf, offset, from, from + n);
      return n;
    },
    closeSync(fd) {
      fds.delete(fd);
    },
  };

  const world = {
    fs,
    now: () => clock,
    advance(ms) {
      clock += Math.max(0, Number(ms) || 0);
      return clock;
    },
    /** A new live "process". */
    spawn() {
      const pid = nextPid++;
      alive.add(pid);
      return pid;
    },
    kill(pid) {
      alive.delete(pid);
    },
    isAlive: (pid) => alive.has(pid),
    hostname,
    fault({ op, match, code = 'EIO', times = 1 }) {
      faults.push({ op, match, code, times });
    },
    before({ op, match, times = 1 }, fn) {
      hooks.push({ op, match, times, fn });
    },
    /** Every stored file path, sorted (forward slashes, for assertions that read the same on every OS). */
    files: () => [...files.keys()].map((k) => k.replace(/\\/g, '/')).sort(),
    text: (p) => files.get(norm(p))?.data.toString('utf8') ?? null,
    /**
     * The io one simulated process works with: the fs, the clock, its pid and the lock's view of the world. A Store
     * opened with it ({ io }) and lib/queueLock.js (lockOn(io)) never touch the disk, the real clock or real pids.
     */
    io(pid = world.spawn()) {
      alive.add(pid);
      return {
        fs,
        pid,
        now: () => clock,
        sleep: (ms) => {
          clock += Math.max(1, Number(ms) || 0);
        },
        pidAlive: (p) => alive.has(p),
        hostname,
        memory: true,
      };
    },
  };
  return world;
}

module.exports = { createMemory, fsError };
