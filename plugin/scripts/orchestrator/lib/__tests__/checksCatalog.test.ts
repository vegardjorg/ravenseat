// =============================================================
// checksCatalog.test.ts: the suggestions as data (lib/checksCatalog.js and checks-catalog/).
//
// Locks: (1) every template the plugin ships is valid; (2) a mistake in a file leaves that file out and says why; (3) a project
// can add, replace and remove suggestions and categories; (4) `when` holds as written; (5) the order is priority first;
// (6) the task is an investigation from the template's own sections, and a declined one can be asked for again.
// =============================================================
import { describe, expect, it } from 'vitest';
import path from 'node:path';

const C = require('../checksCatalog.js');
const { guidance } = { guidance: require('../guidance.js') };

const BUILTIN = path.resolve(__dirname, '..', '..', 'checks-catalog');

const file = (head: string, body = '## Investigate\nFind out.\n\n## Plan and build\nDo it.\n') => `---\n${head}\n---\n${body}`;
const GOOD = 'title: T\ncategory: ci\npriority: high\nwhen: has-ci\nwhy: Because.';
const kinds = (...list: [string, string][]) => list.map(([key, where]) => ({ key, places: [{ where }] }));

describe('the catalog the plugin ships', () => {
  const catalog = C.loadCatalog({ builtin: BUILTIN, own: path.join(BUILTIN, 'does-not-exist') });
  it('has no mistakes, and every suggestion has a category that exists', () => {
    expect(catalog.errors).toEqual([]);
    const keys = catalog.categories.map((c: { key: string }) => c.key);
    for (const t of catalog.templates) expect(keys).toContain(t.category);
    expect(catalog.templates.length).toBeGreaterThan(10);
  });
  it('every suggestion that uses an agent has both sections', () => {
    for (const t of catalog.templates.filter((x: { action: string }) => !x.action)) {
      expect(t.investigate.length).toBeGreaterThan(20);
      expect(t.plan.length).toBeGreaterThan(20);
    }
  });
  it('a bare project gets the first steps, and no suggestion that needs CI', () => {
    const r = C.buildReport({ facts: { git: true, remote: 'github', stacks: ['Node'], ci: [], kinds: [] }, catalog, now: 'x' });
    const keys = r.suggestions.map((s: { key: string }) => s.key);
    expect(keys.slice(0, 2)).toEqual(['first-test', 'ci-on-push']);
    expect(keys).not.toContain('tests-in-ci');
  });
});

describe('parseTemplate', () => {
  it('reads the header and the two sections, also with Windows line endings', () => {
    const t = C.parseTemplate(file(`${GOOD}\ncontent_min: 25`).replace(/\n/g, '\r\n'), 'x');
    expect(t).toMatchObject({ key: 'x', title: 'T', priority: 'high', contentMin: 25, investigate: 'Find out.', plan: 'Do it.', errors: [] });
  });
  it('says what is wrong', () => {
    expect(C.parseTemplate('no header', 'x').errors[0]).toContain('no header');
    expect(C.parseTemplate(file('title: T\ncategory: ci\npriority: urgent\nwhy: W'), 'x').errors[0]).toContain('priority must be');
    expect(C.parseTemplate(file(`${GOOD}\nwhen: has-cii`), 'x').errors[0]).toContain('unknown condition "has-cii"');
    expect(C.parseTemplate(file(GOOD, '## Investigate\nOnly this.\n'), 'x').errors[0]).toContain('Plan and build');
  });
  it('a suggestion with an action needs no sections, and off needs nothing else', () => {
    expect(C.parseTemplate(file(`${GOOD}\naction: gates`, ''), 'x').errors).toEqual([]);
    expect(C.parseTemplate(file('off: true', ''), 'x')).toEqual({ key: 'x', off: true, errors: [] });
  });
});

describe('mergeCatalog: a project changes the suggestions without code', () => {
  const t = (key: string, category = 'ci', extra = '') => C.parseTemplate(file(`title: ${key}\ncategory: ${category}\npriority: high\nwhy: W${extra}`), key);
  const builtin = { categories: [{ key: 'ci', title: 'CI' }, { key: 'tests', title: 'Tests' }], templates: [t('a'), t('b', 'tests')], errors: [] };
  const merge = (own: object) => C.mergeCatalog(builtin, { categories: [], templates: [], errors: [], ...own });
  const keys = (m: { templates: { key: string }[] }) => m.templates.map((x) => x.key);

  it('adds and replaces a suggestion', () => {
    const m = merge({ templates: [t('new'), { ...t('a'), title: 'Mine' }] });
    expect(keys(m)).toEqual(['a', 'b', 'new']);
    expect(m.templates[0].title).toBe('Mine');
  });
  it('removes a suggestion', () => {
    expect(keys(merge({ templates: [C.parseTemplate(file('off: true', ''), 'a')] }))).toEqual(['b']);
  });
  it('adds a category, renames one, and removes one with its suggestions', () => {
    const m = merge({ categories: [{ key: 'ops', title: 'Ops' }, { key: 'ci', title: 'Pipelines' }, { key: 'tests', off: true }] });
    expect(m.categories.map((c: { title: string }) => c.title)).toEqual(['Pipelines', 'Ops']);
    expect(keys(m)).toEqual(['a']);
  });
  it('a suggestion in a category nobody listed is kept; one with a mistake is left out and reported', () => {
    expect(keys(merge({ templates: [t('c', 'other')] }))).toContain('c');
    const bad = merge({ templates: [C.parseTemplate('nope', 'broken')] });
    expect(keys(bad)).not.toContain('broken');
    expect(bad.errors[0]).toContain('broken');
  });
});

describe('holds', () => {
  const facts = { git: true, ci: [{}], hasGates: false, secretsOk: true, stacks: [], kinds: kinds(['test', 'ci'], ['lint', 'script']) };
  it.each([
    ['', true],
    ['has-ci', true],
    ['no-ci', false],
    ['has-ci, no-gates', true],
    ['has-ci, has-gates', false],
    ['found:test', true],
    ['missing:test', false],
    ['missing:test|types', true],
    ['not-in-ci:test', false],
    ['not-in-ci:lint', true],
    ['not-in-ci:types', false],
    ['secrets-open', false],
    ['made-up', false],
    ['made-up:test', false],
  ])('%s is %s', (when, want) => {
    expect(C.holds(when, facts)).toBe(want);
  });
});

describe('buildReport', () => {
  const t = (key: string, priority: string, category: string, extra = '') => C.parseTemplate(file(`title: ${key}\ncategory: ${category}\npriority: ${priority}\nwhy: W${extra}`), key);
  const catalog = {
    categories: [{ key: 'one', title: 'One' }, { key: 'two', title: 'Two' }],
    templates: [t('low-one', 'low', 'one'), t('high-two', 'high', 'two'), t('high-one', 'high', 'one', '\nalso_task: KS-CI')],
    errors: [],
  };
  const state = (tasks: object[], dismissed: string[] = []) =>
    Object.fromEntries(C.buildReport({ facts: {}, catalog, tasks, dismissed, now: 'x' }).suggestions.map((s: { key: string; state: string }) => [s.key, s.state]));

  it('sorts by priority first, then the category order', () => {
    const r = C.buildReport({ facts: {}, catalog, now: 'x' });
    expect(r.suggestions.map((s: { key: string }) => s.key)).toEqual(['high-one', 'high-two', 'low-one']);
  });
  it('tells the state from the queue, also from the build task that does the same work', () => {
    expect(state([{ id: 'KS-PLAN-HIGH-TWO', status: 'waiting' }])['high-two']).toBe('queued');
    expect(state([{ id: 'KS-PLAN-HIGH-TWO', status: 'done' }])['high-two']).toBe('planned');
    expect(state([{ id: 'KS-PLAN-HIGH-TWO', status: 'cancelled' }])['high-two']).toBe('open');
    expect(state([{ id: 'KS-CI', status: 'proposed' }])['high-one']).toBe('queued');
    expect(state([], ['low-one'])['low-one']).toBe('dismissed');
  });
});

describe('planTask', () => {
  const s = { key: 'tests-in-ci', title: 'Run tests', why: 'Why text', priority: 'high', contentMin: 30, investigate: 'INVESTIGATE TEXT', plan: 'PLAN TEXT' };
  const found = { ci: [], kinds: [{ title: 'Tests', places: [{ where: 'ci', file: 'ci.yml' }, { where: 'gate' }] }] };

  it('is an investigation from the template, which builds nothing and proposes the build', () => {
    const t = C.planTask(s, found, []);
    expect(t).toMatchObject({ id: 'KS-PLAN-TESTS-IN-CI', class: 'U', content_min: 30, value: 8 });
    expect(t.mission).toContain('INVESTIGATE TEXT');
    expect(t.mission).toContain('PLAN TEXT');
    expect(t.mission).toContain('Do not build it');
    expect(t.mission).toContain('Tests: CI (ci.yml), gate');
    expect(t.mission).toContain('Never push');
    // The plan goes in the track result: a queue agent is denied `cq add`, and `cq finding` needs a registered project.
    expect(t.mission).toContain('track-result.md');
    expect(t.mission).not.toContain('cq add');
    expect(t.mission).not.toContain('cq finding');
  });
  it('a suggestion investigated before gets a free id, and a longer key is not mixed up', () => {
    expect(C.planTask(s, found, [{ id: 'KS-PLAN-TESTS-IN-CI', status: 'cancelled' }]).id).toBe('KS-PLAN-TESTS-IN-CI-2');
    expect(C.planTask({ ...s, key: 'tests' }, found, [{ id: 'KS-PLAN-TESTS-IN-CI', status: 'done' }]).id).toBe('KS-PLAN-TESTS');
  });
});

describe('the switch', () => {
  it('its own setting wins, and without one it follows the guidance', () => {
    expect(guidance.checksPanelOn({})).toBe(true);
    expect(guidance.checksPanelOn({ guidance: 'quiet' })).toBe(false);
    expect(guidance.checksPanelOn({ guidance: 'quiet', checksPanel: { mode: 'on' } })).toBe(true);
    expect(guidance.checksPanelOn({ checksPanel: { mode: 'off' } })).toBe(false);
  });
});
