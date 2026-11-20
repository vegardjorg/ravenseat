/**
 * @vitest-environment jsdom
 */
// =============================================================
// queuePlanDocSearch.test.ts: P5 of plans/plans-tab-ux-review-2026-11-19.md, full-text search in the plan documents.
//
// What the tests prove:
//   - the pure rules (lib/queuePlanView.js): a document becomes plain passages (markup stripped, code skipped, the
//     heading above each passage kept), a search finds the sentence with the match, case-insensitive, clipped to a
//     short snippet with the match itself apart, so the view can mark it with textContent only,
//   - plans whose document matches come after the plans whose own words match (title and summary rank first), and
//     only when they also fit the filters; each carries its hit,
//   - the server reader (lib/queueBoard.js planDocSearcher) searches only the plan document (planSource, the
//     document folders), at its anchor's section, through the /api/doc guard with the size cap, and reads a file once
//     while its time and size stay the same,
//   - the setting plans.searchDocuments is on by default and checked on its own,
//   - the Roadmap card shows the snippet under the row with the match in a <mark>, and HTML in a document stays text.
// =============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const V = require('../queuePlanView.js') as any;
const T = require('../queueBoard.js') as any;
const KK = require('../queueConfig.js') as any;
const REG = require('../settingsRegistry.js') as any;
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

type Post = Record<string, unknown>;

const DOC = [
  '# Sync',
  '',
  '## 1. Scope',
  '',
  'The app works offline. It keeps a **local copy** of the streaks and syncs them when the train leaves the tunnel.',
  'Nothing else changes.',
  '',
  '```js',
  'const tunnel = "not prose";',
  '```',
  '',
  '## 2. Design',
  '',
  '- A queue of changes, sent in order.',
  '- Conflicts: the newest write wins.',
  '',
].join('\n');

describe('the passages and the hit (pure)', () => {
  it('finds the sentence with the match, with the heading above it and the match apart', () => {
    const hit = V.documentHit(V.documentPassages(DOC), 'TUNNEL');
    expect(hit).toEqual({
      heading: '1. Scope',
      before: 'It keeps a local copy of the streaks and syncs them when the train leaves the ',
      match: 'tunnel',
      after: '.',
    });
  });

  it('skips code, finds list points, and gives null without a match or for a short query', () => {
    const passages = V.documentPassages(DOC);
    expect(passages.some((p: Post) => String(p.text).includes('not prose'))).toBe(false);
    expect(V.documentHit(passages, 'newest write')).toEqual({
      heading: '2. Design',
      before: 'Conflicts: the ',
      match: 'newest write',
      after: ' wins.',
    });
    expect(V.documentHit(passages, 'billing')).toBe(null);
    expect(V.documentHit(passages, 'tu')).toBe(null);
  });

  it('clips a long sentence near the match with an ellipsis', () => {
    const long = `${'word '.repeat(60)}needle ${'more '.repeat(60)}end.`;
    const hit = V.documentHit(V.documentPassages(long), 'needle');
    expect(hit.match).toBe('needle');
    expect(hit.before.startsWith('…')).toBe(true);
    expect(hit.after.endsWith('…')).toBe(true);
    expect(hit.before.length).toBeLessThanOrEqual(V.DOC_HIT_SIDE + 2);
    expect(hit.after.length).toBeLessThanOrEqual(V.DOC_HIT_SIDE + 2);
  });

  it('treats the query as text, not as a pattern', () => {
    expect(V.documentHit(V.documentPassages('Costs (a) lot.'), '(a)')?.match).toBe('(a)');
    expect(V.documentHit(V.documentPassages('Costs a lot.'), '.*.')).toBe(null);
  });
});

function entry(id: string, extra: Post = {}): Post {
  return {
    id,
    title: `Title ${id}`,
    summary: null,
    project: 'auth',
    module: 'account',
    priority: 'later',
    now_category: [],
    maturity: 'idea',
    sources: [],
    ownerQuestions: [],
    legal_open: 0,
    queue: [],
    history: [],
    blocks: [],
    ...extra,
  };
}

describe('search with the document hits (pure)', () => {
  const entries = [
    entry('PL-DOC', { priority: 'now' }),
    entry('PL-TITLE', { title: 'Offline sync', priority: 'later' }),
    entry('PL-OTHER', { priority: 'next', module: 'data' }),
  ];
  const hit = { heading: null, before: 'Works ', match: 'offline', after: '.' };

  it('own matches first, then the plans found in their document, each with its hit', () => {
    const hits = new Map([
      ['PL-DOC', hit],
      ['PL-TITLE', hit],
    ]);
    const list = V.searchWithDocuments(entries, V.emptyFilter(), 'offline', hits, { sort: 'roadmap' });
    expect(list.map((p: Post) => p.id)).toEqual(['PL-TITLE', 'PL-DOC']);
    expect(list[0].docHit).toBeUndefined();
    expect(list[1].docHit).toEqual(hit);
  });

  it('a document hit still has to fit the filters, and without a search nothing is added', () => {
    const hits = new Map([['PL-OTHER', hit]]);
    const filter = { ...V.emptyFilter(), module: ['account'] };
    expect(V.searchWithDocuments(entries, filter, 'offline', hits).map((p: Post) => p.id)).toEqual(['PL-TITLE']);
    expect(V.searchWithDocuments(entries, V.emptyFilter(), '', hits).map((p: Post) => p.id)).toEqual(
      V.filter(entries, V.emptyFilter(), '').map((p: Post) => p.id),
    );
  });

  it('the status line says what the documents added', () => {
    expect(V.docSearchText(0, { busy: true })).toBe('Searching the plan documents…');
    expect(V.docSearchText(0)).toBe(null);
    expect(V.docSearchText(1)).toBe('1 more plan found in the plan documents');
    expect(V.docSearchText(3, { partial: true })).toBe(
      '3 more plans found in the plan documents (the search stopped early; a longer search finds the rest)',
    );
  });

  it('in an area section the own matches stay above the document hits', () => {
    const hits = new Map([['PL-DOC', hit]]);
    const list = V.searchWithDocuments(entries, V.emptyFilter(), 'offline', hits);
    const [account] = V.roadmapSections(list, { group: 'area', modules: [{ oid: 'account', title: 'Account' }] });
    expect(account.entries.map((p: Post) => p.id)).toEqual(['PL-TITLE', 'PL-DOC']);
  });
});

describe('planDocSearcher (server)', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-search-'));
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs', 'plan.md'), DOC);
    fs.writeFileSync(path.join(root, 'docs', 'shared.md'), '# All\n\n## 1. Apples\n\nApples here.\n\n## 2. Bananas\n\nBananas here.\n');
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function countingFs() {
    const counter = { reads: 0 };
    const io = {
      fs: {
        ...fs,
        readFileSync: (...a: unknown[]) => {
          counter.reads += 1;
          return (fs.readFileSync as any)(...a);
        },
      },
      path,
    };
    return { io, counter };
  }

  it('finds a plan by the words in its plan document, with the path it came from', () => {
    const { io } = countingFs();
    const search = T.planDocSearcher(root, io);
    const r = search([entry('PL-SYNC', { sources: [{ path: 'docs/plan.md', role: 'plan' }] })], 'tunnel');
    expect(r.hits).toEqual([
      {
        id: 'PL-SYNC',
        path: 'docs/plan.md',
        heading: '1. Scope',
        before: 'It keeps a local copy of the streaks and syncs them when the train leaves the ',
        match: 'tunnel',
        after: '.',
      },
    ]);
    expect(r.partial).toBe(false);
  });

  it('searches only the section of the anchor in a shared document', () => {
    const { io } = countingFs();
    const search = T.planDocSearcher(root, io);
    const list = [
      entry('PL-A', { sources: [{ path: 'docs/shared.md', anchor: '§ 1', role: 'plan' }] }),
      entry('PL-B', { sources: [{ path: 'docs/shared.md', anchor: '§ 2', role: 'plan' }] }),
    ];
    expect(search(list, 'bananas').hits.map((x: Post) => x.id)).toEqual(['PL-B']);
  });

  it('reads a file once while it is unchanged, also for many plans and searches', () => {
    const { io, counter } = countingFs();
    const search = T.planDocSearcher(root, io);
    const list = ['PL-A', 'PL-B'].map((id) => entry(id, { sources: [{ path: 'docs/shared.md', role: 'plan' }] }));
    search(list, 'apples');
    search(list, 'bananas');
    expect(counter.reads).toBe(1);
    const file = path.join(root, 'docs', 'shared.md');
    fs.writeFileSync(file, '# All\n\nCherries now.\n');
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(file, later, later);
    expect(search(list, 'cherries').hits.length).toBe(2);
    expect(counter.reads).toBe(2);
  });

  it('reads nothing outside the folders, for a missing file, a large one, or a short query', () => {
    const { io, counter } = countingFs();
    const search = T.planDocSearcher(root, io, { max: 64 });
    const list = [
      entry('PL-OUT', { sources: [{ path: '../outside.md', role: 'plan' }] }),
      entry('PL-MISS', { sources: [{ path: 'docs/missing.md', role: 'plan' }] }),
      entry('PL-BIG', { sources: [{ path: 'docs/plan.md', role: 'plan' }] }), // over 64 bytes
      entry('PL-NONE'),
    ];
    expect(search(list, 'tunnel').hits).toEqual([]);
    expect(T.planDocSearcher(root, io)(list, 'tu').hits).toEqual([]);
    expect(counter.reads).toBe(0);
  });

  it('stops at the limit', () => {
    const { io } = countingFs();
    const search = T.planDocSearcher(root, io);
    const list = ['PL-1', 'PL-2', 'PL-3'].map((id) => entry(id, { sources: [{ path: 'docs/shared.md', role: 'plan' }] }));
    expect(search(list, 'here', { limit: 2 }).hits.length).toBe(2);
  });
});

describe('the setting', () => {
  it('plans.searchDocuments is on by default, checked on its own, and has a registry row', () => {
    expect(KK.STANDARD.plans.searchDocuments).toBe(true);
    expect(KK.plansView({}).searchDocuments).toBe(true);
    expect(KK.plansView({ plans: { searchDocuments: false } }).searchDocuments).toBe(false);
    expect(KK.plansView({ plans: { searchDocuments: 'no' } }).searchDocuments).toBe(true);
    const rows = (REG.REGISTRY ?? REG.rows ?? REG.SETTINGS) as Post[];
    expect(rows.some((r) => r.key === 'plans.searchDocuments')).toBe(true);
  });
});

describe('the snippet under the Roadmap row', () => {
  const CLIENT = path.join(__dirname, '..', '..', 'queue-board');
  const roadmapJs = fs.readFileSync(path.join(CLIENT, 'plans', 'roadmap.js'), 'utf8');

  function el(tag: string, attr: Record<string, unknown> | null, ...children: unknown[]) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attr ?? {})) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = String(v);
      else if (k === 'text') e.textContent = String(v);
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v as EventListener);
      else if (k.startsWith('--')) e.style.setProperty(k, String(v));
      else e.setAttribute(k, v === true ? '' : String(v));
    }
    for (const b of (children as unknown[]).flat()) if (b != null && b !== false) e.append(b as Node);
    return e;
  }

  it('shows the matching sentence with the match marked, as text only', () => {
    const w: any = { QueuePlanView: V };
    new Function('window', roadmapJs)(w);
    const t = { filter: V.emptyFilter(), search: 'tunnel', surface: 'roadmap', entry: null };
    const h = {
      el,
      state: () => t,
      use: () => {},
      width: () => 1000,
      prefs: () => ({ layout: 'list', group: 'horizon', compact: false }),
      setPref: () => {},
      isExpanded: () => false,
      toggleExpanded: () => {},
      activeFilters: () => el('div', null),
      search: () => {},
    };
    const hit = { heading: '1. Scope', before: 'Leaves the <b>', match: 'tunnel', after: '</b> soon.' };
    const p = { ...entry('PL-SYNC', { priority: 'now' }), docHit: hit };
    const d = { exists: true, modules: [], projects: {}, entries: [p], view: {} };
    const node = w.QueuePlanRoadmap.cells(h, d, [p]);
    document.body.replaceChildren(node);
    const card = node.querySelector('[data-roadmap-entry="PL-SYNC"]') as HTMLElement;
    const snippet = card.querySelector('.plans-doc-hit') as HTMLElement;
    expect(snippet).not.toBe(null);
    expect(snippet.querySelector('mark')?.textContent).toBe('tunnel');
    expect(snippet.querySelector('b')).toBe(null); // the HTML in the document stays text
    expect(snippet.textContent).toContain('Leaves the <b>tunnel</b> soon.');
    expect(snippet.textContent).toContain('1. Scope');
    const described = String(card.querySelector('.roadmap-card-link')?.getAttribute('aria-describedby'));
    expect(described.split(' ')).toContain(snippet.id);
  });
});
