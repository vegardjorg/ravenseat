/**
 * @vitest-environment jsdom
 */
// =============================================================
// queueBoardStale.test.ts: stale and error states (board step B29, UX review S-stale).
//
// What the tests prove:
//   1. One banner under the top says in plain words what is wrong, what to do (a command with Copy, "Try again") and the
//      time of the last successful update. Danger tone when something is broken (no server, an unreadable queue file, a
//      server error), warn tone for data that is just old. The key case uses the key banner, never a second banner.
//   2. The cards are dimmed while the data is stale (surface and text color, 4.5:1 from the palette), and writes are
//      paused with the reason: a write call, a drag and a keyboard lift are refused with a toast, and nothing is posted.
//   3. The relative times on the cards stop at the last update while stale, and count on again when it comes back.
//   4. Error text is plain: never "Failed to fetch", "HTTP 503", the server's error code, or the key.
//   5. Coming back hides the banner and draws the board again without a reload; going stale and coming back are said
//      once each in a polite live region, and a retry that fails again is silent.
// The rules (staleView, staleAnnouncement, plainError) are tested directly from a11y.js; the behaviour runs the whole
// board in jsdom with a fetch the test controls. CSS rules are read from board.css (render tests do not work in jsdom).
// =============================================================
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { clientSource } from './boardClient';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const T = require('../queueBoard.js') as { board: (queue: unknown, option?: unknown) => any; PALETTE: any };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const U = require('../../queue-board/a11y.js') as any;

const CLIENT = join(__dirname, '..', '..', 'queue-board');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const css = strip(readFileSync(join(CLIENT, 'board.css'), 'utf8'));
const html = readFileSync(join(CLIENT, 'index.html'), 'utf8');
const ROOT = join(__dirname, '..', '..', '..', '..', '..');
const KEY = 'secretTestKey';

// ---- The pure rules ---------------------------------------------------------------------------------------------------

describe('the rules in a11y.js', () => {
  const at = new Date(2026, 10, 18, 18, 54, 30).getTime();

  it('live data has no stale view', () => {
    expect(U.staleView({ keyInvalid: false, error: null, fetched: at, now: at + 30_000 })).toBeNull();
    expect(U.staleView({ keyInvalid: false, error: null, fetched: null, now: at })).toBeNull();
  });

  it('no server: danger, the time it lost contact, the start command and Try again', () => {
    const v = U.staleView({ keyInvalid: false, error: 'offline', fetched: at, now: at + 5_000 });
    expect(v).toMatchObject({ kind: 'offline', tone: 'danger', command: 'ravenseat board', retry: true });
    expect(v.title).toBe('The board lost contact with its server at 18:54.');
    expect(v.text).toContain('Showing the state from 18:54');
    expect(v.text).toContain('times on the cards are as of then');
    expect(v.text).toContain('Changes are paused');
  });

  it('no server and nothing read yet: no time is made up', () => {
    const v = U.staleView({ keyInvalid: false, error: 'offline', fetched: null, now: at });
    expect(v.title).toBe('The board cannot reach its server.');
    expect(v.text).not.toMatch(/\d\d:\d\d/);
  });

  it('an unreadable queue file, a server error and a changed key are danger; old data is warn', () => {
    expect(U.staleView({ error: 'queue', fetched: at, now: at })).toMatchObject({ kind: 'queue', tone: 'danger', command: null });
    expect(U.staleView({ error: 'server', fetched: at, now: at })).toMatchObject({ kind: 'server', tone: 'danger' });
    expect(U.staleView({ keyInvalid: true, error: 'key', fetched: at, now: at })).toMatchObject({
      kind: 'key',
      command: 'ravenseat board open',
      retry: false,
    });
    const old = U.staleView({ error: null, fetched: at, now: at + 61_000 });
    expect(old).toMatchObject({ kind: 'old', tone: 'warn', retry: true });
    expect(old.title).toBe('The board has not been updated since 18:54.');
  });

  it('errorKind: no answer, 401, 503 and the rest', () => {
    expect(U.errorKind(0)).toBe('offline');
    expect(U.errorKind(undefined)).toBe('offline');
    expect(U.errorKind(401)).toBe('key');
    expect(U.errorKind(503)).toBe('queue');
    expect(U.errorKind(500)).toBe('server');
  });

  it('plainError is a plain sentence: no code, no "HTTP", no "Failed to fetch"', () => {
    for (const status of [0, 401, 403, 404, 500, 502, 503]) {
      const text = U.plainError(status);
      expect(text).toMatch(/^[A-Z].*\.$/);
      expect(text).not.toMatch(/HTTP|\d{3}|Failed to fetch|Error:/);
    }
  });

  it('the announcement: going stale, another kind and coming back once each; the same kind is silent', () => {
    const offline = U.staleView({ error: 'offline', fetched: at, now: at });
    const queue = U.staleView({ error: 'queue', fetched: at, now: at });
    expect(U.staleAnnouncement(null, offline)).toBe(
      'The board lost contact with its server at 18:54. Showing the last state; changes are paused.',
    );
    expect(U.staleAnnouncement(offline, { ...offline })).toBeNull();
    expect(U.staleAnnouncement(offline, queue)).toContain('cannot read the queue file');
    expect(U.staleAnnouncement(queue, null)).toBe('The board is back in contact and up to date.');
    expect(U.staleAnnouncement(null, null)).toBeNull();
  });
});

// ---- CSS and markup ---------------------------------------------------------------------------------------------------

function ruleFor(selector: string): string {
  const out: string[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)))
    if (
      m[1]
        .split(',')
        .map((s) => s.trim())
        .includes(selector)
    )
      out.push(m[2]);
  return out.join(';');
}

describe('the look: tones by meaning, dimmed cards that stay readable', () => {
  it('the banner uses the danger and warn tones (tokens, no hex)', () => {
    expect(ruleFor('.stale-banner.stale-danger')).toContain('var(--color-tone-danger)');
    expect(ruleFor('.stale-banner.stale-danger')).toContain('var(--color-on-tone-danger)');
    expect(ruleFor('.stale-banner.stale-warn')).toContain('var(--color-tone-warn)');
    expect(ruleFor('.stale-banner.stale-warn')).toContain('var(--color-on-tone-warn)');
    const b29 = css.slice(css.indexOf('.stale-banner {'), css.indexOf('body.stale .summary.stuck::before'));
    expect(b29).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });

  it('dimmed cards use the surface and text color (not opacity) and keep 4.5:1 in both modes', () => {
    const r = ruleFor('body.stale .summary');
    expect(r).toContain('background: var(--color-surface-container-high)');
    expect(r).toContain('color: var(--color-on-surface-variant)');
    expect(r).toContain('border-style: dashed');
    expect(r).not.toContain('opacity');
    for (const mode of ['light', 'dark']) {
      const p = T.PALETTE[mode];
      expect(U.contrast(p['on-surface-variant'], p['surface-container-high'])).toBeGreaterThanOrEqual(4.5);
      expect(U.contrast(p['on-surface'], p['surface-container-high'])).toBeGreaterThanOrEqual(4.5);
      expect(U.contrast(p['on-tone-danger'], p['tone-danger'])).toBeGreaterThanOrEqual(4.5);
      expect(U.contrast(p['on-tone-warn'], p['tone-warn'])).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('one banner element, not a live region itself; the transitions go to one polite region', () => {
    expect(html.match(/id="stale-banner"/g)?.length).toBe(1);
    expect(html).toMatch(/<div id="stale-banner" class="stale-banner" hidden><\/div>/);
    expect(html).toMatch(/<p id="stale-live" class="hidden-for-eye" role="status" aria-live="polite"><\/p>/);
  });
});

// ---- The board in jsdom -----------------------------------------------------------------------------------------------

const DAY_AGO = new Date(Date.now() - 86_400_000).toISOString();
const START = Date.UTC(2026, 10, 18, 17, 0, 0);
function makeQueue() {
  const task = (id: string, extra: object = {}) => ({
    id,
    title: `Task ${id}`,
    domain: 'ui',
    class: 'K',
    value: 5,
    content_min: 30,
    status: 'waiting',
    depends_on: [],
    waiting_on: [],
    owned_files: [`file/${id}.ts`],
    owner_db: [],
    shared_patch: [],
    mission: `scripts/.queue/mission/${id}.md`,
    added_by: 'test',
    added_at: DAY_AGO,
    ...extra,
  });
  return {
    created: DAY_AGO,
    limits: { maxConcurrent: 5, maxDPlus: 2, maxPerDomain: 5, maxDb: 2 },
    tasks: [
      task('EX-1'),
      task('EX-2'),
      task('EX-3', { status: 'picked', picked_by: 'Vegard', picked_at: new Date(START).toISOString() }),
    ],
    projects: { ex: { title: 'Example', prefixes: ['EX-'] } },
    areas: {},
    question: [],
    resolutions: [],
    changelog: [],
  };
}
function makeState(version: string) {
  const data = { ...T.board(makeQueue()), gitError: null, logo: false, checksPanel: true };
  data.projects = data.projects.map((p: any) => (p.pid === 'ex' ? { ...p, movable: true } : p));
  return { version, data };
}
const state = makeState('v1');
let mode: 'ok' | 'offline' | 'queue' | 'key' = 'ok';
const posts: { url: string; body: any }[] = [];
const logged: string[] = [];

const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};
const $ = (id: string) => document.getElementById(id) as HTMLElement;
/** A poll, as when the tab gets focus. */
async function poll() {
  window.dispatchEvent(new (window as any).Event('focus'));
  await flush();
}
const ageText = () => (document.querySelector('[data-start]') as HTMLElement | null)?.textContent;
const now = (ms: number) => vi.setSystemTime(new Date(ms));

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  now(START + 30 * 60_000); // EX-3 was picked 30 min ago
  document.documentElement.innerHTML = html.replace(/<!doctype[^>]*>/i, '').replace(/<\/?html[^>]*>/g, '');
  sessionStorage.setItem('queue-board-key', KEY);
  localStorage.clear();
  const w = window as any;
  w.CSS = { escape: (s: string) => String(s).replace(/["\\]/g, '\\$&') };
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {} });
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.setInterval = () => 0;
  for (const k of ['log', 'warn', 'error', 'info'] as const)
    vi.spyOn(console, k).mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(' ')));
  w.fetch = async (filePath: string, init?: any) => {
    if (init?.method === 'POST') posts.push({ url: filePath, body: JSON.parse(init.body ?? '{}') });
    if (mode === 'offline') throw new TypeError('Failed to fetch');
    if (mode === 'queue' && filePath.startsWith('/api/state'))
      return { ok: false, status: 503, json: async () => ({ ok: false, message: 'Could not read the queue (ENOENT).' }) };
    if (mode === 'key') return { ok: false, status: 401, json: async () => ({ ok: false, message: 'The key is missing or old.' }) };
    return {
      ok: true,
      status: 200,
      json: async () => {
        if (filePath.startsWith('/api/state'))
          return filePath.includes(`version=${state.version}`) ? { version: state.version, unchanged: true } : state;
        if (filePath.startsWith('/api/checks')) return { report: { found: { kinds: [], ci: [] }, suggestions: [], categories: [] } };
        if (filePath.startsWith('/api/settings')) return { error: 'not in this test' };
        if (filePath.startsWith('/api/task')) return { ok: true, mission: { text: '', path: null }, branch: null };
        return { ok: true };
      },
    };
  };
  for (const f of ['a11y.js', '../lib/queueGraph.js', 'graph.js', 'plan.js', 'performance.js', 'board/'])
    (0, eval)(clientSource(f));
  await flush();
  $('show-lanes').click();
  await flush();
}, 60_000);

afterAll(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Nothing secret and nothing raw anywhere a person or a log can read it. */
function expectClean() {
  const text = document.body.innerHTML + '\n' + logged.join('\n');
  expect(text).not.toContain(KEY);
  expect(document.body.textContent).not.toMatch(/Failed to fetch|HTTP \d|ENOENT|TypeError/);
}

describe('the board going stale and coming back', () => {
  it('live: no banner, no dimming, the age counts', () => {
    expect($('stale-banner').hidden).toBe(true);
    expect(document.body.classList.contains('stale')).toBe(false);
    expect(ageText()).toBe('30 min');
    expect($('status').getAttribute('aria-live')).toBe('polite');
  });

  it('1, 4, 5: the server stops: one danger banner in plain words with the time, said once', async () => {
    now(START + 31 * 60_000);
    mode = 'offline';
    await poll();
    const banner = $('stale-banner');
    expect(banner.hidden).toBe(false);
    expect(banner.classList.contains('stale-danger')).toBe(true);
    expect(document.querySelectorAll('.stale-banner').length).toBe(1);
    const lastOk = new Date(START + 30 * 60_000);
    const hhmm = `${String(lastOk.getHours()).padStart(2, '0')}:${String(lastOk.getMinutes()).padStart(2, '0')}`;
    expect(banner.querySelector('.stale-banner-title')?.textContent).toBe(`The board lost contact with its server at ${hhmm}.`);
    expect(banner.querySelector('code')?.textContent).toBe('ravenseat board');
    expect(banner.querySelector('.stale-retry')?.textContent).toBe('Try again');
    expect($('key-banner').hidden).toBe(true);
    expect($('stale-live').textContent).toContain('lost contact');
    // The status line is quiet meanwhile and says only how old the data is.
    expect($('status').getAttribute('aria-live')).toBe('off');
    expect($('status').textContent).toBe(`Not updated since ${hhmm}`);
    expectClean();
  });

  it('5: a retry that fails again is silent and keeps the same banner', async () => {
    const title = $('stale-banner').querySelector('.stale-banner-title');
    $('stale-live').textContent = '';
    now(START + 32 * 60_000);
    await poll();
    ($('stale-banner').querySelector('.stale-retry') as HTMLButtonElement).click();
    await flush();
    expect($('stale-live').textContent).toBe('');
    expect($('stale-banner').querySelector('.stale-banner-title')).toBe(title);
    expect($('stale-banner').querySelector('.stale-retry')?.textContent).toBe('Try again');
  });

  it('2: the cards are dimmed (body.stale)', () => {
    expect(document.body.classList.contains('stale')).toBe(true);
  });

  it('3: the age stops at the last update, also when the board is drawn again', async () => {
    now(START + 45 * 60_000);
    expect(ageText()).toBe('30 min');
    $('show-flat').click();
    await flush();
    expect(ageText()).toBe('30 min');
  });

  it('2: a write is refused with the reason, and nothing is posted', async () => {
    const before = posts.length;
    // A drag start from old data is cancelled.
    const card = document.querySelector('.summary[draggable="true"]') as HTMLElement;
    expect(card).not.toBeNull();
    const drag = new (window as any).Event('dragstart', { bubbles: true, cancelable: true });
    drag.dataTransfer = { setData() {}, effectAllowed: '' };
    card.dispatchEvent(drag);
    expect(drag.defaultPrevented).toBe(true);
    expect(card.classList.contains('drags')).toBe(false);
    expect($('message').textContent).toBe(U.STALE_BLOCKED);
    $('message').textContent = '';
    // A keyboard lift (Space on the card's title button) is refused the same way.
    const title = card.querySelector('.summary-button') as HTMLElement;
    title.dispatchEvent(new (window as any).KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
    expect(card.classList.contains('boosted')).toBe(false);
    expect($('message').textContent).toBe(U.STALE_BLOCKED);
    // A write call (Pause in the lane header) does not reach the server.
    $('show-lanes').click();
    await flush();
    const pause = document.querySelector('[data-focus^="pause:"]') as HTMLButtonElement | null;
    expect(pause).not.toBeNull();
    pause!.click();
    await flush();
    expect(posts.length).toBe(before);
    expect($('message').textContent).toContain('Changes are paused');
    expectClean();
  });

  it('5: the server is back: the banner goes, the board is live and drawn again, said once', async () => {
    mode = 'ok';
    $('stale-live').textContent = '';
    // The refusal toast is up from the write that was tried; it is no longer true once the board is back.
    ($('message') as HTMLElement).textContent = U.STALE_BLOCKED;
    $('message').hidden = false;
    await poll();
    expect($('message').hidden).toBe(true);
    expect($('stale-banner').hidden).toBe(true);
    expect(document.body.classList.contains('stale')).toBe(false);
    expect($('stale-live').textContent).toBe('The board is back in contact and up to date.');
    expect($('status').getAttribute('aria-live')).toBe('polite');
    expect($('status').textContent).toMatch(/^Updated at /);
    expect(ageText()).toBe('45 min');
    // A further good poll says nothing more.
    $('stale-live').textContent = '';
    await poll();
    expect($('stale-live').textContent).toBe('');
  });

  it('1, 4: an unreadable queue file: its own plain banner, never the server code', async () => {
    mode = 'queue';
    await poll();
    const banner = $('stale-banner');
    expect(banner.hidden).toBe(false);
    expect(banner.querySelector('.stale-banner-title')?.textContent).toBe('The board cannot read the queue file.');
    expect(banner.querySelector('code')).toBeNull();
    expectClean();
    mode = 'ok';
    await poll();
    expect(banner.hidden).toBe(true);
  });

  it('1: a changed key uses the key banner with the time, not a second banner; the link brings it back', async () => {
    mode = 'key';
    $('stale-live').textContent = '';
    await poll();
    expect($('key-banner').hidden).toBe(false);
    expect($('stale-banner').hidden).toBe(true);
    expect(document.body.classList.contains('stale')).toBe(true);
    expect($('key-banner-time').hidden).toBe(false);
    expect($('key-banner-time').textContent).toContain('Showing the state from');
    // The key banner is an alert of its own: the live region does not say it again.
    expect($('stale-live').textContent).toBe('');
    expectClean();
    mode = 'ok';
    ($('key-link') as HTMLInputElement).value = 'http://127.0.0.1:1/#key=freshKey1';
    $('key-form').dispatchEvent(new (window as any).Event('submit', { cancelable: true }));
    await flush();
    expect($('key-banner').hidden).toBe(true);
    expect($('key-banner-time').hidden).toBe(true);
    expect(document.body.classList.contains('stale')).toBe(false);
    expect($('stale-live').textContent).toBe('The board is back in contact and up to date.');
    expect(document.body.innerHTML).not.toContain('freshKey1');
  });
});

describe('the docs', () => {
  it('board.md and the CHANGELOG describe the stale state', () => {
    const doc = readFileSync(join(ROOT, 'plugin', 'docs', 'board.md'), 'utf8');
    expect(doc).toMatch(/lost contact/);
    expect(doc).toMatch(/Changes are paused/);
    const log = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
    // The entry that describes it, wherever it is now: "## Unreleased" is empty right after a release, so reading only
    // that section failed on the release commit itself.
    const entry = log.split('\n- **').find((e) => /stale/i.test(e) && /lost contact|Changes are paused/i.test(e)) ?? '';
    expect(entry).toMatch(/stale/i);
    expect(entry).not.toMatch(/\u2014/);
  });
});
