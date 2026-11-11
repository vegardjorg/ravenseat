// =============================================================
// queueBoardBlocked.test.ts: the Blocked column (board.blockedColumn, off by default), computed on the server side in
// lib/queueBoard.js board(queue, { blockedColumn }).
//   - Off (the default), there is no Blocked column and every card stays where it was.
//   - On, a task with an open blocker that needs action (owner-question, merge-conflict, merge-guard, merge-stopped,
//     gate-red, silent, no-agent, context, quota, other) leaves its own column for Blocked. Normal waiting
//     (depends_on, an ownership conflict with an active task, parking) and the codes track-question and dependency stay
//     where they were. A closed blocker, and an open one on a finished task, do not count.
//   - Blocked is sorted by what the task holds back (unlocks), then by how long the blocker has stood (oldest first).
//   - The card carries the code and the age with the same text as `ravenseat blockers` (queueLogic.ageText).
//   - A task is never in two columns, and "Waiting on you" (the inbox) is the same with the column on or off.
// =============================================================
import { describe, it, expect } from 'vitest';

/* eslint-disable @typescript-eslint/no-require-imports */
const T = require('../queueBoard.js') as { board: (queue: unknown, option?: unknown) => any };
const L = require('../queueLogic.js') as any;
/* eslint-enable @typescript-eslint/no-require-imports */

const NOW = Date.parse('2026-11-10T12:00:00.000Z');
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

const task = (id: string, status: string, own: object = {}) => ({
  id,
  title: `Task ${id}`,
  domain: 'ui',
  class: 'K',
  value: 5,
  content_min: 90,
  status,
  depends_on: [],
  waiting_on: [],
  owned_files: [`file/${id}.ts`],
  owner_db: [],
  shared_patch: [],
  mission: `scripts/.queue/mission/${id}.md`,
  added_by: 'test',
  added_at: ago(600),
  ...(status === 'running' || status === 'review' ? { started: ago(120) } : {}),
  ...(status === 'review' ? { delivered: ago(60) } : {}),
  ...(status === 'done' ? { done: ago(30) } : {}),
  ...own,
});
const block = (code: string, minutes: number, extra: object = {}) => ({ code, from: ago(minutes), ...extra });

function makeQueue(tasks: object[]) {
  return {
    created: ago(1000),
    limits: { maxConcurrent: 5, maxDPlus: 2, maxPerDomain: 5, maxDb: 2 },
    tasks,
    projects: { ex: { title: 'Example', prefixes: ['EX-'] } },
    areas: {},
    question: [],
    resolutions: [],
    changelog: [],
  };
}

const queue = makeQueue([
  // Stuck: open blockers that need action, in three different home columns.
  task('EX-1', 'waiting', { blocks: [block('owner-question', 30)] }),
  task('EX-2', 'review', { blocks: [block('merge-conflict', 200)] }),
  task('EX-3', 'running', { blocks: [block('silent', 90)] }),
  // EX-4 holds back EX-5 and EX-6, EX-1 holds back EX-7: they come first, most held back first.
  task('EX-4', 'waiting', { blocks: [block('gate-red', 10)] }),
  task('EX-5', 'waiting', { depends_on: ['EX-4'] }),
  task('EX-6', 'waiting', { depends_on: ['EX-5'] }),
  task('EX-7', 'waiting', { depends_on: ['EX-1'] }),
  // Normal waiting: stays in In queue.
  task('EX-8', 'waiting', { parked: { reason: 'later', by: 'owner' } }),
  task('EX-9', 'running'),
  task('EX-10', 'waiting', { owned_files: ['file/EX-9.ts'] }),
  // Not counted: a closed blocker, codes that are not stuck, and an open blocker on a finished task.
  task('EX-11', 'waiting', { blocks: [block('quota', 300, { to: ago(100) })] }),
  task('EX-12', 'running', { blocks: [block('track-question', 40)] }),
  task('EX-13', 'waiting', { blocks: [block('dependency', 40)] }),
  task('EX-14', 'done', { blocks: [block('gate-red', 50)] }),
]);

const COLS = ['queue', 'proposed', 'batch', 'blocked', 'inProgress', 'review', 'built'];
const idsIn = (b: any, col: string) => (b.columns[col] ?? []).map((k: any) => k.id);
const allIds = (b: any) => COLS.flatMap((col) => idsIn(b, col));

describe('"Next up" and the start rules skip a task with an open blocker that needs action', () => {
  const ids = (list: { id: string }[]) => list.map((v) => v.id);

  it('the board strip leaves out EX-1 (owner-question) and EX-4 (gate-red), with the column on or off', () => {
    // Room for every waiting task, so only the blockers decide.
    const roomy = { ...queue, limits: { ...queue.limits, maxConcurrent: 20, maxPerDomain: 20 } };
    for (const blockedColumn of [false, true]) {
      const n = T.board(roomy, { now: NOW, blockedColumn }).next;
      expect(ids(n.startable)).not.toContain('EX-1');
      expect(ids(n.startable)).not.toContain('EX-4');
      // A closed blocker and the codes that are normal waiting do not hold a task back.
      expect(ids(n.startable)).toEqual(expect.arrayContaining(['EX-11', 'EX-13']));
    }
  });

  it('selectNext (fill, next, the CLI Next up) and blockers say the same, and unblock frees the task', () => {
    expect(ids(L.selectNext(queue, NOW))).not.toContain('EX-4');
    const ex4 = queue.tasks.find((o: any) => o.id === 'EX-4');
    expect(L.blockers(ex4, queue.tasks, [])).toEqual([
      expect.stringMatching(/^blocked: gate-red .*ravenseat unblock EX-4/),
    ]);
    expect(L.blockers(queue.tasks.find((o: any) => o.id === 'EX-11'), queue.tasks, [])).toEqual([]);
    const freed = structuredClone(queue);
    L.closeBlock(freed.tasks.find((o: any) => o.id === 'EX-4'), { now: NOW });
    expect(ids(L.selectNext(freed, NOW))).toContain('EX-4');
  });
});

describe('the Blocked column, off by default', () => {
  it('without the switch there is no Blocked column and every card stays in its own column', () => {
    const b = T.board(queue, { now: NOW });
    expect(b.columns.blocked).toBeUndefined();
    expect(idsIn(b, 'queue')).toContain('EX-1');
    expect(idsIn(b, 'review')).toContain('EX-2');
    expect(idsIn(b, 'inProgress')).toContain('EX-3');
  });

  it('with blockedColumn: false it is off too', () => {
    expect(T.board(queue, { now: NOW, blockedColumn: false }).columns.blocked).toBeUndefined();
  });
});

describe('the Blocked column, switched on', () => {
  const on = T.board(queue, { now: NOW, blockedColumn: true });

  it('takes only tasks with an open blocker that needs action, from every open column', () => {
    expect([...idsIn(on, 'blocked')].sort()).toEqual(['EX-1', 'EX-2', 'EX-3', 'EX-4']);
    expect(idsIn(on, 'review')).not.toContain('EX-2');
    expect(idsIn(on, 'inProgress')).not.toContain('EX-3');
  });

  it('leaves normal waiting in In queue: depends_on, an ownership conflict with an active task, parking', () => {
    const q = idsIn(on, 'queue');
    for (const id of ['EX-5', 'EX-6', 'EX-7', 'EX-8', 'EX-10']) expect(q, id).toContain(id);
    const card = (id: string) => on.columns.queue.find((k: any) => k.id === id);
    // Shown muted with the reason, as before.
    for (const id of ['EX-5', 'EX-8', 'EX-10']) {
      expect(card(id).ready, id).toBe(false);
      expect(card(id).blockers.length, id).toBeGreaterThan(0);
    }
  });

  it('ignores a closed blocker, track-question, dependency and an open blocker on a finished task', () => {
    expect(idsIn(on, 'queue')).toEqual(expect.arrayContaining(['EX-11', 'EX-13']));
    expect(idsIn(on, 'inProgress')).toContain('EX-12');
    expect(idsIn(on, 'built')).toContain('EX-14');
  });

  it('every stuck code goes to Blocked, the others do not', () => {
    const stuck = ['owner-question', 'merge-conflict', 'merge-guard', 'merge-stopped', 'gate-red', 'silent', 'no-agent', 'context', 'quota', 'other'];
    const all = L.BLOCK_CODES.map((b: any) => b.code);
    const q = makeQueue(all.map((code: string, i: number) => task(`EX-${i + 1}`, 'waiting', { blocks: [block(code, 5)] })));
    const b = T.board(q, { now: NOW, blockedColumn: true });
    const blockedCodes = b.columns.blocked.map((k: any) => k.block.code).sort();
    expect(blockedCodes).toEqual([...stuck].sort());
    expect(b.columns.queue.map((k: any) => k.id).length).toBe(all.length - stuck.length);
  });

  it('sorts by what the task holds back (unlocks), then by how long the blocker has stood', () => {
    // EX-4 unlocks 2, EX-1 unlocks 1, then EX-2 (200 min) before EX-3 (90 min).
    expect(idsIn(on, 'blocked')).toEqual(['EX-4', 'EX-1', 'EX-2', 'EX-3']);
  });

  it('the card carries the code, when it started, and the age with the same text as ravenseat blockers', () => {
    const k = on.columns.blocked.find((x: any) => x.id === 'EX-2');
    expect(k.block).toEqual({
      code: 'merge-conflict',
      from: ago(200),
      note: null,
      minutes: 200,
      age: L.ageText(200 * 60_000),
    });
    expect(k.block.age).toBe('3 h 20 min');
    // The column it would otherwise be in, so the detail panel keeps its actions.
    expect(k.home).toBe('review');
    expect(on.columns.blocked.find((x: any) => x.id === 'EX-1').home).toBe('queue');
  });

  it('never shows a task in two columns', () => {
    const ids = allIds(on);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual([...allIds(T.board(queue, { now: NOW }))].sort());
  });

  it('leaves "Waiting on you" exactly as it is with the column off', () => {
    expect(on.inbox).toEqual(T.board(queue, { now: NOW }).inbox);
  });
});
