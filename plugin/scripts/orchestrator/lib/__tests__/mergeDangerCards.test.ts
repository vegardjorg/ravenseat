// =============================================================
// mergeDangerCards.test.ts: door and blast radius where the owner meets a delivery (MS-1): the Decisions cards
// (lib/queueDecisions.js, fed by lib/queueBoard.js inbox), "Decided for you", `ravenseat decide` and the PR body.
//
// Locks: (1) a delivery card (QA check, a stopped review) carries the track's door and blast radius, "not stated" when
// the record has none, and nothing on a task from before MS-1; (2) a one-way door gets a badge in words and comes first
// within its group, never across groups; (3) a reviewer who disagrees is shown next to the track's call, and the card
// keeps the track's values (code picks no side); (4) "Decided for you" rows of merged work carry them; (5) the PR body
// lists them per task, with the reviewer's door when it differs; (6) nothing here blocks or approves: the options of a
// card are the same with a one-way door.
// =============================================================
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* eslint-disable @typescript-eslint/no-require-imports */
const D = require('../queueDecisions') as any;
const B = require('../queueBoard.js') as any;
const GO = require('../ghOutbound.js') as any;
const MD = require('../mergeDanger.js') as any;
/* eslint-enable @typescript-eslint/no-require-imports */

const qaTask = (id: string, md?: unknown) => ({ id, title: `Task ${id}`, ...(md === undefined ? {} : { merge_danger: md }) });
const inboxWith = (tasks: unknown[]) => ({
  question: [],
  qa: [{ pid: 'P', title: 'Project', features: [{ feature: 'login', tasks }] }],
  proposed: [],
  stuck: [],
});

describe('the Decisions card of a delivery', () => {
  it('carries the door and blast radius, not stated where missing, nothing before MS-1', () => {
    const items = Object.fromEntries(
      D.fromInbox(
        inboxWith([
          qaTask('T-1', { door: 'one-way', blast: 'data', at: 'x' }),
          qaTask('T-2', { door: null, blast: null, at: 'x' }),
          qaTask('T-3'),
        ]),
      ).map((x: any) => [x.id, x]),
    );
    expect(items['T-1'].danger).toMatchObject({ door: 'one-way', blast: 'data', oneWay: true, text: 'Door: one-way · Blast radius: data' });
    expect(items['T-2'].danger).toMatchObject({ oneWay: false, text: 'Door: not stated · Blast radius: not stated' });
    expect(items['T-3'].danger).toBeNull();
  });

  it('a one-way door has a badge in words', () => {
    const [item] = D.fromInbox(inboxWith([qaTask('T-1', { door: 'one-way', blast: 'data' })]));
    expect(item.danger.badge).toBe(D.ONE_WAY_BADGE);
    expect(D.ONE_WAY_BADGE).toMatch(/one-way door/i);
    const [two] = D.fromInbox(inboxWith([qaTask('T-2', { door: 'two-way', blast: 'small' })]));
    expect(two.danger.badge).toBeNull();
  });

  it('comes first within its group, and never jumps to another group', () => {
    const inbox = {
      ...inboxWith([qaTask('T-1', { door: 'two-way', blast: 'small' }), qaTask('T-2', { door: 'one-way', blast: 'data' })]),
      question: [{ sp: 'Q-1', type: 'question', text: 'Which?', choices: [], direct: [], count: 0, minutes: 0 }],
    };
    const groups = D.groupItems(D.fromInbox(inbox));
    expect(groups.map((g: any) => g.verb)).toEqual(['decide', 'check']);
    expect(groups[1].items.map((x: any) => x.id)).toEqual(['T-2', 'T-1']);
    expect(D.walkOrder(D.fromInbox(inbox)).map((x: any) => x.id)).toEqual(['Q-1', 'T-2', 'T-1']);
  });

  it('shows a reviewer who disagrees, and keeps the track values', () => {
    const [item] = D.fromInbox(
      inboxWith([qaTask('T-1', { door: 'two-way', blast: 'small', reviewers: [{ type: 'reviewer', door: 'one-way', blast: 'small' }] })]),
    );
    expect(item.danger.door).toBe('two-way');
    expect(item.danger.oneWay).toBe(false);
    expect(item.danger.disagree).toEqual(['Reviewer says door one-way (the track says two-way)']);
  });

  it('reads as one sentence: the reviewer type leads, one without a type reads "A reviewer", the board adds no prefix', () => {
    const [item] = D.fromInbox(
      inboxWith([qaTask('T-1', { door: 'two-way', blast: 'small', reviewers: [{ type: 'security-reviewer', blast: 'data' }, { door: 'one-way' }] })]),
    );
    expect(item.danger.disagree).toEqual([
      'Security-reviewer says blast radius data (the track says small)',
      'A reviewer says door one-way (the track says two-way)',
    ]);
    // The board card shows the line as it is (queue-board/board/decide.js dangerBlock), with no "Reviewer:" before it.
    const board = fs.readFileSync(path.join(__dirname, '..', '..', 'queue-board', 'board', 'decide.js'), 'utf8');
    expect(board).not.toMatch(/Reviewer: \$\{/);
  });

  it('never changes what the card can do', () => {
    const [one] = D.fromInbox(inboxWith([qaTask('T-1', { door: 'one-way', blast: 'data' })]));
    const [two] = D.fromInbox(inboxWith([qaTask('T-1')]));
    expect(one.options).toEqual(two.options);
    expect(one.recommendation).toBe(two.recommendation);
  });

  it('the inbox passes the record on for QA and for a stopped review', () => {
    const md = { door: 'one-way', blast: 'schema', at: '2026-11-22T10:00:00.000Z' };
    const queue = {
      tasks: [
        { id: 'T-1', title: 'Done one', status: 'done', qa_status: 'waiting', merge_danger: md, class: 'K' },
        {
          id: 'T-2',
          title: 'Stopped one',
          status: 'review',
          class: 'K',
          merge_danger: md,
          blocks: [{ code: 'merge-conflict', from: '2026-11-22T10:00:00.000Z', note: 'conflict' }],
        },
      ],
    };
    const inbox = B.board(queue, { now: Date.parse('2026-11-22T11:00:00.000Z') }).inbox;
    const items = Object.fromEntries(D.fromInbox(inbox).map((x: any) => [x.id, x]));
    expect(items['T-1'].danger?.door).toBe('one-way');
    expect(items['T-2'].danger?.blast).toBe('schema');
  });
});

describe('ravenseat decide', () => {
  it('prints the badge and the two values under a delivery, and a reviewer who disagrees', () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ravenseat-mdg-decide-'));
    try {
      fs.writeFileSync(
        path.join(folder, 'queue.json'),
        JSON.stringify({
          tasks: [
            {
              id: 'T-9',
              title: 'Login form',
              status: 'done',
              class: 'K',
              value: 2,
              qa_status: 'waiting',
              merge_danger: { door: 'one-way', blast: 'users', reviewers: [{ type: 'reviewer', door: 'two-way' }] },
            },
          ],
          resolved: [],
        }),
      );
      const out = execFileSync(process.execPath, [path.resolve(__dirname, '..', '..', 'queue.mjs'), 'decide'], {
        env: { ...process.env, QUEUE_FOLDER: folder, QUEUE_GIT: folder, QUEUE_TIME_LOG: path.join(folder, 'times.jsonl') },
        encoding: 'utf8',
      });
      expect(out).toContain(`${D.ONE_WAY_BADGE}. Door: one-way · Blast radius: users`);
      expect(out).toContain('   Reviewer says door two-way (the track says one-way)');
      expect(out).not.toMatch(/Reviewer: reviewer/i);
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });
});

describe('"Decided for you" and the PR body', () => {
  const now = Date.parse('2026-11-22T12:00:00.000Z');
  it('a row of merged work carries the door and blast radius', () => {
    const queue = {
      tasks: [
        {
          id: 'T-1',
          title: 'Cleanup',
          status: 'done',
          merge_danger: { door: 'one-way', blast: 'data', reviewers: [{ type: 'reviewer', door: 'two-way', blast: 'data' }] },
          decision_signals: { at: '2026-11-22T11:00:00.000Z', signals: [{ category: 'deletion', what: '4 files deleted', asked: false, told: false }] },
        },
      ],
    };
    const [row] = D.decidedForYou(queue, { now: now });
    expect(row.danger).toMatchObject({ door: 'one-way', blast: 'data', oneWay: true });
    expect(row.danger.disagree).toEqual(['Reviewer says door two-way (the track says one-way)']);
  });

  it('the PR fields come from the record, with the reviewer door when it differs', () => {
    expect(MD.prFields({ merge_danger: { door: 'two-way', blast: 'small' } })).toEqual({ door: 'two-way', blast: 'small', reviewerDoor: null });
    expect(MD.prFields({ merge_danger: { door: 'two-way', blast: 'small', reviewers: [{ type: 'reviewer', door: 'one-way' }] } }).reviewerDoor).toBe('one-way');
    expect(MD.prFields({})).toEqual({ door: null, blast: null, reviewerDoor: null });
    const body = GO.prBody({
      tasks: [{ id: 'A-1', title: 'One', ...MD.prFields({ merge_danger: { door: 'two-way', blast: 'small', reviewers: [{ type: 'reviewer', door: 'one-way' }] } }) }],
      tip: 'a'.repeat(40),
      base: 'main',
      fullGate: 'green',
      health: 'green',
    });
    expect(body).toMatch(/door two-way, blast radius small, reviewer says door one-way/);
  });
});
