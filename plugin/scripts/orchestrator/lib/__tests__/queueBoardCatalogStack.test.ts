/**
 * @vitest-environment jsdom
 */
// =============================================================
// queueBoardCatalogStack.test.ts: the stack card in the board's "Project catalog" (board/decide.js catalogItem with
// lib/catalog.js boardGroups, roadmap 0å KD-3, plans/katalog-design-stack-avhengigheter-2026-11-18.md § 7).
//   - A stack entry's card says the tool for the job ("Uses: zod for validation") and what it was chosen over.
//   - A design or decision card has neither line.
// The whole board runs in jsdom with a small synthetic queue and catalog (no real data).
// =============================================================
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { clientSource } from './boardClient';

/* eslint-disable @typescript-eslint/no-require-imports */
const T = require('../queueBoard.js') as { board: (queue: unknown, option?: unknown) => any };
const KK = require('../queueConfig.js') as any;
/* eslint-enable @typescript-eslint/no-require-imports */

const CLIENT = join(__dirname, '..', '..', 'queue-board');
const iso = new Date(Date.now() - 86_400_000).toISOString();

const queue = {
  created: iso,
  limits: { maxConcurrent: 5, maxDPlus: 2, maxPerDomain: 5, maxDb: 2 },
  tasks: [],
  projects: { ex: { title: 'Example', prefixes: ['EX-'] } },
  areas: {},
  question: [],
  resolutions: [],
  changelog: [],
};
const entry = (own: object) => ({ title: '', status: 'accepted', invariant: null, paths: ['src/**'], except: [], source: null, uses: null, alternatives: [], file: null, ...own });
const state = {
  version: 'v1',
  data: {
    ...T.board(queue),
    gitError: null,
    logo: false,
    features: KK.features(KK.STANDARD),
    boardSwitches: KK.boardSwitches(KK.STANDARD, null),
    catalogGroups: [
      { kind: 'stack', title: 'Stack', entries: [entry({ id: 'D-0002', title: 'Validation with zod', uses: { job: 'validation', tool: 'zod' }, alternatives: ['yup', 'joi'] })] },
      { kind: 'decision', title: 'Design choices', entries: [entry({ id: 'D-0003', title: 'Paths are normalized' })] },
    ],
  },
};

const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};
const item = (id: string) =>
  [...document.querySelectorAll('.decide-nb-item')].find((li) => li.querySelector('.sp-id')?.textContent === id) as HTMLElement;
const metas = (id: string) => [...item(id).querySelectorAll('.decide-nb-meta')].map((p) => p.textContent);

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
        : filePath.startsWith('/api/settings')
          ? { ok: false, message: 'not in this test' }
          : { ok: true, message: 'ok', info: [] },
  });
  for (const f of ['a11y.js', '../lib/queueGraph.js', 'graph.js', 'plan.js', 'performance.js', '../lib/queueDecisions.js', 'board/'])
    (0, eval)(clientSource(f));
  await flush();
  (document.getElementById('show-decisions') as HTMLElement).click();
  await flush();
}, 60_000);

describe('the stack card in the project catalog', () => {
  it('says the tool for the job and what it was chosen over', () => {
    expect(item('D-0002')).toBeTruthy();
    expect(metas('D-0002')).toContain('Uses: zod for validation');
    expect(metas('D-0002')).toContain('Chosen over: yup, joi');
  });

  it('a decision card has neither line', () => {
    expect(metas('D-0003').some((m) => /^Uses:|^Chosen over:/.test(m ?? ''))).toBe(false);
  });
});
