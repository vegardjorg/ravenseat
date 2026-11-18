/**
 * @vitest-environment jsdom
 */
// =============================================================
// queueBoardOwnerQuestion.test.ts: an owner question reads like a question in a chat (board step B15).
//
// What the tests prove, in "Waiting on you" (board/inbox.js) and on the Decisions card (board/decide.js):
//   - the order is fixed: the question, the recommendation as its own block, the context (what waits, why, the source),
//     then the answers,
//   - the recommendation sits on the tone-info surface with a "Recommendation" label, at least the size of the question,
//     and is not a muted meta line,
//   - the one-click answer is "As recommended" (not "Use the recommendation (recommended)"), and a choice equal to the
//     recommendation reads "As recommended: <choice>" without a "(recommended)" suffix; the aria-label says what is
//     answered ("Answer Q-SSO as recommended: ..."),
//   - "Other decision" opens the free text field,
//   - the optional `context` field on a question (setQuestion, `ravenseat question <id> --context`) reaches the card,
//     and a question without it works as before,
//   - the colors are token pairs with at least 4.5:1 in light and dark.
// The whole board runs in jsdom with a small synthetic queue (no real data); board.css is read as text.
// =============================================================
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { clientSource } from './boardClient';

/* eslint-disable @typescript-eslint/no-require-imports */
const T = require('../queueBoard.js') as { board: (queue: unknown, option?: unknown) => any; PALETTE: any };
const KK = require('../queueConfig.js') as any;
const L = require('../queueLogic.js') as any;
const D = require('../queueDecisions.js') as any;
const U = require('../../queue-board/a11y.js') as { contrast: (a: string, b: string) => number };
/* eslint-enable @typescript-eslint/no-require-imports */

const CLIENT = join(__dirname, '..', '..', 'queue-board');
const css = readFileSync(join(CLIENT, 'board.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const iso = new Date(Date.now() - 86_400_000).toISOString();

const SSO_REC = 'Yes for Apple, Google later.';
const SSO_WHY = 'Apple requires its own sign-in on iOS when other social sign-in exists.';

const task = (id: string, waiting: string) => ({
  id,
  title: `Task ${id}`,
  domain: 'ui',
  class: 'K',
  value: 5,
  content_min: 90,
  status: 'waiting',
  depends_on: [],
  waiting_on: [waiting],
  owned_files: [`file/${id}.ts`],
  owner_db: [],
  shared_patch: [],
  mission: `scripts/.queue/mission/${id}.md`,
  added_by: 'test',
  added_at: iso,
});

function makeQueue() {
  return {
    created: iso,
    limits: { maxConcurrent: 5, maxDPlus: 2, maxPerDomain: 5, maxDb: 2 },
    tasks: [task('EX-1', 'Q-SSO'), task('EX-2', 'PICK'), task('EX-3', 'FREE')],
    projects: { ex: { title: 'Example', prefixes: ['EX-'] } },
    areas: {},
    question: {
      'Q-SSO': {
        type: 'question',
        text: 'Do we offer sign-in with Apple and Google from day one?',
        recommendation: SSO_REC,
        context: SSO_WHY,
        source: 'docs/roadmap.md',
        added_at: iso,
      },
      PICK: {
        type: 'question',
        text: 'Which vendor?',
        choices: ['Vendor A', 'Vendor B'],
        recommendation: 'Vendor B',
        added_at: iso,
      },
      FREE: { type: 'owner-task', text: 'Write the launch note.', added_at: iso },
    },
    resolutions: {},
    changelog: [],
  };
}

const posts: { path: string; body: any }[] = [];
const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};
const panel = () => document.getElementById('panel') as HTMLElement;
const row = (sp: string) =>
  [...panel().querySelectorAll('.inbox-row')].find((r) => r.querySelector('.sp-id')?.textContent === sp) as HTMLElement;
const card = (sp: string) => document.querySelector(`.decide-card[data-key="decide:${sp}"]`) as HTMLElement;
/** a comes before b in the document. */
const before = (a: Element | null, b: Element | null) =>
  !!a && !!b && (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
/** The visible text of a button without the key hint (the "1" in the Decisions view). */
const label = (b: Element) =>
  [...b.childNodes]
    .filter((n) => !(n instanceof HTMLElement && n.classList.contains('decide-key')))
    .map((n) => n.textContent)
    .join('')
    .trim();

/** The declarations of the first rule whose selector is exactly `selector`. */
function ruleFor(selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = css.match(new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm'));
  const out: Record<string, string> = {};
  if (!m) return out;
  for (const d of m[1].matchAll(/([a-z-]+)\s*:\s*([^;]+);/g)) out[d[1]] = d[2].trim();
  return out;
}
/** The px value of a --text-* token. */
const textPx = (v: string) => {
  const name = v.match(/var\((--text-[a-z]+)\)/)?.[1];
  const m = name ? css.match(new RegExp(`${name}:\\s*(\\d+)px;`)) : null;
  return m ? Number(m[1]) : NaN;
};

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
  w.fetch = async (filePath: string, init?: { method?: string; body?: string }) => {
    if (init?.method === 'POST') posts.push({ path: filePath, body: JSON.parse(init.body ?? '{}') });
    return {
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
    };
  };
  for (const f of ['a11y.js', '../lib/queueGraph.js', 'graph.js', 'plan.js', 'performance.js', '../lib/queueDecisions.js', 'board/'])
    (0, eval)(clientSource(f));
  await flush();
  (document.getElementById('inbox') as HTMLButtonElement).click();
  await flush();
}, 60_000);

describe('"Waiting on you": a question reads like a question in a chat', () => {
  it('the order is the question, the recommendation, the context, then the answers', () => {
    const r = row('Q-SSO');
    const question = r.querySelector('.sp-ask');
    const rec = r.querySelector('.sp-recommendation');
    const context = r.querySelector('.sp-context');
    const answers = r.querySelector('.answer-buttons');
    expect(question?.textContent).toBe('Do we offer sign-in with Apple and Google from day one?');
    expect(before(question, rec)).toBe(true);
    expect(before(rec, context)).toBe(true);
    expect(before(context, answers)).toBe(true);
    // Every button of the row is in the answers, after the recommendation.
    for (const b of r.querySelectorAll('button:not(.link-button)')) expect(before(rec, b)).toBe(true);
  });

  it('the recommendation is its own block with a label, not a muted meta line', () => {
    const r = row('Q-SSO');
    const rec = r.querySelector('.sp-recommendation') as HTMLElement;
    expect(rec.classList.contains('sp-meta')).toBe(false);
    expect(rec.querySelector('.sp-recommendation-label')?.textContent).toBe('Recommendation');
    expect(rec.querySelector('.sp-recommendation-text')?.textContent).toBe(SSO_REC);
    expect([...r.querySelectorAll('.sp-meta')].some((m) => /Recommendation/.test(m.textContent ?? ''))).toBe(false);
  });

  it('the context: why it is asked, and one muted line with what waits and the source', () => {
    const r = row('Q-SSO');
    expect(r.querySelector('.sp-why')?.textContent).toBe(SSO_WHY);
    const meta = r.querySelector('.sp-context .sp-meta') as HTMLElement;
    expect(meta.textContent).toContain('unlocks 1 task');
    expect(meta.textContent).toContain('Waiting:');
    expect(meta.textContent).toContain('EX-1');
    expect(meta.textContent).toContain('Source: docs/roadmap.md');
    // "unlocks" left the header (it is context now, not a headline).
    expect(r.querySelector('.row-header .sp-locks')).toBeNull();
  });

  it('"As recommended" is the filled button, its aria-label says what is answered, and one click answers', async () => {
    const r = row('Q-SSO');
    const filled = [...r.querySelectorAll('.answer-buttons .button-filled')] as HTMLButtonElement[];
    expect(filled.map((b) => b.textContent)).toEqual(['As recommended']);
    expect(filled[0].getAttribute('aria-label')).toBe(`Answer Q-SSO as recommended: ${SSO_REC}`);
    expect(r.textContent).not.toContain('(recommended)');
    expect(r.textContent).not.toContain('Use the recommendation');
    filled[0].click();
    await flush();
    expect(posts.filter((p) => p.path === '/api/action').at(-1)?.body).toEqual({
      type: 'resolve',
      sp: 'Q-SSO',
      answer: SSO_REC,
    });
  });

  it('a choice equal to the recommendation says "As recommended", without a "(recommended)" suffix', () => {
    const r = row('PICK');
    const buttons = [...r.querySelectorAll('.answer-choices button')] as HTMLButtonElement[];
    expect(buttons.map((b) => b.textContent)).toEqual(['Vendor A', 'As recommended: Vendor B']);
    expect(buttons[1].className).toContain('button-filled');
    expect(buttons[1].getAttribute('aria-label')).toBe('Answer PICK as recommended: Vendor B');
    expect(buttons[0].getAttribute('aria-label')).toBe('Answer PICK: Vendor A');
    // The recommended choice is the one-click answer, so there is no second "As recommended" button.
    expect(r.querySelectorAll('.button-filled')).toHaveLength(1);
    expect(r.textContent).not.toContain('(recommended)');
  });

  it('"Other decision" opens the text field; a question without a recommendation keeps its plain answer button', async () => {
    const other = [...row('PICK').querySelectorAll('.answer-buttons button')].find(
      (b) => b.textContent === 'Other decision',
    ) as HTMLButtonElement;
    expect(other).toBeTruthy();
    expect(other.className).not.toContain('button-filled');
    other.click();
    await flush();
    expect(row('PICK').querySelector('textarea')).not.toBeNull();
    // The recommendation stays on top while the field is open.
    expect(before(row('PICK').querySelector('.sp-recommendation'), row('PICK').querySelector('textarea'))).toBe(true);
    const free = row('FREE');
    expect(free.querySelector('.sp-recommendation')).toBeNull();
    expect([...free.querySelectorAll('.answer-buttons button')].map((b) => b.textContent)).toEqual(['Answer']);
  });
});

describe('the Decisions card follows the same order and words', () => {
  it('question, recommendation block, then the buttons; "As recommended" with the same aria-label', () => {
    const c = card('Q-SSO');
    const title = c.querySelector('.decide-title');
    const rec = c.querySelector('.sp-recommendation');
    const options = c.querySelector('.decide-options');
    expect(before(title, rec)).toBe(true);
    expect(before(rec, options)).toBe(true);
    expect(rec?.querySelector('.sp-recommendation-text')?.textContent).toBe(SSO_REC);
    expect(c.querySelector('.sp-why')?.textContent).toBe(SSO_WHY);
    expect([...c.querySelectorAll('.decide-context')].some((p) => /Recommendation/.test(p.textContent ?? ''))).toBe(false);
    const filled = c.querySelector('.decide-options .button-filled') as HTMLButtonElement;
    expect(label(filled)).toBe('As recommended');
    expect(filled.getAttribute('aria-label')).toBe(`Answer Q-SSO as recommended: ${SSO_REC}`);
    expect(c.textContent).not.toContain('(recommended)');
    const pick = card('PICK').querySelector('.decide-options .button-filled') as HTMLButtonElement;
    expect(label(pick)).toBe('As recommended: Vendor B');
    expect(pick.getAttribute('aria-label')).toBe('Answer PICK as recommended: Vendor B');
  });
});

describe('the colors: tokens only, readable in light and dark', () => {
  it('the recommendation sits on the tone-info pair with the control radius, at least the size of the question', () => {
    const box = ruleFor('.sp-recommendation');
    expect(box.background).toBe('var(--color-tone-info)');
    expect(box.color).toBe('var(--color-on-tone-info)');
    expect(box['border-radius']).toBe('var(--radius-md)');
    const q = textPx(ruleFor('.sp-ask')['font-size']);
    const r = textPx(ruleFor('.sp-recommendation-text')['font-size']);
    expect(q).toBeGreaterThanOrEqual(16);
    expect(r).toBeGreaterThanOrEqual(q);
    for (const sel of ['.sp-recommendation', '.sp-recommendation-label', '.sp-recommendation-text', '.sp-ask', '.sp-why'])
      for (const v of Object.values(ruleFor(sel))) expect(v).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });

  it.each(['light', 'dark'])('every text on the question card holds 4.5:1 in %s mode', (mode) => {
    const p = T.PALETTE[mode];
    expect(U.contrast(p['on-tone-info'], p['tone-info'])).toBeGreaterThanOrEqual(4.5);
    expect(U.contrast(p['on-surface'], p['surface-container-lowest'])).toBeGreaterThanOrEqual(4.5);
    expect(U.contrast(p['on-surface-variant'], p['surface-container-lowest'])).toBeGreaterThanOrEqual(4.5);
    expect(U.contrast(p['on-primary'], p.primary)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('the optional context field on a question', () => {
  it('setQuestion keeps it, null removes it, and a question without it is unchanged', () => {
    const queue: any = { question: {} };
    expect(L.setQuestion(queue, { 'Q-NEW': { text: 'Which?', context: '  Because X.  ' } }).error).toEqual([]);
    expect(queue.question['Q-NEW'].context).toBe('Because X.');
    L.setQuestion(queue, { 'Q-NEW': { recommendation: 'This one' } });
    expect(queue.question['Q-NEW'].context).toBe('Because X.');
    L.setQuestion(queue, { 'Q-NEW': { context: null } });
    expect('context' in queue.question['Q-NEW']).toBe(false);
    expect(L.setQuestion(queue, { 'Q-OLD': { text: 'Plain?' } }).error).toEqual([]);
    expect(Object.keys(queue.question['Q-OLD']).sort()).toEqual(['added_at', 'text', 'type']);
    expect(L.setQuestion(queue, { 'Q-NEW': { contxt: 'typo' } }).error[0]).toContain('unknown field contxt');
  });

  it('the decision item carries it as `background`, and the one-click answer is labelled "As recommended"', () => {
    const items = D.fromInbox(T.board(makeQueue()).inbox);
    const sso = items.find((x: any) => x.key === 'decide:Q-SSO');
    expect(sso.background).toBe(SSO_WHY);
    expect(sso.options[0].label).toBe('As recommended');
    expect(sso.context.some((c: string) => c.startsWith('Recommendation'))).toBe(false);
    expect(items.find((x: any) => x.key === 'decide:FREE').background).toBeNull();
  });
});
