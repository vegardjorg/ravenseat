// =============================================================
// queue-board/api/views.mjs: the read-only views and the Follow up page.
//
// The read-only views: GET /api/state (the board), /api/since ("Since you left"), /api/schedule (the Timeline),
// /api/statistics and /api/follow, POST /api/seen (the seen mark), and the Follow up page (followData and the
// page shell /follow, /follow.css, /follow.js in FOLLOW_PAGE).
//
// Moved out of queue-board.mjs unchanged (SPLIT-1). A handler that needs the server takes its context `ctx` first:
// the live paths and caches as getters (demo mode switches them), the data builders and the write plumbing
// (writeTools.mjs). A POST handler also gets `c`, the per-call tools write() builds (no, run, queueNow, info).
// viewRoutes(ctx) binds them, so queue-board.mjs calls them with the old arguments.
//
// Used by: queue-board.mjs (the GET routes, write() and the static pages).
// Tested in: lib/__tests__/queueBoardState.test.ts, queueBoardServe.test.ts, queueBoardFeatures.test.ts and queueBoardMetrics.test.ts.
// =============================================================
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const AWAY = require('../../lib/awaySummary.js');
const F = require('../../lib/queueFollow.js');
const KK = require('../../lib/queueConfig.js');
const SEEN = require('../../lib/seenMark.js');

/** GET /api/state. */
function getState(ctx, req, res, url) {
  const { demoNow, json, state } = ctx;
  try {
    const t = state();
    // The demo field is outside the state cache (the offer follows the real queue and demo-offer.json), so it is part
    // of the version: a change in it reaches the open board on its next poll.
    const demo = demoNow(ctx.demoOn ? ctx.realConfig : KK.config({ fresh: true }));
    const version = `${t.version}|demo:${demo.on ? 1 : 0}${demo.offer ? 1 : 0}${demo.setting ? 1 : 0}`;
    if (url.searchParams.get('version') === version) return json(res, 200, { version, unchanged: true });
    return json(res, 200, { version, data: { ...t.data, demo } });
  } catch (e) {
    return json(res, 503, {
      ok: false,
      message: `Could not read the queue (${e?.code ?? e?.message ?? 'unknown error'}).`,
    });
  }
}

/** GET /api/follow. */
function getFollow(ctx, req, res, url) {
  const { json } = ctx;
  try {
    return json(res, 200, followData(ctx));
  } catch (e) {
    return json(res, 503, {
      ok: false,
      message: `Could not read the follow-up entries (${e?.code ?? e?.message ?? 'unknown error'}).`,
    });
  }
}

// "Since you left" (AW-2): ?window=last-seen|24h|7d (else the setting), ?from=<ms> keeps the visit's window.
function getSince(ctx, req, res, url) {
  const { json, sinceData } = ctx;
  try {
    const w = url.searchParams.get('window');
    const f = Number(url.searchParams.get('from'));
    return json(res, 200, sinceData({ choice: AWAY.WINDOWS.includes(w) ? w : null, from: url.searchParams.has('from') && Number.isFinite(f) ? f : null }));
  } catch (e) {
    return json(res, 503, { ok: false, message: `Could not build "Since you left" (${e?.code ?? e?.message ?? 'unknown error'}).` });
  }
}

// The Timeline tab (T-A): the schedule played forward, read only. "unchanged" when the client has this version.
function getSchedule(ctx, req, res, url) {
  const { json, scheduleData } = ctx;
  try {
    const d = scheduleData();
    if (url.searchParams.get('version') === d.version) return json(res, 200, { version: d.version, unchanged: true });
    return json(res, 200, { ok: true, version: d.version, data: d });
  } catch (e) {
    return json(res, 503, {
      ok: false,
      message: `Could not build the timeline (${e?.code ?? e?.message ?? 'unknown error'}).`,
    });
  }
}

/** GET /api/statistics. */
function getStatistics(ctx, req, res, url) {
  const { json, statistics } = ctx;
  try {
    const s = statistics();
    if (url.searchParams.get('version') === s.version)
      return json(res, 200, { version: s.version, unchanged: true });
    return json(res, 200, { version: s.version, data: s.data });
  } catch (e) {
    return json(res, 503, {
      ok: false,
      message: `Could not build the statistics (${e?.code ?? e?.message ?? 'unknown error'}).`,
    });
  }
}

// "Since you left": the seen mark (AW-3), set by Decisions on screen a few seconds or "Mark seen" (lib/seenMark.js).
function seen(ctx, b, c) {
  const r = SEEN.writeSeen(ctx.FOLDER, { by: 'board' });
  if (!r.ok) return { status: 500, answer: { ok: false, message: `could not write seen.json (${r.error})` } };
  return { status: 200, answer: { ok: true, seen: r.seen } };
}

// ---- Follow up: read only ----------------------------------------------------------------------------------------
/** The entries with the status as it applies today (queueFollow.effectiveStatus), the open ones first, and the lines show prints. */
function followData(ctx) {
  const reg = fs.existsSync(ctx.FOLLOW_FILE)
    ? F.normalize(JSON.parse(fs.readFileSync(ctx.FOLLOW_FILE, 'utf8')))
    : F.emptyRegister();
  return F.boardData(reg, F.dayDate(new Date()));
}

// The page is a shell without data (CSP: only script and style from 'self'); the script fetches /api/follow with the key
// (the same sessionStorage key as the board) and builds the view with textContent, never innerHTML, so text from the
// entries is never read as HTML. Colors from /theme.css (the palette in lib/queueBoard.js), light and dark.
// A function: escHtml and TITLE are defined further down (and the title is read once per request, which is cheap).
const followHtml = (ctx) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Follow up · ${ctx.escHtml(ctx.TITLE)}</title>
<link rel="stylesheet" href="/theme.css">
<link rel="stylesheet" href="/follow.css">
</head>
<body>
<header><h1>Follow up</h1><a href="/">Back to the queue</a></header>
<p id="lines" class="lines"></p>
<main id="entries"><p>Loading ...</p></main>
<script src="/follow.js"></script>
</body>
</html>
`;
const FOLLOW_CSS = `body { font-family: system-ui, sans-serif; margin: 0 auto; max-width: 960px; padding: 16px;
  background: var(--color-surface-container-low); color: var(--color-on-surface); }
header { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; }
a { color: var(--color-primary); }
.lines { white-space: pre-line; color: var(--color-on-surface-variant); }
article { background: var(--color-surface-container-lowest); border: 1px solid var(--color-outline-variant);
  border-radius: 12px; padding: 12px 16px; margin: 12px 0; }
article.to-report { border-color: var(--color-error); }
.status { font-weight: 600; }
article.to-report .status { color: var(--color-error); }
h2 { font-size: 1.05rem; margin: 0 0 4px; overflow-wrap: anywhere; }
ul { margin: 4px 0 8px; padding-left: 20px; }
li, p { overflow-wrap: anywhere; }
.small { color: var(--color-on-surface-variant); font-size: 0.9rem; }
`;
const FOLLOW_JS = `'use strict';
(function () {
  var KEY = 'queue-board-key';
  function getKey() {
    var m = /[#&]key=([A-Za-z0-9_-]+)/.exec(location.hash);
    if (m) {
      sessionStorage.setItem(KEY, m[1]);
      history.replaceState(null, '', location.pathname + location.search);
    }
    return sessionStorage.getItem(KEY);
  }
  function el(tag, text, cls) {
    var e = document.createElement(tag);
    if (text != null) e.textContent = text;
    if (cls) e.className = cls;
    return e;
  }
  function list(rows) {
    var ul = el('ul');
    rows.forEach(function (r) { ul.appendChild(el('li', r)); });
    return ul;
  }
  function values(l) {
    if (!l.values) return '';
    return ' [' + Object.keys(l.values).map(function (k) { return k + '=' + l.values[k]; }).join(', ') + ']';
  }
  function entry(p) {
    var a = el('article', null, p.status);
    a.appendChild(el('h2', p.id + ': ' + p.title));
    var st = p.decided ? 'closed (' + p.status + ')' : p.status === 'to-report' ? 'TO REPORT' : p.status;
    a.appendChild(el('div', st + ' · ' + p.start + ' -> ' + p.end + ' · owner ' + p.owner, 'status'));
    a.appendChild(el('p', p.why));
    a.appendChild(el('div', 'Goals', 'small'));
    a.appendChild(list(p.goals.map(function (m) {
      return m.name + ': ' + m.how + ' (expected: ' + m.expected + ')';
    })));
    var log = p.log.slice(-10).map(function (l) {
      return String(l.at).slice(0, 16).replace('T', ' ') + ' ' + l.source + ': ' + (l.text || '') + values(l);
    });
    a.appendChild(el('div', 'Log (' + p.log.length + (p.log.length > 10 ? ', the last 10' : '') + ')', 'small'));
    a.appendChild(log.length ? list(log) : el('p', '(empty)', 'small'));
    if (p.decision) a.appendChild(el('p', 'Owner decision: ' + p.decision));
    if (p.report) a.appendChild(el('p', 'Report: ' + p.report, 'small'));
    else if (p.status === 'to-report') a.appendChild(el('p', 'Run: ravenseat follow report ' + p.id, 'small'));
    return a;
  }
  var target = document.getElementById('entries');
  fetch('/api/follow', { headers: { 'X-Queue-Key': getKey() || '' } })
    .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
    .then(function (s) {
      target.textContent = '';
      if (!s.ok) { target.appendChild(el('p', s.d.message || 'Could not fetch the follow-up entries.')); return; }
      document.getElementById('lines').textContent = s.d.lines.join('\\n');
      if (!s.d.entries.length)
        target.appendChild(el('p', 'No follow-up entries. Add one: ravenseat follow add --file <json>.'));
      s.d.entries.forEach(function (p) { target.appendChild(entry(p)); });
    })
    .catch(function () { target.textContent = 'Could not fetch the follow-up entries.'; });
})();
`;
// path -> [type, () => body]
const FOLLOW_PAGE = {
  '/follow': ['text/html; charset=utf-8', followHtml],
  '/follow.css': ['text/css; charset=utf-8', () => FOLLOW_CSS],
  '/follow.js': ['text/javascript; charset=utf-8', () => FOLLOW_JS],
};

/** The handlers bound to the server's context (queue-board.mjs builds ctx once and calls them with the old arguments). */
export function viewRoutes(ctx) {
  return {
    getState: (...args) => getState(ctx, ...args),
    getFollow: (...args) => getFollow(ctx, ...args),
    getSince: (...args) => getSince(ctx, ...args),
    getSchedule: (...args) => getSchedule(ctx, ...args),
    getStatistics: (...args) => getStatistics(ctx, ...args),
    seen: (...args) => seen(ctx, ...args),
  };
}

export { FOLLOW_PAGE };
