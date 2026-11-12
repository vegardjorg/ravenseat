// =============================================================
// ownerLog.test.ts: the owner rows a task relies on and the owner log they are confirmed against (lib/ownerLog.js,
// owner decision B2).
//
// Locks: (1) the rows of a task are the changelog entries and undos by the owner that touch it, the owner's answers in
// `resumed`, the resolutions by the owner of its questions, a hand approval and an add by the owner, never an agent's
// or the orchestrator's own writes; (2) a write through the queue CLI records the rows it added, and a row that appears
// in queue.json without one (a forged row) is missing; (3) the first use records every row there is (the baseline), as
// the git surface baseline does; (4) accept records the missing rows of one task; (5) a row's key changes when its
// content does, so an edited answer is a new row; (6) a track worktree records nothing.
// =============================================================
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const OL = require('../ownerLog.js');

const temporary: string[] = [];
afterAll(() => {
  for (const m of temporary) fs.rmSync(m, { recursive: true, force: true });
});
const folder = () => {
  const f = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-owner-log-'));
  temporary.push(f);
  return f;
};

type Q = Record<string, unknown> & { tasks: Record<string, unknown>[] };
const base = (): Q => ({
  tasks: [{ id: 'A', status: 'running', waiting_on: ['q-A'] }, { id: 'B', status: 'running' }],
  changelog: [],
  resolutions: {},
});

describe('the owner rows of a task', () => {
  it('owner changelog entries, undos, answers, resolutions, a hand approval and an owner add', () => {
    const q = base();
    q.changelog = [
      { nr: 1, at: 't1', by: 'owner', action: 'edit', changes: [{ id: 'A', field: 'value', before: 5, after: 6 }] },
      { nr: 2, at: 't2', by: 'theBoard', action: 'edit', changes: [{ id: 'A', field: 'owned_files', before: [], after: ['x'] }], undone: { at: 't3', by: 'owner' } },
      { nr: 3, at: 't4', by: 'ravenseat', action: 'edit', changes: [{ id: 'A', field: 'value', before: 6, after: 7 }] },
      { nr: 4, at: 't5', by: 'owner', action: 'edit', changes: [{ id: 'B', field: 'value', before: 5, after: 6 }] },
    ];
    q.resolutions = { 'q-A': { time: 't6', by: 'owner', answer: 'yes' }, 'A.fixcap4': { time: 't7', by: 'owner' }, 'q-B': { time: 't8', by: 'owner' } };
    Object.assign(q.tasks[0], {
      resumed: [{ answer: 'go', answered_at: 't9', by: 'owner' }, { answer: 'self', answered_at: 't10', by: 'A' }],
      approved: 't11',
      added_by: 'owner',
    });
    const kinds = OL.rowsOf(q, 'A').map((r: { kind: string }) => r.kind).sort();
    expect(kinds).toEqual(['added', 'answer', 'approved', 'changelog', 'changelog', 'resolution', 'resolution', 'undo']);
    // B's own rows are not A's.
    expect(OL.rowsOf(q, 'B').map((r: { kind: string }) => r.kind)).toEqual(['changelog']);
    // The labels never hold an answer's text.
    expect(JSON.stringify(OL.rowsOf(q, 'A').map((r: { label: string }) => r.label))).not.toMatch(/yes|"go"/);
  });

  it('an auto-accepted approval is not an owner row', () => {
    const q = base();
    Object.assign(q.tasks[0], { approved: 't1' });
    q.auto_accepted = [{ id: 'A', at: 't1' }];
    expect(OL.rowsOf(q, 'A')).toEqual([]);
  });

  it('the key follows the content: an edited answer is a new row', () => {
    const q = base();
    q.resolutions = { 'q-A': { time: 't6', by: 'owner', answer: 'yes' } };
    const before = OL.rowsOf(q, 'A')[0].key;
    (q.resolutions as Record<string, { answer: string }>)['q-A'].answer = 'no';
    expect(OL.rowsOf(q, 'A')[0].key).not.toBe(before);
  });
});

describe('the owner log', () => {
  it('the first use records every row (baseline); a write records what it added; a forged row is missing', () => {
    const f = folder();
    const q = base();
    q.resolutions = { 'q-A': { time: 't1', by: 'owner' } };
    // First use: the baseline, nothing missing.
    expect(OL.check(f, q, 'A')).toMatchObject({ baseline: true, missing: [] });
    expect(fs.existsSync(path.join(f, OL.FILE_NAME))).toBe(true);
    // A write through the CLI: the row it added is recorded.
    const before = OL.keySet(q);
    (q.changelog as unknown[]).push({ nr: 1, at: 't2', by: 'owner', action: 'edit', changes: [{ id: 'A', field: 'value', before: 5, after: 6 }] });
    expect(OL.recordWrite(f, { before, after: q })).toMatchObject({ recorded: 1 });
    expect(OL.check(f, q, 'A')).toMatchObject({ baseline: false, missing: [] });
    // A row written straight into queue.json (no CLI write recorded it).
    (q.changelog as unknown[]).push({ nr: 2, at: 't3', by: 'owner', action: 'edit', changes: [{ id: 'A', field: 'owned_files', before: [], after: ['.claude/x'] }] });
    const missing = OL.check(f, q, 'A').missing;
    expect(missing.map((r: { label: string }) => r.label)).toEqual(['changelog #2 (edit by owner)']);
    // A later CLI write does not record it either: it was already there when that write read the queue.
    const again = OL.keySet(q);
    expect(OL.recordWrite(f, { before: again, after: q })).toMatchObject({ recorded: 0 });
    expect(OL.check(f, q, 'A').missing).toHaveLength(1);
    // accept records the missing rows of the task.
    expect(OL.accept(f, q, 'A', 'owner')).toMatchObject({ ok: true, accepted: 1 });
    expect(OL.check(f, q, 'A').missing).toEqual([]);
  });

  it('a write from a track worktree records nothing', () => {
    const f = folder();
    const q = base();
    OL.check(f, q, 'A');
    const before = OL.keySet(q);
    q.resolutions = { 'q-A': { time: 't1', by: 'owner' } };
    expect(OL.recordWrite(f, { before, after: q, inTrack: true })).toMatchObject({ recorded: 0 });
    expect(OL.check(f, q, 'A').missing).toHaveLength(1);
  });

  it('a broken log file reads as an empty log that is not missing (no new baseline over it)', () => {
    const f = folder();
    fs.writeFileSync(path.join(f, OL.FILE_NAME), '{ not json');
    const q = base();
    q.resolutions = { 'q-A': { time: 't1', by: 'owner' } };
    expect(OL.check(f, q, 'A')).toMatchObject({ baseline: false });
    expect(OL.check(f, q, 'A').missing).toHaveLength(1);
  });

  it('the stop text names the rows, the accept command and that nothing changed', () => {
    const text = OL.stopMessage({ id: 'A', missing: [{ label: 'changelog #2 (edit by owner)' }], ravenseat: 'ravenseat', again: 'ravenseat receive A', file: '/x/owner-log.json' });
    expect(text).toContain('changelog #2 (edit by owner)');
    expect(text).toContain('ravenseat owner-log accept A --by owner');
    expect(text).toContain('Nothing changed');
    expect(text).not.toMatch(/[–—]/);
  });
});
