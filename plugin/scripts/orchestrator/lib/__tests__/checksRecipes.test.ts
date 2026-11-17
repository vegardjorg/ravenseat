// =============================================================
// checksRecipes.test.ts: the recipes (failure class x stack) as data in the checks catalog, the condition stack:, and the
// card ledger-recipes on the Checks tab (0i step 6, plans/feillogg-til-gater-2026-11-15.md sections 3.7 and 3.9).
//
// Locks: (1) every recipe the plugin ships is valid, its examples behave, its cards exist, and none is for `other` or
// for the database classes (those come with the database probes); (2) the recipe chosen per class follows the stack and
// what the project already has; (3) a project adds, replaces and removes recipes in docs/queue/checks/recipes.json, and
// a recipe with a mistake is left out and named; (4) stack: reads the stacks and the detected packs; (5) the card shows
// only with the inspection queue on and an open due class, names the class, the count, the places (paths only), the
// stack and the recipe, shows at most three, leaves out a class the owner declined or that has a gate, and never lights
// the red marker.
// =============================================================
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* eslint-disable-next-line @typescript-eslint/no-require-imports */
const C = require('../checksCatalog.js');
/* eslint-disable-next-line @typescript-eslint/no-require-imports */
const FC = require('../failureClasses.js');

const BUILTIN = path.resolve(__dirname, '..', '..', 'checks-catalog');
const NONE = path.join(BUILTIN, 'does-not-exist');
const kinds = (...list: [string, string][]) => list.map(([key, where]) => ({ key, places: [{ where }] }));
type Recipe = { id: string; class: string; when: string; title: string; text: string; cards: string[] };

/** A temporary docs/queue/checks folder with a recipes.json. */
function ownFolder(recipes: unknown) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-recipes-'));
  fs.writeFileSync(path.join(dir, 'recipes.json'), JSON.stringify(recipes));
  return dir;
}

describe('the recipes the plugin ships', () => {
  const catalog = C.loadCatalog({ builtin: BUILTIN, own: NONE });
  const recipes: Recipe[] = catalog.recipes;

  it('has no mistakes, and every recipe has a core class, examples that behave and cards that exist', () => {
    expect(catalog.errors).toEqual([]);
    expect(recipes.length).toBeGreaterThanOrEqual(6);
    const classIds = FC.coreClasses().map((c: { id: string }) => c.id);
    const cardKeys = catalog.templates.map((t: { key: string }) => t.key);
    for (const r of recipes) {
      expect(classIds, r.id).toContain(r.class);
      expect(C.recipeExampleProblems(r), r.id).toEqual([]);
      for (const k of r.cards) expect(cardKeys, `${r.id} -> ${k}`).toContain(k);
      expect(r.text.length, r.id).toBeLessThanOrEqual(400);
    }
    // Ids are unique.
    expect(new Set(recipes.map((r) => r.id)).size).toBe(recipes.length);
  });

  it('never a recipe for other, nor yet for the database classes (they come with the database probes)', () => {
    const classes = new Set(recipes.map((r) => r.class));
    for (const c of ['other', 'access-control', 'migration-schema']) expect(classes.has(c), c).toBe(false);
  });

  it('reuses the cards that exist for the examples in the plan, never a copy of them', () => {
    const ts = { stacks: ['Node/TypeScript'], kinds: [] };
    expect(C.recipeFor('unchecked-error', ts, recipes)).toMatchObject({ cards: ['lint'] });
    expect(C.recipeFor('unchecked-error', ts, recipes).text).toMatch(/no-floating-promises/);
    expect(C.recipeFor('unchecked-error', { stacks: ['Python'] }, recipes).text).toMatch(/ruff/i);
    expect(C.recipeFor('contract-drift', ts, recipes)).toMatchObject({ cards: ['type-check'] });
    expect(C.recipeFor('contract-drift', ts, recipes).text).toMatch(/tsc --noEmit/);
    // The type check runs as a gate but not in CI: the CI card instead.
    expect(C.recipeFor('contract-drift', { stacks: ['Node/TypeScript'], kinds: kinds(['types', 'gate']) }, recipes)).toMatchObject({ cards: ['quality-in-ci'] });
    expect(C.recipeFor('secret-leak', { stacks: [], kinds: [] }, recipes)).toMatchObject({ cards: ['secret-scan-ci'] });
    expect(C.recipeFor('secret-leak', { stacks: [], kinds: [] }, recipes).text).toMatch(/gitleaks/);
    expect(C.recipeFor('test-weakening', { stacks: ['Node'], kinds: kinds(['test', 'gate']) }, recipes).cards).toEqual(['test-timeouts-under-load', 'test-workers-cap']);
    expect(C.recipeFor('test-weakening', { stacks: ['Python'], kinds: kinds(['test', 'gate']) }, recipes).text).toMatch(/pytest-timeout/);
  });

  it('no recipe for a stack none is written for, and none for other', () => {
    expect(C.recipeFor('unchecked-error', { stacks: [] }, recipes)).toBeNull();
    expect(C.recipeFor('other', { stacks: ['Node/TypeScript'] }, recipes)).toBeNull();
    expect(C.recipeFor('time-zone', { stacks: ['Node/TypeScript'] }, recipes)).toBeNull();
  });
});

describe('the condition stack:', () => {
  it('reads the stacks the manifests show and the packs found, never an unknown one', () => {
    expect(C.holds('stack:typescript', { stacks: ['Node/TypeScript'] })).toBe(true);
    expect(C.holds('stack:node', { stacks: ['Node/TypeScript'] })).toBe(true);
    expect(C.holds('stack:typescript', { stacks: ['Node'] })).toBe(false);
    expect(C.holds('stack:python|go', { stacks: ['Python'] })).toBe(true);
    expect(C.holds('stack:supabase', { stacks: ['Node'], packs: { detected: ['supabase'] } })).toBe(true);
    expect(C.holds('stack:python', {})).toBe(false);
  });
});

describe('a project changes the recipes in docs/queue/checks/recipes.json', () => {
  const ex = { hit: [{ stacks: ['Node/TypeScript'] }], miss: [{ stacks: ['Python'] }] };

  it('the same id replaces, off removes, and a new one comes before the plugin\'s', () => {
    const own = ownFolder({
      recipes: [
        { id: 'unchecked-error-typescript', off: true },
        { id: 'our-result-type', class: 'unchecked-error', when: 'stack:typescript', title: 'Our Result type', text: 'Return Result from every service call.', examples: ex },
        { id: 'contract-drift-type-check', class: 'contract-drift', when: 'stack:typescript', title: 'Strict', text: 'tsc with strict on.', cards: ['type-check'], examples: ex },
      ],
    });
    const catalog = C.loadCatalog({ builtin: BUILTIN, own });
    expect(catalog.errors).toEqual([]);
    const ids = catalog.recipes.map((r: Recipe) => r.id);
    expect(ids).not.toContain('unchecked-error-typescript');
    expect(C.recipeFor('unchecked-error', { stacks: ['Node/TypeScript'] }, catalog.recipes).id).toBe('our-result-type');
    expect(C.recipeFor('contract-drift', { stacks: ['Node/TypeScript'], kinds: [] }, catalog.recipes).text).toBe('tsc with strict on.');
  });

  it('a recipe with a mistake is left out and named, the rest still load', () => {
    const own = ownFolder({
      recipes: [
        { id: 'bad-when', class: 'unchecked-error', when: 'stack-ish', title: 'T', text: 'x', examples: ex },
        { id: 'no-examples', class: 'unchecked-error', when: 'stack:typescript', title: 'T', text: 'x' },
        { id: 'wrong-example', class: 'unchecked-error', when: 'stack:typescript', title: 'T', text: 'x', examples: { hit: [{ stacks: ['Python'] }], miss: [{ stacks: ['Go'] }] } },
        { id: 'unknown-card', class: 'unchecked-error', when: 'stack:typescript', title: 'T', text: 'x', cards: ['no-such-card'], examples: ex },
        { id: 'Bad Id', class: 'unchecked-error', when: '', title: 'T', text: 'x', examples: { hit: [{}] } },
        'not an object',
        null,
      ],
    });
    const catalog = C.loadCatalog({ builtin: BUILTIN, own });
    const ids = catalog.recipes.map((r: Recipe) => r.id);
    for (const id of ['bad-when', 'no-examples', 'wrong-example', 'unknown-card', 'Bad Id']) expect(ids, id).not.toContain(id);
    const text = catalog.errors.join('\n');
    expect(text).toMatch(/recipes\.json.*bad-when.*unknown condition/);
    expect(text).toMatch(/no-examples.*example/);
    expect(text).toMatch(/wrong-example.*hit/);
    expect(text).toMatch(/unknown-card.*no-such-card/);
    expect(text).toMatch(/Bad Id/);
    expect(text).toMatch(/every recipe must be an object/);
    expect(ids).toContain('unchecked-error-python');
  });

  it('a broken file is one error and the plugin\'s recipes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-recipes-'));
    fs.writeFileSync(path.join(dir, 'recipes.json'), '{ not json');
    const catalog = C.loadCatalog({ builtin: BUILTIN, own: dir });
    expect(catalog.errors.some((e: string) => /recipes\.json/.test(e))).toBe(true);
    expect(catalog.recipes.length).toBe(C.loadCatalog({ builtin: BUILTIN, own: NONE }).recipes.length);
  });

  it('a card the project turned off drops the link, not the recipe', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-recipes-'));
    fs.mkdirSync(path.join(dir, 'suggestions'));
    fs.writeFileSync(path.join(dir, 'suggestions', 'lint.md'), '---\noff: true\n---\n');
    const catalog = C.loadCatalog({ builtin: BUILTIN, own: dir });
    expect(catalog.errors).toEqual([]);
    expect(catalog.recipes.find((r: Recipe) => r.id === 'unchecked-error-python')).toMatchObject({ cards: [] });
  });
});

describe('the card ledger-recipes', () => {
  const catalog = C.loadCatalog({ builtin: BUILTIN, own: NONE });
  const report = (facts: object, more: object = {}) => C.buildReport({ facts: { git: true, ...facts }, catalog, now: 'x', ...more });
  const card = (r: { suggestions: { key: string }[] }, key = 'ledger-recipes') => r.suggestions.find((s) => s.key === key) as Record<string, any> | undefined;
  const entry = (o: object = {}) => ({
    key: 'unchecked-error@src/api',
    class: 'unchecked-error',
    title: 'unchecked error or result',
    area: 'src/api',
    scope: 'area',
    incidents: 2,
    weight: 2,
    severity: 'M',
    tasks: ['A-1', 'B-2'],
    files: ['src/api/save.ts', 'src/api/load.ts'],
    guardFailed: null,
    proposal: { state: 'add', task: null },
    ...o,
  });
  const ledger = (due: object[], o: object = {}) => ({ ledger: { due, guardFailed: [], marker: true, recent: {}, cap: { open: 0, max: 3, full: false }, ...o } });
  const base = { stacks: ['Node/TypeScript'], kinds: kinds(['test', 'gate']), inspectionOn: true };

  it('names the class, the count, the places, the stack and the recipe with its card, at medium and without the red marker', () => {
    const r = report({ ...base, ...ledger([entry()]) });
    const c = card(r);
    expect(c).toMatchObject({ priority: 'medium', category: 'tests', action: 'ask', state: 'open' });
    const item = c?.ledger.items[0];
    expect(item).toMatchObject({ class: 'unchecked-error', area: 'src/api', incidents: 2, files: ['src/api/save.ts', 'src/api/load.ts'], stacks: ['Node/TypeScript'] });
    expect(item.recipe).toMatchObject({ id: 'unchecked-error-typescript' });
    expect(item.recipe.cards[0]).toMatchObject({ key: 'lint', title: 'Add a linter' });
    expect(c?.detail).toMatch(/unchecked error or result in src\/api: 2 incident/i);
    expect(c?.detail).toMatch(/src\/api\/save\.ts/);
    expect(c?.detail).toMatch(/Node\/TypeScript/);
    expect(c?.detail).toMatch(/no-floating-promises/);
    expect(r.important).toBe(report({ ...base }).important);
  });

  it('places are paths only: an excerpt or code on the entry never reaches the card', () => {
    const r = report({ ...base, ...ledger([entry({ excerpt: 'TypeError: secret token abc', line: 12 })]) });
    const json = JSON.stringify(card(r));
    expect(json).not.toMatch(/secret token/);
    expect(Object.keys(card(r)?.ledger.items[0])).not.toContain('excerpt');
  });

  it('needs the inspection queue on (owner decision 16.11) and an open due class', () => {
    expect(card(report({ ...base, inspectionOn: false, ...ledger([entry()]) }))).toBeUndefined();
    expect(card(report({ ...base, inspectionOn: undefined, ...ledger([entry()]) }))).toBeUndefined();
    expect(card(report({ ...base, ...ledger([]) }))).toBeUndefined();
    expect(card(report({ ...base }))).toBeUndefined();
  });

  it('a no is remembered per class and area: a declined class, or one with a gate, is left out', () => {
    const declined = entry({ proposal: { state: 'declined', task: 'GATE-1' } });
    const exists = entry({ key: 'contract-drift@src/ui', class: 'contract-drift', area: 'src/ui', proposal: { state: 'exists', task: 'GATE-2' } });
    expect(card(report({ ...base, ...ledger([declined, exists]) }))).toBeUndefined();
    expect(C.holds('ledger-due', ledger([declined, exists]))).toBe(false);
    expect(C.holds('ledger-due:unchecked-error', ledger([declined]))).toBe(false);
    // Another area of the same class is another entry, and shows.
    const other = entry({ key: 'unchecked-error@src/ui', area: 'src/ui' });
    expect(card(report({ ...base, ...ledger([declined, other]) }))?.ledger.items.map((i: { area: string }) => i.area)).toEqual(['src/ui']);
  });

  it('an open proposal is named, and a full shared cap says the next one waits', () => {
    const open = entry({ proposal: { state: 'extend', task: 'GATE-4' } });
    const c = card(report({ ...base, ...ledger([open], { cap: { open: 3, max: 3, full: true } }) }));
    expect(c?.ledger.items[0].proposal).toMatchObject({ state: 'extend', task: 'GATE-4' });
    expect(c?.detail).toMatch(/GATE-4/);
    expect(c?.ledger.capFull).toBe(true);
    expect(c?.detail).toMatch(/three open proposals/);
  });

  it('at most three classes, the rest counted; a class without a recipe for the stack says so', () => {
    const list = ['a', 'b', 'c', 'd'].map((x) => entry({ key: `time-zone@src/${x}`, class: 'time-zone', title: 'time and time zone', area: `src/${x}` }));
    const c = card(report({ ...base, ...ledger(list) }));
    expect(c?.ledger.items).toHaveLength(3);
    expect(c?.ledger.more).toBe(1);
    expect(c?.ledger.items[0].recipe).toBeNull();
    expect(c?.detail).toMatch(/no recipe yet/i);
  });

  it('other and an unknown stack are never given a recipe', () => {
    const c = card(report({ inspectionOn: true, stacks: [], ...ledger([entry({ class: 'other' }), entry({ key: 'x@y', area: 'y' })]) }));
    expect(c?.ledger.items.map((i: { class: string }) => i.class)).toEqual(['unchecked-error']);
    expect(c?.ledger.items[0].recipe).toBeNull();
  });
});
