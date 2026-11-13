/**
 * @vitest-environment jsdom
 */
// =============================================================
// queueBoardGuards.test.ts: the Guards and Repeated failures sections of the board's Checks tab.
//   - The guard registry (report.guards, cli/inspection.mjs guardsBoard) shows each guard with its kind, its one-sentence
//     explanation, what it guards against and, for a gate, "caught N times since built".
//   - The open inspection entries (report.inspection) show the failure, the counts and the status with the proposal id; a
//     built entry with no registry entry says how to add one.
//   - Nothing to show: a short line, never an empty section.
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

const baseReport = {
  stacks: [],
  found: { kinds: [], ci: [] },
  suggestions: [],
  categories: [],
  catalogErrors: [],
  knownBugs: null,
};
let report: Record<string, unknown> = {
  ...baseReport,
  guards: {
    file: '.ravenseat/guards.json',
    error: null,
    guards: [
      {
        id: 'G-1',
        title: 'Secret scan before commit',
        explain: 'Stops a key in a config file before it reaches CI.',
        kind: 'gate',
        status: 'active',
        built: '2026-11-01',
        task: 'INSP-1',
        command: 'npm run scan',
        against: { signature: 'abc123def456', lesson: 'npm run scan: leaks found' },
        measures: { runs: 9, redRuns: 4, caughtSince: 3, lastRed: '2026-11-10T10:00:00Z' },
      },
    ],
  },
  inspection: {
    mode: 'on',
    minRepeats: 2,
    windowDays: 30,
    entries: [
      { id: 'sig000000001', name: 'npm test', excerpt: 'Error: sample value missing', count: 5, incidents: 3, firstSeen: iso, lastSeen: iso, sources: ['gate'], status: 'proposed', proposal: 'INSP-2', snoozedUntil: null, unregistered: false },
      { id: 'sig000000002', name: 'ci: CI / lint', excerpt: 'rule x', count: 2, incidents: 2, firstSeen: iso, lastSeen: iso, sources: ['ci'], status: 'built', proposal: 'INSP-3', snoozedUntil: null, unregistered: true },
    ],
  },
};

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
  w.fetch = async (filePath: string) => ({
    ok: true,
    status: 200,
    json: async () =>
      filePath.startsWith('/api/state')
        ? filePath.includes(`version=${state.version}`)
          ? { version: state.version, unchanged: true }
          : state
        : filePath.startsWith('/api/checks')
          ? { ok: true, report }
          : {},
  });
  for (const f of ['a11y.js', '../lib/queueGraph.js', 'graph.js', 'plan.js', 'performance.js', 'board/'])
    (0, eval)(clientSource(f));
  await flush();
}, 60_000);

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const section = (title: string) => {
  const h = [...document.querySelectorAll('h3')].find((x) => x.textContent === title);
  return h?.parentElement?.textContent ?? '';
};

describe('the Guards and Repeated failures sections', () => {
  it('lists the guards with kind, explanation, what they guard against and the measures', async () => {
    $('show-checks').click();
    await flush();
    const text = document.body.textContent ?? '';
    expect(text).toContain('Guards');
    expect(text).toContain('Secret scan before commit');
    expect(text).toContain('Stops a key in a config file before it reaches CI.');
    expect(text).toContain('npm run scan: leaks found');
    expect(text).toContain('Caught 3 times since built');
    expect(section('Guards')).toContain('Gate');
  });

  it('lists the inspection entries with counts, status and the proposal, and the missing registry entry', () => {
    const text = document.body.textContent ?? '';
    expect(text).toContain('Repeated failures');
    expect(text).toContain('npm test');
    expect(text).toContain('3 incidents');
    expect(text).toContain('Proposed: INSP-2');
    expect(text).toContain('guards add --from-task INSP-3');
  });

  it('says so when there is nothing yet, and inspection off is named', async () => {
    report = { ...baseReport, guards: { file: '.ravenseat/guards.json', error: null, guards: [] }, inspection: { mode: 'off', minRepeats: 2, windowDays: 30, entries: [] } };
    $('show-checks').click();
    document.querySelector<HTMLButtonElement>('.checks-head button.button-outline')?.click();
    await flush();
    const text = document.body.textContent ?? '';
    expect(text).toContain('No guards in the registry yet');
    expect(text).toContain('The inspection queue is off');
  });
});
