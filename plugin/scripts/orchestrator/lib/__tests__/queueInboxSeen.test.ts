/**
 * @vitest-environment jsdom
 */
// =============================================================
// queueInboxSeen.test.ts: a card set aside with Seen on the Decisions tab also leaves "Waiting on you" (Q4 in test round 5).
//
// Why: the counter and the tab agreed that the card was gone, while the panel behind the counter kept listing it, so the
// button said one thing and the panel another. Here the real board client runs in jsdom with a small synthetic queue.
// =============================================================
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { clientSource } from './boardClient';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const T = require('../queueBoard.js') as { board: (queue: unknown, option?: unknown) => any };

const CLIENT = join(__dirname, '..', '..', 'queue-board');
const hourAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

const QUEUE = {
  created: hourAgo(48),
  limits: { maxConcurrent: 5, maxDPlus: 2, maxPerDomain: 5, maxDb: 2 },
  tasks: [
    {
      id: 'EX-1',
      title: 'Task EX-1',
      domain: 'dom',
      class: 'K',
      value: 5,
      content_min: 90,
      status: 'running',
      branch: 'queue/EX-1',
      started: hourAgo(3),
      depends_on: [],
      waiting_on: [],
      owned_files: ['file/a.ts'],
      owner_db: [],
      shared_patch: [],
      added_by: 'test',
      added_at: hourAgo(48),
    },
  ],
  projects: { ex: { title: 'Example', prefixes: ['EX-'] } },
  areas: {},
  question: [],
  resolutions: [],
  changelog: [],
};
const SILENT = [{ id: 'EX-1', branch: 'queue/EX-1', last_activity: hourAgo(2), silent_ms: 2 * 3600_000 }];

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

describe('Seen on the Decisions tab', () => {
  beforeAll(async () => {
    const state = { version: 'v1', data: { ...T.board(QUEUE, { silent: SILENT }), gitError: null, logo: false } };
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
          : {},
    });
    for (const f of ['a11y.js', '../lib/queueGraph.js', 'graph.js', 'plan.js', 'performance.js', '../lib/queueDecisions.js', 'board/'])
      (0, eval)(clientSource(f));
    await flush();
  }, 60_000);

  const panelText = () => document.getElementById('panel')?.textContent ?? '';
  const openInbox = async () => {
    (document.getElementById('inbox') as HTMLButtonElement).click();
    await flush();
  };
  const closeInbox = async () => {
    (document.querySelector('#panel .panel-header .button-icon') as HTMLButtonElement).click();
    await flush();
  };

  it('before: the panel lists the silent track', async () => {
    await openInbox();
    expect(panelText()).toContain('Stuck');
    expect(panelText()).toContain('EX-1');
    await closeInbox();
  });

  it('after: the panel says nothing is waiting, like the counter', async () => {
    (document.getElementById('show-decisions') as HTMLButtonElement).click();
    await flush();
    const seen = document.querySelector('.decide-card button[aria-label^="Seen"]') as HTMLButtonElement | null;
    expect(seen).toBeTruthy();
    seen!.click();
    await flush();
    expect(document.querySelector('#inbox .inbox-count')).toBeNull();
    await openInbox();
    expect(panelText()).not.toContain('Stuck');
    expect(panelText()).not.toContain('EX-1');
    expect(panelText()).toContain('Nothing waiting on you');
  });
});
