/**
 * @vitest-environment jsdom
 */
// =============================================================
// queueBoardCards.test.ts: the card anatomy and the badges (board step B4).
//
// What the tests prove:
//   - the screen reader text on the card (the metadata and the footer that aria-describedby points to, including the
//     hidden text) is word for word what it was before the visual change,
//   - the class is plain text on the card (only D+ keeps a badge, with the heavy tone), the estimate is plain text,
//   - "visual" is an eye icon with hidden text, not a purple badge, and "unlocks N" carries an arrow icon,
//   - the project color is a dot in front of the project name, and the color stripe is only on cards in the Blocked
//     column (the ones that need action),
//   - every badge rule in board.css takes its surface and text from the tone tokens (tone-* / on-tone-*).
// The whole board runs in jsdom with a small synthetic queue (no real data); board.css is read as text.
// =============================================================
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { clientSource } from './boardClient';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const T = require('../queueBoard.js') as { board: (queue: unknown, option?: unknown) => any };

const CLIENT = join(__dirname, '..', '..', 'queue-board');
const css = readFileSync(join(CLIENT, 'board.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

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
  mission: `scripts/.queue/mission/${id}.md`,
  added_by: 'test',
  added_at: ago(600),
  ...own,
});

/**
 * EX-1: ready, visual, unlocks EX-3. EX-2: ready D+. EX-3: waits on EX-1 (blocked in the queue).
 * EX-4: an open owner question, so it stands in the Blocked column.
 */
function makeQueue() {
  return {
    created: ago(1000),
    limits: { maxConcurrent: 5, maxDPlus: 2, maxPerDomain: 5, maxDb: 2 },
    tasks: [
      task('EX-1', { labels: ['visual'], value: 9 }),
      task('EX-2', { class: 'D+', value: 7 }),
      task('EX-3', { depends_on: ['EX-1'] }),
      task('EX-4', { blocks: [{ code: 'owner-question', from: ago(30) }] }),
    ],
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

beforeAll(async () => {
  const state = {
    version: 'v1',
    data: {
      ...T.board(makeQueue(), { blockedColumn: true }),
      boardSwitches: { blockedColumn: true },
      gitError: null,
      logo: false,
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
        : {},
  });
  for (const f of ['a11y.js', '../lib/queueGraph.js', 'graph.js', 'plan.js', 'performance.js', 'board/'])
    (0, eval)(clientSource(f));
  await flush();
  // Blocked sections start closed and are built when they open.
  for (const d of document.querySelectorAll('details')) {
    (d as HTMLDetailsElement).open = true;
    d.dispatchEvent(new Event('toggle'));
  }
  await flush();
}, 60_000);

const card = (id: string, col: string) =>
  document.querySelector(`.summary[data-id="${id}"][data-col="${col}"]`) as HTMLElement;

/** The text aria-describedby points to (the metadata and the footer), with the spaces folded. */
function described(li: HTMLElement): string {
  const button = li.querySelector('.summary-button') as HTMLElement;
  return (button.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .map((id) => (document.getElementById(id)?.textContent ?? '').trim())
    .join(' | ');
}

describe('the screen reader text on the card is unchanged', () => {
  it('metadata and footer read the same words as before B4', () => {
    expect(card('EX-1', 'queue')).not.toBeNull();
    expect(card('EX-4', 'blocked')).not.toBeNull();
    // Recorded from the board before the visual change; a change here changes what a screen reader says.
    expect(described(card('EX-1', 'queue'))).toBe(
      'EX-1exK30 minvisualunlocks 1Unlocks 1 task (30 min estimated) via the chain | Ready now',
    );
    // D+ carries the class factor in its estimate (30 min of content is 54 min of agent work).
    expect(described(card('EX-2', 'queue'))).toBe('EX-2exD+54 min | Ready now');
    expect(described(card('EX-3', 'queue'))).toBe('EX-3exK30 min | waiting on EX-1 (waiting)');
    expect(described(card('EX-4', 'blocked'))).toBe(
      'EX-4exK30 minBlocked by owner-question for 30 min. ravenseat unblock EX-4 closes it. | owner-question · 30 minin queue',
    );
  });

  it('the class keeps its spoken label, and the title is still the button', () => {
    const li = card('EX-2', 'queue');
    const cls = li.querySelector('[aria-label^="class"], [aria-label*="D+"]') as HTMLElement;
    expect(cls).not.toBeNull();
    expect(li.querySelector('button.summary-button')?.textContent).toBe('Task EX-2');
  });
});

describe('B4: the card anatomy', () => {
  it('the class is plain text, only D+ is a badge (the heavy tone)', () => {
    const k = card('EX-1', 'queue').querySelector('.summary-class') as HTMLElement;
    expect(k).not.toBeNull();
    expect(k.textContent).toBe('K');
    expect(k.classList.contains('badge')).toBe(false);
    const dplus = card('EX-2', 'queue').querySelector('.summary-class') as HTMLElement;
    expect(dplus.classList.contains('badge')).toBe(true);
    expect(dplus.classList.contains('class-dplus')).toBe(true);
  });

  it('the estimate is plain text, not a badge', () => {
    const e = card('EX-1', 'queue').querySelector('.summary-estimate') as HTMLElement;
    expect(e).not.toBeNull();
    expect(e.textContent).toBe('30 min');
    expect(e.classList.contains('badge')).toBe(false);
  });

  it('"visual" is an eye icon with hidden text, not a badge', () => {
    const li = card('EX-1', 'queue');
    expect(li.querySelector('.badge.visual')).toBeNull();
    const v = li.querySelector('.summary-visual') as HTMLElement;
    expect(v).not.toBeNull();
    expect(v.querySelector('svg.icon.eye[aria-hidden="true"]')).not.toBeNull();
    expect(v.querySelector('.hidden-for-eye')?.textContent).toBe('visual');
    expect(v.getAttribute('title')).toMatch(/visual check/);
  });

  it('"unlocks N" carries an arrow icon that the screen reader skips', () => {
    const b = card('EX-1', 'queue').querySelector('.badge.locks') as HTMLElement;
    expect(b.querySelector('svg.icon.unlocks[aria-hidden="true"]')).not.toBeNull();
    expect(b.textContent).toBe('unlocks 1');
  });

  it('the project color is a dot before the project name, the stripe only on cards in Blocked', () => {
    expect(css).toMatch(/\.summary-project::before\s*\{[^}]*background:\s*var\(--p/);
    // No stripe on the plain card: the ::before on .summary exists only for .summary.stuck.
    const stripes = [...css.matchAll(/([^{}]+)\{[^}]*\}/g)].map((m) => m[1].trim()).filter((s) => /\.summary::before/.test(s));
    expect(stripes).toEqual([]);
    expect(css).toMatch(/\.summary\.stuck::before\s*\{[^}]*content:/);
    // The ready card has no primary frame any more; the badge says it.
    expect(css).not.toMatch(/(^|\n)\.summary\.ready\s*\{[^}]*border-color:\s*var\(--color-primary\)/);
  });
});

describe('B4: badges use the tone tokens', () => {
  /** Every top-level rule whose selector is about a badge, with its background and color. */
  function badgeRules() {
    const out: { sel: string; body: string }[] = [];
    for (const m of css.matchAll(/(^|\n)([^@{}\n][^{}]*)\{([^}]*)\}/g)) {
      const sel = m[2].trim();
      if (/\.badge\b/.test(sel) && !/\.summary\.marked/.test(sel)) out.push({ sel, body: m[3] });
    }
    return out;
  }

  it('every badge surface is a tone-* token and every badge text an on-tone-* token', () => {
    const rules = badgeRules();
    expect(rules.length).toBeGreaterThan(5);
    for (const { sel, body } of rules) {
      const bg = body.match(/(?:^|;|\s)background:\s*([^;]+);/);
      const color = body.match(/(?:^|;|\s)color:\s*([^;]+);/);
      if (bg) expect(`${sel}: ${bg[1].trim()}`).toMatch(/: var\(--color-tone-[a-z]+\)$/);
      if (color) expect(`${sel}: ${color[1].trim()}`).toMatch(/: var\(--color-on-tone-[a-z]+\)$/);
    }
  });

  it('the base badge is neutral and has no visible frame', () => {
    const base = badgeRules().find((r) => r.sel === '.badge')!;
    expect(base.body).toMatch(/background:\s*var\(--color-tone-neutral\)/);
    expect(base.body).toMatch(/border:\s*1px solid transparent/);
  });

  it('purple means only D+: no badge uses the tertiary or module-purple colors', () => {
    for (const { sel, body } of badgeRules()) expect(`${sel}{${body}}`).not.toMatch(/tertiary|module-purple/);
  });
});
