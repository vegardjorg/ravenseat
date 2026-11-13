// =============================================================
// inspection.test.ts: the inspection queue (lib/inspection.js): failures that repeat become ONE proposal to the owner.
//
// Locks: (1) one entry per signature with count, incidents, first/last seen, sources and example tasks; (2) the threshold
// counts incidents (a task's reruns of the same red gate are one) within the window; (3) an entry over it is due once,
// becomes proposed, and follows its task (approved, built, rejected); (4) a rejected entry stays rejected until its
// incidents double; (5) snooze holds it until the date; (6) at most MAX_OPEN proposals at a time; (7) the proposal task
// is a proposal (never approved), names the signature, and asks for a guard or nothing; (8) the settings.
// =============================================================
import { describe, expect, it } from 'vitest';

/* eslint-disable @typescript-eslint/no-require-imports */
const I = require('../inspection');
const FS = require('../failureSignature');
/* eslint-enable @typescript-eslint/no-require-imports */

const NOW = Date.parse('2026-11-13T12:00:00Z');
const day = (n: number) => new Date(NOW - n * 86_400_000).toISOString();
const SETUP = I.setupOf({});

/** A red gate row as gates.mjs writes it. */
const red = (track: string | null, daysAgo: number, command = 'npm run scan', excerpt = 'Error: leaks found: <n>') => ({
  time: day(daysAgo),
  event: 'gate',
  track,
  branch: track ? `queue/${track}` : 'main',
  kind: 'full',
  gates: [command],
  failed: [command],
  errors: { [command]: excerpt },
});
const occ = (rows: object[]) => FS.occurrences(rows);
const scan = (state: unknown, rows: object[], tasks: object[] = [], o: Record<string, unknown> = {}) =>
  I.scan(state, { occurrences: occ(rows), tasks, now: NOW, setup: SETUP, ...o });

describe('the settings', () => {
  it('defaults: on, 2 repeats, 30 days; off and own values are read', () => {
    expect(I.DEFAULTS).toEqual({ mode: 'on', minRepeats: 2, windowDays: 30 });
    expect(SETUP).toMatchObject({ mode: 'on', enabled: true, minRepeats: 2, windowDays: 30 });
    expect(I.setupOf({ inspection: { mode: 'off', minRepeats: 4, windowDays: 7 } })).toMatchObject({ enabled: false, minRepeats: 4, windowDays: 7 });
    // Nonsense falls back to the default.
    expect(I.setupOf({ inspection: { minRepeats: 0, windowDays: 'x' } })).toMatchObject({ minRepeats: 2, windowDays: 30 });
  });
});

describe('one entry per signature', () => {
  it('count, incidents, first and last seen, sources and example tasks', () => {
    const rows = [red('A-1', 10), red('A-1', 9), red('B-2', 3)];
    const { state } = scan(null, rows);
    const entries = Object.values(state.entries) as Record<string, unknown>[];
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      name: 'npm run scan',
      excerpt: 'Error: leaks found: <n>',
      count: 3,
      incidents: 2,
      firstSeen: day(10),
      lastSeen: day(3),
      sources: ['gate'],
      tasks: ['B-2', 'A-1'],
    });
  });

  it('the same failure from a gate and from CI is one entry with both sources only when name and excerpt match; others stay apart', () => {
    const rows = [red('A-1', 2), red('A-2', 2, 'npm test', 'FAIL src/a.test.ts'), { time: day(1), event: 'ciWatch', sha: 'abc1234', verdict: 'check', task: 'CI-abc1234', failures: [{ name: 'npm run scan', excerpt: 'Error: leaks found: <n>' }] }];
    const { state } = scan(null, rows);
    const byName = Object.fromEntries((Object.values(state.entries) as { name: string; sources: string[] }[]).map((e) => [e.name, e]));
    expect(byName['npm run scan'].sources).toEqual(['ci', 'gate']);
    expect(byName['npm test'].sources).toEqual(['gate']);
  });

  it('only the window counts', () => {
    const { state } = scan(null, [red('A-1', 40), red('B-2', 35), red('C-3', 1)]);
    expect(Object.values(state.entries)[0]).toMatchObject({ count: 1, incidents: 1 });
  });
});

describe('the threshold and the proposal', () => {
  it('reruns in one task are one incident: not due; a second task makes it due', () => {
    let r = scan(null, [red('A-1', 5), red('A-1', 5), red('A-1', 4)]);
    expect(r.due).toEqual([]);
    expect((Object.values(r.state.entries)[0] as { status: string }).status).toBe('watching');
    r = scan(r.state, [red('A-1', 5), red('B-2', 1)]);
    expect(r.due.map((e: { name: string }) => e.name)).toEqual(['npm run scan']);
  });

  it('due once: after the proposal is recorded it is not due again, and it follows its task', () => {
    const rows = [red('A-1', 5), red('B-2', 1)];
    let r = scan(null, rows);
    const id = r.due[0].id;
    I.recordProposal(r.state, id, 'INSP-1', day(0));
    r = scan(r.state, rows, [{ id: 'INSP-1', status: 'proposed' }]);
    expect(r.due).toEqual([]);
    expect(r.state.entries[id]).toMatchObject({ status: 'proposed', proposal: 'INSP-1' });
    r = scan(r.state, rows, [{ id: 'INSP-1', status: 'waiting' }]);
    expect(r.state.entries[id].status).toBe('approved');
    r = scan(r.state, rows, [{ id: 'INSP-1', status: 'done' }]);
    expect(r.state.entries[id].status).toBe('built');
    // An archived task counts too.
    r = scan(r.state, rows, [], { archived: { 'INSP-1': { status: 'done' } } });
    expect(r.state.entries[id].status).toBe('built');
  });

  it('a rejected entry stays rejected until its incidents double', () => {
    const two = [red('A-1', 5), red('B-2', 4)];
    let r = scan(null, two);
    const id = r.due[0].id;
    I.recordProposal(r.state, id, 'INSP-1', day(4));
    r = scan(r.state, two, [{ id: 'INSP-1', status: 'cancelled' }]);
    expect(r.state.entries[id]).toMatchObject({ status: 'rejected', rejectedAtIncidents: 2 });
    expect(r.due).toEqual([]);
    const three = [...two, red('C-3', 2)];
    r = scan(r.state, three, [{ id: 'INSP-1', status: 'cancelled' }]);
    expect(r.state.entries[id].status).toBe('rejected');
    expect(r.due).toEqual([]);
    const four = [...three, red('D-4', 1)];
    r = scan(r.state, four, [{ id: 'INSP-1', status: 'cancelled' }]);
    expect(r.due.map((e: { id: string }) => e.id)).toEqual([id]);
    // Not proposed yet (no free slot, say): the old cancelled task does not reject it again on the next scan.
    r = scan(r.state, four, [{ id: 'INSP-1', status: 'cancelled' }]);
    expect(r.state.entries[id].status).toBe('due');
  });

  it('snooze: cancelled with a date is snoozed, not rejected, and due again after the date', () => {
    const rows = [red('A-1', 5), red('B-2', 4)];
    let r = scan(null, rows);
    const id = r.due[0].id;
    I.recordProposal(r.state, id, 'INSP-1', day(4));
    const s = I.snooze(r.state, 'INSP-1', { now: NOW, days: 7 });
    expect(s).toMatchObject({ id, proposal: 'INSP-1' });
    r = scan(r.state, rows, [{ id: 'INSP-1', status: 'cancelled' }]);
    expect(r.state.entries[id].status).toBe('snoozed');
    expect(r.due).toEqual([]);
    r = scan(r.state, rows, [{ id: 'INSP-1', status: 'cancelled' }], { now: NOW + 8 * 86_400_000 });
    expect(r.due.map((e: { id: string }) => e.id)).toEqual([id]);
    // By signature id too, and unknown ids are an error.
    expect(I.snooze(r.state, id, { now: NOW, days: 3 })).toMatchObject({ id });
    expect(I.snooze(r.state, 'nothing', { now: NOW })).toHaveProperty('error');
  });

  it(`at most ${3} open proposals at a time, the most incidents first`, () => {
    expect(I.MAX_OPEN).toBe(3);
    const rows = ['a', 'b', 'c', 'd', 'e'].flatMap((x, i) =>
      Array.from({ length: 2 + i }, (_, k) => red(`${x.toUpperCase()}-${k}`, 2, `check-${x}`)),
    );
    let r = scan(null, rows);
    expect(r.due.map((e: { name: string }) => e.name)).toEqual(['check-e', 'check-d', 'check-c']);
    I.recordProposal(r.state, r.due[0].id, 'INSP-1', day(0));
    r = scan(r.state, rows, [{ id: 'INSP-1', status: 'proposed' }]);
    expect(r.due.map((e: { name: string }) => e.name)).toEqual(['check-d', 'check-c']);
  });

  it('minRepeats and windowDays come from the setup', () => {
    const rows = [red('A-1', 5), red('B-2', 4)];
    expect(scan(null, rows, [], { setup: I.setupOf({ inspection: { minRepeats: 3 } }) }).due).toEqual([]);
    expect(scan(null, rows, [], { setup: I.setupOf({ inspection: { windowDays: 4 } }) }).due).toEqual([]);
  });
});

describe('the proposal task', () => {
  const entry = { id: 'abc123def456', name: 'npm run scan', excerpt: 'Error: leaks found: <n>', count: 13, incidents: 9, sources: ['ci', 'gate'], tasks: ['A-1', 'B-2'], firstSeen: day(20), lastSeen: day(1) };

  it('a proposal (added_by inspection, never approved here) that names the failure and asks for a guard or nothing', () => {
    const t = I.proposalTask({ id: 'INSP-1', entry, cli: 'ravenseat', lite: false, registryFile: '.ravenseat/guards.json' });
    expect(t).toMatchObject({ id: 'INSP-1', class: 'K', added_by: 'inspection agent', labels: ['guard', 'inspection'], batched: true, source: 'inspection abc123def456' });
    expect(t.title).toContain('npm run scan');
    expect(t.title).toContain('9');
    expect(t.owned_files).toEqual(['.ravenseat/guards.json']);
    for (const s of ['Error: leaks found: <n>', 'gate', 'instruction', 'nothing', 'ravenseat guards add --from-task INSP-1', 'A-1'])
      expect(t.mission, s).toContain(s);
    expect(t).not.toHaveProperty('approved');
    expect(t).not.toHaveProperty('status');
    // Lite has no batch queue.
    expect(I.proposalTask({ id: 'INSP-1', entry, cli: 'ravenseat', lite: true, registryFile: 'g.json' })).not.toHaveProperty('batched');
  });

  it('the next free INSP-<n>', () => {
    expect(I.nextId([])).toBe('INSP-1');
    expect(I.nextId([{ id: 'INSP-2' }, { id: 'A-9' }, { id: 'INSP-10' }])).toBe('INSP-11');
  });
});

describe('the lines and the board data', () => {
  it('open entries with count and last seen; built entries without a registry entry say how to add one', () => {
    const rows = [red('A-1', 5), red('B-2', 1)];
    const r = scan(null, rows);
    const id = r.due[0].id;
    I.recordProposal(r.state, id, 'INSP-1', day(0));
    const built = scan(r.state, rows, [{ id: 'INSP-1', status: 'done' }]).state;
    const lines = I.lines(built, { setup: SETUP, registry: { guards: [] }, cli: 'ravenseat' }).join('\n');
    expect(lines).toContain('npm run scan');
    expect(lines).toContain('built by INSP-1');
    expect(lines).toContain('ravenseat guards add --from-task INSP-1');
    const withEntry = I.lines(built, { setup: SETUP, registry: { guards: [{ id: 'G-1', task: 'INSP-1' }] }, cli: 'ravenseat' }).join('\n');
    expect(withEntry).not.toContain('guards add --from-task INSP-1');
    const board = I.boardData(built, { registry: { guards: [] } });
    expect(board.entries[0]).toMatchObject({ name: 'npm run scan', count: 2, incidents: 2, status: 'built', proposal: 'INSP-1', unregistered: true });
    expect(I.lines(null, { setup: I.setupOf({ inspection: { mode: 'off' } }), cli: 'ravenseat' }).join('\n')).toContain('off');
  });
});
