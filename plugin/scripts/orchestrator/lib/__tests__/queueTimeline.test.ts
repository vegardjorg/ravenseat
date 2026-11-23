// =============================================================
// queueTimeline.test.ts: the server side of the board's Timeline tab (roadmap TIDSLINJE T-A;
// plans/gantt-utredning-2026-11-18.md, section 6).
//
// Locks: (1) the settings: board.timeline on in full and off in lite (unless the file sets it), the horizon 3 days
// (clamped 1 to 14), rows by focus step or project, each with a registry row in Board that weakens nothing; (2) the
// payload: the schedule from queueSchedule as it is, the tasks done in the last day with their track and review times,
// the project of every task and the register's titles; (3) read-only: the queue it is given is unchanged; (4) the
// cache key changes with the queue's bytes, the settings and the minute.
// =============================================================
import { describe, expect, it } from 'vitest';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const KK = require('../queueConfig.js') as any;
const R = require('../settingsRegistry.js') as any;
const QT = require('../queueTimeline.js') as any;
const SC = require('../queueSchedule.js') as any;
/* eslint-enable @typescript-eslint/no-require-imports */

const resolved = (own: object) => KK.resolveOwn(KK.merge(KK.STANDARD, own), own);
const H = 3_600_000;
const NOW = Date.UTC(2026, 10, 22, 12, 0);
const iso = (ms: number) => new Date(ms).toISOString();

describe('the settings', () => {
  it('STANDARD: the tab on, 3 days, rows by focus step', () => {
    expect(KK.STANDARD.board.timeline).toBe(true);
    expect(KK.STANDARD.board.timelineHorizonDays).toBe(3);
    expect(KK.STANDARD.board.timelineRows).toBe('step');
    expect(KK.boardTimeline(resolved({}))).toEqual({ on: true, horizonDays: 3, rows: 'step', drag: true, dragPreview: true });
  });
  it('lite turns the tab off unless the file sets it', () => {
    expect(KK.boardTimeline(resolved({ mode: 'lite' })).on).toBe(false);
    expect(KK.boardTimeline(resolved({ mode: 'lite', board: { timeline: true } })).on).toBe(true);
  });
  it('the horizon is clamped to 1..14 and a wrong value falls back; rows only step or project', () => {
    expect(KK.boardTimeline(resolved({ board: { timelineHorizonDays: 0 } })).horizonDays).toBe(1);
    expect(KK.boardTimeline(resolved({ board: { timelineHorizonDays: 99 } })).horizonDays).toBe(14);
    expect(KK.boardTimeline(resolved({ board: { timelineHorizonDays: 'x' } })).horizonDays).toBe(3);
    expect(KK.boardTimeline(resolved({ board: { timelineRows: 'project' } })).rows).toBe('project');
    expect(KK.boardTimeline(resolved({ board: { timelineRows: 'area' } })).rows).toBe('step');
    expect(KK.boardTimeline(null)).toEqual({ on: true, horizonDays: 3, rows: 'step', drag: true, dragPreview: true });
  });
  it('each has a registry row in Board that weakens nothing', () => {
    const tab = R.rowFor('board.timeline');
    expect(tab.category).toBe('board');
    expect(tab.type).toBe('onoff');
    expect(tab.defaultByMode).toEqual({ lite: false, full: true });
    expect(tab.weakens).toBeNull();
    const h = R.rowFor('board.timelineHorizonDays');
    expect(h.type).toBe('integer');
    expect(h.weakens).toBeNull();
    const rows = R.rowFor('board.timelineRows');
    expect(rows.type).toBe('choice');
    expect(rows.choices).toEqual(['step', 'project']);
    expect(rows.weakens).toBeNull();
  });
});

const task = (id: string, extra: object) => ({
  id,
  title: `Task ${id}`,
  domain: id,
  class: 'K',
  value: 5,
  content_min: 60,
  status: 'waiting',
  depends_on: [],
  waiting_on: [],
  owned_files: [`f/${id}.ts`],
  added_by: 'test',
  added_at: iso(NOW - 48 * H),
  ...extra,
});
const queue = () => ({
  created: iso(NOW - 72 * H),
  limits: { maxConcurrent: 2 },
  projects: { ex: { title: 'Example', prefixes: ['EX-'] }, ot: { title: 'Other', prefixes: ['OT-'] } },
  tasks: [
    task('EX-1', {}),
    task('OT-1', { status: 'running', started: iso(NOW - H) }),
    task('EX-2', { status: 'done', started: iso(NOW - 6 * H), delivered: iso(NOW - 4 * H), done: iso(NOW - 3 * H) }),
    task('EX-3', { status: 'done', started: iso(NOW - 60 * H), done: iso(NOW - 50 * H) }),
    task('EX-4', { status: 'cancelled', started: iso(NOW - 5 * H), done: iso(NOW - 2 * H) }),
    task('EX-5', { status: 'done', project: 'ot', started: iso(NOW - 2 * H), done: iso(NOW - H) }),
  ],
});

describe('the payload', () => {
  it('the schedule as queueSchedule gives it, unchanged', () => {
    const q = queue();
    const d = QT.timelineData(q, { now: NOW });
    expect(d.schedule).toEqual(SC.schedule(queue(), { now: NOW }));
  });
  it('ran: the tasks done in the last day, with start, delivered and end; not cancelled, not older', () => {
    const d = QT.timelineData(queue(), { now: NOW });
    expect(d.ran.map((r: any) => r.id)).toEqual(['EX-2', 'EX-5']);
    expect(d.ran[0]).toEqual({ id: 'EX-2', title: 'Task EX-2', class: 'K', start: iso(NOW - 6 * H), delivered: iso(NOW - 4 * H), end: iso(NOW - 3 * H) });
    expect(d.ran[1].delivered).toBe(null);
  });
  it('the project of every task, by the register, and the titles', () => {
    const d = QT.timelineData(queue(), { now: NOW });
    expect(d.projects['EX-1']).toBe('ex');
    expect(d.projects['OT-1']).toBe('ot');
    expect(d.projects['EX-5']).toBe('ot');
    expect(d.projectTitles).toEqual({ ex: 'Example', ot: 'Other' });
    expect(d.titles['EX-1']).toBe('Task EX-1');
  });
  it('read-only: the queue it is given is unchanged', () => {
    const q = queue();
    const before = JSON.stringify(q);
    QT.timelineData(q, { now: NOW });
    expect(JSON.stringify(q)).toBe(before);
  });
  it('the cache key follows the queue bytes, the settings and the minute', () => {
    const k = (over: any = {}) => QT.cacheKey({ queueStamp: 'a:1', settings: { on: true, horizonDays: 3, rows: 'step' }, now: NOW, ...over });
    expect(k()).toBe(k({ now: NOW + 20_000 }));
    expect(k()).not.toBe(k({ now: NOW + 61_000 }));
    expect(k()).not.toBe(k({ queueStamp: 'a:2' }));
    expect(k()).not.toBe(k({ settings: { on: true, horizonDays: 4, rows: 'step' } }));
  });
});
