// =============================================================
// queueSessionRows.test.ts: the queue-start and queue-idle time log rows (AW-5, plans/borte-flate-vurdering-2026-11-21.md).
//
// Why: the time log had no explicit "the owner started the queue" or "the queue went idle" row, so a session timeline
// had to guess its start and had no end. lib/eventRows.js queueSessionStep is the pure rule: start or fill opens a
// session once (queue-start), and a SILENT pulse with no running track closes it once (queue-idle, with how long it
// ran). Everything else writes nothing, so a fill every few minutes gives one row, not hundreds.
// =============================================================
import { describe, expect, it } from 'vitest';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const ER = require('../eventRows.js') as any;
/* eslint-enable @typescript-eslint/no-require-imports */

const T0 = '2026-11-21T20:00:00.000Z';
const T1 = '2026-11-21T23:30:00.000Z';

describe('queueSessionStep', () => {
  it('start or fill with no open session writes one queue-start row and opens the session', () => {
    const r = ER.queueSessionStep(null, { kind: 'active', command: 'fill', running: 0, time: T0 });
    expect(r.row).toEqual({ time: T0, event: 'queue-start', command: 'fill', running: 0 });
    expect(r.next).toEqual({ open: true, since: T0 });
  });

  it('a second fill while the session is open writes nothing', () => {
    const r = ER.queueSessionStep({ open: true, since: T0 }, { kind: 'active', command: 'start', running: 2, time: T1 });
    expect(r.row).toBeNull();
    expect(r.next).toEqual({ open: true, since: T0 });
  });

  it('a quiet pulse with nothing running closes the open session with its length', () => {
    const r = ER.queueSessionStep({ open: true, since: T0 }, { kind: 'quiet', running: 0, time: T1 });
    expect(r.row).toEqual({ time: T1, event: 'queue-idle', since: T0, duration_s: 3.5 * 3600 });
    expect(r.next).toEqual({ open: false, since: T1 });
  });

  it('a quiet pulse while a track runs, or with no open session, writes nothing', () => {
    expect(ER.queueSessionStep({ open: true, since: T0 }, { kind: 'quiet', running: 1, time: T1 }).row).toBeNull();
    expect(ER.queueSessionStep(null, { kind: 'quiet', running: 0, time: T1 }).row).toBeNull();
    expect(ER.queueSessionStep({ open: false, since: T0 }, { kind: 'quiet', running: 0, time: T1 }).row).toBeNull();
  });

  it('a broken state file counts as no open session, and an unknown kind writes nothing', () => {
    expect(ER.queueSessionStep('junk', { kind: 'active', command: 'fill', running: 0, time: T0 }).row?.event).toBe('queue-start');
    expect(ER.queueSessionStep({ open: true, since: T0 }, { kind: 'other', running: 0, time: T1 }).row).toBeNull();
  });

  it('the two names are time log events', () => {
    expect(ER.EVENTS.has('queue-start')).toBe(true);
    expect(ER.EVENTS.has('queue-idle')).toBe(true);
  });
});
