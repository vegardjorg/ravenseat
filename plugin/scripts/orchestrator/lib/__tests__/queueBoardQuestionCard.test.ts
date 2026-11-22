/**
 * @vitest-environment jsdom
 */
// =============================================================
// queueBoardQuestionCard.test.ts: the card fields on the Decisions room (section 6.1 and 6.2 of
// plans/autonomi-nivaa-utredning.md), drawn by board/question.js.
//
// What the tests prove, with the whole board in jsdom on a small synthetic queue:
//   - a new-format question shows its category title next to the type, then the question, the recommendation, "If you
//     follow the recommendation" and "If you choose something else", then why it is asked, then the answers,
//   - an old post looks as before: no category badge, no consequence list,
//   - an approval (a machine card) gets its two lines from code,
//   - a track question written as free text is marked "Not filled in by the agent",
//   - the new styles use tokens only, and the warn pair holds 4.5:1 in light and dark.
// =============================================================
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { clientSource } from './boardClient';

/* eslint-disable @typescript-eslint/no-require-imports */
const T = require('../queueBoard.js') as { board: (queue: unknown, option?: unknown) => any; PALETTE: any };
const KK = require('../queueConfig.js') as any;
const U = require('../../queue-board/a11y.js') as { contrast: (a: string, b: string) => number };
/* eslint-enable @typescript-eslint/no-require-imports */

const CLIENT = join(__dirname, '..', '..', 'queue-board');
const css = readFileSync(join(CLIENT, 'board.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const iso = new Date(Date.now() - 86_400_000).toISOString();

const IF_YES = 'One new package (about 20 kB), and the bug is fixed in this round.';
const IF_NO = 'About 40 lines of our own code, and one more round.';
const WHY = 'The report shows the wrong day at midnight for users outside UTC.';

const task = (id: string, status: string, own: object = {}) => ({
  id,
  title: `Task ${id}`,
  domain: 'ui',
  class: 'K',
  value: 5,
  content_min: 45,
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

function makeQueue() {
  return {
    created: iso,
    limits: { maxConcurrent: 5, maxDPlus: 2, maxPerDomain: 5, maxDb: 2 },
    tasks: [
      task('EX-1', 'waiting', { waiting_on: ['Q-DATE'] }),
      task('EX-2', 'waiting', { waiting_on: ['OLD'] }),
      task('EX-3', 'proposed', { added_by: 'EX-9' }),
      task('EX-4', 'review', {
        blocks: [{ code: 'track-question', from: iso, note: 'Should the export include archived rows?', unfilled: 1, registered: [] }],
      }),
    ],
    projects: { ex: { title: 'Example', prefixes: ['EX-'] } },
    areas: {},
    question: {
      'Q-DATE': {
        type: 'question',
        text: 'Use date-fns for time zones in the report?',
        category: 'dependency',
        context: WHY,
        if_yes: IF_YES,
        if_no: IF_NO,
        recommendation: 'Use date-fns',
        choices: ['Use date-fns', 'Write it ourselves'],
        added_at: iso,
      },
      OLD: { type: 'question', text: 'An old question without the new fields?', recommendation: 'Yes', added_at: iso },
    },
    resolutions: {},
    changelog: [],
  };
}

const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};
const card = (key: string) => document.querySelector(`.decide-card[data-key="${key}"]`) as HTMLElement;
const before = (a: Element | null, b: Element | null) =>
  !!a && !!b && (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
function ruleFor(selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = css.match(new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm'));
  const out: Record<string, string> = {};
  if (!m) return out;
  for (const d of m[1].matchAll(/([a-z-]+)\s*:\s*([^;]+);/g)) out[d[1]] = d[2].trim();
  return out;
}

beforeAll(async () => {
  const state = {
    version: 'v1',
    data: {
      ...T.board(makeQueue()),
      gitError: null,
      logo: false,
      features: KK.features(KK.STANDARD),
      boardSwitches: KK.boardSwitches(KK.STANDARD, null),
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
  (document.getElementById('inbox') as HTMLButtonElement).click();
  await flush();
}, 60_000);

describe('a new-format question card', () => {
  it('shows the category title next to the type', () => {
    const c = card('decide:Q-DATE');
    const badge = c.querySelector('.decide-card-head .sp-category');
    expect(badge?.textContent).toBe('New libraries');
  });

  it('reads: the question, the recommendation, both consequence lines with their labels, why, then the answers', () => {
    const c = card('decide:Q-DATE');
    const rec = c.querySelector('.sp-recommendation');
    const list = c.querySelector('dl.sp-if');
    const why = c.querySelector('.sp-why');
    const answers = c.querySelector('.decide-options');
    expect([...(list?.querySelectorAll('dt') ?? [])].map((x) => x.textContent)).toEqual([
      'If you follow the recommendation',
      'If you choose something else',
    ]);
    expect([...(list?.querySelectorAll('dd') ?? [])].map((x) => x.textContent)).toEqual([IF_YES, IF_NO]);
    expect(why?.textContent).toBe(WHY);
    expect(before(c.querySelector('.sp-ask'), rec)).toBe(true);
    expect(before(rec, list)).toBe(true);
    expect(before(list, why)).toBe(true);
    expect(before(why, answers)).toBe(true);
  });

  it('an old post looks as before: no category badge and no consequence list', () => {
    const c = card('decide:OLD');
    expect(c.querySelector('.sp-category')).toBeNull();
    expect(c.querySelector('.sp-if')).toBeNull();
    expect(c.querySelector('.sp-recommendation-text')?.textContent).toBe('Yes');
  });
});

describe('machine cards and free text', () => {
  it('an approval gets its two lines from code', () => {
    const c = card('approve:EX-3');
    const dd = [...c.querySelectorAll('dl.sp-if dd')].map((x) => x.textContent);
    expect(dd).toEqual(['About 45 min of agent work.', 'Nothing changes, and it stays declined.']);
  });

  it('a track question written as free text is marked "Not filled in by the agent"', () => {
    const c = card('unstick:EX-4');
    expect(c.querySelector('.decide-card-head .sp-not-filled')?.textContent).toBe('Not filled in by the agent');
    expect(c.textContent).toContain('Should the export include archived rows?');
  });
});

describe('the colors: tokens only', () => {
  it('the new rules use tokens, never a raw color', () => {
    for (const sel of ['.badge.sp-category', '.badge.sp-not-filled', '.sp-if', '.sp-if-label', '.sp-if-text']) {
      const r = ruleFor(sel);
      expect(Object.keys(r).length, sel).toBeGreaterThan(0);
      for (const v of Object.values(r)) expect(v).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|hsl\(/i);
    }
    expect(ruleFor('.badge.sp-not-filled').background).toBe('var(--color-tone-warn)');
    expect(ruleFor('.badge.sp-not-filled').color).toBe('var(--color-on-tone-warn)');
  });

  it.each(['light', 'dark'])('the text pairs hold 4.5:1 in %s mode', (mode) => {
    const p = T.PALETTE[mode];
    expect(U.contrast(p['on-tone-warn'], p['tone-warn'])).toBeGreaterThanOrEqual(4.5);
    expect(U.contrast(p['on-surface-variant'], p['surface-container-lowest'])).toBeGreaterThanOrEqual(4.5);
  });
});
