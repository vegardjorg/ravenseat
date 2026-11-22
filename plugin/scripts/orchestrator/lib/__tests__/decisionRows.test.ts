// =============================================================
// decisionRows.test.ts: the decision rows in the time log (section 7.1 of plans/autonomi-nivaa-utredning.md),
// built by lib/decisionRows.js and written by resolve, approve, cancel --remark declined and qa.
//
// Why: "how often does the owner follow the recommendation" is the number the autonomy levels are tuned on, so it must
// only count what says something: a single answer by the owner (or the board) to a question that had a recommendation.
// Machine cards (approve, QA) have a fixed recommendation in code and never count; bulk answers never count.
// =============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const R = require('../decisionRows.js') as any;

const NOW = '2026-11-22T10:00:00.000Z';
const ASKED = '2026-11-21T09:00:00.000Z';

describe('followed (table 7.1)', () => {
  const base = { verb: 'decide', recommended: 'Use date-fns', by: 'owner', bulk: false };
  it('the recommended choice is true, also with a note; another choice is false', () => {
    expect(R.followedOf({ ...base, chosen: 'Use date-fns' })).toBe(true);
    expect(R.followedOf({ ...base, chosen: 'use DATE-FNS ' })).toBe(true);
    expect(R.followedOf({ ...base, chosen: 'Write it ourselves' })).toBe(false);
  });
  it('free text is false, except "Use the recommendation" and "As recommended"', () => {
    expect(R.followedOf({ ...base, chosen: 'Use the recommendation' })).toBe(true);
    expect(R.followedOf({ ...base, chosen: 'As recommended.' })).toBe(true);
    expect(R.followedOf({ ...base, chosen: 'Maybe later, ask the vendor first' })).toBe(false);
  });
  it('does not count (null): no recommendation, another by, bulk, or a machine card', () => {
    expect(R.followedOf({ ...base, recommended: null, chosen: 'x' })).toBeNull();
    expect(R.followedOf({ ...base, by: 'orchestrator', chosen: 'Use date-fns' })).toBeNull();
    expect(R.followedOf({ ...base, by: null, chosen: 'Use date-fns' })).toBeNull();
    expect(R.followedOf({ ...base, by: 'theBoard', chosen: 'Use date-fns' })).toBe(true);
    expect(R.followedOf({ ...base, bulk: true, chosen: 'Use date-fns' })).toBeNull();
    for (const verb of ['approve', 'check', 'unstick']) expect(R.followedOf({ ...base, verb, chosen: 'Use date-fns' })).toBeNull();
  });
});

describe('the rows', () => {
  const q = { type: 'question', text: 'Use date-fns?', category: 'dependency', recommendation: 'Use date-fns', choices: ['Use date-fns', 'Write it ourselves'], added_at: ASKED };

  it('a resolve row with every field, and no answer text beyond the choice', () => {
    const row = R.resolveRow({ sp: 'Q-7', q, chosen: 'Use date-fns', note: true, by: 'owner', surface: 'board', bulk: false, now: NOW });
    expect(row).toEqual({
      time: NOW,
      event: 'decision',
      key: 'decide:Q-7',
      verb: 'decide',
      category: 'dependency',
      recommended: 'Use date-fns',
      chosen: 'Use date-fns',
      followed: true,
      note: true,
      asked_at: ASKED,
      answered_at: NOW,
      by: 'owner',
      surface: 'board',
      bulk: false,
      auto: false,
    });
  });

  it('an old post is uncategorized; free text is not stored as chosen (it can hold names), only whether it followed', () => {
    const row = R.resolveRow({ sp: 'OLD', q: { type: 'question', text: 'x', recommendation: 'Yes' }, chosen: 'No, ask Kari first', free: true, by: 'owner', now: NOW });
    expect(row).toMatchObject({ category: 'uncategorized', chosen: null, followed: false, asked_at: null, surface: 'cli' });
  });

  it('machine rows: approve, decline and QA never count, and carry their fixed category', () => {
    const t = { id: 'T-5', added_at: ASKED };
    expect(R.taskRow({ verb: 'approve', task: t, chosen: 'Approve', by: 'owner', now: NOW })).toMatchObject({
      key: 'approve:T-5',
      category: 'followups',
      recommended: 'Approve',
      chosen: 'Approve',
      followed: null,
      asked_at: ASKED,
    });
    expect(R.taskRow({ verb: 'approve', task: t, chosen: 'Decline', by: 'owner', now: NOW })).toMatchObject({ chosen: 'Decline', followed: null });
    expect(R.taskRow({ verb: 'check', task: t, chosen: 'QA ok', by: 'auto', bulk: true, now: NOW })).toMatchObject({
      key: 'check:T-5',
      category: 'uncategorized',
      recommended: 'QA ok',
      followed: null,
      bulk: true,
      auto: true,
    });
  });

  it('the surface comes from RAVENSEAT_SURFACE (the board server sets it), otherwise cli', () => {
    expect(R.surfaceOf({ RAVENSEAT_SURFACE: 'board' })).toBe('board');
    expect(R.surfaceOf({})).toBe('cli');
    expect(R.surfaceOf({ RAVENSEAT_SURFACE: 'something' })).toBe('cli');
  });
});

// ---- the CLI commands write them ----------------------------------------------------------------------------------

const QUEUE = resolve(__dirname, '..', '..', 'queue.mjs');
let folder: string;
const env = (own: object = {}) => ({ ...process.env, QUEUE_FOLDER: folder, QUEUE_GIT: folder, QUEUE_TIME_LOG: join(folder, 'times.jsonl'), ...own });
const run = (args: string[], own: object = {}) => execFileSync(process.execPath, [QUEUE, ...args], { env: env(own), encoding: 'utf8' });
const rows = () =>
  existsSync(join(folder, 'times.jsonl'))
    ? readFileSync(join(folder, 'times.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((x) => x.event === 'decision')
    : [];
const queue = () => JSON.parse(readFileSync(join(folder, 'queue.json'), 'utf8'));

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'ravenseat-drows-'));
  writeFileSync(
    join(folder, 'queue.json'),
    JSON.stringify({
      tasks: [
        { id: 'T-1', title: 'Needs vendor', status: 'waiting', class: 'K', value: 3, waiting_on: ['Q-1'] },
        { id: 'T-5', title: 'Add export', status: 'proposed', class: 'K', value: 3, added_at: ASKED },
        { id: 'T-6', title: 'Add import', status: 'proposed', class: 'K', value: 3 },
        { id: 'T-9', title: 'Login form', status: 'done', class: 'K', value: 2, domain: 'general', qa_status: 'waiting' },
      ],
      question: {
        'Q-1': { type: 'question', text: 'Which vendor?', category: 'product', recommendation: 'Vendor B', choices: ['Vendor A', 'Vendor B'], added_at: ASKED },
      },
      resolved: [],
    }),
  );
});
afterEach(() => rmSync(folder, { recursive: true, force: true }));

describe('the commands write one row per answer', () => {
  it('resolve --choice: the row, and resolutions get category and followed', () => {
    run(['resolve', 'Q-1', '--choice', '2', '--by', 'owner'], { RAVENSEAT_SURFACE: 'board' });
    expect(rows()).toEqual([expect.objectContaining({ key: 'decide:Q-1', category: 'product', chosen: 'Vendor B', followed: true, surface: 'board', by: 'owner' })]);
    expect(queue().resolutions['Q-1']).toMatchObject({ category: 'product', followed: true });
  });

  it('resolve with another choice and a note', () => {
    run(['resolve', 'Q-1', '--choice', '1', '--answer', 'cheaper', '--by', 'owner']);
    expect(rows()[0]).toMatchObject({ chosen: 'Vendor A', followed: false, note: true, surface: 'cli' });
    expect(queue().resolutions['Q-1'].followed).toBe(false);
  });

  it('approve of two is bulk; a decline is its own row; qa ok is a check row', () => {
    run(['approve', 'T-5', 'T-6', '--by', 'owner']);
    expect(rows().map((r: any) => [r.key, r.chosen, r.bulk, r.followed])).toEqual([
      ['approve:T-5', 'Approve', true, null],
      ['approve:T-6', 'Approve', true, null],
    ]);
    run(['qa', 'ok', 'T-9', '--by', 'owner']);
    expect(rows()[2]).toMatchObject({ key: 'check:T-9', verb: 'check', chosen: 'QA ok', bulk: false });
  });

  it('qa deviation --by owner (the board passes it): the row records the owner, and "owner" never becomes the text', () => {
    run(['qa', 'deviation', 'T-9', 'The button is gone', '--by', 'owner'], { RAVENSEAT_SURFACE: 'board' });
    expect(rows()).toEqual([expect.objectContaining({ key: 'check:T-9', chosen: 'Deviation', by: 'owner', surface: 'board' })]);
    const fix = queue().tasks.find((o: any) => o.id === 'T-9-QA1');
    expect(fix.mission).toContain('The button is gone');
    expect(fix.mission).not.toMatch(/owner\n/);
  });

  it('cancel --remark declined of a proposal writes a Decline row; a plain cancel writes none', () => {
    run(['cancel', 'T-5', '--remark', 'declined', '--by', 'owner']);
    expect(rows()).toEqual([expect.objectContaining({ key: 'approve:T-5', chosen: 'Decline', followed: null })]);
    run(['cancel', 'T-1', '--remark', 'not needed']);
    expect(rows()).toHaveLength(1);
  });

  it('fails open: a time log that cannot be written never stops the answer', () => {
    run(['resolve', 'Q-1', '--choice', '2', '--by', 'owner'], { QUEUE_TIME_LOG: folder }); // a folder: the append fails
    expect(queue().resolutions['Q-1'].answer).toBe('Vendor B');
  });
});
