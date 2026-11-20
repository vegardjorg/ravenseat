// =============================================================
// scripts/orchestrator/lib/silentSnapshot.js: the evidence snapshot when a track turns SILENT (roadmap 0y Y4).
//
// WHY: a SILENT track (queueLogic.silentTracks, measured by lib/trackActivity.js) is usually looked at long after it
// hung, and by then the evidence is gone: what the agent did last, the background job it was waiting on, the process
// that never ended. So the command that first sees the silence (show, state, pulse: cli/tracks.mjs findSilent) writes
// one small local file with:
//   1. the tail of the agent's transcript (the newest rows, one short line each),
//   2. the background jobs the agent started that never reported back (no task notification names them),
//   3. the processes whose command line names the track's worktree or branch, and their child processes.
//
// THE RULES:
//   - Local only: <dataFolder>/silent-snapshots/, gitignored (the data folder is, and the folder gets its own `*`
//     .gitignore too). Nothing is sent anywhere.
//   - Redaction BEFORE writing (redactCommand, redactText): a flag named like a key, token, secret or password loses
//     its value; an env assignment keeps its name and loses its value; a URL loses its user info and query string; an
//     inline script (-e, -c, -Command, --eval, /c) is dropped with everything after it; a long token-like argument is
//     dropped. When unsure, the argument is dropped.
//   - Size-capped (silentSnapshot.maxKB, 64): the oldest transcript rows are left out first.
//   - One file per silence: the name carries the track id and the last sign of life, so the next pulse in the same
//     silence reuses the file (and lists no processes again).
//   - Retention (silentSnapshot.keep, 20): the oldest snapshots beyond that are removed when a new one is written.
//   - It never stops work: every step fails open (a part that cannot be read says so in the file, or no file).
// silentSnapshot.enabled (on) turns it off. The process register and track marker of roadmap 0s (V2, V6) do not exist
// yet; when they do, relevantProcesses can take their pids as seeds instead of matching command lines.
//
// Tested in lib/__tests__/silentSnapshot.test.ts.
// =============================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const R = '[redacted]';
const DEFAULTS = Object.freeze({ enabled: true, keep: 20, maxKB: 64 });
/** The folder under the data folder. */
const FOLDER_NAME = 'silent-snapshots';
/** At most this much of the end of a transcript is read (the tail and the jobs come from it). */
const READ_BYTES = 2 * 1024 * 1024;
const MAX_JOBS = 20;
const MAX_PROCESSES = 40;

// ---- Redaction ----------------------------------------------------------------------------------------------------

/** A name that marks its value as secret (a flag, an env name, a key in free text). */
const SECRET_NAME = /(pass(word|wd)?|pwd|secret|token|api[-_]?key|apikey|access[-_]?key|private[-_]?key|key|auth|credential|cookie|session|signature|bearer)/i;
/** Flags whose value (and everything after it) is a script: dropped whole. */
const SCRIPT_FLAG = /^(-e|-c|--eval|--command|-command|-encodedcommand|-enc|-ec|\/c|\/k)$/i;
const ENV_ASSIGN = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;
const FLAG_VALUE = /^(-{1,2}[A-Za-z0-9][\w.-]*)=(.*)$/s;
const URL_RE = /^([a-z][a-z0-9+.-]*:\/\/)([^@/\s]+@)?([^?\s]*)(\?.*)?$/i;

const unquote = (s) => s.replace(/^(["'])(.*)\1$/s, '$2');

/** A long argument made of token characters with both letters and digits (no path or dot): an id or a secret. */
function tokenLike(s) {
  const v = unquote(s);
  if (v.length < 24 || !/^[A-Za-z0-9_\-+=]+$/.test(v)) return false;
  return (v.match(/\d/g)?.length ?? 0) >= 3 && (v.match(/[A-Za-z]/g)?.length ?? 0) >= 3;
}

/** A URL without user info and query string; null when `s` is no URL. */
function redactUrl(s) {
  const q = /^(["'])(.*)\1$/s.exec(s);
  const m = URL_RE.exec(q ? q[2] : s);
  if (!m) return null;
  const out = `${m[1]}${m[2] ? `${R}@` : ''}${m[3]}${m[4] ? `?${R}` : ''}`;
  return q ? `${q[1]}${out}${q[1]}` : out;
}

/** One value (after `=` or a plain argument): a URL is cleaned, a token-like value dropped, the rest kept. */
function redactValue(v) {
  const u = redactUrl(v);
  if (u != null) return u;
  return tokenLike(v) ? R : v;
}

/**
 * A command line with its secrets removed, argument by argument (the rules at the top of this file). Quotes are kept
 * on what stays. Never throws.
 */
function redactCommand(cmd) {
  const tokens = String(cmd ?? '').match(/(?:[^\s"']+|"[^"]*"?|'[^']*'?)+/g) ?? [];
  const out = [];
  let dropNext = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (dropNext) {
      out.push(R);
      dropNext = false;
      continue;
    }
    if (SCRIPT_FLAG.test(t)) {
      out.push(t);
      if (i < tokens.length - 1) out.push(R);
      break;
    }
    if (/^bearer$/i.test(t)) {
      out.push(t);
      dropNext = true;
      continue;
    }
    const fv = FLAG_VALUE.exec(t);
    if (fv) {
      out.push(`${fv[1]}=${SECRET_NAME.test(fv[1]) ? R : redactValue(fv[2])}`);
      continue;
    }
    if (/^-{1,2}[A-Za-z]/.test(t)) {
      out.push(t);
      if (SECRET_NAME.test(t.replace(/^-+/, ''))) dropNext = true;
      continue;
    }
    const env = ENV_ASSIGN.exec(t);
    if (env) {
      out.push(`${env[1]}=${R}`);
      continue;
    }
    // A quoted argument that carries "name: value" or "name=value" with a secret name (a header, a setting): dropped.
    if (/^["']/.test(t) && new RegExp(`${SECRET_NAME.source}\\s*[:=]`, 'i').test(t)) {
      out.push(R);
      continue;
    }
    out.push(redactValue(t));
  }
  return out.join(' ');
}

/** Free text (a transcript line) with the same kinds of secrets removed. Never throws. */
function redactText(text) {
  return String(text ?? '')
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@"'<>]+@/gi, `$1${R}@`)
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s?#"'<>]+)\?[^\s"'<>)]+/gi, `$1?${R}`)
    .replace(/\b(bearer|basic)\s+[^\s"'<>]+/gi, `$1 ${R}`)
    .replace(
      /\b([\w-]*(?:password|passwd|pwd|secret|token|api[-_]?key|apikey|credential|cookie)[\w-]*)(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&"'<>]+)/gi,
      `$1$2${R}`,
    )
    .replace(/\b(export\s+|set\s+)?([A-Z][A-Z0-9_]{1,})=("[^"]*"|'[^']*'|[^\s"'<>]+)/g, `$1$2=${R}`)
    .replace(/(?<![\w\-+=])(?=[A-Za-z0-9_\-+=]*\d)(?=[A-Za-z0-9_\-+=]*[A-Za-z])[A-Za-z0-9_\-+=]{32,}(?![\w\-+=])/g, R);
}

// ---- The transcript -----------------------------------------------------------------------------------------------

const cut = (s, n) => {
  const x = String(s ?? '').replace(/\s+/g, ' ').trim();
  return x.length > n ? `${x.slice(0, n - 1)}…` : x;
};

/** The client's transcript reader (lib/clients/claude/entries.js): the core never reads the row format itself. */
const entries = () => require('./clients/index.js').clientFor().entries;

/** The transcript rows as the adapter's events; a line that is not JSON (a cut first line) is left out. */
function parseRows(text) {
  const E = entries();
  const rows = [];
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    const raw = E.parse(line);
    if (raw && typeof raw === 'object') rows.push(E.entry(raw));
  }
  return rows;
}

/** The parts of an event: a string content is one text part. */
function partsOf(e) {
  if (e.parts) return e.parts.filter((p) => p && typeof p === 'object');
  return e.text ? [{ kind: 'text', text: e.text }] : [];
}

const resultText = (p) => entries().resultText(p.content);

/** A short, redacted summary of a tool call's input. */
function inputSummary(input) {
  if (!input || typeof input !== 'object') return '';
  if (typeof input.command === 'string') return redactCommand(input.command);
  for (const k of ['file_path', 'path', 'pattern', 'url', 'description', 'prompt'])
    if (typeof input[k] === 'string') return redactText(input[k]);
  try {
    return redactText(JSON.stringify(input));
  } catch {
    return '';
  }
}

const clock = (r) => {
  const t = Date.parse(r?.timestamp ?? '');
  return Number.isFinite(t) ? new Date(t).toISOString().slice(11, 19) : '--:--:--';
};

/**
 * The newest `maxRows` lines of the transcript, one per text, tool call or tool result, each cut to `maxChars` and
 * redacted. Rows that are not JSON are skipped.
 * @returns {string[]}
 */
function transcriptTail(text, { maxRows = 40, maxChars = 240 } = {}) {
  const lines = [];
  for (const e of parseRows(text)) {
    const who = e.kind === 'unknown' ? (e.type ?? 'row') : e.kind;
    for (const p of partsOf(e)) {
      if (p.kind === 'text' && typeof p.text === 'string' && p.text.trim())
        lines.push(`${clock(e)} ${who}: ${cut(redactText(p.text), maxChars)}`);
      else if (p.kind === 'tool') lines.push(`${clock(e)} tool ${p.name ?? '?'} ${cut(inputSummary(p.input), maxChars)}`);
      else if (p.kind === 'result') lines.push(`${clock(e)} result: ${cut(redactText(resultText(p)), maxChars)}`);
    }
  }
  return lines.slice(-maxRows);
}

/** Is this text a background task notification (as lib/clients/claude/entries.js reads one)? */
const isNotification = (t) => /<task-notification>/.test(t) || /^\s*Background command\b/i.test(t);

/**
 * The background jobs the agent started (a tool call with run_in_background) that never reported back: no later task
 * notification names the job id or the tool call id, and no later call stopped it. Newest last, at most MAX_JOBS.
 * @returns {{ id: string, tool: string, time: string|null, command: string }[]}
 */
function openBackgroundJobs(text) {
  const started = new Map(); // tool_use id -> job
  const order = [];
  const heard = [];
  for (const e of parseRows(text)) {
    if (e.notification && e.text) heard.push(e.text);
    for (const p of partsOf(e)) {
      if (p.kind === 'tool') {
        if (p.input?.run_in_background === true && p.id) {
          const job = { id: p.id, use: p.id, tool: String(p.name ?? '?'), time: e.timestamp ?? null, command: cut(inputSummary(p.input), 200) };
          started.set(p.id, job);
          order.push(job);
        } else if (/kill|stop/i.test(String(p.name ?? ''))) {
          try {
            heard.push(JSON.stringify(p.input ?? {}));
          } catch {
            // error-ignored: an input that cannot be read stops nothing
          }
        }
      } else if (p.kind === 'result' && started.has(p.id)) {
        const m = /\b(?:ID|agentId|task id):\s*([A-Za-z0-9_-]+)/i.exec(resultText(p));
        if (m) started.get(p.id).id = m[1];
      } else if (p.kind === 'text' && typeof p.text === 'string' && isNotification(p.text)) heard.push(p.text);
      else if (p.kind === 'result' && isNotification(resultText(p))) heard.push(resultText(p));
    }
  }
  const all = heard.join('\n');
  return order
    .filter((j) => !all.includes(`<task-id>${j.id}</task-id>`) && !all.includes(`<tool-use-id>${j.use}</tool-use-id>`) && !all.includes(j.id))
    .slice(-MAX_JOBS)
    .map(({ id, tool, time, command }) => ({ id, tool, time, command }));
}

// ---- The processes ------------------------------------------------------------------------------------------------

const norm = (s) => String(s ?? '').toLowerCase().replace(/\\/g, '/');

/**
 * The 8.3 short form of a Windows path (C:\Users\RUNNER~1\...), or null. `for %I in (...) do echo %~sI` is the one
 * built-in way to ask for it; the path comes from git, never from a user, and is quoted. Fails open, short timeout.
 */
function shortPathWin(p) {
  try {
    const { spawnSync } = require('node:child_process');
    const r = spawnSync('cmd', ['/d', '/s', '/c', `for %I in ("${String(p).replace(/\//g, '\\')}") do @echo %~sI`], {
      encoding: 'utf8',
      timeout: 3000,
      windowsVerbatimArguments: true,
    });
    const out = String(r.stdout ?? '').trim().split(/\r?\n/)[0];
    return r.status === 0 && out ? out : null;
  } catch {
    return null; // error-ignored: the short form only widens the process filter; the long form still works
  }
}

/**
 * Every form of `p` a command line can use: as given, the resolved long form, and on Windows the 8.3 short form (a CI
 * runner's temp folder is C:\Users\RUNNER~1\... in a command line while git reports C:/Users/runneradmin/...).
 * Duplicates (after norm) are dropped. `short` and `real` are seams for tests.
 */
function pathForms(p, { platform = process.platform, short = shortPathWin, real = (x) => fs.realpathSync.native(x) } = {}) {
  if (!p) return [];
  const out = [p];
  const add = (f) => {
    try {
      const v = f();
      if (v && !out.some((o) => norm(o) === norm(v))) out.push(v);
    } catch {
      // error-ignored: a form that cannot be computed is left out
    }
  };
  add(() => real(p));
  if (platform === 'win32') add(() => short(p));
  return out;
}

/**
 * The long forms of the Windows paths in `cmd` that hold an 8.3 short name (a `~`), joined by spaces, or ''. A command
 * line can mix short and long folder names (C:\Users\RUNNER~1\...\Temp\queue-snap-x\wt-A after mkdtemp under a short
 * TEMP), so no single form of the worktree path matches it as written. Each such path is resolved from its longest
 * existing prefix (the file at the end may not exist), and the rest is kept as written. Fails open per path; only
 * used for matching, never shown.
 */
function expandShortNames(cmd, real = (x) => fs.realpathSync.native(x)) {
  const s = String(cmd ?? '');
  if (!s.includes('~')) return '';
  const out = [];
  for (const m of s.match(/[A-Za-z]:[\\/][^\s"'<>|]*~[^\s"'<>|]*/g) ?? []) {
    const parts = m.split(/[\\/]/);
    for (let n = parts.length; n > 1; n -= 1) {
      try {
        const head = real(parts.slice(0, n).join('\\'));
        out.push([head, ...parts.slice(n)].join('\\'));
        break;
      } catch {
        // error-ignored: this prefix does not exist; try the shorter one
      }
    }
  }
  return out.join(' ');
}

/**
 * The processes whose command line names one of `needles` (the worktree path, the branch; slashes either way, any
 * case, 8.3 short names expanded) and their descendants, in list order, at most `max`, each with its command line
 * redacted. `real` is a seam for tests.
 * @param {{ pid: number, ppid: number, name?: string, cmd?: string }[]} list
 */
function relevantProcesses(list, { needles = [], max = MAX_PROCESSES, self = process.pid, real } = {}) {
  const ns = needles.filter(Boolean).map(norm);
  if (!ns.length) return [];
  const keep = new Set();
  const names = (p) => {
    const hay = norm(p.cmd);
    if (ns.some((n) => hay.includes(n))) return true;
    const long = norm(expandShortNames(p.cmd, real));
    return long !== '' && ns.some((n) => long.includes(n));
  };
  for (const p of list ?? []) if (p?.pid !== self && names(p)) keep.add(p.pid);
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of list ?? [])
      if (!keep.has(p.pid) && keep.has(p.ppid) && p.pid !== self) {
        keep.add(p.pid);
        grew = true;
      }
  }
  return (list ?? [])
    .filter((p) => keep.has(p.pid))
    .slice(0, max)
    .map((p) => ({ pid: p.pid, ppid: p.ppid, name: String(p.name ?? ''), cmd: cut(redactCommand(p.cmd ?? ''), 400) }));
}

/**
 * The machine's processes ({ pid, ppid, name, cmd }), or a note why there are none. QUEUE_SNAPSHOT_PROCESSES names a
 * JSON file with the list instead (tests). Windows: Get-CimInstance Win32_Process; elsewhere `ps`. Fails open.
 * @returns {{ list: object[], note: string|null }}
 */
function listProcesses({ env = process.env, platform = process.platform, timeoutMs = 8000 } = {}) {
  try {
    if (env.QUEUE_SNAPSHOT_PROCESSES) return { list: JSON.parse(fs.readFileSync(env.QUEUE_SNAPSHOT_PROCESSES, 'utf8')), note: null };
    if (platform === 'win32') {
      const out = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress',
        ],
        { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
      );
      const parsed = JSON.parse(out || '[]');
      return {
        list: (Array.isArray(parsed) ? parsed : [parsed]).map((p) => ({
          pid: p.ProcessId,
          ppid: p.ParentProcessId,
          name: p.Name ?? '',
          cmd: p.CommandLine ?? '',
        })),
        note: null,
      };
    }
    const out = execFileSync('ps', ['-eo', 'pid=,ppid=,comm=,args='], {
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const list = [];
    for (const l of out.split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(l);
      if (m) list.push({ pid: Number(m[1]), ppid: Number(m[2]), name: m[3], cmd: m[4] });
    }
    return { list, note: null };
  } catch (e) {
    return { list: [], note: `the process list could not be read (${cut(e?.code ?? e?.name ?? 'error', 40)})` };
  }
}

// ---- The file -----------------------------------------------------------------------------------------------------

/** The settings (silentSnapshot in queue.config.json) with the defaults for a missing or invalid value. */
function settingsFrom(config) {
  const s = config?.silentSnapshot ?? {};
  const keep = Number(s.keep);
  const maxKB = Number(s.maxKB);
  return {
    enabled: s.enabled !== false,
    keep: Number.isInteger(keep) && keep >= 1 ? keep : DEFAULTS.keep,
    maxKB: Number.isFinite(maxKB) && maxKB >= 4 ? maxKB : DEFAULTS.maxKB,
  };
}

const ageText = (ms) => {
  const min = Math.round(ms / 60_000);
  return min < 120 ? `${min} min` : `${Math.round(min / 60)} h`;
};

/**
 * The snapshot as text, at most maxKB: the header, the background jobs, the processes, then as many of the newest
 * transcript rows as fit (the oldest left out first, and a line says how many).
 */
function snapshotText(x, { maxKB = DEFAULTS.maxKB } = {}) {
  const max = Math.floor(maxKB * 1024);
  const head = [
    `Ravenseat evidence snapshot: track ${x.id} is SILENT`,
    `Written ${new Date(x.now ?? Date.now()).toISOString()}; branch ${x.branch ?? '?'}; silent for ${ageText(x.silent_ms ?? 0)} ` +
      `(last sign of life ${x.last_activity ?? '?'})`,
    `Worktree: ${x.worktree ?? '?'}`,
    `Local file, never pushed; secrets, env values and URL credentials were redacted before writing; capped at ${maxKB} KB.`,
    '',
    `## Background jobs that never reported back (${x.jobs?.length ?? 0})`,
    ...(x.jobs?.length ? x.jobs.map((j) => `  ${j.id}  ${j.tool}  started ${j.time ?? '?'}  ${j.command}`) : ['  none']),
    '',
    `## Processes that name the worktree or the branch, with their children (${x.processes?.length ?? 0}, command lines redacted)`,
    ...(x.processNote ? [`  ${x.processNote}`] : []),
    ...(x.processes?.length
      ? x.processes.map((p) => `  ${p.pid} (parent ${p.ppid}) ${p.name}: ${p.cmd}`)
      : x.processNote
        ? []
        : ['  none']),
    '',
    `## Transcript tail${x.agent ? ` (agent ${x.agent})` : ''}`,
  ];
  let text = `${head.join('\n')}\n`;
  const tail = x.tail ?? [];
  if (!tail.length) return `${text}  no transcript found\n`.slice(0, max);
  const reserve = 120; // the "left out" line
  let budget = max - Buffer.byteLength(text, 'utf8') - reserve;
  const kept = [];
  for (let i = tail.length - 1; i >= 0; i--) {
    const b = Buffer.byteLength(tail[i], 'utf8') + 3;
    if (b > budget) break;
    budget -= b;
    kept.unshift(tail[i]);
  }
  if (kept.length < tail.length) text += `  (${tail.length - kept.length} older rows left out to stay under ${maxKB} KB)\n`;
  text += kept.map((l) => `  ${l}`).join('\n') + '\n';
  // A last guard: never over the cap, whatever the header held.
  while (Buffer.byteLength(text, 'utf8') > max) text = text.slice(0, Math.max(0, text.length - 256));
  return text;
}

/** The file for one silence: <id>-<last sign of life>.txt (only safe characters). */
function fileFor(dir, x) {
  const id = String(x.id ?? 'track').replace(/[^A-Za-z0-9_.-]/g, '_');
  const stamp = String(x.last_activity ?? '').replace(/[^0-9TZ]/g, '').slice(0, 16) || 'unknown';
  return path.join(dir, `${id}-${stamp}.txt`);
}

/** Removes the oldest snapshots beyond `keep` (never `except`). Fails open. */
function prune(dir, keep, except) {
  let files;
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.txt'))
      .map((f) => {
        const p = path.join(dir, f);
        return { p, t: fs.statSync(p).mtimeMs };
      });
  } catch {
    return;
  }
  files.sort((a, b) => b.t - a.t || b.p.localeCompare(a.p));
  for (const f of files.slice(keep)) {
    if (f.p === except) continue;
    try {
      fs.rmSync(f.p, { force: true });
    } catch {
      // error-ignored: an old snapshot left behind costs only disk space
    }
  }
}

/**
 * Writes the snapshot for one silence (or returns the file it already has) and prunes to `keep`. The folder gets a
 * `*` .gitignore. Throws on a write error (capture catches it).
 */
function writeSnapshot(dir, x, { keep = DEFAULTS.keep, maxKB = DEFAULTS.maxKB } = {}) {
  const file = fileFor(dir, x);
  if (fs.existsSync(file)) return file;
  fs.mkdirSync(dir, { recursive: true });
  const ignore = path.join(dir, '.gitignore');
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n');
  fs.writeFileSync(file, snapshotText(x, { maxKB }));
  prune(dir, keep, file);
  return file;
}

/** The end of a file (at most `bytes`), from the first whole line. Null when it cannot be read. */
function readEnd(file, bytes = READ_BYTES) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const text = buf.toString('utf8');
    return size > len ? text.slice(text.indexOf('\n') + 1) : text;
  } catch {
    return null;
  } finally {
    if (fd != null) fs.closeSync(fd);
  }
}

/**
 * The I/O for one SILENT track: reuses the file of this silence or writes a new one. Returns its path, or null when it
 * is off or anything failed (it never throws: the silence warning must still print).
 * @param {{ dataFolder: string, hit: { id: string, branch: string, last_activity: string, silent_ms: number },
 *   worktree?: string|null, transcript?: string|null, agent?: string|null, config?: object, now?: number,
 *   processes?: () => { list: object[], note: string|null } }} x
 */
function capture({ dataFolder, hit, worktree = null, transcript = null, agent = null, config = {}, now = Date.now(), processes = listProcesses }) {
  try {
    const s = settingsFrom(config);
    if (!s.enabled || !dataFolder || !hit?.id) return null;
    const dir = path.join(dataFolder, FOLDER_NAME);
    const existing = fileFor(dir, hit);
    if (fs.existsSync(existing)) return existing;
    const text = transcript ? readEnd(transcript) : null;
    const procs = processes();
    return writeSnapshot(
      dir,
      {
        ...hit,
        worktree,
        agent,
        now,
        tail: text ? transcriptTail(text) : [],
        jobs: text ? openBackgroundJobs(text) : [],
        processes: relevantProcesses(procs.list, { needles: [...pathForms(worktree), hit.branch] }),
        processNote: procs.note,
      },
      { keep: s.keep, maxKB: s.maxKB },
    );
  } catch {
    return null; // error-ignored: the snapshot is evidence only; the SILENT warning prints without it
  }
}

module.exports = {
  DEFAULTS,
  FOLDER_NAME,
  pathForms,
  redactCommand,
  redactText,
  transcriptTail,
  openBackgroundJobs,
  relevantProcesses,
  listProcesses,
  settingsFrom,
  snapshotText,
  writeSnapshot,
  capture,
};
