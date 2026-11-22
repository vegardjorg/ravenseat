/**
 * @vitest-environment jsdom
 */
// =============================================================
// queueBoardQa1e.test.ts: why things are grayed in Dependencies, and the project name on lane cards (QA-1e: Q6, Q8).
//
// What the tests prove:
//   - Q6: selecting a task in Dependencies shows a status line in the graph's top area ("Showing the chain of <id>
//     (<n> tasks) · Clear selection"). The line is a polite live region that is always in the layout with a fixed
//     height, so it never pushes the graph down. "Clear selection" and Esc both clear it. The card views say the
//     same in the strip above the columns (plus "the rest is faded"); in Dependencies the strip leaves it to the graph
//     line, so the chain is never explained twice.
//   - Q6: the legend explains the dimmed states, and only the ones that apply right now: "faded: outside the selected
//     chain" (while a chain is selected; its slot is kept so nothing moves), "small gray: hidden by your filter or
//     search" (when neighbor nodes are drawn) and "pale: done" (when done predecessors are drawn).
//   - Q6: a neighbor node is named "<title>: hidden by the filter or search, <id>" and still opens on a click; a done
//     node says "done".
//   - Q8: cards keep the project short name and color dot in Project lanes and in Flat grouped by area or feature,
//     and the card cache key no longer depends on the view or grouping (the same node is reused when they change).
// =============================================================
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { clientSource } from './boardClient';

/* eslint-disable @typescript-eslint/no-require-imports */
const T = require('../queueBoard.js') as { board: (queue: unknown, option?: unknown) => any };
/* eslint-enable @typescript-eslint/no-require-imports */

const CLIENT = join(__dirname, '..', '..', 'queue-board');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const css = strip(readFileSync(join(CLIENT, 'board.css'), 'utf8'));
const html = readFileSync(join(CLIENT, 'index.html'), 'utf8');
const iso = new Date(Date.now() - 86_400_000).toISOString();

/** The declarations of every top-level rule that lists exactly this selector. */
function base(selector: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
    const selectors = m[1].split(',').map((s) => s.trim());
    if (!selectors.includes(selector)) continue;
    for (const d of m[2].split(';')) {
      const colon = d.indexOf(':');
      if (colon > 0) out[d.slice(0, colon).trim()] = d.slice(colon + 1).trim();
    }
  }
  return out;
}

// ---- A queue with one chain across two projects and a done predecessor ----------------------------------------------
//   EX-0 (done) -> EX-1 -> EX-2 -> EX-3, and EX-1 -> OT-1 (another project, so a project filter makes it a neighbor).
function makeQueue() {
  const task = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    title: `Title ${id}`,
    feature: id.startsWith('EX') ? 'Feature A' : 'Feature B',
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
    tasks: [
      task('EX-0', { status: 'done', done: iso }),
      task('EX-1', { depends_on: ['EX-0'] }),
      task('EX-2', { depends_on: ['EX-1'] }),
      task('EX-3', { depends_on: ['EX-2'] }),
      task('OT-1', { depends_on: ['EX-1'] }),
    ],
    projects: { ex: { title: 'Example', prefixes: ['EX-'] }, ot: { title: 'Other', prefixes: ['OT-'] } },
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
const key = (target: Element, k: string) =>
  target.dispatchEvent(new (window as any).KeyboardEvent('keydown', { key: k, bubbles: true }));

beforeAll(async () => {
  document.documentElement.innerHTML = html.replace(/<!doctype[^>]*>/i, '').replace(/<\/?html[^>]*>/g, '');
  sessionStorage.setItem('queue-board-key', 'testKey');
  localStorage.clear();
  // The graph's options: done predecessors shown, neighbors on (the default).
  localStorage.setItem('queue-board-graph', JSON.stringify({ finished: true }));
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

const node = (id: string) => document.querySelector(`.graph-svg .node[data-id="${id}"]`) as SVGGElement | null;
const status = () => document.querySelector('.graph-top .graph-chain-status') as HTMLElement;
const legendItem = (k: string) => document.querySelector(`.graph-draw li[data-legend="${k}"]`) as HTMLElement | null;
const closePanel = async () => {
  if (!$('panel').hidden) key(document.body, 'Escape');
  await flush();
};
async function setProjectFilter(pid: string, on: boolean) {
  if ($('filter-menu').hidden) $('filter-button').click();
  const box = $('filter-menu').querySelector(`#f-projects-${pid}`) as HTMLInputElement;
  if (box.checked !== on) box.click();
  await flush();
  if (!$('filter-menu').hidden) $('filter-button').click();
  await flush();
}

// ---- Q6: the chain status line ---------------------------------------------------------------------------------------

describe('Q6: the chain status line in Dependencies', () => {
  it('is in the graph top from the first draw: empty, polite and with a fixed height', async () => {
    $('show-graph').click();
    await flush();
    const s = status();
    expect(s).not.toBeNull();
    expect(s.getAttribute('role')).toBe('status');
    expect(s.getAttribute('aria-live')).toBe('polite');
    expect(s.textContent).toBe('');
    // A fixed height (and a full row), so the text appearing never moves the graph.
    expect(base('.graph-chain-status').height).toMatch(/^\d+px$/);
    expect(base('.graph-chain-status')['flex-basis']).toBe('100%');
  });

  it('selecting a task shows "Showing the chain of <id> (<n> tasks) · Clear selection"', async () => {
    const before = status();
    node('EX-2')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();
    // The same element is updated (a live region is only announced when it was already in the page).
    expect(status()).toBe(before);
    // EX-2's chain (the server's, open tasks only): EX-1 before it and EX-3 after it. 3 tasks with EX-2.
    const lead = status().querySelector('.graph-chain-text') as HTMLElement;
    expect(lead.textContent).toBe('Showing the chain of EX-2 (3 tasks)');
    const clear = status().querySelector('button') as HTMLButtonElement;
    expect(clear.textContent).toBe('Clear selection');
    expect(status().textContent).toMatch(/^Showing the chain of EX-2 \(3 tasks\) · .*Clear selection$/);
    // The strip above the graph does not say it a second time.
    expect($('stripe').querySelector('.chain-line')).toBeNull();
  });

  it('"Clear selection" clears the line and the dimming', async () => {
    await closePanel();
    (status().querySelector('button') as HTMLButtonElement).click();
    await flush();
    expect(status().textContent).toBe('');
    expect(document.querySelector('.graph-svg')!.classList.contains('chain-active')).toBe(false);
  });

  it('Esc clears it too (the first Esc closes the panel, the next clears the chain)', async () => {
    node('EX-3')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();
    expect(status().textContent).toContain('Showing the chain of EX-3');
    await closePanel();
    expect(status().textContent).toContain('Showing the chain of EX-3');
    key(document.body, 'Escape');
    await flush();
    expect(status().textContent).toBe('');
  });
});

// ---- Q6: the legend --------------------------------------------------------------------------------------------------

describe('Q6: the legend explains the dimmed states that apply', () => {
  it('"faded" keeps its slot but is shown only while a chain is selected', async () => {
    const faded = legendItem('faded')!;
    expect(faded.textContent).toBe('faded: outside the selected chain');
    expect(faded.classList.contains('legend-idle')).toBe(true);
    expect(faded.getAttribute('aria-hidden')).toBe('true');
    expect(base('.graph-draw .legend-idle').visibility).toBe('hidden');
    node('EX-2')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();
    expect(legendItem('faded')!.classList.contains('legend-idle')).toBe(false);
    expect(legendItem('faded')!.getAttribute('aria-hidden')).toBeNull();
    await closePanel();
    key(document.body, 'Escape');
    await flush();
    expect(legendItem('faded')!.classList.contains('legend-idle')).toBe(true);
  });

  it('"pale: done" is there when done predecessors are drawn', () => {
    expect(node('EX-0')).not.toBeNull();
    expect(legendItem('done')?.textContent).toBe('pale: done');
  });

  it('"small gray" is there only when a filter or search hides neighbors', async () => {
    expect(legendItem('neighbor')).toBeNull();
    await setProjectFilter('ex', true);
    expect(node('OT-1')!.classList.contains('role-neighbor')).toBe(true);
    expect(legendItem('neighbor')?.textContent).toBe('small gray: hidden by your filter or search');
  });
});

// ---- Q6: names -------------------------------------------------------------------------------------------------------

describe('Q6: neighbor and done nodes say why they look dimmed', () => {
  // deps H1: the title first, the id after it (it was "<id> <title>: ...").
  it('a neighbor is named "<title>: hidden by the filter or search, <id>", in the tooltip too', () => {
    const g = node('OT-1')!;
    expect(g.getAttribute('aria-label')).toMatch(/^Title OT-1: hidden by the filter or search, OT-1, /);
    expect(g.querySelector('title')!.textContent).toMatch(/^Title OT-1: hidden by the filter or search\nOT-1\n/);
  });

  it('a click on a neighbor still opens it', async () => {
    node('OT-1')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();
    expect($('panel').hidden).toBe(false);
    expect($('panel').textContent).toContain('OT-1');
    await closePanel();
    key(document.body, 'Escape');
    await flush();
  });

  it('a done node says "done"', () => {
    const g = node('EX-0')!;
    expect(g.classList.contains('role-done')).toBe(true);
    expect(g.getAttribute('aria-label')).toMatch(/\bdone\b/);
    expect(g.querySelector('title')!.textContent).toMatch(/\ndone(\n|$)/);
  });
});

// ---- Q6: the card views say the same in the strip ----------------------------------------------------------------------

describe('Q6: the card views explain the faded cards', () => {
  it('the strip says which chain is shown and that the rest is faded, with Clear selection', async () => {
    await setProjectFilter('ex', false);
    $('show-flat').click();
    await flush();
    (document.querySelector('.summary[data-id="EX-2"] .summary-button') as HTMLButtonElement).click();
    await flush();
    const line = $('stripe').querySelector('.chain-line') as HTMLElement;
    expect(line.getAttribute('role')).toBe('status');
    expect(line.textContent).toContain('Showing the chain of EX-2 (3 tasks)');
    expect(line.textContent).toContain('the rest is faded');
    const clear = [...line.querySelectorAll('button')].find((b) => b.textContent === 'Clear selection');
    expect(clear).toBeTruthy();
    await closePanel();
    clear!.click();
    await flush();
    expect($('stripe').querySelector('.chain-line')).toBeNull();
  });
});

// ---- Q8: the project name on cards everywhere -------------------------------------------------------------------------

describe('Q8: cards keep the project name and dot', () => {
  const card = (id: string) => document.querySelector(`.summary[data-id="${id}"]`) as HTMLElement;

  it('in Project lanes', async () => {
    $('show-lanes').click();
    await flush();
    const c = card('EX-1');
    expect(c).not.toBeNull();
    const p = c.querySelector('.summary-project') as HTMLElement;
    expect(p?.textContent).toBe('ex');
    expect(p.title).toBe('Example');
    // The dot is .summary-project::before in the card's project color (--p on the card).
    expect(c.style.getPropertyValue('--p')).toMatch(/^var\(--color-/);
    expect(css).toMatch(/\.summary-project::before\s*\{[^}]*background:\s*var\(--p/);
  });

  it('in Flat grouped by area or feature, with the same card node reused (the cache key ignores the grouping)', async () => {
    $('show-flat').click();
    await flush();
    const g = $('grouping') as HTMLSelectElement;
    g.value = 'none';
    g.dispatchEvent(new Event('change'));
    await flush();
    const first = card('EX-2');
    expect(first.querySelector('.summary-project')?.textContent).toBe('ex');
    for (const v of ['feature', 'area', 'none']) {
      g.value = v;
      g.dispatchEvent(new Event('change'));
      await flush();
      expect(card('EX-2').querySelector('.summary-project')?.textContent, v).toBe('ex');
      // Unchanged DOM, unchanged key: the buffer hands back the same node.
      expect(card('EX-2'), v).toBe(first);
    }
  });

  it('the card source has no view rule for the project name any more', () => {
    expect(clientSource('board/')).not.toMatch(/showProjectName/);
  });
});
