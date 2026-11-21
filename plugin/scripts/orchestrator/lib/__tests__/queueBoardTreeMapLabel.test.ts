// =============================================================
// queueBoardTreeMapLabel.test.ts: the text in a Plans tree map field stays readable over the built fill.
//
// Why (owner QA 21.11): the fill from below has a 2 px top line. When the fill reached the text, that line ran right
// through a label ("43 % built" was struck through). Each text line now sits on a small chip in the field's own color
// (--pri-surface), only as wide as its text, so the fill line stops at the text and the text keeps the field's
// contrast in light and dark. The chip uses the field's tokens, so no new color is added.
// CSS rules are read from plans/plans.css (render tests do not work in jsdom).
// =============================================================
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/* eslint-disable @typescript-eslint/no-require-imports */
const { PALETTE } = require('../queueBoard.js') as {
  PALETTE: { light: Record<string, string>; dark: Record<string, string> };
};
const U = require('../../queue-board/a11y.js') as { contrast: (a: string, b: string) => number };
/* eslint-enable @typescript-eslint/no-require-imports */

const css = readFileSync(join(__dirname, '..', '..', 'queue-board', 'plans', 'plans.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
type Rule = { selectors: string[]; decl: Record<string, string> };
const RULES: Rule[] = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].map((m) => {
  const decl: Record<string, string> = {};
  for (const d of m[2].split(';')) {
    const i = d.indexOf(':');
    if (i > 0) decl[d.slice(0, i).trim()] = d.slice(i + 1).trim();
  }
  return { selectors: m[1].split(',').map((x) => x.trim().replace(/\s+/g, ' ')), decl };
});
const rule = (sel: string) =>
  Object.assign({}, ...RULES.filter((r) => r.selectors.includes(sel)).map((r) => r.decl)) as Record<string, string>;
const token = (v: string | undefined) => v?.match(/var\(--color-([a-z0-9-]+)\)/)?.[1];

describe('tree map: the fill line never runs through a label', () => {
  it('the name and each line sit on a chip in the field color, as wide as the text', () => {
    for (const sel of ['.tree-map-name', '.tree-map-line']) {
      const r = rule(sel);
      expect(r.background, sel).toBe('var(--pri-surface)');
      // as wide as the text (not the whole field), but never wider than the field, so the ellipsis still works
      expect(r['align-self'], sel).toBe('flex-start');
      expect(r['max-width'], sel).toBe('100%');
    }
  });

  it('the chip sits above the fill (the content is positioned, the fill is under it)', () => {
    expect(rule('.tree-map-content').position).toBe('relative');
    expect(rule('.tree-map-fill').position).toBe('absolute');
  });

  it('the text on its chip keeps 4.5:1 for every priority in light and dark', () => {
    for (const p of ['now', 'owner', 'later', 'drop']) {
      const r = rule(`.tree-map-field.pri-${p}`);
      const surface = token(r['--pri-surface']) as string;
      const text = token(r['--pri-text']) as string;
      for (const mode of ['light', 'dark'] as const) {
        const ratio = U.contrast(PALETTE[mode][text], PALETTE[mode][surface]);
        expect(ratio, `${p} ${mode}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
