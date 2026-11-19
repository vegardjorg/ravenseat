/**
 * @vitest-environment jsdom
 */
// =============================================================
// queueFocusB18.test.ts: "How focus works" and "What happens now" (board step B18, the focus review of 2026-11-18).
//
// What the tests prove:
//   - the server builds one plain text `focusNow` (lib/queueBoard.js) from focusStatus and evaluateFocusStep for each
//     state: no focus, a step going first, nothing ready (waits on an owner question), standing still on rests (QA on a
//     done task), and a focus that has ended (queue paused with the owner question, paused without it, continuing).
//     The text names no CLI command; each state carries the board actions that settle it, and a CLI command only where
//     the board has no action,
//   - the Focus tab has a collapsible "How focus works" box (h3, a button with aria-expanded and aria-controls, a
//     region named by it) whose text follows the focus's own values (rest wait or fill, pause or continue), and the
//     choice to close it is remembered in the browser,
//   - the Focus tab and the red band on Flat show the same "What happens now" line with buttons; the band has no CLI
//     text about the focus any more, and its buttons open the card in Decisions or open the Focus tab,
//   - `ravenseat qa ok` also cleans the focus, so the owner question about a finished focus comes right away,
//   - in Decisions, the answer "Set a new focus" opens the Focus tab.
// The board runs in jsdom with small synthetic queues (no network), as in queueFocusB17.test.ts.
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
  focusNow: (queue: unknown, option?: unknown) => any;
};
const L = require('../queueLogic.js') as {
  syncFocusEnd: (queue: unknown, option?: unknown) => any;
  focusEndQuestionId: (focus: unknown) => string;
};
/* eslint-enable @typescript-eslint/no-require-imports */

const ORCH = join(__dirname, '..', '..');
const CLIENT = join(ORCH, 'queue-board');
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

/** A queue around a focus: `tasks` and `focus` vary per state. */
function makeQueue(tasks: object[], focus: object | null, extra: object = {}) {
  return {
    created: iso,
    limits: { maxConcurrent: 5, maxDPlus: 2, maxPerDomain: 5, maxDb: 2 },
    tasks,
    projects: PROJECTS,
    areas: {},
    changelog: [],
    ...(focus ? { focus: { from: iso, rest: 'wait', ...focus } } : {}),
    ...extra,
  };
}

/** Step 1 (ui › Today) has a ready task, step 2 is billing, and one task sits outside the focus. */
const activeQueue = () =>
  makeQueue(
    [
      task('UI-3', 'ui', 'Today', 'waiting'),
      task('UI-4', 'ui', 'Today', 'waiting'),
      task('BILL-1', 'billing', null, 'waiting'),
      task('MISC-1', 'misc', null, 'waiting'),
    ],
    { name: 'Today first', order: ['feature:ui/Today', 'project:billing'] },
  );

/** Today is done except for QA on UI-1: the focus stands still on a rest; MISC-1 is outside and waits. */
const stuckQueue = () =>
  makeQueue(
    [
      task('UI-1', 'ui', 'Today', 'done', { qa_status: 'waiting', label: ['visual'] }),
      task('MISC-1', 'misc', null, 'waiting'),
    ],
    { name: 'Today first', order: ['feature:ui/Today'] },
  );

/** The one task in focus waits on the owner question SP-1 and something else, so nothing in focus is ready. */
const blockedQueue = () =>
  makeQueue(
    [
      task('UI-5', 'ui', 'Today', 'waiting', { waiting_on: ['SP-1'], depends_on: ['UI-6'] }),
      task('UI-6', 'ui', 'Today', 'running', { started: iso }),
      task('MISC-1', 'misc', null, 'waiting'),
    ],
    { order: ['feature:ui/Today'] },
    { question: { 'SP-1': { type: 'question', text: 'Which streak rule?' } } },
  );

/** Every step is done: with continueWhenEmpty off (the default) the queue is paused. */
const endedQueue = (focus: object = {}) =>
  makeQueue(
    [task('UI-1', 'ui', 'Today', 'done'), task('MISC-1', 'misc', null, 'waiting')],
    { name: 'Today first', order: ['feature:ui/Today'], ...focus },
  );

const NO_CLI = /ravenseat|queue\.config|--choice/;

describe('focusNow: the server text per state', () => {
  it('no focus: one plain sentence, no actions', () => {
    const n = T.focusNow(makeQueue([task('MISC-1', 'misc', null, 'waiting')], null));
    expect(n.state).toBe('none');
    expect(n.text).toMatch(/^No focus/);
    expect(n.actions).toEqual([]);
    expect(n.cli).toBeNull();
  });

  it('active: which step goes first, what waits outside and what is left', () => {
    const n = T.focusNow(activeQueue());
    expect(n.state).toBe('active');
    expect(n.text).toMatch(/Step 1 ui › Today goes first: 2 ready to start\./);
    expect(n.text).toMatch(/1 task outside the focus waits\./);
    expect(n.text).toMatch(/Left: 3 tasks in 2 steps/);
    expect(n.text).not.toMatch(NO_CLI);
    expect(n.actions).toEqual([]);
    // With rest fill the outside task fills free slots instead.
    const q = activeQueue();
    (q as any).focus.rest = 'fill';
    expect(T.focusNow(q).text).toMatch(/1 task outside the focus fills free slots/);
  });

  it('nothing ready: names the owner question and gives a button to answer it', () => {
    const n = T.focusNow(blockedQueue());
    expect(n.state).toBe('waiting');
    expect(n.text).toMatch(/Nothing new in the focus can start/);
    expect(n.text).toMatch(/1 in progress/);
    expect(n.text).toMatch(/SP-1/);
    expect(n.text).toMatch(/free slots stay empty/);
    expect(n.text).not.toMatch(NO_CLI);
    expect(n.actions).toEqual([{ type: 'decide', key: 'decide:SP-1', label: 'Answer SP-1' }]);
  });

  it('standing still on a rest: says why nothing starts and opens the QA card', () => {
    const n = T.focusNow(stuckQueue());
    expect(n.state).toBe('stuck');
    expect(n.text).toMatch(/The queue is standing still/);
    expect(n.text).toMatch(/step 1 ui › Today waits only on you: QA on UI-1/);
    expect(n.text).toMatch(/free slots stay empty/);
    expect(n.text).not.toMatch(NO_CLI);
    expect(n.actions).toEqual([{ type: 'decide', key: 'check:UI-1', label: 'QA UI-1' }]);
    expect(n.cli).toBeNull();
  });

  it('ended and paused with the owner question: continue or set a new focus, as buttons', () => {
    const q = endedQueue();
    L.syncFocusEnd(q, { now: new Date().toISOString() });
    const id = L.focusEndQuestionId((q as any).focus);
    const n = T.focusNow(q);
    expect(n.state).toBe('ended-paused');
    expect(n.text).toMatch(/Focus "Today first" is done\. The queue is paused: nothing starts until you choose\./);
    expect(n.text).not.toMatch(NO_CLI);
    expect(n.actions).toEqual([
      { type: 'resolve', sp: id, choice: 2, label: 'Continue the regular queue' },
      { type: 'focus-tab', label: 'Set a new focus' },
    ]);
    expect(n.cli).toBeNull();
  });

  it('ended and paused without an open question: the CLI chip only for what the board cannot do', () => {
    const n = T.focusNow(endedQueue());
    expect(n.state).toBe('ended-paused');
    expect(n.actions).toEqual([{ type: 'focus-tab', label: 'Set a new focus' }]);
    expect(n.cli).toBe('ravenseat focus off');
    expect(n.text).not.toMatch(NO_CLI);
  });

  it('ended and continuing: the regular queue goes on, and a new focus is one click away', () => {
    const n = T.focusNow(endedQueue({ continue_when_empty: true }));
    expect(n.state).toBe('ended-continuing');
    expect(n.text).toMatch(/The queue goes on with the rest by priority\./);
    expect(n.actions).toEqual([{ type: 'focus-tab', label: 'Set a new focus' }]);
  });

  it('the board data carries focusNow, and how the focus works follows its own values', () => {
    const d = T.board(stuckQueue());
    expect(d.focusNow.state).toBe('stuck');
    expect(d.focusNow.how).toEqual({ rest: 'wait', drag_with: true, continues: false });
    const fill = T.board(endedQueue({ rest: 'fill', continue_when_empty: true }));
    expect(fill.focusNow.how).toMatchObject({ rest: 'fill', continues: true });
  });
});

// ---- The board in jsdom ----

const state: { version: string; data: any } = { version: 'v1', data: null };
const posts: { path: string; body: any }[] = [];
const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};
const $ = (id: string) => document.getElementById(id) as HTMLElement;
async function show(queue: object, version: string) {
  state.data = { ...T.board(queue), gitError: null, logo: false };
  state.version = version;
  window.dispatchEvent(new Event('focus'));
  await flush();
}
const buttonsIn = (root: Element | null) =>
  [...(root?.querySelectorAll('button') ?? [])].map((b) => (b.textContent ?? '').trim());

beforeAll(async () => {
  const html = readFileSync(join(CLIENT, 'index.html'), 'utf8');
  document.documentElement.innerHTML = html.replace(/<!doctype[^>]*>/i, '').replace(/<\/?html[^>]*>/g, '');
  sessionStorage.setItem('queue-board-key', 'testKey');
  localStorage.clear();
  state.data = { ...T.board(stuckQueue()), gitError: null, logo: false };
  const w = window as any;
  w.CSS = { escape: (s: string) => String(s).replace(/["\\]/g, '\\$&') };
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.setInterval = () => 0;
  w.fetch = async (filePath: string, init?: { body?: string }) => {
    if (init?.body && !filePath.startsWith('/api/state')) posts.push({ path: filePath, body: JSON.parse(init.body) });
    return {
      ok: true,
      status: 200,
      json: async () =>
        filePath.startsWith('/api/state')
          ? filePath.includes(`version=${state.version}`)
            ? { version: state.version, unchanged: true }
            : state
          : { ok: true, message: 'ok', info: [] },
    };
  };
  for (const f of ['a11y.js', '../lib/queueGraph.js', 'graph.js', 'plan.js', 'performance.js', '../lib/queueDecisions.js', 'board/'])
    (0, eval)(clientSource(f));
  await flush();
  $('room-queue').click();
  await flush();
  $('show-flat').click();
  await flush();
}, 60_000);

describe('the Focus tab: "How focus works" and "What happens now"', () => {
  it('the box is a heading with a real toggle and a named region, open until it is closed', async () => {
    $('show-plan').click();
    await flush();
    const box = document.querySelector('.focus-how') as HTMLElement;
    expect(box).toBeTruthy();
    const toggle = box.querySelector('h3 > button#focus-how-toggle') as HTMLButtonElement;
    expect(toggle.textContent).toContain('How focus works');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.getAttribute('aria-controls')).toBe('focus-how-body');
    const body = $('focus-how-body');
    expect(body.getAttribute('role')).toBe('region');
    expect(body.getAttribute('aria-labelledby')).toBe('focus-how-toggle');
    expect(body.hidden).toBe(false);
    // The text follows the focus: rest waits, and the queue pauses and asks when it is done.
    expect(body.textContent).toMatch(/do not start while the focus applies/);
    expect(body.textContent).toMatch(/pauses and asks you in Decisions/);
    toggle.click();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(body.hidden).toBe(true);
    expect(localStorage.getItem('queue-board-focus-how')).toBe('closed');
    // A redraw keeps it closed.
    $('show-flat').click();
    await flush();
    $('show-plan').click();
    await flush();
    expect(document.querySelector('#focus-how-toggle')?.getAttribute('aria-expanded')).toBe('false');
    (document.querySelector('#focus-how-toggle') as HTMLButtonElement).click();
    expect(localStorage.getItem('queue-board-focus-how')).toBe('open');
  });

  it('the text follows rest fill and continue when empty', async () => {
    await show(endedQueue({ rest: 'fill', continue_when_empty: true }), 'v-fill');
    const body = $('focus-how-body');
    expect(body.textContent).toMatch(/start only when the focus has nothing ready/);
    expect(body.textContent).toMatch(/goes on with the rest by priority/);
    await show(stuckQueue(), 'v-stuck');
  });

  it('"What happens now" stands on the tab with the buttons, and the band does not repeat it there', () => {
    const line = document.querySelector('.plan-view .focus-now') as HTMLElement;
    expect(line).toBeTruthy();
    expect(line.textContent).toMatch(/What happens now/);
    expect(line.textContent).toMatch(/standing still/);
    expect(buttonsIn(line)).toEqual(['QA UI-1']);
    expect(document.querySelector('.focusLine .focus-now')).toBeNull();
  });
});

describe('Flat: the red band shows "What happens now" with buttons, no CLI advice', () => {
  it('stuck on QA: the band has the line and the button, and no ravenseat text', async () => {
    $('show-flat').click();
    await flush();
    const band = $('focusLine');
    expect(band.className).toContain('notice');
    const line = band.querySelector('.focus-now') as HTMLElement;
    expect(line).toBeTruthy();
    expect(line.textContent).toMatch(/standing still/);
    expect(band.textContent).not.toMatch(NO_CLI);
    expect(buttonsIn(line)).toEqual(['QA UI-1']);
    // The button opens the QA card in Decisions.
    (line.querySelector('button') as HTMLButtonElement).click();
    await flush();
    expect($('show-decisions').getAttribute('aria-selected')).toBe('true');
    $('room-queue').click();
    await flush();
  });

  it('ended without a question: "Set a new focus" opens the Focus tab, the CLI chip only for focus off', async () => {
    await show(endedQueue(), 'v-ended');
    $('show-flat').click();
    await flush();
    const line = $('focusLine').querySelector('.focus-now') as HTMLElement;
    expect(line.textContent).toMatch(/is done\. The queue is paused/);
    expect(line.querySelector('.cli-chip code')?.textContent).toBe('ravenseat focus off');
    const set = [...line.querySelectorAll('button')].find((b) => b.textContent === 'Set a new focus')!;
    set.click();
    await flush();
    expect($('show-plan').getAttribute('aria-selected')).toBe('true');
  });

  it('ended with the question: "Continue the regular queue" answers it with choice 2', async () => {
    const q = endedQueue();
    L.syncFocusEnd(q, { now: new Date().toISOString() });
    const id = L.focusEndQuestionId((q as any).focus);
    await show(q, 'v-ended-q');
    $('room-queue').click();
    await flush();
    $('show-flat').click();
    await flush();
    const line = $('focusLine').querySelector('.focus-now') as HTMLElement;
    expect(line.querySelector('.cli-chip')).toBeNull();
    posts.length = 0;
    const go = [...line.querySelectorAll('button')].find((b) => b.textContent === 'Continue the regular queue')!;
    go.click();
    await flush();
    expect(posts).toContainEqual({ path: '/api/action', body: { type: 'resolve', sp: id, choice: 2 } });
  });
});

describe('Decisions: "Set a new focus" opens the Focus tab', () => {
  it('answering the focus-done question with "Set a new focus" lands on the Focus tab', async () => {
    const q = endedQueue();
    L.syncFocusEnd(q, { now: new Date().toISOString() });
    const id = L.focusEndQuestionId((q as any).focus);
    await show(q, 'v-decide');
    $('show-decisions').click();
    await flush();
    const button = document.querySelector(`button[aria-label="Answer ${id}: Set a new focus"]`) as HTMLButtonElement;
    expect(button).toBeTruthy();
    button.click();
    await flush();
    expect($('show-plan').getAttribute('aria-selected')).toBe('true');
  });
});

describe('ravenseat qa ok cleans the focus at once', () => {
  const QUEUE_MJS = join(ORCH, 'queue.mjs');
  let folder: string;
  function run(args: string[]): { code: number; out: string; error: string } {
    try {
      const out = execFileSync(process.execPath, [QUEUE_MJS, ...args], {
        env: { ...process.env, QUEUE_FOLDER: folder, QUEUE_GIT: folder, QUEUE_TIME_LOG: join(folder, 'times.jsonl') },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { code: 0, out, error: '' };
    } catch (e) {
      const x = e as { status: number; stdout: string; stderr: string };
      return { code: x.status, out: x.stdout ?? '', error: x.stderr ?? '' };
    }
  }
  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'queue-focus-b18-'));
    writeFileSync(join(folder, 'queue.json'), JSON.stringify({ ...stuckQueue(), next_migr: 1000 }, null, 2));
  });
  afterEach(() => rmSync(folder, { recursive: true, force: true }));

  it('the last QA in the focus registers the owner question right away', () => {
    const r = run(['qa', 'ok', 'UI-1', '--by', 'owner']);
    expect(r.code, r.error).toBe(0);
    expect(r.out).toMatch(/QA ok: UI-1/);
    expect(r.out).toMatch(/is done: queue paused/);
    const q = JSON.parse(readFileSync(join(folder, 'queue.json'), 'utf8'));
    expect(q.focus.finished_at).toBeTruthy();
    expect(Object.keys(q.question ?? {}).filter((k) => k.startsWith('focus-done-'))).toHaveLength(1);
  });
});
