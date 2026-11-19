// =============================================================
// queueBoardA11y.test.ts: the pure accessibility logic in queueBoard (scripts/orchestrator/queue-board/a11y.js).
//
// The tests prove that:
//   - the focus trap wraps around at both ends and tolerates focus outside the list and an empty list (one trap for all dialogs),
//   - the toast queue never has the same message twice, puts the newest at the bottom and never pushes out "Undo",
//   - the marked card holds at least 4.5:1 in both modes, computed from the palette (PALETTE in lib/queueBoard.js),
//   - the tabs follow the arrow keys, Home and End,
//   - the legend and the WIP text are readable text, the key is read from the # part of the link, and theme has three options.
// =============================================================
import { describe, it, expect } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { PALETTE } = require('../queueBoard.js') as {
  PALETTE: { light: Record<string, string>; dark: Record<string, string> };
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const U = require('../../queue-board/a11y.js') as {
  nextInTrap: (count: number, i: number, backward: boolean) => number;
  toastAdd: (
    queue: string[],
    key: string,
    option?: { max?: number; kept?: string[] },
  ) => string[];
  toastRemove: (queue: string[], key: string) => string[];
  contrast: (a: string, b: string) => number;
  tabMeasure: (count: number, i: number, keyPress: string) => number | null;
  CLASSES: { class: string; name: string; explanation: string }[];
  classLabel: (k: string) => string;
  wipText: (w: {
    agents: number;
    max: number;
    dPlus: number;
    maxDPlus: number;
    picked?: number;
  }) => string;
  keyFromLink: (text: string) => string | null;
  themeFromSaved: (v: string | null) => string;
  nextTheme: (v: string | null) => string;
};

describe('the focus trap (nextInTrap)', () => {
  it('Tab moves ahead and wraps from last to first', () => {
    expect(U.nextInTrap(3, 0, false)).toBe(1);
    expect(U.nextInTrap(3, 2, false)).toBe(0);
  });
  it('Shift+Tab moves backward and wraps from first to last', () => {
    expect(U.nextInTrap(3, 2, true)).toBe(1);
    expect(U.nextInTrap(3, 0, true)).toBe(2);
  });
  it('focus outside the list (-1) goes to the first with Tab and the last with Shift+Tab', () => {
    expect(U.nextInTrap(3, -1, false)).toBe(0);
    expect(U.nextInTrap(3, -1, true)).toBe(2);
  });
  it('an empty dialog gives -1 (nothing to focus)', () => {
    expect(U.nextInTrap(0, -1, false)).toBe(-1);
    expect(U.nextInTrap(0, 0, true)).toBe(-1);
  });
  it('one element: focus stays there', () => {
    expect(U.nextInTrap(1, 0, false)).toBe(0);
    expect(U.nextInTrap(1, 0, true)).toBe(0);
  });
});

describe('toast queue (one stack)', () => {
  it('puts the newest at the bottom and never has the same key twice', () => {
    let queue: string[] = [];
    queue = U.toastAdd(queue, 'undo');
    queue = U.toastAdd(queue, 'message');
    expect(queue).toEqual(['undo', 'message']);
    queue = U.toastAdd(queue, 'undo');
    expect(queue).toEqual(['message', 'undo']);
  });
  it('over max the oldest drops out, but never one that is to be kept', () => {
    const queue = U.toastAdd(['undo', 'a', 'b'], 'c', { max: 3, kept: ['undo'] });
    expect(queue).toEqual(['undo', 'b', 'c']);
  });
  it('remove takes away only the key', () => {
    expect(U.toastRemove(['undo', 'message'], 'message')).toEqual(['undo']);
    expect(U.toastRemove(['undo'], 'message')).toEqual(['undo']);
  });
});

describe('contrast for the marked card', () => {
  const { light, dark } = PALETTE;
  it('the formula gives known values', () => {
    expect(U.contrast('#000000', '#ffffff')).toBe(21);
    expect(U.contrast('#777777', '#777777')).toBe(1);
    expect(Number.isNaN(U.contrast('red', '#ffffff'))).toBe(true);
  });
  it.each([
    ['light', light],
    ['dark', dark],
  ])('on-primary-container on primary-container is at least 4.5:1 in %s mode', (_name, p) => {
    const k = U.contrast(p['on-primary-container'], p['primary-container']);
    expect(k).toBeGreaterThanOrEqual(4.5);
  });
});

// The design language for the board (a calm work table): neutral surfaces, text carries the information, and each
// status color has one meaning. Every text pair is WCAG AA (4.5:1 for normal text); control borders are non-text
// UI (3:1). All pairs are checked in light and dark.
describe('the palette: every text pair in both modes', () => {
  const MODES: [string, Record<string, string>][] = [
    ['light', PALETTE.light],
    ['dark', PALETTE.dark],
  ];
  // The surfaces text can sit on: the canvas behind the columns, the card (also panel and top), the panel surface,
  // and the hover surface / active tab.
  const SURFACES = [
    'surface-container-low',
    'surface-container-lowest',
    'surface',
    'surface-container-high',
  ];
  // Tinted badges: one meaning each (neutral, info / ready, ok / done, waiting on you, error / stops, heavy class,
  // caution: the orange of a medium Checks suggestion, between danger for high and warn for low; QA-1a).
  const TONES = ['neutral', 'info', 'ok', 'warn', 'danger', 'heavy', 'caution'];

  /** Every [label, foreground, background, minimum] pair for one mode. */
  function pairs(p: Record<string, string>): [string, string, string, number][] {
    const out: [string, string, string, number][] = [];
    for (const s of SURFACES) {
      out.push([`on-surface on ${s}`, p['on-surface'], p[s], 4.5]);
      out.push([`on-surface-variant on ${s}`, p['on-surface-variant'], p[s], 4.5]);
      out.push([`primary (link) on ${s}`, p.primary, p[s], 4.5]);
      out.push([`outline (control border) on ${s}`, p.outline, p[s], 3]);
    }
    out.push(['on-primary on primary', p['on-primary'], p.primary, 4.5]);
    for (const t of TONES)
      out.push([`on-tone-${t} on tone-${t}`, p[`on-tone-${t}`], p[`tone-${t}`], 4.5]);
    // The Focus drop bar (QA-1a) is a non-text mark: 3:1 on the section surface and on the highlighted drop zone.
    for (const s of ['surface-container', 'surface-container-high'])
      out.push([`drop-indicator on ${s}`, p['drop-indicator'], p[s], 3]);
    return out;
  }

  /** The hue of a #rrggbb color in degrees (0 to 360), for telling the severity tones apart. */
  function hue(hex: string): number {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const max = Math.max(r, g, b);
    const d = max - Math.min(r, g, b);
    if (!d) return 0;
    const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return (h * 60 + 360) % 360;
  }

  it.each(MODES)('the orange caution tone sits clearly between the red danger and the yellow warn in %s mode', (_name, p) => {
    // The three Checks levels must not blur together: the caution color is at least 12 degrees of hue from each
    // neighbour, in the order red, orange, yellow on the color wheel (surface and text alike).
    for (const part of ['tone', 'on-tone']) {
      const [danger, caution, warn] = ['danger', 'caution', 'warn'].map((t) => hue(p[`${part}-${t}`]));
      expect(caution - danger, `${part} caution vs danger`).toBeGreaterThanOrEqual(12);
      expect(warn - caution, `${part} warn vs caution`).toBeGreaterThanOrEqual(12);
    }
  });

  it.each(MODES)('the drop bar is a dark gray in light mode and a light gray in dark mode (%s)', (name, p) => {
    expect(p['drop-indicator']).toMatch(/^#[0-9a-f]{6}$/i);
    // Contrast against black grows with luminance: a dark gray stays near black, a light gray is far from it.
    const lum = U.contrast(p['drop-indicator'], '#000000');
    if (name === 'light') expect(lum).toBeLessThan(5);
    else expect(lum).toBeGreaterThan(10);
  });

  it.each(MODES)('the tone tokens exist in %s mode', (_name, p) => {
    for (const t of TONES) {
      expect(p[`tone-${t}`]).toMatch(/^#[0-9a-f]{6}$/i);
      expect(p[`on-tone-${t}`]).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it.each(MODES)('every text pair is at least 4.5:1 and every border 3:1 in %s mode', (_name, p) => {
    const below = pairs(p)
      .map(([label, fg, bg, min]) => ({ label, k: U.contrast(fg, bg), min }))
      .filter((r) => !(r.k >= r.min))
      .map((r) => `${r.label}: ${r.k.toFixed(2)} (needs ${r.min})`);
    expect(below).toEqual([]);
  });

  it.each(MODES)('the card is lighter than the canvas in %s mode (a raised surface, not a hole)', (_name, p) => {
    // Contrast against black grows with luminance, so it orders the surfaces without a luminance helper of its own.
    const light = (c: string) => U.contrast(c, '#000000');
    expect(light(p['surface-container-lowest'])).toBeGreaterThan(light(p['surface-container-low']));
    // The hover surface stands out from the card in the direction of the mode (darker in light, lighter in dark).
    if (_name === 'dark')
      expect(light(p['surface-container-high'])).toBeGreaterThan(light(p['surface-container-lowest']));
    else expect(light(p['surface-container-high'])).toBeLessThan(light(p['surface-container-lowest']));
  });
});

describe('the tabs (arrow keys)', () => {
  it('right and left wrap around, Home and End go to the ends, other keys give null', () => {
    expect(U.tabMeasure(6, 5, 'ArrowRight')).toBe(0);
    expect(U.tabMeasure(6, 0, 'ArrowLeft')).toBe(5);
    expect(U.tabMeasure(6, 3, 'Home')).toBe(0);
    expect(U.tabMeasure(6, 3, 'End')).toBe(5);
    expect(U.tabMeasure(6, 3, 'a')).toBeNull();
    expect(U.tabMeasure(0, 0, 'ArrowRight')).toBeNull();
  });
});

describe('the legend and WIP', () => {
  it('has all four classes', () => {
    expect(U.CLASSES.map((k) => k.class)).toEqual(['K', 'D', 'D+', 'U']);
  });
  it('the class badge gets a readable label', () => {
    expect(U.classLabel('D+')).toBe('Risk class D+: database with new table or privacy');
    expect(U.classLabel('X')).toBe('Risk class X');
  });
  it('the WIP chip is plain text', () => {
    expect(U.wipText({ agents: 3, max: 4, dPlus: 1, maxDPlus: 2 })).toBe(
      'Agents 3 of 4 · heavy 1 of 2',
    );
    expect(U.wipText({ agents: 3, max: 4, dPlus: 1, maxDPlus: 2, picked: 2 })).toBe(
      'Agents 3 of 4 · heavy 1 of 2 · 2 picked',
    );
  });
});

describe('the key from a link', () => {
  it('reads the key from the # part', () => {
    expect(U.keyFromLink('http://127.0.0.1:4310/#key=abc_DEF-123')).toBe('abc_DEF-123');
    expect(U.keyFromLink('  http://127.0.0.1:4310/?x=1#a=1&key=xyz  ')).toBe('xyz');
  });
  it('does not accept a key in the query (only the # part) or empty text', () => {
    expect(U.keyFromLink('http://127.0.0.1:4310/?key=abc')).toBeNull();
    expect(U.keyFromLink('')).toBeNull();
    expect(U.keyFromLink('http://127.0.0.1:4310/#other=1')).toBeNull();
  });
  it('accepts a bare key without a link', () => {
    expect(U.keyFromLink('A1b2C3d4E5f6G7h8')).toBe('A1b2C3d4E5f6G7h8');
    expect(U.keyFromLink('summary')).toBeNull();
  });
});

describe('theme', () => {
  it('an unknown or empty saved option is System', () => {
    expect(U.themeFromSaved(null)).toBe('system');
    expect(U.themeFromSaved('blue')).toBe('system');
    expect(U.themeFromSaved('dark')).toBe('dark');
  });
  it('the button goes System → Light → Dark → System', () => {
    expect(U.nextTheme(null)).toBe('light');
    expect(U.nextTheme('light')).toBe('dark');
    expect(U.nextTheme('dark')).toBe('system');
  });
});
