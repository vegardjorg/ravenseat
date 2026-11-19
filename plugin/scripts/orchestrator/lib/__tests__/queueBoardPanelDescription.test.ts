/**
 * @vitest-environment jsdom
 */
// =============================================================
// queueBoardPanelDescription.test.ts: the task's own description and sources in the detail panel (roadmap 2c4, and
// the 0p2 B5 gap "the panel shows only the plan chip and source").
//
// What the tests prove:
//   - a task with a `description` (from /api/task) shows it at the top, in the place of the derived mission summary,
//     above the actions and the mission; without one the derived summary is shown as before;
//   - the description is text, never markup: HTML and markdown in it are shown as written;
//   - the task's own sources are listed in Details (path, anchor and role), between the plan entry and the source;
//   - the Edit form has a description field that starts from the task's description, sends it only when changed,
//     and sends "" to remove it.
// The whole board runs in jsdom with a small synthetic queue (no real data); /api/task is stubbed.
// =============================================================
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { clientSource } from './boardClient';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const T = require('../queueBoard.js') as { board: (queue: unknown, option?: unknown) => any };

const CLIENT = join(__dirname, '..', '..', 'queue-board');

/** What /api/task gives per task id, besides the mission. */
const DETAILS: Record<string, { description: string | null; sources: object[] }> = {
  'EX-1': { description: 'Users see how long they kept a habit going.', sources: [] },
  'EX-2': { description: null, sources: [] },
  'EX-3': { description: '<img src=x onerror="window.hacked=1"> **not bold** `code`', sources: [] },
  'EX-4': {
    description: null,
    sources: [
      { path: 'docs/auth.md', anchor: '§ 2', role: 'spec' },
      { path: 'docs/notes.md', anchor: null, role: null },
    ],
  },
};
const MISSION = '## What and why\n\nThe derived summary from the mission.\n\n## Steps\n\n1. Do it.';

function makeQueue() {
  const iso = new Date(Date.now() - 86_400_000).toISOString();
  const task = (id: string, value: number, extra: Record<string, unknown> = {}) => ({
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
    added_at: iso,
    ...extra,
  });
  return {
    created: iso,
    limits: { maxConcurrent: 5, maxDPlus: 2, maxPerDomain: 5, maxDb: 2 },
    tasks: [
      task('EX-1', 9),
      task('EX-2', 8),
      task('EX-3', 7),
      task('EX-4', 6, { plan: 'PL-AUTH', source: 'review of EX-0, finding M1' }),
    ],
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
const posts: { path: string; body: any }[] = [];
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
  w.fetch = async (filePath: string, init?: { method?: string; body?: string }) => {
    if (init?.method === 'POST') posts.push({ path: filePath, body: JSON.parse(init.body ?? '{}') });
    return {
      ok: true,
      status: 200,
      json: async () => {
        if (filePath.startsWith('/api/state'))
          return filePath.includes(`version=${state.version}`) ? { version: state.version, unchanged: true } : state;
        if (filePath === '/api/task-edit') return { ok: true, log: 7 };
        const task = /^\/api\/task\?id=([^&]+)/.exec(filePath);
        if (task) {
          const id = decodeURIComponent(task[1]);
          return {
            ok: true,
            mission: { text: MISSION, path: null },
            branch: { name: `queue/${id}`, exists: false },
            ...DETAILS[id],
          };
        }
        return { ok: true };
      },
    };
  };
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
/** The Details fact with this label: its dd, or null. */
const fact = (label: string) => {
  const dt = [...panel().querySelectorAll('dl.facts > dt')].find((d) => d.textContent === label);
  return (dt?.nextElementSibling as HTMLElement | null) ?? null;
};

describe('the description in the panel', () => {
  it('is shown at the top, in the place of the derived summary, above the actions and the mission', async () => {
    await open('EX-1');
    const kids = [...panel().children];
    const top = panel().querySelector('.panel-summary') as HTMLElement;
    expect(top.textContent).toBe('Users see how long they kept a habit going.');
    expect(top.classList.contains('panel-description')).toBe(true);
    expect(panel().querySelectorAll('.panel-summary').length).toBe(1);
    expect(kids.indexOf(top)).toBeLessThan(kids.indexOf(panel().querySelector('.actions') as Element));
    expect(kids.indexOf(top)).toBeLessThan(kids.indexOf(panel().querySelector('section.mission') as Element));
    // The derived summary is not shown as well (it is still in the mission itself).
    expect(top.textContent).not.toContain('derived summary');
  });

  it('falls back to the derived mission summary without a description', async () => {
    await open('EX-2');
    const top = panel().querySelector('.panel-summary') as HTMLElement;
    expect(top.textContent).toBe('The derived summary from the mission.');
    expect(top.classList.contains('panel-description')).toBe(false);
  });

  it('is text, never markup: HTML and markdown are shown as written', async () => {
    w.hacked = 0;
    await open('EX-3');
    const top = panel().querySelector('.panel-summary') as HTMLElement;
    expect(top.textContent).toBe('<img src=x onerror="window.hacked=1"> **not bold** `code`');
    expect(top.querySelector('img, strong, code')).toBeNull();
    expect(w.hacked).toBe(0);
  });
});

describe('the task own sources in Details', () => {
  it('lists each source with its anchor and role, between the plan entry and the source', async () => {
    await open('EX-4');
    const dd = fact('Sources');
    expect(dd).not.toBeNull();
    const items = [...(dd as HTMLElement).querySelectorAll('li')].map((li) => li.textContent);
    expect(items).toEqual(['docs/auth.md§ 2spec', 'docs/notes.md']);
    expect((dd as HTMLElement).querySelector('code')?.textContent).toBe('docs/auth.md');
    const labels = [...panel().querySelectorAll('dl.facts > dt')].map((d) => d.textContent);
    expect(labels.indexOf('Plan entry')).toBeLessThan(labels.indexOf('Sources'));
    expect(labels.indexOf('Sources')).toBeLessThan(labels.indexOf('Source'));
    expect(fact('Source')?.textContent).toContain('review of EX-0, finding M1');
  });

  it('no Sources fact for a task without its own sources', async () => {
    await open('EX-1');
    expect(fact('Sources')).toBeNull();
  });
});

describe('the description in the Edit form', () => {
  const editButton = () =>
    [...panel().querySelectorAll('.actions button')].find((b) => b.textContent === 'Edit') as HTMLButtonElement;
  const save = () => (panel().querySelector('.task-edit button[type="submit"]') as HTMLButtonElement).click();
  const edits = () => posts.filter((p) => p.path === '/api/task-edit').map((p) => p.body);

  it('starts from the description, is labelled, and is not sent when unchanged', async () => {
    posts.length = 0;
    await open('EX-1');
    editButton().click();
    await flush();
    const field = panel().querySelector('#edit-description') as HTMLTextAreaElement;
    expect(field).not.toBeNull();
    expect(field.value).toBe('Users see how long they kept a habit going.');
    expect(panel().querySelector('label[for="edit-description"]')?.textContent).toMatch(/Description/);
    save();
    await flush();
    expect(edits()).toEqual([{ type: 'edit', id: 'EX-1', form: { value: '9', content_min: '30', class: 'K' } }]);
  });

  it('sends a changed description, and "" to remove it', async () => {
    posts.length = 0;
    await open('EX-2');
    editButton().click();
    await flush();
    const field = panel().querySelector('#edit-description') as HTMLTextAreaElement;
    expect(field.value).toBe('');
    field.value = 'A new summary.';
    field.dispatchEvent(new Event('input'));
    save();
    await flush();
    await open('EX-1');
    editButton().click();
    await flush();
    const again = panel().querySelector('#edit-description') as HTMLTextAreaElement;
    again.value = '';
    again.dispatchEvent(new Event('input'));
    save();
    await flush();
    expect(edits()).toEqual([
      { type: 'edit', id: 'EX-2', form: { value: '8', content_min: '30', class: 'K', description: 'A new summary.' } },
      { type: 'edit', id: 'EX-1', form: { value: '9', content_min: '30', class: 'K', description: '' } },
    ]);
  });
});
