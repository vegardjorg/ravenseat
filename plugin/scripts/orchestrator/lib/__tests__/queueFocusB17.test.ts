/**
 * @vitest-environment jsdom
 */
// =============================================================
// queueFocusB17.test.ts: fixes and small bugs in the Focus feature (board step B17, the focus review of 2026-11-18).
//
// What the tests prove:
//   - H4: a focus step that points to a feature with no pending tasks (all done, or only rests such as QA) is still in
//     the plan basis and on the Focus tab, marked "done", never "does not exist". A feature no task has ever had
//     still says "does not exist",
//   - the "Set focus" / "Edit focus" button in the focus line is hidden on the Focus tab itself (where the focus is
//     edited) and shown on the other tabs,
//   - the Now column has no fixed tone of its own: no rule for .plan-now sets a background or a text color, so Now
//     looks like the other columns and never like an active drop zone,
//   - one word for a focus step on the board: "step", never "stage", in the Focus UI texts, the server texts the board
//     shows (preview, notices, warnings), the settings and the docs,
//   - a project step in the focus line shows the project id like the cards do (the title in the tooltip), and a
//     feature step shows "pid › name".
// The whole board runs in jsdom with a small synthetic queue (no network), as in queueBoardFeatures.test.ts.
// =============================================================
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { clientSource } from './boardClient';

/* eslint-disable @typescript-eslint/no-require-imports */
const T = require('../queueBoard.js') as {
  board: (queue: unknown, option?: unknown) => any;
  planBasis: (queue: unknown, option?: unknown) => any;
  focusPreview: (queue: unknown, input: unknown, option?: unknown) => any;
};
const L = require('../queueLogic.js') as {
  setFocus: (queue: unknown, input: unknown, now?: string) => { error: string[]; warnings: string[] };
  focusStatus: (queue: unknown, option?: unknown) => any;
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

/** Theme is done with QA still waiting (done with rests), Polish is done outright, Ghost never had a task. */
function makeQueue() {
  return {
    created: iso,
    limits: { maxConcurrent: 5, maxDPlus: 2, maxPerDomain: 5, maxDb: 2 },
    tasks: [
      task('UI-1', 'ui', 'Theme', 'done', { qa_status: 'waiting' }),
      task('UI-2', 'ui', 'Polish', 'done'),
      task('UI-3', 'ui', 'Today', 'waiting'),
      task('BILL-1', 'billing', 'Plans', 'waiting'),
    ],
    projects: {
      ui: { title: 'Habit screens', prefixes: ['UI-'] },
      billing: { title: 'Subscriptions', prefixes: ['BILL-'] },
    },
    areas: {},
    question: [],
    resolutions: [],
    changelog: [],
    focus: {
      order: ['feature:ui/Theme', 'feature:ui/Polish', 'feature:ui/Ghost', 'feature:ui/Today', 'project:billing'],
      rest: 'wait',
      from: iso,
      now_count: 1,
    },
  };
}

const queue = makeQueue();
const state = { version: 'v1', data: { ...T.board(queue), gitError: null, logo: false } };

const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};
const $ = (id: string) => document.getElementById(id) as HTMLElement;
const focusLineButtons = () =>
  [...document.querySelectorAll('.focusLine button')].map((b) => (b.textContent ?? '').trim());

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
  w.fetch = async (filePath: string) => ({
    ok: true,
    status: 200,
    json: async () =>
      filePath.startsWith('/api/state')
        ? filePath.includes(`version=${state.version}`)
          ? { version: state.version, unchanged: true }
          : state
        : {},
  });
  for (const f of ['a11y.js', '../lib/queueGraph.js', 'graph.js', 'plan.js', 'performance.js', 'board/'])
    (0, eval)(clientSource(f));
  await flush();
  $('show-flat').click();
  await flush();
}, 60_000);

describe('H4: a done feature step is "done", not "does not exist"', () => {
  it('planBasis lists a feature from a focus step even with no pending tasks, with the step status', () => {
    const p = T.planBasis(queue);
    const ui = p.projects.find((x: any) => x.pid === 'ui');
    const names = ui.features.map((f: any) => f.name);
    expect(names).toEqual(expect.arrayContaining(['Theme', 'Polish', 'Today']));
    // A feature no task has ever had is not invented.
    expect(names).not.toContain('Ghost');
    const theme = ui.features.find((f: any) => f.name === 'Theme');
    expect(theme).toMatchObject({ stage: 'feature:ui/Theme', waiting: 0, readyOnes: 0 });
    expect(p.step_status['feature:ui/Theme']).toBe('done-with-rests');
    expect(p.step_status['feature:ui/Polish']).toBe('done');
    expect(p.step_status['feature:ui/Today']).toBe('active');
    expect(p.step_status['project:billing']).toBe('active');
  });

  it('without a focus there is no step status and no extra feature', () => {
    const q = { ...makeQueue(), focus: undefined };
    const p = T.planBasis(q);
    expect(p.step_status).toEqual({});
    expect(p.projects.find((x: any) => x.pid === 'ui').features.map((f: any) => f.name)).toEqual(['Today']);
  });

  it('the Focus tab marks the done steps "done" and keeps "does not exist" for the missing one', async () => {
    $('show-plan').click();
    await flush();
    const el = (key: string) => document.querySelector(`.plan-element[data-key="${key}"]`) as HTMLElement;
    for (const key of ['feature:ui/Theme', 'feature:ui/Polish']) {
      expect(el(key), key).toBeTruthy();
      const badges = [...el(key).querySelectorAll('.plan-header .badge')].map((b) => b.textContent);
      expect(badges, key).toContain('done');
      expect(badges, key).not.toContain('does not exist');
    }
    const ghost = [...el('feature:ui/Ghost').querySelectorAll('.plan-header .badge')].map((b) => b.textContent);
    expect(ghost).toContain('does not exist');
    const today = [...el('feature:ui/Today').querySelectorAll('.plan-header .badge')].map((b) => b.textContent);
    expect(today).not.toContain('done');
    $('show-flat').click();
    await flush();
  });
});

describe('the focus line button is hidden on the Focus tab', () => {
  it('shows "Edit focus" on Flat and hides it on the Focus tab', async () => {
    expect(focusLineButtons()).toContain('Edit focus');
    $('show-plan').click();
    await flush();
    expect(focusLineButtons()).not.toContain('Edit focus');
    expect(focusLineButtons()).not.toContain('Set focus');
    $('show-lanes').click();
    await flush();
    expect(focusLineButtons()).toContain('Edit focus');
    $('show-flat').click();
    await flush();
  });
});

describe('the Now column has no fixed tone', () => {
  it('no rule for .plan-now sets a background or a text color', () => {
    const css = readFileSync(join(CLIENT, 'board.css'), 'utf8');
    const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter((m) => /\.plan-now\b/.test(m[1]));
    for (const m of rules) expect(m[2], m[1].trim()).not.toMatch(/(^|;|\s)(background|color)\s*:/);
  });
});

describe('a project step in the focus line reads like the cards', () => {
  it('shows the project id (title in the tooltip) and "pid › name" for a feature', () => {
    const steps = [...document.querySelectorAll('.focusLine .focus-step')] as HTMLElement[];
    const billing = steps.find((s) => /billing/.test(s.textContent ?? ''));
    expect(billing).toBeTruthy();
    expect(billing!.textContent).toMatch(/^\d+ billing$/);
    expect(billing!.title).toContain('Subscriptions');
    const today = steps.find((s) => /Today/.test(s.textContent ?? ''));
    expect(today!.textContent).toMatch(/^\d+ ui › Today$/);
    // The cards show the same id.
    const chip = document.querySelector('.summary[data-id="BILL-1"] .summary-project') as HTMLElement;
    expect(chip.textContent).toBe('billing');
    expect(chip.title).toBe('Subscriptions');
  });
});

describe('one word on the board: step, never stage', () => {
  // A quoted text (single, double or backtick) with the word stage or stages in it, outside comments. What sits in
  // ${...} is code (the data field `stage` keeps its name), and the grouping key 'stage' alone is data (a value in
  // GROUPINGS), not a text the owner reads.
  const QUOTED = /(['"`])(?:(?!\1)[^\n\\]|\\.)*\1/g;
  const texts = (file: string) =>
    readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .flatMap((l) => [...l.matchAll(QUOTED)].map((m) => m[0]))
      .filter((s) => !/^['"`]stage['"`]$/.test(s))
      .filter((s) => /(?<![.\w$?])stages?\b(?!\s*:)/i.test(s.replace(/\$\{[^}]*\}/g, '')));

  it('the Focus UI, its help and the server texts the board shows say "step"', () => {
    const files = [
      join(CLIENT, 'plan.js'),
      join(CLIENT, 'board', 'views.js'),
      join(CLIENT, 'board', 'panel.js'),
      join(CLIENT, 'board', 'decide.js'),
      join(CLIENT, 'board', 'menus.js'),
      join(ORCH, 'lib', 'queueBoard.js'),
      join(ORCH, 'lib', 'queueDecisions.js'),
      join(ORCH, 'lib', 'queuePlanView.js'),
      join(ORCH, 'lib', 'settingsRegistry.js'),
      join(ORCH, 'lib', 'logic', 'focus.js'),
      join(ORCH, 'lib', 'logic', 'ranking.js'),
      join(ORCH, 'lib', 'logic', 'edit.js'),
      join(ORCH, 'lib', 'logic', 'explain.js'),
      join(ORCH, 'cli', 'projects.mjs'),
      join(ORCH, 'queue-board.mjs'),
    ];
    const found = files.flatMap((f) => texts(f).map((s) => `${f.slice(ORCH.length)}: ${s.slice(0, 90)}`));
    expect(found).toEqual([]);
  });

  it('the preview and the warnings say "step"', () => {
    const q = makeQueue();
    const f = T.focusPreview(q, { order: ['feature:ui/Today', 'project:billing'], now_count: 1 });
    expect(f.error).toEqual([]);
    expect(f.lines.join('\n')).toMatch(/^Now, step 1: /m);
    expect(f.lines.join('\n')).not.toMatch(/\bstages?\b/i);
    const w = L.setFocus(makeQueue(), { order: ['feature:ui/Ghost'] }, new Date().toISOString());
    expect(w.warnings.join(' ')).toMatch(/step 1 \(feature:ui\/Ghost\) has no open tasks/);
  });

  it('the docs say "step" for a focus step', () => {
    for (const f of ['board.md', 'queue.md', 'full-mode.md']) {
      const text = readFileSync(join(DOCS, f), 'utf8');
      const hits = text.split('\n').filter((l) => /\bstages?\b/i.test(l));
      expect(hits, f).toEqual([]);
    }
  });
});
