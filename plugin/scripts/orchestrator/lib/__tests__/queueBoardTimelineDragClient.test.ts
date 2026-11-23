/**
 * @vitest-environment jsdom
 */
// =============================================================
// queueBoardTimelineDragClient.test.ts: the board side of the Timeline's drag for order (roadmap TIDSLINJE T-B).
//
// Locks the keyboard model on a planned bar and on a step row (Space lifts, the arrows move with the place said in the
// live region, Enter drops, Escape cancels, left and right give the sideways refusal), the preview before a save (the
// dry run with plan_effect, the plan sentence, Save and Cancel), the save with the preview's version and the Undo toast
// with the changelog number, the direct save when board.timelineDragPreview is off, the table's Move up and Move down
// buttons, and that with board.timelineDrag off nothing lifts (Space opens the card, as before). The whole board runs
// in jsdom with a small queue with two focus steps and the real schedule payload; the server is a fetch mock.
// =============================================================
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { clientSource } from './boardClient';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const T = require('../queueBoard.js') as { board: (queue: unknown, option?: unknown) => any };
const KK = require('../queueConfig.js') as any;
const QT = require('../queueTimeline.js') as any;
/* eslint-enable @typescript-eslint/no-require-imports */

const CLIENT = join(__dirname, '..', '..', 'queue-board');
const NOW = Date.now();
const H = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const task = (id: string, extra: object = {}) => ({
  id,
  title: `Task ${id}`,
  domain: id.toLowerCase(),
  class: 'K',
  value: 5,
  content_min: 60,
  status: 'waiting',
  depends_on: [],
  waiting_on: [],
  owned_files: [`f/${id}.ts`],
  added_by: 'test',
  added_at: iso(NOW - 48 * H),
  ...extra,
});
const queue = {
  created: iso(NOW - 72 * H),
  changed: iso(NOW - H),
  limits: { maxConcurrent: 1, maxDPlus: 2, maxPerDomain: 5, maxDb: 2 },
  projects: { a: { title: 'Alpha', prefixes: ['A-'] }, b: { title: 'Beta', prefixes: ['B-'] } },
  areas: {},
  question: {},
  resolutions: {},
  changelog: [],
  focus: { order: ['project:a', 'project:b'], rest: 'wait', from: iso(NOW - 24 * H), now_count: 1 },
  tasks: [task('A-1', { value: 8 }), task('A-2', { value: 3 }), task('B-1')],
};
const flush = async () => {
  for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0));
};

let state: any;
let timeline: object = {};
const posts: { path: string; body: any }[] = [];
const payload = QT.timelineData(queue, { now: NOW });
const SENTENCE = 'Step 2 (Beta) done about 1 h later; A-2 starts first in step 1 (Alpha).';
const $ = (id: string) => document.getElementById(id) as HTMLElement;
const stateWith = () => ({
  version: `v${Math.random()}`,
  data: {
    ...T.board(queue),
    gitError: null,
    logo: false,
    features: KK.features(KK.STANDARD),
    boardSwitches: KK.boardSwitches(KK.STANDARD, null),
    boardTimeline: { on: true, horizonDays: 3, rows: 'step', drag: true, dragPreview: true, ...timeline },
  },
});
const answerFor = (p: string, body: any) => {
  if (p === '/api/bulk' && body.dry)
    return { ok: true, dry: true, changed: 'V1', lines: ['A-2 priority_bonus: (none) → 2'], warnings: [], error: [], guard: [], can: true, plan: { sentence: SENTENCE, parts: [] } };
  if (p === '/api/bulk') return { ok: true, message: '1', log: 41 };
  if (p === '/api/focus' && body.dry)
    return { ok: true, dry: true, changed: 'V2', before_text: 'a, b', after_text: 'b, a', lines: [], warnings: [], error: [], can: true, plan: { sentence: 'Step 1 (Beta) done about 2 h earlier; B-1 starts first.', parts: [] } };
  if (p === '/api/focus') return { ok: true, message: 'Focus saved', info: [], log: 42 };
  if (p === '/api/undo') return { ok: true, message: 'Undone' };
  return { ok: false, message: 'not in this test' };
};
const refetch = async () => {
  window.dispatchEvent(new Event('focus'));
  await flush();
};
const key = (target: Element, k: string) => {
  target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
};
const bar = (id: string) => document.querySelector(`.tl-bar[data-id="${id}"]`) as HTMLElement;
const live = () => $('tl-live').textContent ?? '';
const dialog = () => document.getElementById('tl-drop') as HTMLElement | null;
const button = (root: ParentNode, text: string) =>
  [...root.querySelectorAll('button')].find((b) => b.textContent === text) as HTMLButtonElement;

beforeAll(async () => {
  state = stateWith();
  const html = readFileSync(join(CLIENT, 'index.html'), 'utf8');
  document.documentElement.innerHTML = html.replace(/<!doctype[^>]*>/i, '').replace(/<\/?html[^>]*>/g, '');
  sessionStorage.setItem('queue-board-key', 'testKey');
  localStorage.clear();
  localStorage.setItem('queue-board-view', 'timeline');
  const w = window as any;
  w.CSS = { escape: (s: string) => String(s).replace(/["\\]/g, '\\$&') };
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.setInterval = () => 0;
  w.fetch = async (p: string, init?: { method?: string; body?: string }) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    if (init?.method === 'POST') posts.push({ path: p, body });
    return {
      ok: true,
      status: 200,
      json: async () =>
        p.startsWith('/api/state')
          ? p.includes(`version=${state.version}`)
            ? { version: state.version, unchanged: true }
            : state
          : p.startsWith('/api/schedule')
            ? { ok: true, version: `sched-${state.version}`, data: { enabled: true, ...payload } }
            : init?.method === 'POST'
              ? answerFor(p, body)
              : { ok: false, message: 'not in this test' },
    };
  };
  for (const f of ['a11y.js', '../lib/queueGraph.js', 'graph.js', 'plan.js', 'performance.js', '../lib/queueDecisions.js', '../lib/timelineLayout.js', '../lib/timelineDrag.js', 'board/'])
    (0, eval)(clientSource(f));
  await flush();
  $('show-timeline').click();
  await flush();
}, 60_000);

beforeEach(async () => {
  posts.length = 0;
  if (dialog() && !(dialog()!.closest('.guard-background') as HTMLElement).hidden) button(dialog()!, 'Cancel')?.click();
  await flush();
});

describe('a planned bar with the keyboard', () => {
  it('the first in its step is A-1, then A-2 (the order the bars start in)', () => {
    expect(bar('A-1')).toBeTruthy();
    expect(bar('A-2')).toBeTruthy();
    expect(bar('A-1').dataset.movable).toBe('true');
  });

  it('Space lifts and says the place; ArrowDown moves it; Escape cancels and posts nothing', async () => {
    key(bar('A-1'), ' ');
    expect(live()).toBe('A-1 lifted: place 1 of 2 in step 1 (Alpha), where it is now. Up and down move, Enter drops, Escape cancels.');
    expect(bar('A-1').classList.contains('lifted')).toBe(true);
    key(bar('A-1'), 'ArrowDown');
    expect(live()).toBe('A-1: place 2 of 2 in step 1 (Alpha), right below A-2.');
    key(bar('A-1'), 'ArrowDown');
    expect(live()).toMatch(/last place in step 1/);
    key(bar('A-1'), 'Escape');
    expect(live()).toBe('Move cancelled: A-1 stays where it was.');
    await flush();
    expect(posts).toEqual([]);
    expect(dialog() == null || (dialog()!.closest('.guard-background') as HTMLElement).hidden).toBe(true);
  });

  it('left or right while lifted: the sideways refusal, the bar stays lifted', () => {
    key(bar('A-2'), ' ');
    key(bar('A-2'), 'ArrowRight');
    expect(live()).toMatch(/time is calculated/i);
    expect(bar('A-2').classList.contains('lifted')).toBe(true);
    key(bar('A-2'), 'Escape');
  });

  it('Enter drops: the preview with the plan sentence, then Save writes with the preview version and offers Undo', async () => {
    key(bar('A-2'), ' ');
    key(bar('A-2'), 'ArrowUp');
    key(bar('A-2'), 'Enter');
    await flush();
    expect(posts[0]).toEqual({
      path: '/api/bulk',
      body: { action: 'rank', ids: ['A-2'], val: { space: 'over', ref: 'A-1' }, dry: true, plan_effect: true },
    });
    const d = dialog()!;
    expect((d.closest('.guard-background') as HTMLElement).hidden).toBe(false);
    expect(d.querySelector('.tl-plan-sentence')?.textContent).toBe(SENTENCE);
    // T-C 0a: the plan sentence comes first (right after the title), then the move in words; the raw field lines
    // ("A-2 priority_bonus: ...") are only behind a closed Details.
    expect(d.querySelector('h2 + p')?.className).toBe('tl-plan-sentence');
    expect(d.querySelector('.tl-plan-sentence + p')?.textContent).toBe('A-2: place 1 of 2 in step 1 (Alpha), right above A-1.');
    const details = d.querySelector('details.tl-drop-details') as HTMLDetailsElement;
    expect(details).toBeTruthy();
    expect(details.open).toBe(false);
    expect(details.querySelector('summary')?.textContent).toBe('Details');
    expect(details.textContent).toContain('priority_bonus');
    const outside = [...d.children].filter((c) => c !== details).map((c) => c.textContent).join(' ');
    expect(outside).not.toContain('priority_bonus');
    // A part the dry run does not have (the focus line for a rank) is left out, never written as "null".
    expect(d.textContent).not.toContain('null');
    button(d, 'Save order').click();
    await flush();
    expect(posts[1]).toEqual({ path: '/api/bulk', body: { action: 'rank', ids: ['A-2'], val: { space: 'over', ref: 'A-1' }, expect: 'V1' } });
    expect($('undo-message').hidden).toBe(false);
    const undo = button($('undo-message'), 'Undo');
    expect(undo).toBeTruthy();
    undo.click();
    await flush();
    expect(posts.find((p) => p.path === '/api/undo')?.body).toEqual({ nr: 41 });
  });

  it('Cancel in the preview saves nothing', async () => {
    key(bar('A-2'), ' ');
    key(bar('A-2'), 'ArrowUp');
    key(bar('A-2'), 'Enter');
    await flush();
    button(dialog()!, 'Cancel').click();
    await flush();
    expect(posts.map((p) => p.body.dry)).toEqual([true]);
  });
});

describe('a step row with the keyboard', () => {
  it('Space on the step title lifts it, ArrowDown and Enter preview the new focus order (POST /api/focus dry)', async () => {
    const title = document.querySelector('.tl-title[data-stage="project:a"]') as HTMLElement;
    expect(title.getAttribute('role')).toBe('button');
    key(title, ' ');
    expect(live()).toMatch(/^Step 1 \(Alpha\) lifted: place 1 of 2/);
    key(title, 'ArrowDown');
    expect(live()).toMatch(/place 2 of 2/);
    key(title, 'Enter');
    await flush();
    expect(posts[0].path).toBe('/api/focus');
    expect(posts[0].body.dry).toBe(true);
    expect(posts[0].body.plan_effect).toBe(true);
    expect(posts[0].body.plan.order).toEqual(['project:b', 'project:a']);
    expect(dialog()!.querySelector('.tl-plan-sentence')?.textContent).toBe('Step 1 (Beta) done about 2 h earlier; B-1 starts first.');
    button(dialog()!, 'Save order').click();
    await flush();
    expect(posts[1].body.expect).toBe('V2');
    expect(posts[1].body.dry).toBeUndefined();
    expect(button($('undo-message'), 'Undo')).toBeTruthy();
  });
});

describe('the settings', () => {
  it('board.timelineDragPreview off: a drop saves at once, with Undo in the toast', async () => {
    timeline = { dragPreview: false };
    state = stateWith();
    await refetch();
    key(bar('A-2'), ' ');
    key(bar('A-2'), 'ArrowUp');
    key(bar('A-2'), 'Enter');
    await flush();
    expect(posts.map((p) => [p.path, p.body.dry === true])).toEqual([['/api/bulk', true], ['/api/bulk', false]]);
    expect(dialog() == null || (dialog()!.closest('.guard-background') as HTMLElement).hidden).toBe(true);
    expect(button($('undo-message'), 'Undo')).toBeTruthy();
  });

  it('board.timelineDrag off: nothing lifts, Space opens the card as before, no move buttons in the table', async () => {
    timeline = { drag: false };
    state = stateWith();
    await refetch();
    expect(bar('A-2').dataset.movable).toBeUndefined();
    key(bar('A-2'), ' ');
    expect($('panel').hidden).toBe(false);
    expect(posts).toEqual([]);
  });
});

describe('the table view', () => {
  it('Move up and Move down per planned task, the same preview (not mouse only)', async () => {
    timeline = {};
    state = stateWith();
    await refetch();
    const sw = [...document.querySelectorAll('.tl-switch .toggles-button')].find((b) => b.textContent === 'Table') as HTMLElement;
    sw.click();
    await flush();
    const up = document.querySelector('button[aria-label="Move A-2 up"]') as HTMLButtonElement;
    expect(up).toBeTruthy();
    expect((document.querySelector('button[aria-label="Move A-1 up"]') as HTMLButtonElement).disabled).toBe(true);
    up.click();
    await flush();
    expect(posts[0].body).toEqual({ action: 'rank', ids: ['A-2'], val: { space: 'over', ref: 'A-1' }, dry: true, plan_effect: true });
    expect(dialog()!.querySelector('.tl-plan-sentence')?.textContent).toBe(SENTENCE);
  });
});

describe('the CSS', () => {
  const css = readFileSync(join(CLIENT, 'board.css'), 'utf8');
  const part = css.slice(css.indexOf('/* ---- The Timeline tab'));
  it('the drag marks use tokens only', () => {
    expect(part).toContain('.tl-drop-line');
    expect(part).toContain('.tl-bar.lifted');
    expect(part).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });
});
