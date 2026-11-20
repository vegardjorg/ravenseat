/**
 * @vitest-environment jsdom
 */
// =============================================================
// queueBoardPlansCapture.test.ts: "+ New plan" in the Plans room (P6 of plans/plans-tab-ux-review-2026-11-19.md).
//
// What the tests prove:
//   - the button says "+ New plan", tells its key (n) and which form it opens, and is gone with features.plans.inbox off,
//   - the form asks for a title only (Title, required, up to 160) and offers "What and why, in your own words" as
//     optional, with one "Add to inbox" button and Cancel; Escape closes it and focus goes back to the button,
//   - Add to inbox saves at once (POST /api/plan-capture, no preview), closes the form, and offers Undo in the board's
//     toast; Undo sends the changelog number to POST /api/plan-undo,
//   - an empty title, a failed save and the same title again are said in words, and what was typed is kept on failure,
//   - n opens the form from the keyboard (keyAction), never while typing,
//   - the Roadmap: the button sits in its toolbar, and the empty register invites the first plan,
//   - the wiring: capture.js loads before plans.js, the server serves it and routes /api/plan-capture through queue.mjs
//     plan capture with the text in a file; no innerHTML; tokens only in the CSS.
// =============================================================
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const V = require('../queuePlanView.js') as any;
const I = require('../planInbox.js') as any;
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

const CLIENT = join(__dirname, '..', '..', 'queue-board');
const captureJs = readFileSync(join(CLIENT, 'plans', 'capture.js'), 'utf8');
const roadmapJs = readFileSync(join(CLIENT, 'plans', 'roadmap.js'), 'utf8');
const css = readFileSync(join(CLIENT, 'plans', 'plans.css'), 'utf8');
const html = readFileSync(join(CLIENT, 'index.html'), 'utf8');
const server = readFileSync(join(CLIENT, '..', 'queue-board.mjs'), 'utf8');
const plansJs = readFileSync(join(CLIENT, 'plans', 'plans.js'), 'utf8');
const workJs = readFileSync(join(CLIENT, 'plans', 'work.js'), 'utf8');

type Post = Record<string, unknown>;

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

/** capture.js in jsdom with the helpers plans.js gives it; `answer` is what the fake server says. */
function setup({ on = true, open = false, answer = null as any, fail = null as string | null, title = '', text = '' } = {}) {
  const w: any = { QueuePlanView: V };
  new Function('window', captureJs)(w);
  const calls: { post: [string, Post][]; message: [string, boolean][]; undo: [string, () => void][]; set: Post[]; refresh: number } = {
    post: [],
    message: [],
    undo: [],
    set: [],
    refresh: 0,
  };
  const st: any = { open, title, text, busy: false, error: null };
  const h = {
    el,
    featureOn: () => on,
    capture: () => st,
    setCapture: (change: Post) => {
      calls.set.push(change);
      Object.assign(st, change);
      redraw();
    },
    post: async (path: string, body: Post) => {
      calls.post.push([path, body]);
      if (fail) throw new Error(fail);
      return path === '/api/plan-undo' ? { ok: true, message: 'Undone (one change).' } : answer;
    },
    message: (t: string, error = false) => calls.message.push([t, error]),
    undoToast: (t: string, fn: () => void) => calls.undo.push([t, fn]),
    refresh: async () => {
      calls.refresh += 1;
    },
  };
  const root = document.createElement('div');
  document.body.replaceChildren(root);
  function redraw() {
    root.replaceChildren(...[w.QueuePlanCapture.button(h), w.QueuePlanCapture.form(h)].filter(Boolean));
  }
  redraw();
  return { w, h, calls, root, st, redraw };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('the button', () => {
  it('"+ New plan", with its key and the form it opens; a click opens the form with focus on Title', async () => {
    const { root, st } = setup();
    const b = root.querySelector('button.plans-capture-open') as HTMLButtonElement;
    expect(b.textContent).toBe('+ New plan');
    expect(b.getAttribute('aria-keyshortcuts')).toBe('n');
    expect(b.getAttribute('aria-expanded')).toBe('false');
    expect(b.getAttribute('aria-controls')).toBe('plans-capture');
    b.click();
    expect(st.open).toBe(true);
    expect(root.querySelector('#plans-capture')).toBeTruthy();
    expect((root.querySelector('button.plans-capture-open') as HTMLElement).getAttribute('aria-expanded')).toBe('true');
  });
  it('gone with features.plans.inbox off', () => {
    const { root } = setup({ on: false, open: true });
    expect(root.querySelector('button.plans-capture-open')).toBe(null);
    expect(root.querySelector('#plans-capture')).toBe(null);
  });
});

describe('the form', () => {
  it('only a title is required; the text is optional; one Add to inbox button and Cancel', () => {
    const { root } = setup({ open: true });
    const form = root.querySelector('form#plans-capture') as HTMLFormElement;
    expect(form.getAttribute('aria-labelledby')).toBe('plans-capture-heading');
    expect(root.querySelector('#plans-capture-heading')?.textContent).toBe('New plan');
    const title = form.querySelector('input#plans-capture-title') as HTMLInputElement;
    expect(title.hasAttribute('required')).toBe(true);
    expect(title.getAttribute('maxlength')).toBe('160');
    expect(form.querySelector('label[for="plans-capture-title"]')?.textContent).toBe('Title');
    const text = form.querySelector('textarea#plans-capture-text') as HTMLTextAreaElement;
    expect(text.hasAttribute('required')).toBe(false);
    expect(text.getAttribute('maxlength')).toBe(String(I.TEXT_MAX));
    expect(form.querySelector('label[for="plans-capture-text"]')?.textContent).toBe('What and why, in your own words (optional)');
    const buttons = [...form.querySelectorAll('button')].map((b) => b.textContent);
    expect(buttons).toEqual(['Add to inbox', 'Cancel']);
    expect((form.querySelector('button[type="submit"]') as HTMLElement).textContent).toBe('Add to inbox');
    // nothing else is asked: no id, project, priority or category
    expect(form.querySelectorAll('input, textarea, select')).toHaveLength(2);
  });
  it('what is typed is kept in the state (a live redraw keeps it)', () => {
    const { root, st, redraw } = setup({ open: true });
    const title = root.querySelector('#plans-capture-title') as HTMLInputElement;
    title.value = 'Dark mode';
    title.dispatchEvent(new Event('input'));
    expect(st.title).toBe('Dark mode');
    redraw();
    expect((root.querySelector('#plans-capture-title') as HTMLInputElement).value).toBe('Dark mode');
  });
  it('the soft limit is a note, not a stop', () => {
    const { root } = setup({ open: true, title: 'A', text: 'x'.repeat(I.TEXT_SOFT + 1) });
    const note = root.querySelector('#plans-capture-count') as HTMLElement;
    expect(note.textContent).toMatch(/2001 characters/);
    expect(note.textContent).toMatch(/plan document/);
    expect(root.querySelector('#plans-capture-text')?.getAttribute('aria-describedby')).toBe('plans-capture-count');
  });
  it('Escape and Cancel close it; the typed text goes with it', () => {
    const { root, st } = setup({ open: true, title: 'x' });
    (root.querySelector('form') as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(st.open).toBe(false);
    expect(st.title).toBe('');
    const again = setup({ open: true });
    ([...again.root.querySelectorAll('button')].find((b) => b.textContent === 'Cancel') as HTMLElement).click();
    expect(again.st.open).toBe(false);
  });
});

describe('Add to inbox', () => {
  it('saves at once, closes the form and offers Undo, which sends the changelog number', async () => {
    const { root, calls, st } = setup({
      open: true,
      title: 'Dark mode',
      text: 'People read at night.',
      answer: { ok: true, id: 'PL-DARK-MODE-1', log: 7, message: 'Added to the inbox. Claude sorts it the next time plans are worked on.' },
    });
    (root.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    expect(calls.post[0]).toEqual(['/api/plan-capture', { title: 'Dark mode', text: 'People read at night.' }]);
    expect(st.open).toBe(false);
    expect(st.title).toBe('');
    expect(calls.undo).toHaveLength(1);
    expect(calls.undo[0][0]).toBe('Added to the inbox. Claude sorts it the next time plans are worked on.');
    expect(calls.refresh).toBe(1);
    calls.undo[0][1]();
    await flush();
    expect(calls.post[1]).toEqual(['/api/plan-undo', { nr: [7] }]);
    expect(calls.message.at(-1)).toEqual(['Undone (one change).', false]);
  });
  it('an empty title is said in words, and nothing is sent', async () => {
    const { root, calls } = setup({ open: true, title: '   ' });
    (root.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    expect(calls.post).toHaveLength(0);
    const err = root.querySelector('.plans-capture-error') as HTMLElement;
    expect(err.getAttribute('role')).toBe('alert');
    expect(err.textContent).toBe('Write a title first.');
  });
  it('a failed save keeps what was typed and says why', async () => {
    const { root, st } = setup({ open: true, title: 'Dark mode', fail: 'the board is offline' });
    (root.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    expect(st.open).toBe(true);
    expect(st.title).toBe('Dark mode');
    expect(root.querySelector('.plans-capture-error')?.textContent).toBe('Could not add it: the board is offline');
  });
  it('the same title again: a plain message, no Undo (nothing was written)', async () => {
    const { root, calls } = setup({
      open: true,
      title: 'Dark mode',
      answer: { ok: true, id: 'PL-DARK-MODE-1', duplicate: 'PL-DARK-MODE-1', log: null, message: 'Already in the inbox as PL-DARK-MODE-1.' },
    });
    (root.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    expect(calls.undo).toHaveLength(0);
    expect(calls.message.at(-1)).toEqual(['Already in the inbox as PL-DARK-MODE-1.', false]);
  });
});

describe('the key and the limits', () => {
  it('n opens the form, never while typing or with a modifier', () => {
    expect(V.keyAction({ key: 'n' })).toEqual({ type: 'new' });
    expect(V.keyAction({ key: 'n' }, { inputField: true })).toBe(null);
    expect(V.keyAction({ key: 'n', ctrlKey: true })).toBe(null);
  });
  it('one set of limits for the form, the server and the CLI', () => {
    expect(V.CAPTURE).toEqual({ TITLE_MAX: I.TITLE_MAX, TEXT_SOFT: I.TEXT_SOFT, TEXT_MAX: I.TEXT_MAX });
  });
});

describe('the Roadmap', () => {
  function roadmap(entries: Post[], withButton = true) {
    const w: any = { QueuePlanView: V };
    new Function('window', roadmapJs)(w);
    const h: any = {
      el,
      state: () => ({ filter: V.emptyFilter(), search: '', surface: 'roadmap', entry: null }),
      use: () => {},
      width: () => 1440,
      prefs: () => ({ layout: null, group: 'horizon', compact: false }),
      setPref: () => {},
      isExpanded: () => false,
      toggleExpanded: () => {},
      activeFilters: () => el('div', null),
      search: () => {},
      newPlanButton: withButton ? () => el('button', { class: 'plans-capture-open', text: '+ New plan' }) : undefined,
      captureForm: () => el('form', { id: 'plans-capture' }),
    };
    const d = { exists: entries.length > 0, modules: [], projects: {}, entries, view: {} };
    return w.QueuePlanRoadmap.cells(h, d, entries);
  }
  it('the button is in the toolbar and the form right under it', () => {
    const node = roadmap([{ id: 'PL-A', title: 'A', priority: 'later', maturity: 'idea', ownerQuestions: [], queue: [] }]);
    expect(node.querySelector('.roadmap-toolbar .plans-capture-open')).toBeTruthy();
    expect(node.querySelector('.roadmap-toolbar + #plans-capture, .roadmap-toolbar ~ #plans-capture')).toBeTruthy();
  });
  it('an empty register invites the first plan', () => {
    const node = roadmap([]);
    expect(node.querySelector('.empty p')?.textContent).toBe('No plans yet. Add the first one: a title and a few sentences are enough.');
    expect(node.querySelector('.empty .plans-capture-open')).toBeTruthy();
    // without quick capture the old pointer to Claude stays
    expect(roadmap([], false).querySelector('.empty p')?.textContent).toMatch(/\/plans/);
  });
});

describe('the wiring', () => {
  const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  it('capture.js loads before plans.js and is served; plans.js and work.js wire it in', () => {
    expect(html.indexOf('/plans/capture.js')).toBeGreaterThan(0);
    expect(html.indexOf('/plans/plans.js')).toBeGreaterThan(html.indexOf('/plans/capture.js'));
    expect(server).toMatch(/'\/plans\/capture\.js': \[path\.join\('plans', 'capture\.js'\)/);
    expect(plansJs).toMatch(/window\.QueuePlanCapture/);
    expect(plansJs).toMatch(/featureOn\('plans\.inbox'\)/);
    expect(workJs).toMatch(/t\.type === 'new'/);
  });
  it('the server: the route, the module switch, the text in a file, and the write via queue.mjs plan capture', () => {
    expect(server).toMatch(/filePath === '\/api\/plan-capture'\) return planCapture\(b\)/);
    const fn = server.slice(server.indexOf('async function planCapture'), server.indexOf('// ---- Multi select'));
    expect(fn).toMatch(/FEATURES\['plans\.inbox'\]/);
    expect(fn).toMatch(/INBOX\.captureInput\(b\)/);
    expect(fn).toMatch(/'plan', 'capture', '--file', tmp/);
    expect(fn).toMatch(/fs\.rmSync\(tmp/);
    expect(fn).not.toMatch(/renameSync|PLAN_FILE/);
  });
  it('no innerHTML in capture.js; tokens only in its CSS', () => {
    expect(code(captureJs)).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|eval\(/);
    const start = css.indexOf('/* ---- Quick capture');
    expect(start).toBeGreaterThan(0);
    expect(css.slice(start)).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });
});
