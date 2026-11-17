/**
 * @vitest-environment jsdom
 */
// =============================================================
// queueBoardBuildGate.test.ts: the "Build as gate" button on the Checks tab's card ledger-recipes (0i step 7,
// plans/feillogg-til-gater-2026-11-15.md section 3.7 point 3).
//   - A due class and area with nothing proposed yet (proposal state add) has the button; a click posts
//     { action: 'build-gate', item: '<class>@<area>' } to /api/checks, the same keyed write as the other buttons.
//   - The cap full (state full) shows that it waits, with no button; an open proposal (extend) names its task.
//   - The card quick-gate-add (0i step 9b) lists each guard's exact command with an "Add to gates.quick" button that posts
//     { action: 'quick-add', item: <guard id> } (never the command), and the card has no button of its own.
// The whole board runs in jsdom with a small synthetic queue and report (no real data).
// =============================================================
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { clientSource } from './boardClient';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const T = require('../queueBoard.js') as { board: (queue: unknown, option?: unknown) => any };
const KK = require('../queueConfig.js') as { STANDARD: Record<string, unknown>; features: (cfg?: unknown) => Record<string, boolean>; boardSwitches: (cfg?: unknown, queue?: unknown) => Record<string, boolean> };
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
const state = {
  version: 'v1',
  data: {
    ...T.board(queue),
    gitError: null,
    logo: false,
    features: KK.features(KK.STANDARD),
    boardSwitches: KK.boardSwitches(KK.STANDARD, null),
    checksPanel: true,
  },
};

const item = (key: string, area: string, proposal: { state: string; task: string | null }) => ({
  key,
  class: key.split('@')[0],
  title: 'unchecked error or result',
  area,
  scope: 'area',
  incidents: 2,
  severity: 'M',
  tasks: ['A-1', 'B-2'],
  files: [`${area}/save.ts`],
  stacks: ['typescript'],
  proposal,
  recipe: { id: 'r1', title: 'A lint rule', text: 'Turn on the rule.', cards: [] },
});

const report = {
  stacks: [],
  found: { kinds: [], ci: [] },
  categories: [{ key: 'tests', title: 'Tests', text: '' }],
  catalogErrors: [],
  knownBugs: null,
  recipePrecision: {
    on: true,
    floor: 30,
    min: 5,
    minDb: 10,
    recipes: [
      { id: 'contract-drift-type-check', title: 'Type check', class: 'contract-drift', db: false, proposals: 5, accepted: 1, declined: 4, pending: 0, rate: 20, damped: true, by: 'auto', override: null },
      { id: 'access-control-supabase', title: 'Probes', class: 'access-control', db: true, proposals: 1, accepted: 0, declined: 0, pending: 1, rate: null, damped: false, by: null, override: null },
    ],
    classes: [],
    damped: ['contract-drift-type-check'],
  },
  suggestions: [
    {
      key: 'ledger-recipes',
      title: 'A kind of failure keeps coming back: what would guard it',
      category: 'tests',
      priority: 'medium',
      why: 'The finding log shows it.',
      contentMin: 15,
      action: 'ask',
      ask: 'Ask Claude.',
      applies: true,
      state: 'open',
      taskId: null,
      ledger: {
        items: [
          item('unchecked-error@src/api', 'src/api', { state: 'add', task: null }),
          item('null-undefined@src/ui', 'src/ui', { state: 'full', task: null }),
          item('race-condition@src/jobs', 'src/jobs', { state: 'extend', task: 'GATE-4' }),
          // A class whose only recipe is damped by its precision (0i step 9): named, not offered.
          { ...item('contract-drift@src/lib', 'src/lib', { state: 'extend', task: 'GATE-5' }), recipe: null, damped: [{ id: 'contract-drift-type-check', title: 'Type check' }] },
        ],
        more: 0,
        capFull: false,
      },
    },
    {
      key: 'quick-gate-add',
      title: 'Run a built gate guard on every merge',
      category: 'tests',
      priority: 'medium',
      why: 'Its command is not in gates.quick.',
      contentMin: 5,
      action: 'quick-gate',
      applies: true,
      state: 'open',
      taskId: null,
      detail: 'Not in gates.quick: G-1.',
      quickGate: [{ guard: 'G-1', title: 'Lint for unchecked results', command: 'npm run lint:api', task: 'GATE-1', inFull: false }],
    },
  ],
};

const posts: { file: string; body: any }[] = [];
const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};

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
  w.fetch = async (filePath: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
    if (init?.method === 'POST') posts.push({ file: filePath, body: JSON.parse(init.body ?? '{}') });
    return {
      ok: true,
      status: 200,
      json: async () =>
        filePath.startsWith('/api/state')
          ? filePath.includes(`version=${state.version}`)
            ? { version: state.version, unchanged: true }
            : state
          : filePath.startsWith('/api/checks')
            ? { ok: true, report, message: 'GATE-1 proposed' }
            : {},
    };
  };
  for (const f of ['a11y.js', '../lib/queueGraph.js', 'graph.js', 'plan.js', 'performance.js', 'board/'])
    (0, eval)(clientSource(f));
  await flush();
}, 60_000);

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const buttons = () => [...document.querySelectorAll<HTMLButtonElement>('.checks-places button')].filter((b) => b.textContent === 'Build as gate');

describe('the Build as gate button', () => {
  it('shows on a class and area with nothing proposed, and posts its key to /api/checks', async () => {
    $('show-checks').click();
    await flush();
    expect(buttons()).toHaveLength(1);
    buttons()[0].click();
    await flush();
    expect(posts).toContainEqual({ file: '/api/checks', body: { action: 'build-gate', item: 'unchecked-error@src/api' } });
  });

  it('the cap full says it waits, with no button; an open proposal names its task', () => {
    const text = document.querySelector('.checks-places')?.textContent ?? '';
    expect(text).toMatch(/waits for a free slot/i);
    expect(text).toContain('Proposed as GATE-4');
    expect(buttons()).toHaveLength(1);
  });
});

describe('recipe precision on the Checks tab (0i step 9)', () => {
  it('lists each measured recipe with its proposals, the accepted share and whether it is damped', () => {
    const text = document.querySelector('.checks-precision')?.textContent ?? '';
    expect(text).toContain('Type check: 5 proposals, 1 accepted (20%), damped.');
    expect(text).toContain('Probes (database): 1 proposals, none decided yet, 1 waiting, shown.');
  });

  it('a damped recipe is named on the card, not offered as its recipe', () => {
    const card = [...document.querySelectorAll('.checks-places')].find((u) => !u.classList.contains('checks-precision'))?.textContent ?? '';
    expect(card).toContain('Damped recipe, listed under Recipe precision and not offered here: contract-drift-type-check.');
    expect(card).not.toMatch(/Contract drift[^.]*No recipe yet/);
  });
});

describe('the card "Run a built gate guard on every merge" (0i step 9b)', () => {
  const card = () => [...document.querySelectorAll('.checks-suggestion')].find((c) => c.textContent?.includes('Run a built gate guard')) as HTMLElement;

  it('shows the exact command and posts only the guard id', async () => {
    expect(card().textContent).toContain('npm run lint:api');
    const add = [...card().querySelectorAll<HTMLButtonElement>('button')].filter((b) => b.textContent === 'Add to gates.quick');
    expect(add).toHaveLength(1);
    expect(add[0].title).toContain('Nothing runs now');
    add[0].click();
    await flush();
    expect(posts).toContainEqual({ file: '/api/checks', body: { action: 'quick-add', item: 'G-1' } });
    expect(JSON.stringify(posts)).not.toContain('npm run lint:api');
  });

  it('has no card-wide button (no investigation, no turn on)', () => {
    const texts = [...card().querySelectorAll('button')].map((b) => b.textContent);
    expect(texts).not.toContain('Add investigation to queue');
    expect(texts).not.toContain('Turn on');
  });
});
