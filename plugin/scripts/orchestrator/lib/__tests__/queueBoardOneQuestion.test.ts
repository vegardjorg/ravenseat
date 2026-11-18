/**
 * @vitest-environment jsdom
 */
// =============================================================
// queueBoardOneQuestion.test.ts: one question card and one counter on every surface (board step B24).
//
// What the tests prove:
//   - one word table (QueueDecisions.QUESTION_WORDS) gives the type names and the button words, and the Plans view
//     (QueuePlanView.DEC_TYPE) takes its names from it, so "Owner task" is "Owner task" everywhere,
//   - the choices keep the order they were written in on every surface (the number on the button is the --choice
//     number), the recommended one filled and marked "As recommended",
//   - the Decisions card, the Plans > Decisions detail and the Plans overview row are drawn by the same renderer
//     (board/question.js, window.QueueQuestion) and show the same order, type names and button words,
//   - an owner task's button is a verb ("Mark done") with an optional note, and the POST body keeps its shape,
//   - the "Waiting on you" drawer is gone: the button opens the Decisions room and carries the only counter,
//   - what only the drawer had (Sort with accept-suggestion, QA ok and Approve for many, the unlogged answers) is in
//     Decisions now,
//   - the landing rule: Decisions on load only when something is new since the last visit.
// The whole board runs in jsdom with a small synthetic queue (no real data).
// =============================================================
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { boardSource, clientSource } from './boardClient';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const T = require('../queueBoard.js') as { board: (queue: unknown, option?: unknown) => any };
const KK = require('../queueConfig.js') as any;
const D = require('../queueDecisions.js') as any;
const V = require('../queuePlanView.js') as any;
const P = require('../queuePlan.js') as any;
/* eslint-enable @typescript-eslint/no-require-imports */

const CLIENT = join(__dirname, '..', '..', 'queue-board');
const iso = new Date(Date.now() - 86_400_000).toISOString();

const task = (id: string, status: string, waiting: string[] = []) => ({
  id,
  title: `Task ${id}`,
  domain: 'ui',
  class: 'K',
  value: 5,
  content_min: 90,
  status,
  depends_on: [],
  waiting_on: waiting,
  owned_files: [`file/${id}.ts`],
  owner_db: [],
  shared_patch: [],
  mission: `scripts/.queue/mission/${id}.md`,
  added_by: 'test',
  added_at: iso,
});

function makeQueue() {
  return {
    created: iso,
    limits: { maxConcurrent: 5, maxDPlus: 2, maxPerDomain: 5, maxDb: 2 },
    tasks: [
      task('EX-1', 'waiting', ['Q-SSO']),
      task('EX-2', 'waiting', ['PICK']),
      task('EX-3', 'waiting', ['FREE']),
      task('EX-5', 'proposed'),
      task('EX-6', 'proposed'),
    ],
    projects: { ex: { title: 'Example', prefixes: ['EX-'] } },
    areas: {},
    question: {
      'Q-SSO': {
        type: 'question',
        text: 'Do we offer sign-in with Apple and Google from day one?',
        recommendation: 'Yes for Apple, Google later.',
        added_at: iso,
      },
      PICK: {
        type: 'question',
        text: 'How long should the free trial be?',
        choices: ['7 days', '14 days', '30 days'],
        recommendation: '14 days',
        context: 'Habits take about two weeks.',
        added_at: iso,
      },
      FREE: { type: 'owner-task', text: 'Write the launch note.', added_at: iso },
    },
    resolutions: {},
    changelog: [],
  };
}

const posts: { path: string; body: any }[] = [];
const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};
const $ = (id: string) => document.getElementById(id) as HTMLElement;
const card = (key: string) => document.querySelector(`.decide-card[data-key="${key}"]`) as HTMLElement;
/** The visible text of a button without the key hint (the "1" in the Decisions view). */
const label = (b: Element) =>
  [...b.childNodes]
    .filter((n) => !(n instanceof HTMLElement && n.classList.contains('decide-key')))
    .map((n) => n.textContent)
    .join('')
    .trim();
const answerLabels = (root: Element) =>
  [...root.querySelectorAll('.decide-options button')].map(label);
const keys = (root: Element) =>
  [...root.querySelectorAll('.decide-options .decide-key')].map((k) => k.textContent);

/** The Plans rows for the same queue, made by the server's own function (queuePlan.ownerDecisions). */
const planRows = () => P.ownerDecisions({ entries: [] }, makeQueue()).openOnes as any[];

const state: any = { version: 'v1', data: null };

beforeAll(async () => {
  const data = {
    ...T.board(makeQueue()),
    gitError: null,
    logo: false,
    features: KK.features(KK.STANDARD),
    boardSwitches: KK.boardSwitches(KK.STANDARD, null),
  };
  // What only the drawer had: the Sort list, QA for many and the answers not in the decision log yet.
  data.inbox.sort = [{ id: 'EX-5', type: 'move', now: '(none)', proposed: 'ex', title: 'Task EX-5', reason: 'prefix EX-' }];
  data.inbox.unlogged = [{ sp: 'OLD-1' }];
  state.data = data;
  const html = readFileSync(join(CLIENT, 'index.html'), 'utf8');
  document.documentElement.innerHTML = html.replace(/<!doctype[^>]*>/i, '').replace(/<\/?html[^>]*>/g, '');
  sessionStorage.setItem('queue-board-key', 'testKey');
  localStorage.clear(); // a first visit: everything is new
  const w = window as any;
  w.CSS = { escape: (s: string) => String(s).replace(/["\\]/g, '\\$&') };
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.setInterval = () => 0;
  w.fetch = async (filePath: string, init?: { method?: string; body?: string }) => {
    if (init?.method === 'POST') posts.push({ path: filePath, body: JSON.parse(init.body ?? '{}') });
    return {
      ok: true,
      status: 200,
      json: async () =>
        filePath.startsWith('/api/state')
          ? filePath.includes(`version=${state.version}`)
            ? { version: state.version, unchanged: true }
            : state
          : filePath.startsWith('/api/settings')
            ? { ok: false, message: 'not in this test' }
            : { ok: true, message: 'ok', info: [] },
    };
  };
  for (const f of ['a11y.js', '../lib/queueGraph.js', 'graph.js', 'plan.js', 'performance.js', '../lib/queueDecisions.js', 'board/'])
    (0, eval)(clientSource(f));
  await flush();
}, 60_000);

describe('one word table', () => {
  it('names every type once, and the Plans view takes its names from it', () => {
    expect(D.QUESTION_WORDS['owner-task'].name).toBe('Owner task');
    for (const [type, w] of Object.entries(D.QUESTION_WORDS) as [string, any][])
      expect(V.DEC_TYPE[type]).toBe(w.name);
  });

  it('the owner task is answered with a verb, never with a question on the button', () => {
    const w = D.QUESTION_WORDS['owner-task'];
    expect(w.answer).toBe('Mark done');
    expect(w.answer).not.toMatch(/\?$/);
    expect(w.optional).toBe(true);
    for (const x of Object.values(D.QUESTION_WORDS) as any[]) expect(x.answer).not.toMatch(/\?$/);
    const src = [boardSource(), readFileSync(join(CLIENT, 'plans', 'legal.js'), 'utf8'), readFileSync(join(CLIENT, 'plans', 'overview.js'), 'utf8')].join('\n');
    expect(src).not.toContain('What is completed?');
    expect(src).not.toContain('Use the recommendation');
    expect(src).not.toContain("'? Owner question'");
    expect(src).not.toContain("'Owner action'");
  });
});

describe('the choices keep their order, the recommended one marked', () => {
  it('the decision item keeps the written order and the 1-based choice number', () => {
    const items = D.fromInbox(T.board(makeQueue()).inbox);
    const pick = items.find((x: any) => x.key === 'decide:PICK');
    expect(pick.options.map((o: any) => o.label)).toEqual(['7 days', '14 days', '30 days']);
    expect(pick.options.map((o: any) => o.recommended)).toEqual([false, true, false]);
    expect(pick.options.map((o: any) => o.action.choice)).toEqual([1, 2, 3]);
  });

  it('the Decisions card: same order, the number on the button is the choice number', () => {
    const c = card('decide:PICK');
    expect(answerLabels(c)).toEqual(['7 days', 'As recommended: 14 days', '30 days', 'Other decision']);
    expect(keys(c)).toEqual(['1', '2', '3']);
    expect(c.querySelector('.decide-options .button-filled')?.textContent).toContain('14 days');
  });

  it('Plans > Decisions and the Plans overview: the same renderer gives the same words and order', () => {
    const Q = (window as any).QueueQuestion;
    expect(Q).toBeTruthy();
    const rows = planRows();
    const pick = rows.find((r) => r.id === 'PICK');
    expect(pick.choices.map((c: any) => c.label)).toEqual(['7 days', '14 days', '30 days']);
    expect(pick.context).toBe('Habits take about two weeks.');
    const item = Q.fromPlan(pick);
    const detail = document.createElement('div');
    detail.append(Q.answers(item, { onOption() {}, onFree() {} }));
    expect(answerLabels(detail)).toEqual(answerLabels(card('decide:PICK')));
    // Same for the question without choices and the owner task.
    for (const sp of ['Q-SSO', 'FREE']) {
      const box = document.createElement('div');
      box.append(Q.answers(Q.fromPlan(rows.find((r) => r.id === sp)), { onOption() {}, onFree() {} }));
      expect(answerLabels(box)).toEqual(answerLabels(card(`decide:${sp}`)));
    }
    // The overview row: the same type name as the card, led by what the answer unlocks.
    const free = Q.compact(Q.fromPlan(rows.find((r) => r.id === 'FREE')), { onOpen() {} });
    expect(free.querySelector('.sp-type')?.textContent).toBe('Owner task');
    expect(card('decide:FREE').querySelector('.sp-type')?.textContent).toBe('Owner task');
    expect(free.querySelector('.question-meta')?.textContent).toMatch(/^unlocks 1 task \(1 h 30 min\)/);
    expect(free.querySelector('button')?.textContent).toBe('Mark done');
    // Both Plans surfaces draw through the shared renderer.
    expect(readFileSync(join(CLIENT, 'plans', 'legal.js'), 'utf8')).toContain('QueueQuestion');
    expect(readFileSync(join(CLIENT, 'plans', 'overview.js'), 'utf8')).toContain('QueueQuestion');
  });
});

describe('no drawer, one counter', () => {
  it('the board landed in Decisions on a first visit (everything is new)', () => {
    expect($('show-decisions').getAttribute('aria-selected')).toBe('true');
    expect(document.querySelector('.decide')).not.toBeNull();
  });

  it('the count is on "Waiting on you" only, not on the Decisions tab', () => {
    expect($('show-decisions').querySelector('.inbox-count')).toBeNull();
    expect($('show-decisions').textContent?.trim()).toBe('Decisions');
    expect($('inbox').querySelector('.inbox-count')?.textContent).toBe('5');
    expect($('inbox').getAttribute('aria-label')).toBe('Waiting on you: 5, opens Decisions');
  });

  it('the button opens the Decisions room, not a side panel', async () => {
    expect($('inbox').hasAttribute('aria-haspopup')).toBe(false);
    expect($('inbox').hasAttribute('aria-expanded')).toBe(false);
    $('room-queue').click();
    await flush();
    expect($('show-decisions').getAttribute('aria-selected')).toBe('false');
    $('inbox').click();
    await flush();
    expect($('show-decisions').getAttribute('aria-selected')).toBe('true');
    expect($('panel').hidden).toBe(true);
    expect(document.querySelector('.inbox-row')).toBeNull();
    const html = readFileSync(join(CLIENT, 'index.html'), 'utf8');
    expect(html).not.toContain('board/inbox.js');
    expect(boardSource()).not.toMatch(/function (openInbox|drawInbox)\b/);
  });
});

describe('what the drawer had is in Decisions now', () => {
  it('the Sort list, with "Accept proposal" (the accept-suggestion bulk action)', async () => {
    const sort = document.querySelector('.decide-sort') as HTMLElement;
    expect(sort).not.toBeNull();
    expect(sort.textContent).toContain('Sort (1)');
    const accept = [...sort.querySelectorAll('button')].find((b) => b.textContent === 'Accept proposal') as HTMLButtonElement;
    expect(accept).toBeTruthy();
    accept.click();
    await flush();
    // The bulk dialog opens with accept-suggestion for that task (you see the change before it is saved).
    expect($('bulk-background').hidden).toBe(false);
    expect($('bulk-title').textContent).toBe('Accept proposed project');
    ([...$('bulk').querySelectorAll('button')].find((b) => b.textContent === 'Cancel') as HTMLButtonElement).click();
    await flush();
    expect($('bulk-background').hidden).toBe(true);
  });

  it('Approve for many: check the cards, then "Approve selected" writes them at once', async () => {
    const group = document.querySelector('.decide-group[aria-labelledby="decide-approve"]') as HTMLElement;
    const bulk = () => [...group.querySelectorAll('button')].find((b) => /^Approve selected/.test(b.textContent ?? '')) as HTMLButtonElement;
    expect(bulk().disabled).toBe(true);
    for (const id of ['EX-5', 'EX-6']) {
      const box = card(`approve:${id}`).querySelector('input[type="checkbox"]') as HTMLInputElement;
      box.checked = true;
      box.dispatchEvent(new Event('change'));
      await flush();
    }
    const fresh = document.querySelector('.decide-group[aria-labelledby="decide-approve"]') as HTMLElement;
    const button = [...fresh.querySelectorAll('button')].find((b) => /^Approve selected/.test(b.textContent ?? '')) as HTMLButtonElement;
    expect(button.textContent).toBe('Approve selected (2)');
    button.click();
    await flush();
    expect(posts.at(-1)).toEqual({ path: '/api/action', body: { type: 'approve', ids: ['EX-5', 'EX-6'] } });
  });

  it('the answers not in the decision log yet', () => {
    expect(document.querySelector('.decide')?.textContent).toContain('not entered in the decision log yet (OLD-1)');
  });
});

describe('the owner task: "Mark done" with an optional note, the same POST body', () => {
  it('"Mark done" opens an optional note; saving writes { type: resolve, sp, answer }', async () => {
    const c = card('decide:FREE');
    expect(answerLabels(c)).toEqual(['Mark done']);
    (c.querySelector('.decide-options button') as HTMLButtonElement).click();
    await flush();
    const form = card('decide:FREE').querySelector('.decide-form') as HTMLElement;
    expect(form.querySelector('label')?.textContent).toBe('Note (optional)');
    const save = [...form.querySelectorAll('button')].find((b) => b.textContent === 'Mark done') as HTMLButtonElement;
    expect(save).toBeTruthy();
    (form.querySelector('textarea') as HTMLTextAreaElement).value = 'Sent to the list';
    save.click();
    await flush();
    // The answer waits for its undo window; leaving the page writes it.
    window.dispatchEvent(new Event('pagehide'));
    await flush();
    expect(posts.at(-1)).toEqual({ path: '/api/action', body: { type: 'resolve', sp: 'FREE', answer: 'Sent to the list' } });
  });

  it('without a note the answer is "Done" (the server still gets a non-empty answer)', () => {
    const item = D.fromInbox(T.board(makeQueue()).inbox).find((x: any) => x.key === 'decide:FREE');
    expect(item.free.label).toBe('Mark done');
    expect(item.free.optional).toBe(true);
    expect(D.freeAnswer(item, '  ')).toBe('Done');
    expect(D.freeAnswer(item, 'x')).toBe('x');
    const q = D.fromInbox(T.board(makeQueue()).inbox).find((x: any) => x.key === 'decide:Q-SSO');
    expect(D.freeAnswer(q, '  ')).toBe('');
  });
});

describe('the landing rule', () => {
  it('Decisions only when a decision is new since the last visit', () => {
    expect(D.landInDecisions(['decide:A', 'check:B'], null)).toBe(true); // first visit
    expect(D.landInDecisions(['decide:A', 'check:B'], ['decide:A', 'check:B'])).toBe(false);
    expect(D.landInDecisions(['decide:A'], ['decide:A', 'check:B'])).toBe(false); // one left: nothing new
    expect(D.landInDecisions(['decide:A', 'decide:C'], ['decide:A'])).toBe(true);
    expect(D.landInDecisions([], null)).toBe(false); // nothing waits
  });

  it('a visit to Decisions remembers what was there', () => {
    const seen = JSON.parse(localStorage.getItem('queue-board-decisions-seen') ?? 'null');
    expect(seen).toEqual(expect.arrayContaining(['decide:PICK', 'decide:FREE', 'approve:EX-5']));
  });
});
