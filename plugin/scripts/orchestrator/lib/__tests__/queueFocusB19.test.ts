/**
 * @vitest-environment jsdom
 */
// =============================================================
// queueFocusB19.test.ts: the new layout of the Focus tab (board step B19, the focus review of 2026-11-18, owner
// question 1: Now and Next become one list, now_count stays in the data but is not drawn).
//
// What the tests prove:
//   - one ordered "In focus" list holds every step in step order (T1, T2, ...), and there is no Now or Next column,
//   - each step row folds open with a real button (aria-expanded, aria-controls) to a region that lists the step's
//     tasks with a status per task; the server builds that list (planBasis step_tasks, the same assignment as the
//     step evaluation), and a done step keeps its "done" badge,
//   - "Not in focus" and "On pause" are sections of their own with real headings, after the list,
//   - the focus settings (name, rest, until, drag along, when done, Clear focus, Areas) sit in a fold below the lists,
//     closed by default, opened by a real button,
//   - the DOM order is the mobile order (what happens now, In focus, Not in focus, On pause, settings fold), and below
//     600 px the sections stack in one column,
//   - the keyboard moves a step within the list (up and down) and between the sections (left and right), and saving
//     sends the saved now_count unchanged,
//   - the new CSS uses tokens only, the fold buttons are at least 36 px, and the docs describe the new layout.
// The whole board runs in jsdom with a small synthetic queue (no network), as in queueFocusB17.test.ts.
// =============================================================
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { clientSource } from './boardClient';

/* eslint-disable @typescript-eslint/no-require-imports */
const T = require('../queueBoard.js') as {
  board: (queue: unknown, option?: unknown) => any;
  planBasis: (queue: unknown, option?: unknown) => any;
};
/* eslint-enable @typescript-eslint/no-require-imports */

const ORCH = join(__dirname, '..', '..');
const CLIENT = join(ORCH, 'queue-board');
const DOCS = join(ORCH, '..', '..', 'docs');
const iso = new Date(Date.now() - 86_400_000).toISOString();

function task(id: string, project: string, feature: string, status: string, extra: object = {}) {
  return {
    id,
    title: `Task ${id}`,
    project,
    feature,
    domain: project,
    class: 'K',
    value: 5,
    content_min: 60,
    status,
    depends_on: [],
    waiting_on: [],
    owned_files: [`file/${id}.ts`],
    owner_db: [],
    shared_patch: [],
    mission: `scripts/.queue/mission/${id}.md`,
    added_by: 'test',
    added_at: iso,
    ...(status === 'done' ? { done: iso } : {}),
    ...extra,
  };
}

/** Theme is done with QA waiting, Today has a ready and a blocked task, billing is a project step, docs is outside. */
function makeQueue() {
  return {
    created: iso,
    limits: { maxConcurrent: 5, maxDPlus: 2, maxPerDomain: 5, maxDb: 2 },
    tasks: [
      task('UI-1', 'ui', 'Theme', 'done', { qa_status: 'waiting' }),
      task('UI-2', 'ui', 'Polish', 'done'),
      task('UI-3', 'ui', 'Today', 'waiting'),
      task('UI-4', 'ui', 'Today', 'waiting', { depends_on: ['BILL-1'] }),
      task('BILL-1', 'billing', 'Plans', 'waiting'),
      task('DOC-1', 'docs', 'Guide', 'waiting'),
    ],
    projects: {
      ui: { title: 'Habit screens', prefixes: ['UI-'] },
      billing: { title: 'Subscriptions', prefixes: ['BILL-'] },
      docs: { title: 'Docs', prefixes: ['DOC-'] },
    },
    areas: {},
    question: [],
    resolutions: [],
    changelog: [],
    focus: {
      order: ['feature:ui/Theme', 'feature:ui/Today', 'project:billing'],
      rest: 'wait',
      from: iso,
      now_count: 2,
      drag_with_dependencies: false,
    },
  };
}

const queue = makeQueue();
const state = { version: 'v1', data: { ...T.board(queue), gitError: null, logo: false } };
const posted: any[] = [];

const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};
const $ = (id: string) => document.getElementById(id) as HTMLElement;
const view = () => document.querySelector('.plan-view') as HTMLElement;
const focusKeys = () =>
  [...document.querySelectorAll('.plan-list[data-col="focus"] > .plan-element')].map(
    (x) => (x as HTMLElement).dataset.key,
  );
const row = (key: string) =>
  document.querySelector(`.plan-list > .plan-element[data-key="${key}"]`) as HTMLElement;
const press = (target: HTMLElement, key: string) =>
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

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
  w.fetch = async (filePath: string, init?: { body?: string }) => {
    if (filePath.startsWith('/api/focus')) posted.push(JSON.parse(init?.body ?? '{}'));
    return {
      ok: true,
      status: 200,
      json: async () =>
        filePath.startsWith('/api/state')
          ? filePath.includes(`version=${state.version}`)
            ? { version: state.version, unchanged: true }
            : state
          : filePath.startsWith('/api/focus')
            ? { can: true, before_text: 'before', after_text: 'after', lines: [], changed: 'c1' }
            : {},
    };
  };
  for (const f of ['a11y.js', '../lib/queueGraph.js', 'graph.js', 'plan.js', 'performance.js', 'board/'])
    (0, eval)(clientSource(f));
  await flush();
  $('show-plan').click();
  await flush();
}, 60_000);

describe('planBasis lists the tasks of each saved step', () => {
  it('gives step_tasks per step key with a status per task, from the same assignment as the step evaluation', () => {
    const p = T.planBasis(queue);
    expect(p.step_tasks['feature:ui/Theme']).toEqual([{ id: 'UI-1', title: 'Task UI-1', state: 'qa' }]);
    expect(p.step_tasks['feature:ui/Today']).toEqual([
      { id: 'UI-3', title: 'Task UI-3', state: 'ready' },
      { id: 'UI-4', title: 'Task UI-4', state: 'blocked' },
    ]);
    expect(p.step_tasks['project:billing']).toEqual([{ id: 'BILL-1', title: 'Task BILL-1', state: 'ready' }]);
    // A task outside every step is in no list, and a done task without a rest is left out.
    const all = Object.values(p.step_tasks).flat() as { id: string }[];
    expect(all.map((x) => x.id)).not.toContain('DOC-1');
    expect(all.map((x) => x.id)).not.toContain('UI-2');
  });

  it('without a focus step_tasks is empty', () => {
    expect(T.planBasis({ ...makeQueue(), focus: undefined }).step_tasks).toEqual({});
  });
});

describe('one ordered "In focus" list', () => {
  it('holds every step in step order and draws no Now or Next column', () => {
    expect(focusKeys()).toEqual(['feature:ui/Theme', 'feature:ui/Today', 'project:billing']);
    const steps = [...document.querySelectorAll('.plan-list[data-col="focus"] > .plan-element .plan-step')].map(
      (x) => x.textContent,
    );
    expect(steps).toEqual(['T1', 'T2', 'T3']);
    expect(document.querySelector('[data-col="now"], [data-col="next"], .plan-now, .plan-next')).toBeNull();
    const headings = [...view().querySelectorAll('h2')].map((h) => (h.textContent ?? '').trim());
    expect(headings).not.toContain('Now');
    expect(headings).not.toContain('Next');
  });

  it('"In focus", "Not in focus" and "On pause" are real headings that name their sections', () => {
    for (const [col, name] of [
      ['focus', 'In focus'],
      ['later', 'Not in focus'],
      ['waiting', 'On pause'],
    ]) {
      const list = document.querySelector(`.plan-list[data-col="${col}"]`) as HTMLElement;
      const section = list.closest('section') as HTMLElement;
      const h = $(section.getAttribute('aria-labelledby') ?? '');
      expect(h?.tagName, col).toBe('H2');
      expect(h.textContent, col).toContain(name);
    }
    expect(row('project:docs')?.closest('.plan-list')?.getAttribute('data-col')).toBe('later');
  });
});

describe('a step folds open to show its tasks', () => {
  it('has a button with aria-expanded and aria-controls, and a hidden region named by it', async () => {
    const today = row('feature:ui/Today');
    const button = today.querySelector('button.plan-tasks-toggle') as HTMLButtonElement;
    expect(button).toBeTruthy();
    expect(button.getAttribute('aria-expanded')).toBe('false');
    const region = $(button.getAttribute('aria-controls') ?? '');
    expect(region.getAttribute('role')).toBe('region');
    expect(region.getAttribute('aria-labelledby')).toBe(button.id);
    expect(region.hidden).toBe(true);
    button.click();
    await flush();
    const open = row('feature:ui/Today').querySelector('button.plan-tasks-toggle') as HTMLButtonElement;
    expect(open.getAttribute('aria-expanded')).toBe('true');
    const shown = $(open.getAttribute('aria-controls') ?? '');
    expect(shown.hidden).toBe(false);
    const items = [...shown.querySelectorAll('li')].map((li) => (li.textContent ?? '').replace(/\s+/g, ' ').trim());
    expect(items).toEqual(['UI-3 Task UI-3 ready', 'UI-4 Task UI-4 blocked']);
    // The opened fold keeps keyboard focus on its button after the redraw.
    expect(document.activeElement).toBe(open);
  });

  it('a done step keeps its "done" badge and its fold shows the rest that holds it', async () => {
    const theme = row('feature:ui/Theme');
    const badges = [...theme.querySelectorAll('.plan-header .badge')].map((b) => b.textContent);
    expect(badges).toContain('done');
    (theme.querySelector('button.plan-tasks-toggle') as HTMLButtonElement).click();
    await flush();
    const region = $(
      (row('feature:ui/Theme').querySelector('button.plan-tasks-toggle') as HTMLElement).getAttribute(
        'aria-controls',
      ) ?? '',
    );
    expect(region.textContent).toMatch(/UI-1.*QA/);
  });
});

describe('the focus settings sit in a fold below the lists', () => {
  it('is closed by default and holds name, rest, until, drag along, when done, Clear focus and Areas', async () => {
    const toggle = $('plan-settings-toggle') as HTMLButtonElement;
    expect(toggle.tagName).toBe('BUTTON');
    expect(toggle.closest('h2')).toBeTruthy();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-controls')).toBe('plan-settings-body');
    const body = $('plan-settings-body');
    expect(body.getAttribute('role')).toBe('region');
    expect(body.hidden).toBe(true);
    for (const label of [
      'Name of the focus period',
      'Rest of the queue',
      'Focus applies up to and including',
      'When the focus is done',
    ])
      expect(body.querySelector(`[aria-label="${label}"]`), label).toBeTruthy();
    expect(body.querySelector('input[type="checkbox"]')).toBeTruthy();
    const texts = [...body.querySelectorAll('button')].map((b) => (b.textContent ?? '').trim());
    expect(texts).toEqual(expect.arrayContaining(['Clear focus', 'Areas …']));
    // Nothing of it outside the fold.
    const outside = [...view().querySelectorAll('select, input')].filter((x) => !body.contains(x));
    expect(outside).toEqual([]);
    toggle.click();
    await flush();
    expect($('plan-settings-toggle').getAttribute('aria-expanded')).toBe('true');
    expect($('plan-settings-body').hidden).toBe(false);
    ($('plan-settings-toggle') as HTMLButtonElement).click();
    await flush();
    expect($('plan-settings-body').hidden).toBe(true);
  });

  it('keeps the draft state, Discard and Save focus with the list, outside the fold', () => {
    const tool = document.querySelector('.plan-tool') as HTMLElement;
    expect(tool.closest('#plan-settings-body')).toBeNull();
    const texts = [...tool.querySelectorAll('button')].map((b) => (b.textContent ?? '').trim());
    expect(texts).toEqual(expect.arrayContaining(['Discard', 'Save focus']));
  });
});

describe('the order is the mobile order', () => {
  it('what happens now, In focus, Not in focus, On pause, then the settings fold', () => {
    const order = [
      view().querySelector('.focus-now'),
      document.querySelector('.plan-list[data-col="focus"]'),
      document.querySelector('.plan-list[data-col="later"]'),
      document.querySelector('.plan-list[data-col="waiting"]'),
      $('plan-settings-toggle'),
    ] as HTMLElement[];
    for (const x of order) expect(x).toBeTruthy();
    for (let i = 1; i < order.length; i++)
      expect(order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING, `${i}`).toBeTruthy();
    // "How focus works" stays on top, before the line.
    const how = view().querySelector('.focus-how') as HTMLElement;
    expect(how.compareDocumentPosition(order[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('below 600 px the sections stack in one column, and no rule reorders them', () => {
    const css = readFileSync(join(CLIENT, 'board.css'), 'utf8');
    const media = css.slice(css.indexOf('@media (max-width: 599px)'));
    expect(media.length).toBeGreaterThan(0);
    const block = media.slice(0, media.indexOf('\n}\n'));
    expect(block).toMatch(/\.plan-rest\s*\{[^}]*grid-template-columns:\s*1fr/);
    const planRules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter((m) => /\.plan-/.test(m[1]));
    for (const m of planRules) expect(m[2], m[1].trim()).not.toMatch(/(^|;|\s)order\s*:/);
  });
});

describe('keyboard and saving', () => {
  it('moves a step up in the list and out to Not in focus, and saving sends the saved now_count', async () => {
    let el = row('project:billing');
    el.focus();
    press(el, ' ');
    await flush();
    press(row('project:billing'), 'ArrowUp');
    await flush();
    expect(focusKeys()).toEqual(['feature:ui/Theme', 'project:billing', 'feature:ui/Today']);
    press(row('project:billing'), ' ');
    await flush();
    el = row('project:billing');
    el.focus();
    press(el, ' ');
    await flush();
    press(row('project:billing'), 'ArrowRight');
    await flush();
    expect(row('project:billing').closest('.plan-list')?.getAttribute('data-col')).toBe('later');
    press(row('project:billing'), 'ArrowRight');
    await flush();
    expect(row('project:billing').closest('.plan-list')?.getAttribute('data-col')).toBe('waiting');
    press(row('project:billing'), 'Escape');
    await flush();
    expect(focusKeys()).toEqual(['feature:ui/Theme', 'project:billing', 'feature:ui/Today']);
    const save = [...document.querySelectorAll('.plan-tool button')].find(
      (b) => (b.textContent ?? '').trim() === 'Save focus',
    ) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    save.click();
    await flush();
    const last = posted[posted.length - 1];
    expect(last.dry).toBe(true);
    expect(last.plan.order).toEqual(['feature:ui/Theme', 'project:billing', 'feature:ui/Today']);
    expect(last.plan.now_count).toBe(2);
    const cancel = [...document.querySelectorAll('#plan-dialog button')].find(
      (b) => (b.textContent ?? '').trim() === 'Cancel',
    ) as HTMLButtonElement;
    cancel.click();
    await flush();
  });
});

describe('tokens, targets and docs', () => {
  const css = readFileSync(join(CLIENT, 'board.css'), 'utf8');
  const rules = (re: RegExp) => [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter((m) => re.test(m[1]));

  it('the new Focus layout rules use tokens only (no hex, no rgb color)', () => {
    const mine = rules(/\.plan-(focus|rest|section|settings|tasks)/);
    expect(mine.length).toBeGreaterThan(0);
    for (const m of mine) expect(m[2], m[1].trim()).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(/i);
  });

  it('the fold buttons are at least 36 px on a mouse', () => {
    for (const sel of ['.plan-expand', '.plan-tasks-toggle']) {
      const m = rules(new RegExp(`(^|,)\\s*\\${sel}\\s*(,|$)`)).find((x) => /min-height/.test(x[2]));
      expect(m, sel).toBeTruthy();
      expect(Number(/min-height:\s*(\d+)px/.exec(m![2])?.[1]), sel).toBeGreaterThanOrEqual(36);
    }
  });

  it('the docs describe one In focus list, Not in focus, On pause and the settings fold', () => {
    for (const f of ['board.md', 'full-mode.md']) {
      const text = readFileSync(join(DOCS, f), 'utf8');
      expect(text, f).not.toMatch(/Now, Next, Later and Waiting/);
      expect(text, f).toMatch(/In focus/);
      expect(text, f).toMatch(/Not in focus/);
      expect(text, f).toMatch(/On pause/);
    }
    const board = readFileSync(join(DOCS, 'board.md'), 'utf8');
    expect(board).toMatch(/Focus settings/);
  });

  it('the board help and the focus line advice name the new sections, not Now and Next', () => {
    for (const f of ['board/menus.js', 'board/views.js', 'index.html']) {
      const src = readFileSync(join(CLIENT, f), 'utf8');
      expect(src, f).not.toMatch(/(into|to|between) Now(,| and) Next/);
      expect(src, f).not.toMatch(/four columns/);
    }
  });
});
