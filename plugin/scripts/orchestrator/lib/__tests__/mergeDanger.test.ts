// =============================================================
// mergeDanger.test.ts: the door and blast radius lines a track writes in its report (lib/mergeDanger.js, MS-1).
//
// Locks: (1) "Door: one-way / two-way" and "Blast radius: <one word>" are read from the report, then the reply, in the
// usual spellings (bold, a list dash, "one way", a short explanation after the word); (2) a missing or malformed line
// (the template copied as is, a placeholder, a sentence instead of one word) is null, shown as "not stated", never an
// error; (3) the reviewer's own call is read from its answer, and a disagreement is listed, not resolved; (4) the
// package section and the receive line say it is the track's call and never a guard.
// =============================================================
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const MD = require('../mergeDanger') as any;

describe('parse: the two lines in a report', () => {
  it('reads a plain door and blast radius', () => {
    expect(MD.parse('RESULT status=DONE\n\nDoor: one-way\nBlast radius: data\n')).toEqual({ door: 'one-way', blast: 'data' });
    expect(MD.parse('Door: two-way\nBlast radius: small')).toEqual({ door: 'two-way', blast: 'small' });
  });

  it('accepts the usual spellings', () => {
    expect(MD.parse('- **Door:** One way\n- **Blast radius:** `Module`.')).toEqual({ door: 'one-way', blast: 'module' });
    expect(MD.parse('* Door: two-way door\n* Blast-radius: local (one file)')).toEqual({ door: 'two-way', blast: 'local' });
    expect(MD.parse('Door: one-way, the column is dropped\nBlast radius: users - every login')).toEqual({ door: 'one-way', blast: 'users' });
  });

  it('a missing or malformed line is null, never an error', () => {
    expect(MD.parse('')).toEqual({ door: null, blast: null });
    expect(MD.parse(null)).toEqual({ door: null, blast: null });
    expect(MD.parse('Door: one-way / two-way\nBlast radius: <one word>')).toEqual({ door: null, blast: null });
    expect(MD.parse('Door: maybe\nBlast radius: the whole app')).toEqual({ door: null, blast: null });
    // Only at the start of a line: a sentence that mentions a door is not the line.
    expect(MD.parse('The back door: one-way street')).toEqual({ door: null, blast: null });
  });

  it('a very long word is not one word', () => {
    expect(MD.parse(`Blast radius: ${'a'.repeat(40)}`).blast).toBeNull();
  });
});

describe('fromTrack: report first, then the reply', () => {
  it('takes each line from the report, and a line the report lacks from the reply', () => {
    expect(MD.fromTrack({ report: 'Door: one-way', reply: 'Door: two-way\nBlast radius: small' })).toEqual({ door: 'one-way', blast: 'small' });
    expect(MD.fromTrack({ report: null, reply: null })).toEqual({ door: null, blast: null });
  });

  it('record keeps the two values and the time, nothing else', () => {
    const rec = MD.record(MD.fromTrack({ report: 'Door: one-way\nBlast radius: data' }), { at: '2026-11-22T10:00:00.000Z' });
    expect(rec).toEqual({ door: 'one-way', blast: 'data', at: '2026-11-22T10:00:00.000Z' });
  });
});

describe('the reviewer', () => {
  it('reads each reviewer that states a call, and leaves out one that states none', () => {
    const calls = MD.reviewerCalls([
      { type: 'reviewer', text: 'FINDINGS H=0 M=0 L=0\nDoor: two-way\nBlast radius: data' },
      { type: 'reviewer-security', text: 'FINDINGS H=0 M=0 L=0' },
    ]);
    expect(calls).toEqual([{ type: 'reviewer', door: 'two-way', blast: 'data' }]);
  });

  it('a disagreement is listed per field, never resolved', () => {
    const rec = { door: 'one-way', blast: 'data', reviewers: [{ type: 'reviewer', door: 'two-way', blast: 'data' }] };
    expect(MD.disagreements(rec)).toEqual([{ type: 'reviewer', field: 'door', track: 'one-way', reviewer: 'two-way' }]);
    // The stored values are untouched: code does not pick a side.
    expect(rec.door).toBe('one-way');
  });

  it('a reviewer call where the track stated none is a disagreement too', () => {
    const rec = { door: null, blast: null, reviewers: [{ type: 'reviewer-light', door: 'one-way', blast: null }] };
    expect(MD.disagreements(rec)).toEqual([{ type: 'reviewer-light', field: 'door', track: null, reviewer: 'one-way' }]);
  });

  it('agreement and no reviewer give none', () => {
    expect(MD.disagreements({ door: 'two-way', blast: 'small', reviewers: [{ type: 'reviewer', door: 'two-way', blast: 'small' }] })).toEqual([]);
    expect(MD.disagreements({ door: 'two-way', blast: 'small' })).toEqual([]);
    expect(MD.disagreements(null)).toEqual([]);
  });
});

describe('who is told to write the lines', () => {
  it('the mission template, both track agents and both main reviewers name both lines', () => {
    const plugin = path.resolve(__dirname, '..', '..', '..', '..');
    for (const f of ['docs/mission-template.md', 'agents/track.md', 'agents/track-d.md', 'agents/reviewer.md', 'agents/reviewer-light.md']) {
      const text = fs.readFileSync(path.join(plugin, f), 'utf8');
      expect(text, f).toMatch(/Door: one-way/);
      expect(text, f).toMatch(/Blast radius: <one word>/);
    }
  });
});

describe('what receive writes', () => {
  it('the package section has the two lines and says it is never a guard', () => {
    const lines = MD.packageSection({ door: 'one-way', blast: null }).join('\n');
    expect(lines).toMatch(/^## Door and blast radius/m);
    expect(lines).toMatch(/^- Door: one-way$/m);
    expect(lines).toMatch(/^- Blast radius: not stated$/m);
    expect(lines).toMatch(/never a guard/);
    expect(lines).toMatch(/Door: one-way\|two-way/);
  });

  it('the receive line names both, not stated where missing', () => {
    expect(MD.receiveLine('A-1', { door: 'one-way', blast: 'data' })).toBe(
      "DOOR: A-1: one-way door, blast radius data (the track's call; nothing is blocked or approved by it).",
    );
    expect(MD.receiveLine('A-1', { door: null, blast: null })).toMatch(/door not stated, blast radius not stated/);
  });
});
