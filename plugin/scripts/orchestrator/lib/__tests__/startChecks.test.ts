// =============================================================
// startChecks.test.ts: the checks before a task starts (PS-1..4, lib/startChecks.js).
//
// Locks: (1) PS-1 finds the repo paths a mission names that the task does not own, share or read, and only real paths
// (an extension or an existing tree entry; never URLs, prose, globs or absolute paths), at most 5 named plus "and N
// more"; (2) PS-2 warns on an empty owned_files for K, D and D+ only; (3) PS-3 says "size not set" for a D or D+ without
// content_min and marks the 30-minute fallback as a guess; (4) PS-4 notes a mismatch between ownerQuestions=<n> and the
// items under the report's owner question heading; (5) each check is off with its setting.
// =============================================================
import { describe, expect, it } from 'vitest';

const SC = require('../startChecks.js');

const task = (extra: Record<string, unknown> = {}) => ({ id: 'T1', class: 'K', title: 'A task', mission: '', owned_files: [], ...extra });

describe('PS-1: paths the mission names outside the task files', () => {
  it('finds a path with an extension and a folder that exists, not one the task owns, reads or shares', () => {
    const t = task({
      mission: 'Change lib/a.js and lib/b.js, read `docs/guide.md`, and look in src/widgets/ for the rest. Update plugin/c.ts.',
      owned_files: ['lib/a.js'],
      reads: ['docs/'],
      shared_patch: ['plugin/c.ts'],
    });
    const exists = (p: string) => p === 'src/widgets';
    expect(SC.missionPaths(t, { exists })).toEqual(['lib/b.js', 'src/widgets/']);
  });

  it('ignores URLs, prose with slashes, globs, absolute paths and versions', () => {
    const t = task({
      mission:
        'See https://example.com/a/b.html and www.example.com/x.js. Use and/or, 1/2 of it, e.g. this, v1.2 and ' +
        'lib/**/*.js, /etc/hosts.conf, C:/tmp/x.txt, ~/notes.md, ../outside/x.js. Then src/real.ts.',
    });
    expect(SC.missionPaths(t, { exists: () => false })).toEqual(['src/real.ts']);
  });

  it('a bare file name counts only when it exists in the tree', () => {
    const t = task({ mission: 'Fix README.md and notes.txt in place.' });
    expect(SC.missionPaths(t, { exists: (p: string) => p === 'README.md' })).toEqual(['README.md']);
  });

  it('an owned folder covers a path under it, and an owned file under a named folder covers the folder', () => {
    const t = task({ mission: 'Work in lib/x/y.js and in docs/ only.', owned_files: ['lib/', 'docs/queue.md'] });
    expect(SC.missionPaths(t, { exists: (p: string) => p === 'docs' })).toEqual([]);
  });

  it('one line lists at most 5 paths plus "and N more"', () => {
    const paths = ['a/1.js', 'a/2.js', 'a/3.js', 'a/4.js', 'a/5.js', 'a/6.js', 'a/7.js'];
    const t = task({ mission: paths.join(' '), owned_files: ['b/x.js'] });
    const line = SC.missionPathLine(t, SC.missionPaths(t, { exists: () => false }), { ravenseat: 'ravenseat' });
    expect(line).toMatch(/^WARNING: T1: /);
    expect(line).toContain('a/1.js, a/2.js, a/3.js, a/4.js, a/5.js and 2 more');
    expect(line).not.toContain('a/6.js');
    expect(line.split('\n')).toHaveLength(1);
  });

  it('skips the paths it is told to (the protected path that has its own line)', () => {
    const t = task({ mission: 'Change .claude/settings.json and lib/z.js', owned_files: ['lib/a.js'] });
    expect(SC.missionPaths(t, { exists: () => false, skip: ['.claude/settings.json'] })).toEqual(['lib/z.js']);
  });

  it('says the same path once', () => {
    const t = task({ mission: 'lib/z.js, then lib/z.js again (lib/z.js).', owned_files: ['lib/a.js'] });
    expect(SC.missionPaths(t, { exists: () => false })).toEqual(['lib/z.js']);
  });
});

describe('PS-2: empty owned_files', () => {
  it('warns for K, D and D+, not for U', () => {
    for (const c of ['K', 'D', 'D+']) expect(SC.emptyOwnershipLine(task({ class: c }), {})).toMatch(/^WARNING: T1: /);
    expect(SC.emptyOwnershipLine(task({ class: 'U' }), {})).toBeNull();
    expect(SC.emptyOwnershipLine(task({ owned_files: ['a.js'] }), {})).toBeNull();
  });
});

describe('PS-3: D or D+ without content_min', () => {
  it('warns and marks the estimate as a guess', () => {
    expect(SC.sizeNotSet(task({ class: 'D' }))).toBe(true);
    expect(SC.sizeNotSet(task({ class: 'D+', content_min: null }))).toBe(true);
    expect(SC.sizeNotSet(task({ class: 'D', content_min: 60 }))).toBe(false);
    expect(SC.sizeNotSet(task({ class: 'K' }))).toBe(false);
    expect(SC.sizeNotSetLine(task({ class: 'D' }), {})).toMatch(/^WARNING: T1: .*size not set.*30/);
    expect(SC.estimateText(task({ class: 'D' }), 60)).toBe('60 min (size not set, a guess)');
    expect(SC.estimateText(task({ class: 'D', content_min: 40 }), 60)).toBe('60 min');
  });
});

describe('PS-4: ownerQuestions against the report', () => {
  const report = (body: string) => `# Report\n\n## Owner questions\n\n${body}\n\n## Tests\n\n- ok`;
  it('notes a count that does not match the items', () => {
    const r = SC.ownerQuestionNote({ result: { ownerQuestions: 1 }, reportText: report('1. First?\n2. Second?') });
    expect(r).toMatch(/^NOTE: .*ownerQuestions=1.*2/);
    const zero = SC.ownerQuestionNote({ result: { ownerQuestions: 0 }, reportText: report('- Should X be Y?') });
    expect(zero).toMatch(/ownerQuestions=0/);
  });
  it('no note when they match, when the section says none, or without a count or a section', () => {
    expect(SC.ownerQuestionNote({ result: { ownerQuestions: 2 }, reportText: report('- A?\n  - detail\n- B?') })).toBeNull();
    expect(SC.ownerQuestionNote({ result: { ownerQuestions: 0 }, reportText: report('None.') })).toBeNull();
    expect(SC.ownerQuestionNote({ result: { ownerQuestions: null }, reportText: report('- A?') })).toBeNull();
    expect(SC.ownerQuestionNote({ result: null, reportText: report('- A?') })).toBeNull();
    expect(SC.ownerQuestionNote({ result: { ownerQuestions: 1 }, reportText: '# Report\n' })).toBeNull();
  });
  it('a section without list marks counts its paragraphs, and the reply is read when the report has none', () => {
    expect(SC.ownerQuestionNote({ result: { ownerQuestions: 1 }, reportText: null, reply: report('Should X be Y?') })).toBeNull();
    expect(SC.ownerQuestionNote({ result: { ownerQuestions: 1 }, reportText: null, reply: report('One?\n\nTwo?') })).toMatch(/NOTE/);
  });
});

describe('the settings', () => {
  it('every check is on by default and off by its own key', () => {
    expect(SC.setup({})).toEqual({ missionPaths: true, emptyOwnership: true, sizeNotSet: true, ownerQuestionCount: true });
    const off = SC.setup({ planChecks: { missionPaths: false, emptyOwnership: false, sizeNotSet: false, ownerQuestionCount: false } });
    expect(Object.values(off).every((v) => v === false)).toBe(true);
  });
  it('warningLines gives nothing for a check that is off', () => {
    const t = task({ class: 'D', mission: 'Change lib/z.js' });
    const on = SC.warningLines(t, { config: {}, exists: () => false, ravenseat: 'ravenseat' });
    expect(on).toHaveLength(3);
    const off = SC.warningLines(t, {
      config: { planChecks: { missionPaths: false, emptyOwnership: false, sizeNotSet: false } },
      exists: () => false,
      ravenseat: 'ravenseat',
    });
    expect(off).toEqual([]);
  });
});
