/**
 * @vitest-environment jsdom
 */
// =============================================================
// queueBoardKeepAnswer.test.ts: "Keep as design choice" in the Decisions room (roadmap 0z Z-A, catalog.captureAnswers).
//
// Locks: with captureAnswers explicit, a plain owner question has one toggle button (aria-pressed) under its answers; a
// condition has none. Pressed, the next answer goes as POST /api/action { ..., keep: true } (resolve --keep), and the
// undo toast says it will be kept; not pressed, no keep. With suggest, a question that reads like a lasting rule gets
// the hint next to the button (never pressed by itself). With off, or without the setting in the state, no button.
// The whole board runs in jsdom with a small synthetic queue (no real data).
// =============================================================
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { clientSource } from './boardClient';

// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
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
    tasks: [task('EX-1', 'PICK'), task('EX-2', 'RULE'), task('EX-3', 'COND')],
    projects: { ex: { title: 'Example', prefixes: ['EX-'] } },
    areas: {},
    question: {
      PICK: { type: 'question', text: 'Which vendor?', choices: ['Vendor A', 'Vendor B'], recommendation: 'Vendor B', added_at: iso },
      RULE: { type: 'question', text: 'Should buttons always be filled?', recommendation: 'Yes, always filled', added_at: iso },
      COND: { type: 'condition', text: 'The contract is signed', added_at: iso },
    },
    resolutions: {},
    changelog: [],
  };
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};
const card = (sp: string) => document.querySelector(`.decide-card[data-key="decide:${sp}"]`) as HTMLElement;
const keepButton = (sp: string) => card(sp)?.querySelector('.decide-keep button') as HTMLButtonElement | null;
const state: { version: string; data: any } = { version: 'v1', data: null };
const w = window as any;

/** Puts a new state on the board (a new version, so the next poll draws it). */
async function showState(captureAnswers: string | null) {
  state.version = `v-${captureAnswers}-${Math.random()}`;
  state.data = { ...T.board(makeQueue(), { captureAnswers }), gitError: null, logo: false };
  window.dispatchEvent(new Event('focus'));
  await flush();
}

beforeAll(async () => {
  state.data = { ...T.board(makeQueue(), { captureAnswers: 'explicit' }), gitError: null, logo: false };
  const html = readFileSync(join(CLIENT, 'index.html'), 'utf8');
  document.documentElement.innerHTML = html.replace(/<!doctype[^>]*>/i, '').replace(/<\/?html[^>]*>/g, '');
  sessionStorage.setItem('queue-board-key', 'testKey');
  localStorage.clear();
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

describe('Decisions: Keep as design choice', () => {
  it('explicit: a toggle under a plain question, none on a condition, no hint', () => {
    const b = keepButton('PICK');
    expect(b).not.toBeNull();
    expect(b!.textContent).toMatch(/Keep as design choice/);
    expect(b!.getAttribute('aria-pressed')).toBe('false');
    expect(b!.type).toBe('button');
    expect(keepButton('COND')).toBeNull();
    expect(card('RULE').querySelector('.decide-keep-hint')).toBeNull();
  });

  it('pressed, the answer goes with keep: true and the toast says so; not pressed, no keep', async () => {
    keepButton('PICK')!.click();
    await flush();
    expect(keepButton('PICK')!.getAttribute('aria-pressed')).toBe('true');
    const realTimeout = w.setTimeout;
    let undoWindow: (() => unknown) | null = null;
    w.setTimeout = (fn: () => unknown, ms?: number) => (ms === 5000 ? ((undoWindow = fn), 0) : realTimeout(fn, ms));
    (card('PICK').querySelector('.decide-options > button') as HTMLButtonElement).click();
    await flush();
    w.setTimeout = realTimeout;
    expect(document.getElementById('undo-message')!.textContent).toMatch(/kept as a proposed design choice/);
    await undoWindow!();
    await flush();
    expect(posts.filter((p) => p.path === '/api/action').at(-1)?.body).toEqual({ type: 'resolve', sp: 'PICK', choice: 1, keep: true });

    await showState('explicit');
    let second: (() => unknown) | null = null;
    w.setTimeout = (fn: () => unknown, ms?: number) => (ms === 5000 ? ((second = fn), 0) : realTimeout(fn, ms));
    (card('PICK').querySelector('.decide-options > button') as HTMLButtonElement).click();
    await flush();
    w.setTimeout = realTimeout;
    await second!();
    await flush();
    expect(posts.filter((p) => p.path === '/api/action').at(-1)?.body).toEqual({ type: 'resolve', sp: 'PICK', choice: 1 });
  });

  it('suggest: a lasting-looking question gets the hint, and the button is still not pressed', async () => {
    await showState('suggest');
    expect(card('RULE').querySelector('.decide-keep-hint')?.textContent).toMatch(/lasting rule/);
    expect(keepButton('RULE')!.getAttribute('aria-pressed')).toBe('false');
    expect(card('PICK').querySelector('.decide-keep-hint')).toBeNull();
  });

  it('off, or no setting in the state: no button', async () => {
    await showState('off');
    expect(keepButton('PICK')).toBeNull();
    await showState(null);
    expect(keepButton('RULE')).toBeNull();
  });
});
