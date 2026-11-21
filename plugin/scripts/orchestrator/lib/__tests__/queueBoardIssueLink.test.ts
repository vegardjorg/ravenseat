/**
 * @vitest-environment jsdom
 */
// =============================================================
// queueBoardIssueLink.test.ts: the GitHub issue link on the board (GH-2): the card badge and the Issue fact in the
// detail panel.
//
// What the tests prove:
//   - the server gives the card { label: 'Issue #12', url } built from the stored repo and number, and null for a
//     link whose repo is not a plain owner/name (so a hand-edited queue.json cannot inject a URL);
//   - the card shows "Issue #12" as a link to github.com, rel noopener noreferrer, a new tab, not a tab stop of its
//     own (roving tabindex), and a click on it does not open the panel;
//   - the panel has an Issue fact with a real, focusable link; a task without a link has neither.
// The whole board runs in jsdom with a small synthetic queue (no real data); /api/task is stubbed.
// =============================================================
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { clientSource } from './boardClient';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const T = require('../queueBoard.js') as { board: (queue: unknown, option?: unknown) => any };

const CLIENT = join(__dirname, '..', '..', 'queue-board');

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
      task('EX-1', 9, { issue: { repo: 'acme/tool', number: 12 } }),
      task('EX-2', 8),
      task('EX-3', 7, { issue: { repo: 'evil.example/x" onmouseover="alert(1)', number: 3 } }),
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
const w = window as any;
let data: any;

beforeAll(async () => {
  data = T.board(makeQueue());
  const state = { version: 'v1', data: { ...data, gitError: null, logo: false } };
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
        return { ok: true, mission: { text: '## What\n\nX.', path: null }, branch: { name: `queue/${id}`, exists: false }, description: null, sources: [] };
      }
      return { ok: true };
    },
  });
  for (const f of ['a11y.js', '../lib/queueGraph.js', 'graph.js', 'plan.js', 'performance.js', 'board/'])
    (0, eval)(clientSource(f));
  await flush();
}, 60_000);

const panel = () => document.getElementById('panel') as HTMLElement;
const card = (id: string) => document.querySelector(`.summary[data-id="${id}"]`) as HTMLElement;
async function open(id: string) {
  if (!panel().hidden) (panel().querySelector('.button-icon') as HTMLButtonElement).click();
  (card(id).querySelector('.summary-button') as HTMLButtonElement).click();
  await flush();
  expect(panel().hidden).toBe(false);
}
const fact = (label: string) => {
  const dt = [...panel().querySelectorAll('dl.facts > dt')].find((d) => d.textContent === label);
  return (dt?.nextElementSibling as HTMLElement | null) ?? null;
};
const allCards = () => Object.values(data.columns as Record<string, any[]>).flat();

describe('the issue link from the server', () => {
  it('is built from the stored repo and number, and null for a repo that is not owner/name', () => {
    const by = (id: string) => allCards().find((k) => k.id === id);
    expect(by('EX-1').issue).toEqual({ repo: 'acme/tool', number: 12, label: 'Issue #12', url: 'https://github.com/acme/tool/issues/12' });
    expect(by('EX-2').issue).toBeNull();
    expect(by('EX-3').issue).toBeNull();
  });
});

describe('the issue badge on the card', () => {
  it('is a link to github.com in a new tab, rel noopener, not a tab stop of its own', () => {
    const a = card('EX-1').querySelector('a.issue-badge') as HTMLAnchorElement;
    expect(a).not.toBeNull();
    expect(a.textContent).toBe('Issue #12');
    expect(a.getAttribute('href')).toBe('https://github.com/acme/tool/issues/12');
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toMatch(/\bnoopener\b/);
    expect(a.getAttribute('tabindex')).toBe('-1');
    expect(card('EX-2').querySelector('.issue-badge')).toBeNull();
    expect(card('EX-3').querySelector('.issue-badge')).toBeNull();
  });

  it('a click on it does not open the panel', async () => {
    if (!panel().hidden) (panel().querySelector('.button-icon') as HTMLButtonElement).click();
    const a = card('EX-1').querySelector('a.issue-badge') as HTMLAnchorElement;
    a.addEventListener('click', (e) => e.preventDefault()); // jsdom: no navigation
    a.click();
    await flush();
    expect(panel().hidden).toBe(true);
  });
});

describe('the Issue fact in the panel', () => {
  it('is a focusable link for a linked task, and absent without a link', async () => {
    await open('EX-1');
    const a = fact('Issue')?.querySelector('a') as HTMLAnchorElement;
    expect(a).not.toBeNull();
    expect(a.textContent).toBe('Issue #12 on GitHub');
    expect(a.getAttribute('href')).toBe('https://github.com/acme/tool/issues/12');
    expect(a.getAttribute('rel')).toMatch(/\bnoopener\b/);
    expect(a.hasAttribute('tabindex')).toBe(false);
    await open('EX-2');
    expect(fact('Issue')).toBeNull();
  });
});
