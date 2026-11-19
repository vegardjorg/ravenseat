/**
 * @vitest-environment jsdom
 */
// =============================================================
// queueBoardQa1b.test.ts: Focus at the size the owner runs it (QA-1b, Q4): 50 steps in focus, a step with more tasks
// than fit on a screen, and many open cards to pick from.
//
// What the tests prove:
//   1. The "Add to focus …" picker has a searchable What: a combobox (role, aria-controls, aria-activedescendant) over a
//      listbox, filtered by id and title (every word must match), with the count of matches in a polite live region.
//      The arrow keys move the choice, Esc inside the field clears the search first (the dialog stays open) and only an
//      Esc on an empty field closes the dialog. With a handful of tasks every one is listed, as before.
//   2. Position is First / After a step / Last (Last stays the default). "After a step" opens a searchable list of the
//      steps by label (T<n>, task id and title, or the step's name). In the draft picker the step lands at that index;
//      from a card, the detail panel and the Selection, "Add to focus at …" opens the same picker with the card(s)
//      chosen, and each position gives the right change payload for POST /api/focus (First at 1, after step k at k+1,
//      Last without `at`, as the one-click "Add to focus").
//   3. A step's open task list above 12 tasks is capped with its own scroll area: focusable, labelled with the count
//      and a visible hint; 12 or fewer stay as they were. In focus with more than 12 steps draws compact rows, every
//      step has a small menu with Move to top and Move to bottom (and Home/End do the same for a lifted step), and the
//      QA-1a drop bar still sits exactly where the drop lands.
// The whole board runs in jsdom with a synthetic queue (no network), as in queueFocusB21.test.ts.
// =============================================================
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { clientSource } from './boardClient';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const T = require('../queueBoard.js') as { board: (queue: unknown, option?: unknown) => any };

const CLIENT = join(__dirname, '..', '..', 'queue-board');
const iso = new Date(Date.now() - 86_400_000).toISOString();

function task(id: string, project: string, feature: string | null = null) {
  return {
    id,
    title: `Task ${id}`,
    project,
    ...(feature ? { feature } : {}),
    domain: `${project}-${id}`,
    class: 'K',
    value: 5,
    content_min: 60,
    status: 'waiting',
    depends_on: [],
    waiting_on: [],
    owned_files: [`file/${id}.ts`],
    owner_db: [],
    shared_patch: [],
    mission: `scripts/.queue/mission/${id}.md`,
    added_by: 'test',
    added_at: iso,
  };
}

// Step 1 is the feature big/Lots with 15 tasks (more than the 12-row cap); steps 2 to 50 are one task each
// (task:S-1 to task:S-49). MISC-1 and MISC-2 are outside the focus.
const BIG = Array.from({ length: 15 }, (_, i) => `BIG-${i + 1}`);
const STEPS = Array.from({ length: 49 }, (_, i) => `S-${i + 1}`);
const ORDER = ['feature:big/Lots', ...STEPS.map((id) => `task:${id}`)];

function makeQueue() {
  return {
    created: iso,
    limits: { maxConcurrent: 5, maxDPlus: 2, maxPerDomain: 5, maxDb: 2 },
    tasks: [
      ...BIG.map((id) => task(id, 'big', 'Lots')),
      ...STEPS.map((id) => task(id, 'steps')),
      task('MISC-1', 'misc'),
      task('MISC-2', 'misc'),
    ],
    projects: {
      big: { title: 'Big feature', prefixes: ['BIG-'] },
      steps: { title: 'One task per step', prefixes: ['S-'] },
      misc: { title: 'Odds and ends', prefixes: ['MISC-'] },
    },
    areas: {},
    question: [],
    resolutions: [],
    changelog: [],
    focus: { from: iso, rest: 'wait', order: ORDER, drag_with_dependencies: true },
  };
}

const state = { version: 'v1', data: { ...T.board(makeQueue()), gitError: null, logo: false } };
const posted: any[] = [];
const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};
const $ = (id: string) => document.getElementById(id) as HTMLElement;
const dialog = () => $('plan-dialog');
const dialogOpen = () => !$('plan-dialog-background')?.hidden;
const card = (id: string) => document.querySelector(`.summary[data-id="${id}"]`) as HTMLElement;
const key = (target: Element, k: string) =>
  target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
const type = async (input: HTMLInputElement, value: string) => {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await flush();
};
const focusList = () => document.querySelector('.plan-list[data-col="focus"]') as HTMLElement;
const focusKeys = () =>
  [...document.querySelectorAll('.plan-list[data-col="focus"] > .plan-element')].map((x) => (x as HTMLElement).dataset.key);
const row = (k: string) => document.querySelector(`.plan-list > .plan-element[data-key="${k}"]`) as HTMLElement;
/** The options a combobox's listbox shows now, as their values. */
const optionValues = (input: HTMLInputElement) =>
  [...$(input.getAttribute('aria-controls')!).querySelectorAll('[role="option"]')].map(
    (o) => (o as HTMLElement).dataset.value,
  );
const chosen = (input: HTMLInputElement) =>
  ($(input.getAttribute('aria-controls')!).querySelector('[aria-selected="true"]') as HTMLElement | null)?.dataset.value;
const dialogButton = (text: string) =>
  [...dialog().querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === text) as HTMLButtonElement;
const closeDialog = async () => {
  if (!dialogOpen()) return;
  dialogButton('Cancel')?.click();
  await flush();
};
const openToolbarPicker = async () => {
  const open = [...document.querySelectorAll('.plan-tool button')].find(
    (b) => (b.textContent ?? '').trim() === 'Add to focus …',
  ) as HTMLButtonElement;
  open.click();
  await flush();
};
const position = (value: string) =>
  dialog().querySelector(`input[type="radio"][name="plan-pick-where"][value="${value}"]`) as HTMLInputElement;
const choosePosition = async (value: string) => {
  const r = position(value);
  r.checked = true;
  r.dispatchEvent(new Event('change', { bubbles: true }));
  await flush();
};

beforeAll(async () => {
  const html = readFileSync(join(CLIENT, 'index.html'), 'utf8');
  document.documentElement.innerHTML = html.replace(/<!doctype[^>]*>/i, '').replace(/<\/?html[^>]*>/g, '');
  sessionStorage.setItem('queue-board-key', 'testKey');
  localStorage.clear();
  const w = window as any;
  w.CSS = { escape: (s: string) => String(s).replace(/["\\]/g, '\\$&') };
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {} });
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.setInterval = () => 0;
  w.fetch = async (filePath: string, init?: { body?: string }) => {
    if (filePath.startsWith('/api/focus')) posted.push(JSON.parse(init?.body ?? '{}'));
    return {
      ok: true,
      status: 200,
      json: async () =>
        filePath.startsWith('/api/state')
          ? filePath.includes(`version=${state.version}`)
            ? { version: state.version, unchanged: true }
            : state
          : filePath.startsWith('/api/focus')
            ? { ok: true, can: true, before_text: 'before', after_text: 'after', lines: ['a line'], changed: 'c1' }
            : filePath.startsWith('/api/task')
              ? { ok: true, mission: { text: '', path: null }, branch: null }
              : {},
    };
  };
  for (const f of ['a11y.js', '../lib/queueGraph.js', 'graph.js', 'plan.js', 'performance.js', 'board/'])
    (0, eval)(clientSource(f));
  await flush();
}, 60_000);

beforeEach(() => {
  posted.length = 0;
});

// ---------------------------------------------------------------------------------------------------------------------
describe('1. the picker: What is searchable', () => {
  beforeAll(async () => {
    $('show-plan').click();
    await flush();
  });

  const what = () => dialog().querySelector('#plan-pick-what') as HTMLInputElement;
  const count = () => $('plan-pick-what-count');

  it('What is a combobox over a listbox, labelled, with every open task not yet a step and the count', async () => {
    await openToolbarPicker();
    const input = what();
    expect(input.getAttribute('role')).toBe('combobox');
    expect(input.getAttribute('aria-autocomplete')).toBe('list');
    expect(dialog().querySelector('label[for="plan-pick-what"]')?.textContent).toBe('What');
    const list = $(input.getAttribute('aria-controls')!);
    expect(list.getAttribute('role')).toBe('listbox');
    // 15 BIG cards (a feature step covers them, but none is its own step) and the two MISC ones; S-1 to S-49 are steps.
    const values = optionValues(input);
    expect(values).toHaveLength(17);
    expect(values).toContain('task:MISC-1');
    expect(values).not.toContain('task:S-1');
    expect(count().getAttribute('aria-live')).toBe('polite');
    expect(count().textContent).toBe('17 tasks');
    // One option is chosen from the start (the first), and the field points at it.
    expect(chosen(input)).toBe(values[0]);
    // The parts the draft picker leaves out are not drawn as the text "null".
    expect(dialog().textContent).not.toMatch(/null/);
    expect(input.getAttribute('aria-activedescendant')).toBe(list.querySelector('[aria-selected="true"]')!.id);
  });

  it('filters by id and by title, every word must match, and says how many match', async () => {
    const input = what();
    await type(input, 'misc');
    expect(optionValues(input)).toEqual(['task:MISC-1', 'task:MISC-2']);
    expect(count().textContent).toBe('2 of 17 match');
    await type(input, 'BIG-1');
    expect(optionValues(input)).toEqual(['task:BIG-1', 'task:BIG-10', 'task:BIG-11', 'task:BIG-12', 'task:BIG-13', 'task:BIG-14', 'task:BIG-15']);
    // A title word and an id word together.
    await type(input, 'task misc-2');
    expect(optionValues(input)).toEqual(['task:MISC-2']);
    expect(count().textContent).toBe('1 of 17 match');
    // The choice follows the filter: the only match is chosen.
    expect(chosen(input)).toBe('task:MISC-2');
    await type(input, 'nothing like this');
    expect(optionValues(input)).toEqual([]);
    expect(count().textContent).toBe('No matches');
    expect(dialogButton('Add').disabled).toBe(true);
    await type(input, '');
    expect(optionValues(input)).toHaveLength(17);
    expect(dialogButton('Add').disabled).toBe(false);
  });

  it('the arrow keys move the choice, and aria-activedescendant follows', async () => {
    const input = what();
    await type(input, 'misc');
    expect(chosen(input)).toBe('task:MISC-1');
    key(input, 'ArrowDown');
    expect(chosen(input)).toBe('task:MISC-2');
    expect(input.getAttribute('aria-activedescendant')).toBe(
      $(input.getAttribute('aria-controls')!).querySelector('[aria-selected="true"]')!.id,
    );
    // The last stays the last (no wrap, so the count of presses is predictable); up goes back.
    key(input, 'ArrowDown');
    expect(chosen(input)).toBe('task:MISC-2');
    key(input, 'ArrowUp');
    expect(chosen(input)).toBe('task:MISC-1');
    // A click on an option chooses it too.
    ($(input.getAttribute('aria-controls')!).querySelectorAll('[role="option"]')[1] as HTMLElement).click();
    expect(chosen(input)).toBe('task:MISC-2');
  });

  it('Esc with text clears the search and keeps the dialog open; Esc on an empty field closes it', async () => {
    const input = what();
    await type(input, 'misc');
    key(input, 'Escape');
    await flush();
    expect(dialogOpen()).toBe(true);
    expect(input.value).toBe('');
    expect(optionValues(input)).toHaveLength(17);
    key(input, 'Escape');
    await flush();
    expect(dialogOpen()).toBe(false);
  });

  it('a change of Kind refills the list and clears the search', async () => {
    await openToolbarPicker();
    await type(what(), 'misc');
    const kind = dialog().querySelector('#plan-pick-kind') as HTMLSelectElement;
    kind.value = 'project';
    kind.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    expect(what().value).toBe('');
    // big and steps are covered by steps of their own? No: only feature:big/Lots and task steps are steps, so every
    // project is offered.
    expect(optionValues(what())).toEqual(expect.arrayContaining(['project:big', 'project:steps', 'project:misc']));
    expect(count().textContent).toMatch(/^\d+ projects$/);
    await closeDialog();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('2. position: First, After a step, Last', () => {
  const after = () => dialog().querySelector('#plan-pick-after') as HTMLInputElement;

  it('the position control is a labelled group of three choices, Last by default, and the step list is hidden', async () => {
    await openToolbarPicker();
    const group = dialog().querySelector('fieldset.plan-pick-where') as HTMLFieldSetElement;
    expect(group.querySelector('legend')?.textContent).toBe('Position');
    expect([...group.querySelectorAll('input[type="radio"]')].map((r) => (r as HTMLInputElement).value)).toEqual([
      'first',
      'after',
      'last',
    ]);
    expect(position('last').checked).toBe(true);
    expect((after().closest('.plan-pick-after') as HTMLElement).hidden).toBe(true);
    // No 51-item select any more.
    expect(dialog().querySelector('select[aria-label="Position"]')).toBeNull();
  });

  it('"After a step" shows a searchable list of the steps by label, the last step chosen', async () => {
    await choosePosition('after');
    expect((after().closest('.plan-pick-after') as HTMLElement).hidden).toBe(false);
    expect(after().getAttribute('role')).toBe('combobox');
    const labels = [...$(after().getAttribute('aria-controls')!).querySelectorAll('[role="option"]')].map((o) =>
      (o.textContent ?? '').replace(/\s+/g, ' ').trim(),
    );
    expect(labels).toHaveLength(50);
    expect(labels[0]).toBe('T1 Lots big');
    expect(labels[1]).toBe('T2 S-1 Task S-1');
    expect(chosen(after())).toBe('task:S-49');
    expect($('plan-pick-after-count').textContent).toBe('50 steps');
    await type(after(), 's-3');
    expect($('plan-pick-after-count').textContent).toBe('11 of 50 match');
  });

  it('the draft picker: after step 3 puts the task at step 4 in the draft, nothing is posted', async () => {
    await type(after(), 'S-2 Task');
    // S-2 is step 3.
    expect(chosen(after())).toBe('task:S-2');
    const what = dialog().querySelector('#plan-pick-what') as HTMLInputElement;
    await type(what, 'MISC-1');
    dialogButton('Add').click();
    await flush();
    expect(focusKeys()[3]).toBe('task:MISC-1');
    expect(posted).toEqual([]);
    // First puts the next one at the top.
    await openToolbarPicker();
    await type(dialog().querySelector('#plan-pick-what') as HTMLInputElement, 'MISC-2');
    await choosePosition('first');
    dialogButton('Add').click();
    await flush();
    expect(focusKeys()[0]).toBe('task:MISC-2');
    // Forget the draft for the next tests.
    ([...document.querySelectorAll('.plan-tool button')].find((b) => b.textContent === 'Discard') as HTMLButtonElement).click();
    await flush();
    expect(focusKeys()).toEqual(ORDER);
  });

  it('with a handful of steps or none, it works as before (Last is step n+1)', async () => {
    await openToolbarPicker();
    await type(dialog().querySelector('#plan-pick-what') as HTMLInputElement, 'MISC-1');
    dialogButton('Add').click();
    await flush();
    expect(focusKeys().at(-1)).toBe('task:MISC-1');
    ([...document.querySelectorAll('.plan-tool button')].find((b) => b.textContent === 'Discard') as HTMLButtonElement).click();
    await flush();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('2b. "Add to focus at …" from a card, the panel and the Selection', () => {
  beforeAll(async () => {
    $('show-flat')?.click();
    await flush();
  });

  it('the card keeps the one-click "Add to focus" and has an "at …" button beside it', async () => {
    const footer = card('MISC-1').querySelector('.summary-footer') as HTMLElement;
    expect((footer.querySelector('button.focus-add') as HTMLElement).textContent).toBe('Add to focus');
    const at = footer.querySelector('button.focus-add-at') as HTMLButtonElement;
    expect(at).not.toBeNull();
    // The visible text is part of the accessible name (WCAG 2.5.3).
    expect(at.getAttribute('aria-label')!.toLowerCase()).toContain((at.textContent ?? '').toLowerCase().trim());
    // The one click still adds last: no `at`.
    (footer.querySelector('button.focus-add') as HTMLButtonElement).click();
    await flush();
    expect(posted[0]).toEqual({ change: { action: 'add', steps: ['task:MISC-1'] }, dry: true });
    await closeDialog();
  });

  it('"at …" opens the picker with the card chosen, and each position gives the right change payload', async () => {
    const open = async () => {
      (card('MISC-1').querySelector('button.focus-add-at') as HTMLButtonElement).click();
      await flush();
    };
    await open();
    expect(dialog().querySelector('#plan-dialog-title')?.textContent).toBe('Add to focus at …');
    // The card is chosen; there is no Kind or What to pick.
    expect(dialog().querySelector('#plan-pick-kind')).toBeNull();
    expect(dialog().querySelector('#plan-pick-what')).toBeNull();
    expect(dialog().querySelector('.plan-pick-chosen')?.textContent).toMatch(/MISC-1/);
    // The detail panel did not open.
    expect($('panel').hidden).toBe(true);

    // Last (the default): no `at`, the same change as the one click.
    dialogButton('Preview').click();
    await flush();
    expect(posted.at(-1)).toEqual({ change: { action: 'add', steps: ['task:MISC-1'] }, dry: true });
    await closeDialog();

    // First: at 1.
    await open();
    await choosePosition('first');
    dialogButton('Preview').click();
    await flush();
    expect(posted.at(-1)).toEqual({ change: { action: 'add', steps: ['task:MISC-1'], at: 1 }, dry: true });
    expect(dialog().textContent).toMatch(/at step 1/);
    // Confirm saves with the same change.
    (dialog().querySelector('.button-filled') as HTMLButtonElement).click();
    await flush();
    expect(posted.at(-1)).toEqual({ change: { action: 'add', steps: ['task:MISC-1'], at: 1 }, expect: 'c1' });

    // After step 3 (S-2): at 4.
    await open();
    await choosePosition('after');
    await type(dialog().querySelector('#plan-pick-after') as HTMLInputElement, 'S-2 Task');
    dialogButton('Preview').click();
    await flush();
    expect(posted.at(-1)).toEqual({ change: { action: 'add', steps: ['task:MISC-1'], at: 4 }, dry: true });
    await closeDialog();

    // After the last step is the same as Last: no `at`.
    await open();
    await choosePosition('after');
    dialogButton('Preview').click();
    await flush();
    expect(posted.at(-1)).toEqual({ change: { action: 'add', steps: ['task:MISC-1'] }, dry: true });
    await closeDialog();
  });

  it('the detail panel has "Add to focus at …" beside "Add to focus"', async () => {
    (card('MISC-2').querySelector('.summary-button') as HTMLButtonElement).click();
    await flush();
    const texts = [...$('panel').querySelectorAll('button')].map((b) => (b.textContent ?? '').trim());
    expect(texts).toContain('Add to focus');
    const at = [...$('panel').querySelectorAll('button')].find((b) => b.textContent === 'Add to focus at …') as HTMLButtonElement;
    expect(at).toBeDefined();
    at.click();
    await flush();
    expect(dialog().querySelector('.plan-pick-chosen')?.textContent).toMatch(/MISC-2/);
    await choosePosition('first');
    dialogButton('Preview').click();
    await flush();
    expect(posted.at(-1)).toEqual({ change: { action: 'add', steps: ['task:MISC-2'], at: 1 }, dry: true });
    await closeDialog();
    ($('panel').querySelector('.button-icon') as HTMLButtonElement | null)?.click();
    await flush();
  });

  it('the Selection has "Add to focus at …" that opens the picker with every selected outside task chosen', async () => {
    for (const id of ['MISC-1', 'MISC-2', 'S-1']) {
      (card(id).querySelector('.mark-box input') as HTMLInputElement).click();
      await flush();
    }
    const actions = [...$('optionLine').querySelectorAll('[data-action]')] as HTMLElement[];
    expect(actions.map((b) => b.dataset.action)).toContain('focus-add');
    const at = actions.find((b) => b.dataset.action === 'focus-add-at') as HTMLButtonElement;
    expect(at?.textContent).toBe('Add to focus at …');
    at.click();
    await flush();
    const listed = dialog().querySelector('.plan-pick-chosen')?.textContent ?? '';
    expect(listed).toMatch(/MISC-1/);
    expect(listed).toMatch(/MISC-2/);
    // S-1 is a step already, so it is not added (as the one-click bulk add).
    expect(listed).not.toMatch(/S-1\b/);
    await choosePosition('first');
    dialogButton('Preview').click();
    await flush();
    expect(posted.at(-1)).toEqual({ change: { action: 'add', steps: ['task:MISC-1', 'task:MISC-2'], at: 1 }, dry: true });
    await closeDialog();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('3. a long task list, 50 steps, Move to top and bottom', () => {
  beforeAll(async () => {
    $('show-plan').click();
    await flush();
  });

  it('a step with 15 tasks: the open list is capped with a focusable, labelled scroll area and a visible hint', async () => {
    const toggle = row('feature:big/Lots').querySelector('.plan-tasks-toggle') as HTMLButtonElement;
    expect(toggle.textContent).toMatch(/Tasks \(15\)/);
    toggle.click();
    await flush();
    const list = row('feature:big/Lots').querySelector('.plan-tasks-list') as HTMLElement;
    expect(list.classList.contains('is-capped')).toBe(true);
    expect(list.getAttribute('tabindex')).toBe('0');
    expect(list.getAttribute('aria-label')).toMatch(/15 tasks/);
    expect(list.querySelectorAll('li')).toHaveLength(15);
    const hint = row('feature:big/Lots').querySelector('.plan-tasks-hint') as HTMLElement;
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toMatch(/15/);
    expect(hint.textContent).toMatch(/scroll/i);
    // A long title stays one line with the full text in the title.
    expect((list.querySelector('.plan-tasks-title') as HTMLElement).getAttribute('title')).toBe('Task BIG-1');
  });

  it('a step with 12 tasks or fewer is not capped (no scroll area, no hint)', async () => {
    const toggle = row('task:S-1').querySelector('.plan-tasks-toggle') as HTMLButtonElement;
    toggle.click();
    await flush();
    const list = row('task:S-1').querySelector('.plan-tasks-list') as HTMLElement;
    expect(list.classList.contains('is-capped')).toBe(false);
    expect(list.hasAttribute('tabindex')).toBe(false);
    expect(row('task:S-1').querySelector('.plan-tasks-hint')).toBeNull();
  });

  it('the CSS caps the list at 12 rows with its own scroll and a focus ring, with tokens only', () => {
    const css = readFileSync(join(CLIENT, 'board.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const capped = css.match(/\.plan-tasks-list\.is-capped\s*\{([^}]*)\}/);
    expect(capped).not.toBeNull();
    expect(capped![1]).toMatch(/max-height:\s*calc\(12\s*\*\s*var\(--plan-task-row\)/);
    expect(capped![1]).toMatch(/overflow-y:\s*auto/);
    expect(css).toMatch(/\.plan-tasks-list\.is-capped:focus-visible\s*\{[^}]*outline/);
    // Tokens only. The one raw color allowed is the board's black menu shadow (the same in both modes).
    for (const block of css.match(/\.plan-(tasks|list-compact|step-menu|pick)[^{]*\{[^}]*\}/g) ?? [])
      expect(block.replace(/rgb\(0 0 0 \/ [\d.]+\)/g, '')).not.toMatch(/#[0-9a-f]{3,6}\b|rgb\(/i);
  });

  it('In focus with more than 12 steps draws compact rows; the steps keep their order and labels', () => {
    expect(focusKeys()).toHaveLength(50);
    expect(focusList().classList.contains('plan-list-compact')).toBe(true);
    const css = readFileSync(join(CLIENT, 'board.css'), 'utf8');
    expect(css).toMatch(/\.plan-list-compact\s*>\s*\.plan-element\s*\{/);
  });

  it('every step has a menu with Move to top and Move to bottom; they move the step in the draft', async () => {
    const menuButton = (k: string) => row(k).querySelector('.plan-step-menu-button') as HTMLButtonElement;
    const b = menuButton('task:S-30');
    expect(b.getAttribute('aria-haspopup')).toBe('menu');
    expect(b.getAttribute('aria-expanded')).toBe('false');
    expect(b.getAttribute('aria-label')).toMatch(/S-30/);
    b.click();
    await flush();
    expect(menuButton('task:S-30').getAttribute('aria-expanded')).toBe('true');
    const menu = row('task:S-30').querySelector('[role="menu"]') as HTMLElement;
    const items = [...menu.querySelectorAll('[role="menuitem"]')] as HTMLButtonElement[];
    expect(items.map((x) => x.textContent)).toEqual(['Move to top', 'Move to bottom']);
    // The first item has focus, the arrows move between them, Esc closes and gives the focus back.
    expect(document.activeElement).toBe(items[0]);
    key(items[0], 'ArrowDown');
    expect(document.activeElement).toBe(items[1]);
    key(items[1], 'Escape');
    await flush();
    expect(row('task:S-30').querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(menuButton('task:S-30'));

    menuButton('task:S-30').click();
    await flush();
    (row('task:S-30').querySelector('[role="menuitem"]') as HTMLButtonElement).click();
    await flush();
    expect(focusKeys()[0]).toBe('task:S-30');
    expect(document.querySelector('.plan-draft')?.textContent).toMatch(/Draft, not saved/);
    // The focus stays on the moved step's menu button.
    expect(document.activeElement).toBe(menuButton('task:S-30'));

    menuButton('task:S-30').click();
    await flush();
    const top = [...row('task:S-30').querySelectorAll('[role="menuitem"]')] as HTMLButtonElement[];
    // Already first: Move to top is disabled.
    expect(top[0].disabled).toBe(true);
    top[1].click();
    await flush();
    expect(focusKeys().at(-1)).toBe('task:S-30');
    expect(posted).toEqual([]);
  });

  it('a lifted step: Home moves it to the top and End to the bottom', async () => {
    const r = () => row('task:S-10');
    r().focus();
    key(r(), ' ');
    await flush();
    key(r(), 'Home');
    await flush();
    expect(focusKeys()[0]).toBe('task:S-10');
    key(r(), 'End');
    await flush();
    expect(focusKeys().at(-1)).toBe('task:S-10');
    key(r(), 'Escape');
    await flush();
    // Esc put back the draft from before the lift (S-30 at the bottom from the test above).
    expect(focusKeys().at(-1)).toBe('task:S-30');
    ([...document.querySelectorAll('.plan-tool button')].find((b) => b.textContent === 'Discard') as HTMLButtonElement).click();
    await flush();
    expect(focusKeys()).toEqual(ORDER);
  });

  describe('the drop bar with 50 compact rows', () => {
    // Rows 30 px tall with a 4 px gap: row i spans 34*i to 34*i+30 (midpoint 34*i+15). jsdom has no layout.
    let real: typeof Element.prototype.getBoundingClientRect;
    beforeAll(() => {
      real = Element.prototype.getBoundingClientRect;
      Element.prototype.getBoundingClientRect = function (this: Element) {
        const el = this as HTMLElement;
        if (el.matches?.('.plan-list[data-col="focus"]'))
          return { top: 0, bottom: 1700, height: 1700, left: 0, right: 300, width: 300, x: 0, y: 0 } as DOMRect;
        if (el.matches?.('.plan-list[data-col="focus"] > .plan-element')) {
          const i = [...el.parentElement!.querySelectorAll(':scope > .plan-element')].indexOf(el);
          return { top: 34 * i, bottom: 34 * i + 30, height: 30, left: 0, right: 300, width: 300, x: 0, y: 34 * i } as DOMRect;
        }
        return real.call(this);
      };
    });
    afterAll(() => {
      Element.prototype.getBoundingClientRect = real;
    });
    function drag(kind: string, target: Element, y = 0) {
      const e = new Event(kind, { bubbles: true, cancelable: true });
      Object.defineProperty(e, 'dataTransfer', { value: { setData() {}, effectAllowed: '', dropEffect: '' } });
      Object.defineProperty(e, 'clientY', { value: y });
      Object.defineProperty(e, 'relatedTarget', { value: null });
      target.dispatchEvent(e);
    }

    it('the bar sits where releaseIndex drops the step, and the drop lands there', async () => {
      // Drag the last step (S-49, row 49). y 150 is above the middle of row 4 (151): index 4 among the other rows.
      drag('dragstart', row('task:S-49'));
      drag('dragover', focusList(), 150);
      const bar = focusList().querySelector('.plan-drop-bar') as HTMLElement;
      expect(bar.dataset.index).toBe('4');
      // Between row 3 (ends 132) and row 4 (starts 136).
      const top = parseFloat(bar.style.top);
      expect(top).toBeGreaterThanOrEqual(132 - 3);
      expect(top).toBeLessThanOrEqual(136);
      drag('drop', focusList(), 150);
      await flush();
      expect(document.querySelector('.plan-drop-bar')).toBeNull();
      expect(focusKeys().indexOf('task:S-49')).toBe(4);
      ([...document.querySelectorAll('.plan-tool button')].find((b) => b.textContent === 'Discard') as HTMLButtonElement).click();
      await flush();
    });
  });
});
