// =============================================================
// demoMode.js: demo mode on the board (owner decision 22.11; docs/board.md "Demo mode").
//
// A first-time user can explore a populated demo board ("Pebble") from an empty board (the offer, lib/demoOffer.js) or
// from Settings > Show demo board. The owner's hard requirement: users WILL click every answer, button and option, so
// the demo must be completely separate and locked down. That is done in three layers, all on the server:
//
//   1. SEPARATE DATA. The demo lives in <dataFolder>/demo/ (gitignored with the data folder): its own queue.json,
//      plans.json, time log, seen mark, settings (queue.config.json) and plan documents, made from the tracked snapshot
//      demo-data/pebble.json. While demo mode is on, queue-board.mjs points its read AND write paths there, and every
//      queue.mjs it runs gets childEnv(): every QUEUE_* path inside the demo folder, its cwd there, git locked out
//      (GIT_DIR names a folder that does not exist, GIT_CEILING_DIRECTORIES stops the search above the demo folder), the
//      update check off and the GitHub and API tokens dropped. Nothing is ever copied from the demo into the real
//      queue, leaving demo mode deletes nothing, and a CLI run in the real repo never reads the demo folder.
//   2. AN ALLOW-LIST. refusal() is asked before every /api/ call while demo mode is on. Only actions that write inside
//      the demo folder through queue.mjs get through (answer, approve, QA ok and deviation, edit, cancel, move, lanes,
//      areas, focus, the seen mark, plan priorities) plus the read views; everything else, also anything new or
//      unknown, is refused with 409 "Not in demo mode: ...". Refused classes: start (pick, release, requeue, track
//      answers, cloud), settings (every write), gates (checks, plan check), project (writes into project files).
//   3. PATH CONFINEMENT. confined() checks every path a demo write uses: it must resolve inside the demo folder, no part
//      on the way may be a symlink or junction, and its real path must be the path walked. checkRoot() refuses a demo
//      folder that is itself a link or holds one, so a planted junction cannot point demo writes at the real queue, and
//      build()/reset() never delete through a link.
//
// The snapshot stores every time as "@rel:<ms>" (scripts/make-demo-snapshot.mjs); build() turns them into dates around
// now, so the demo never looks stale. Entering demo mode always builds a fresh folder; "Reset demo" does the same.
// =============================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SNAPSHOT_FILE = path.join(__dirname, '..', 'demo-data', 'pebble.json');
const OFFER_FILE = 'demo-offer.json';

/** Every path of the demo folder under a data folder. `root` is also the demo project's root and document root. */
function paths(dataFolder) {
  const root = path.join(path.resolve(dataFolder), 'demo');
  const data = path.join(root, 'data');
  return {
    root,
    data,
    queue: path.join(data, 'queue.json'),
    plans: path.join(data, 'plans.json'),
    timeLog: path.join(data, 'times.jsonl'),
    config: path.join(root, 'queue.config.json'),
    marker: path.join(root, 'demo.json'),
    tmp: path.join(root, 'tmp'),
    // Never created: git run with GIT_DIR here fails at once with "not a git repository".
    noGit: path.join(root, '.no-git'),
  };
}

// ---- The offer's stored dismissal (per project, next to seen.json) --------------------------------------------------
/** { dismissed } from <dataFolder>/demo-offer.json; a missing or broken file is not dismissed. */
function readOffer(dataFolder) {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(dataFolder, OFFER_FILE), 'utf8'));
    return { dismissed: v?.dismissed === true };
  } catch {
    return { dismissed: false };
  }
}
/** "Don't show again": writes { dismissed: true, at } (a temporary file and a rename). */
function writeDismissed(dataFolder, { now = Date.now() } = {}) {
  const file = path.join(dataFolder, OFFER_FILE);
  try {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ dismissed: true, at: new Date(now).toISOString() }, null, 2)}\n`);
    fs.renameSync(tmp, file);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.code ?? 'write failed') };
  }
}

// ---- The allow-list ----------------------------------------------------------------------------------------------
/** Read views that only read the (demo) paths. */
const GET_OK = new Set([
  '/api/state', '/api/since', '/api/schedule', '/api/statistics', '/api/plans', '/api/plan-search', '/api/doc',
  '/api/settings', '/api/task', '/api/archive', '/api/follow',
]);
/** Writes that run queue.mjs on the demo folder only (edit, edit-many, rank, project, area, focus, undo, plan edits). */
const POST_OK = new Set([
  '/api/move', '/api/lane', '/api/bulk', '/api/undo', '/api/task-edit', '/api/focus', '/api/area', '/api/seen',
  '/api/plan-prioritize', '/api/plan-bulk', '/api/plan-undo',
]);
/** POST /api/action types that only change the demo queue. */
const ACTION_OK = new Set([
  'resolve', 'approve', 'qa-ok', 'qa-deviation', 'pause', 'continue', 'flag-stuck', 'batch-in', 'batch-out', 'batch-pack',
]);
/** Known refusals by class (the message says which); anything else is refused as unknown. */
const ACTION_CLASS = {
  pick: 'start', release: 'start', requeue: 'start', 'track-answer': 'start',
  'cloud-start': 'start', 'cloud-done': 'start', 'cloud-cancel': 'start',
  'board-switch': 'settings', 'cloud-switch': 'settings', 'cloud-setting': 'settings',
};
const ROUTE_CLASS = {
  'GET /api/cloudPackage': 'start', 'GET /api/cloud-bundles': 'start',
  'POST /api/limit': 'settings', 'POST /api/setting': 'settings', 'POST /api/guidance': 'settings',
  'POST /api/helper': 'settings', 'POST /api/helper-add': 'settings', 'POST /api/proposals': 'settings',
  'POST /api/proposals-undo': 'settings', 'POST /api/update-dismiss': 'settings',
  'GET /api/checks': 'gates', 'POST /api/checks': 'gates', 'GET /api/plan-check': 'gates',
  'POST /api/plan-new': 'project', 'POST /api/plan-source': 'project', 'POST /api/lawyerPackage': 'project',
  'POST /api/plan-capture': 'project', 'POST /api/plan-proposal': 'project',
};
const BACK = 'Back to my board to do it for real.';
const MESSAGES = {
  start: `Not in demo mode: starting or handing out work (pick, release, a track, the cloud) is off on the demo board. ${BACK}`,
  settings: 'Not in demo mode: settings are view only on the demo board. Back to my board to change them.',
  gates: `Not in demo mode: checks and gates run commands in your repo, so they are off on the demo board. ${BACK}`,
  project: `Not in demo mode: this would write into your project's files, so it is off on the demo board. ${BACK}`,
  unknown: `Not in demo mode: the demo board lets through answering, approving, QA, editing and moving cards only. ${BACK}`,
};

/**
 * null when the request is allowed while demo mode is on, otherwise the refusal { status: 409, answer } to send as is.
 * Refused by default: only the allow-lists above get through.
 * @param {string} method
 * @param {string} route the path, '/api/...'
 * @param {object} [body] the parsed JSON body of a POST
 */
function refusal(method, route, body = {}) {
  const b = body && typeof body === 'object' ? body : {};
  let cls = null;
  if (method === 'GET' && GET_OK.has(route)) return null;
  if (method === 'POST' && POST_OK.has(route)) return null;
  if (method === 'POST' && route === '/api/action') {
    const type = String(b.type ?? '');
    // "Keep as design choice" writes a draft into the project catalog: refused, the plain answer is fine.
    if (type === 'resolve' && b.keep === true) cls = 'project';
    else if (ACTION_OK.has(type)) return null;
    else cls = ACTION_CLASS[type] ?? 'unknown';
  } else cls = ROUTE_CLASS[`${method} ${route}`] ?? 'unknown';
  return { status: 409, answer: { ok: false, demo: true, refused: cls, message: MESSAGES[cls] } };
}

// ---- Path confinement --------------------------------------------------------------------------------------------
const isLink = (p) => {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};

/**
 * Is `target` a path strictly inside `root` that a write can use? It must resolve under the root, no existing part
 * on the way (the root included) may be a symlink or junction (Node reports both as a symlink), and the real path of
 * the deepest existing part must be the path walked (catches 8.3 short names and links the walk did not see).
 * @returns {{ ok: boolean, reason?: string }}
 */
function confined(root, target) {
  const r = path.resolve(root);
  const t = path.resolve(String(target ?? ''));
  if (!t.startsWith(r + path.sep)) return { ok: false, reason: 'outside the demo folder' };
  if (!fs.existsSync(r)) return { ok: true }; // nothing on disk yet: everything below is made as plain folders
  if (isLink(r)) return { ok: false, reason: 'the demo folder is a link' };
  const realRoot = fs.realpathSync.native(r);
  const parts = path.relative(r, t).split(path.sep);
  let here = r;
  let walked = realRoot;
  for (const part of parts) {
    const next = path.join(here, part);
    if (!fs.existsSync(next) && !isLink(next)) break;
    if (isLink(next)) return { ok: false, reason: `${path.relative(r, next)} is a link` };
    here = next;
    walked = path.join(walked, part);
  }
  if (here !== r && fs.realpathSync.native(here).toLowerCase() !== walked.toLowerCase())
    return { ok: false, reason: 'the real path differs from the path walked' };
  return { ok: true };
}

/** Every symlink or junction under root (relative paths), without walking into one. */
function linksIn(root) {
  const out = [];
  const walk = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (isLink(p)) out.push(path.relative(root, p));
      else if (e.isDirectory()) walk(p);
    }
  };
  walk(root);
  return out.sort();
}

/**
 * Is the demo folder under this data folder safe to use and to delete? A missing folder is fine. Refused: the folder is
 * a link, its real path is not <real data folder>/demo, or it holds a link anywhere inside.
 * @returns {{ ok: boolean, message?: string }}
 */
function checkRoot(dataFolder) {
  const { root } = paths(dataFolder);
  const where = 'Remove it by hand and try again; nothing was changed.';
  if (isLink(root)) return { ok: false, message: `The demo folder ${root} is a link, so the board will not use it. ${where}` };
  if (!fs.existsSync(root)) return { ok: true };
  try {
    if (fs.realpathSync.native(root).toLowerCase() !== path.join(fs.realpathSync.native(dataFolder), 'demo').toLowerCase())
      return { ok: false, message: `The demo folder ${root} resolves somewhere else. ${where}` };
  } catch {
    return { ok: false, message: `The demo folder ${root} cannot be read. ${where}` };
  }
  const links = linksIn(root);
  if (links.length) return { ok: false, message: `The demo folder holds a link (${links[0]}), so the board will not use it. ${where}` };
  return { ok: true };
}

// ---- The snapshot and the folder ---------------------------------------------------------------------------------
/** The tracked snapshot, read fresh (it is small). */
function snapshot() {
  return JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
}

const REL = /^@rel:(-?\d+)$/;
/** "@rel:<ms>" -> the ISO time that far from now; everything else is kept. */
function fromRelative(v, now) {
  if (typeof v === 'string') {
    const m = REL.exec(v);
    return m ? new Date(now + Number(m[1])).toISOString() : v;
  }
  if (Array.isArray(v)) return v.map((x) => fromRelative(x, now));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fromRelative(x, now)]));
  return v;
}

/** The files of the demo folder: [absolute path, text]. Entry names from the snapshot are checked by build(). */
function filesOf(snap, p, { now, mode }) {
  const json = (v) => `${JSON.stringify(v, null, 2)}\n`;
  const files = [[p.config, json({ ...snap.config, ...(mode ? { mode } : {}) })]];
  for (const [name, v] of Object.entries(snap.data ?? {})) if (v != null) files.push([path.join(p.data, name), json(fromRelative(v, now))]);
  const rows = fromRelative(snap.timeLog ?? [], now);
  files.push([p.timeLog, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '')]);
  for (const [name, text] of Object.entries(snap.docs ?? {})) files.push([path.join(p.root, ...String(name).split('/')), String(text)]);
  files.push([p.marker, json({ version: snap.version ?? 1, name: snap.name ?? 'demo', built: new Date(now).toISOString() })]);
  return files;
}

/**
 * Makes <dataFolder>/demo from the snapshot, replacing what is there. Every target is checked with confined() before
 * anything is written or deleted, and a folder that is or holds a link is refused (checkRoot), so nothing outside the
 * demo folder is ever written or deleted.
 * @param {string} dataFolder the REAL data folder
 * @param {{ now?: number, mode?: 'lite'|'full', snapshot?: object }} [o]
 * @returns {{ ok: boolean, message?: string, paths?: object }}
 */
function build(dataFolder, o = {}) {
  const now = o.now ?? Date.now();
  const p = paths(dataFolder);
  const safe = checkRoot(dataFolder);
  if (!safe.ok) return safe;
  let snap;
  try {
    snap = o.snapshot ?? snapshot();
  } catch (e) {
    return { ok: false, message: `Could not read the demo data (${e?.code ?? e?.message ?? 'unknown error'}).` };
  }
  const files = filesOf(snap, p, { now, mode: o.mode });
  for (const [file] of files) {
    const c = confined(p.root, file);
    if (!c.ok) return { ok: false, message: `The demo data names a file ${c.reason}; nothing was written.` };
  }
  try {
    // checkRoot found no link inside, so this removes plain files and folders only.
    fs.rmSync(p.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    for (const [file, text] of files) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    }
  } catch (e) {
    return { ok: false, message: `Could not make the demo folder (${e?.code ?? 'unknown error'}).` };
  }
  return { ok: true, paths: p };
}

/** "Reset demo": the folder made again from the snapshot (the same checks as build). */
function reset(dataFolder, o = {}) {
  return build(dataFolder, o);
}

// ---- The environment of everything that runs in demo mode -----------------------------------------------------------
/** Tokens a demo child never gets: nothing in demo mode may reach GitHub or an API. */
const DROPPED = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'];

/** The variables demo mode sets: every queue path in the demo folder, git locked out, updates off. */
function demoVariables(p) {
  return {
    QUEUE_ROOT: p.root,
    QUEUE_CONFIG: p.config,
    QUEUE_FOLDER: p.data,
    QUEUE_FILE: p.queue,
    QUEUE_TIME_LOG: p.timeLog,
    QUEUE_GIT: p.root,
    QUEUE_PLAN_SOURCE_ROOT: p.root,
    QUEUE_DOC_ROOT: p.root,
    QUEUE_SCRATCHPAD: path.join(p.root, 'scratch'),
    QUEUE_TRANSCRIPTS: path.join(p.root, 'transcripts'),
    QUEUE_PLAN_BACKUP: path.join(p.root, 'plan-backup'),
    QUEUE_INDEX_FILE: path.join(p.data, 'index.json'),
    QUEUE_STATUSLINE_CACHE: path.join(p.data, 'statusline.json'),
    // A gh that does not exist: any GitHub call fails at once.
    QUEUE_GH: path.join(p.root, 'no-gh'),
    QUEUE_CI_GH: path.join(p.root, 'no-gh'),
    GIT_DIR: p.noGit,
    GIT_CEILING_DIRECTORIES: path.dirname(p.root),
    DISABLE_UPDATES: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    RAVENSEAT_DEMO: '1',
  };
}

/** The environment for a queue.mjs run in demo mode: `env` with the demo variables and without the tokens. */
function childEnv(env, p) {
  const out = { ...env };
  for (const k of DROPPED) delete out[k];
  return { ...out, ...demoVariables(p) };
}

/** Every path value of the demo variables that must lie inside the demo folder (checked before each demo write). */
function unconfinedVariables(p) {
  const v = demoVariables(p);
  const bad = [];
  for (const k of Object.keys(v)) {
    if (!/^(QUEUE_|GIT_DIR$)/.test(k)) continue;
    if (v[k] === p.root) continue;
    if (!confined(p.root, v[k]).ok) bad.push(k);
  }
  return bad;
}

module.exports = {
  SNAPSHOT_FILE,
  OFFER_FILE,
  paths,
  readOffer,
  writeDismissed,
  refusal,
  confined,
  linksIn,
  checkRoot,
  snapshot,
  fromRelative,
  build,
  reset,
  demoVariables,
  childEnv,
  unconfinedVariables,
};
