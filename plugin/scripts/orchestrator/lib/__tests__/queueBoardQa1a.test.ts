/**
 * @vitest-environment jsdom
 */
// =============================================================
// queueBoardQa1a.test.ts: three fixes from the owner's QA of the board (QA-1a).
//
// What the tests prove:
//   Q1. The settings gear toggles: a click while Settings is open closes the panel (as the X does), a click while it
//       is closed opens it, a click while another panel (a card) is open opens Settings, and the gear carries
//       aria-expanded that follows the panel. A second click during the loading state also closes.
//   Q2. Checks severity is visible: a tally of the open suggestions per level (High, Medium, Low) stands at the top of
//       the view, with one screen-reader sentence and zero counts shown muted; each card's level word is a pill whose
//       class names its level (checks-pill-high, -medium, -low), and the tally uses the same pill classes. The CSS
//       gives each pill its tone pair (danger, caution, warn) and uses tokens only.
//   Q3. Focus shows a drop bar while a step is dragged: it sits exactly where releaseIndex will drop the step (the
//       same midpoint rule), moves on dragover, is gone on dragleave, drop and dragend, and is not shown when the drop
//       would not move the step. The drop itself lands where the bar was.
// The whole board runs in jsdom with a small synthetic queue (no network), as in queueFocusB19.test.ts.
// =============================================================
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { clientSource } from './boardClient';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const T = require('../queueBoard.js') as { board: (queue: unknown, option?: unknown) => any };

const CLIENT = join(__dirname, '..', '..', 'queue-board');
const iso = new Date(Date.now() - 86_400_000).toISOString();

function task(id: string, project: string, feature: string) {
  return {
    id,
    title: `Task ${id}`,
    project,
    feature,
    domain: project,
    class: 'K',
    value: 5,
    content_min: 60,
    status: 'waiting',
    depends_on: [],
    waiting_on: [],
    owned_files: [`file/${id}.ts`],
    owner_db: [],
    shared_patch: [],
    mission: `scripts/.queue/mission/${id}.md`,
    added_by: 'test',
    added_at: iso,
  };
}

/** Three focus steps (Theme, Today, billing), so a drag in "In focus" has rows to land between. */
function makeQueue() {
  return {
    created: iso,
    limits: { maxConcurrent: 5, maxDPlus: 2, maxPerDomain: 5, maxDb: 2 },
    tasks: [task('UI-1', 'ui', 'Theme'), task('UI-3', 'ui', 'Today'), task('BILL-1', 'billing', 'Plans')],
    projects: {
      ui: { title: 'Habit screens', prefixes: ['UI-'] },
      billing: { title: 'Subscriptions', prefixes: ['BILL-'] },
    },
    areas: {},
    question: [],
    resolutions: [],
    changelog: [],
    focus: { order: ['feature:ui/Theme', 'feature:ui/Today', 'project:billing'], rest: 'wait', from: iso, now_count: 2 },
  };
}

const card = (key: string, priority: string, extra: object = {}) => ({
  key,
  title: `Card ${key}`,
  category: 'tests',
  priority,
  state: 'open',
  applies: true,
  why: `Why ${key}`,
  investigate: 'Look at it.',
  plan: 'Plan it.',
  contentMin: 60,
  ...extra,
});
// Open: 2 high, 1 medium, 0 low. Not counted: a set-aside high, a queued medium, a set-aside low and a high that
// does not apply now.
const suggestions = [
  card('h1', 'high'),
  card('h2', 'high'),
  card('h-aside', 'high', { state: 'dismissed' }),
  card('h-na', 'high', { applies: false }),
  card('m1', 'medium'),
  card('m-queued', 'medium', { state: 'queued', taskId: 'KS-PLAN-M' }),
  card('l-aside', 'low', { state: 'dismissed' }),
];
const categories = [{ key: 'tests', title: 'Tests', text: 'Tests.' }];
const report = { found: { kinds: [], ci: [] }, suggestions, categories, knownBugs: {} };

const state = {
  version: 'v1',
  data: { ...T.board(makeQueue()), gitError: null, logo: false, checksPanel: true },
};
/** While true, /api/settings never answers (the loading state stays). */
let hold = false;

const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};
const $ = (id: string) => document.getElementById(id) as HTMLElement;
const panel = () => $('panel');
const gear = () => $('settings') as HTMLButtonElement;
/** Settings is what the panel shows (its heading says so; the help and a card have other headings). */
const settingsOpen = () => !panel().hidden && /Settings/.test(panel().querySelector('h2')?.textContent ?? '');

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
  w.fetch = async (filePath: string) => {
    if (filePath.startsWith('/api/settings') && hold) return new Promise(() => {});
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
}, 60_000);

// ---------------------------------------------------------------------------------------------------------------------
describe('Q1: the settings gear toggles', () => {
  it('starts closed with aria-expanded false and aria-controls on the panel', () => {
    expect(panel().hidden).toBe(true);
    expect(gear().getAttribute('aria-expanded')).toBe('false');
    expect(gear().getAttribute('aria-controls')).toBe('panel');
  });

  it('a click opens Settings, a second click closes the panel as the X does, a third opens it again', async () => {
    gear().click();
    await flush();
    expect(panel().hidden).toBe(false);
    expect(settingsOpen()).toBe(true);
    expect(gear().getAttribute('aria-expanded')).toBe('true');

    gear().click();
    await flush();
    expect(panel().hidden).toBe(true);
    expect(panel().childElementCount).toBe(0);
    expect(gear().getAttribute('aria-expanded')).toBe('false');

    gear().click();
    await flush();
    expect(panel().hidden).toBe(false);
    expect(gear().getAttribute('aria-expanded')).toBe('true');
    // The X still closes it, and the gear follows.
    (panel().querySelector('.panel-header button[aria-label="Close"]') as HTMLButtonElement).click();
    await flush();
    expect(panel().hidden).toBe(true);
    expect(gear().getAttribute('aria-expanded')).toBe('false');
  });

  it('a second click while Settings is still loading closes it (it does not redraw the loading state)', async () => {
    hold = true;
    gear().click();
    await flush();
    expect(panel().hidden).toBe(false);
    gear().click();
    await flush();
    expect(panel().hidden).toBe(true);
    expect(gear().getAttribute('aria-expanded')).toBe('false');
    hold = false;
  });

  it('with another panel open (the help), the gear opens Settings instead of closing', async () => {
    // The Checks room has its own "?" that opens the help in the same panel.
    $('show-checks').click();
    await flush();
    (document.querySelector('.room-help[data-help="checks"]') as HTMLElement).click();
    await flush();
    expect(panel().hidden).toBe(false);
    expect(gear().getAttribute('aria-expanded')).toBe('false');
    gear().click();
    await flush();
    expect(panel().hidden).toBe(false);
    expect(gear().getAttribute('aria-expanded')).toBe('true');
    gear().click();
    await flush();
    expect(panel().hidden).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('Q2: Checks severity is visible', () => {
  beforeAll(async () => {
    $('show-checks').click();
    await flush();
  });

  it('a tally of the open suggestions stands at the top, before the Important box and the lists', () => {
    const view = document.querySelector('.checks-view') as HTMLElement;
    const tally = view.querySelector('.checks-tally') as HTMLElement;
    expect(tally).not.toBeNull();
    const summary = view.querySelector('.checks-summary') as HTMLElement;
    // The tally comes before the Important box and before the first card.
    expect(tally.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const firstCard = view.querySelector('.checks-suggestion') as HTMLElement;
    expect(tally.compareDocumentPosition(firstCard) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('counts only open suggestions that apply: High 2, Medium 1, Low 0', () => {
    const items = [...document.querySelectorAll('.checks-tally .checks-tally-item')] as HTMLElement[];
    expect(items.map((x) => x.dataset.level)).toEqual(['high', 'medium', 'low']);
    expect(items.map((x) => (x.textContent ?? '').replace(/\s+/g, ' ').trim())).toEqual(['High 2', 'Medium 1', 'Low 0']);
  });

  it('each level in the tally is a pill in its color, and a zero count is muted', () => {
    const items = [...document.querySelectorAll('.checks-tally .checks-tally-item')] as HTMLElement[];
    expect(items[0].classList.contains('checks-pill-high')).toBe(true);
    expect(items[1].classList.contains('checks-pill-medium')).toBe(true);
    expect(items[2].classList.contains('checks-pill-low')).toBe(true);
    expect(items.every((x) => x.classList.contains('checks-pill'))).toBe(true);
    expect(items[2].classList.contains('checks-pill-zero')).toBe(true);
    expect(items[0].classList.contains('checks-pill-zero')).toBe(false);
  });

  it('has one screen-reader sentence, and the visual pills are hidden from it', () => {
    const tally = document.querySelector('.checks-tally') as HTMLElement;
    const sr = tally.querySelector('.hidden-for-eye') as HTMLElement;
    expect(sr.textContent).toBe('Open suggestions: 2 high, 1 medium, 0 low.');
    expect(tally.querySelector('.checks-tally-pills')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('the level word on each card is a pill with its level class', () => {
    for (const [key, level, word] of [
      ['h1', 'high', 'High'],
      ['m1', 'medium', 'Medium'],
      ['m-queued', 'medium', 'Medium'],
    ]) {
      const c = document.getElementById(`checks-card-${key}`);
      const pill = c?.querySelector('.checks-priority') as HTMLElement;
      expect(pill, key).not.toBeNull();
      expect(pill.classList.contains('checks-pill'), key).toBe(true);
      expect(pill.classList.contains(`checks-pill-${level}`), key).toBe(true);
      expect(pill.textContent).toBe(word);
    }
  });

  it('the CSS gives each pill its tone pair (danger, caution, warn) with tokens only', () => {
    const css = readFileSync(join(CLIENT, 'board.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const rule = (sel: string) => {
      const m = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].find((x) => x[1].split(',').map((s) => s.trim()).includes(sel));
      return m?.[2] ?? '';
    };
    expect(rule('.checks-pill-high')).toMatch(/background:\s*var\(--color-tone-danger\)/);
    expect(rule('.checks-pill-high')).toMatch(/color:\s*var\(--color-on-tone-danger\)/);
    expect(rule('.checks-pill-medium')).toMatch(/background:\s*var\(--color-tone-caution\)/);
    expect(rule('.checks-pill-medium')).toMatch(/color:\s*var\(--color-on-tone-caution\)/);
    expect(rule('.checks-pill-low')).toMatch(/background:\s*var\(--color-tone-warn\)/);
    expect(rule('.checks-pill-low')).toMatch(/color:\s*var\(--color-on-tone-warn\)/);
    expect(rule('.checks-pill-zero')).toMatch(/var\(--color-tone-neutral\)/);
    for (const sel of ['.checks-pill', '.checks-pill-high', '.checks-pill-medium', '.checks-pill-low', '.checks-pill-zero', '.checks-tally'])
      expect(rule(sel), sel).not.toMatch(/#[0-9a-f]{3,6}\b|rgb\(/i);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('Q3: the drop bar in Focus', () => {
  // Row rectangles in "In focus": Theme 0-80, Today 100-180, billing 200-280 (midpoints 40, 140, 240). The list
  // itself starts at 0. jsdom has no layout, so the rectangles are set by hand.
  const RECTS: Record<string, [number, number]> = {
    'feature:ui/Theme': [0, 80],
    'feature:ui/Today': [100, 180],
    'project:billing': [200, 280],
  };
  const list = () => document.querySelector('.plan-list[data-col="focus"]') as HTMLElement;
  const row = (key: string) => document.querySelector(`.plan-list > .plan-element[data-key="${key}"]`) as HTMLElement;
  const focusKeys = () =>
    [...document.querySelectorAll('.plan-list[data-col="focus"] > .plan-element')].map((x) => (x as HTMLElement).dataset.key);
  const bar = () => list().querySelector('.plan-drop-bar') as HTMLElement | null;
  /** A drag event with the parts the board reads (dataTransfer, clientY, relatedTarget). */
  function drag(type: string, target: Element, y = 0, related: Element | null = null) {
    const e = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'dataTransfer', { value: { setData() {}, effectAllowed: '', dropEffect: '' } });
    Object.defineProperty(e, 'clientY', { value: y });
    Object.defineProperty(e, 'relatedTarget', { value: related });
    target.dispatchEvent(e);
  }

  beforeAll(async () => {
    $('show-plan').click();
    await flush();
    const real = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (this: Element) {
      const key = (this as HTMLElement).dataset?.key;
      const r = key && this.parentElement?.matches('.plan-list') ? RECTS[key] : null;
      if (r) return { top: r[0], bottom: r[1], height: r[1] - r[0], left: 0, right: 300, width: 300, x: 0, y: r[0] } as DOMRect;
      if ((this as HTMLElement).matches?.('.plan-list[data-col="focus"]'))
        return { top: 0, bottom: 300, height: 300, left: 0, right: 300, width: 300, x: 0, y: 0 } as DOMRect;
      return real.call(this);
    };
  });

  it('shows the bar between the rows where releaseIndex will drop the step, for several heights', () => {
    expect(focusKeys()).toEqual(['feature:ui/Theme', 'feature:ui/Today', 'project:billing']);
    drag('dragstart', row('project:billing'));
    // Above the middle of Theme: index 0, the bar above Theme.
    drag('dragover', list(), 10);
    expect(bar()?.dataset.index).toBe('0');
    expect(parseFloat(bar()!.style.top)).toBeLessThanOrEqual(0);
    // Between the middles of Theme and Today: index 1, the bar in the gap between Theme (ends 80) and Today (starts 100).
    drag('dragover', list(), 120);
    expect(bar()?.dataset.index).toBe('1');
    const top = parseFloat(bar()!.style.top);
    expect(top).toBeGreaterThanOrEqual(80 - 3);
    expect(top).toBeLessThanOrEqual(100);
    // Only one bar, and it is decoration for the eye (the live status names the move).
    expect(list().querySelectorAll('.plan-drop-bar').length).toBe(1);
    expect(bar()?.getAttribute('aria-hidden')).toBe('true');
  });

  it('shows no bar where the drop would not move the step', () => {
    // Below the middle of Today, billing would land at index 2, where it already is.
    drag('dragover', list(), 190);
    expect(bar()).toBeNull();
    drag('dragover', list(), 290);
    expect(bar()).toBeNull();
    // Back up: the bar comes back.
    drag('dragover', list(), 10);
    expect(bar()?.dataset.index).toBe('0');
  });

  it('dragleave out of the list removes the bar; dragend removes it too', () => {
    drag('dragleave', list(), 10, document.body);
    expect(bar()).toBeNull();
    drag('dragover', list(), 120);
    expect(bar()).not.toBeNull();
    // A leave into a child of the list (the pointer moved onto a row) keeps it.
    drag('dragleave', list(), 120, row('feature:ui/Theme'));
    expect(bar()).not.toBeNull();
    drag('dragend', row('project:billing'));
    expect(document.querySelector('.plan-drop-bar')).toBeNull();
  });

  it('the drop lands where the bar was, and the bar is gone afterwards', async () => {
    drag('dragstart', row('project:billing'));
    drag('dragover', list(), 120);
    const shown = bar()?.dataset.index;
    expect(shown).toBe('1');
    drag('drop', list(), 120);
    await flush();
    expect(document.querySelector('.plan-drop-bar')).toBeNull();
    expect(focusKeys().indexOf('project:billing')).toBe(Number(shown));
  });

  it('the bar uses a theme token, never hex, and has round ends', () => {
    const css = readFileSync(join(CLIENT, 'board.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const m = css.match(/\.plan-drop-bar\s*\{([^}]*)\}/);
    expect(m).not.toBeNull();
    expect(m![1]).toMatch(/background:\s*var\(--color-drop-indicator\)/);
    expect(m![1]).toMatch(/height:\s*3px/);
    expect(m![1]).toMatch(/border-radius/);
    expect(m![1]).not.toMatch(/#[0-9a-f]{3,6}\b|rgb\(/i);
  });
});
