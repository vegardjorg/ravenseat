/**
 * @vitest-environment jsdom
 */
// =============================================================
// queueBoardChecksGroups.test.ts: the Checks room (board steps B10, B11 and B34, UX review C1 and C3).
//
// What the tests prove:
//   - B10: the suggestions are grouped by category, one real heading (h4) per group, in the order of
//     checks-catalog/categories.json; a category with no suggestion gets no group; a quiet low card stays in the
//     "More ideas" fold and is not in a group; a card's title in a group is the heading level under its group.
//   - B11: "How it works" sits at the top, under the header: a button with aria-expanded and aria-controls, and a
//     region named by it. It is open until the owner closes it; the choice is remembered in localStorage and survives
//     a redraw, and with storage that throws it still opens and closes (held in memory). Four steps, each with an icon,
//     in the order the code runs them (the click is the yes, the plan changes no files, you choose the steps, the
//     approved ones are built), and one line for the cards that need no agent ("Turn on", "Use as gates").
//   - B34 (C1): the Important box names each open important suggestion as a button that scrolls to its card and puts
//     focus on it (also when the category filter hid it), and "Go to suggestions" moves focus to the suggestions
//     heading.
//   - B34 (C3): while the first read runs, the view shows placeholders in the cards' shape (hidden from a screen
//     reader) and one polite status line, not an empty view; they go when the report comes.
//   - The header still has only "Read again" next to the room's "?" (B28).
// CSS rules are read from board.css (render tests do not work in jsdom); the behaviour runs the whole board in jsdom.
// =============================================================
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { clientSource } from './boardClient';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const T = require('../queueBoard.js') as { board: (queue: unknown, option?: unknown) => any };

const CLIENT = join(__dirname, '..', '..', 'queue-board');
const html = readFileSync(join(CLIENT, 'index.html'), 'utf8');
const css = readFileSync(join(CLIENT, 'board.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const categories = JSON.parse(readFileSync(join(__dirname, '..', '..', 'checks-catalog', 'categories.json'), 'utf8')) as {
  key: string;
  title: string;
  text: string;
}[];
const iso = new Date(Date.now() - 86_400_000).toISOString();
const HOW_KEY = 'queue-board-checks-how';

function makeQueue() {
  return {
    created: iso,
    limits: { maxConcurrent: 5, maxDPlus: 2, maxPerDomain: 5, maxDb: 2 },
    tasks: [],
    projects: { ex: { title: 'Example', prefixes: ['EX-'] } },
    areas: {},
    question: [],
    resolutions: [],
    changelog: [],
  };
}

const card = (key: string, category: string, priority: string, extra: object = {}) => ({
  key,
  title: `Card ${key}`,
  category,
  priority,
  state: 'open',
  applies: true,
  why: `Why ${key}`,
  investigate: 'Look at it.',
  plan: 'Plan it.',
  contentMin: 60,
  ...extra,
});
// The server sorts by priority; the groups keep that order inside each group.
const suggestions = [
  card('use-gates', 'setup', 'high', { action: 'gates' }),
  card('first-test', 'tests', 'high'),
  card('lint', 'quality', 'medium'),
  card('dep-audit', 'dependencies', 'medium', { state: 'queued', taskId: 'KS-PLAN-DEP-AUDIT' }),
  // a second card in one group: that group takes the whole row (the width), the one-card groups sit side by side.
  card('dep-pin', 'dependencies', 'low'),
  card('secret-scan-receive', 'security', 'low', { action: 'setting', setting: 'secretScan.atReceive' }),
  card('formatter', 'quality', 'low', { quiet: true }),
];
const report = { found: { kinds: [], ci: [] }, suggestions, categories, knownBugs: {} };

const state = { version: 'v1', data: { ...T.board(makeQueue()), gitError: null, logo: false, checksPanel: true } };
let releaseChecks: () => void = () => {};
const checksGate = new Promise<void>((r) => (releaseChecks = r));

const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};
const $ = (id: string) => document.getElementById(id) as HTMLElement;
const view = () => document.querySelector('.checks-view') as HTMLElement;

beforeAll(async () => {
  document.documentElement.innerHTML = html.replace(/<!doctype[^>]*>/i, '').replace(/<\/?html[^>]*>/g, '');
  sessionStorage.setItem('queue-board-key', 'testKey');
  localStorage.clear();
  const w = window as any;
  w.CSS = { escape: (s: string) => String(s).replace(/["\\]/g, '\\$&') };
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {} });
  w.HTMLElement.prototype.scrollIntoView = function () {
    (this as HTMLElement).dataset.scrolled = '1';
  };
  w.setInterval = () => 0;
  w.fetch = async (filePath: string) => {
    // The first read of the checks waits until the test lets it go, so the loading state can be looked at.
    if (filePath.startsWith('/api/checks')) await checksGate;
    return {
      ok: true,
      status: 200,
      json: async () => {
        if (filePath.startsWith('/api/state'))
          return filePath.includes(`version=${state.version}`) ? { version: state.version, unchanged: true } : state;
        if (filePath.startsWith('/api/checks')) return { report };
        if (filePath.startsWith('/api/settings')) return { error: 'not in this test' };
        return { ok: true };
      },
    };
  };
  for (const f of ['a11y.js', '../lib/queueGraph.js', 'graph.js', 'plan.js', 'performance.js', 'board/'])
    (0, eval)(clientSource(f));
  await flush();
  $('show-checks').click();
  await flush();
}, 60_000);

describe('B34 (C3): placeholders while the checks are read', () => {
  it('shows placeholders in the cards shape and one status line, not an empty view', () => {
    const v = view();
    expect(v.getAttribute('aria-busy')).toBe('true');
    const skeleton = v.querySelector('.checks-skeleton') as HTMLElement;
    expect(skeleton).not.toBeNull();
    expect(skeleton.getAttribute('aria-hidden')).toBe('true');
    expect(skeleton.querySelectorAll('.checks-skeleton-card').length).toBeGreaterThanOrEqual(3);
    const status = v.querySelector('[role="status"]') as HTMLElement;
    expect(status?.textContent).toMatch(/Reading the project/);
    // "How it works" needs no report, so it is there from the start and does not move when the cards come.
    expect(v.querySelector('.checks-how')).not.toBeNull();
  });

  it('the placeholders take the space without animating for someone who asked for less motion', () => {
    expect(css).toMatch(/\.checks-skeleton-card\s*\{[^}]*min-height/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: no-preference\)\s*\{[^@]*\.checks-skeleton/);
  });

  it('they go when the report comes', async () => {
    releaseChecks();
    await flush();
    expect(view().querySelector('.checks-skeleton')).toBeNull();
    expect(view().getAttribute('aria-busy')).toBeNull();
  });
});

describe('B28: the header keeps one action', () => {
  it('only "Read again" next to the room "?"', () => {
    const head = view().querySelector('.checks-head') as HTMLElement;
    const buttons = [...head.querySelectorAll('button:not(.room-help)')].map((b) => b.textContent?.trim());
    expect(buttons).toEqual(['Read again']);
  });
});

describe('B10: the suggestions grouped by category', () => {
  it('one real heading per group, in the order of categories.json, and no empty group', () => {
    const groups = [...view().querySelectorAll('.checks-group')] as HTMLElement[];
    const headings = groups.map((g) => g.querySelector('.checks-group-title') as HTMLElement);
    expect(headings.every((h) => h.tagName === 'H4')).toBe(true);
    const title = (k: string) => categories.find((c) => c.key === k)?.title;
    expect(headings.map((h) => h.textContent)).toEqual(
      ['setup', 'tests', 'quality', 'security', 'dependencies'].map(title),
    );
    // Each group is a section named by its heading.
    for (const g of groups) expect($(g.getAttribute('aria-labelledby') as string)?.textContent).toBe(g.querySelector('h4')?.textContent);
  });

  it('a card sits in its own group, its title one level under the group heading', () => {
    const group = [...view().querySelectorAll('.checks-group')].find((g) => g.querySelector('h4')?.textContent === 'Code quality') as HTMLElement;
    const titles = [...group.querySelectorAll('.checks-card-title')];
    expect(titles.map((h) => h.textContent)).toEqual(['Card lint']);
    expect(titles[0].tagName).toBe('H5');
  });

  // Owner QA 21.11: most groups hold one card, so each group stacked under the last left one narrow column in a wide
  // view. The groups now sit in the same grid as the cards: one-card groups side by side, a group with more cards
  // takes the whole row and lays its cards out in its own grid. Nothing has a fixed width, so 390 px is one column.
  it('the groups use the width: one-card groups side by side, a larger group across the row', () => {
    const groups = [...view().querySelectorAll('.checks-group')] as HTMLElement[];
    const wide = groups.filter((g) => g.classList.contains('checks-group-wide')).map((g) => g.querySelector('h4')?.textContent);
    expect(wide).toEqual([categories.find((c) => c.key === 'dependencies')?.title]);
    const rule = (sel: string) => new RegExp(`(^|[},])\\s*${sel.replace(/[.\\-]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(css)?.[2] ?? '';
    const groupsRule = rule('.checks-groups');
    expect(groupsRule).toMatch(/display:\s*grid/);
    expect(groupsRule).toMatch(/grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(min\(100%,\s*320px\),\s*1fr\)\)/);
    expect(rule('.checks-group-wide')).toMatch(/grid-column:\s*1\s*\/\s*-1/);
    // a group is a grid item that may shrink below its content, so a long word never scrolls the page sideways
    expect(rule('.checks-group')).toMatch(/min-width:\s*0/);
  });

  it('a quiet card stays in the More ideas fold, not in a group', () => {
    const more = view().querySelector('.checks-more') as HTMLElement;
    expect(more.textContent).toMatch(/Card formatter/);
    for (const g of view().querySelectorAll('.checks-group')) expect(g.textContent).not.toMatch(/Card formatter/);
  });
});

describe('B11: How it works', () => {
  const toggle = () => $('checks-how-toggle') as HTMLButtonElement;
  const body = () => $('checks-how-body');

  it('sits at the top under the header, open, as a button that controls a region', () => {
    const how = view().querySelector('.checks-how') as HTMLElement;
    // The severity tally sits inside the header, on the heading's line (owner QA 19.11), and "How it works" comes
    // right under the header.
    const head = view().querySelector('.checks-head') as HTMLElement;
    expect(head.querySelector('.checks-tally')).not.toBeNull();
    expect(head.querySelector('.checks-tally-caption')?.textContent).toBe('Recommendations for your project');
    expect(head.nextElementSibling).toBe(how);
    expect(toggle().tagName).toBe('BUTTON');
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    expect(toggle().getAttribute('aria-controls')).toBe('checks-how-body');
    expect(toggle().closest('h3')).not.toBeNull();
    expect(body().getAttribute('role')).toBe('region');
    expect(body().getAttribute('aria-labelledby')).toBe('checks-how-toggle');
    expect(body().hidden).toBe(false);
  });

  it('four steps with an icon each, in the order the code runs them', () => {
    const steps = [...body().querySelectorAll('ol > li')] as HTMLElement[];
    expect(steps).toHaveLength(4);
    for (const s of steps) expect(s.querySelector('svg.icon')).not.toBeNull();
    const text = steps.map((s) => s.textContent ?? '');
    expect(text[0]).toMatch(/Add investigation to queue/);
    expect(text[0]).toMatch(/KS-PLAN-/);
    expect(text[0]).toMatch(/your yes/);
    expect(text[1]).toMatch(/plan/);
    expect(text[1]).toMatch(/not worth it/);
    expect(text[1]).toMatch(/no files/);
    expect(text[2]).toMatch(/You choose/);
    expect(text[3]).toMatch(/built in the queue/);
    // The cards that need no agent, in one line.
    expect(body().textContent).toMatch(/"Turn on" and "Use as gates"/);
  });

  it('closes on a click, remembers it in localStorage, and stays closed across a redraw', async () => {
    toggle().click();
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(body().hidden).toBe(true);
    expect(localStorage.getItem(HOW_KEY)).toBe('closed');
    (view().querySelector('.checks-head button:not(.room-help)') as HTMLButtonElement).click();
    await flush();
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(body().hidden).toBe(true);
    toggle().click();
    expect(localStorage.getItem(HOW_KEY)).toBe('open');
    expect(body().hidden).toBe(false);
  });

  it('opens and closes also when the storage throws', async () => {
    const w = window as any;
    const real = Object.getOwnPropertyDescriptor(w, 'localStorage');
    Object.defineProperty(w, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('blocked');
      },
    });
    try {
      toggle().click();
      expect(body().hidden).toBe(true);
      (view().querySelector('.checks-head button:not(.room-help)') as HTMLButtonElement).click();
      await flush();
      expect(body().hidden).toBe(true);
      toggle().click();
      expect(body().hidden).toBe(false);
    } finally {
      if (real) Object.defineProperty(w, 'localStorage', real);
    }
  });

  it('only its own height changes: the box keeps no fixed height and the steps sit in a grid', () => {
    expect(css).toMatch(/\.checks-how-steps\s*\{[^}]*display:\s*grid/);
    expect(css).toMatch(/\.checks-how-toggle\s*\{[^}]*min-height:\s*36px/);
  });
});

describe('B34 (C1): the Important box leads to the suggestions', () => {
  const summary = () => view().querySelector('.checks-summary') as HTMLElement;

  it('names each open important suggestion as a button to its card', () => {
    const buttons = [...summary().querySelectorAll('.checks-summary-go')] as HTMLButtonElement[];
    expect(buttons.map((b) => b.textContent)).toEqual(['Card use-gates', 'Card first-test']);
    buttons[1].click();
    const target = $('checks-card-first-test');
    expect(target.dataset.scrolled).toBe('1');
    expect(document.activeElement).toBe(target);
  });

  it('shows the card also when the category filter hid it', async () => {
    const select = $('checks-category') as HTMLSelectElement;
    select.value = 'quality';
    select.dispatchEvent(new Event('change'));
    await flush();
    expect(document.getElementById('checks-card-first-test')).toBeNull();
    ([...summary().querySelectorAll('.checks-summary-go')][1] as HTMLButtonElement).click();
    await flush();
    expect(document.activeElement).toBe($('checks-card-first-test'));
    expect(($('checks-category') as HTMLSelectElement).value).toBe('all');
  });

  it('"Go to suggestions" moves focus to the suggestions heading', () => {
    const go = [...summary().querySelectorAll('button')].find((b) => b.textContent === 'Go to suggestions') as HTMLButtonElement;
    expect(go).toBeDefined();
    go.click();
    expect(document.activeElement).toBe($('checks-suggestions-title'));
  });
});
