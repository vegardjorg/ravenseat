/**
 * @vitest-environment jsdom
 */
// =============================================================
// queueBoardHelpPanel.test.ts: the "How to use the board" help (board steps B9 and B30, UX review H1: the help was a
// wall of 13 sections that started with the most advanced one, with no contents and no way in from the rooms).
//
// What the tests prove:
//   1. B9: help opened from Settings has "Back to menu", which goes back to Settings with focus on the button that
//      opened the help. Opened from anywhere else there is no Back to menu, and Esc and Close still return focus.
//   2. B30: a contents list sits at the top. Each entry jumps to its section and moves focus to the section heading,
//      and the board's hash (where the key lives) is never touched.
//   3. B30: the sections come in the order of use: what the board shows, Waiting on you and Decisions, picking and
//      running work first; Areas is the last section before the legend.
//   4. B30: each room's own header has a small "?" ("Help for <room>") that opens the help at that room's section,
//      with focus on its heading; closing the help puts focus back on the "?".
// The whole board runs in jsdom with a mock server (no network); the state is built by the server's own function.
// =============================================================
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { clientSource } from './boardClient';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const T = require('../queueBoard.js') as { board: (queue: unknown, option?: unknown) => any };

const CLIENT = join(__dirname, '..', '..', 'queue-board');

function makeQueue() {
  const iso = new Date(Date.now() - 86_400_000).toISOString();
  return {
    created: iso,
    limits: {},
    tasks: [{ id: 'EX-1', title: 'A task', status: 'waiting', class: 'K', project: 'ex', estimate_min: 30, registered: iso }],
    projects: { ex: { title: 'Example' } },
    areas: {},
    question: [],
    resolutions: [],
    changelog: [],
  };
}

const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};

const state = {
  version: 'v1',
  data: { ...T.board(makeQueue()), gitError: null, logo: false, checksPanel: true, boardSwitches: {}, features: {} },
};

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const panel = () => $('panel');
const press = (el: Element, k: string) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
const helpOpen = () => !panel().hidden && $('panel-title')?.textContent === 'How to use the board';
const sectionIds = () => [...panel().querySelectorAll('section.help-del')].map((s) => s.id);
const button = (root: ParentNode, text: string) =>
  [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined;

async function closeAll() {
  (panel().querySelector('.panel-header button[aria-label="Close"]') as HTMLButtonElement | null)?.click();
  await flush();
}
async function room(tabId: string) {
  $(tabId).click();
  await flush();
}

beforeAll(async () => {
  const html = readFileSync(join(CLIENT, 'index.html'), 'utf8');
  document.documentElement.innerHTML = html.replace(/<!doctype[^>]*>/i, '').replace(/<\/?html[^>]*>/g, '');
  sessionStorage.setItem('queue-board-key', 'testKey');
  localStorage.clear();
  const w = window as any;
  w.CSS = { escape: (s: string) => String(s).replace(/["\\]/g, '\\$&') };
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {} });
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.setInterval = () => 0;
  w.QueueMascotView = {
    MODE_OPTIONS: [{ val: 'chatty', text: 'Chatty' }],
    mode: () => 'chatty',
    locked: () => false,
    isHidden: () => false,
    setMode() {},
    newState() {},
  };
  w.fetch = async (filePath: string, init?: { method?: string }) => {
    if (init?.method === 'POST') return { ok: true, status: 200, json: async () => ({ ok: true, message: 'ok', info: [] }) };
    // Settings and statistics never answer: the parts that need no server are drawn, which is all these tests read.
    if (filePath.startsWith('/api/settings') || filePath.startsWith('/api/statistics')) return new Promise(() => {});
    if (filePath.startsWith('/api/checks'))
      return { ok: true, status: 200, json: async () => ({ report: { found: { kinds: [], ci: [] }, suggestions: [], categories: [] } }) };
    if (filePath.startsWith('/api/state'))
      return {
        ok: true,
        status: 200,
        json: async () => (filePath.includes(`version=${state.version}`) ? { version: state.version, unchanged: true } : state),
      };
    return { ok: true, status: 200, json: async () => ({}) };
  };
  for (const f of ['a11y.js', '../lib/queueGraph.js', 'graph.js', 'plan.js', 'performance.js', '../lib/queueUpdate.js', '../lib/queueDecisions.js', 'board/'])
    (0, eval)(clientSource(f));
  await flush();
}, 60_000);

beforeEach(async () => {
  await closeAll();
  await room('room-queue');
  await room('show-flat');
});

/** Opens Settings from the gear and the help from its "How to use the board" button. */
async function helpFromSettings() {
  $('settings').click();
  await flush();
  button(panel(), 'How to use the board')!.click();
  await flush();
}

describe('1. B9: Back to menu', () => {
  it('help opened from Settings goes back to Settings with focus on the button that opened it', async () => {
    await helpFromSettings();
    expect(helpOpen()).toBe(true);
    const back = button(panel(), 'Back to menu');
    expect(back).toBeDefined();
    // It sits in the panel header, before the contents, so it is near the start of the tab order.
    expect(back!.closest('.panel-header')).not.toBeNull();
    back!.click();
    await flush();
    expect($('panel-title').textContent).toBe('Settings');
    expect(document.activeElement?.textContent?.trim()).toBe('How to use the board');
    expect(panel().contains(document.activeElement)).toBe(true);
  });

  it('Esc from help opened in Settings closes the panel and focus goes back to the gear', async () => {
    $('settings').focus();
    await helpFromSettings();
    press(panel(), 'Escape');
    await flush();
    expect(panel().hidden).toBe(true);
    expect(document.activeElement).toBe($('settings'));
  });

  it('help opened from a room has no Back to menu (the gear did not open it)', async () => {
    await room('show-decisions');
    (document.querySelector('[aria-label="Help for Decisions"]') as HTMLButtonElement).click();
    await flush();
    expect(helpOpen()).toBe(true);
    expect(button(panel(), 'Back to menu')).toBeUndefined();
  });
});

describe('2. B30: the contents list', () => {
  it('sits right under the header and links every section and the legend, in order', async () => {
    await helpFromSettings();
    const nav = panel().querySelector('nav[aria-label="Contents"]') as HTMLElement;
    expect(nav).not.toBeNull();
    expect(nav.previousElementSibling?.classList.contains('panel-header')).toBe(true);
    const links = [...nav.querySelectorAll('a')];
    expect(links.map((a) => a.getAttribute('href'))).toEqual([...sectionIds(), 'help-legend'].map((id) => `#${id}`));
    for (const a of links) expect(a.textContent?.trim().length).toBeGreaterThan(0);
  });

  it('a link moves focus to its section heading and leaves the hash alone', async () => {
    await helpFromSettings();
    const before = location.hash;
    const link = panel().querySelector('nav[aria-label="Contents"] a[href="#help-keyboard"]') as HTMLAnchorElement;
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(click);
    await flush();
    expect(click.defaultPrevented).toBe(true);
    expect(location.hash).toBe(before);
    const heading = $('help-keyboard').querySelector('h3') as HTMLElement;
    expect(document.activeElement).toBe(heading);
    // The heading takes focus without becoming a tab stop.
    expect(heading.tabIndex).toBe(-1);
    expect($('help-keyboard').getAttribute('aria-labelledby')).toBe(heading.id);
  });
});

describe('3. B30: sections in the order of use', () => {
  it('starts with the basics and ends with Areas before the legend', async () => {
    await helpFromSettings();
    const ids = sectionIds();
    expect(ids.slice(0, 3)).toEqual(['help-board', 'help-waiting', 'help-work']);
    expect(ids[ids.length - 1]).toBe('help-areas');
    // Every room with a "?" has its section.
    for (const id of ['help-focus', 'help-plans', 'help-checks', 'help-statistics']) expect(ids).toContain(id);
    // The advanced parts come after the rooms (QA-1d: the "Filter, tabs and grouping" section was "Selection, ...").
    for (const late of ['help-filters', 'help-bulk', 'help-batch', 'help-keyboard'])
      expect(ids.indexOf(late)).toBeGreaterThan(ids.indexOf('help-statistics'));
    // The legend follows the sections, and is the last thing linked.
    const legend = $('help-legend');
    expect(legend).not.toBeNull();
    expect(legend.compareDocumentPosition($('help-areas')) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
  });

  it('the first section says what the rooms are and where the help lives', async () => {
    await helpFromSettings();
    const text = $('help-board').textContent ?? '';
    for (const word of ['Queue', 'Decisions', 'Plans', 'Checks', 'In queue', 'In progress', 'Review', 'Built', 'Settings'])
      expect(text).toContain(word);
  });
});

describe('4. B30: a "?" in each room header', () => {
  /** Clicks the room's "?", checks the help opens on its section with focus on the heading, then closes again. */
  async function check(name: string, sectionId: string, header: string) {
    const q = document.querySelector(`[aria-label="Help for ${name}"]`) as HTMLButtonElement;
    expect(q, name).not.toBeNull();
    expect(q.closest(header), name).not.toBeNull();
    // Never in the fixed top (B6/B16).
    expect(q.closest('.top'), name).toBeNull();
    expect(q.textContent?.trim()).toBe('?');
    q.focus();
    q.click();
    await flush();
    expect(helpOpen(), name).toBe(true);
    expect(document.activeElement, name).toBe($(sectionId).querySelector('h3'));
    press(panel(), 'Escape');
    await flush();
    expect(panel().hidden, name).toBe(true);
    expect((document.activeElement as HTMLElement)?.getAttribute('aria-label'), name).toBe(`Help for ${name}`);
  }

  it('the queue: in the In queue column header', async () => {
    await check('the queue', 'help-work', '.col-header');
  });

  it('Decisions: in the room header', async () => {
    await room('show-decisions');
    await check('Decisions', 'help-waiting', '.decide-head');
  });

  it('Checks: in the room header', async () => {
    await room('show-checks');
    await check('Checks', 'help-checks', '.checks-head');
  });

  it('Focus: in the focus toolbar', async () => {
    await room('show-plan');
    await check('Focus', 'help-focus', '.plan-tool');
  });

  it('Statistics: in a header of its own, also while the figures load', async () => {
    await room('show-statistics');
    await check('Statistics', 'help-statistics', '.stat-head');
  });

  it('Plans: the Plans room draws its "?" in the breadcrumb line', () => {
    const src = readFileSync(join(CLIENT, 'plans', 'plans.js'), 'utf8');
    expect(src).toMatch(/roomHelp\('plans', 'Plans'/);
  });

  it('each "?" is one shared style: 24 px drawn, a 36 px hit area, and no colour of its own', () => {
    const css = readFileSync(join(CLIENT, 'board.css'), 'utf8');
    const block = (sel: string) => css.slice(css.indexOf(`${sel} {`), css.indexOf('}', css.indexOf(`${sel} {`)));
    expect(block('.room-help')).toContain('width: 24px');
    // 24 + 2 x 6 = 36 px to hit with a mouse.
    expect(block('.room-help::after')).toContain('inset: -6px');
    for (const sel of ['.room-help', '.room-help::after', '.help-contents', '.help-back'])
      expect(block(sel), sel).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });
});
