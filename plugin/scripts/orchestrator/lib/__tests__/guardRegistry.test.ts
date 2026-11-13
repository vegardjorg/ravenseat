// =============================================================
// guardRegistry.test.ts: the guard registry (lib/guardRegistry.js), the tracked list of the guards a project has built.
//
// Locks: (1) the entry shape: id, title, a one-sentence explanation, kind, what it guards against, task, date, status and
// a `measures` object; (2) validation (kind, one line, something it guards against); (3) entries from an inspection
// task; (4) retire keeps the entry; (5) measures for a gate whose command the gate rows know: red runs, caught since it
// was built, last red, without writing them to the file; (6) the file text is stable (2-space JSON, LF) and unknown
// fields survive a round trip, so later measures need no migration.
// =============================================================
import { describe, expect, it } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const GR = require('../guardRegistry');

const NOW = '2026-11-13T12:00:00.000Z';
const base = { title: 'Secret scan before commit', explain: 'Stops a key in a config file before it reaches CI.', kind: 'gate', command: 'npm run scan', against: { signature: 'abc123def456' } };

describe('adding and validating', () => {
  it('the entry has every field, with measures reserved', () => {
    const reg = GR.empty();
    const r = GR.addGuard(reg, { ...base, task: 'INSP-1' }, { now: NOW });
    expect(r.error).toEqual([]);
    expect(reg.guards).toEqual([
      {
        id: 'G-1',
        title: 'Secret scan before commit',
        explain: 'Stops a key in a config file before it reaches CI.',
        kind: 'gate',
        against: { signature: 'abc123def456', lesson: null },
        command: 'npm run scan',
        task: 'INSP-1',
        built: '2026-11-13',
        status: 'active',
        measures: { runs: null, redRuns: null, caughtSince: null, lastRed: null },
      },
    ]);
    expect(GR.addGuard(reg, { title: 'Ask before a schema change', explain: 'A lesson from a review.', kind: 'instruction', against: { lesson: 'two migrations with the same number' } }, { now: NOW }).guard.id).toBe('G-2');
  });

  it('refuses an unknown kind, a multi-line text, nothing to guard against, and a second entry for the same task', () => {
    const reg = GR.empty();
    expect(GR.addGuard(reg, { ...base, kind: 'magic' }, { now: NOW }).error.join(' ')).toContain('kind');
    expect(GR.addGuard(reg, { ...base, explain: 'one.\ntwo.' }, { now: NOW }).error.join(' ')).toContain('one line');
    expect(GR.addGuard(reg, { ...base, title: '' }, { now: NOW }).error.join(' ')).toContain('title');
    expect(GR.addGuard(reg, { ...base, against: {} }, { now: NOW }).error.join(' ')).toContain('against');
    expect(GR.addGuard(reg, { ...base, task: 'INSP-1' }, { now: NOW }).error).toEqual([]);
    expect(GR.addGuard(reg, { ...base, task: 'INSP-1' }, { now: NOW }).error.join(' ')).toContain('INSP-1');
    expect(GR.KINDS).toEqual(['gate', 'instruction', 'review', 'none']);
  });

  it('from an inspection task: the title, the signature and the lesson are filled in', () => {
    const entry = { id: 'abc123def456', name: 'npm run scan', excerpt: 'Error: leaks found: <n>' };
    const input = GR.fromTask({ task: { id: 'INSP-1', title: 'Guard: npm run scan failed 9 times the same way' }, entry });
    expect(input).toMatchObject({ task: 'INSP-1', title: 'npm run scan failed 9 times the same way', against: { signature: 'abc123def456', lesson: 'npm run scan: Error: leaks found: <n>' } });
  });

  it('retire keeps the entry with status retired', () => {
    const reg = GR.empty();
    GR.addGuard(reg, base, { now: NOW });
    expect(GR.retire(reg, 'G-1')).toBe(null);
    expect(reg.guards[0].status).toBe('retired');
    expect(GR.retire(reg, 'G-9')).toContain('G-9');
  });
});

describe('the file', () => {
  it('parses and writes stable text; unknown fields survive; a broken file is an error, not an empty list', () => {
    const reg = GR.empty();
    GR.addGuard(reg, base, { now: NOW });
    reg.guards[0].measures.sabotage = 'CATCHES';
    reg.guards[0].note = 'kept';
    const text = GR.serialize(reg);
    expect(text.endsWith('}\n')).toBe(true);
    expect(text).not.toContain('\r');
    expect(text).toContain('\n  "guards": [');
    const back = GR.parse(text);
    expect(back.error).toBe(null);
    expect(back.registry.guards[0]).toMatchObject({ note: 'kept', measures: { sabotage: 'CATCHES' } });
    expect(GR.parse('{ nope').error).toBeTruthy();
    expect(GR.parse(null)).toEqual({ registry: GR.empty(), error: null });
  });
});

describe('measures from the gate rows', () => {
  const row = (time: string, failed: boolean, command = 'npm run scan') => ({ time, event: 'gate', gates: [command, 'npm test'], failed: failed ? [command] : [] });
  const rows = [
    row('2026-11-01T10:00:00Z', true),
    row('2026-11-12T09:00:00Z', false),
    row('2026-11-13T13:00:00Z', true),
    row('2026-11-14T09:00:00Z', true),
    row('2026-11-14T10:00:00Z', false),
    row('2026-11-14T11:00:00Z', true, 'npm run other'),
  ];

  it('a gate entry with a command: runs and red runs since it was built, all red runs, the last red', () => {
    const reg = GR.empty();
    GR.addGuard(reg, base, { now: NOW });
    GR.addGuard(reg, { ...base, kind: 'instruction', command: undefined, title: 'A rule' }, { now: NOW });
    const [gate, rule] = GR.withMeasures(reg, rows);
    expect(gate.measures).toEqual({ runs: 3, redRuns: 3, caughtSince: 2, lastRed: '2026-11-14T09:00:00Z' });
    expect(rule.measures).toEqual({ runs: null, redRuns: null, caughtSince: null, lastRed: null });
    // The registry itself is not changed (the measures are never written back).
    expect(reg.guards[0].measures.redRuns).toBe(null);
  });

  it('the lines and the board data say "caught N times since built"', () => {
    const reg = GR.empty();
    GR.addGuard(reg, { ...base, task: 'INSP-1' }, { now: NOW });
    const text = GR.lines(reg, rows, { cli: 'ravenseat' }).join('\n');
    expect(text).toContain('G-1');
    expect(text).toContain('[gate]');
    expect(text).toContain('built 2026-11-13 by INSP-1');
    expect(text).toContain('Stops a key in a config file before it reaches CI.');
    expect(text).toContain('caught 2 times since built');
    expect(GR.lines(GR.empty(), [], { cli: 'ravenseat' }).join('\n')).toContain('ravenseat guards add');
    expect(GR.boardData(reg, rows).guards[0]).toMatchObject({ id: 'G-1', kind: 'gate', task: 'INSP-1', measures: { caughtSince: 2 } });
  });
});
