/**
 * @vitest-environment jsdom
 */
// =============================================================
// queueBoardFolds.test.ts: headings without all caps (board step B5) and folds that look like folds (B25, UX review
// findings K1, K2, X5 and PL6).
//
// What the tests prove:
//   - no heading, label or counter on the board or in Plans is set in all caps (no text-transform: uppercase), and the
//     section headings use weight 600 and a token size,
//   - the column header keeps "In progress" on one line next to the agents badge (the heading does not wrap, the badge
//     gives way with an ellipsis), and the flat columns have a maximum width,
//   - Blocked, Proposed and the batch queue are disclosure buttons in a heading (button semantics, aria-expanded,
//     aria-controls, a chevron), with the same look as the Plans folds,
//   - Blocked is open from the start when it has 20 cards or fewer and closed above that; Proposed is closed; the
//     viewer's own open or close choice holds across a redraw,
//   - the chain line names the real cause of a hidden card (closed fold, search, filter, selection, older in Built),
//     with an action that reveals it where there is one ("Show" opens the fold),
//   - the Plans and Focus folds use the same chevron instead of small text arrows.
// The whole board runs in jsdom with a small synthetic queue (no real data); the state is swapped and fetched again
// through the window's focus event, as in the browser.
// =============================================================
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { clientSource } from './boardClient';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const T = require('../queueBoard.js') as { board: (queue: unknown, option?: unknown) => any };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const A = require('../../queue-board/a11y.js') as {
  chainHidden: (causes: Array<Record<string, unknown>>) => Array<{ text: string; action: string | null; label: string | null; aria: string | null }>;
};

const CLIENT = join(__dirname, '..', '..', 'queue-board');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const css = strip(readFileSync(join(CLIENT, 'board.css'), 'utf8'));
const plansCss = strip(readFileSync(join(CLIENT, 'plans', 'plans.css'), 'utf8'));
const iso = new Date(Date.now() - 86_400_000).toISOString();

/** The declarations of the first rule whose selector list is exactly `selector`. */
function rule(source: string, selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(?:^|\\})\\s*${esc}\\s*\\{([^}]*)\\}`).exec(source);
  return m ? m[1] : '';
}

/**
 * A queue with EX-1 ready, `blocked` tasks that wait on it (depends_on, so they are in the Blocked fold) and `proposed`
 * proposals.
 */
function makeQueue(blocked: number, proposed = 0) {
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
  const tasks = [task('EX-1')];
  for (let i = 0; i < blocked; i++) tasks.push(task(`EX-${i + 2}`, { depends_on: ['EX-1'] }));
  for (let i = 0; i < proposed; i++) tasks.push(task(`PR-${i + 1}`, { status: 'proposed' }));
  return {
    created: iso,
    limits: { maxConcurrent: 5, maxDPlus: 2, maxPerDomain: 5, maxDb: 2 },
    tasks,
    projects: { ex: { title: 'Example', prefixes: ['EX-', 'PR-'] } },
    areas: {},
    question: [],
    resolutions: [],
    changelog: [],
  };
}

const stateFor = (version: string, blocked: number, proposed = 0) => ({
  version,
  data: { ...T.board(makeQueue(blocked, proposed)), gitError: null, logo: false },
});
let state = stateFor('v1', 3, 2);

const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};
/** A new state from the "server": the board fetches again on the window's focus event. */
async function serve(next: typeof state) {
  state = next;
  window.dispatchEvent(new Event('focus'));
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

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const fold = (name: string) =>
  document.querySelector(`section.column[data-col="queue"] [data-section="${name}"]`) as HTMLElement | null;
const foldButton = (name: string) => fold(name)?.querySelector('.fold-button') as HTMLButtonElement | null;
const chainText = () => $('stripe').querySelector('.chain-line')?.textContent ?? '';
async function openCard(id: string) {
  const b = document.querySelector(`.summary[data-id="${id}"] .summary-button`) as HTMLButtonElement;
  expect(b, id).not.toBeNull();
  b.click();
  await flush();
}
function closePanel() {
  if (!$('panel').hidden) ($('panel').querySelector('.button-icon') as HTMLButtonElement).click();
}

describe('B5: headings in sentence case', () => {
  it('no selector on the board or in Plans sets text in all caps', () => {
    expect(css).not.toMatch(/text-transform:\s*uppercase/);
    expect(plansCss).not.toMatch(/text-transform:\s*uppercase/);
  });

  it('the section headings use weight 600 and a token size, without letter spacing', () => {
    const r = rule(css, '.section-title');
    expect(r).toMatch(/font-weight:\s*600/);
    expect(r).toMatch(/font-size:\s*var\(--text-[a-z]+\)/);
    expect(r).not.toMatch(/letter-spacing/);
  });

  it('the column header keeps the heading on one line; the agents badge gives way with an ellipsis', () => {
    expect(rule(css, '.col-header h2')).toMatch(/white-space:\s*nowrap/);
    const wip = rule(css, '.wip');
    expect(wip).toMatch(/min-width:\s*0/);
    expect(wip).toMatch(/overflow:\s*hidden/);
    expect(wip).toMatch(/text-overflow:\s*ellipsis/);
    // The counter and the heading never shrink below their text.
    expect(rule(css, '.counter')).toMatch(/flex:\s*none/);
  });

  it('the flat columns have a maximum width', () => {
    expect(rule(css, '.board.flat')).toMatch(/minmax\(280px,\s*\d+px\)/);
  });

  it('the ready heading and the column counter read as text, the full badge text stays in the title', async () => {
    await serve(stateFor('h1', 3, 2));
    const ready = document.querySelector('section.column[data-col="queue"] h3.section-title') as HTMLElement;
    expect(ready.textContent).toBe('Ready now (1)');
    const wip = document.querySelector('.col-header .wip') as HTMLElement;
    expect(wip.title.startsWith(wip.textContent ?? '')).toBe(true);
  });
});

describe('B25: folds that look like folds', () => {
  it('Blocked, Proposed: a button in a heading with aria-expanded, aria-controls and a chevron', async () => {
    await serve(stateFor('f1', 3, 2));
    for (const name of ['blocked', 'proposed']) {
      const b = foldButton(name);
      expect(b, name).not.toBeNull();
      expect(b!.tagName).toBe('BUTTON');
      expect(b!.type).toBe('button');
      expect(b!.closest('h3')).not.toBeNull();
      expect(b!.querySelector('.fold-chevron[aria-hidden="true"]')).not.toBeNull();
      const body = document.getElementById(b!.getAttribute('aria-controls') ?? '');
      expect(body, name).not.toBeNull();
      expect(['true', 'false']).toContain(b!.getAttribute('aria-expanded'));
      expect(body!.hidden).toBe(b!.getAttribute('aria-expanded') === 'false');
    }
    // No <details> left for these sections (the summary had no arrow and no button semantics).
    expect(document.querySelector('details.section')).toBeNull();
    expect(foldButton('blocked')!.textContent).toBe('Blocked (3)');
    expect(foldButton('proposed')!.textContent).toBe('Proposed (2)');
  });

  it('Blocked is open from the start with 20 cards or fewer, Proposed is closed', async () => {
    await serve(stateFor('f2', 20, 2));
    expect(foldButton('blocked')!.getAttribute('aria-expanded')).toBe('true');
    expect(fold('blocked')!.querySelectorAll('.summary')).toHaveLength(20);
    expect(foldButton('proposed')!.getAttribute('aria-expanded')).toBe('false');
    expect(fold('proposed')!.querySelectorAll('.summary')).toHaveLength(0);
  });

  it('Blocked is closed from the start above 20 cards, and its cards are not built until it opens', async () => {
    await serve(stateFor('f3', 21, 0));
    const b = foldButton('blocked')!;
    expect(b.getAttribute('aria-expanded')).toBe('false');
    expect(fold('blocked')!.querySelectorAll('.summary')).toHaveLength(0);
    b.click();
    await flush();
    expect(foldButton('blocked')!.getAttribute('aria-expanded')).toBe('true');
    expect(fold('blocked')!.querySelectorAll('.summary')).toHaveLength(21);
  });

  it("the viewer's own choice holds across a redraw (closed stays closed under 20)", async () => {
    // The viewer opened Blocked above: it stays open even though the count is above the limit.
    await serve(stateFor('f4', 25, 0));
    expect(foldButton('blocked')!.getAttribute('aria-expanded')).toBe('true');
    foldButton('blocked')!.click();
    await flush();
    expect(foldButton('blocked')!.getAttribute('aria-expanded')).toBe('false');
    await serve(stateFor('f5', 3, 0));
    expect(foldButton('blocked')!.getAttribute('aria-expanded')).toBe('false');
    expect(fold('blocked')!.querySelector('.fold-body')!.hasAttribute('hidden')).toBe(true);
  });

  it('the fold button has the shared disclosure style: hover surface, 32 px target and a turning chevron', () => {
    expect(rule(css, '.fold-button')).toMatch(/min-height:\s*32px/);
    // The shared hover layer since B7 (queueBoardHoverEmpty.test.ts).
    expect(css).toMatch(/\.fold-button:hover\s*\{[^}]*background-image:\s*linear-gradient\(var\(--state-hover\)/);
    expect(rule(css, '.fold-chevron')).toMatch(/width:\s*16px/);
    expect(css).toMatch(/\[aria-expanded='true'\]\s*>\s*\.fold-chevron/);
    // The Plans folds get the same chevron and hover.
    expect(css).toMatch(/\.plans-fold:hover/);
    expect(css).toMatch(/\.unregistered-toggle(:not\(:disabled\))?:hover/);
  });

  it('the Unregistered box in Plans gets its own padding (PL6: the rules named .unreg, the box is .unregistered)', () => {
    const src = readFileSync(join(CLIENT, 'plans', 'read.js'), 'utf8');
    expect(src).toContain("class: `unregistered${count ? ' has-unregistered' : ''}`");
    expect(rule(plansCss, '.unregistered')).toMatch(/padding:\s*var\(--distance-xs\) var\(--distance-lg\)/);
    expect(plansCss).not.toMatch(/\.unreg[\s.{,:]/);
  });

  it('the Plans and Focus folds draw the shared chevron instead of a text arrow', () => {
    for (const f of ['plans/plans.js', 'plans/read.js', 'plans/documents.js', 'plans/legal.js', 'plan.js']) {
      const src = readFileSync(join(CLIENT, f), 'utf8');
      expect(src, f).toContain('fold-chevron');
      expect(src, f).not.toMatch(/open \? '▾ ?' : '▸ ?'/);
    }
  });
});

describe('B25: the chain line names the real cause', () => {
  it('a closed fold: "in the closed Blocked group" with Show, which opens it', async () => {
    await serve(stateFor('c1', 3, 0));
    // Blocked is closed (the choice from the test above holds).
    expect(foldButton('blocked')!.getAttribute('aria-expanded')).toBe('false');
    await openCard('EX-1');
    expect(chainText()).toContain('3 in the closed Blocked group');
    expect(chainText()).not.toContain('filter');
    const show = [...$('stripe').querySelectorAll('.chain-line button')].find((b) => b.textContent === 'Show') as HTMLButtonElement;
    expect(show).toBeDefined();
    expect(show.getAttribute('aria-label')).toBe('Show the Blocked group');
    closePanel();
    show.click();
    await flush();
    expect(foldButton('blocked')!.getAttribute('aria-expanded')).toBe('true');
    expect(chainText()).not.toMatch(/closed|hidden/);
  });

  it('the search: "hidden by the search" with Clear search', async () => {
    const search = $('search') as HTMLInputElement;
    search.value = 'EX-1';
    search.dispatchEvent(new Event('input'));
    await flush();
    await openCard('EX-1');
    expect(chainText()).toContain('3 hidden by the search');
    expect([...$('stripe').querySelectorAll('.chain-line button')].map((b) => b.textContent)).toContain('Clear search');
    closePanel();
    search.value = '';
    search.dispatchEvent(new Event('input'));
    await flush();
  });

  it('the text for every cause, with the action that reveals it', () => {
    const parts = A.chainHidden([
      { cause: 'fold', n: 2, name: 'Blocked', key: 'blocked' },
      { cause: 'filter', n: 1 },
      { cause: 'search', n: 3 },
      { cause: 'selection', n: 1, name: 'On hold' },
      { cause: 'older', n: 2 },
      { cause: 'elsewhere', n: 1 },
    ]);
    expect(parts.map((p) => p.text)).toEqual([
      '2 in the closed Blocked group',
      '1 hidden by the filter',
      '3 hidden by the search',
      '1 outside the selection "On hold"',
      '2 older than 7 days in Built',
      '1 not shown in this view',
    ]);
    expect(parts.map((p) => p.action)).toEqual(['fold:blocked', 'filter', 'search', 'selection', 'older', null]);
    expect(parts.map((p) => p.label)).toEqual(['Show', 'Remove filter', 'Clear search', 'Show all', 'Show more', null]);
    expect(parts[0].aria).toBe('Show the Blocked group');
    // Nothing hidden: no parts; zero counts are left out.
    expect(A.chainHidden([])).toEqual([]);
    expect(A.chainHidden([{ cause: 'filter', n: 0 }])).toEqual([]);
  });
});
