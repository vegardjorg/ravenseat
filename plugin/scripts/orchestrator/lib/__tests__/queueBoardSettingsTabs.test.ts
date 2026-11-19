/**
 * @vitest-environment jsdom
 */
// =============================================================
// queueBoardSettingsTabs.test.ts: Settings in logical tabs (board step B8, UX review 2.10: Settings were 8 292 px tall
// with 29 sections under two tabs in full mode).
//
// What the tests prove:
//   1. Settings are a real tab list (role tablist/tab/tabpanel, one tab stop, aria-controls, arrow keys, Home and End)
//      with six tabs built on the settings registry's sixteen categories; every category sits in exactly one tab, and
//      "Queue and context" holds the queue limits and machine load (B13 lands there later).
//   2. The chosen tab is remembered in this browser; an old value ("general"), a value that is no tab and a storage that
//      throws all give the first tab, and the page still draws.
//   3. "Logo and mascot" is the very last thing in Settings: the end of the last tab, and last while loading.
//   4. Each setting is in one place with its real control: no row only says "Changed in ...", no key is drawn twice, and
//      the own sections (Guidance, Checks, Columns, Cloud, Auto-accept) sit in the tab of their category.
//   5. The way in to one setting switches to its tab first and still focuses the control: "Turn it off in Settings" in
//      the Checks view, a link in the weakened banner (a registry row and an own section) and a "Has effect only when"
//      link. Lite and full mode still fold the Advanced rows and the full-only rows inside each tab.
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
// eslint-disable-next-line @typescript-eslint/no-require-imports
const RG = require('../settingsRegistry.js');

const CLIENT = join(__dirname, '..', '..', 'queue-board');

/** The tabs and the categories each one holds, in order (the owner's B8 grouping). */
const TABS: [string, string, string[]][] = [
  ['queue', 'Queue and context', ['limits', 'load', 'history']],
  ['checks', 'Checks', ['gates', 'tests', 'learning']],
  ['guards', 'Guards', ['files', 'guards', 'push', 'scope', 'private']],
  ['helpers', 'Agents', ['review']],
  ['project', 'Project', ['project', 'plans']],
  ['board', 'Board', ['board', 'cloud']],
];

function makeQueue() {
  const iso = new Date(Date.now() - 86_400_000).toISOString();
  return { created: iso, limits: {}, tasks: [], projects: {}, areas: {}, question: [], resolutions: [], changelog: [] };
}

const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};

let config = KK.merge(KK.STANDARD, { mode: 'full' });
/** While true, /api/settings never answers (the loading state stays). */
let hold = false;
const state = {
  version: 'v1',
  data: {
    ...T.board(makeQueue()),
    gitError: null,
    logo: false,
    checksPanel: true,
    boardSwitches: {},
    features: { cloud: true },
    cloudSettings: [{ key: 'collect', label: 'When a session has finished', kind: 'choice', choices: ['off', 'ask', 'auto'], value: 'ask', help: 'x' }],
  },
};

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
    checksPanel: true,
    guidance: 'guided',
    autoAccept: PR.boardData(config.proposals?.autoAccept, queue),
  };
}

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const panel = () => $('panel');
const tab = (id: string) => $(`settings-tab-${id}`) as HTMLButtonElement;
const pane = (id: string) => $(`settings-panel-${id}`);
const selected = () => panel().querySelector('[role="tab"][aria-selected="true"]')?.id.replace('settings-tab-', '');
const paneOf = (el: Element | null) => el?.closest('[role="tabpanel"]')?.id.replace('settings-panel-', '');
const press = (el: Element, k: string) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

async function closeSettings() {
  (panel().querySelector('.panel-header button[aria-label="Close"]') as HTMLButtonElement | null)?.click();
  await flush();
}
async function reopen(o: object = { mode: 'full' }) {
  config = KK.merge(KK.STANDARD, o);
  await closeSettings();
  $('settings').click();
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
  // A small stand-in for mascot.js, so the gear draws its "Logo and mascot" section.
  w.QueueMascotView = {
    MODE_OPTIONS: [
      { val: 'chatty', text: 'Chatty' },
      { val: 'off', text: 'Off' },
    ],
    mode: () => 'chatty',
    locked: () => false,
    isHidden: () => false,
    setMode() {},
    newState() {},
  };
  w.fetch = async (filePath: string, init?: { method?: string; body?: string }) => {
    if (init?.method === 'POST') return { ok: true, status: 200, json: async () => ({ ok: true, message: 'ok', info: [] }) };
    if (filePath.startsWith('/api/settings')) {
      if (hold) return new Promise(() => {});
      return { ok: true, status: 200, json: async () => settingsAnswer() };
    }
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
  for (const f of ['a11y.js', '../lib/queueGraph.js', 'graph.js', 'plan.js', 'performance.js', '../lib/queueUpdate.js', 'board/'])
    (0, eval)(clientSource(f));
  await flush();
}, 60_000);

beforeEach(async () => {
  hold = false;
  localStorage.removeItem('queue-board-settings-tab');
  await reopen();
});

describe('1. a real tab list with six logical tabs', () => {
  it('has the six tabs in order, one tab stop, each controlling its panel, only the chosen one shown', () => {
    const list = panel().querySelector('[role="tablist"]') as HTMLElement;
    expect(list.getAttribute('aria-label')).toBe('Settings');
    const tabs = [...list.querySelectorAll('[role="tab"]')] as HTMLButtonElement[];
    expect(tabs.map((x) => x.textContent)).toEqual(TABS.map((x) => x[1]));
    expect(tabs.map((x) => x.id)).toEqual(TABS.map((x) => `settings-tab-${x[0]}`));
    expect(selected()).toBe('queue');
    expect(tabs.filter((x) => x.tabIndex === 0)).toEqual([tab('queue')]);
    for (const [id] of TABS) {
      expect(tab(id).getAttribute('aria-controls')).toBe(`settings-panel-${id}`);
      expect(pane(id).getAttribute('role')).toBe('tabpanel');
      expect(pane(id).getAttribute('aria-labelledby')).toBe(`settings-tab-${id}`);
      expect(pane(id).hidden).toBe(id !== 'queue');
    }
  });

  it('every one of the sixteen categories is in exactly one tab, the one the grouping says', () => {
    expect(RG.CATEGORIES).toHaveLength(16);
    const all = TABS.flatMap((x) => x[2]);
    expect([...all].sort()).toEqual(RG.CATEGORIES.map((c: { id: string }) => c.id).sort());
    for (const [id, , cats] of TABS)
      for (const c of cats) {
        const drawn = panel().querySelectorAll(`[data-category="${c}"]`);
        // Cloud's rows all live in the Cloud section (its real switches), so the category itself may not be drawn.
        if (c === 'cloud' && drawn.length === 0) continue;
        expect(drawn.length, c).toBe(1);
        expect(paneOf(drawn[0]), c).toBe(id);
      }
    // The Cloud section with its real switches is in the Board tab.
    expect(paneOf($('cloud-module'))).toBe('board');
    // "Queue and context" holds the queue's limits and the machine load.
    expect(paneOf(panel().querySelector('[data-key="limits.maxConcurrent"]'))).toBe('queue');
    expect(paneOf(panel().querySelector('[data-category="load"]'))).toBe('queue');
  });

  it('ArrowRight, ArrowLeft, Home and End move between the tabs, select them and keep focus on the tab', async () => {
    tab('queue').focus();
    press(tab('queue'), 'ArrowRight');
    await flush();
    expect(selected()).toBe('checks');
    expect(document.activeElement).toBe(tab('checks'));
    expect(pane('checks').hidden).toBe(false);
    expect(pane('queue').hidden).toBe(true);
    expect(tab('checks').tabIndex).toBe(0);
    expect(tab('queue').tabIndex).toBe(-1);
    press(tab('checks'), 'End');
    await flush();
    expect(selected()).toBe('board');
    expect(document.activeElement).toBe(tab('board'));
    press(tab('board'), 'ArrowRight');
    await flush();
    expect(selected()).toBe('queue');
    press(tab('queue'), 'ArrowLeft');
    await flush();
    expect(selected()).toBe('board');
    press(tab('board'), 'Home');
    await flush();
    expect(selected()).toBe('queue');
    expect(document.activeElement).toBe(tab('queue'));
  });

  it('a click selects a tab too', async () => {
    tab('guards').click();
    await flush();
    expect(selected()).toBe('guards');
    expect(pane('guards').hidden).toBe(false);
  });
});

describe('2. the chosen tab is remembered in this browser, and the page works without it', () => {
  it('is saved and opens again on that tab', async () => {
    tab('project').click();
    await flush();
    expect(localStorage.getItem('queue-board-settings-tab')).toBe('project');
    await reopen();
    expect(selected()).toBe('project');
  });

  it('an old value (general), a value that is no tab, or a storage that throws gives the first tab', async () => {
    for (const v of ['general', 'nonsense']) {
      localStorage.setItem('queue-board-settings-tab', v);
      await reopen();
      expect(selected(), v).toBe('queue');
    }
    // The old "Helper agents" tab keeps its id, so a viewer who had it open lands on Agents.
    localStorage.setItem('queue-board-settings-tab', 'helpers');
    await reopen();
    expect(selected()).toBe('helpers');
    const proto = Object.getPrototypeOf(localStorage);
    const get = proto.getItem;
    const set = proto.setItem;
    proto.getItem = () => {
      throw new Error('blocked');
    };
    proto.setItem = () => {
      throw new Error('blocked');
    };
    try {
      await reopen();
      expect(selected()).toBe('queue');
      tab('board').click();
      await flush();
      expect(selected()).toBe('board');
    } finally {
      proto.getItem = get;
      proto.setItem = set;
    }
  });
});

describe('3. "Logo and mascot" is the very last thing in Settings', () => {
  it('ends the last tab (Board), after the Cloud section', () => {
    const last = pane(TABS.at(-1)![0]);
    const mascot = last.lastElementChild as HTMLElement;
    expect(mascot.querySelector('legend')?.textContent).toBe('Logo and mascot');
    expect(panel().lastElementChild).toBe(last);
  });

  it('is last while the settings are still loading, too', async () => {
    hold = true;
    await closeSettings();
    $('settings').click();
    await flush();
    const legend = (panel().lastElementChild as HTMLElement).querySelector('legend');
    expect(legend?.textContent).toBe('Logo and mascot');
    hold = false;
  });
});

describe('4. each setting is in one place, with its real control', () => {
  it('no row only says "Changed in ...", and no key is drawn twice', () => {
    expect(panel().textContent).not.toMatch(/Changed in /);
    const keys = [...panel().querySelectorAll('[data-key]')].map((x) => x.getAttribute('data-key'));
    expect(keys.length).toBeGreaterThan(100);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of ['guidance', 'board.mascot', 'board.blockedColumn', 'checksPanel.mode', 'features.cloud', 'helpers'])
      expect(panel().querySelector(`[data-key="${k}"]`), k).toBeNull();
    // A module with its own registry row (a real switch) is not listed again under "Modules (read only)".
    expect(panel().querySelector('[data-key="features.focus"]')).not.toBeNull();
    expect($('setting-modules')).toBeNull();
  });

  it('the own sections sit in the tab of their category', () => {
    expect(paneOf($('guidance-quiet'))).toBe('board');
    expect(paneOf($('board-blocked-column'))).toBe('board');
    expect(paneOf($('checks-panel'))).toBe('checks');
    // Auto-accept decides what the queue approves by itself, so it is with the queue.
    expect(paneOf($('aa-enabled'))).toBe('queue');
    expect(paneOf($('setting-helpers'))).toBe('helpers');
    expect(paneOf($('cloud-setting-collect'))).toBe('board');
    // Cloud is one section with one heading: the category's rows without a switch there (the hidden paths) sit in it.
    const cloud = [...pane('board').querySelectorAll('h3')].filter((h) => h.textContent === 'Cloud');
    expect(cloud).toHaveLength(1);
    expect(cloud[0].closest('[data-category="cloud"]')?.querySelector('[data-key="cloudHidden"]')).not.toBeNull();
    expect(paneOf($('setting-undo'))).toBe('queue');
    // The theme is in the Board tab; Help stays above the tabs, reachable from every tab.
    expect(paneOf(panel().querySelector('.theme-option input[name="theme-option"]'))).toBe('board');
    expect(paneOf($('setting-help'))).toBeUndefined();
  });

  it('full mode folds the Advanced rows inside the tab; lite folds the full-only rows', async () => {
    const adv = pane('queue').querySelector('[data-category="limits"] details[data-fold="advanced"]') as HTMLDetailsElement;
    expect(adv).not.toBeNull();
    expect(adv.open).toBe(false);
    expect(panel().textContent).toContain('Mode: full.');
    await reopen({ mode: 'lite' });
    expect(panel().textContent).toContain('Mode: lite.');
    expect(pane('queue').querySelector('[data-category="limits"] details[data-fold="fullonly"]')).not.toBeNull();
    // The mode line sits above the tabs, so it is seen from every tab.
    expect(paneOf(panel().querySelector('.settings-mode'))).toBeUndefined();
  });
});

describe('5. a way in to one setting switches to its tab first and focuses the control', () => {
  it('"Turn it off in Settings" in the Checks view opens the Checks tab on the switch', async () => {
    localStorage.setItem('queue-board-settings-tab', 'project');
    await closeSettings();
    $('show-checks').click();
    await flush();
    const line = document.querySelector('.checks-view .checks-off-hint button') as HTMLButtonElement;
    expect(line).not.toBeNull();
    line.click();
    await flush();
    expect(selected()).toBe('checks');
    expect(pane('checks').hidden).toBe(false);
    expect(document.activeElement).toBe($('checks-panel'));
  });

  it('a link in the weakened banner switches to the row\'s tab and focuses its control', async () => {
    await reopen({ mode: 'full', secretScan: { enabled: false } });
    expect(selected()).toBe('queue');
    const banner = $('settings-weakened');
    // The banner is above the tabs, so it is seen from every tab.
    expect(paneOf(banner)).toBeUndefined();
    const link = [...banner.querySelectorAll('a')].find((a) => a.textContent === RG.rowFor('secretScan.enabled').title) as HTMLAnchorElement;
    link.click();
    await flush();
    expect(selected()).toBe('guards');
    // secretScan.enabled is an Advanced row: its closed fold is opened so the switch can take focus.
    expect(($('reg-secretScan-enabled').closest('details') as HTMLDetailsElement).open).toBe(true);
    expect(document.activeElement).toBe($('reg-secretScan-enabled'));
    expect(location.hash).not.toContain('setting');
  });

  it('a weakened setting with its own section links to that section\'s control', async () => {
    await reopen({ mode: 'full', proposals: { autoAccept: { enabled: true } } });
    const banner = $('settings-weakened');
    const link = [...banner.querySelectorAll('a')].find((a) => a.textContent === RG.rowFor('proposals.autoAccept.enabled').title) as HTMLAnchorElement;
    expect(link).toBeTruthy();
    tab('board').click();
    await flush();
    link.click();
    await flush();
    expect(selected()).toBe('queue');
    expect(document.activeElement).toBe($('aa-enabled'));
  });

  it('a "Has effect only when" link opens the fold its row is in and focuses the control', async () => {
    tab('checks').click();
    await flush();
    const needs = panel().querySelector('[data-key="gates.fixWithoutTestWarning"] .registry-requires a') as HTMLAnchorElement;
    expect(needs.getAttribute('href')).toBe('#setting-row-gates-redOnBase');
    needs.click();
    await flush();
    expect(selected()).toBe('checks');
    // gates.redOnBase is edited in queue.config.json (no control on the board), so its row takes focus itself, without
    // becoming a tab stop; the Advanced fold it sits in is opened.
    const parent = $('setting-row-gates-redOnBase');
    expect(document.activeElement).toBe(parent);
    expect(parent.tabIndex).toBe(-1);
    expect((parent.closest('details') as HTMLDetailsElement).open).toBe(true);
  });
});
