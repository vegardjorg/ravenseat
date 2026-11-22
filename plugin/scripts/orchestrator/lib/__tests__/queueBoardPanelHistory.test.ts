/**
 * @vitest-environment jsdom
 */
// =============================================================
// queueBoardPanelHistory.test.ts: the card's History in the detail panel (roadmap 0ø J5, board/panel.js).
//
// Locks: a collapsed "History" section after Details, with the step count in its summary; open, an ordered list with
// one item per step (a <time> with the ISO time, the text, the gap since the step before), a failure marked in words
// for a screen reader and by a class (never by colour alone); the text is text, never markup; a history that could
// not be built and an empty one each say so; the open state is remembered like Details.
// The whole board runs in jsdom with a small synthetic queue (no real data); /api/task is stubbed.
// =============================================================
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { clientSource } from './boardClient';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const T = require('../queueBoard.js') as { board: (queue: unknown, option?: unknown) => any };

const CLIENT = join(__dirname, '..', '..', 'queue-board');
const H = 3_600_000;
const T0 = Date.parse('2026-11-21T20:00:00.000Z');
const iso = (h: number) => new Date(T0 + h * H).toISOString();

/** What /api/task gives as `history` per task id. */
const HISTORY: Record<string, unknown> = {
  'EX-1': {
    id: 'EX-1',
    open: true,
    span_ms: 3 * H,
    steps: [
      { time: iso(0), kind: 'added', text: 'Added by you', fail: false, gap_ms: null },
      { time: iso(1), kind: 'gate-red', text: 'Track gate red: <b>npm test</b>', fail: true, gap_ms: 1 * H },
      { time: iso(3), kind: 'gate-green', text: 'Track gate green', fail: false, gap_ms: 2 * H },
    ],
  },
  'EX-2': null,
  'EX-3': { id: 'EX-3', open: true, span_ms: null, steps: [] },
};

function makeQueue() {
  const at = new Date(Date.now() - 86_400_000).toISOString();
  const task = (id: string, value: number) => ({
    id,
    title: `Task ${id}`,
    domain: 'ui',
    class: 'K',
    value,
    content_min: 30,
    status: 'waiting',
    depends_on: [],
    waiting_on: [],
    owned_files: [`file/${id}.ts`],
    owner_db: [],
    shared_patch: [],
    mission: `scripts/.queue/mission/${id}.md`,
    added_by: 'test',
    added_at: at,
  });
  return {
    created: at,
    limits: { maxConcurrent: 5, maxDPlus: 2, maxPerDomain: 5, maxDb: 2 },
    tasks: [task('EX-1', 9), task('EX-2', 8), task('EX-3', 7)],
    projects: { ex: { title: 'Example', prefixes: ['EX-'] } },
    areas: {},
    question: [],
    resolutions: [],
    changelog: [],
  };
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};
const w = window as any;

beforeAll(async () => {
  const state = { version: 'v1', data: { ...T.board(makeQueue()), gitError: null, logo: false } };
  const html = readFileSync(join(CLIENT, 'index.html'), 'utf8');
  document.documentElement.innerHTML = html.replace(/<!doctype[^>]*>/i, '').replace(/<\/?html[^>]*>/g, '');
  sessionStorage.setItem('queue-board-key', 'testKey');
  localStorage.clear();
  w.CSS = { escape: (s: string) => String(s).replace(/["\\]/g, '\\$&') };
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.setInterval = () => 0;
  w.fetch = async (filePath: string) => ({
    ok: true,
    status: 200,
    json: async () => {
      if (filePath.startsWith('/api/state'))
        return filePath.includes(`version=${state.version}`) ? { version: state.version, unchanged: true } : state;
      const task = /^\/api\/task\?id=([^&]+)/.exec(filePath);
      if (task) {
        const id = decodeURIComponent(task[1]);
        return { ok: true, mission: { text: '', path: null }, branch: null, description: null, sources: [], history: HISTORY[id] };
      }
      return { ok: true };
    },
  });
  for (const f of ['a11y.js', '../lib/queueGraph.js', 'graph.js', 'plan.js', 'performance.js', 'board/'])
    (0, eval)(clientSource(f));
  await flush();
}, 60_000);

const panel = () => document.getElementById('panel') as HTMLElement;
async function open(id: string) {
  if (!panel().hidden) (panel().querySelector('.button-icon') as HTMLButtonElement).click();
  const b = document.querySelector(`.summary[data-id="${id}"] .summary-button`) as HTMLButtonElement;
  expect(b, id).not.toBeNull();
  b.click();
  await flush();
  expect(panel().hidden).toBe(false);
}
const history = () => panel().querySelector('details.panel-history') as HTMLDetailsElement | null;

describe('the History section in the panel', () => {
  it('is a collapsed section after Details, with the step count in its summary', async () => {
    await open('EX-1');
    const h = history();
    expect(h).not.toBeNull();
    expect(h!.open).toBe(false);
    expect(h!.querySelector('summary')?.textContent).toContain('History');
    expect(h!.querySelector('summary')?.textContent).toContain('3 steps');
    const kids = [...panel().children];
    expect(kids.indexOf(h!)).toBeGreaterThan(kids.indexOf(panel().querySelector('details.panel-details:not(.panel-history)') as Element));
  });

  it('lists the steps in order with the time, the text and the gap, a failure marked in words', async () => {
    await open('EX-1');
    const items = [...history()!.querySelectorAll('ol > li')];
    expect(items).toHaveLength(3);
    expect(items[0].querySelector('time')?.getAttribute('datetime')).toBe(iso(0));
    expect(items[1].classList.contains('history-fail')).toBe(true);
    expect(items[1].textContent).toContain('Failed');
    expect(items[1].textContent).toContain('+1 h');
    expect(items[2].textContent).toContain('+2 h');
    expect(items[0].classList.contains('history-fail')).toBe(false);
  });

  it('shows the text as text, never markup', async () => {
    await open('EX-1');
    const li = history()!.querySelectorAll('ol > li')[1];
    expect(li.querySelector('b')).toBeNull();
    expect(li.textContent).toContain('<b>npm test</b>');
  });

  it('says so when the history could not be built, and when nothing is recorded yet', async () => {
    await open('EX-2');
    expect(history()!.textContent).toContain('could not be read');
    await open('EX-3');
    expect(history()!.textContent).toContain('Nothing recorded yet');
  });

  it('remembers the open state like Details', async () => {
    await open('EX-1');
    const h = history()!;
    h.open = true;
    h.dispatchEvent(new Event('toggle'));
    await open('EX-3');
    expect(history()!.open).toBe(true);
    history()!.open = false;
    history()!.dispatchEvent(new Event('toggle'));
  });
});
