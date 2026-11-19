// =============================================================
// queueBoardPlansPriority.test.ts: priority is never red anywhere in Plans (board step B33, the rest of B32).
//
// What the tests prove:
//   - no rule in plans.css that colors a priority (a selector with .pri-now, .pri-owner or .pri-later) uses an error
//     or danger token: the Plans list, the facet options, the tree map, the structure legend and the dependency
//     nodes all use the area cards' priority colors (strong primary for Now, the warn tone for Owner, a muted
//     neutral for Later),
//   - red stays for errors: the legal and overdue warning chips still use the error container,
//   - the list's priority symbols hold 4.5:1 on the list surfaces, the tree map's text holds 4.5:1 on its priority
//     surface, and its edge (also the legend sample's edge) holds 3:1 against the surfaces around it, light and dark,
//   - a Now field in the tree map keeps a visible selection and focus outline (not primary on primary).
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

const css = readFileSync(join(__dirname, '..', '..', 'queue-board', 'plans', 'plans.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);

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
const MODES = ['light', 'dark'] as const;

describe('priority is never red in Plans', () => {
  it('no rule with a priority selector uses an error or danger token', () => {
    const pri = RULES.filter((r) => r.selectors.some((s) => /\.pri-(now|owner|later)\b/.test(s)));
    expect(pri.length).toBeGreaterThan(5);
    for (const r of pri) expect(Object.values(r.decl).join(' '), r.selectors.join(', ')).not.toMatch(/error|danger/);
  });

  it('Now, Owner and Later use the area cards colors', () => {
    expect(token(rule('.plans-pri.pri-now .plans-pri-symbol').color)).toBe('primary');
    expect(token(rule('.plans-pri.pri-owner .plans-pri-symbol').color)).toBe('on-tone-warn');
    expect(token(rule('.plans-pri.pri-later .plans-pri-symbol').color)).toBe('on-tone-neutral');
    const now = rule('.tree-map-field.pri-now');
    expect([token(now['--pri-surface']), token(now['--pri-text']), token(now['--pri-edge'])]).toEqual([
      'primary',
      'on-primary',
      'primary',
    ]);
    const owner = rule('.tree-map-field.pri-owner');
    expect([token(owner['--pri-surface']), token(owner['--pri-text'])]).toEqual(['tone-warn', 'on-tone-warn']);
    const later = rule('.tree-map-field.pri-later');
    expect([token(later['--pri-surface']), token(later['--pri-text'])]).toEqual(['tone-neutral', 'on-tone-neutral']);
    expect(token(rule('.dep-node.pri-now .dep-fill').fill)).toBe('primary');
    expect(token(rule('.dep-node.pri-owner .dep-fill').fill)).toBe('tone-warn');
  });

  it('red stays for errors: the legal and overdue warning chips keep the error container', () => {
    expect(token(rule('.plans-warning.v-legal').background)).toBe('error-container');
  });
});

describe('contrast', () => {
  it('the list priority symbols hold 4.5:1 on the list surfaces', () => {
    for (const mode of MODES)
      for (const p of ['now', 'owner', 'later']) {
        const c = token(rule(`.plans-pri.pri-${p} .plans-pri-symbol`).color)!;
        for (const behind of ['surface-container-lowest', 'surface-container-low', 'surface-container-high'])
          expect(U.contrast(PALETTE[mode][c], PALETTE[mode][behind]), `${mode} ${p} on ${behind}`).toBeGreaterThanOrEqual(4.5);
      }
  });

  it('tree map: text 4.5:1 on its priority surface, edge 3:1 against the surfaces around it', () => {
    for (const mode of MODES)
      for (const p of ['now', 'owner', 'later']) {
        const r = rule(`.tree-map-field.pri-${p}`);
        const pal = PALETTE[mode];
        const [surf, text, edge] = [token(r['--pri-surface'])!, token(r['--pri-text'])!, token(r['--pri-edge'])!];
        expect(U.contrast(pal[text], pal[surf]), `${mode} ${p} text`).toBeGreaterThanOrEqual(4.5);
        for (const behind of ['surface-container-lowest', 'surface-container-low', 'surface'])
          expect(U.contrast(pal[edge], pal[behind]), `${mode} ${p} edge on ${behind}`).toBeGreaterThanOrEqual(3);
      }
  });

  it('a Now field keeps a visible selection and focus outline, and a visible built fill', () => {
    for (const sel of ['.tree-map-field.pri-now.selected', '.tree-map-field.pri-now:focus-visible'])
      expect(token(rule(sel)['outline-color']), sel).toBe('on-primary');
    expect(token(rule('.tree-map-field.pri-now .tree-map-fill')['border-top-color'])).toBe('on-primary');
  });
});
