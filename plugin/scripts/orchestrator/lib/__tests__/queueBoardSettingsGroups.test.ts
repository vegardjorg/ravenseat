/**
 * @vitest-environment jsdom
 */
// =============================================================
// queueBoardSettingsGroups.test.ts: the settings registry in the board's gear (board/settings.js registrySections) and
// the shared warning dialog with the slide (board/api.js confirmWeaken), plans/innstillinger-vurdering-2026-11-12.md
// steps 6 and 6b.
//   - every category is drawn with its basic rows first and the Advanced ones folded (closed) under them; in lite the
//     full-only rows are behind one closed line, so maxDPlus has no field there; each row says where it is saved;
//   - a guard weaker than the default gives a banner and a Weakened mark;
//   - (b) tapping the weaker option changes nothing by itself: the control goes back, the dialog shows the row's three
//     texts, and Cancel, Escape, Close and a click outside send nothing;
//   - (c) a single click or one key press on the handle does not complete the slide; holding ArrowRight for about a
//     second does, by keyboard on a real slider (role, aria-valuenow, aria-valuetext), and only then is the change sent
//     with confirm: 'weaken'. A change that weakens nothing is sent at once.
// The whole board runs in jsdom with a mock server (no network); the answers are built by the server's own functions.
// =============================================================
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { clientSource } from './boardClient';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const T = require('../queueBoard.js') as {
  board: (queue: unknown, option?: unknown) => any;
  settings: (queue: unknown, option?: unknown) => any[];
  settingsGroups: (queue: unknown, option?: unknown) => any;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const KK = require('../queueConfig.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const PR = require('../queueProposals.js');

const CLIENT = join(__dirname, '..', '..', 'queue-board');

function makeQueue() {
  const iso = new Date(Date.now() - 86_400_000).toISOString();
  return { created: iso, limits: {}, tasks: [], projects: {}, areas: {}, question: [], resolutions: [], changelog: [] };
}

const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The config the mock server answers with (changed per test). */
let config = KK.merge(KK.STANDARD, { mode: 'lite' });
const posts: { path: string; body: any }[] = [];
const state = { version: 'v1', data: { ...T.board(makeQueue()), gitError: null, logo: false, update: null } };

function settingsAnswer() {
  const queue = makeQueue();
  const mode = config.mode === 'lite' ? 'lite' : 'full';
  return {
    ok: true,
    mode,
    field: T.settings(queue, { migrations: false, mode }),
    registry: T.settingsGroups(queue, { config, migrations: false }),
    usageToday: 0,
    night: { active: false },
    setup: { rules: [], rulesSource: 'docs/orchestration.md' },
    helpers: [],
    autoAccept: PR.boardData(config.proposals?.autoAccept, queue),
  };
}

const panel = () => document.getElementById('panel') as HTMLElement;
const category = (id: string) => panel().querySelector(`[data-category="${id}"]`) as HTMLElement;
const row = (key: string) => panel().querySelector(`[data-key="${key}"]`) as HTMLElement;
const dialog = () => document.getElementById('guard') as HTMLElement;
const dialogOpen = () => !(document.getElementById('guard-background') as HTMLElement).hidden;
const handle = () => document.getElementById('slide-handle') as HTMLElement;
const settingPosts = () => posts.filter((p) => p.path === '/api/setting' || p.path === '/api/proposals');
const key = (el: Element, type: 'keydown' | 'keyup', k: string, o: KeyboardEventInit = {}) =>
  el.dispatchEvent(new KeyboardEvent(type, { key: k, bubbles: true, cancelable: true, ...o }));
const pointer = (el: Element, type: string, x: number) => {
  const e = new MouseEvent(type, { bubbles: true, clientX: x }) as MouseEvent & { pointerId: number };
  e.pointerId = 1;
  el.dispatchEvent(e);
};

async function redraw(o: object) {
  config = KK.merge(KK.STANDARD, o);
  // Close the panel and open the gear again (the board's scripts keep their names to themselves), which fetches anew.
  (panel().querySelector('.panel-header button[aria-label="Close"]') as HTMLButtonElement | null)?.click();
  await flush();
  (document.getElementById('settings') as HTMLButtonElement).click();
  await flush();
}

beforeAll(async () => {
  const html = readFileSync(join(CLIENT, 'index.html'), 'utf8');
  document.documentElement.innerHTML = html.replace(/<!doctype[^>]*>/i, '').replace(/<\/?html[^>]*>/g, '');
  sessionStorage.setItem('queue-board-key', 'testKey');
  localStorage.clear();
  const w = window as any;
  w.CSS = { escape: (s: string) => String(s).replace(/["\\]/g, '\\$&') };
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.setInterval = () => 0;
  w.fetch = async (filePath: string, init?: { method?: string; body?: string }) => {
    if (init?.method === 'POST') {
      posts.push({ path: filePath, body: JSON.parse(init.body ?? '{}') });
      return { ok: true, status: 200, json: async () => ({ ok: true, message: 'ok', info: [] }) };
    }
    if (filePath.startsWith('/api/settings')) return { ok: true, status: 200, json: async () => settingsAnswer() };
    if (filePath.startsWith('/api/state'))
      return {
        ok: true,
        status: 200,
        json: async () => (filePath.includes(`version=${state.version}`) ? { version: state.version, unchanged: true } : state),
      };
    return { ok: true, status: 200, json: async () => ({}) };
  };
  for (const f of ['a11y.js', '../lib/queueGraph.js', 'graph.js', 'plan.js', 'performance.js', '../lib/queueUpdate.js', 'board/'])
    (0, eval)(clientSource(f));
  await flush();
  (document.getElementById('settings') as HTMLButtonElement).click();
  await flush();
}, 60_000);

beforeEach(() => {
  posts.length = 0;
});

describe('the settings registry in the gear (step 6)', () => {
  it('draws the categories in order, basic rows first and Advanced folded closed under them', async () => {
    await redraw({ mode: 'full' });
    const ids = [...panel().querySelectorAll('[data-category]')].map((c) => c.getAttribute('data-category'));
    expect(ids.slice(0, 3)).toEqual(['project', 'limits', 'load']);
    const limits = category('limits');
    expect(limits.querySelector('h3')?.textContent).toBe('Limits and cost');
    const advanced = limits.querySelector('details[data-fold="advanced"]') as HTMLDetailsElement;
    expect(advanced).not.toBeNull();
    expect(advanced.open).toBe(false);
    expect(advanced.querySelector('summary')?.textContent).toMatch(/^Advanced \(\d+\)$/);
    // A basic row is directly in the category, not in the fold, and the limit keeps its field with the guard rules.
    const basic = row('limits.maxConcurrent');
    expect(basic.closest('details')).toBeNull();
    expect(document.getElementById('g-maxConcurrent')).not.toBeNull();
    // Every advanced row is inside the fold and marked.
    for (const f of advanced.querySelectorAll('[data-key]')) expect(f.textContent).toContain('Advanced');
  });

  it('says where each row is saved', async () => {
    await redraw({ mode: 'full' });
    expect(row('limits.maxConcurrent').textContent).toContain('Saved only for you (queue.json)');
    expect(row('secretScan.enabled').textContent).toContain('Saved for the project (queue.config.json, remember to commit)');
  });

  it('lite: the full-only rows are behind one closed line per category, so maxDPlus has no field', async () => {
    await redraw({ mode: 'lite' });
    expect(panel().textContent).toContain('Mode: lite.');
    const limits = category('limits');
    const line = [...limits.querySelectorAll('details[data-fold="fullonly"]')] as HTMLDetailsElement[];
    expect(line).toHaveLength(1);
    expect(line[0].open).toBe(false);
    expect(line[0].querySelector('summary')?.textContent).toMatch(/^\d+ more apply only in full mode .*Show them$/);
    expect(line[0].querySelector('[data-key="limits.maxDPlus"]')).not.toBeNull();
    expect(document.getElementById('g-maxDPlus')).toBeNull();
    expect(document.getElementById('g-maxConcurrent')).not.toBeNull();
  });

  it('a guard weaker than the default gives the banner and a Weakened mark; none in the default setup', async () => {
    await redraw({ mode: 'full' });
    expect(document.getElementById('settings-weakened')).toBeNull();
    await redraw({ mode: 'full', secretScan: { enabled: false } });
    const banner = document.getElementById('settings-weakened') as HTMLElement;
    expect(banner.textContent).toContain('One guard is weaker than the default');
    expect(banner.textContent).toContain('Secret scan before push');
    expect(row('secretScan.enabled').textContent).toContain('Weakened');
  });
});

describe('the warning dialog with the slide (step 6b)', () => {
  const secretSwitch = () => document.getElementById('reg-secretScan-enabled') as HTMLInputElement;
  const openWarning = async () => {
    await redraw({ mode: 'full' });
    expect(secretSwitch().checked).toBe(true);
    secretSwitch().click(); // the weaker option: off
    await flush();
  };

  it('(b) tapping the weaker option changes nothing; the dialog shows the three texts; Cancel sends nothing', async () => {
    await openWarning();
    expect(dialogOpen()).toBe(true);
    expect(secretSwitch().checked).toBe(true); // put back at once
    const text = dialog().textContent ?? '';
    for (const h of ['What it protects against', 'Why turning it off is not a good idea', 'What changes']) expect(text).toContain(h);
    expect(text).toContain('Saved for the project');
    const cancel = [...dialog().querySelectorAll('button')].find((b) => b.textContent === 'Cancel') as HTMLButtonElement;
    expect(document.activeElement).toBe(cancel);
    cancel.click();
    await flush();
    expect(dialogOpen()).toBe(false);
    expect(settingPosts()).toEqual([]);
    expect(secretSwitch().checked).toBe(true);
  });

  it('(b) Escape, Close and a click outside send nothing either', async () => {
    await openWarning();
    key(dialog(), 'keydown', 'Escape');
    await flush();
    expect(dialogOpen()).toBe(false);

    await openWarning();
    (dialog().querySelector('button[aria-label^="Close"]') as HTMLButtonElement).click();
    await flush();
    expect(dialogOpen()).toBe(false);

    await openWarning();
    const background = document.getElementById('guard-background') as HTMLElement;
    background.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();
    expect(dialogOpen()).toBe(false);
    expect(settingPosts()).toEqual([]);
    expect(secretSwitch().checked).toBe(true);
  });

  it('(c) the handle is a real slider; a click or one key press does not complete it', async () => {
    await openWarning();
    const h = handle();
    expect(h.getAttribute('role')).toBe('slider');
    expect(h.getAttribute('tabindex')).toBe('0');
    expect([h.getAttribute('aria-valuemin'), h.getAttribute('aria-valuemax')]).toEqual(['0', '100']);
    expect(h.getAttribute('aria-valuetext')).toBe('Not confirmed');
    // A click (pointer down and up without a drag, then the click).
    pointer(h, 'pointerdown', 10);
    pointer(h, 'pointerup', 10);
    h.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();
    expect(h.getAttribute('aria-valuenow')).toBe('0');
    // One Enter press, let go at once.
    key(h, 'keydown', 'Enter');
    key(h, 'keyup', 'Enter');
    await wait(200);
    expect(Number(h.getAttribute('aria-valuenow'))).toBeLessThan(100);
    expect(h.getAttribute('aria-valuetext')).toBe('Not confirmed');
    expect(dialogOpen()).toBe(true);
    expect(settingPosts()).toEqual([]);
    key(dialog(), 'keydown', 'Escape');
    await flush();
    expect(settingPosts()).toEqual([]);
  });

  it('(c) holding ArrowRight for about a second completes it, and only then is the change sent', async () => {
    await openWarning();
    const h = handle();
    h.focus();
    key(h, 'keydown', 'ArrowRight');
    // Key repeats while held are ignored (the hold is timed).
    key(h, 'keydown', 'ArrowRight', { repeat: true });
    await wait(400);
    expect(settingPosts()).toEqual([]);
    expect(Number(h.getAttribute('aria-valuenow'))).toBeGreaterThan(0);
    await wait(900);
    expect(h.getAttribute('aria-valuetext')).toBe('Confirmed');
    await flush();
    expect(dialogOpen()).toBe(false);
    expect(settingPosts()).toEqual([
      { path: '/api/setting', body: { key: 'secretScan.enabled', value: 'off', confirm: 'weaken' } },
    ]);
  });

  it('a change that weakens nothing is sent at once, without the dialog', async () => {
    await redraw({ mode: 'full', secretScan: { enabled: false } });
    secretSwitch().click(); // back on: stronger
    await flush();
    expect(dialogOpen()).toBe(false);
    expect(settingPosts()).toEqual([{ path: '/api/setting', body: { key: 'secretScan.enabled', value: 'on' } }]);
  });

  it('switching auto-accept on opens the same dialog; Cancel leaves it off and saves nothing', async () => {
    await redraw({ mode: 'full' });
    const aa = document.getElementById('aa-enabled') as HTMLInputElement;
    expect(aa.checked).toBe(false);
    aa.click();
    await flush();
    expect(dialogOpen()).toBe(true);
    expect(aa.checked).toBe(false);
    expect(dialog().textContent).toContain('Auto-accept proposals');
    key(dialog(), 'keydown', 'Escape');
    await flush();
    expect(aa.checked).toBe(false);
    expect(settingPosts()).toEqual([]);
  });
});
