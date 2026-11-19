// =============================================================
// taskDescription.test.ts: the task's short, human-written summary (`description`, roadmap 2c4) in its pure parts.
//
// What the tests prove:
//   - descriptionValue: text is trimmed, an empty or missing one means "no description", anything that is not text
//     is an error (the panel and info only ever get a string);
//   - the soft limit: up to 320 characters gives no warning, longer gives ONE WARNING line that says it was saved;
//   - validate (the check add and edit run) refuses a description that is not text, and takes a line break, as it
//     does for the title;
//   - info shows the description, the plan entry, the task's own sources with their roles and anchors, and the
//     origin `source` (0p2 B5);
//   - the board's edit form takes a description, and an emptied one removes it;
//   - panelFields (the /api/task addition) gives the description and the task's own sources, normalised by
//     taskLinks, never the plan entry's sources and never a path outside the project.
// =============================================================
import { describe, it, expect } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const D = require('../taskDescription.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const L = require('../queueLogic.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const TE = require('../queueTaskEdit.js');

const task = (extra: Record<string, unknown> = {}) => ({
  id: 'A-1',
  title: 'Task A-1',
  domain: 'ui',
  class: 'K',
  mission: 'The mission.',
  status: 'waiting',
  ...extra,
});

describe('descriptionValue', () => {
  it('trims text; empty, blank or missing means no description', () => {
    expect(D.descriptionValue('  Short summary.  ')).toEqual({ value: 'Short summary.', error: null });
    for (const v of ['', '   ', null, undefined]) expect(D.descriptionValue(v)).toEqual({ value: null, error: null });
  });

  it('refuses anything that is not text', () => {
    for (const v of [42, true, ['a'], { a: 1 }]) expect(D.descriptionValue(v).error).toBe('description must be text');
  });
});

describe('the soft limit of 320 characters', () => {
  it('is the same number as the panel summary', () => {
    expect(D.DESCRIPTION_SOFT_MAX).toBe(320);
  });

  it('no warning up to 320 characters, one WARNING line above it', () => {
    expect(D.descriptionWarning('A-1', 'x'.repeat(320))).toBeNull();
    expect(D.descriptionWarning('A-1', null)).toBeNull();
    expect(D.descriptionWarning('A-1', 'x'.repeat(321))).toBe(
      'WARNING: A-1: the description is 321 characters, over the soft limit of 320; it was saved anyway. ' +
        'Keep it to a short summary; the mission holds the detail.',
    );
  });

  it('counts characters, not UTF-16 units (an emoji or æøå is one)', () => {
    expect(D.descriptionWarning('A-1', 'å'.repeat(320))).toBeNull();
    expect(D.descriptionWarning('A-1', '\u{1F600}'.repeat(320))).toBeNull();
  });
});

describe('validate', () => {
  it('refuses a description that is not text; takes text, null and a line break (as the title does)', () => {
    expect(L.validate(task({ description: 42 }))).toContain('description must be text');
    expect(L.validate(task({ description: 'One line.' }))).toEqual([]);
    expect(L.validate(task({ description: null }))).toEqual([]);
    expect(L.validate(task({ description: 'Line one.\nLine two.' }))).toEqual([]);
    expect(L.validate(task({ title: 'Title one.\nTitle two.' }))).toEqual([]);
  });
});

describe('info shows the description and the links (0p2 B5)', () => {
  const lines = (o: object) => L.infoView(o) as string[];

  it('the description right after the title', () => {
    const out = lines(task({ description: 'What the owner wrote.' }));
    const i = out.findIndex((l) => l.startsWith('title: '));
    expect(out[i + 1]).toBe('description: What the owner wrote.');
  });

  it('no description line without one', () => {
    expect(lines(task()).some((l) => l.startsWith('description:'))).toBe(false);
  });

  it('a line break in the description stays one info line', () => {
    expect(lines(task({ description: 'One.\nTwo.' }))).toContain('description: One. Two.');
  });

  it('plan, sources with roles and anchors, and the origin source', () => {
    const out = lines(
      task({
        plan: 'PL-AUTH',
        sources: [
          { path: 'docs/auth.md', anchor: '§ 2', role: 'spec' },
          { path: 'docs/notes.md' },
          { path: 'docs/old.md', anchor: '#sync', role: 'history' },
        ],
        source: 'review of AUTH-2, finding M1',
      }),
    );
    expect(out).toContain('plan: PL-AUTH');
    expect(out).toContain('sources: docs/auth.md § 2 (spec); docs/notes.md; docs/old.md #sync (history)');
    expect(out).toContain('source: review of AUTH-2, finding M1');
  });

  it('none of the link lines when the task has no links', () => {
    expect(lines(task()).some((l) => /^(plan|sources|source): /.test(l))).toBe(false);
  });
});

describe('the board edit form takes a description', () => {
  it('editFields: a description is trimmed; an emptied one is null (removes it)', () => {
    expect(TE.editFields({ description: '  New summary.  ' })).toEqual({ error: [], field: { description: 'New summary.' } });
    expect(TE.editFields({ description: '' })).toEqual({ error: [], field: { description: null } });
    expect(TE.editFields({ description: 5 }).error).toEqual(['description must be text']);
  });

  it('editPlan: only a description that changes; removing a missing one is "nothing changed"', () => {
    const queue = { tasks: [task({ description: 'Old.' }), task({ id: 'B-1' })], projects: {} };
    expect(TE.editPlan(queue, 'A-1', { description: 'New.' })).toEqual({ error: [], field: { description: 'New.' } });
    expect(TE.editPlan(queue, 'A-1', { description: '' })).toEqual({ error: [], field: { description: null } });
    expect(TE.editPlan(queue, 'A-1', { description: 'Old.' }).error).toEqual(['nothing changed']);
    expect(TE.editPlan(queue, 'B-1', { description: '' }).error).toEqual(['nothing changed']);
  });
});

describe('panelFields: what /api/task adds for the panel', () => {
  it('the description, or null', () => {
    expect(D.panelFields(task({ description: 'Summary.' })).description).toBe('Summary.');
    expect(D.panelFields(task()).description).toBeNull();
    expect(D.panelFields(task({ description: 42 })).description).toBeNull();
  });

  it('the task own sources with role and anchor, normalised; never a path outside the project', () => {
    const f = D.panelFields(
      task({
        plan: 'PL-AUTH',
        sources: [
          { path: './docs/auth.md', anchor: ' § 2 ', role: 'spec' },
          { path: 'docs/auth.md', anchor: '2' },
          { path: '../outside.md' },
          { path: 'docs/notes.md' },
        ],
        source: 'docs/origin.md',
      }),
    );
    expect(f.sources).toEqual([
      { path: 'docs/auth.md', anchor: '§ 2', role: 'spec' },
      { path: 'docs/notes.md', anchor: null, role: null },
    ]);
  });

  it('no sources: an empty list (the plan entry sources are the Plans view)', () => {
    expect(D.panelFields(task({ plan: 'PL-AUTH' })).sources).toEqual([]);
  });
});
