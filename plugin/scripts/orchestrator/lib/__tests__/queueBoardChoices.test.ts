/**
 * @vitest-environment jsdom
 */
// =============================================================
// queueBoardChoices.test.ts: "Waiting on you" shows the choices of an owner question as buttons, and a click answers
// through POST /api/action { type: 'resolve', sp, choice } (the same path as the free text answer). A question without
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
const panel = () => document.getElementById('panel') as HTMLElement;
const row = (sp: string) =>
  [...panel().querySelectorAll('.inbox-row')].find((r) => r.querySelector('.sp-id')?.textContent === sp) as HTMLElement;

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
  for (const f of ['a11y.js', '../lib/queueGraph.js', 'graph.js', 'plan.js', 'performance.js', 'board/'])
    (0, eval)(clientSource(f));
  await flush();
  (document.getElementById('inbox') as HTMLButtonElement).click();
  await flush();
}, 60_000);

describe('"Waiting on you": choices on an owner question', () => {
  it('shows one button per choice (the recommended one filled and marked); no choice buttons without choices', () => {
    const buttons = [...row('PICK').querySelectorAll('.answer-choices button')] as HTMLButtonElement[];
    expect(buttons.map((b) => b.textContent)).toEqual(['Vendor A', 'Vendor B (recommended)']);
    expect(buttons[1].className).toContain('button-filled');
    expect(buttons[0].className).toContain('button-outline');
    expect(row('PICK').querySelector('.answer-choices')?.getAttribute('role')).toBe('group');
    // The free text answer stays available.
    expect([...row('PICK').querySelectorAll(':scope > .button')].map((b) => b.textContent)).toContain(
      'Answer in your own words',
    );
    expect(row('FREE').querySelector('.answer-choices')).toBeNull();
    expect([...row('FREE').querySelectorAll(':scope > .button')].map((b) => b.textContent)).toContain('Answer');
  });

  it('a click answers through POST /api/action { type: resolve, sp, choice } (1-based), the free text field as a note', async () => {
    (row('PICK').querySelectorAll('.answer-choices button')[0] as HTMLButtonElement).click();
    await flush();
    expect(posts.filter((p) => p.path === '/api/action').at(-1)?.body).toEqual({
      type: 'resolve',
      sp: 'PICK',
      choice: 1,
    });
    // With the free text field open and filled in, its text goes along as the note.
    const open = [...row('PICK').querySelectorAll(':scope > .button')].find(
      (b) => b.textContent === 'Answer in your own words',
    ) as HTMLButtonElement;
    open.click();
    await flush();
    const field = row('PICK').querySelector('textarea') as HTMLTextAreaElement;
    field.value = 'from March';
    (row('PICK').querySelectorAll('.answer-choices button')[1] as HTMLButtonElement).click();
    await flush();
    expect(posts.filter((p) => p.path === '/api/action').at(-1)?.body).toEqual({
      type: 'resolve',
      sp: 'PICK',
      choice: 2,
      answer: 'from March',
    });
  });
});
