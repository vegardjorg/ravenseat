/**
 * @vitest-environment jsdom
 */
// =============================================================
// queueBoardJ14.test.ts: the tab title count, deep links, keyboard shortcuts and quick filter buttons (roadmap 0ø J1
// to J4, plans/jira-vurdering-2026-11-18.md, owner answers 18.11 as recommended).
//
// Locks: (J1) the tab title starts with "(n) " for what waits on the owner and drops it with board.titleCount off;
// (J2) #view=…&task=… opens that view and card, wins over the landing in Decisions, follows the panel and the tab, and
// the board key is taken out of the address and never written back; (J3) ? opens the shortcut overview (Esc closes it
// and focus goes back), / goes to the search, g and a letter opens a tab, j and k move between cards, nothing fires in
// a text field, and board.shortcuts off turns them off; (J4) the quick filter buttons filter the cards (several
// combine), and board.quickFilters off hides the row. The whole board runs in jsdom with a small synthetic queue.
// =============================================================
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { clientSource } from './boardClient';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const T = require('../queueBoard.js') as { board: (queue: unknown, option?: unknown) => any };
const KK = require('../queueConfig.js') as any;
/* eslint-enable @typescript-eslint/no-require-imports */

const CLIENT = join(__dirname, '..', '..', 'queue-board');
const old = new Date(Date.now() - 5 * 86_400_000).toISOString();
const task = (id: string, status: string) => ({
  id,
  title: `Task ${id}`,
  domain: `d-${id}`,
  class: 'K',
  value: 5,
  content_min: 90,
  status,
  depends_on: [],
  waiting_on: [],
  owned_files: [`file/${id}.ts`],
  owner_db: [],
  shared_patch: [],
  mission: `scripts/.queue/mission/${id}.md`,
  added_by: 'test',
  added_at: old,
});
const queue = {
  created: old,
  limits: { maxConcurrent: 5, maxDPlus: 2, maxPerDomain: 5, maxDb: 2 },
  tasks: [task('EX-1', 'waiting'), task('EX-2', 'proposed'), task('EX-3', 'waiting'), task('EX-4', 'waiting')],
  projects: { ex: { title: 'Example', prefixes: ['EX-'] } },
  areas: {},
  question: {},
  resolutions: {},
  changelog: [],
};
const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};
const $ = (id: string) => document.getElementById(id) as HTMLElement;
const press = (key: string, target: Element = document.activeElement ?? document.body, extra: object = {}) =>
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra }));
const card = (id: string) => document.querySelector(`.summary[data-id="${id}"]`) as HTMLElement | null;
const shown = (id: string) => !!card(id) && !card(id)!.closest('[hidden]');

let state: any;
const display = { titleCount: true, shortcuts: true, quickFilters: true };

beforeAll(async () => {
  const data = { ...T.board(queue), gitError: null, logo: false, features: KK.features(KK.STANDARD), boardSwitches: KK.boardSwitches(KK.STANDARD, null), boardDisplay: display };
  // EX-3 changed an hour ago with a red gate; EX-4 is older than usual and changed long ago.
  const recent = new Date(Date.now() - 3600_000).toISOString();
  for (const list of Object.values(data.columns) as any[][])
    for (const k of list) {
      k.changed_at = k.id === 'EX-3' ? recent : old;
      k.gate_red = k.id === 'EX-3';
      if (k.id === 'EX-4') k.aging = { measure: 'work', limit: 60, age: 600 };
    }
  state = { version: 'v1', data };
  const html = readFileSync(join(CLIENT, 'index.html'), 'utf8');
  document.documentElement.innerHTML = html.replace(/<!doctype[^>]*>/i, '').replace(/<\/?html[^>]*>/g, '');
  document.title = 'Queue board';
  sessionStorage.clear();
  localStorage.clear();
  // The deep link as the orchestrator would write it, with the key from a first open (it must leave the address).
  history.replaceState(null, '', `${location.pathname}#key=testKey&view=flat&task=EX-1`);
  const w = window as any;
  w.CSS = { escape: (s: string) => String(s).replace(/["\\]/g, '\\$&') };
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.setInterval = () => 0;
  w.fetch = async (filePath: string) => ({
    ok: true,
    status: 200,
    json: async () =>
      filePath.startsWith('/api/state')
        ? filePath.includes(`version=${state.version}`)
          ? { version: state.version, unchanged: true }
          : state
        : filePath.startsWith('/api/settings')
          ? { ok: false, message: 'not in this test' }
          : { ok: true, message: 'ok', info: [] },
  });
  for (const f of ['a11y.js', '../lib/queueGraph.js', 'graph.js', 'plan.js', 'performance.js', '../lib/queueDecisions.js', 'board/'])
    (0, eval)(clientSource(f));
  await flush();
}, 60_000);

describe('J2 deep links', () => {
  it('the key leaves the address at once and is kept for the tab; the link opens the view and the card', () => {
    expect(sessionStorage.getItem('queue-board-key')).toBe('testKey');
    expect(location.hash).not.toContain('key=');
    // The link wins over the landing in Decisions (a decision waits and was never seen).
    expect($('show-flat').getAttribute('aria-selected')).toBe('true');
    expect($('panel').hidden).toBe(false);
    expect($('panel').textContent).toContain('EX-1');
    expect(location.hash).toContain('task=EX-1');
  });

  it('closing the panel takes the task out of the address; the view stays', async () => {
    press('Escape', document.body);
    await flush();
    expect($('panel').hidden).toBe(true);
    expect(location.hash).not.toContain('task=');
    expect(location.hash).toContain('view=flat');
  });

  it('a new hash (back, forward or a pasted link) opens that card; the key is never written back', async () => {
    location.hash = '#view=flat&task=EX-3';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await flush();
    expect($('panel').textContent).toContain('EX-3');
    expect(location.hash).not.toContain('key');
    press('Escape', document.body);
    await flush();
  });

  it('an unknown task says so and opens nothing', async () => {
    location.hash = '#view=flat&task=NOPE-9';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await flush();
    expect($('panel').hidden).toBe(true);
    expect(document.body.textContent).toContain('NOPE-9 is not on the board');
  });
});

describe('J1 the count in the tab title', () => {
  it('starts with what waits on the owner', () => {
    expect(document.title).toBe('(1) Queue board');
  });
});

describe('J3 keyboard shortcuts', () => {
  it('? opens the overview as a dialog with the keys; Esc closes it and focus goes back', async () => {
    const from = $('search');
    from.focus();
    from.blur();
    document.body.focus();
    press('?', document.body, { shiftKey: true });
    await flush();
    const box = $('keys-background');
    expect(box.hidden).toBe(false);
    const dialog = $('keys');
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.contains(document.activeElement)).toBe(true);
    for (const k of ['?', '/', 'g d', 'g q', 'g c', 'g p', 'j', 'k', 'Enter', 'Esc', 'u']) expect(dialog.textContent, k).toContain(k);
    press('Escape', document.activeElement!);
    await flush();
    expect(box.hidden).toBe(true);
  });

  it('/ goes to the search, and keys typed there stay text', async () => {
    document.body.focus();
    press('/', document.body);
    expect(document.activeElement).toBe($('search'));
    press('j', $('search'));
    press('?', $('search'), { shiftKey: true });
    await flush();
    expect(document.activeElement).toBe($('search'));
    expect($('keys-background').hidden).toBe(true);
    $('search').blur();
  });

  it('j and k move between the cards', () => {
    document.body.focus();
    press('j', document.body);
    const first = document.activeElement as HTMLElement;
    expect(first.classList.contains('summary-button')).toBe(true);
    press('j', first);
    const second = document.activeElement as HTMLElement;
    expect(second).not.toBe(first);
    expect(second.classList.contains('summary-button')).toBe(true);
    press('k', second);
    expect(document.activeElement).toBe(first);
  });

  it('g and a letter opens a tab: d Decisions, q back to the queue view', async () => {
    document.body.focus();
    press('g', document.body);
    press('d', document.body);
    await flush();
    expect($('show-decisions').getAttribute('aria-selected')).toBe('true');
    expect(location.hash).toContain('view=decisions');
    document.body.focus();
    press('g', document.body);
    press('q', document.body);
    await flush();
    expect($('show-flat').getAttribute('aria-selected')).toBe('true');
  });

  it('a key with Ctrl, Alt or Cmd is left to the browser', () => {
    document.body.focus();
    const e = new KeyboardEvent('keydown', { key: '/', ctrlKey: true, bubbles: true, cancelable: true });
    document.body.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
    expect(document.activeElement).not.toBe($('search'));
  });
});

describe('J4 quick filter buttons', () => {
  const button = (name: string) =>
    [...$('quick-filters').querySelectorAll('button')].find((b) => b.textContent?.includes(name)) as HTMLButtonElement;

  it('the row shows three toggle buttons, none pressed', () => {
    expect($('quick-filters').hidden).toBe(false);
    for (const n of ['Changed 24 h', 'Older than usual', 'Red gate']) expect(button(n)?.getAttribute('aria-pressed'), n).toBe('false');
  });

  it('a button filters the cards, several combine, and a second click lifts it', async () => {
    expect(shown('EX-1')).toBe(true);
    button('Red gate').click();
    await flush();
    expect(button('Red gate').getAttribute('aria-pressed')).toBe('true');
    expect(shown('EX-3')).toBe(true);
    expect(shown('EX-1')).toBe(false);
    expect(shown('EX-4')).toBe(false);
    button('Changed 24 h').click();
    await flush();
    expect(shown('EX-3')).toBe(true);
    button('Red gate').click();
    button('Changed 24 h').click();
    button('Older than usual').click();
    await flush();
    expect(shown('EX-4')).toBe(true);
    expect(shown('EX-3')).toBe(false);
    button('Older than usual').click();
    await flush();
    expect(shown('EX-1')).toBe(true);
  });
});

describe('the three settings off', () => {
  beforeAll(async () => {
    state = { version: 'v2', data: { ...state.data, boardDisplay: { titleCount: false, shortcuts: false, quickFilters: false } } };
    window.dispatchEvent(new Event('focus'));
    await flush();
  });

  it('board.titleCount off: the plain title', () => {
    expect(document.title).toBe('Queue board');
  });

  it('board.shortcuts off: ? and / do nothing', async () => {
    document.body.focus();
    press('?', document.body, { shiftKey: true });
    press('/', document.body);
    await flush();
    expect($('keys-background').hidden).toBe(true);
    expect(document.activeElement).not.toBe($('search'));
  });

  it('board.quickFilters off: no row, and no hidden filter stays on', () => {
    expect($('quick-filters').hidden).toBe(true);
    expect(shown('EX-1')).toBe(true);
  });
});
