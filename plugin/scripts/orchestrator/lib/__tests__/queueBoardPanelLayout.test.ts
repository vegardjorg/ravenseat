/**
 * @vitest-environment jsdom
 */
// =============================================================
// queueBoardPanelLayout.test.ts: the task panel reads top down (board step B14) and is not modal on a wide screen
// (UX review finding P1).
//
// What the tests prove:
//   - B14 order: title, a short "what the task is about", the actions, the full mission, and the technical facts last
//     in a collapsible "Details" that is closed by default and remembered per viewer (and works without storage),
//   - the summary rule: the first paragraph of a "What and why" (or Why, Goal, Purpose, Background, Summary, and the
//     Norwegian "Hva og hvorfor") section, else the first prose paragraph that is not generated boilerplate (the
//     =====ID===== marker, TITLE: and BRANCH: lines, headings, "**Ownership in the queue:**" blocks, code and tables),
//     else the first list item; clipped at a word boundary,
//   - the screen reader names stay: the dialog is labelled by the title, Close, Actions and The mission,
//   - from 1200 px the panel is not modal (no aria-modal, no backdrop, no focus trap, the board is not inert and stays
//     clickable, a click on another card swaps the content); below 1200 px it is modal as before; Esc closes it in
//     both and focus goes back to the card,
//   - the selection menu (B23) does not open under the side panel.
// The whole board runs in jsdom with a small synthetic queue (no real data); the media query is stubbed.
// =============================================================
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { clientSource } from './boardClient';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const T = require('../queueBoard.js') as { board: (queue: unknown, option?: unknown) => any };

const CLIENT = join(__dirname, '..', '..', 'queue-board');
const css = readFileSync(join(CLIENT, 'board.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** The mission texts, per task id. */
const LONG = 'word '.repeat(200).trim();
const MISSIONS: Record<string, string> = {
  // With a "What and why" heading: the paragraph under it, not the ownership block or the title line before it.
  'EX-1': [
    '## TRACK EX-1 (Streak calendar) class K, estimate 90 min',
    '',
    '**Ownership in the queue:** files src/ui/streak/*; DB none. Do not touch what other tasks own.',
    '',
    '## What and why',
    '',
    'Users cannot see how long they kept a habit going.',
    'Add a month calendar under the habit card.',
    '',
    'A second paragraph that is not the summary.',
    '',
    '## Steps',
    '',
    '1. Add a `StreakCalendar` component.',
    '2. Mark done days.',
  ].join('\n'),
  // No headings: the first paragraph.
  'EX-2': 'Customers must be able to upgrade from the app.\n\nThe server creates the checkout session.',
  // A generated mission from another project: marker, metadata lines, headings and a bold block before the prose.
  'EX-3': [
    '=====EX-3=====',
    'TITLE: TRACK EX-3 (same weekly limit)',
    'BLOCK: 3480-3489',
    'BRANCH: queue/EX-3',
    '',
    '## TRACK EX-3 (same weekly limit; class D, estimate 26 min)',
    '',
    '**Ownership in the queue:** files none; DB min_percent. Do not touch what other tasks own.',
    '',
    "**The owner's answer to what the task waited on** (binding):",
    '- Q-1: yes.',
    '',
    '# EX-3: the minimum uses the same weekly limit as the classification (D, about 25 min)',
    '',
    'Found in the review of EX-2. The minimum uses the weekly limit without the regime.',
  ].join('\n'),
  // A bold label that names the summary.
  'EX-4': '**Goal:** Lock the account after ten failed sign-ins.\n\n**Ownership in the queue:** files none.',
  // Only a list: its first item.
  'EX-5': '- Compress the sync payloads with gzip.\n- Measure the size before and after.',
  // Nothing: no summary.
  'EX-6': '',
  // A very long first paragraph: clipped at a word boundary.
  'EX-7': LONG,
  // The Norwegian heading.
  'EX-8': '# Tittel\n\n**Eierskap i køen:** filer ingen.\n\n## Hva og hvorfor\n\nBrukerne ser ikke rekken sin.',
};

function makeQueue() {
  const iso = new Date(Date.now() - 86_400_000).toISOString();
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
    added_at: iso,
  });
  return {
    created: iso,
    limits: { maxConcurrent: 5, maxDPlus: 2, maxPerDomain: 5, maxDb: 2 },
    tasks: Object.keys(MISSIONS).map((id, i) => task(id, 9 - i)),
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
/** The media query answer: `wide` makes the side panel's (min-width: 1200px) match. */
let wide = false;
const mediaListeners: Array<() => void> = [];
/** When true, every localStorage call throws (blocked storage). */
let storageBlocked = false;

beforeAll(async () => {
  const state = { version: 'v1', data: { ...T.board(makeQueue()), gitError: null, logo: false } };
  const html = readFileSync(join(CLIENT, 'index.html'), 'utf8');
  document.documentElement.innerHTML = html.replace(/<!doctype[^>]*>/i, '').replace(/<\/?html[^>]*>/g, '');
  sessionStorage.setItem('queue-board-key', 'testKey');
  localStorage.clear();
  // Blocked storage throws on every call, as in a strict private window.
  const ls = Storage.prototype;
  for (const m of ['getItem', 'setItem', 'removeItem'] as const) {
    const plain = ls[m];
    (ls as any)[m] = function (this: Storage, ...a: unknown[]) {
      if (storageBlocked && this === localStorage) throw new Error('blocked');
      return (plain as any).apply(this, a);
    };
  }
  w.CSS = { escape: (s: string) => String(s).replace(/["\\]/g, '\\$&') };
  w.matchMedia = (q: string) => ({
    get matches() {
      return wide && /min-width:\s*1200px/.test(q);
    },
    media: q,
    addEventListener(_: string, f: () => void) {
      mediaListeners.push(f);
    },
    removeEventListener() {},
    addListener(f: () => void) {
      mediaListeners.push(f);
    },
  });
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
        return { ok: true, mission: { text: MISSIONS[id] ?? '', path: null }, branch: { name: `queue/${id}`, exists: false } };
      }
      return { ok: true };
    },
  });
  for (const f of ['a11y.js', '../lib/queueGraph.js', 'graph.js', 'plan.js', 'performance.js', 'board/'])
    (0, eval)(clientSource(f));
  await flush();
}, 60_000);

const panel = () => document.getElementById('panel') as HTMLElement;
const backdrop = () => document.getElementById('panel-background') as HTMLElement;
const cardButton = (id: string) =>
  document.querySelector(`.summary[data-id="${id}"] .summary-button`) as HTMLButtonElement;
const details = () => panel().querySelector('details.panel-details') as HTMLDetailsElement;
const summaryText = () => panel().querySelector('.panel-summary')?.textContent ?? null;

/** Clicks a card's title as a mouse does (the button gets focus first). */
async function openCard(id: string) {
  const b = cardButton(id);
  expect(b).not.toBeNull();
  b.focus();
  b.click();
  await flush();
}
function esc() {
  document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
}
function closeIfOpen() {
  if (!panel().hidden) (panel().querySelector('.button-icon') as HTMLButtonElement).click();
}

beforeEach(() => {
  closeIfOpen();
  wide = false;
  storageBlocked = false;
  localStorage.removeItem('queue-board-panel-details');
});

describe('B14: the panel reads top down', () => {
  it('shows the title, the summary, the actions, the mission and the Details last', async () => {
    await openCard('EX-1');
    const kids = [...panel().children];
    const at = (sel: string) => kids.findIndex((k) => k.matches(sel));
    const order = ['.panel-header', '.panel-summary', '.actions', 'section.mission', 'details.panel-details'].map(at);
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // Details is the last block, and the facts (Status, Branch, Owner files ...) live inside it, not above the actions.
    expect(kids[kids.length - 1]).toBe(details());
    const dl = details().querySelector('dl.facts') as HTMLElement;
    const labels = [...dl.querySelectorAll(':scope > dt')].map((d) => d.textContent);
    expect(labels).toEqual(expect.arrayContaining(['Status', 'Project', 'Class', 'Owner files', 'Branch']));
    expect(panel().querySelectorAll('dl.facts').length).toBe(1);
    expect(details().querySelector('summary')?.textContent).toMatch(/^Details/);
  });

  it('keeps the screen reader names: the title labels the dialog, Close, Actions and The mission', async () => {
    await openCard('EX-1');
    expect(panel().getAttribute('role')).toBe('dialog');
    expect(panel().getAttribute('aria-labelledby')).toBe('panel-title');
    expect(document.getElementById('panel-title')?.textContent).toBe('Task EX-1');
    expect(panel().querySelector('.button-icon')?.getAttribute('aria-label')).toBe('Close');
    expect(panel().querySelector('.actions')?.getAttribute('aria-label')).toBe('Actions');
    expect(panel().querySelector('section.mission')?.getAttribute('aria-label')).toBe('The mission');
  });
});

describe('B14: the summary rule', () => {
  it('takes the first paragraph of the "What and why" section', async () => {
    await openCard('EX-1');
    expect(summaryText()).toBe('Users cannot see how long they kept a habit going. Add a month calendar under the habit card.');
  });

  it('takes the first paragraph of a mission without headings', async () => {
    await openCard('EX-2');
    expect(summaryText()).toBe('Customers must be able to upgrade from the app.');
  });

  it('skips the generated marker, metadata lines, headings and bold blocks', async () => {
    await openCard('EX-3');
    expect(summaryText()).toBe('Found in the review of EX-2. The minimum uses the weekly limit without the regime.');
  });

  it('takes the text of a bold Goal label', async () => {
    await openCard('EX-4');
    expect(summaryText()).toBe('Lock the account after ten failed sign-ins.');
  });

  it('falls back to the first list item', async () => {
    await openCard('EX-5');
    expect(summaryText()).toBe('Compress the sync payloads with gzip.');
  });

  it('shows no summary for an empty mission', async () => {
    await openCard('EX-6');
    expect(panel().querySelector('.panel-summary')).toBeNull();
  });

  it('clips a long paragraph at a word boundary', async () => {
    await openCard('EX-7');
    const s = summaryText() as string;
    expect(s.length).toBeLessThanOrEqual(321);
    expect(s.endsWith('…')).toBe(true);
    expect(s.slice(0, -1)).toMatch(/(^| )word$/);
  });

  it('knows the Norwegian heading', async () => {
    await openCard('EX-8');
    expect(summaryText()).toBe('Brukerne ser ikke rekken sin.');
  });
});

describe('B14: Details', () => {
  it('is closed by default, and the choice is remembered per viewer', async () => {
    await openCard('EX-1');
    expect(details().open).toBe(false);
    details().open = true;
    details().dispatchEvent(new Event('toggle'));
    expect(localStorage.getItem('queue-board-panel-details')).toBe('open');
    closeIfOpen();
    await openCard('EX-2');
    expect(details().open).toBe(true);
    details().open = false;
    details().dispatchEvent(new Event('toggle'));
    expect(localStorage.getItem('queue-board-panel-details')).toBe('closed');
    closeIfOpen();
    await openCard('EX-1');
    expect(details().open).toBe(false);
  });

  it('works when storage is blocked: closed by default, and the choice holds for the visit', async () => {
    storageBlocked = true;
    await openCard('EX-1');
    expect(details()).not.toBeNull();
    details().open = true;
    expect(() => details().dispatchEvent(new Event('toggle'))).not.toThrow();
    closeIfOpen();
    await openCard('EX-2');
    expect(details().open).toBe(true);
    details().open = false;
    details().dispatchEvent(new Event('toggle'));
  });

  it('has a quiet style on the summary row, with tokens only', () => {
    const rule = /\.panel-details\s*>\s*summary\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toMatch(/cursor:\s*pointer/);
    expect(rule).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });
});

describe('P1: modal below 1200 px', () => {
  it('is a modal dialog with a backdrop, an inert board and a focus trap', async () => {
    await openCard('EX-1');
    expect(panel().getAttribute('aria-modal')).toBe('true');
    expect(backdrop().hidden).toBe(false);
    expect(document.getElementById('board')?.hasAttribute('inert')).toBe(true);
    expect(document.body.classList.contains('panel-beside')).toBe(false);
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    (panel().querySelector('.button-icon') as HTMLElement).dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
  });

  it('closes on Esc and puts focus back on the card', async () => {
    await openCard('EX-2');
    esc();
    expect(panel().hidden).toBe(true);
    expect(document.activeElement).toBe(cardButton('EX-2'));
  });
});

describe('P1: beside the board from 1200 px', () => {
  // QA-1c Q5: from 1200 px the panel now floats over the board by default (board.panelMode float, body.panel-float);
  // the docked panel (body.panel-beside) is the beside mode, tested in queueBoardPanelFloat.test.ts. Not modal in both.
  it('is not modal: no aria-modal, no backdrop, no inert board, no focus trap', async () => {
    wide = true;
    await openCard('EX-1');
    expect(panel().hidden).toBe(false);
    expect(panel().hasAttribute('aria-modal')).toBe(false);
    expect(backdrop().hidden).toBe(true);
    for (const sel of ['#board', 'header.top']) expect(document.querySelector(sel)?.hasAttribute('inert')).toBe(false);
    expect(document.body.classList.contains('panel-float')).toBe(true);
    expect(document.body.classList.contains('panel-beside')).toBe(false);
    // Focus went to the panel.
    expect(panel().contains(document.activeElement)).toBe(true);
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    (panel().querySelector('.button-icon') as HTMLElement).dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false);
  });

  it('swaps the content on a click on another card, and Esc puts focus back on that card', async () => {
    wide = true;
    await openCard('EX-1');
    await openCard('EX-2');
    expect(panel().hidden).toBe(false);
    expect(document.getElementById('panel-title')?.textContent).toBe('Task EX-2');
    expect(panel().contains(document.activeElement)).toBe(true);
    esc();
    expect(panel().hidden).toBe(true);
    expect(document.body.classList.contains('panel-beside')).toBe(false);
    expect(document.activeElement).toBe(cardButton('EX-2'));
  });

  it('follows the width: crossing 1200 px while open switches between modal and beside', async () => {
    wide = true;
    await openCard('EX-1');
    wide = false;
    for (const f of mediaListeners) f();
    expect(panel().getAttribute('aria-modal')).toBe('true');
    expect(backdrop().hidden).toBe(false);
    expect(document.getElementById('board')?.hasAttribute('inert')).toBe(true);
    wide = true;
    for (const f of mediaListeners) f();
    expect(panel().hasAttribute('aria-modal')).toBe(false);
    expect(backdrop().hidden).toBe(true);
    expect(document.getElementById('board')?.hasAttribute('inert')).toBe(false);
  });

  it('makes room: the board gets the panel width as padding, and the panel has no scrim', () => {
    const rule = /body\.panel-beside\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toMatch(/padding-right:\s*var\(--panel-side\)/);
    expect(css).toMatch(/@media\s*\(min-width:\s*1200px\)/);
  });

  it('keeps the selection menu out from under the side panel', async () => {
    wide = true;
    await openCard('EX-1');
    w.innerWidth = 1440;
    w.innerHeight = 900;
    const rect = (left: number, top: number, width: number, height: number) => ({
      left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() {},
    });
    (panel() as any).getBoundingClientRect = () => rect(900, 0, 540, 900);
    const line = document.getElementById('optionLine') as HTMLElement;
    (line as any).getBoundingClientRect = () => rect(0, 0, 240, 300);
    const card = document.querySelector('.summary[data-id="EX-2"][data-markable]') as HTMLElement;
    const box = card.querySelector('.mark-box') as HTMLElement;
    (box as any).getBoundingClientRect = () => rect(800, 200, 24, 36);
    const input = box.querySelector('input') as HTMLInputElement;
    input.click();
    await flush();
    expect(line.classList.contains('as-menu')).toBe(true);
    const left = parseFloat(line.style.left);
    // Right of the box would end at 1068, under the panel (starts at 900): it flips to the left of the box.
    expect(left + 240).toBeLessThanOrEqual(800);
    input.click();
    await flush();
  });
});
