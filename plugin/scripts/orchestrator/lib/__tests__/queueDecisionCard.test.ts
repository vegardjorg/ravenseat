// =============================================================
// queueDecisionCard.test.ts: the decision card with the card fields (section 6.1 of plans/autonomi-nivaa-utredning.md).
//
// The board, `ravenseat decide` and /ravenseat:decide read one item (lib/queueDecisions.js). A question carries its
// category (with the title), context, and what happens if the owner follows the recommendation or chooses something
// else. An approval is a machine card: its two lines come from code. A track question written as free text, without a
// registration, is marked "Not filled in by the agent". The inbox from lib/queueBoard.js passes the fields on.
// =============================================================
import { describe, it, expect } from 'vitest';

/* eslint-disable @typescript-eslint/no-require-imports */
const DEC = require('../queueDecisions.js') as any;
const AC = require('../askCatalog.js') as { categories: () => { key: string; title: string }[] };
const T = require('../queueBoard.js') as { board: (queue: unknown, option?: unknown) => any };
/* eslint-enable @typescript-eslint/no-require-imports */

const card = {
  sp: 'Q-7',
  type: 'question',
  text: 'Use date-fns for time zones in the report?',
  category: 'dependency',
  context: 'The report shows the wrong day at midnight outside UTC.',
  if_yes: 'One new package, and the bug is fixed in this round.',
  if_no: 'About 40 lines of our own code, and one more round.',
  recommendation: 'Use date-fns',
  choices: [
    { label: 'Use date-fns', recommended: true },
    { label: 'Write it ourselves', recommended: false },
  ],
};

describe('questionItem: the card fields', () => {
  it('carries the category and its title, the context and both consequence lines', () => {
    const x = DEC.questionItem(card);
    expect(x).toMatchObject({
      category: 'dependency',
      categoryTitle: 'New libraries',
      background: card.context,
      ifYes: card.if_yes,
      ifNo: card.if_no,
    });
  });

  it('an old post shows as today: uncategorized, no title, no consequence lines', () => {
    const x = DEC.questionItem({ sp: 'OLD', type: 'question', text: 'Old?' });
    expect(x).toMatchObject({ category: 'uncategorized', categoryTitle: null, ifYes: null, ifNo: null });
  });

  it('uses the words of section 6.1 for the two lines', () => {
    expect(DEC.IF_YES_LABEL).toBe('If you follow the recommendation');
    expect(DEC.IF_NO_LABEL).toBe('If you choose something else');
  });

  it('keeps the category titles equal to ask-catalog/categories.json (this file also runs in the browser)', () => {
    expect(DEC.CATEGORY_TITLES).toEqual(Object.fromEntries(AC.categories().map((r) => [r.key, r.title])));
  });
});

describe('machine cards get their two lines from code', () => {
  it('an approval: yes is the agent work, no is nothing; category Follow-up tasks', () => {
    const x = DEC.fromInbox({ proposed: [{ id: 'P-1', title: 'Do it', class: 'K', estimate: 45, value: 5 }] })[0];
    expect(x).toMatchObject({
      category: 'followups',
      categoryTitle: 'Follow-up tasks',
      ifYes: 'About 45 min of agent work.',
      ifNo: 'Nothing changes, and it stays declined.',
    });
  });

  it('when the recommendation is Decline, the lines follow the recommendation', () => {
    const x = DEC.fromInbox({ proposed: [{ id: 'P-2', title: 'Fix it', class: 'K', estimate: 90, gate_without_place: true }] })[0];
    expect(x.recommendation).toBe('Decline');
    expect(x.ifYes).toBe('Nothing changes, and it stays declined.');
    expect(x.ifNo).toBe('About 1 h 30 min of agent work, on a guess.');
  });

  it('a QA check says what each answer does', () => {
    const x = DEC.fromInbox({ qa: [{ pid: 'p', features: [{ feature: 'f', tasks: [{ id: 'A-1', title: 'A' }] }] }] })[0];
    expect(x.ifYes).toMatch(/counts as done/);
    expect(x.ifNo).toMatch(/fix task/);
  });
});

describe('a track question that was not registered', () => {
  const stuck = (stop: object) => ({ id: 'T-1', title: 'T', status: 'review', stop: { code: 'track-question', note: 'Which vendor?', ...stop } });

  it('is marked "Not filled in by the agent" with what that means', () => {
    const x = DEC.fromInbox({ stuck: [stuck({ unfilled: 1, registered: [] })] })[0];
    expect(x.notFilled).toBe(true);
    expect(DEC.NOT_FILLED).toBe('Not filled in by the agent');
    expect(x.context.join(' ')).toMatch(/Not filled in by the agent/);
  });

  it('names the questions the track did register, and is not marked when every question is registered', () => {
    const x = DEC.fromInbox({ stuck: [stuck({ unfilled: 0, registered: ['Q-1', 'Q-2'] })] })[0];
    expect(x.notFilled).toBe(false);
    expect(x.context.join(' ')).toMatch(/Registered as questions: Q-1, Q-2/);
    // An old block without the fields reads as before.
    const old = DEC.fromInbox({ stuck: [stuck({})] })[0];
    expect(old.notFilled).toBe(false);
  });
});

describe('the board inbox passes the fields on', () => {
  const iso = new Date(Date.now() - 86_400_000).toISOString();
  const task = (id: string, status: string, own: object = {}) => ({
    id,
    title: id,
    domain: 'ui',
    class: 'K',
    value: 5,
    content_min: 60,
    status,
    depends_on: [],
    waiting_on: [],
    owned_files: [`f/${id}.ts`],
    mission: 'm',
    added_by: 'test',
    added_at: iso,
    ...own,
  });

  it('a question has category, if_yes and if_no; a stop has unfilled and registered', () => {
    const queue = {
      created: iso,
      limits: { maxConcurrent: 5 },
      tasks: [
        task('A-1', 'waiting', { waiting_on: ['Q-7'] }),
        task('T-1', 'review', { blocks: [{ code: 'track-question', from: iso, note: 'Which?', unfilled: 1, registered: ['Q-7'] }] }),
      ],
      question: {
        'Q-7': {
          type: 'question',
          text: card.text,
          category: 'dependency',
          context: card.context,
          if_yes: card.if_yes,
          if_no: card.if_no,
          recommendation: 'Use date-fns',
          choices: ['Use date-fns', 'Write it ourselves'],
          added_at: iso,
        },
      },
      resolved: [],
    };
    const inbox = T.board(queue).inbox;
    expect(inbox.question[0]).toMatchObject({ category: 'dependency', if_yes: card.if_yes, if_no: card.if_no });
    const stop = inbox.stuck.find((h: any) => h.id === 'T-1').stop;
    expect(stop).toMatchObject({ unfilled: 1, registered: ['Q-7'] });
  });
});
