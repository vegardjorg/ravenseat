/**
 * @vitest-environment jsdom
 */
// =============================================================
// queueBoardChoices.test.ts: the Decisions room (where "Waiting on you" leads since B24) shows the choices of an owner
// question as buttons in their written order, and a click answers through POST /api/action { type: 'resolve', sp, choice }
// (the same path as the free text answer); the text field can go along as the choice's note. A question without
// choices keeps the plain "Answer" button. The whole board runs in jsdom with a small synthetic queue (no real data).
// =============================================================
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { clientSource } from './boardClient';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const T = require('../queueBoard.js') as { board: (queue: unknown, option?: unknown) => any };

const CLIENT = join(__dirname, '..', '..', 'queue-board');
const posts: { path: string; body: any }[] = [];

function makeQueue() {
  const iso = new Date(Date.now() - 86_400_000).toISOString();
  const task = (id: string, waiting: string) => ({
    id,
    title: `Task ${id}`,
    domain: 'ui',
    class: 'K',
    value: 5,
    content_min: 90,
    status: 'waiting',
    depends_on: [],
    waiting_on: [waiting],
    owned_files: [`file/${id}.ts`],
    owner_db: [],
    shared_patch: [],
    mission: `scripts/.queue/mission/${id}.md`,
    added_by: 'test',
    added_at: iso,
  });
  return {
    created: iso,
    limits: { maxConcurrent: 5, maxDPlus: 2, maxPerDomain: 5, maxDb: 2 },
    tasks: [task('EX-1', 'PICK'), task('EX-2', 'FREE')],
    projects: { ex: { title: 'Example', prefixes: ['EX-'] } },
    areas: {},
    question: {
      PICK: {
        type: 'question',
        text: 'Which vendor?',
        choices: ['Vendor A', 'Vendor B'],
        recommendation: 'Vendor B',
        added_at: iso,
      },
      FREE: { type: 'question', text: 'Anything else?', added_at: iso },
    },
    resolutions: {},
    changelog: [],
  };
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};
const card = (sp: string) => document.querySelector(`.decide-card[data-key="decide:${sp}"]`) as HTMLElement;
/** The choice buttons on a card (not the free answer, not "Open <task>"). */
const choices = (sp: string) =>
  [...card(sp).querySelectorAll(':scope > .decide-options > button:not(.link-button):not([data-focus$=":free"])')] as HTMLButtonElement[];
/** The visible text of a button without the key hint (the "1" in the Decisions room). */
const label = (b: Element) =>
  [...b.childNodes]
    .filter((n) => !(n instanceof HTMLElement && n.classList.contains('decide-key')))
    .map((n) => n.textContent)
    .join('');

beforeAll(async () => {
  const state = { version: 'v1', data: { ...T.board(makeQueue()), gitError: null, logo: false } };
  const html = readFileSync(join(CLIENT, 'index.html'), 'utf8');
  document.documentElement.innerHTML = html.replace(/<!doctype[^>]*>/i, '').replace(/<\/?html[^>]*>/g, '');
  sessionStorage.setItem('queue-board-key', 'testKey');
  localStorage.clear();
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
          : { ok: true },
    };
  };
  for (const f of ['a11y.js', '../lib/queueGraph.js', 'graph.js', 'plan.js', 'performance.js', '../lib/queueDecisions.js', 'board/'])
    (0, eval)(clientSource(f));
  await flush();
  (document.getElementById('inbox') as HTMLButtonElement).click();
  await flush();
}, 60_000);

describe('Decisions: choices on an owner question', () => {
  it('shows one button per choice in the written order (the recommended one filled, "As recommended: <choice>"); no choice buttons without choices', () => {
    const buttons = choices('PICK');
    expect(buttons.map(label)).toEqual(['Vendor A', 'As recommended: Vendor B']);
    expect(buttons[1].className).toContain('button-filled');
    expect(buttons[0].className).toContain('button-outline');
    expect(card('PICK').querySelector('.decide-options')?.getAttribute('role')).toBe('group');
    // The free text answer stays available, as "Other decision".
    expect([...card('PICK').querySelectorAll('.decide-options > .link-button')].map((b) => b.textContent)).toContain(
      'Other decision',
    );
    expect(choices('FREE')).toHaveLength(0);
    expect([...card('FREE').querySelectorAll('.decide-options > .button')].map((b) => b.textContent)).toContain('Answer');
  });

  it('a click answers through POST /api/action { type: resolve, sp, choice } (1-based), and a choice can take the text as a note', async () => {
    // The answer waits in its undo window (5 s); the test catches that timer and runs it now.
    const w = window as any;
    const realTimeout = w.setTimeout;
    let undoWindow: (() => unknown) | null = null;
    w.setTimeout = (fn: () => unknown, ms?: number) => (ms === 5000 ? ((undoWindow = fn), 0) : realTimeout(fn, ms));
    choices('PICK')[0].click();
    await flush();
    w.setTimeout = realTimeout;
    expect(undoWindow).not.toBeNull();
    await undoWindow!();
    await flush();
    expect(posts.filter((p) => p.path === '/api/action').at(-1)?.body).toEqual({
      type: 'resolve',
      sp: 'PICK',
      choice: 1,
    });
    // With the text field open and filled in, "Choose with this note" sends the choice with the text.
    const open = [...card('PICK').querySelectorAll('.decide-options > .link-button')].find(
      (b) => b.textContent === 'Other decision',
    ) as HTMLButtonElement;
    open.click();
    await flush();
    const field = card('PICK').querySelector('textarea') as HTMLTextAreaElement;
    field.value = 'from March';
    const withNote = [...card('PICK').querySelectorAll('.decide-form .decide-options button')] as HTMLButtonElement[];
    expect(withNote.map((b) => b.textContent)).toEqual(['Vendor A', 'As recommended: Vendor B']);
    withNote[1].click();
    await flush();
    window.dispatchEvent(new Event('pagehide'));
    await flush();
    expect(posts.filter((p) => p.path === '/api/action').at(-1)?.body).toEqual({
      type: 'resolve',
      sp: 'PICK',
      choice: 2,
      answer: 'from March',
    });
  });
});
