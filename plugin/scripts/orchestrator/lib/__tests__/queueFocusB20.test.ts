/**
 * @vitest-environment jsdom
 */
// =============================================================
// queueFocusB20.test.ts: one task as a focus step, and adding or removing one step (board step B20, the focus review
// of 2026-11-18, owner question 2: yes to task:<id>, the exclusion list waits).
//
// What the tests prove:
//   - parseStep reads `task:<id>` (and a bare task id) and refuses an unknown task id; a bare name that is two kinds at
//     once must be written with its type,
//   - stepMatch gives a task step specificity 4, so it wins over a feature, project or area step that also holds the
//     task, whatever the order of the steps; the step evaluation counts the task in its own step,
//   - addFocusStep and removeFocusStep change the focus list in place: append or insert at a 1-based place, a duplicate
//     is a no-op, an unknown task, a missing focus, a step not in the list and the last step are refused with a clear
//     message; each change is one changelog entry, so undo puts the list back,
//   - cleanFocus takes out a task step whose task is done, as it does for other done steps,
//   - `ravenseat focus add` and `focus remove` work against a copy of the queue (exit codes and undo), and the usage
//     text and docs name them,
//   - the board accepts `task:<id>` in POST /api/focus (the STEP regex) and in focusPreview, and the Focus tab draws a
//     task step with its id and title, and its fold shows that one task.
// The board runs in jsdom with a small synthetic queue (no network), as in queueFocusB19.test.ts.
// =============================================================
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { clientSource } from './boardClient';

/* eslint-disable @typescript-eslint/no-require-imports */
const T = require('../queueBoard.js') as {
  board: (queue: unknown, option?: unknown) => any;
  planBasis: (queue: unknown, option?: unknown) => any;
  focusPreview: (queue: unknown, input: unknown, option?: unknown) => any;
};
const L = require('../queueLogic.js') as {
  parseStep: (raw: string, queue: unknown) => { stage?: string; error?: string };
  stepMatch: (o: unknown, stage: string, queue: unknown) => number;
  ownStep: (o: unknown, queue: unknown) => number | null;
  evaluateFocusStep: (queue: unknown, now?: number) => any[];
  cleanFocus: (queue: unknown, option?: unknown) => any;
  addFocusStep: (queue: unknown, raw: string, option?: unknown) => any;
  removeFocusStep: (queue: unknown, raw: string, option?: unknown) => any;
  undoEntry: (queue: unknown, option?: unknown) => any;
  cloneJson: <X>(x: X) => X;
};
/* eslint-enable @typescript-eslint/no-require-imports */

const ORCH = join(__dirname, '..', '..');
const CLIENT = join(ORCH, 'queue-board');
const DOCS = join(ORCH, '..', '..', 'docs');
const iso = new Date(Date.now() - 86_400_000).toISOString();

function task(id: string, project: string, feature: string | null, status: string, extra: object = {}) {
  return {
    id,
    title: `Task ${id}`,
    project,
    ...(feature ? { feature } : {}),
    domain: `${project}-${id}`,
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

const PROJECTS = {
  ui: { title: 'Habit screens', prefixes: ['UI-'] },
  billing: { title: 'Subscriptions', prefixes: ['BILL-'] },
  misc: { title: 'Odds and ends', prefixes: ['MISC-'] },
};

/** Step 1 is the Today feature, step 2 billing; MISC-1 and MISC-2 sit outside the focus. */
function makeQueue(order: string[] | null = ['feature:ui/Today', 'project:billing']): any {
  return {
    created: iso,
    limits: { maxConcurrent: 5, maxDPlus: 2, maxPerDomain: 5, maxDb: 2 },
    tasks: [
      task('UI-3', 'ui', 'Today', 'waiting'),
      task('UI-4', 'ui', 'Today', 'waiting'),
      task('BILL-1', 'billing', null, 'waiting'),
      task('MISC-1', 'misc', null, 'waiting'),
      task('MISC-2', 'misc', null, 'done'),
    ],
    projects: PROJECTS,
    areas: {},
    changelog: [],
    ...(order ? { focus: { from: iso, rest: 'wait', order, drag_with_dependencies: true } } : {}),
  };
}
const byId = (queue: any, id: string) => queue.tasks.find((o: any) => o.id === id);

describe('parseStep and stepMatch: task:<id>', () => {
  it('reads task:<id> and a bare task id, and refuses an unknown task id', () => {
    const queue = makeQueue();
    expect(L.parseStep('task:MISC-1', queue)).toEqual({ stage: 'task:MISC-1' });
    expect(L.parseStep('MISC-1', queue)).toEqual({ stage: 'task:MISC-1' });
    expect(L.parseStep('task:NOPE-9', queue).error).toMatch(/unknown task NOPE-9/);
    expect(L.parseStep('task:', queue).error).toMatch(/task:<id>/);
    // The error for an unknown type names the new type.
    expect(L.parseStep('bogus:x', queue).error).toMatch(/task:/);
  });

  it('a bare name that is both a project and a task id must be written with its type', () => {
    const queue = makeQueue();
    queue.tasks.push(task('misc', 'misc', null, 'waiting'));
    expect(L.parseStep('misc', queue).error).toMatch(/project:misc.*task:misc|task:misc.*project:misc/);
    expect(L.parseStep('task:misc', queue)).toEqual({ stage: 'task:misc' });
  });

  it('a task step has specificity 4 and wins over the feature step that also holds the task', () => {
    const queue = makeQueue(['feature:ui/Today', 'task:UI-4']);
    const ui4 = byId(queue, 'UI-4');
    expect(L.stepMatch(ui4, 'task:UI-4', queue)).toBe(4);
    expect(L.stepMatch(ui4, 'feature:ui/Today', queue)).toBe(3);
    expect(L.stepMatch(byId(queue, 'UI-3'), 'task:UI-4', queue)).toBe(0);
    expect(L.ownStep(ui4, queue)).toBe(1);
    expect(L.ownStep(byId(queue, 'UI-3'), queue)).toBe(0);
  });

  it('the step evaluation counts the task in its own step', () => {
    const queue = makeQueue(['task:MISC-1', 'project:billing']);
    const ev = L.evaluateFocusStep(queue);
    expect(ev[0]).toMatchObject({ stage: 'task:MISC-1', open: 1, ready: 1, status: 'active' });
    expect(ev[0].title).toMatch(/MISC-1/);
  });
});

describe('addFocusStep and removeFocusStep', () => {
  it('appends by default, inserts at a 1-based place, and one undo puts the list back', () => {
    const queue = makeQueue();
    const r = L.addFocusStep(queue, 'MISC-1', { by: 'owner' });
    expect(r.error).toEqual([]);
    expect(r.stage).toBe('task:MISC-1');
    expect(queue.focus.order).toEqual(['feature:ui/Today', 'project:billing', 'task:MISC-1']);
    expect(r.entry).toBeTruthy();
    const r2 = L.addFocusStep(queue, 'task:UI-4', { at: 1, by: 'owner' });
    expect(r2.error).toEqual([]);
    expect(queue.focus.order[0]).toBe('task:UI-4');
    expect(L.undoEntry(queue, { by: 'owner' }).error).toEqual([]);
    expect(queue.focus.order).toEqual(['feature:ui/Today', 'project:billing', 'task:MISC-1']);
    expect(L.undoEntry(queue, { by: 'owner' }).error).toEqual([]);
    expect(queue.focus.order).toEqual(['feature:ui/Today', 'project:billing']);
  });

  it('a duplicate is a no-op with a message; an unknown task, a bad --at and a missing focus are refused', () => {
    const queue = makeQueue();
    const before = L.cloneJson(queue);
    const d = L.addFocusStep(queue, 'project:billing', { by: 'owner' });
    expect(d.error).toEqual([]);
    expect(d.noop).toBe(true);
    expect(d.message).toMatch(/already/);
    expect(queue).toEqual(before);
    expect(L.addFocusStep(queue, 'NOPE-9').error.join(' ')).toMatch(/unknown/);
    expect(L.addFocusStep(queue, 'MISC-1', { at: 0 }).error.join(' ')).toMatch(/--at/);
    expect(L.addFocusStep(queue, 'MISC-1', { at: 4 }).error.join(' ')).toMatch(/--at/);
    expect(queue).toEqual(before);
    const none = makeQueue(null);
    expect(L.addFocusStep(none, 'MISC-1').error.join(' ')).toMatch(/no focus.*focus set/i);
    expect(none.focus).toBeUndefined();
  });

  it('removes a step (bare task id too), refuses a step not in the list and the last step, and undo restores', () => {
    const queue = makeQueue(['feature:ui/Today', 'task:MISC-1', 'project:billing']);
    const r = L.removeFocusStep(queue, 'MISC-1', { by: 'owner' });
    expect(r.error).toEqual([]);
    expect(r.stage).toBe('task:MISC-1');
    expect(queue.focus.order).toEqual(['feature:ui/Today', 'project:billing']);
    expect(queue.focus.history.at(-1)).toMatchObject({ action: 'removed', stage: 'task:MISC-1', by: 'owner' });
    expect(L.removeFocusStep(queue, 'task:MISC-1').error.join(' ')).toMatch(/not in the focus/);
    expect(L.removeFocusStep(queue, 'project:billing').error).toEqual([]);
    expect(L.removeFocusStep(queue, 'feature:ui/Today').error.join(' ')).toMatch(/last step.*focus off/);
    expect(L.undoEntry(queue, { by: 'owner' }).error).toEqual([]);
    expect(L.undoEntry(queue, { by: 'owner' }).error).toEqual([]);
    expect(queue.focus.order).toEqual(['feature:ui/Today', 'task:MISC-1', 'project:billing']);
  });

  it('a task step whose task was removed from the queue can still be removed by its saved form', () => {
    const queue = makeQueue(['feature:ui/Today', 'task:GONE-1']);
    expect(L.removeFocusStep(queue, 'task:GONE-1').error).toEqual([]);
    expect(queue.focus.order).toEqual(['feature:ui/Today']);
  });

  it('keeps now_count on the same steps when a step is added or removed in front of it', () => {
    const queue = makeQueue(['feature:ui/Today', 'project:billing']);
    queue.focus.now_count = 1;
    L.addFocusStep(queue, 'MISC-1', { at: 1 });
    expect(queue.focus.now_count).toBe(2);
    L.removeFocusStep(queue, 'MISC-1');
    expect(queue.focus.now_count).toBe(1);
  });
});

describe('cleanFocus takes out a done task step', () => {
  it('the step whose task is done leaves the focus, with history', () => {
    const queue = makeQueue(['task:MISC-1', 'project:billing']);
    byId(queue, 'MISC-1').status = 'done';
    byId(queue, 'MISC-1').done = iso;
    const r = L.cleanFocus(queue, { by: 'owner' });
    expect(r.taken_out.map((x: any) => x.stage)).toEqual(['task:MISC-1']);
    expect(queue.focus.order).toEqual(['project:billing']);
  });

  it('a task step whose task waits on QA stays as done-with-rests', () => {
    const queue = makeQueue(['task:MISC-1', 'project:billing']);
    Object.assign(byId(queue, 'MISC-1'), { status: 'done', done: iso, qa_status: 'waiting' });
    expect(L.evaluateFocusStep(queue)[0].status).toBe('done-with-rests');
    expect(L.cleanFocus(queue, { by: 'owner' }).taken_out).toEqual([]);
  });
});

describe('queue.mjs focus add / focus remove (against a copy)', () => {
  const QUEUE_MJS = join(ORCH, 'queue.mjs');
  let folder: string;
  function run(args: string[]): { code: number; out: string; error: string } {
    try {
      const out = execFileSync(process.execPath, [QUEUE_MJS, ...args], {
        env: {
          ...process.env,
          QUEUE_FOLDER: folder,
          QUEUE_GIT: folder,
          QUEUE_TIME_LOG: join(folder, 'times.jsonl'),
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { code: 0, out, error: '' };
    } catch (e) {
      const x = e as { status: number; stdout: string; stderr: string };
      return { code: x.status, out: x.stdout ?? '', error: x.stderr ?? '' };
    }
  }
  const readQueue = () => JSON.parse(readFileSync(join(folder, 'queue.json'), 'utf8'));
  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'queue-focus-b20-'));
    writeFileSync(join(folder, 'queue.json'), JSON.stringify({ ...makeQueue(), next_migr: 1000 }, null, 2));
  });
  afterEach(() => rmSync(folder, { recursive: true, force: true }));

  it('add appends or inserts with --at, a duplicate is a no-op, and undo takes it back', () => {
    const a = run(['focus', 'add', 'MISC-1', '--by', 'owner']);
    expect(a.code, a.error).toBe(0);
    expect(a.out).toMatch(/task:MISC-1/);
    expect(a.out).toMatch(/undo/);
    expect(readQueue().focus.order).toEqual(['feature:ui/Today', 'project:billing', 'task:MISC-1']);
    const b = run(['focus', 'add', 'task:UI-4', '--at', '1']);
    expect(b.code, b.error).toBe(0);
    expect(readQueue().focus.order[0]).toBe('task:UI-4');
    const dup = run(['focus', 'add', 'MISC-1']);
    expect(dup.code).toBe(0);
    expect(dup.out).toMatch(/already/);
    expect(run(['undo']).code).toBe(0);
    expect(readQueue().focus.order).toEqual(['feature:ui/Today', 'project:billing', 'task:MISC-1']);
  });

  it('add refuses an unknown task and a bad --at; remove refuses a step not in the list (exit != 0)', () => {
    const u = run(['focus', 'add', 'NOPE-9']);
    expect(u.code).not.toBe(0);
    expect(u.error).toMatch(/unknown/);
    const at = run(['focus', 'add', 'MISC-1', '--at', 'x']);
    expect(at.code).not.toBe(0);
    expect(at.error).toMatch(/--at/);
    const r = run(['focus', 'remove', 'MISC-1']);
    expect(r.code).not.toBe(0);
    expect(r.error).toMatch(/not in the focus/);
    expect(readQueue().focus.order).toEqual(['feature:ui/Today', 'project:billing']);
  });

  it('remove takes one step out, and undo puts it back', () => {
    const r = run(['focus', 'remove', 'project:billing', '--by', 'owner']);
    expect(r.code, r.error).toBe(0);
    expect(readQueue().focus.order).toEqual(['feature:ui/Today']);
    expect(run(['undo']).code).toBe(0);
    expect(readQueue().focus.order).toEqual(['feature:ui/Today', 'project:billing']);
  });

  it('the usage text and the docs name focus add and focus remove', () => {
    const u = run(['focus', 'bogus']);
    expect(u.error).toMatch(/focus add/);
    expect(u.error).toMatch(/focus remove/);
    const usage = readFileSync(QUEUE_MJS, 'utf8');
    expect(usage).toMatch(/queue\.mjs focus add <step\|id> \[--at <n>\]/);
    expect(usage).toMatch(/queue\.mjs focus remove <step\|id>/);
    const docs = readFileSync(join(DOCS, 'queue.md'), 'utf8');
    expect(docs).toMatch(/focus add <step\\?\|id> \[--at <n>\]/);
    expect(docs).toMatch(/task:<id>/);
  });
});

describe('the board accepts task steps', () => {
  it('the STEP regex of POST /api/focus takes task:<id>', () => {
    const src = readFileSync(join(ORCH, 'queue-board.mjs'), 'utf8');
    const m = src.match(/const STEP =\s*\n?\s*(\/.*\/);/);
    expect(m).toBeTruthy();
    const STEP = (0, eval)(m![1]) as RegExp;
    expect(STEP.test('task:MISC-1')).toBe(true);
    expect(STEP.test('task:ui.2_b')).toBe(true);
    expect(STEP.test('task:')).toBe(false);
    expect(STEP.test('task:a b')).toBe(false);
    expect(STEP.test('project:billing')).toBe(true);
  });

  it('focusPreview names a task step with its id and type', () => {
    const f = T.focusPreview(makeQueue(), { order: ['task:MISC-1', 'project:billing'] });
    expect(f.error).toEqual([]);
    expect(f.lines[0]).toMatch(/step 1: .*MISC-1.*\(task\)/);
    expect(T.focusPreview(makeQueue(), { order: ['task:NOPE-9'] }).error.join(' ')).toMatch(/unknown task/);
  });

  it('planBasis gives a task step its one task and its info', () => {
    const p = T.planBasis(makeQueue(['task:MISC-1', 'project:billing']));
    expect(p.step_tasks['task:MISC-1']).toEqual([{ id: 'MISC-1', title: 'Task MISC-1', state: 'ready' }]);
    expect(p.task_steps['task:MISC-1']).toMatchObject({ id: 'MISC-1', title: 'Task MISC-1', exists: true });
    expect(p.task_steps['task:MISC-1'].waiting).toBe(1);
  });
});

describe('the Focus tab draws a task step', () => {
  const queue = makeQueue(['task:MISC-1', 'project:billing']);
  const state = { version: 'v1', data: { ...T.board(queue), gitError: null, logo: false } };
  const flush = async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  };
  const row = (key: string) =>
    document.querySelector(`.plan-list > .plan-element[data-key="${key}"]`) as HTMLElement;

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
    (document.getElementById('show-plan') as HTMLElement).click();
    await flush();
  }, 60_000);

  it('shows a Task badge, the id and the title, never "does not exist"', () => {
    const r = row('task:MISC-1');
    expect(r).toBeTruthy();
    expect(r.closest('.plan-list')?.getAttribute('data-col')).toBe('focus');
    const header = (r.querySelector('.plan-header')?.textContent ?? '').replace(/\s+/g, ' ');
    expect(header).toMatch(/T1/);
    expect(header).toMatch(/Task/);
    expect(header).toMatch(/MISC-1/);
    expect(header).toMatch(/Task MISC-1/);
    expect(header).not.toMatch(/does not exist/);
  });

  it('its fold shows that one task', async () => {
    const button = row('task:MISC-1').querySelector('button.plan-tasks-toggle') as HTMLButtonElement;
    expect(button.textContent).toMatch(/Tasks \(1\)/);
    button.click();
    await flush();
    const open = row('task:MISC-1').querySelector('button.plan-tasks-toggle') as HTMLButtonElement;
    const region = document.getElementById(open.getAttribute('aria-controls') ?? '') as HTMLElement;
    const items = [...region.querySelectorAll('li')].map((li) => (li.textContent ?? '').replace(/\s+/g, ' ').trim());
    expect(items).toEqual(['MISC-1 Task MISC-1 ready']);
  });
});
