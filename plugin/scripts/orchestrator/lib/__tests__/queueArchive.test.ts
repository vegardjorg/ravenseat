// =============================================================
// queueArchive.test.ts: done and cancelled tasks older than history.archiveDoneAfterDays move from queue.json to
// <dataFolder>/queue-archive.json (lib/queueArchive.js, owner decision B5).
//
// Locks: which tasks move (terminal, untouched for N days, no open task depends on them or fixes them, no QA waiting);
// the archive is written before the queue lets go of them, so a crash in between leaves a task in both places, which
// the next pass and every reader handle without a duplicate; a broken archive is never written over and nothing moves;
// queue.archived keeps each moved id and its status; lookups and the read-only view find archived tasks; restore brings
// one back for a new dependency; the owner log records nothing for a pass and stops on nothing it moved.
// =============================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const QA = require('../queueArchive.js') as any;
const OL = require('../ownerLog.js') as any;
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-12T12:00:00.000Z');
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();
let folder = '';
beforeEach(() => {
  folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ravenseat-archive-'));
});
afterEach(() => fs.rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

const task = (id: string, o: Record<string, unknown> = {}) => ({
  id, title: id, class: 'K', status: 'done', added_at: ago(60), started: ago(59), done: ago(58), depends_on: [], ...o,
});
// Every finished task in a fixture was first seen finished long ago (queue.terminal_since), unless a test says otherwise.
const queueOf = (tasks: any[], extra: Record<string, unknown> = {}) => ({
  tasks,
  changelog: [],
  terminal_since: Object.fromEntries(tasks.filter((t) => ['done', 'cancelled'].includes(t.status)).map((t) => [t.id, ago(58)])),
  ...extra,
});
const ids = (q: any) => q.tasks.map((t: any) => t.id);

describe('candidates', () => {
  it('done and cancelled tasks untouched for more than N days; open ones, recent ones and N = null never', () => {
    const q = queueOf([
      task('OLD'),
      task('GONE', { status: 'cancelled', done: undefined }),
      task('NEW', { done: ago(5) }),
      task('OPEN', { status: 'waiting', done: undefined }),
      task('RUN', { status: 'running', done: undefined }),
    ]);
    expect(QA.candidates(q, { days: 30, now: NOW }).map((t: any) => t.id)).toEqual(['OLD', 'GONE']);
    expect(QA.candidates(q, { days: null, now: NOW })).toEqual([]);
  });

  it('a task an open task depends on, fixes or is a QA fix of, and a done task with QA waiting, stay', () => {
    const q = queueOf([
      task('DEP'),
      task('FIXED'),
      task('QAORIG'),
      task('QA', { qa_status: 'waiting' }),
      task('FREE'),
      task('A', { status: 'waiting', done: undefined, depends_on: ['DEP'], fixes: ['FIXED'], qa_original: 'QAORIG' }),
    ]);
    expect(QA.candidates(q, { days: 30, now: NOW }).map((t: any) => t.id)).toEqual(['FREE']);
  });

  it('gate and kickstart tasks stay (their readers look up what the owner declined), and a task without a time too', () => {
    const q = queueOf([
      task('GATE-1', { status: 'cancelled', labels: ['gate'] }),
      task('KICK', { status: 'cancelled', labels: ['kickstart'] }),
      { id: 'NOTIME', status: 'done' },
    ]);
    expect(QA.candidates(q, { days: 30, now: NOW })).toEqual([]);
  });

  it('a changelog entry (or an undo) that touched the task recently keeps it: it can still be undone', () => {
    const q = queueOf([task('OLD'), task('OTHER')], {
      changelog: [
        { nr: 1, at: ago(2), by: 'owner', action: 'set', changes: [{ id: 'OLD', field: 'status', before: 'waiting', after: 'done' }] },
        { nr: 2, at: ago(90), by: 'owner', action: 'set', changes: [{ id: 'OTHER', field: 'value' }], undone: { at: ago(1), by: 'owner' } },
      ],
    });
    expect(QA.candidates(q, { days: 30, now: NOW })).toEqual([]);
  });
});

describe('terminal_since: a cancel leaves no time on the task, so the archive counts from when it first saw it finished', () => {
  it('a finished task not seen before is stamped now and stays; it moves N days later; an open one again loses its stamp', () => {
    const q: any = queueOf([task('OLD'), task('BACK', { status: 'waiting', done: undefined })], {
      terminal_since: { BACK: ago(90) },
    });
    expect(QA.archiveDone(q, { folder, days: 30, now: NOW }).moved).toEqual([]);
    expect(q.terminal_since).toEqual({ OLD: new Date(NOW).toISOString() });
    expect(QA.archiveDone(q, { folder, days: 30, now: NOW + 31 * DAY }).moved).toEqual(['OLD']);
    expect(q.terminal_since).toEqual({});
  });

  it('any other time on the task (a QA close) counts as a touch', () => {
    const q = queueOf([task('OLD', { qa_closed_at: ago(1) })]);
    expect(QA.candidates(q, { days: 30, now: NOW })).toEqual([]);
  });
});

describe('archiveDone', () => {
  it('moves the tasks to queue-archive.json, keeps their ids and status in queue.archived, and says which moved', () => {
    const q = queueOf([task('OLD'), task('GONE', { status: 'cancelled' }), task('OPEN', { status: 'waiting', done: undefined })]);
    const r = QA.archiveDone(q, { folder, days: 30, now: NOW });
    expect(r.moved).toEqual(['OLD', 'GONE']);
    expect(ids(q)).toEqual(['OPEN']);
    expect(q.archived).toEqual({ OLD: 'done', GONE: 'cancelled' });
    const file = JSON.parse(fs.readFileSync(path.join(folder, 'queue-archive.json'), 'utf8'));
    expect(file.version).toBe(1);
    expect(file.tasks.map((t: any) => t.id)).toEqual(['OLD', 'GONE']);
    expect(file.tasks[0].archived_at).toBe(new Date(NOW).toISOString());
    expect(file.tasks[0].title).toBe('OLD');
  });

  it('nothing to move: no archive file is written', () => {
    const q = queueOf([task('NEW', { done: ago(1) })]);
    expect(QA.archiveDone(q, { folder, days: 30, now: NOW }).moved).toEqual([]);
    expect(fs.existsSync(path.join(folder, 'queue-archive.json'))).toBe(false);
    expect(q.archived).toBeUndefined();
  });

  it('a crash after the archive write (the task in both files): no duplicate in the view, and the next pass replaces it', () => {
    const q = queueOf([task('OLD')]);
    const copy = JSON.parse(JSON.stringify(q));
    QA.archiveDone(copy, { folder, days: 30, now: NOW }); // archive written, but this queue copy is "never published"
    const view = QA.withArchive(q, folder);
    expect(view.tasks.map((t: any) => t.id)).toEqual(['OLD']);
    expect(view.tasks[0].archived).toBeUndefined(); // the queue's own copy wins
    QA.archiveDone(q, { folder, days: 30, now: NOW + 1000 });
    const file = JSON.parse(fs.readFileSync(path.join(folder, 'queue-archive.json'), 'utf8'));
    expect(file.tasks.map((t: any) => t.id)).toEqual(['OLD']);
    expect(ids(q)).toEqual([]);
  });

  it('a broken archive file is never written over, and nothing leaves the queue', () => {
    fs.writeFileSync(path.join(folder, 'queue-archive.json'), '{ broken');
    const q = queueOf([task('OLD')]);
    const r = QA.archiveDone(q, { folder, days: 30, now: NOW });
    expect(r.moved).toEqual([]);
    expect(r.error).toMatch(/does not parse/);
    expect(ids(q)).toEqual(['OLD']);
    expect(fs.readFileSync(path.join(folder, 'queue-archive.json'), 'utf8')).toBe('{ broken');
  });

  it('days null (never): nothing moves', () => {
    const q = queueOf([task('OLD')]);
    expect(QA.archiveDone(q, { folder, days: null, now: NOW }).moved).toEqual([]);
    expect(ids(q)).toEqual(['OLD']);
  });
});

describe('reading archived tasks', () => {
  it('lookup finds an archived task by id, read-only (a copy); withArchive marks them archived and adds them last', () => {
    const q = queueOf([task('OLD'), task('OPEN', { status: 'waiting', done: undefined })]);
    QA.archiveDone(q, { folder, days: 30, now: NOW });
    const o = QA.lookup(folder, 'OLD');
    expect(o).toMatchObject({ id: 'OLD', status: 'done' });
    expect(QA.lookup(folder, 'NOPE')).toBeNull();
    const view = QA.withArchive(q, folder);
    expect(view.tasks.map((t: any) => [t.id, !!t.archived])).toEqual([['OPEN', false], ['OLD', true]]);
    expect(ids(q)).toEqual(['OPEN']); // the queue itself is unchanged
  });

  it('withArchive with no archive file is the queue as it is', () => {
    const q = queueOf([task('A', { status: 'waiting' })]);
    expect(QA.withArchive(q, folder).tasks).toEqual(q.tasks);
  });

  it('restore puts an archived task back in the queue (a new task depends on it) and takes it off queue.archived', () => {
    const q = queueOf([task('OLD'), task('X')]);
    QA.archiveDone(q, { folder, days: 30, now: NOW });
    const r = QA.restore(q, folder, ['OLD', 'NOPE']);
    expect(r).toEqual({ restored: ['OLD'], missing: ['NOPE'] });
    expect(ids(q)).toEqual(['OLD']);
    expect(q.tasks[0].archived_at).toBeUndefined();
    expect(q.archived).toEqual({ X: 'done' });
  });
});

describe('the owner log stays consistent', () => {
  it('an archiving write records nothing new, and a check of the next task finds nothing missing', () => {
    const owner = { nr: 1, at: ago(90), by: 'owner', action: 'edit', changes: [{ id: 'OLD', field: 'value', before: 5, after: 6 }] };
    const q = queueOf([task('OLD', { added_by: 'owner' }), task('NEXT', { status: 'review', done: undefined })], { changelog: [owner] });
    // The first write: the baseline.
    OL.recordWrite(folder, { before: new Set(), after: q });
    const before = OL.keySet(q);
    QA.archiveDone(q, { folder, days: 30, now: NOW });
    expect(OL.recordWrite(folder, { before, after: q }).recorded).toBe(0);
    expect(OL.check(folder, q, 'NEXT').missing).toEqual([]);
    expect(OL.check(folder, q, 'OLD').missing).toEqual([]); // not in the queue: no rows to stop on
  });
});

describe('daysOf', () => {
  it('a whole number of days, or null for never; anything else is never too (doctor names it)', () => {
    expect(QA.daysOf({ history: { archiveDoneAfterDays: 30 } })).toBe(30);
    expect(QA.daysOf({ history: { archiveDoneAfterDays: null } })).toBeNull();
    expect(QA.daysOf({ history: { archiveDoneAfterDays: -1 } })).toBeNull();
    expect(QA.daysOf({ history: { archiveDoneAfterDays: 'x' } })).toBeNull();
    expect(QA.daysOf({})).toBeNull();
  });
});
