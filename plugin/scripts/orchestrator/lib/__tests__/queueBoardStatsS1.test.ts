/**
 * @vitest-environment jsdom
 */
// =============================================================
// queueBoardStatsS1.test.ts: the Statistics cards keep their own styles, and the value texts give way to the lines
// (board step S1, the bugs 1.1 and 1.2 in the statistics review of 2026-11-18).
//
// What the tests prove:
//   - no CSS rule written for another view leaks into a Statistics card: no rule from the Dependencies section, and no
//     rule for the help legend (.explanation, .legend) or a legend sample (.draw-line) from outside the Statistics
//     section, matches an element inside a chart card. That was the bug: `.graph-svg { height: 100% }` (the graph) and
//     `.explanation { display: grid }` (the help) came later in board.css and won, so the legends ran below the card,
//   - the Statistics rules that replace them have their own scope (.graph ...) with the intended values,
//   - a legend sample is drawn like its line in the chart: dashed for a dashed line, solid for "Added" (solid),
//   - a value text next to a bar never sits on a vertical line (cap, estimate): it moves past the line, and the lines
//     are drawn before the texts so a text is on top,
//   - the context chart's axis ends at 1.1 times the larger of max and cap, so the top value is never on the edge.
// The whole board runs in jsdom with a mock server (no network), as in queueBoardMetrics.test.ts.
// =============================================================
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { clientSource } from './boardClient';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const T = require('../queueBoard.js') as { board: (queue: unknown, option?: unknown) => any };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const S = require('../queueStatistics.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const SX = require('../statisticsSections.js');

const CLIENT = join(__dirname, '..', '..', 'queue-board');
const cssText = readFileSync(join(CLIENT, 'board.css'), 'utf8');
const now = Date.now();
const iso = (min: number) => new Date(now - min * 60_000).toISOString();

// Two finished K tasks (time per class with an estimate line) and two track agents with context, the larger at 288k
// against the 300k cap (the case from the review where "288k" sat on the cap line).
const task = (id: string, back: number) => ({
  id,
  project: 'a',
  title: `Title ${id}`,
  class: 'K',
  status: 'done',
  estimate: 100,
  added_at: iso(back + 200),
  started: iso(back + 110),
  delivered: iso(back + 20),
  done: iso(back),
});
const queue = {
  limits: {},
  projects: {},
  areas: {},
  tasks: [task('K-1', 120), task('K-2', 60)],
  question: {},
  resolutions: {},
  changelog: [],
};
const rows = [
  { time: iso(90), event: 'done', agent_id: 'a1', agent_type: 'track', tokens: { input: 1000 }, context: { end: 150_000 } },
  { time: iso(30), event: 'done', agent_id: 'a2', agent_type: 'track', tokens: { input: 1000 }, context: { end: 288_000 } },
];
const state = { version: 'v1', data: { ...T.board(queue), gitError: null, logo: false, update: null } };

const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};

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
  w.fetch = async (filePath: string) => {
    if (filePath.startsWith('/api/statistics'))
      return {
        ok: true,
        status: 200,
        json: async () => {
          const stat = S.statistics(queue, rows);
          return { version: 's1', data: { ...stat, sections: SX.sections({ queue, rows, statistics: stat }), guards: null, timeLogError: null } };
        },
      };
    // Settings is only opened by the advice button; its content is not in this test.
    if (filePath.startsWith('/api/settings'))
      return { ok: true, status: 200, json: async () => ({ error: 'not in this test' }) };
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
  (document.getElementById('show-statistics') as HTMLButtonElement).click();
  await flush();
}, 60_000);

/** board.css split at its section headers ("/* ---- Name ---- *\/"), each section's style rules parsed by jsdom. */
function sections(): { name: string; rules: CSSStyleRule[] }[] {
  const parts = cssText.split(/\n(?=\/\* ---- )/);
  return parts.map((text) => {
    const name = text.match(/^\/\* ---- ([^\n]*?)(?: ----|$)/m)?.[1] ?? '(top)';
    const style = document.createElement('style');
    style.textContent = text;
    document.head.append(style);
    const rules: CSSStyleRule[] = [];
    const walk = (list: CSSRuleList) => {
      for (const r of [...list]) {
        if ((r as CSSStyleRule).selectorText) rules.push(r as CSSStyleRule);
        else if ((r as CSSMediaRule).cssRules) walk((r as CSSMediaRule).cssRules);
      }
    };
    walk((style.sheet as CSSStyleSheet).cssRules);
    style.remove();
    return { name, rules };
  });
}

/** The declarations of the rules with exactly this selector in the Statistics section, later ones winning. */
function statRule(selector: string): Record<string, string> {
  const out: Record<string, string> = {};
  const stat = sections().find((x) => x.name === 'Statistics');
  for (const r of stat?.rules ?? []) {
    const sels = r.selectorText.split(',').map((x) => x.trim().replace(/\s+/g, ' '));
    if (!sels.includes(selector)) continue;
    for (let i = 0; i < r.style.length; i++) out[r.style[i]] = r.style.getPropertyValue(r.style[i]);
  }
  return out;
}

const cards = () => [...document.querySelectorAll('.board.statistics .graphs > .graph')] as HTMLElement[];

describe('Statistics S1: no style from another view leaks into the chart cards', () => {
  it('draws the chart cards with their legends (S2: five in Cost and tokens, two in Flow, three in Machine)', () => {
    expect(cards()).toHaveLength(10);
    expect(cards().every((c) => c.querySelector('ul.explanation'))).toBe(true);
    // No phases measured and no timed gate run: those two cards say so instead of drawing an empty chart.
    expect(cards().filter((c) => c.querySelector('svg.graph-svg'))).toHaveLength(8);
  });

  it('no rule from Dependencies, or for the help legend or a legend sample outside Statistics, matches in a card', () => {
    const foreign: string[] = [];
    for (const sec of sections()) {
      for (const r of sec.rules) {
        for (const sel of r.selectorText.split(',').map((x) => x.trim())) {
          const own = sec.name === 'Statistics';
          const help = /\.(explanation|legend|draw-line|draw-dot)\b/.test(sel);
          if (!(sec.name.startsWith('Dependencies') || (help && !own))) continue;
          // Pseudo-elements never match an element; strip them so the base selector is checked.
          const base = sel.replace(/::?(before|after|placeholder|marker)\b.*$/, '').trim();
          if (!base) continue;
          let hit = false;
          for (const c of cards()) {
            try {
              hit = c.matches(base) || !!c.querySelector(base);
            } catch {
              hit = false;
            }
            if (hit) break;
          }
          if (hit) foreign.push(`${sec.name}: ${sel}`);
        }
      }
    }
    expect(foreign).toEqual([]);
  });

  it('the Statistics rules have their own scope with the intended values', () => {
    expect(statRule('.graph .graph-svg').height).toBe('auto');
    const ex = statRule('.graph .explanation');
    expect(ex.display).toBe('flex');
    expect(ex['flex-wrap']).toBe('wrap');
    expect(statRule('.graph .draw-line')['border-top']).toMatch(/dashed/);
    expect(statRule('.graph .draw-line.draw-solid')['border-top-style']).toBe('solid');
  });

  it('a legend sample is drawn like its line: solid for Added, dashed for the estimate and the cap', () => {
    const sample = (text: string) =>
      [...document.querySelectorAll('.board.statistics .graph .explanation li')]
        .find((li) => li.textContent === text)
        ?.querySelector('span');
    expect(sample('Added')?.classList.contains('draw-solid')).toBe(true);
    for (const t of ['Estimated average', 'Cap 300k']) {
      expect(sample(t)?.classList.contains('draw-line')).toBe(true);
      expect(sample(t)?.classList.contains('draw-solid')).toBe(false);
    }
  });
});

describe('Statistics S1: the value texts give way to the lines', () => {
  /** The x of the vertical lines (cap, estimate) in a horizontal chart. */
  const lineXs = (svg: SVGSVGElement) =>
    [...svg.querySelectorAll('line[class^="line-"]')].map((l) => Number(l.getAttribute('x1')));
  const horizontal = () =>
    cards()
      .map((c) => c.querySelector('svg.graph-svg') as SVGSVGElement)
      .filter(Boolean)
      .filter((svg) => svg.querySelector('line[class^="line-"]') && svg.querySelector('text.value'));

  it('every value text is marked, and no vertical line runs through one (text width about 7.2 units a character)', () => {
    // Time per class (the estimate line); the context is a point strip since S4.
    expect(horizontal().length).toBe(1);
    for (const svg of horizontal()) {
      for (const t of [...svg.querySelectorAll('text.value')]) {
        const x0 = Number(t.getAttribute('x'));
        const w = (t.textContent ?? '').length * 7.2;
        const [from, to] = t.getAttribute('text-anchor') === 'end' ? [x0 - w, x0] : [x0, x0 + w];
        for (const lx of lineXs(svg))
          expect(lx < from - 2 || lx > to + 2, `${t.textContent} at ${from}..${to}, line at ${lx}`).toBe(true);
        expect(to).toBeLessThanOrEqual(560);
      }
    }
  });

  it('the lines are drawn before the value texts, so a text is on top', () => {
    for (const svg of horizontal()) {
      const all = [...svg.children];
      const lastLine = Math.max(...[...svg.querySelectorAll('line[class^="line-"]')].map((l) => all.indexOf(l)));
      const firstText = Math.min(...[...svg.querySelectorAll('text.value')].map((t) => all.indexOf(t)));
      expect(lastLine).toBeLessThan(firstText);
    }
  });

  it('the context strip ends at 1.1 times the larger of max and cap, with one point per track and the cap labelled', () => {
    const card = cards().find((c) => c.querySelector('figcaption')?.textContent === 'Do the tracks come near the cap?');
    const svg = card?.querySelector('svg.graph-svg') as SVGSVGElement;
    const axis = svg.querySelector('line.axis') as SVGLineElement;
    const left = Number(axis.getAttribute('x1'));
    const right = Number(axis.getAttribute('x2'));
    const cap = Number(svg.querySelector('line.line-cap')?.getAttribute('x1'));
    // 300k of 330k: the cap sits at about 91 % of the axis, not on the edge.
    expect((cap - left) / (right - left)).toBeCloseTo(300 / 330, 3);
    expect([...svg.querySelectorAll('text')].map((t) => t.textContent)).toContain('cap 300k');
    const dots = [...svg.querySelectorAll('circle.dot')];
    expect(dots).toHaveLength(2);
    // 288k is over 80 % of the cap: marked near, the 150k one not.
    expect(dots.filter((c) => c.classList.contains('s-near'))).toHaveLength(1);
  });
});

// The rework (S2 to S7 of the same review): the order, the questions, the advice lines and the colors.
describe('Statistics S2 to S7: the top row, the sections and the advice', () => {
  const tab = () => document.querySelector('.board.statistics') as HTMLElement;

  it('the top row has the five numbers in order, and the legend for the classes is gone from the tab', () => {
    const names = [...tab().querySelectorAll('.keyFigures .tile-name')].map((x) => x.textContent);
    expect(names).toEqual(['Cost per merged change', 'Finished against new', 'Right first time', 'Waiting on you', 'Weekly quota']);
    // Too few answers is said, not hidden.
    expect(tab().querySelectorAll('.keyFigures .tile-value')[3].textContent).toBe('too few answers yet');
    expect(tab().querySelector('.legend')).toBeNull();
  });

  it('four sections as folds with a heading each, in the order of the review', () => {
    const titles = [...tab().querySelectorAll('details.stat-section > summary h3')].map((h) => h.textContent);
    expect(titles).toEqual(['Cost and tokens', 'Flow', 'Quality', 'Machine']);
    expect(statRule('.stat-section-title')['text-transform'] ?? '').not.toBe('uppercase');
  });

  it('every chart asks one question and has a "Does this look bad?" line', () => {
    for (const c of cards()) {
      expect(c.querySelector('figcaption')?.textContent).toMatch(/\?$/);
      expect(c.querySelector('.graph-advice')?.textContent).toMatch(/^Does this look bad\? /);
    }
  });

  it('a setting button opens the gear', async () => {
    const button = [...tab().querySelectorAll('.graph-advice button')].find((b) => b.textContent === 'limits.dailyBudget') as HTMLButtonElement;
    expect(button.getAttribute('aria-label')).toBe('Open the setting limits.dailyBudget');
    button.click();
    await flush();
    expect(document.getElementById('settings')?.getAttribute('aria-expanded')).toBe('true');
  });

  it('night is a muted blue and Added a neutral: purple is for D+ only', () => {
    expect(cssText).toMatch(/\.s-night \{\s*--s: var\(--color-category-slate\)/);
    expect(cssText).not.toMatch(/\.s-in \{\s*--s: var\(--color-category-plum\)/);
  });

  // Last in the file: it narrows the board. A window that turns narrow gets its charts drawn again at the new width.
  it('a resize to phone width draws the charts again at the card width', async () => {
    const width = () => Number(cards()[0].querySelector('svg.graph-svg')?.getAttribute('viewBox')?.split(' ')[2]);
    expect(width()).toBe(560);
    const main = document.getElementById('board') as HTMLElement;
    Object.defineProperty(main, 'clientWidth', { configurable: true, get: () => 390 });
    window.dispatchEvent(new Event('resize'));
    await new Promise((r) => setTimeout(r, 200));
    await flush();
    expect(width()).toBe(390 - 66);
  });
});
