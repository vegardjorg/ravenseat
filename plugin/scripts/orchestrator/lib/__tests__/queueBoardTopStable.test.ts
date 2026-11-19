/**
 * @vitest-environment jsdom
 */
// =============================================================
// queueBoardTopStable.test.ts: the top bar and a stable layout (board steps B6, B16, B26 and B27).
//
// What the tests prove:
//   - B16: the top has one height in every room. Its two rows are fixed tracks (not auto), so hiding row 2 in Plans
//     leaves the height and the y of row 1 unchanged; the rows never wrap from 721 px up; the page itself never
//     scrolls (an absolutely positioned screen-reader text inside the board stays inside it), so no page scrollbar
//     shifts the right side of the top; with the panel beside the board the top keeps its full width.
//   - B6: no accent line under the top, the title is not in the accent color, the counter on "Waiting on you" is the
//     warning tone, Decisions shows one filled button (on the current card), the Plans pulse stops, and the room tabs
//     carry an icon while keeping their text, roles and keyboard order.
//   - B26: a compact top below 1200 px (narrower search, tabs that scroll instead of wrapping, no room icons), and
//     columns that fit at 1000 and 1100 px.
//   - B27: "Waiting on you" has a fixed place right after the room tabs and the status text comes last before the gear,
//     clipped with an ellipsis; the focus line keeps its height from the first paint; the chain line shares the row
//     with "Next up", so opening a card does not push the board down; the Plans breadcrumb has one height.
// The browser measurements behind these rules are in the 0u2 B6 report; render tests do not work in jsdom, so the
// layout rules are read from the CSS and the behaviour runs the whole board in jsdom with a small synthetic queue.
// =============================================================
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { clientSource } from './boardClient';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const T = require('../queueBoard.js') as { board: (queue: unknown, option?: unknown) => any };

const CLIENT = join(__dirname, '..', '..', 'queue-board');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const css = strip(readFileSync(join(CLIENT, 'board.css'), 'utf8'));
const plansCss = strip(readFileSync(join(CLIENT, 'plans', 'plans.css'), 'utf8'));
const html = readFileSync(join(CLIENT, 'index.html'), 'utf8');
const iso = new Date(Date.now() - 86_400_000).toISOString();

// ---- A small CSS reader: top-level rules and rules inside one level of @media --------------------------------------

type Rule = { media: string | null; selectors: string[]; decl: Record<string, string> };

function readRules(text: string): Rule[] {
  const rules: Rule[] = [];
  const surface = (content: string, media: string | null) => {
    let k = 0;
    while (k < content.length) {
      const start = content.indexOf('{', k);
      if (start < 0) break;
      const header = content.slice(k, start).trim();
      let depth = 0;
      let end = start;
      for (; end < content.length; end++) {
        if (content[end] === '{') depth++;
        else if (content[end] === '}' && --depth === 0) break;
      }
      const body = content.slice(start + 1, end);
      if (header.startsWith('@media')) surface(body, header);
      else if (!header.startsWith('@')) {
        const decl: Record<string, string> = {};
        for (const d of body.split(';')) {
          const colon = d.indexOf(':');
          if (colon > 0) decl[d.slice(0, colon).trim()] = d.slice(colon + 1).trim();
        }
        rules.push({ media, selectors: header.split(',').map((s) => s.trim()), decl });
      }
      k = end + 1;
    }
  };
  surface(text, null);
  return rules;
}

const rules = readRules(css);
const plansRules = readRules(plansCss);

/** Does a media query apply at this width (width queries only; hover, motion and the rest never count)? */
function appliesAt(media: string | null, width: number): boolean {
  if (media === null) return true;
  const max = /max-width:\s*(\d+)px/.exec(media);
  const min = /min-width:\s*(\d+)px/.exec(media);
  if (!max && !min) return false;
  if (max && width > Number(max[1])) return false;
  if (min && width < Number(min[1])) return false;
  return true;
}

/** The last value of a property for an exact selector at a width (source order, last wins). */
function valueAt(selector: string, property: string, width: number, from = rules): string | null {
  let val: string | null = null;
  for (const r of from)
    if (appliesAt(r.media, width) && r.selectors.includes(selector) && r.decl[property] !== undefined)
      val = r.decl[property];
  return val;
}

const base = (selector: string, from = rules) =>
  Object.assign({}, ...from.filter((r) => r.media === null && r.selectors.includes(selector)).map((r) => r.decl)) as Record<
    string,
    string
  >;

// ---- The board in jsdom (same harness as queueBoardFolds.test.ts) ---------------------------------------------------

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
    added_at: iso,
    ...extra,
  });
  return {
    created: iso,
    limits: { maxConcurrent: 5, maxDPlus: 2, maxPerDomain: 5, maxDb: 2 },
    tasks: [task('EX-1'), task('EX-2', { depends_on: ['EX-1'] }), task('EX-3')],
    projects: { ex: { title: 'Example', prefixes: ['EX-'] } },
    areas: {},
    question: [],
    resolutions: [],
    changelog: [],
  };
}
const state = { version: 'v1', data: { ...T.board(makeQueue()), gitError: null, logo: false } };
const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};
const $ = (id: string) => document.getElementById(id) as HTMLElement;

let focusLineHiddenBeforeData: boolean | null = null;

beforeAll(async () => {
  document.documentElement.innerHTML = html.replace(/<!doctype[^>]*>/i, '').replace(/<\/?html[^>]*>/g, '');
  // Before any script runs: the focus line is in the layout from the first paint.
  focusLineHiddenBeforeData = $('focusLine').hidden;
  sessionStorage.setItem('queue-board-key', 'testKey');
  localStorage.clear();
  const w = window as any;
  w.CSS = { escape: (s: string) => String(s).replace(/["\\]/g, '\\$&') };
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {} });
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.setInterval = () => 0;
  w.fetch = async (filePath: string) => ({
    ok: true,
    status: 200,
    json: async () => {
      if (filePath.startsWith('/api/state'))
        return filePath.includes(`version=${state.version}`) ? { version: state.version, unchanged: true } : state;
      if (filePath.startsWith('/api/task')) return { ok: true, mission: { text: '', path: null }, branch: null };
      return { ok: true };
    },
  });
  for (const f of ['a11y.js', '../lib/queueGraph.js', 'graph.js', 'plan.js', 'performance.js', 'board/'])
    (0, eval)(clientSource(f));
  await flush();
}, 60_000);

// ---- B16 --------------------------------------------------------------------------------------------------------------

describe('B16: one top height in every room', () => {
  it('the two rows of the top are fixed tracks of the same height, and the mascot zone spans exactly both', () => {
    const template = base('.top')['grid-template'] ?? '';
    const m = /'mascot row1'\s+(\d+)px\s+'mascot row2'\s+(\d+)px/.exec(template);
    expect(m, template).not.toBeNull();
    const [row1, row2] = [Number(m![1]), Number(m![2])];
    expect(row1).toBe(row2);
    // Row gap 4 px: the mascot zone (104 px) is the two rows and the gap, so it never stretches a row.
    expect(base('.top')['row-gap']).toBe('4px');
    expect(base('.mascot').height).toBe(`${row1 + 4 + row2}px`);
    // Each row is that height and never wraps on a mouse-wide screen.
    expect(base('.top-row').height).toBe(`${row1}px`);
    expect(base('.top-row')['flex-wrap']).toBe('nowrap');
  });

  it('only the phone rule (720 px and below) lets the rows of the top grow and wrap', () => {
    const loose = rules.filter(
      (r) =>
        r.selectors.some((s) => /^\.top(-row\d?)?$/.test(s)) &&
        (r.decl['flex-wrap'] === 'wrap' ||
          /row\d'\s+auto\b/.test(r.decl['grid-template'] ?? '') ||
          r.decl['grid-template-rows'] !== undefined ||
          r.decl['min-height'] !== undefined),
    );
    expect(loose.length).toBeGreaterThan(0);
    for (const r of loose) expect(r.media ?? 'no media', r.selectors.join(',')).toMatch(/max-width:\s*720px/);
  });

  it('Plans changes nothing in the top but hide row 2 (the track keeps its height)', () => {
    for (const r of plansRules)
      for (const s of r.selectors.filter((x) => /(^|[\s>+~])(\.top(-row\d?)?|header)(?![\w-])/.test(x))) {
        expect(s).toMatch(/\.top-row2$/);
        expect(Object.keys(r.decl)).toEqual(['display']);
      }
  });

  it('the page never scrolls: the board and the Plans room contain their absolutely positioned screen-reader text', () => {
    // A .hidden-for-eye span (position: absolute) without a positioned ancestor extended the document in Statistics,
    // the page got a scrollbar and the gear moved 15 px left.
    expect(base('.board').position).toBe('relative');
    expect(base('.plans-room', plansRules).position).toBe('relative');
  });

  it('with the panel beside the board the top keeps its full width and the panel starts below it', () => {
    const top = rules.find((r) => r.selectors.includes('body.panel-beside .top'));
    expect(top?.decl['margin-right']).toBe('calc(-1 * var(--panel-side))');
    const panel = rules.find((r) => r.selectors.includes('body.panel-beside .panel'));
    expect(panel?.decl.top).toBe('var(--top-height)');
    // --top-height is the fixed top: padding 6 + two rows + gap 4 + padding 6 + the 1 px border.
    const row = Number(/'mascot row1'\s+(\d+)px/.exec(base('.top')['grid-template'])![1]);
    const root = base(':root')['--top-height'];
    expect(root).toBe(`${6 + row + 4 + row + 6 + 1}px`);
  });
});

// ---- B6 ---------------------------------------------------------------------------------------------------------------

describe('B6: the top and the accent', () => {
  it('no accent line under the top: a neutral hairline and no shadow, in both files', () => {
    expect(base('.top')['border-bottom']).toBe('1px solid var(--color-outline-variant)');
    for (const r of [...rules, ...plansRules])
      if (r.selectors.some((s) => /^(body[.\w-]*\s+)?\.top(-row\d?)?$|^body\.room-/.test(s)))
        expect(r.decl['box-shadow'] ?? '', r.selectors.join(',')).not.toMatch(/primary|tertiary/);
  });

  it('the title is plain text, not the accent color', () => {
    expect(base('.title').color).toBe('var(--color-on-surface)');
  });

  it('the counter on "Waiting on you" is the warning tone, and the button has no accent frame', () => {
    expect(base('.inbox-count').background).toBe('var(--color-tone-warn)');
    expect(base('.inbox-count').color).toBe('var(--color-on-tone-warn)');
    expect(base('.inbox-button.active')['border-color'] ?? '').not.toMatch(/primary/);
  });

  it('Decisions has one filled button: the recommendation on the current card; the others look secondary', () => {
    const r = base('.decide-card:not(.current) .button-filled');
    expect(r.background).toBe('var(--color-surface-container-lowest)');
    expect(r['border-color']).toBe('var(--color-outline)');
    expect(r.color).toBe('var(--color-on-surface)');
  });

  it('the "working now" pulse in Plans runs three times and stops', () => {
    expect(plansCss).toMatch(/animation:\s*plans-pulse\s+[\d.]+s\s+ease-in-out\s+3\s*;/);
    expect(plansCss).not.toMatch(/plans-pulse[^;]*infinite/);
  });

  it('the room tabs carry an icon and keep their text, role, aria and keyboard order', async () => {
    const tabs = [...$('room-option').querySelectorAll('[role="tab"]')] as HTMLElement[];
    expect(tabs.map((b) => b.id)).toEqual(['room-plans', 'room-queue', 'show-decisions', 'show-checks']);
    expect($('room-option').getAttribute('role')).toBe('tablist');
    expect($('room-option').getAttribute('aria-label')).toBe('Workspace');
    for (const b of tabs) {
      const svg = b.querySelector('svg.icon');
      expect(svg, b.id).not.toBeNull();
      expect(svg!.getAttribute('aria-hidden')).toBe('true');
      expect(b.getAttribute('aria-selected')).toMatch(/true|false/);
    }
    expect(tabs.map((b) => b.textContent?.trim())).toEqual(['Plans', 'Queue', 'Decisions', 'Checks']);
    // One tab stop in the list (roving tabindex), unchanged.
    expect(tabs.filter((b) => b.tabIndex === 0)).toHaveLength(1);
    // A redraw of the Decisions tab keeps its icon.
    $('show-decisions').click();
    await flush();
    expect($('show-decisions').querySelector('svg.icon')).not.toBeNull();
    $('room-queue').click();
    $('show-flat').click();
    await flush();
  });
});

// ---- B26 --------------------------------------------------------------------------------------------------------------

describe('B26: medium width (1000 to 1199 px)', () => {
  it('a compact top below 1200 px: narrower search, tabs that scroll in their row, no room icons', () => {
    const compact = (sel: string, prop: string) => valueAt(sel, prop, 1000);
    expect(rules.some((r) => r.media && /max-width:\s*1199px/.test(r.media))).toBe(true);
    expect(parseInt(compact('.top .search', 'flex-basis') ?? '999', 10)).toBeLessThanOrEqual(180);
    expect(compact('.top-row2 .toggles', 'overflow-x')).toBe('auto');
    expect(compact('.top-row2 .toggles', 'min-width')).toBe('0');
    expect(compact('.room-option .icon', 'display')).toBe('none');
    // Not on a wide screen.
    expect(valueAt('.room-option .icon', 'display', 1440)).not.toBe('none');
  });

  it('the search gives way before anything wraps: it can shrink to a floor on every width', () => {
    expect(base('.search')['min-width']).toMatch(/^\d+px$/);
    expect(parseInt(base('.search')['min-width'], 10)).toBeLessThanOrEqual(120);
    expect(base('.search-filter')['min-width']).toBe('0');
  });

  for (const width of [1000, 1100])
    it(`four flat columns and four lane columns fit at ${width} px`, () => {
      const fits = (template: string | null) => {
        const min = Number(/minmax\((\d+)px/.exec(template ?? '')?.[1]);
        // 4 columns, 3 gaps of 16 px and 24 px padding on each side.
        return 4 * min + 3 * 16 + 2 * 24;
      };
      expect(fits(valueAt('.board.flat', 'grid-template-columns', width))).toBeLessThanOrEqual(width);
      expect(fits(valueAt('.lane-headers', 'grid-template-columns', width))).toBeLessThanOrEqual(width);
      expect(fits(valueAt('.lane-row', 'grid-template-columns', width))).toBeLessThanOrEqual(width);
    });

  it('on a wide screen the columns keep the B5 width', () => {
    expect(valueAt('.board.flat', 'grid-template-columns', 1440)).toMatch(/minmax\(280px,\s*480px\)/);
  });
});

// ---- B27 --------------------------------------------------------------------------------------------------------------

describe('B27: a stable layout', () => {
  it('row 1: the room tabs, "Waiting on you" right after them, the title, then the status last before the gear', () => {
    const row1 = [...$('mascot').parentElement!.querySelector('.top-row1')!.children].map(
      (e) => e.id || e.className,
    );
    expect(row1).toEqual(['room-option', 'inbox', 'title', 'top-fill', 'status', 'settings']);
  });

  it('the status text is clipped with an ellipsis and never pushes the gear', () => {
    const s = base('.status');
    expect(s['white-space']).toBe('nowrap');
    expect(s.overflow).toBe('hidden');
    expect(s['text-overflow']).toBe('ellipsis');
    expect(s['min-width']).toBe('0');
    expect(s['max-width']).toMatch(/^\d+px$/);
    expect(base('.title')['min-width']).toBe('0');
    expect(base('.title')['text-overflow']).toBe('ellipsis');
    for (const sel of ['#room-option', '.room-option', '.inbox-button', '#settings', '.button-icon'])
      if (base(sel).flex !== undefined) expect(base(sel).flex, sel).toBe('none');
    expect(base('.room-option').flex).toBe('none');
    expect(base('.inbox-button').flex).toBe('none');
  });

  it('choosing a room never widens its tab: the label keeps its bold width, the Checks dot is out of the flow', async () => {
    // Measured before: "Waiting on you" moved 1 px in Decisions because the chosen tab turned bold.
    for (const id of ['room-plans', 'room-queue', 'show-decisions', 'show-checks']) {
      const label = $(id).querySelector('.tab-label') as HTMLElement | null;
      expect(label, id).not.toBeNull();
      expect(label!.dataset.label).toBe(label!.textContent);
    }
    const after = base('.tab-label::after');
    expect(after.content).toBe('attr(data-label)');
    expect(after['font-weight']).toBe('600');
    expect(after.height).toBe('0');
    expect(after.visibility).toBe('hidden');
    expect(base('.tab-label')['flex-direction']).toBe('column');
    expect(base('.room-option .toggles-button.has-marker::after').position).toBe('absolute');
    $('show-decisions').click();
    await flush();
    expect($('show-decisions').querySelector('.tab-label')?.textContent).toBe('Decisions');
    $('room-queue').click();
    $('show-flat').click();
    await flush();
  });

  it('the full status text is in its tooltip, also when it is clipped', async () => {
    $('status').textContent = 'Could not read the queue (a long reason). Showing the state from 12:00.';
    await flush();
    expect($('status').title).toBe($('status').textContent);
  });

  it('the focus line is in the layout from the first paint and keeps a one-row height', () => {
    expect(focusLineHiddenBeforeData).toBe(false);
    expect(html).not.toMatch(/id="focusLine"[^>]*\bhidden\b/);
    expect(base('.focusLine')['min-height']).toBe('45px');
    expect($('focusLine').hidden).toBe(false);
  });

  it('opening a card puts the chain into the "Next up" row: still one row, so the board does not move', async () => {
    expect($('stripe').querySelectorAll('.stripe-row')).toHaveLength(1);
    const b = document.querySelector('.summary[data-id="EX-2"] .summary-button') as HTMLButtonElement;
    expect(b).not.toBeNull();
    b.click();
    await flush();
    const rows = $('stripe').querySelectorAll('.stripe-row');
    expect(rows).toHaveLength(1);
    expect(rows[0].querySelector('.chain-line')).not.toBeNull();
    expect(rows[0].querySelector('.chain-line')!.getAttribute('role')).toBe('status');
    const row = base('.stripe-row');
    expect(row['flex-wrap']).toBe('nowrap');
    expect(row.height).toBe('36px');
    // The legend is short line pieces in the chain colors, not boxes that look like checkboxes.
    expect(base('.draw-chain').height).toBe('0');
    (($('panel').querySelector('.button-icon') as HTMLButtonElement) ?? { click() {} }).click();
    await flush();
  });

  it('the Plans breadcrumb has one height on every surface', () => {
    expect(base('.plans-path', plansRules).height).toMatch(/^\d+px$/);
  });
});
