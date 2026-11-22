// =============================================================
// queueDecisions.test.ts: the decision overview's rules (lib/queueDecisions.js), shared by `ravenseat decide`, /ravenseat:decide
// and the board's Decisions view.
//
// Why: the owner's main loop is one list of everything that waits on them, most impact first. The sort (focus stage 1
// first, then what the answer unlocks), the groups (Decide, Check, Approve, Unstick), the impact line and the exact
// write per option are pure here, so the CLI and the board cannot drift apart.
// =============================================================
import { describe, it, expect } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const D = require('../queueDecisions') as any;

const inbox = {
  question: [
    {
      sp: 'Q-1',
      type: 'question',
      text: 'Which vendor?',
      recommendation: 'Vendor B',
      choices: [{ label: 'Vendor A' }, { label: 'Vendor B', recommended: true }],
      direct: ['T-1'],
      count: 1,
      minutes: 60,
      focus: null,
    },
    {
      sp: 'Q-2',
      type: 'question',
      text: 'Ship the beta?',
      recommendation: 'Yes, behind a flag',
      choices: [],
      direct: ['T-2', 'T-3'],
      count: 2,
      minutes: 30,
      focus: { per_step: [30], count: 2, minutes: 30 },
    },
  ],
  qa: [{ pid: 'P', title: 'Project', features: [{ feature: 'login', tasks: [{ id: 'T-9', title: 'Login form' }] }] }],
  proposed: [{ id: 'T-5', title: 'Add export', class: 'K', estimate: 45, value: 3, unlocks: { count: 1, minutes: 20 } }],
  stuck: [
    { id: 'T-7', title: 'Old pick', status: 'picked', picked_by: 'agent' },
    { id: 'T-8', title: 'Long run', status: 'active', aging: { age: 600, limit: 300, measure: 'work' }, class: 'K' },
    { id: 'T-6', title: 'Blocked run', status: 'active', aging: { age: 600, limit: 300 }, open_block: 'other' },
  ],
};

describe('items from the inbox', () => {
  const items = D.fromInbox(inbox);
  const byKey = Object.fromEntries(items.map((x: any) => [x.key, x]));

  it('makes one item per question, QA task, proposal and stuck task', () => {
    expect(items.map((x: any) => x.key).sort()).toEqual(
      ['approve:T-5', 'check:T-9', 'decide:Q-1', 'decide:Q-2', 'unstick:T-6', 'unstick:T-7', 'unstick:T-8'].sort(),
    );
  });

  it('keeps the choices in their written order, marks the recommended one, and keeps its 1-based choice number', () => {
    const q = byKey['decide:Q-1'];
    expect(q.options.map((o: any) => o.label)).toEqual(['Vendor A', 'Vendor B']);
    expect(q.options.map((o: any) => o.recommended)).toEqual([false, true]);
    expect(q.options[1].action).toEqual({ type: 'resolve', sp: 'Q-1', choice: 2 });
    expect(q.free.action).toEqual({ type: 'resolve', sp: 'Q-1', answer: null });
  });

  it('a question without choices but with a recommendation gets "As recommended"', () => {
    const q = byKey['decide:Q-2'];
    expect(q.options).toHaveLength(1);
    expect(q.options[0].label).toBe('As recommended');
    expect(q.options[0].action).toEqual({ type: 'resolve', sp: 'Q-2', answer: 'Yes, behind a flag' });
  });

  it('QA: ok is recommended, a deviation needs text; a proposal: approve, or decline with an optional reason', () => {
    expect(byKey['check:T-9'].options.map((o: any) => [o.label, o.recommended, !!o.needsText])).toEqual([
      ['QA ok', true, false],
      ['Deviation', false, true],
    ]);
    const p = byKey['approve:T-5'].options;
    expect(p[0].action.type).toBe('approve');
    expect(p[1]).toMatchObject({ label: 'Decline', optionalText: true });
  });

  it('stuck: release a picked task, flag an aging one, and never flag one that already has an open blocker', () => {
    expect(byKey['unstick:T-7'].options.map((o: any) => o.action.type)).toEqual(['release', 'keep']);
    expect(byKey['unstick:T-8'].options.map((o: any) => o.action.type)).toEqual(['flag-stuck', 'keep']);
    expect(byKey['unstick:T-6'].options.map((o: any) => o.action.type)).toEqual(['keep']);
  });
});

describe('sorting and grouping', () => {
  const item = (key: string, verb: string, impact: object) => ({
    key,
    verb,
    impact: { count: 0, minutes: 0, perStep: [], focusCount: 0, focusMinutes: 0, ...impact },
  });

  it('focus stage 1 minutes weigh most, then later stages, then tasks unlocked, minutes, verb and key', () => {
    const list = [
      item('decide:a', 'decide', { count: 9, minutes: 900 }),
      item('decide:b', 'decide', { perStep: [0, 120], focusCount: 1 }),
      item('decide:c', 'decide', { perStep: [10], focusCount: 1 }),
      item('check:d', 'check', {}),
      item('decide:e', 'decide', {}),
      item('unstick:f', 'unstick', {}),
      item('decide:g', 'decide', { count: 9, minutes: 100 }),
    ];
    expect(D.sortItems(list).map((x: any) => x.key)).toEqual([
      'decide:c',
      'decide:b',
      'decide:a',
      'decide:g',
      'decide:e',
      'unstick:f',
      'check:d',
    ]);
  });

  it('groups in the order Decide, Check, Approve, Unstick, each sorted, empty ones left out', () => {
    const groups = D.groupItems(D.fromInbox(inbox));
    expect(groups.map((g: any) => g.verb)).toEqual(['decide', 'check', 'approve', 'unstick']);
    expect(groups[0].items.map((x: any) => x.id)).toEqual(['Q-2', 'Q-1']); // Q-2 is in focus stage 1
    expect(D.groupItems([]).length).toBe(0);
    // The keyboard walks the groups as drawn.
    expect(D.walkOrder(D.fromInbox(inbox)).map((x: any) => x.key)[0]).toBe('decide:Q-2');
  });

  it('decisions() is the sorted list the CLI and the skill walk', () => {
    expect(D.decisions(inbox)[0].key).toBe('decide:Q-2');
    expect(D.decisions(null)).toEqual([]);
  });
});

describe('the impact line', () => {
  const items = Object.fromEntries(D.fromInbox(inbox).map((x: any) => [x.key, x]));
  it('says what the answer unlocks, in words', () => {
    expect(D.impactLine(items['decide:Q-2'])).toBe('unlocks 2 tasks (30 min) · in focus: 2 (30 min), step 1 first');
    expect(D.impactLine(items['approve:T-5'])).toBe('queues it (45 min) · then unlocks 1 task (20 min)');
    expect(D.impactLine(items['check:T-9'])).toBe('closes the QA; nothing waits on it');
    expect(D.impactLine({ ...items['approve:T-5'], batched: true })).toContain('puts it in the batch queue (45 min), where it does not start alone');
    expect(D.impactLine(items['unstick:T-7'])).toBe('nothing waits on it');
  });
});

describe('the writes', () => {
  it('cliArgs gives the same queue.mjs command the board runs, with --by owner where it is recorded', () => {
    expect(D.cliArgs({ type: 'resolve', sp: 'Q-1', choice: 2 })).toEqual(['resolve', 'Q-1', '--choice', '2', '--by', 'owner']);
    expect(D.cliArgs({ type: 'resolve', sp: 'Q-1', answer: 'Do X' })).toEqual(['resolve', 'Q-1', '--answer', 'Do X', '--by', 'owner']);
    expect(D.cliArgs({ type: 'qa-ok', id: 'T-9' })).toEqual(['qa', 'ok', 'T-9', '--by', 'owner']);
    expect(D.cliArgs({ type: 'qa-deviation', id: 'T-9', text: 'Broken' })).toEqual(['qa', 'deviation', 'T-9', 'Broken']);
    expect(D.cliArgs({ type: 'approve', id: 'T-5' })).toEqual(['approve', 'T-5', '--by', 'owner']);
    expect(D.cliArgs({ type: 'decline', id: 'T-5', reason: ' not  now ' })).toEqual([
      'cancel',
      'T-5',
      '--remark',
      'declined: not now',
      '--by',
      'owner',
    ]);
    expect(D.cliArgs({ type: 'release', id: 'T-7' })).toEqual(['release', 'T-7']);
    expect(D.cliArgs({ type: 'flag-stuck', id: 'T-8' })).toEqual(['block', 'T-8', 'other', '--note', D.FLAG_NOTE]);
    expect(D.cliArgs({ type: 'keep', id: 'T-8' })).toBeNull();
  });

  it('cliText quotes what the shell needs quoted', () => {
    expect(D.cliText(['resolve', 'Q-1', '--answer', 'say "hi" $HOME'])).toBe('ravenseat resolve Q-1 --answer "say \\"hi\\" \\$HOME"');
    expect(D.cliText(null)).toBeNull();
  });

  it('boardCall: /api/action, and decline through /api/task-edit', () => {
    expect(D.boardCall({ type: 'resolve', sp: 'Q-1', choice: 2 })).toEqual({
      path: '/api/action',
      body: { type: 'resolve', sp: 'Q-1', choice: 2 },
    });
    expect(D.boardCall({ type: 'flag-stuck', id: 'T-8' })).toEqual({ path: '/api/action', body: { type: 'flag-stuck', id: 'T-8' } });
    expect(D.boardCall({ type: 'decline', id: 'T-5', reason: 'later' })).toEqual({
      path: '/api/task-edit',
      body: { type: 'decline', id: 'T-5', reason: 'later' },
    });
    expect(D.boardCall({ type: 'keep' })).toBeNull();
  });

  it('decline with keep (roadmap 0f): cancel --keep on the command line, keep: true to the board server', () => {
    expect(D.cliArgs({ type: 'decline', id: 'T-5', reason: 'too noisy', keep: true })).toEqual([
      'cancel',
      'T-5',
      '--remark',
      'declined: too noisy',
      '--keep',
      '--by',
      'owner',
    ]);
    expect(D.boardCall({ type: 'decline', id: 'T-5', keep: true })).toEqual({
      path: '/api/task-edit',
      body: { type: 'decline', id: 'T-5', keep: true },
    });
  });
});

describe('decided today', () => {
  const now = new Date(2026, 4, 10, 15, 0).getTime();
  const at = (h: number) => new Date(2026, 4, 10, h, 0).toISOString();
  const yesterday = new Date(2026, 4, 9, 23, 0).toISOString();
  const queue = {
    resolutions: { 'Q-1': { time: at(9), answer: 'Vendor B', by: 'owner' }, 'Q-0': { time: yesterday, answer: 'old' } },
    auto_accepted: [{ id: 'T-3', at: at(11) }],
    tasks: [
      { id: 'T-1', approved: at(10), approved_by: 'owner' },
      { id: 'T-3', approved: at(11) }, // the auto-accept: not the owner's decision
      { id: 'T-4', qa_ok: at(12), qa_ok_by: 'owner' },
      { id: 'T-5', qa_ok: at(13), qa_ok_by: 'auto' },
      { id: 'T-6', remarks: [`${at(14)} declined: not now`, `${yesterday} declined`] },
      { id: 'T-7', remarks: [`${at(8)} QA deviation, fix T-8`] },
    ],
  };

  it('lists the owner decisions since the start of the local day, newest first, without the automatic ones', () => {
    const list = D.decidedToday(queue, { now });
    expect(list.map((x: any) => [x.verb, x.id, x.what])).toEqual([
      ['approve', 'T-6', 'declined: not now'],
      ['check', 'T-4', 'QA ok'],
      ['approve', 'T-1', 'approved'],
      ['decide', 'Q-1', 'Vendor B'],
      ['check', 'T-7', 'QA deviation, fix T-8'],
    ]);
    expect(D.decidedToday(queue, { now, max: 2 })).toHaveLength(2);
    expect(D.decidedToday({}, { now })).toEqual([]);
  });
});

describe('the "focus ended" owner question (focus-done-<n>)', () => {
  const box = {
    question: [
      { sp: 'Q-9', type: 'question', text: 'Big one', direct: ['A', 'B'], count: 5, minutes: 600, focus: { per_step: [600], count: 5, minutes: 600 } },
      {
        sp: 'focus-done-1',
        type: 'question',
        text: 'Focus "Auth" is done: set a new focus or continue the regular queue?',
        choices: [{ label: 'Set a new focus' }, { label: 'Continue the regular queue' }],
        direct: [],
        count: 0,
        minutes: 0,
        focus: null,
      },
    ],
  };

  it('comes first, says the queue is paused, and answers with the choice number like any question', () => {
    const list = D.decisions(box);
    expect(list[0].id).toBe('focus-done-1');
    expect(D.impactLine(list[0])).toBe('the queue is paused until you answer');
    expect(list[0].options.map((o: any) => o.label)).toEqual(['Set a new focus', 'Continue the regular queue']);
    expect(D.cliArgs(list[0].options[1].action)).toEqual(['resolve', 'focus-done-1', '--choice', '2', '--by', 'owner']);
  });
});

describe('decided for you (phase 1 of the question level study, section 5.2)', () => {
  const now = new Date(2026, 4, 10, 15, 0).getTime();
  const at = (h: number) => new Date(2026, 4, 10, h, 0).toISOString();
  const yesterday = new Date(2026, 4, 9, 23, 0).toISOString();
  const sig = (h: number, signals: any[]) => ({ at: at(h), tip: 'abc', signals, not_asked: signals.filter((s) => s.asked === false).map((s) => s.category) });
  const queue = {
    auto_accepted: [
      { id: 'F-1', at: at(9), reason: 'class K, estimate 30 min <= 60' },
      { id: 'F-2', at: at(10), reason: 'class K' },
      { id: 'F-3', at: at(11), reason: 'class K', undone: at(12) },
      { id: 'F-0', at: yesterday, reason: 'class K' },
    ],
    tasks: [
      { id: 'F-1', title: 'Add a retry', status: 'waiting', approved: at(9) },
      { id: 'F-2', title: 'Tidy logs', status: 'running', started: at(10), approved: at(10) },
      { id: 'F-3', title: 'Old idea', status: 'proposed' },
      { id: 'F-0', title: 'Yesterday', status: 'waiting' },
      {
        id: 'T-1',
        title: 'Export',
        status: 'review',
        decision_signals: sig(13, [
          { category: 'dependency', what: '1 new package: date-fns', items: ['date-fns'], asked: false, told: false },
          { category: 'migration', what: '1 migration or schema file', items: ['db/migrations/1.sql'], asked: true, told: false },
        ]),
      },
      {
        id: 'T-2',
        title: 'Cleanup',
        status: 'done',
        merge_commit: '0123456789abcdef',
        decision_signals: sig(14, [{ category: 'deletion', what: '4 files deleted', items: [], asked: false, told: true }]),
      },
      { id: 'T-3', status: 'review', decision_signals: { ...sig(8, []), at: yesterday } },
    ],
  };

  it('auto-approved proposals and delivered signals since the start of the day, newest first, with how to undo', () => {
    const list = D.decidedForYou(queue, { now });
    expect(list.map((x: any) => [x.id, x.category, x.who])).toEqual([
      ['T-2', 'Deletion', 'The agent decided'],
      ['T-1', 'New package', 'The agent decided'],
      ['T-1', 'Migration or schema', 'The agent decided'],
      ['F-3', 'Follow-up tasks', 'Approved by your rules'],
      ['F-2', 'Follow-up tasks', 'Approved by your rules'],
      ['F-1', 'Follow-up tasks', 'Approved by your rules'],
    ]);
    const by = (id: string, c?: string) => list.find((x: any) => x.id === id && (!c || x.category === c));
    expect(by('F-1')).toMatchObject({ what: 'Add a retry', why: 'class K, estimate 30 min <= 60', at: at(9), undo: 'ravenseat proposals undo F-1' });
    expect(by('F-2').undo).toBe('started: ravenseat set F-2 cancelled (the tokens it used are spent)');
    expect(by('F-3').undo).toBe('undone already, back to proposed');
    expect(by('T-1', 'New package')).toMatchObject({ what: '1 new package: date-fns', why: 'not asked', title: 'Export' });
    expect(by('T-1', 'New package').undo).toBe('not merged: ravenseat resume T-1 --reason fix --answer "<what to change>"');
    expect(by('T-1', 'Migration or schema').why).toBe('asked you');
    expect(by('T-2')).toMatchObject({ why: 'not asked, but said under Assumptions', undo: 'merged: ravenseat undo T-2' });
    // The parts the board shows apart: the state and the cost in words, the command as code.
    expect(by('T-2').undo_parts).toEqual({ when: 'merged', cli: 'ravenseat undo T-2', note: null });
    expect(by('F-2').undo_parts).toEqual({ when: 'started', cli: 'ravenseat set F-2 cancelled', note: 'the tokens it used are spent' });
    expect(by('F-3').undo_parts).toEqual({ when: 'undone already, back to proposed', cli: null, note: null });
  });

  it('follows a window, a max and an empty queue; the labels are the ones receive uses', () => {
    expect(D.decidedForYou(queue, { now, from: new Date(2026, 4, 10, 12, 30).getTime() }).map((x: any) => x.id)).toEqual(['T-2', 'T-1', 'T-1']);
    expect(D.decidedForYou(queue, { now, max: 2 })).toHaveLength(2);
    expect(D.decidedForYou({}, { now })).toEqual([]);
    expect(D.decidedForYou(queue, { now, ravenseat: 'cq' }).find((x: any) => x.id === 'F-1').undo).toBe('cq proposals undo F-1');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    expect(D.SIGNAL_LABELS).toEqual(require('../decisionSignals').LABELS);
  });

  it('is never in the decision count, and decided today still skips the auto-accepts', () => {
    expect(D.decidedToday(queue, { now }).some((x: any) => x.id.startsWith('F-'))).toBe(false);
  });
});
