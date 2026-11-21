/**
 * @vitest-environment jsdom
 */
// =============================================================
// zoneBoard.test.ts: sensitive zones on the board and at add (PG-5, lib/catalogZones.js, board/cards.js, panel.js,
// decide.js; plans/plan-gate-vurdering-2026-11-21.md section 6).
//
// What the tests prove:
//   - zones.detect is on by default and off only for false; off gives no zones at all (zonesOnDisk),
//   - the NOTE line says "is in" for a file or category hit and "may touch" for keywords alone,
//   - the server gives a card `zone` only when the caller passed zonesFor and there is a hit, never for a done task,
//   - the card shows the "Sensitive zone" or "May touch a zone" badge with a tooltip, and the panel a fact,
//   - a zone entry in the Decisions catalog shows its reason and keywords, and no "Applies to" line without paths.
// The whole board runs in jsdom with a small synthetic queue (no real data).
// =============================================================
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { clientSource } from './boardClient';

/* eslint-disable @typescript-eslint/no-require-imports */
const T = require('../queueBoard.js') as { board: (queue: unknown, option?: unknown) => any };
const Z = require('../catalogZones.js') as any;
const KK = require('../queueConfig.js') as any;
const C = require('../catalog.js') as any;
/* eslint-enable @typescript-eslint/no-require-imports */

const CLIENT = join(__dirname, '..', '..', 'queue-board');
const NOW = Date.now();
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

const task = (id: string, own: object = {}) => ({
  id,
  title: `Task ${id}`,
  domain: 'ui',
  class: 'K',
  value: 5,
  content_min: 30,
  status: 'waiting',
  depends_on: [],
  waiting_on: [],
  owned_files: [`file/${id}.ts`],
  owner_db: [],
  shared_patch: [],
  mission: 'Do the thing.',
  added_by: 'test',
  added_at: ago(600),
  ...own,
});

const FILE_HIT = { id: 'D-0001', title: 'Sign-in', reason: 'Hard to undo.', why: 'files', detail: 'src/auth/a.ts' };
const WORD_HIT = { id: 'D-0002', title: 'Keys', reason: '', why: 'keyword', detail: 'encrypt' };

/** ZN-1 owns a zone file, ZN-2 only names a keyword, ZN-3 meets nothing, ZN-4 is done (no badge even with a hit). */
const hitsFor = (o: any) => (o.id === 'ZN-1' || o.id === 'ZN-4' ? [FILE_HIT] : o.id === 'ZN-2' ? [WORD_HIT] : []);
const queue = {
  created: ago(1000),
  limits: { maxConcurrent: 5, maxDPlus: 2, maxPerDomain: 5, maxDb: 2 },
  tasks: [task('ZN-1'), task('ZN-2'), task('ZN-3'), task('ZN-4', { status: 'done', done: ago(10) })],
  projects: { zn: { title: 'Example', prefixes: ['ZN-'] } },
  areas: {},
  question: [],
  resolutions: [],
  changelog: [],
};

const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};
const summaryOf = (data: any, id: string) =>
  Object.values(data.columns as Record<string, any[]>)
    .flat()
    .find((k: any) => k.id === id);
const card = (id: string) => document.querySelector(`.summary[data-id="${id}"]`) as HTMLElement | null;

let data: any;
beforeAll(async () => {
  data = T.board(queue, { zonesFor: hitsFor });
  const state = {
    version: 'v1',
    data: {
      ...data,
      gitError: null,
      logo: false,
      features: KK.features(KK.STANDARD),
      boardSwitches: KK.boardSwitches(KK.STANDARD, null),
      catalogGroups: [
        {
          kind: 'zone',
          title: 'Sensitive zones',
          entries: [
            { id: 'D-0009', title: 'Encryption and keys', status: 'proposed', invariant: null, reason: 'A lost key loses data.', keywords: ['encrypt', 'kms'], paths: [], except: [], source: null, uses: null, alternatives: [], file: null },
          ],
        },
      ],
    },
  };
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
}, 60_000);

describe('the zones.detect switch', () => {
  it('is on by default and off only for false', () => {
    expect(KK.STANDARD.zones).toEqual({ detect: true });
    expect(Z.zonesSetup({}).detect).toBe(true);
    expect(Z.zonesSetup({ zones: { detect: false } }).detect).toBe(false);
    expect(Z.zonesSetup({ zones: 'odd' }).detect).toBe(true);
  });

  it('off gives no zones even with an accepted zone on disk', () => {
    const root = mkdtempSync(join(tmpdir(), 'zones-'));
    const dir = join(root, 'docs', 'queue', 'catalog', 'decisions');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'D-0001-sign-in.md'),
      '---\nid: D-0001\ntitle: Sign-in\nkind: zone\nstatus: accepted\npaths: ["src/auth/**"]\nreason: Hard to undo.\n---\n',
    );
    // The owner's accept lives in the data folder's record, not in the frontmatter (lib/catalog.js recordAccept).
    const cat = C.readCatalog(join(root, 'docs', 'queue', 'catalog'));
    let ledger = C.emptyLedger();
    for (const x of cat.decisions) ledger = C.recordAccept(ledger, x.decision, { by: 'owner' });
    writeFileSync(join(root, C.LEDGER_FILE), JSON.stringify(ledger));
    const t = task('X-1', { owned_files: ['src/auth/a.ts'] });
    const on = Z.zonesOnDisk({ root, dataFolder: root, cfg: { zones: { detect: true } } });
    const off = Z.zonesOnDisk({ root, dataFolder: root, cfg: { zones: { detect: false } } });
    expect(off.empty).toBe(true);
    expect(off(t)).toEqual([]);
    // The control: the same tree with the switch on does find it (so off is what removed it).
    expect(on(t).map((h: any) => h.id)).toEqual(['D-0001']);
  });
});

describe('the NOTE line at add', () => {
  it('says "is in" for a file hit and "may touch" for a keyword alone, and nothing without a hit', () => {
    expect(Z.noteLine('ZN-1', [FILE_HIT])).toBe(
      'NOTE: ZN-1 is in sensitive zone D-0001 Sign-in (files: src/auth/a.ts): Hard to undo. A change here is expensive ' +
        'to undo: the plan review and the riskiest assumption cover it before the start (zones.detect).',
    );
    expect(Z.noteLine('ZN-2', [WORD_HIT])).toMatch(/^NOTE: ZN-2 may touch sensitive zone D-0002 Keys \(keyword: encrypt\)\./);
    expect(Z.noteLine('ZN-1', [FILE_HIT, WORD_HIT])).toMatch(/is in sensitive zones D-0001/);
    expect(Z.noteLine('ZN-3', [])).toBeNull();
  });
});

describe('the zone on the board', () => {
  it('the server gives zone only with zonesFor and a hit, never for a done task', () => {
    expect(summaryOf(data, 'ZN-1').zone).toEqual({
      badge: 'Sensitive zone',
      title: 'In a sensitive zone: D-0001 Sign-in (files: src/auth/a.ts): Hard to undo.',
      fact: 'D-0001 Sign-in (files: src/auth/a.ts): Hard to undo.',
      ids: ['D-0001'],
    });
    expect(summaryOf(data, 'ZN-2').zone.badge).toBe('May touch a zone');
    expect(summaryOf(data, 'ZN-3')).not.toHaveProperty('zone');
    expect(summaryOf(data, 'ZN-4')).not.toHaveProperty('zone');
    // No zonesFor (no catalog, or zones.detect off): no card has a zone.
    const plain = T.board(queue);
    expect(summaryOf(plain, 'ZN-1')).not.toHaveProperty('zone');
  });

  it('the card has the badge with the tooltip, and only where there is a hit', () => {
    const b = card('ZN-1')?.querySelector('.zone-badge') as HTMLElement;
    expect(b?.textContent).toBe('Sensitive zone');
    expect(b.getAttribute('title')).toContain('D-0001 Sign-in');
    expect((card('ZN-2')?.querySelector('.zone-badge') as HTMLElement)?.textContent).toBe('May touch a zone');
    expect(card('ZN-3')?.querySelector('.zone-badge')).toBeNull();
  });

  it('the detail panel has a Sensitive zone fact', async () => {
    (card('ZN-1')?.querySelector('.summary-button') as HTMLElement).click();
    await flush();
    const panel = document.getElementById('panel') as HTMLElement;
    expect(panel.textContent).toContain('Sensitive zone');
    expect(panel.textContent).toContain('D-0001 Sign-in (files: src/auth/a.ts): Hard to undo.');
  });

  it('a zone entry in the Decisions catalog shows its reason and keywords, and no Applies to line', async () => {
    (document.getElementById('show-decisions') as HTMLElement).click();
    await flush();
    const li = [...document.querySelectorAll('.decide-nb-item')].find(
      (x) => x.querySelector('.sp-id')?.textContent === 'D-0009',
    ) as HTMLElement;
    expect(li).toBeTruthy();
    expect(document.body.textContent).toContain('Sensitive zones (1)');
    expect(li.textContent).toContain('A lost key loses data.');
    const metas = [...li.querySelectorAll('.decide-nb-meta')].map((p) => p.textContent);
    expect(metas).toContain('Keywords: encrypt, kms');
    expect(metas.some((m) => /^Applies to/.test(m ?? ''))).toBe(false);
    expect(metas).toContain('Accept it with: ravenseat catalog accept D-0009 --by owner');
  });
});
