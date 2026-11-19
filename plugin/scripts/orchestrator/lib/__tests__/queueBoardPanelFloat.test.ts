/**
 * @vitest-environment jsdom
 */
// =============================================================
// queueBoardPanelFloat.test.ts: the side panel floats over the board instead of pushing it (QA-1c Q5).
//
// Before, from 1200 px the panel docked: the body got padding-right for it, so opening a task, Settings or the help
// narrowed the work area and rewrapped it (the focus line pushed "Edit focus" to a new row, the dependency view's top
// row rewrapped). Now board.panelMode picks how it sits on a wide screen: "float" (the default) lays it over the board
// as an overlay and changes nothing in the work area's layout, "beside" keeps the docked panel for those who want it.
//
// What the tests prove:
//   - float at 1440 px: body.panel-float, no body.panel-beside, no body padding, and the work area (the focus line, the
//     board, the top) keeps its classes and styles, so nothing reflows; the CSS for float only places the panel itself
//     and the messages, never the body, the top or the board; not modal (no aria-modal, no scrim, no inert, no trap),
//   - float at 900 px: the modal sheet as before (scrim, aria-modal, inert board) and still no body padding,
//   - a pointer click outside closes it, focus is not pulled away from what the click focused; a press that starts in
//     the panel, a drag (the graph's pan), a keyboard activation and a click in a menu or dialog do not close it,
//   - an edit form with unsaved changes, or a new-task form, keeps it open with a short hint; an unchanged one does not,
//   - a click on another card swaps the content, Esc and X close it and focus goes back to the card,
//   - beside restores the docked behavior (body.panel-beside, no outside-click close), and a change of the setting on
//     the next poll applies to an open panel at once,
//   - Settings, the help and the Dependencies view's task panel float and close the same way.
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
const iso = new Date(Date.now() - 86_400_000).toISOString();

function task(id: string, value: number) {
  return {
    id,
    title: `Task ${id}`,
    project: 'ex',
    domain: `ui-${id}`,
    class: 'K',
    value,
    content_min: 30,
    status: 'waiting',
    depends_on: id === 'EX-2' ? ['EX-1'] : [],
    waiting_on: [],
    owned_files: [`file/${id}.ts`],
    owner_db: [],
    shared_patch: [],
    mission: `scripts/.queue/mission/${id}.md`,
    added_by: 'test',
    added_at: iso,
  };
}
function makeQueue() {
  return {
    created: iso,
    limits: { maxConcurrent: 5, maxDPlus: 2, maxPerDomain: 5, maxDb: 2 },
    tasks: ['EX-1', 'EX-2', 'EX-3'].map((id, i) => task(id, 9 - i)),
    projects: { ex: { title: 'Example', prefixes: ['EX-'] } },
    areas: {},
    question: [],
    resolutions: [],
    changelog: [],
    // A focus, so the focus line (#focusLine) is drawn with its row and "Edit focus".
    focus: { from: iso, rest: 'fill', order: ['task:EX-1', 'task:EX-2'], drag_with_dependencies: true },
  };
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

const w = window as any;
/** The media query answer: `wide` makes the side panel's (min-width: 1200px) match. */
let wide = true;
const mediaListeners: Array<() => void> = [];
/** The state the stubbed server answers with; a test changes panelMode and the version to send a new one. */
let state: { version: string; data: any };
/** The version counter for setMode. */
let versionNr = 1;
/**
 * Sends a new state with board.panelMode set to `mode`, as the server does on the next poll after the gear changed the
 * config, and lets the board fetch it (a window focus fetches at once, start.js).
 */
async function setMode(mode: string) {
  if (state.data.panelMode === mode) return;
  versionNr += 1;
  state = { version: `v${versionNr}`, data: { ...state.data, panelMode: mode } };
  window.dispatchEvent(new Event('focus'));
  await flush();
}

beforeAll(async () => {
  state = { version: 'v1', data: { ...T.board(makeQueue()), gitError: null, logo: false, panelMode: 'float' } };
  const html = readFileSync(join(CLIENT, 'index.html'), 'utf8');
  document.documentElement.innerHTML = html.replace(/<!doctype[^>]*>/i, '').replace(/<\/?html[^>]*>/g, '');
  sessionStorage.setItem('queue-board-key', 'testKey');
  localStorage.clear();
  // The flat view, so the first state lands on the cards (not Decisions).
  localStorage.setItem('queue-board-view', 'flat');
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
    // Settings answers with a server error, so the gear's panel draws its short error state (this file tests where the
    // panel sits, not the settings themselves; queueBoardSettingsTabs.test.ts has the full answer).
    ok: !filePath.startsWith('/api/settings'),
    status: filePath.startsWith('/api/settings') ? 500 : 200,
    json: async () => {
      if (filePath.startsWith('/api/settings')) return { ok: false, message: 'not in this test' };
      if (filePath.startsWith('/api/state'))
        return filePath.includes(`version=${state.version}`) ? { version: state.version, unchanged: true } : state;
      const t = /^\/api\/task\?id=([^&]+)/.exec(filePath);
      if (t) {
        const id = decodeURIComponent(t[1]);
        return { ok: true, mission: { text: `Mission of ${id}.`, path: null }, description: '', branch: { name: `queue/${id}`, exists: false } };
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
const title = () => document.getElementById('panel-title')?.textContent ?? null;
const cardButton = (id: string) =>
  document.querySelector(`.summary[data-id="${id}"] .summary-button`) as HTMLButtonElement;

/** A real pointer click: the press (pointerdown and mousedown) and the click, at one spot unless `to` moves it. */
function pointerClick(target: Element, o: { at?: [number, number]; to?: [number, number]; pressOn?: Element } = {}) {
  const [x, y] = o.at ?? [10, 10];
  const [x2, y2] = o.to ?? [x, y];
  const press = o.pressOn ?? target;
  for (const type of ['pointerdown', 'mousedown'])
    press.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }));
  for (const type of ['pointerup', 'mouseup'])
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x2, clientY: y2, button: 0 }));
  target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x2, clientY: y2, detail: 1, button: 0 }));
}
/** Opens a card as a mouse does (the button gets focus, then the press and the click). */
async function openCard(id: string) {
  const b = cardButton(id);
  expect(b, id).not.toBeNull();
  b.focus();
  pointerClick(b);
  await flush();
}
function esc() {
  document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
}
function closeIfOpen() {
  if (!panel().hidden) (panel().querySelector('.panel-header .button-icon') as HTMLButtonElement)?.click();
  if (!panel().hidden) esc();
}
/** A spot on the board outside every card: the board element itself. */
const boardArea = () => document.getElementById('board') as HTMLElement;
/**
 * The class list and inline style of the work area, to prove that opening the panel changes nothing there that could
 * move it. Left out: the body's own panel-* class (the one thing that places the panel) and chain-active on the board
 * (the highlight of the opened card's chain, colors only, as before).
 */
const workArea = () =>
  ['#focusLine', '#board', 'header.top', 'body'].map((sel) => {
    const e = document.querySelector(sel) as HTMLElement;
    const classes = [...e.classList].filter((c) => !/^panel-/.test(c) && c !== 'chain-active').join(' ');
    return `${sel}|${classes}|${e.getAttribute('style') ?? ''}`;
  });

beforeEach(async () => {
  closeIfOpen();
  wide = true;
  await setMode('float');
  if (document.getElementById('show-flat')?.getAttribute('aria-selected') !== 'true') {
    (document.getElementById('show-flat') as HTMLElement).click();
    await flush();
  }
});

describe('float at 1440 px: over the board, nothing in the work area changes', () => {
  it('sets body.panel-float, no panel-beside and no body padding; not modal', async () => {
    w.innerWidth = 1440;
    expect(document.getElementById('focusLine')?.querySelector('.focus-row')).not.toBeNull();
    const before = workArea();
    await openCard('EX-1');
    expect(panel().hidden).toBe(false);
    expect(document.body.classList.contains('panel-float')).toBe(true);
    expect(document.body.classList.contains('panel-beside')).toBe(false);
    expect(document.body.style.paddingRight).toBe('');
    // The focus line, the board, the top and the body keep their classes and styles: nothing for a reflow.
    expect(workArea()).toEqual(before);
    expect(panel().hasAttribute('aria-modal')).toBe(false);
    expect(backdrop().hidden).toBe(true);
    for (const sel of ['#board', 'header.top', '#focusLine'])
      expect(document.querySelector(sel)?.hasAttribute('inert'), sel).toBe(false);
    // Focus went into the panel and stayed there through the redraw when the task's details arrived.
    expect(panel().contains(document.activeElement)).toBe(true);
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    (panel().querySelector('.button-icon') as HTMLElement).dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false);
  });

  it('the float CSS places only the panel and the messages, never the body, the top or the board', () => {
    const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter((m) => /panel-float/.test(m[1]));
    expect(rules.length).toBeGreaterThan(0);
    for (const [, sel, body] of rules) {
      for (const s of sel.split(',').map((x) => x.trim()).filter((x) => /panel-float/.test(x)))
        expect(s, s).toMatch(/^body\.panel-float \.(panel|toaster)$/);
      expect(body, sel).not.toMatch(/padding|margin/);
    }
    // The floating panel sits below the top, with the overlay elevation from the theme tokens.
    const p = /body\.panel-float \.panel\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(p).toMatch(/top:\s*var\(--top-height\)/);
    expect(p).toMatch(/width:\s*var\(--panel-side\)/);
    expect(p).toMatch(/box-shadow:\s*var\(--elevation-overlay\)/);
    expect(css).toMatch(/--elevation-overlay:/);
  });
});

describe('float at 900 px: the modal sheet as before', () => {
  it('is modal with the scrim and an inert board, and the body gets no padding', async () => {
    wide = false;
    w.innerWidth = 900;
    await openCard('EX-1');
    expect(panel().getAttribute('aria-modal')).toBe('true');
    expect(backdrop().hidden).toBe(false);
    expect(document.getElementById('board')?.hasAttribute('inert')).toBe(true);
    expect(document.body.classList.contains('panel-float')).toBe(false);
    expect(document.body.classList.contains('panel-beside')).toBe(false);
    expect(document.body.style.paddingRight).toBe('');
    // A click on the scrim closes it, as before.
    pointerClick(backdrop());
    expect(panel().hidden).toBe(true);
  });
});

describe('a click outside closes the floating panel', () => {
  it('closes on a pointer click on the board, and does not pull focus away from what the click focused', async () => {
    await openCard('EX-1');
    const search = document.querySelector('header.top button, header.top input') as HTMLElement;
    search.focus();
    pointerClick(boardArea());
    expect(panel().hidden).toBe(true);
    expect(document.body.classList.contains('panel-float')).toBe(false);
    expect(document.activeElement).toBe(search);
  });

  it('puts focus back on the card when the click left focus nowhere', async () => {
    await openCard('EX-2');
    (document.activeElement as HTMLElement)?.blur();
    pointerClick(boardArea());
    expect(panel().hidden).toBe(true);
    expect(document.activeElement).toBe(cardButton('EX-2'));
  });

  it('stays open for a press that starts in the panel, a drag, and a keyboard activation outside', async () => {
    await openCard('EX-1');
    // A text selection that starts in the panel and ends outside it.
    pointerClick(boardArea(), { pressOn: panel().querySelector('h2') as Element });
    expect(panel().hidden).toBe(false);
    // A drag (the graph's pan, a lane drag): the pointer moved between the press and the click.
    pointerClick(boardArea(), { at: [10, 10], to: [80, 10] });
    expect(panel().hidden).toBe(false);
    // Enter or Space on a control outside fires a click without a press: the keyboard keeps the panel (Esc closes it).
    boardArea().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }));
    expect(panel().hidden).toBe(false);
  });

  it('does not count a click in a menu or a dialog opened from the panel, or on a control that went away', async () => {
    await openCard('EX-1');
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    const item = document.createElement('button');
    item.setAttribute('role', 'menuitem');
    menu.append(item);
    document.body.append(menu);
    pointerClick(item);
    expect(panel().hidden).toBe(false);
    menu.remove();
    // A dialog over the board (the guard's confirm, the focus picker): role dialog or alertdialog.
    const guard = document.getElementById('guard-background') as HTMLElement;
    guard.hidden = false;
    pointerClick(document.getElementById('guard') as HTMLElement);
    expect(panel().hidden).toBe(false);
    guard.hidden = true;
    // A menu item that removes itself on click (the menu closes before the click reaches the document).
    const gone = document.createElement('button');
    gone.addEventListener('click', () => gone.remove());
    document.body.append(gone);
    pointerClick(gone);
    expect(panel().hidden).toBe(false);
  });

  it('a click on another card swaps the content instead of closing; the same card keeps it open', async () => {
    await openCard('EX-1');
    await openCard('EX-2');
    expect(panel().hidden).toBe(false);
    expect(title()).toBe('Task EX-2');
    await openCard('EX-2');
    expect(panel().hidden).toBe(false);
    expect(title()).toBe('Task EX-2');
  });
});

describe('unsaved forms keep the panel open', () => {
  it('an Edit form with a changed field stays open with a short hint; an unchanged one closes', async () => {
    await openCard('EX-1');
    const edit = [...panel().querySelectorAll('.actions button')].find((b) => b.textContent === 'Edit') as HTMLElement;
    edit.click();
    await flush();
    // Unchanged: an outside click closes it like any panel.
    pointerClick(boardArea());
    expect(panel().hidden).toBe(true);
    await openCard('EX-1');
    ([...panel().querySelectorAll('.actions button')].find((b) => b.textContent === 'Edit') as HTMLElement).click();
    await flush();
    const value = panel().querySelector('#edit-value') as HTMLInputElement;
    value.value = '3';
    value.dispatchEvent(new Event('input', { bubbles: true }));
    pointerClick(boardArea());
    expect(panel().hidden).toBe(false);
    expect(document.getElementById('message')?.textContent).toMatch(/unsaved/i);
    // X still closes it (the owner's explicit choice), and so does Esc once the form is closed.
    (panel().querySelector('.panel-header .button-icon') as HTMLButtonElement).click();
    expect(panel().hidden).toBe(true);
  });

  it('a typed reason in the Cancel form keeps it open too', async () => {
    await openCard('EX-3');
    ([...panel().querySelectorAll('.actions button')].find((b) => b.textContent === 'Cancel task') as HTMLElement).click();
    await flush();
    const reason = panel().querySelector('#cancel-reason') as HTMLInputElement;
    reason.value = 'not needed';
    reason.dispatchEvent(new Event('input', { bubbles: true }));
    pointerClick(boardArea());
    expect(panel().hidden).toBe(false);
  });

  it('a new-task form (form[data-new-task]) keeps it open whatever it holds, also on the narrow scrim', async () => {
    await openCard('EX-1');
    const form = document.createElement('form');
    form.setAttribute('data-new-task', '');
    panel().append(form);
    pointerClick(boardArea());
    expect(panel().hidden).toBe(false);
    wide = false;
    for (const f of mediaListeners) f();
    expect(backdrop().hidden).toBe(false);
    pointerClick(backdrop());
    expect(panel().hidden).toBe(false);
    form.remove();
    pointerClick(backdrop());
    expect(panel().hidden).toBe(true);
  });
});

describe('Esc and X', () => {
  it('Esc closes the floating panel and focus goes back to the card', async () => {
    await openCard('EX-2');
    esc();
    expect(panel().hidden).toBe(true);
    expect(document.activeElement).toBe(cardButton('EX-2'));
  });

  it('X closes it and focus goes back to the card', async () => {
    await openCard('EX-1');
    (panel().querySelector('.panel-header .button-icon') as HTMLButtonElement).click();
    expect(panel().hidden).toBe(true);
    expect(document.body.classList.contains('panel-float')).toBe(false);
    expect(document.activeElement).toBe(cardButton('EX-1'));
  });
});

describe('beside: the docked panel from before', () => {
  it('makes room (body.panel-beside), is not modal, and an outside click does not close it', async () => {
    await setMode('beside');
    await openCard('EX-1');
    expect(document.body.classList.contains('panel-beside')).toBe(true);
    expect(document.body.classList.contains('panel-float')).toBe(false);
    expect(panel().hasAttribute('aria-modal')).toBe(false);
    expect(backdrop().hidden).toBe(true);
    pointerClick(boardArea());
    expect(panel().hidden).toBe(false);
    esc();
    expect(panel().hidden).toBe(true);
    expect(document.body.classList.contains('panel-beside')).toBe(false);
  });

  it('keeps the docked CSS: the body padding and the full-width top', () => {
    expect(/body\.panel-beside\s*\{([^}]*)\}/.exec(css)?.[1] ?? '').toMatch(/padding-right:\s*var\(--panel-side\)/);
    expect(/body\.panel-beside \.top\s*\{([^}]*)\}/.exec(css)?.[1] ?? '').toMatch(/margin-right/);
  });

  it('a new setting on the next poll applies to the open panel at once', async () => {
    await openCard('EX-1');
    expect(document.body.classList.contains('panel-float')).toBe(true);
    await setMode('beside');
    expect(panel().hidden).toBe(false);
    expect(document.body.classList.contains('panel-beside')).toBe(true);
    expect(document.body.classList.contains('panel-float')).toBe(false);
    await setMode('float');
    expect(document.body.classList.contains('panel-float')).toBe(true);
    expect(document.body.classList.contains('panel-beside')).toBe(false);
  });

  it('an unknown value falls back to float', async () => {
    await setMode('sideways');
    await openCard('EX-1');
    expect(document.body.classList.contains('panel-float')).toBe(true);
  });
});

describe('Settings, the help and the Dependencies view float and close the same way', () => {
  it('Settings floats, closes on an outside click, and the gear still toggles it', async () => {
    const gear = document.getElementById('settings') as HTMLElement;
    pointerClick(gear);
    await flush();
    expect(panel().hidden).toBe(false);
    expect(gear.getAttribute('aria-expanded')).toBe('true');
    expect(document.body.classList.contains('panel-float')).toBe(true);
    expect(document.body.style.paddingRight).toBe('');
    pointerClick(boardArea());
    expect(panel().hidden).toBe(true);
    // The gear: open, and a second click closes (no double handling by the outside click).
    pointerClick(gear);
    await flush();
    expect(panel().hidden).toBe(false);
    pointerClick(gear);
    await flush();
    expect(panel().hidden).toBe(true);
  });

  it('the help floats and closes on an outside click', async () => {
    // A room's "?" opens the help at its section (menus.js roomHelp).
    const help = document.querySelector('.room-help') as HTMLElement;
    expect(help).not.toBeNull();
    help.focus();
    pointerClick(help);
    await flush();
    expect(panel().hidden).toBe(false);
    expect(title()).toBe('How to use the board');
    expect(document.body.classList.contains('panel-float')).toBe(true);
    expect(document.body.classList.contains('panel-float')).toBe(true);
    pointerClick(boardArea());
    expect(panel().hidden).toBe(true);
  });

  it('a task opened from the Dependencies view floats, swaps on another node and closes on an outside click', async () => {
    (document.getElementById('show-graph') as HTMLElement).click();
    await flush();
    const node = (id: string) => document.querySelector(`.graph-svg .node[data-id="${id}"]`) as Element;
    expect(node('EX-1')).not.toBeNull();
    pointerClick(node('EX-1'));
    await flush();
    expect(title()).toBe('Task EX-1');
    expect(document.body.classList.contains('panel-float')).toBe(true);
    pointerClick(node('EX-2'));
    await flush();
    expect(title()).toBe('Task EX-2');
    pointerClick(document.querySelector('.graph-surface') as Element);
    expect(panel().hidden).toBe(true);
  });
});
