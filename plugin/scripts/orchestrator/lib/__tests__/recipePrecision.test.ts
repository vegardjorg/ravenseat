// =============================================================
// recipePrecision.test.ts: precision per recipe and per class, and the damping of a recipe that is seldom accepted
// (0i step 9, plans/feillogg-til-gater-2026-11-15.md section 3.9 "Presisjon måles").
//
// Locks: (1) a proposal is a gate task from the finding log (labels gate and finding-log); accepted is approved or later
// (built included), declined is cancelled, proposed is pending and never counts toward the minimum; (2) the recipe is
// read from the task's own field `recipe`, never from its mission, and a task without one counts for its class only;
// (3) database recipes are counted on their own rows and have their own, higher minimum; (4) a recipe is damped below
// 30 percent accepted after at least 5 decided proposals, never before, and the owner's choice per recipe wins both ways;
// (5) learning.recipeDamping off damps nothing automatically; (6) the catalog skips a damped recipe on the card and
// names it as damped instead, and a hint is never a proposal; (7) nothing but ids, classes and counts reaches the facts.
// =============================================================
import { describe, expect, it } from 'vitest';

/* eslint-disable-next-line @typescript-eslint/no-require-imports */
const P = require('../recipePrecision.js');
/* eslint-disable-next-line @typescript-eslint/no-require-imports */
const R = require('../findingRepeats.js');
/* eslint-disable-next-line @typescript-eslint/no-require-imports */
const C = require('../checksCatalog.js');

let n = 0;
/** A gate task proposed from the finding log, with a recipe id (null: none). */
const gate = (status: string, recipe: string | null = 'unchecked-error-node', o: Record<string, unknown> = {}) => {
  n += 1;
  return {
    id: `GATE-${n}`,
    title: `Gate: Unchecked error or result in src/a${n}`,
    status,
    labels: ['gate', 'finding-log'],
    source: `finding-log unchecked-error@src/a${n}`,
    mission: 'secret mission text with code',
    ...(recipe ? { recipe: { id: recipe, db: false } } : {}),
    ...o,
  };
};
const many = (status: string, k: number, recipe?: string | null, o?: Record<string, unknown>) => Array.from({ length: k }, () => gate(status, recipe, o));
const setup = (o: Record<string, unknown> = {}) => R.setupOf({ learning: o });

describe('the measure per recipe and per class', () => {
  it('counts accepted (approved or built), declined (cancelled) and pending (proposed) per recipe', () => {
    const tasks = [gate('waiting'), gate('done'), gate('cancelled'), gate('proposed'), gate('running')];
    const m = P.measure(tasks);
    expect(m.recipes).toEqual([
      { id: 'unchecked-error-node', class: 'unchecked-error', db: false, proposals: 5, accepted: 3, declined: 1, pending: 1, rate: 75 },
    ]);
    expect(m.classes).toEqual([{ class: 'unchecked-error', db: false, proposals: 5, accepted: 3, declined: 1, pending: 1, rate: 75 }]);
  });

  it('only gate tasks from the finding log count; a task without a recipe counts for its class only; a duplicate id once', () => {
    const plain = { id: 'GATE-90', title: 'Gate: a GATE line', status: 'cancelled', labels: ['gate'], source: null, recipe: { id: 'unchecked-error-node' } };
    const insp = { id: 'INSP-1', status: 'cancelled', labels: ['guard', 'inspection'] };
    const noRecipe = gate('cancelled', null);
    const one = gate('done');
    const m = P.measure([plain, insp, noRecipe, one, { ...one, status: 'cancelled' }]);
    expect(m.recipes).toEqual([{ id: 'unchecked-error-node', class: 'unchecked-error', db: false, proposals: 1, accepted: 1, declined: 0, pending: 0, rate: 100 }]);
    expect(m.classes[0]).toMatchObject({ class: 'unchecked-error', proposals: 2, accepted: 1, declined: 1, rate: 50 });
  });

  it('a recipe id that is not a recipe id is ignored, and the rate is null before anything is decided', () => {
    const m = P.measure([gate('proposed', 'Bad Id; rm -rf'), gate('proposed')]);
    expect(m.recipes.map((r: { id: string }) => r.id)).toEqual(['unchecked-error-node']);
    expect(m.recipes[0].rate).toBeNull();
  });

  it('counts database recipes on their own rows, per recipe and per class', () => {
    const db = (status: string) => gate(status, null, { source: 'finding-log access-control@supabase', recipe: { id: 'access-control-supabase', db: true } });
    const m = P.measure([db('cancelled'), db('done'), gate('cancelled', null, { source: 'finding-log access-control@src/api' })]);
    expect(m.recipes).toEqual([{ id: 'access-control-supabase', class: 'access-control', db: true, proposals: 2, accepted: 1, declined: 1, pending: 0, rate: 50 }]);
    expect(m.classes).toEqual([
      { class: 'access-control', db: false, proposals: 1, accepted: 0, declined: 1, pending: 0, rate: 0 },
      { class: 'access-control', db: true, proposals: 2, accepted: 1, declined: 1, pending: 0, rate: 50 },
    ]);
  });
});

describe('damping', () => {
  const stat = (accepted: number, declined: number, db = false) => ({ id: 'x', class: 'unchecked-error', db, proposals: accepted + declined, accepted, declined, pending: 0, rate: null });

  it('damps below 30 percent accepted after at least 5 decided proposals, and not before', () => {
    expect(P.dampOf(stat(1, 4), setup())).toEqual({ damped: true, by: 'auto' });
    expect(P.dampOf(stat(0, 4), setup())).toEqual({ damped: false, by: null });
    expect(P.dampOf(stat(2, 3), setup())).toEqual({ damped: false, by: null });
    // Exactly 30 percent is not below it.
    expect(P.dampOf(stat(3, 7), setup())).toEqual({ damped: false, by: null });
    expect(P.dampOf(stat(2, 8), setup())).toEqual({ damped: true, by: 'auto' });
  });

  it('pending proposals do not count toward the minimum', () => {
    expect(P.dampOf({ ...stat(0, 4), proposals: 9, pending: 5 }, setup())).toEqual({ damped: false, by: null });
  });

  it('a database recipe needs its own minimum (10 by default) before it is damped', () => {
    expect(P.dampOf(stat(1, 6, true), setup())).toEqual({ damped: false, by: null });
    expect(P.dampOf(stat(1, 9, true), setup())).toEqual({ damped: true, by: 'auto' });
    expect(P.dampOf(stat(1, 6, true), setup({ recipeMinProposalsDb: 5 }))).toEqual({ damped: true, by: 'auto' });
  });

  it('the owner wins both ways, and learning.recipeDamping off damps nothing by itself', () => {
    expect(P.dampOf(stat(1, 4), setup(), 'show')).toEqual({ damped: false, by: 'owner' });
    expect(P.dampOf(stat(5, 0), setup(), 'damp')).toEqual({ damped: true, by: 'owner' });
    expect(P.dampOf(stat(1, 4), setup({ recipeDamping: false }))).toEqual({ damped: false, by: null });
    expect(P.dampOf(stat(5, 0), setup({ recipeDamping: false }), 'damp')).toEqual({ damped: true, by: 'owner' });
    expect(P.dampOf(stat(1, 4), setup({ recipeMinAccepted: 10 }))).toEqual({ damped: false, by: null });
  });

  it('the settings have defaults, and doctor names a wrong value', () => {
    expect(setup()).toMatchObject({ recipeDamping: true, recipeMinProposals: 5, recipeMinProposalsDb: 10, recipeMinAccepted: 30 });
    expect(R.setupProblems({ recipeMinAccepted: 101 })).toEqual(['learning.recipeMinAccepted must be a whole number from 1 to 100']);
    expect(R.setupProblems({ recipeDamping: 'yes' })).toEqual(['learning.recipeDamping must be true or false']);
  });

  it('overridesOf keeps only valid ids with show or damp', () => {
    expect(P.overridesOf({ checksPanel: { recipes: { 'a-b': 'show', c: 'damp', d: 'maybe', 'Bad Id': 'show' } } })).toEqual({ 'a-b': 'show', c: 'damp' });
    expect(P.overridesOf(null)).toEqual({});
  });
});

describe('the facts for the Checks tab', () => {
  const catalog = [
    { id: 'unchecked-error-node', class: 'unchecked-error', title: 'A lint rule for floating promises', text: 'x', db: false },
    { id: 'unchecked-error-python', class: 'unchecked-error', title: 'Ruff', text: 'y', db: false },
  ];

  it('lists every recipe with proposals or an owner choice, with title, counts, rate and whether it is damped', () => {
    const tasks = [...many('cancelled', 4), gate('done')];
    const f = P.facts({ tasks, setup: setup(), overrides: { 'unchecked-error-python': 'damp' }, recipes: catalog });
    expect(f.on).toBe(true);
    expect(f.damped).toEqual(['unchecked-error-node', 'unchecked-error-python']);
    expect(f.recipes).toEqual([
      { id: 'unchecked-error-node', title: 'A lint rule for floating promises', class: 'unchecked-error', db: false, proposals: 5, accepted: 1, declined: 4, pending: 0, rate: 20, damped: true, by: 'auto', override: null },
      { id: 'unchecked-error-python', title: 'Ruff', class: 'unchecked-error', db: false, proposals: 0, accepted: 0, declined: 0, pending: 0, rate: null, damped: true, by: 'owner', override: 'damp' },
    ]);
    expect(JSON.stringify(f)).not.toContain('secret mission');
    expect(f.classes[0]).toMatchObject({ class: 'unchecked-error', proposals: 5, rate: 20 });
  });

  it('a task field `recipe` comes from the recipe (id and db only), and none from a hint', () => {
    expect(P.recipeRef({ id: 'unchecked-error-node', title: 't', text: 'long', db: false })).toEqual({ id: 'unchecked-error-node', db: false });
    expect(P.recipeRef({ id: 'access-control-supabase', db: true })).toEqual({ id: 'access-control-supabase', db: true });
    expect(P.recipeRef(null)).toBeNull();
    expect(P.recipeRef({ id: 'Bad Id' })).toBeNull();
  });
});

describe('the task carries its recipe', () => {
  const entry = {
    key: 'unchecked-error@src/api', class: 'unchecked-error', area: 'src/api', scope: 'area', incidents: 2, weight: 2,
    severity: 'M', tasks: ['A-1', 'B-2'], files: ['src/api/save.ts'], line: 4, places: ['src/api/save.ts'],
    firstSeen: '2026-10-01T10:00:00.000Z', lastSeen: '2026-11-15T10:00:00.000Z', due: true, guardFailed: null,
  };
  it('buildTask and proposalTask store recipe.id in their own field; the source stays the same', () => {
    const recipe = { id: 'unchecked-error-node', title: 'Lint', text: 'Turn it on.', db: false };
    const b = R.buildTask(entry, { id: 'GATE-1', recipe });
    expect(b.recipe).toEqual({ id: 'unchecked-error-node', db: false });
    expect(b.source).toBe('finding-log unchecked-error@src/api');
    expect(R.proposalTask(entry, { id: 'GATE-2', recipe }).recipe).toEqual({ id: 'unchecked-error-node', db: false });
    expect(R.proposalTask(entry, { id: 'GATE-3' })).not.toHaveProperty('recipe');
    // The guard reading of a done one is unchanged by the new field.
    expect(R.guardsFrom({ tasks: [{ ...b, status: 'done', done: '2026-11-16T10:00:00Z' }] })[0]).toMatchObject({ class: 'unchecked-error', area: 'src/api' });
  });
});

describe('the catalog skips a damped recipe', () => {
  const two = [
    { id: 'first', class: 'unchecked-error', when: '', title: 'First', text: 'a', cards: [], db: false },
    { id: 'second', class: 'unchecked-error', when: '', title: 'Second', text: 'b', cards: [], db: false },
  ];
  it('recipeFor takes the next recipe whose when holds, and dampedFor names the damped ones', () => {
    expect(C.recipeFor('unchecked-error', {}, two).id).toBe('first');
    expect(C.recipeFor('unchecked-error', { recipeDamped: ['first'] }, two).id).toBe('second');
    expect(C.recipeFor('unchecked-error', { recipeDamped: ['first', 'second'] }, two)).toBeNull();
    expect(C.dampedFor('unchecked-error', { recipeDamped: ['first'] }, two)).toEqual([{ id: 'first', title: 'First' }]);
    expect(C.dampedFor('unchecked-error', {}, two)).toEqual([]);
  });
});
