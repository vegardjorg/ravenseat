/**
 * @vitest-environment jsdom
 */
// =============================================================
// queueBoardWords.test.ts: the board's words and text (board step B31).
//
// What the tests prove:
//   - the bulk dialog's main button says the verb and the count ("Put 3 tasks on hold"), not "Do it", and the label
//     dialog's button follows the add/remove choice,
//   - a CLI command the board cannot run itself stands in a copyable "Claude Code:" chip last, not mid-sentence (X6),
//     and where the board has the control the text names no CLI,
//   - English text uses a decimal point, never a comma (PL3),
//   - zero and short durations read naturally ("opened today", "just now", "9 min ago") (PL4),
//   - a success toast is role="status" and an error toast role="alert" (T-toast),
//   - the keyboard hint in Decisions uses <kbd> keys and names only the number keys that work (D4).
// The whole board runs in jsdom with a small synthetic queue (no real data).
// =============================================================
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { clientSource } from './boardClient';

/* eslint-disable @typescript-eslint/no-require-imports */
const T = require('../queueBoard.js') as { board: (queue: unknown, option?: unknown) => any };
const KK = require('../queueConfig.js') as any;
const D = require('../queueDecisions.js') as {
  daysOpenText: (d: number) => string;
  agoText: (min: number) => string;
  NUMBER_KEYS: number;
};
const P = require('../queuePlan.js') as {
  capacity: (reg: unknown, queue: unknown, o?: unknown) => { text: string };
};
/* eslint-enable @typescript-eslint/no-require-imports */

const CLIENT = join(__dirname, '..', '..', 'queue-board');
const read = (f: string) => readFileSync(join(CLIENT, f), 'utf8');
const iso = new Date(Date.now() - 86_400_000).toISOString();

const task = (id: string, status: string, own: object = {}) => ({
  id,
  title: `Task ${id}`,
  domain: 'ui',
  class: 'K',
  value: 5,
  content_min: 30,
  status,
  depends_on: [],
  waiting_on: [],
  owned_files: [`file/${id}.ts`],
  owner_db: [],
  shared_patch: [],
  mission: `scripts/.queue/mission/${id}.md`,
  added_by: 'test',
  added_at: iso,
  ...own,
});
const queue = {
  created: iso,
  limits: { maxConcurrent: 5, maxDPlus: 2, maxPerDomain: 5, maxDb: 2 },
  tasks: [task('EX-1', 'proposed'), task('EX-3', 'waiting'), task('EX-4', 'waiting'), task('EX-5', 'waiting')],
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
  },
};

const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};
const $ = (id: string) => document.getElementById(id) as HTMLElement;
const w = window as any;

beforeAll(async () => {
  document.documentElement.innerHTML = read('index.html')
    .replace(/<!doctype[^>]*>/i, '')
    .replace(/<\/?html[^>]*>/g, '');
  sessionStorage.setItem('queue-board-key', 'testKey');
  localStorage.clear();
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
          : { ok: true, can: true, recap: 'Preview.', lines: [], guard: [], version: 'v1' },
  });
  for (const f of ['a11y.js', '../lib/queueGraph.js', 'graph.js', 'plan.js', 'performance.js', '../lib/queueDecisions.js', 'board/'])
    (0, eval)(clientSource(f));
  await flush();
}, 60_000);

describe('D4: the keyboard hint in Decisions', () => {
  it('shows the keys as <kbd> and names only number keys that work', () => {
    const hint = document.querySelector('.decide-keys') as HTMLElement;
    expect(hint).not.toBeNull();
    const keys = [...hint.querySelectorAll('kbd')].map((k) => k.textContent);
    expect(keys).toEqual(expect.arrayContaining(['j', 'k', 'Enter', 'u']));
    expect(hint.textContent).not.toContain('=');
    // The highest number named is the most options a card has, and never above the keys the handler takes.
    const most = Math.max(...[...document.querySelectorAll('.decide-card')].map((c) => c.querySelectorAll('.decide-options .decide-key').length));
    const numbers = keys.filter((k) => /^\d$/.test(k ?? '')).map(Number);
    expect(Math.max(...numbers)).toBe(Math.min(most, D.NUMBER_KEYS));
    expect(D.NUMBER_KEYS).toBe(4);
  });
});

describe('B-dialog: the bulk button says what it does', () => {
  const card = (id: string) => document.querySelector(`.summary[data-id="${id}"][data-markable]`) as HTMLElement;
  const check = (id: string, on = true) => {
    const i = card(id).querySelector('.mark-box input') as HTMLInputElement;
    if (i.checked !== on) i.click();
  };
  const menu = (label: string) =>
    ([...$('optionLine').querySelectorAll('[role="menuitem"], [role="toolbar"] button')] as HTMLButtonElement[]).find(
      (b) => b.textContent?.trim() === label,
    ) as HTMLButtonElement;
  const main = () => $('bulk').querySelector('.guard-buttons .button-filled') as HTMLButtonElement;
  const close = () => $('bulk').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

  it('goes to the queue view', async () => {
    $('room-queue').click();
    await flush();
    for (const d of document.querySelectorAll('details')) {
      (d as HTMLDetailsElement).open = true;
      d.dispatchEvent(new Event('toggle'));
    }
    await flush();
    expect(card('EX-3')).not.toBeNull();
  });

  it('"Put on hold" on three tasks says "Put 3 tasks on hold"', async () => {
    for (const id of ['EX-3', 'EX-4', 'EX-5']) check(id);
    menu('Put on hold').click();
    await flush();
    expect(main().textContent).toBe('Put 3 tasks on hold');
    expect($('bulk').textContent).not.toContain('Do it');
    close();
  });

  it('the label button follows the selection and the add/remove choice', async () => {
    check('EX-5', false);
    menu('Label').click();
    await flush();
    expect(main().textContent).toBe('Add the label to 2 tasks');
    const option = $('bulk-label-option') as HTMLSelectElement;
    option.value = 'remove';
    option.dispatchEvent(new Event('change'));
    expect(main().textContent).toBe('Remove the label from 2 tasks');
    close();
  });

  it('X6: "Move to project" names the CLI in a copyable chip last, not in the sentence', async () => {
    menu('Move to project').click();
    await flush();
    expect(main().textContent).toBe('Move 2 tasks');
    const help = $('bulk').querySelector('.field-help') as HTMLElement;
    const chip = help.querySelector('.cli-chip') as HTMLElement;
    expect(chip).not.toBeNull();
    expect(help.lastElementChild).toBe(chip);
    expect(chip.querySelector('.cli-chip-label')?.textContent).toBe('Claude Code:');
    expect(chip.querySelector('code')?.textContent).toBe('ravenseat project <pid> --title "…"');
    expect(chip.querySelector('button')?.textContent).toBe('Copy');
    // The sentence before the chip asks for Claude, without the command.
    expect(help.firstChild?.textContent).toBe('No fitting project? Ask Claude to create one. ');
  });

  it('T-toast: a success toast is role=status, an error toast role=alert', async () => {
    const copy = $('bulk').querySelector('.cli-chip button') as HTMLButtonElement;
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => {} }, configurable: true });
    copy.click();
    await flush();
    expect($('message').textContent).toBe('The command is copied.');
    expect($('message').getAttribute('role')).toBe('status');
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: async () => Promise.reject(new Error('no')) },
      configurable: true,
    });
    copy.click();
    await flush();
    expect($('message').getAttribute('role')).toBe('alert');
    close();
  });

  it('T-toast: the message box is not an alert before anything is shown', () => {
    expect(read('index.html')).not.toMatch(/id="message"[^>]*role="alert"/);
  });
});

describe('X6: where the board has the control, the text names no CLI', () => {
  it('settings and Checks point to the switch, not to ravenseat', () => {
    const settings = read('board/settings.js');
    expect(settings).not.toContain('Claude Code: ravenseat board-setting blocked on|off');
    expect(settings).not.toContain('Also ravenseat checks on|off in Claude Code');
    expect(read('board/checks.js')).not.toContain('or ravenseat checks marker off, hides the dot');
  });

  it('Plans > Legal and the answer form put commands in a chip and name no command the board does itself', () => {
    const legal = read('plans/legal.js');
    expect(legal).not.toContain('The points are added to the entry with ravenseat plan edit');
    expect(legal).not.toContain('Changed with ravenseat plan edit');
    expect(legal).not.toContain('saved with ravenseat resolve');
    expect(legal).toContain('h.cliChip(');
  });

  it('the panel puts the cancel command in the chip', () => {
    expect(read('board/edit.js')).toContain('cliChip(`ravenseat set ${k.id} cancelled --remark "<why>"`)');
  });
});

describe('PL3: a decimal point in English text', () => {
  it('the pace in Now uses "2.3", never "2,3"', () => {
    const reg = {
      entries: [
        { id: 'PL-A', priority: 'now', size: 'L', status: 'planned' },
        { id: 'PL-B', priority: 'now', size: 'M', status: 'planned' },
      ],
    };
    const text = P.capacity(reg, { tasks: [] }, { donePerWeek: 2.25 }).text;
    expect(text).toMatch(/about \d+\.\d weeks|about \d+ weeks/);
    expect(text).toContain('2.3 finished queue tasks per week');
    expect(text).not.toMatch(/\d,\d/);
  });
});

describe('PL4: natural words for short durations', () => {
  it('days open', () => {
    expect(D.daysOpenText(0)).toBe('opened today');
    expect(D.daysOpenText(1)).toBe('open for 1 day');
    expect(D.daysOpenText(5)).toBe('open for 5 days');
  });

  it('how long ago', () => {
    expect(D.agoText(0)).toBe('just now');
    expect(D.agoText(9)).toBe('9 min ago');
    expect(D.agoText(125)).toBe('2 h 5 min ago');
    expect(D.agoText(3 * 24 * 60)).toBe('3 days ago');
  });

  it('Plans uses the shared words, not "open for 0 d", "min in queue" or "last pulse"', () => {
    const legal = read('plans/legal.js');
    expect(legal).not.toContain('open for ${x.days_open} d');
    expect(legal).not.toContain('min in queue');
    expect(legal).toContain('daysOpenText(');
    const overview = read('plans/overview.js');
    expect(overview).not.toContain('last pulse');
    expect(overview).toContain('agoText(');
  });
});
