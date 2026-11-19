/**
 * @vitest-environment jsdom
 */
// =============================================================
// queueBoardHoverEmpty.test.ts: hover and press, empty columns, the selected card and the empty search (board step B7,
// UX review K3 and K4).
//
// What the tests prove:
//   - B7 hover and press: one hover tone and one press tone for buttons, tabs, fold headers and cards, both made from
//     the on-surface token as a thin layer over whatever surface the control has (so the same rule works on the card,
//     the canvas, the top and the panel); a filled button gets the same kind of layer in its own text color. No
//     brightness filter (it did almost nothing in dark mode). The tones are computed from the palette: visible against
//     the surface in light AND dark mode, press stronger than hover, and the text on them keeps 4.5:1. The card has
//     12 px padding.
//   - B7 empty states: an empty column says what goes there in one calm line, in the shared .empty-state style.
//   - K3: "selected" on the chosen card is screen reader text out of the flow, so the id row does not get longer and
//     the card keeps its shape; the ring stays.
//   - K4: a search that matches nothing shows ONE message above the columns with "Clear search"; the columns show 0 and
//     no repeated message, and "Next up" never shows a card that the search hides.
// CSS rules are read from board.css (render tests do not work in jsdom); the behaviour runs the whole board in jsdom.
// =============================================================
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { clientSource } from './boardClient';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const T = require('../queueBoard.js') as {
  board: (queue: unknown, option?: unknown) => any;
  PALETTE: Record<'light' | 'dark', Record<string, string>>;
};

const CLIENT = join(__dirname, '..', '..', 'queue-board');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const css = strip(readFileSync(join(CLIENT, 'board.css'), 'utf8'));
const html = readFileSync(join(CLIENT, 'index.html'), 'utf8');
const iso = new Date(Date.now() - 86_400_000).toISOString();

// ---- A small CSS reader: top-level rules (and rules inside one level of @media) --------------------------------------

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
/** The declarations of all top-level rules that list this exact selector, merged in source order. */
const base = (selector: string) =>
  Object.assign({}, ...rules.filter((r) => r.media === null && r.selectors.includes(selector)).map((r) => r.decl)) as Record<
    string,
    string
  >;

// ---- Colors: WCAG contrast and the color-mix the browser computes (in srgb, gamma-encoded channels) -------------------

const lum = (hex: string) => {
  const c = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const contrast = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
/** `share` of `top` laid over `under` (a translucent layer of `top` at that alpha, which is what color-mix with transparent gives). */
const over = (top: string, share: number, under: string) =>
  '#' +
  [1, 3, 5]
    .map((i) =>
      Math.round(parseInt(top.slice(i, i + 2), 16) * share + parseInt(under.slice(i, i + 2), 16) * (1 - share))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('');

/** The share of `token` in a state tone: `color-mix(in srgb, var(--color-<token>) N%, transparent)`. */
function stateShare(name: string, token = 'on-surface'): number {
  const v = base(':root')[name] ?? '';
  const m = new RegExp(`^color-mix\\(in srgb, var\\(--color-${token}\\) (\\d+)%, transparent\\)$`).exec(v);
  expect(m, `${name}: ${v}`).not.toBeNull();
  return Number(m![1]) / 100;
}

// ---- The controls that share the hover and press tones ---------------------------------------------------------------

const layer = (token: string) => `linear-gradient(var(${token}), var(${token}))`;
const CONTROLS: { name: string; hover: string; press: string; filled?: boolean }[] = [
  { name: 'button', hover: '.button:not(:disabled):hover', press: '.button:not(:disabled):active' },
  {
    name: 'filled button',
    hover: '.button-filled:not(:disabled):hover',
    press: '.button-filled:not(:disabled):active',
    filled: true,
  },
  { name: 'toggle', hover: '.toggles-button:hover', press: '.toggles-button:active' },
  {
    name: 'tab',
    hover: ".toggles[role='tablist'] .toggles-button:hover",
    press: ".toggles[role='tablist'] .toggles-button:active",
  },
  { name: 'fold header', hover: '.fold-button:hover', press: '.fold-button:active' },
  { name: 'link button', hover: '.link-button:hover', press: '.link-button:active' },
  { name: 'icon button', hover: '.button-icon:hover', press: '.button-icon:active' },
  { name: 'card', hover: '.summary:hover', press: '.summary:active' },
  { name: 'next up', hover: '.next-summary:hover', press: '.next-summary:active' },
];

describe('B7: one hover tone and one press tone', () => {
  it('the state tones are layers of the text color, press stronger than hover', () => {
    expect(stateShare('--state-press')).toBeGreaterThan(stateShare('--state-hover'));
    expect(stateShare('--state-press-filled', 'on-primary')).toBeGreaterThan(
      stateShare('--state-hover-filled', 'on-primary'),
    );
  });

  for (const c of CONTROLS)
    it(`${c.name}: hover lays the hover tone and press the press tone over its own surface`, () => {
      const suffix = c.filled ? '-filled' : '';
      expect(base(c.hover)['background-image'], c.hover).toBe(layer(`--state-hover${suffix}`));
      expect(base(c.press)['background-image'], c.press).toBe(layer(`--state-press${suffix}`));
    });

  it('the filled layer comes after the shared one, so it wins on a filled button', () => {
    const at = (sel: string) => rules.findIndex((r) => r.media === null && r.selectors.includes(sel));
    expect(at('.button-filled:not(:disabled):hover')).toBeGreaterThan(at('.button:not(:disabled):hover'));
    expect(at('.button-filled:not(:disabled):active')).toBeGreaterThan(at('.button:not(:disabled):active'));
  });

  it('no brightness filter for hover or press (it barely shows on a dark surface)', () => {
    expect(css).not.toMatch(/filter:\s*brightness/);
  });

  it('the press still moves a button a little, except with reduced motion', () => {
    expect(base('.button:not(:disabled):active').transform).toBe('scale(0.97)');
    const reduced = rules.filter(
      (r) => r.media?.includes('prefers-reduced-motion') && r.selectors.includes('.button:not(:disabled):active'),
    );
    expect(reduced.map((r) => r.decl.transform)).toContain('none');
  });

  it('forced colors drop the layers (the system colors carry hover there)', () => {
    const forced = rules.filter((r) => r.media?.includes('forced-colors') && r.selectors.includes(':root'));
    const decl = Object.assign({}, ...forced.map((r) => r.decl));
    for (const name of ['--state-hover', '--state-press', '--state-hover-filled', '--state-press-filled'])
      expect(decl[name], name).toBe('transparent');
  });

  for (const mode of ['light', 'dark'] as const)
    it(`${mode}: hover is visible on every surface a control sits on, and the text keeps 4.5:1`, () => {
      const p = T.PALETTE[mode];
      const hover = stateShare('--state-hover');
      const press = stateShare('--state-press');
      // The card and the top (lowest), the canvas (low), the panel (surface): every kind of control sits there, so
      // the text on a pressed control is checked for all of them (tabs and folds switch to on-surface, link buttons stay
      // primary, the danger button keeps its tone text). The chosen toggle (high) carries on-surface only.
      const surfaces: [string, string[]][] = [
        ['surface-container-lowest', ['on-surface', 'primary', 'on-tone-danger']],
        ['surface-container-low', ['on-surface', 'primary', 'on-tone-danger']],
        ['surface', ['on-surface', 'primary', 'on-tone-danger']],
        ['surface-container-high', ['on-surface']],
      ];
      for (const [surface, texts] of surfaces) {
        const h = over(p['on-surface'], hover, p[surface]);
        const a = over(p['on-surface'], press, p[surface]);
        // Visible: at least 1.15:1 against the surface (the old card-to-hover step in dark mode was 1.146).
        expect(contrast(h, p[surface]), `${mode} hover on ${surface}`).toBeGreaterThanOrEqual(1.15);
        expect(contrast(a, p[surface]), `${mode} press on ${surface}`).toBeGreaterThan(contrast(h, p[surface]));
        for (const text of texts)
          expect(contrast(p[text], a), `${mode} ${text} on press over ${surface}`).toBeGreaterThanOrEqual(4.5);
      }
      // A filled button: its own layer over primary keeps the on-primary text readable and still shows.
      for (const name of ['--state-hover-filled', '--state-press-filled']) {
        const f = over(p['on-primary'], stateShare(name, 'on-primary'), p.primary);
        expect(contrast(p['on-primary'], f), `${mode} on-primary with ${name}`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(f, p.primary), `${mode} filled with ${name}`).toBeGreaterThanOrEqual(1.15);
      }
    });

  it('tabs and folds switch to on-surface text on hover (their resting text is the muted tone)', () => {
    expect(base(".toggles[role='tablist'] .toggles-button:hover").color).toBe('var(--color-on-surface)');
    expect(base('.fold-button:hover').color).toBe('var(--color-on-surface)');
  });

  it('the card has the 12 px padding from the B4 spacing and keeps its hover edge', () => {
    expect(base(':root')['--distance-card']).toBe('calc(var(--distance-sm) + var(--distance-xs))');
    expect(base('.summary').padding).toBe('var(--distance-card)');
    expect(base('.summary:hover')['border-color']).toBe('var(--color-outline)');
  });
});

// ---- K3: the selected card keeps its shape ---------------------------------------------------------------------------

describe('K3: "selected" does not lengthen the id row', () => {
  it('the word is screen reader text out of the flow, and the ring stays', () => {
    const after = base('.summary.chain-selected .summary-id::after');
    expect(after.content).toMatch(/selected/);
    expect(after.position).toBe('absolute');
    expect(after.width).toBe('1px');
    expect(after.height).toBe('1px');
    expect(after.overflow).toBe('hidden');
    expect(after['clip-path']).toBe('inset(50%)');
    expect(after['white-space']).toBe('nowrap');
    expect(base('.summary.chain-selected')['box-shadow']).toBe('0 0 0 3px var(--color-primary)');
  });
});

// ---- The board in jsdom: empty columns, the empty search and "Next up" ------------------------------------------------

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
    // Only waiting tasks: In progress, Review and Built are empty.
    tasks: [
      task('EX-1', { title: 'Alpha login' }),
      task('EX-2', { depends_on: ['EX-1'] }),
      task('EX-3', { title: 'Beta sync' }),
    ],
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
/** Types into the search and waits out its 150 ms debounce. */
async function search(text: string) {
  const s = $('search') as HTMLInputElement;
  s.value = text;
  s.dispatchEvent(new Event('input'));
  await new Promise((r) => setTimeout(r, 200));
  await flush();
}
const shown = (e: Element) => !e.closest('[hidden]');
const column = (key: string) => document.querySelector(`.column[data-col="${key}"]`) as HTMLElement;

beforeAll(async () => {
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

describe('B7: an empty column says what goes there', () => {
  const lines: Record<string, RegExp> = {
    inProgress: /^Nothing in progress\. Running and picked tasks show here\.$/,
    review: /^Nothing to review\. Delivered tasks wait here for review and merge\.$/,
    built: /^Nothing built yet\. Merged tasks show here\.$/,
  };
  for (const [key, text] of Object.entries(lines))
    it(`${key}: one calm line in the shared empty state, no action button`, () => {
      const empty = [...column(key).querySelectorAll('.empty-state')].filter(shown);
      expect(empty).toHaveLength(1);
      expect(empty[0].classList.contains('empty')).toBe(true);
      expect(empty[0].textContent).toMatch(text);
      expect(empty[0].querySelector('button')).toBeNull();
    });
});

describe('K4: an empty search is one message above the columns', () => {
  it('before the search: no search message, and "Next up" shows the ready ones', () => {
    expect([...document.querySelectorAll('.search-empty')].filter(shown)).toHaveLength(0);
    const ids = [...$('stripe').querySelectorAll('.next-id')].map((e) => e.textContent);
    expect(ids).toEqual(expect.arrayContaining(['EX-1', 'EX-3']));
  });

  it('a search that matches nothing: one message with Clear search, the columns show 0 and no repeat', async () => {
    await search('zzqq');
    const messages = [...$('board').querySelectorAll('*')].filter(
      (e) => shown(e) && e.children.length === 0 && /Nothing matches/.test(e.textContent ?? ''),
    );
    expect(messages).toHaveLength(1);
    const box = messages[0].closest('.search-empty') as HTMLElement;
    expect(box).not.toBeNull();
    expect(box.classList.contains('empty-state')).toBe(true);
    expect($('board').classList.contains('search-none')).toBe(true);
    // Above the columns: before the first column in the board.
    const first = $('board').querySelector('.column') as HTMLElement;
    expect(box.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(box.querySelector('button')?.textContent).toBe('Clear search');
    for (const c of document.querySelectorAll('.column .counter')) expect(c.textContent).toBe('0');
  });

  it('"Next up" shows no card the search hides, and says so', () => {
    expect($('stripe').querySelectorAll('.next-summary')).toHaveLength(0);
    expect($('stripe').textContent).toMatch(/hidden by the search/);
  });

  it('a search that matches one card: "Next up" shows only that card, the message is gone', async () => {
    await search('beta');
    const ids = [...$('stripe').querySelectorAll('.next-id')].map((e) => e.textContent);
    expect(ids).toEqual(['EX-3']);
    expect([...document.querySelectorAll('.search-empty')].filter(shown)).toHaveLength(0);
    expect($('board').classList.contains('search-none')).toBe(false);
    // A column the search empties shows its counter at 0 and a quiet line, not the "Nothing matches" action.
    for (const e of [...document.querySelectorAll('.column .empty-state')].filter(shown))
      expect(e.textContent).not.toMatch(/Nothing matches/);
  });

  it('Clear search empties the search, puts the focus there and brings the cards back', async () => {
    await search('zzqq');
    const button = [...document.querySelectorAll('.search-empty button')].find(shown) as HTMLButtonElement;
    button.click();
    await new Promise((r) => setTimeout(r, 200));
    await flush();
    expect(($('search') as HTMLInputElement).value).toBe('');
    expect(document.activeElement).toBe($('search'));
    expect([...document.querySelectorAll('.search-empty')].filter(shown)).toHaveLength(0);
    expect(column('queue').querySelector('.counter')?.textContent).toBe('3');
  });
});
