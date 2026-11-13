// =============================================================
// taskFields.test.ts: the known task fields and the nearest one for a misspelled field (lib/taskFields.js).
//
// Locks: (1) every field of the task table and the example in docs/queue.md (A task) is known, so a documented field
// never gets a warning from add; (2) the nearest field for common slips (`owns`, `dependson`, `owned_file`, `titel`);
// (3) a word far from every field gets no guess; (4) unknownFields lists each unknown field once, skips the ones the
// caller names, and nothing for a valid task.
// Pure: reads only docs/queue.md.
// =============================================================
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const F = require('../taskFields.js');

describe('lib/taskFields.js', () => {
  it('knows every field of the task table and the example in docs/queue.md', () => {
    const doc = fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', 'docs', 'queue.md'), 'utf8');
    const section = doc.slice(doc.indexOf('## A task'), doc.indexOf('Status flow:'));
    const fromTable = [...section.matchAll(/^\| ((?:`[a-z_]+`(?:, )?)+) \|/gm)].flatMap((m) =>
      [...m[1].matchAll(/`([a-z_]+)`/g)].map((x) => x[1]),
    );
    const fromExample = [...section.matchAll(/^ {2}"([a-z_]+)":/gm)].map((m) => m[1]);
    expect(fromTable.length).toBeGreaterThan(15);
    expect(fromExample.length).toBeGreaterThan(10);
    for (const k of [...fromTable, ...fromExample]) expect(F.KNOWN, k).toContain(k);
  });

  it('finds the nearest field for common slips, and none for a far word', () => {
    expect(F.nearest('owns')).toBe('owned_files');
    expect(F.nearest('dependson')).toBe('depends_on');
    expect(F.nearest('owned_file')).toBe('owned_files');
    expect(F.nearest('titel')).toBe('title');
    expect(F.nearest('zzqx_flag')).toBeNull();
  });

  it('lists each unknown field with its nearest one, skips what the caller names, and nothing for a valid task', () => {
    expect(F.unknownFields({ id: 'A', title: 'x', owned_files: [] })).toEqual([]);
    expect(F.unknownFields({ id: 'A', owns: [], zzqx: 1, minutes: 5 }, ['minutes'])).toEqual([
      { field: 'owns', near: 'owned_files' },
      { field: 'zzqx', near: null },
    ]);
    expect(F.unknownFieldWarning('A', { field: 'owns', near: 'owned_files' })).toBe(
      'WARNING: A: unknown field "owns"; the queue does not read it (did you mean owned_files?).',
    );
    expect(F.unknownFields(null)).toEqual([]);
  });
});
