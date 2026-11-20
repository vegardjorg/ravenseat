/**
 * @vitest-environment jsdom
 */
// =============================================================
// queueBoardMascotFigure.test.ts: speech bubbles only with the mascot figure (track hdr, owner 21.11).
//
// The Ravenseat logo is the default figure in the top's corner and it never talks: no bubble on events, none on a
// click, and the zone is a plain picture (no button role, no label, no tab stop). The mascot (the switch "Show the
// mascot instead of the logo" in the gear) still talks as before, and board.mascot (chatty, events, off) decides how
// much. mascot.js reads the figure from the zone's data-talker, which board/start.js sets in drawLogo().
// The test runs lib/queueMascot.js and mascot.js in jsdom with a minimal top, as the board loads them.
// =============================================================
import { describe, it, expect, beforeEach } from 'vitest';
import { clientSource } from './boardClient';

const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};

/** A state with one open owner question more each time (`questions` of them), which gives the event new-question. */
const state = (questions: number) => ({
  mascot: { mode: 'chatty', file: false },
  columns: { queue: [], batch: [], inProgress: [], review: [], built: [] },
  inbox: { question: Array.from({ length: questions }, (_, i) => ({ sp: `Q-${i}` })) },
});

type View = {
  newState: (d: unknown) => Promise<void>;
  figureChanged: () => void;
  mode: () => string;
};

function load(talker: 'raven' | 'mascot'): { view: View; bubble: HTMLElement; zone: HTMLElement } {
  document.body.innerHTML =
    '<header class="top"><div id="mascot" class="mascot"></div><p id="bubble" class="bubble" role="note" hidden></p></header>';
  const zone = document.getElementById('mascot')!;
  zone.dataset.talker = talker;
  const w = window as any;
  w.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} }); // reduced motion: no fade
  w.setInterval = () => 0;
  w.fetch = async () => ({ ok: true, json: async () => ({ phrases: null }) });
  localStorage.clear();
  delete w.QueueMascotView;
  (0, eval)(clientSource('../lib/queueMascot.js'));
  (0, eval)(clientSource('mascot.js'));
  return { view: w.QueueMascotView as View, bubble: document.getElementById('bubble')!, zone };
}

describe('the logo (the default figure) never talks', () => {
  let t: ReturnType<typeof load>;
  beforeEach(() => {
    t = load('raven');
  });

  it('no bubble on an event, even in Chatty', async () => {
    await t.view.newState(state(0));
    await t.view.newState(state(1)); // a new owner question: the event new-question
    await flush();
    expect(t.view.mode()).toBe('chatty'); // the choice itself is kept for when the mascot is turned on
    expect(t.bubble.hidden).toBe(true);
  });

  it('no bubble on a click or a key, and the zone is a plain picture (no button role, label or tab stop)', async () => {
    await t.view.newState(state(0));
    t.zone.click();
    t.zone.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(t.bubble.hidden).toBe(true);
    expect(t.zone.getAttribute('role')).toBeNull();
    expect(t.zone.getAttribute('aria-label')).toBeNull();
    expect(t.zone.hasAttribute('tabindex')).toBe(false);
    expect(t.zone.classList.contains('clickable')).toBe(false);
  });
});

describe('the mascot figure still talks', () => {
  let t: ReturnType<typeof load>;
  beforeEach(() => {
    t = load('mascot');
  });

  it('a bubble on an event', async () => {
    await t.view.newState(state(0));
    await t.view.newState(state(1));
    await flush();
    expect(t.bubble.hidden).toBe(false);
    expect(t.bubble.textContent).not.toBe('');
  });

  it('a click gives a line, and the zone is a button with a label', async () => {
    await t.view.newState(state(0));
    expect(t.zone.getAttribute('role')).toBe('button');
    expect(t.zone.getAttribute('aria-label')).toBe('The mascot: say something');
    t.zone.click();
    expect(t.bubble.hidden).toBe(false);
  });

  it('switching to the logo closes the bubble at once and makes the zone a plain picture again', async () => {
    await t.view.newState(state(0));
    t.zone.click();
    expect(t.bubble.hidden).toBe(false);
    t.zone.dataset.talker = 'raven';
    t.view.figureChanged();
    expect(t.bubble.hidden).toBe(true);
    expect(t.zone.getAttribute('role')).toBeNull();
    t.zone.click();
    expect(t.bubble.hidden).toBe(true);
    // And back: the mascot is a button again.
    t.zone.dataset.talker = 'mascot';
    t.view.figureChanged();
    expect(t.zone.getAttribute('role')).toBe('button');
  });
});
