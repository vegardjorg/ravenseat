/**
 * @vitest-environment jsdom
 */
// =============================================================
// queueBoardGraphLabels.test.ts: the labels and the legend of the Dependencies graph (board step B33, finding G1).
//
// What the tests prove:
//   - a task's id sits below its status ring, never inside it: the label's top (hanging baseline) is below the
//     ring's outer edge with the thickest ring stroke the CSS draws (selected, focus, in progress), at every circle
//     size the graph uses; a question's id sits above its square and "unlocks N" below it, both clear of the edge,
//   - the label font has a cap: on screen it stays between 12 and 14 px (--text-xs to --text-sm) at every zoom, because
//     the view sets the zoom as a CSS variable and the font size divides by it,
//   - every legend sample has a visible edge that holds 3:1 against the surfaces behind it, light and dark, and the
//     sample for each state uses the same edge color as the ring it explains,
//   - the nodes keep their keyboard and screen reader behaviour (tab stop, role, name, Enter opens).
// The graph is the repo's own graph.js with the real queueGraph.js in jsdom (no real data).
// =============================================================
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/* eslint-disable @typescript-eslint/no-require-imports */
const G = require('../queueGraph.js') as { MEASURE: { rMin: number; rMax: number; rSmall: number } };
const { PALETTE } = require('../queueBoard.js') as {
  PALETTE: { light: Record<string, string>; dark: Record<string, string> };
};
const U = require('../../queue-board/a11y.js') as { contrast: (a: string, b: string) => number };
/* eslint-enable @typescript-eslint/no-require-imports */

const CLIENT = join(__dirname, '..', '..', 'queue-board');
const graphJs = readFileSync(join(CLIENT, 'graph.js'), 'utf8');
const css = readFileSync(join(CLIENT, 'board.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** The declarations of one CSS rule with exactly this selector (one selector of a list also matches). */
function rule(selector: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of css.matchAll(/()([^{}]+)\{([^}]*)\}/g)) {
    const sels = m[2].split(',').map((x) => x.trim().replace(/\s+/g, ' '));
    if (!sels.includes(selector)) continue;
    for (const d of m[3].split(';')) {
      const i = d.indexOf(':');
      if (i > 0) out[d.slice(0, i).trim()] = d.slice(i + 1).trim();
    }
  }
  return out;
}
const token = (v: string | undefined) => v?.match(/var\(--color-([a-z0-9-]+)\)/)?.[1];

/** The thickest stroke any rule in board.css gives the ring of a task node (selected, focus, active, chain). */
function thickestRingStroke(): number {
  let max = 0;
  for (const m of css.matchAll(/()([^{}]+)\{([^}]*)\}/g)) {
    if (!/\.ring\b/.test(m[2])) continue;
    const w = m[3].match(/stroke-width:\s*([\d.]+)/);
    if (w) max = Math.max(max, Number(w[1]));
  }
  return max;
}

/** A small queue in the shape queueBoard.board gives: chains of every state and size, and an owner question. */
function data() {
  const card = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    project: 'a',
    title: `Title ${id}`,
    status: 'waiting',
    ready: true,
    depends_on: [],
    ...extra,
  });
  return {
    columns: {
      queue: [
        card('S-1', { estimate: 5 }),
        card('S-2', { estimate: 5, depends_on: ['S-1'], ready: false }),
        card('L-1', { estimate: 600 }),
        card('L-2', { estimate: 600, depends_on: ['L-1'], ready: false }),
        card('Q-W', { estimate: 40, ready: false }),
      ],
      proposed: [],
      inProgress: [card('A-1', { estimate: 120, status: 'active' }), card('A-2', { estimate: 40, depends_on: ['A-1'], status: 'waiting', ready: false })],
      review: [],
      built: [],
    },
    inbox: { question: [{ type: 'question', sp: 'Q-1', text: 'Is Q-W wanted?', direct: ['Q-W'], count: 1 }] },
    projects: [{ pid: 'a', title: 'Project a', color: 'category-teal' }],
  };
}

function el(tag: string, attr: Record<string, unknown> | null, ...children: unknown[]) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attr ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = String(v);
    else if (k === 'text') e.textContent = String(v);
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'checked') (e as HTMLInputElement).checked = !!v;
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const b of (children as unknown[]).flat()) if (b != null && b !== false) e.append(b as Node);
  return e;
}

let main: HTMLElement;
const opened: string[] = [];
beforeAll(() => {
  const w = window as unknown as Record<string, unknown>;
  w.QueueGraph = require('../queueGraph.js');
  if (!(globalThis as { CSS?: unknown }).CSS) (globalThis as { CSS?: unknown }).CSS = { escape: (x: string) => x };
  new Function(graphJs)();
  main = document.createElement('main');
  document.body.append(main);
  (w.QueueGraphView as { draw: (c: unknown) => void }).draw({
    el,
    main,
    version: 1,
    filterKey: '',
    data: data(),
    visible: () => true,
    drawOnNew: () => {},
    openPanel: (id: string) => opened.push(id),
    openDecisions: (id: string) => opened.push(id),
  });
});

const nodes = () => [...main.querySelectorAll('.graph-svg .node')] as SVGGElement[];

describe('labels sit outside the status ring', () => {
  it('the graph draws circles of several sizes, so the check covers the range', () => {
    const radii = new Set(
      nodes()
        .filter((g) => g.classList.contains('task'))
        .map((g) => Number(g.querySelector('circle.fill')?.getAttribute('r'))),
    );
    expect(radii.size).toBeGreaterThan(1);
  });

  it('every task label hangs below the ring outer edge with the thickest ring stroke, plus a gap', () => {
    const stroke = thickestRingStroke();
    expect(stroke).toBeGreaterThanOrEqual(3);
    const lbl = rule('.graph-svg .node .label');
    expect(lbl['dominant-baseline']).toBe('hanging');
    for (const g of nodes().filter((x) => x.classList.contains('task'))) {
      const r = Number(g.querySelector('circle.fill')?.getAttribute('r'));
      const ring = g.querySelector('circle.ring');
      const outer = (ring ? Number(ring.getAttribute('r')) : r) + stroke / 2;
      const y = Number(g.querySelector('text.label')?.getAttribute('y'));
      expect(y, g.dataset.id).toBeGreaterThanOrEqual(outer + 2);
    }
  });

  it('the label offset holds for the smallest and the largest circle the layout gives', () => {
    const V = (window as unknown as { QueueGraphView: { labelY: (r: number) => number } }).QueueGraphView;
    const stroke = thickestRingStroke();
    for (const r of [G.MEASURE.rSmall, G.MEASURE.rMin, G.MEASURE.rMax])
      expect(V.labelY(r)).toBeGreaterThanOrEqual(r + 3 + stroke / 2 + 2);
  });

  it('a question label (its text, then the id and "unlocks N") hangs below its square, clear of the edge', () => {
    const q = nodes().find((g) => g.classList.contains('sp')) as SVGGElement;
    const h = Number(q.querySelector('rect.sp-box')?.getAttribute('width')) / 2;
    const label = Number(q.querySelector('text.label')?.getAttribute('y'));
    expect(label).toBeGreaterThanOrEqual(h + 3);
    const locks = q.querySelector('text.label .graph-locks');
    expect(locks?.textContent).toBe('unlocks 1');
    expect(rule('.graph-svg .node .label')['dominant-baseline']).toBe('hanging');
  });
});

describe('the title is what you read first (deps H1)', () => {
  const lines = (g: Element) => [...g.querySelectorAll('text.label > tspan')].map((t) => t.textContent);

  it('every core task shows its title, then a muted line with the id', () => {
    for (const g of nodes().filter((x) => x.classList.contains('role-core'))) {
      const id = g.dataset.id as string;
      const l = lines(g);
      expect(l[0], id).toBe(`Title ${id}`);
      expect(l[l.length - 1], id).toMatch(new RegExp(`^${id}\\b`));
      expect(g.querySelector('tspan.label-meta')?.textContent, id).toMatch(new RegExp(`^${id}\\b`));
      expect(g.querySelector('text.label')?.classList.contains('titled'), id).toBe(true);
    }
  });

  it('small nodes are labelled too: the titled label is shown without hover or zoom', () => {
    expect(rule('.graph-svg .node .label.titled').display).toBe('inline');
    const small = nodes().find((g) => g.dataset.id === 'S-1') as SVGGElement;
    expect(small.classList.contains('large')).toBe(false);
    expect(lines(small)[0]).toBe('Title S-1');
  });

  it('a question shows its text first, its id muted after', () => {
    const q = nodes().find((g) => g.classList.contains('sp')) as SVGGElement;
    expect(lines(q)[0]).toBe('Is Q-W wanted?');
    expect(q.querySelector('tspan.label-meta')?.textContent).toMatch(/^Q-1\b/);
  });

  it('the muted line uses the muted text token', () => {
    expect(token(rule('.graph-svg .node .label .label-meta').fill)).toBe('on-surface-variant');
  });

  it('the accessible name and the tooltip start with the title, not the id', () => {
    const t = nodes().find((g) => g.dataset.id === 'L-2') as SVGGElement;
    expect(t.getAttribute('aria-label')).toMatch(/^Title L-2, L-2, /);
    expect(t.querySelector('title')?.textContent).toMatch(/^Title L-2\n/);
  });

  it('the title font is fixed in graph units and capped at 14 px on screen when zoomed in', () => {
    expect(rule('.graph-svg .node .label.titled')['font-size']).toBe(
      'min(var(--text-xs), calc(var(--text-sm) / var(--graph-scale, 1)))',
    );
  });
});

describe('a font-size cap', () => {
  // The tokens the clamp may use and their px (board.css): the floor is --text-xs (the board's 12 px floor).
  const PX: Record<string, number> = { 'text-xs': 12, 'text-sm': 14, 'text-md': 16 };
  const sizes = (decl: string) => {
    const m = decl.match(
      /^clamp\(\s*calc\(\s*var\(--(text-[a-z]+)\)\s*\/\s*var\(--graph-scale,\s*1\)\s*\)\s*,\s*var\(--text-xs\)\s*,\s*calc\(\s*var\(--(text-[a-z]+)\)\s*\/\s*var\(--graph-scale,\s*1\)\s*\)\s*\)$/,
    );
    return m ? { min: PX[m[1]], max: PX[m[2]] } : null;
  };

  it('labels and "unlocks N" are clamped on screen between a readable minimum and a maximum', () => {
    for (const sel of ['.graph-svg .node .label', '.graph-svg .node .graph-locks']) {
      const s = sizes(rule(sel)['font-size'] ?? '');
      expect(s, sel).toBeTruthy();
      expect(s!.min).toBeGreaterThanOrEqual(12);
      expect(s!.max).toBeLessThanOrEqual(14);
      expect(s!.max).toBeGreaterThan(s!.min);
    }
  });

  it('the view writes the zoom to --graph-scale, also after a wheel zoom', () => {
    const svg = main.querySelector('.graph-svg') as SVGSVGElement;
    expect(svg.style.getPropertyValue('--graph-scale')).toBe('1');
    const surface = main.querySelector('.graph-surface') as HTMLElement;
    surface.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, bubbles: true, cancelable: true }));
    expect(Number(svg.style.getPropertyValue('--graph-scale'))).toBeGreaterThan(1);
  });
});

describe('legend samples with a visible edge', () => {
  const SAMPLES: [string, string][] = [
    ['t-ready', '.task .ring'],
    ['t-blocked', '.task.t-blocked .ring'],
    ['t-active', '.task.t-active .ring'],
    ['t-batch', '.task.t-batch .ring'],
    ['t-sp', '.sp .sp-box'],
  ];
  const edgeOf = (cls: string) => {
    const base = rule('.graph-draw .draw');
    const own = rule(`.graph-draw .${cls}`);
    const border = own['border-color'] ?? own.border ?? base['border-color'] ?? base.border;
    return token(border);
  };

  it('every sample has an edge token (never transparent) of at least 1.5 px', () => {
    for (const [cls] of SAMPLES) {
      expect(edgeOf(cls), cls).toBeTruthy();
      const own = rule(`.graph-draw .${cls}`);
      expect(Object.values(own).join(' '), cls).not.toMatch(/transparent/);
    }
    expect(rule('.graph-draw .draw').border).toMatch(/^1\.5px solid/);
  });

  it('each sample edge is the same color as the ring or box it explains', () => {
    for (const [cls, node] of SAMPLES) expect(edgeOf(cls), cls).toBe(token(rule(node).stroke));
  });

  it('every sample edge holds 3:1 against the surfaces behind the legend, light and dark', () => {
    for (const mode of ['light', 'dark'] as const) {
      const p = PALETTE[mode];
      for (const [cls] of SAMPLES)
        for (const behind of ['surface-container-low', 'surface-container-lowest', 'surface'])
          expect(U.contrast(p[edgeOf(cls)!], p[behind]), `${mode} ${cls} on ${behind}`).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('keyboard and screen reader behaviour stay', () => {
  it('every node is a named button tab stop, and Enter opens it', () => {
    for (const g of nodes()) {
      expect(g.getAttribute('tabindex')).toBe('0');
      expect(g.getAttribute('role')).toBe('button');
      expect(g.getAttribute('aria-label')).toBeTruthy();
    }
    const t = nodes().find((g) => g.dataset.id === 'A-1') as SVGGElement;
    t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(opened).toContain('A-1');
  });
});
