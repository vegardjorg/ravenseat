/**
 * @vitest-environment jsdom
 */
// =============================================================
// queueBoardMenusOneJob.test.ts: menus with one job (board step B28, UX review M1, M2, M3, C2 and X3).
//
// What the tests prove:
//   - M1 / X3: the Filter menu holds only filters. "Pause" (a command that changes the queue for everyone) is gone from
//     it and lives in the project's lane header, with the same write as before ({ type: 'pause', pid } to
//     /api/action). The Filter menu points to the lane header with a view switch, never a command.
//   - M2: a Filter section with nothing to choose (Plan entry with no plan entries) is not drawn, so no lone
//     "Select all"; it comes back once there is something under it.
//   - M3: every quick filter (a built-in row, in the Filter menu since QA-1d; before that in the Selection menu) has a
//     short visible explanation as a second line (not only a tooltip), tied to the row with aria-describedby; the rows
//     are 36 px on a mouse and 44 px on touch, in the on-surface text color like the B23 selection menu. The heading
//     of your own saved filters is "Saved" and the empty line has the menu's side padding.
//   - X3: "Waiting on me" is not a quick filter (the "Waiting on you" button at the top opens Decisions).
//   - C2: the Checks header has one action ("Read again"); "Turn this tab off" is gone from it. A quiet line at the end
//     of the view opens Settings on the existing Checks switch, which is where the tab is turned off.
//   - The arrow keys move between the quick filter rows, and Esc closes the menu with focus back on Filter.
// CSS rules are read from board.css (render tests do not work in jsdom); the behaviour runs the whole board in jsdom.
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
const html = readFileSync(join(CLIENT, 'index.html'), 'utf8');
const iso = new Date(Date.now() - 86_400_000).toISOString();

// ---- A small CSS reader: top-level rules and rules inside one level of @media ---------------------------------------

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
const base = (selector: string) =>
  Object.assign({}, ...rules.filter((r) => r.media === null && r.selectors.includes(selector)).map((r) => r.decl)) as Record<
    string,
    string
  >;
const inMedia = (media: RegExp, selector: string) =>
  Object.assign(
    {},
    ...rules.filter((r) => r.media && media.test(r.media) && r.selectors.includes(selector)).map((r) => r.decl),
  ) as Record<string, string>;

// ---- The board in jsdom ---------------------------------------------------------------------------------------------

function makeQueue(withPlan = false) {
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
    tasks: [task('EX-1', withPlan ? { plan: 'PL-1' } : {}), task('EX-2')],
    projects: { ex: { title: 'Example', prefixes: ['EX-'] } },
    areas: {},
    question: [],
    resolutions: [],
    changelog: [],
  };
}
function makeState(version: string, withPlan = false) {
  const data = { ...T.board(makeQueue(withPlan)), gitError: null, logo: false, checksPanel: true };
  // The project is in the register, so it can be paused (as a registered project on a real board).
  data.projects = data.projects.map((p: any) => (p.pid === 'ex' ? { ...p, movable: true } : p));
  return { version, data };
}
let state = makeState('v1');
const posts: { url: string; body: any }[] = [];
const report = { found: { kinds: [], ci: [] }, suggestions: [], categories: [] };

const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};
const $ = (id: string) => document.getElementById(id) as HTMLElement;
/** Switches the queue view with its tab, as the owner does. */
async function show(view: 'flat' | 'lanes') {
  $(`show-${view}`).click();
  await flush();
}
const closeFilter = () => {
  if (!$('filter-menu').hidden) $('filter-button').click();
};
const key = (target: Element, k: string) =>
  target.dispatchEvent(new (window as any).KeyboardEvent('keydown', { key: k, bubbles: true }));

beforeAll(async () => {
  document.documentElement.innerHTML = html.replace(/<!doctype[^>]*>/i, '').replace(/<\/?html[^>]*>/g, '');
  sessionStorage.setItem('queue-board-key', 'testKey');
  localStorage.clear();
  const w = window as any;
  w.CSS = { escape: (s: string) => String(s).replace(/["\\]/g, '\\$&') };
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {} });
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.setInterval = () => 0;
  w.fetch = async (filePath: string, init?: any) => {
    if (init?.method === 'POST') posts.push({ url: filePath, body: JSON.parse(init.body ?? '{}') });
    return {
      ok: true,
      status: 200,
      json: async () => {
        if (filePath.startsWith('/api/state'))
          return filePath.includes(`version=${state.version}`) ? { version: state.version, unchanged: true } : state;
        if (filePath.startsWith('/api/checks')) return { report };
        if (filePath.startsWith('/api/settings')) return { error: 'not in this test' };
        if (filePath.startsWith('/api/task')) return { ok: true, mission: { text: '', path: null }, branch: null };
        return { ok: true };
      },
    };
  };
  for (const f of ['a11y.js', '../lib/queueGraph.js', 'graph.js', 'plan.js', 'performance.js', 'board/'])
    (0, eval)(clientSource(f));
  await flush();
  // The board lands in the queue view for these tests (the data has no owner questions).
  await show('flat');
}, 60_000);

function openFilter() {
  if ($('filter-menu').hidden) $('filter-button').click();
  return $('filter-menu');
}
/** QA-1d: the quick filters and saved filters are the first two sections of the Filter menu (no Selection menu). */
function openSelection() {
  return openFilter();
}
/** The Quick filters section (the old Selection menu's built-in rows). */
const quickSection = (menu: HTMLElement) => menu.querySelectorAll('.filter-section')[0] as HTMLElement;

describe('M2: a Filter section with nothing under it is not drawn', () => {
  it('no plan entries: no "Plan entry" section and no lone "Select all"', () => {
    const menu = openFilter();
    const titles = [...menu.querySelectorAll('.filter-section h3')].map((h) => h.textContent);
    expect(titles).toContain('Show');
    expect(titles).toContain('Projects');
    expect(titles).not.toContain('Plan entry');
    expect(menu.querySelector('[data-focus="all:plan"]')).toBeNull();
    // QA-1d: the first two sections are Quick filters and Saved (rows, not checkboxes); the filter sections follow.
    const filterSections = [...menu.querySelectorAll('.filter-section')].slice(2);
    expect(filterSections.length).toBeGreaterThan(0);
    for (const s of filterSections) expect(s.querySelectorAll('input[type="checkbox"]').length).toBeGreaterThan(0);
    closeFilter();
  });
});

describe('M1 / X3: Pause is a command, so it lives in the lane header, not in the Filter menu', () => {
  it('the Filter menu has no Pause or Continue button', () => {
    const menu = openFilter();
    expect(menu.querySelector('[data-focus^="pause:"]')).toBeNull();
    const texts = [...menu.querySelectorAll('button')].map((b) => b.textContent?.trim());
    expect(texts).not.toContain('Pause');
    expect(texts).not.toContain('Continue');
    closeFilter();
  });

  it('the Filter menu points to the lane header with a view switch, which writes nothing', async () => {
    const menu = openFilter();
    const hint = menu.querySelector('.filter-hint') as HTMLElement;
    expect(hint).not.toBeNull();
    expect(hint.textContent).toMatch(/Pause/);
    const before = posts.length;
    (hint.querySelector('button') as HTMLButtonElement).click();
    await flush();
    expect($('show-lanes').getAttribute('aria-selected') ?? $('show-lanes').getAttribute('aria-pressed')).toBe('true');
    expect(posts.length).toBe(before);
    expect($('filter-menu').hidden).toBe(true);
  });

  it('the lane header keeps Pause, with the same write as before', async () => {
    await show('lanes');
    // The write below fetches the state again: this version has a plan entry, for the M2 test after it.
    state = makeState('v2', true);
    const button = document.querySelector('.lane-header [data-focus="pause:ex"]') as HTMLButtonElement;
    expect(button).not.toBeNull();
    expect(button.getAttribute('aria-label')).toBe('Pause the project ex');
    const before = posts.length;
    button.click();
    await flush();
    const write = posts.slice(before).find((p) => p.url.startsWith('/api/action'));
    expect(write?.body).toMatchObject({ type: 'pause', pid: 'ex' });
    await show('flat');
  });
});

describe('M2: the hidden section comes back', () => {
  it('the section comes back once a task has a plan entry (the state after the Pause write)', async () => {
    const menu = openFilter();
    const titles = [...menu.querySelectorAll('.filter-section h3')].map((h) => h.textContent);
    expect(titles).toContain('Plan entry');
    closeFilter();
  });
});

describe('M3 / X3: the quick filters say what each row does, in the B23 menu style', () => {
  it('every built-in row has a visible explanation line tied to it', () => {
    const menu = openSelection();
    const rows = [...quickSection(menu).querySelectorAll('.view-option')] as HTMLElement[];
    const byName = new Map(rows.map((r) => [r.querySelector('.view-name')?.textContent, r]));
    for (const name of ['Sort', 'Outside focus, ready', 'On hold']) {
      const row = byName.get(name);
      expect(row, name).toBeTruthy();
      const explain = row!.querySelector('.view-explain') as HTMLElement;
      expect(explain?.textContent?.length, name).toBeGreaterThan(10);
      expect(row!.getAttribute('aria-describedby')).toBe(explain.id);
      expect(row!.getAttribute('aria-label')).toBe(name);
    }
    for (const r of rows) expect(r.querySelector('.view-explain')?.textContent?.trim()).toBeTruthy();
  });

  it('"Waiting on me" is out of the menu, the own heading is "Saved" and the empty line is padded', () => {
    const menu = openSelection();
    expect(menu.textContent).not.toMatch(/Waiting on me/);
    const titles = [...menu.querySelectorAll('.filter-section h3')].map((h) => h.textContent);
    expect(titles.slice(0, 2)).toEqual(['Quick filters', 'Saved']);
    expect(menu.querySelector('.empty')?.textContent).toBe('No saved filters yet.');
    const empty = base('.filter-menu .empty');
    expect(empty.padding ?? empty['padding-left']).toMatch(/var\(--distance-md\)/);
  });

  it('the rows are 36 px on a mouse and 44 px on touch, in the on-surface text color, in the Filter menu', () => {
    expect(html).not.toMatch(/id="views-menu"/);
    const row = base('.view-option');
    expect(row['min-height']).toBe('36px');
    expect(row.color).toBe('var(--color-on-surface)');
    expect(inMedia(/pointer: coarse/, '.view-option')['min-height']).toBe('44px');
    expect(base('.view-explain').color).toBe('var(--color-on-surface-variant)');
  });

  it('the arrow keys move between the rows and Esc closes with focus back on Filter', () => {
    const menu = openSelection();
    const rows = [...quickSection(menu).querySelectorAll('.view-option')] as HTMLElement[];
    rows[0].focus();
    key(rows[0], 'ArrowDown');
    expect(document.activeElement).toBe(rows[1]);
    key(rows[1], 'ArrowUp');
    expect(document.activeElement).toBe(rows[0]);
    key(rows[0], 'Escape');
    expect(menu.hidden).toBe(true);
    expect(document.activeElement).toBe($('filter-button'));
  });

  it('Esc in the Filter menu still closes it with focus back on Filter', () => {
    const menu = openFilter();
    key(menu.querySelector('input') as Element, 'Escape');
    expect(menu.hidden).toBe(true);
    expect(document.activeElement).toBe($('filter-button'));
  });
});

describe('C2: "Turn this tab off" is out of the Checks header', () => {
  it('the header has one action, Read again', async () => {
    $('show-checks').click();
    await flush();
    const head = document.querySelector('.checks-view .checks-head') as HTMLElement;
    // The room's "?" (B30) opens the help; it is no action on the room, so it does not count here.
    const buttons = [...head.querySelectorAll('button:not(.room-help)')].map((b) => b.textContent?.trim());
    expect(buttons).toEqual(['Read again']);
    expect(head.querySelectorAll('.room-help')).toHaveLength(1);
    expect(document.querySelector('.checks-view')?.textContent).not.toMatch(/Turn this tab off/);
  });

  it('a quiet line at the end opens Settings on the Checks switch, and writes nothing itself', async () => {
    const view = document.querySelector('.checks-view') as HTMLElement;
    const line = view.querySelector('.checks-off-hint') as HTMLElement;
    expect(line).not.toBeNull();
    expect(view.lastElementChild).toBe(line);
    const before = posts.length;
    (line.querySelector('button') as HTMLButtonElement).click();
    await flush();
    expect(posts.length).toBe(before);
    expect(document.getElementById('panel-title')?.textContent).toBe('Settings');
  });
});
