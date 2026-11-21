// =============================================================
// releaseNotes.test.ts: the release notes draft (lib/releaseNotes.js, GH-5).
//
// Locks: (1) merged tasks are grouped Added / Changed / Fixed / Hardened (the CHANGELOG's groups) from what the task
// carries: a fix link or a base or CI fix task is Fixed, labels name the others, the rest is Changed; (2) only done
// tasks count, an investigation (class U, no production code) is left out and counted; (3) the order is the merge
// order; (4) the local draft uses the title as written, the GitHub form puts it in a code span and ends with the
// signature; (5) an empty range says so.
// =============================================================
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const RN = require('../releaseNotes.js');

const t = (id: string, over: Record<string, unknown> = {}) => ({ id, title: `Title ${id}`, status: 'done', class: 'K', ...over });

describe('groupOf', () => {
  it('a fix link, a QA fix and a base or CI fix task are Fixed', () => {
    expect(RN.groupOf(t('A', { fixes: ['B'] }))).toBe('Fixed');
    expect(RN.groupOf(t('A', { qa_original: 'B' }))).toBe('Fixed');
    expect(RN.groupOf(t('A', { added_by: 'ci watch' }))).toBe('Fixed');
    expect(RN.groupOf(t('A', { added_by: 'base gate' }))).toBe('Fixed');
    expect(RN.groupOf(t('A', { labels: ['bug'] }))).toBe('Fixed');
  });

  it('labels give Added and Hardened; anything else is Changed', () => {
    expect(RN.groupOf(t('A', { labels: ['feature'] }))).toBe('Added');
    expect(RN.groupOf(t('A', { labels: ['security'] }))).toBe('Hardened');
    expect(RN.groupOf(t('A', { labels: ['hardening'] }))).toBe('Hardened');
    expect(RN.groupOf(t('A'))).toBe('Changed');
    expect(RN.groupOf(t('A', { labels: ['docs'] }))).toBe('Changed');
  });
});

describe('build', () => {
  it('groups the merged ids in merge order, leaves out what is not done and investigations', () => {
    const tasks = [t('A-1', { labels: ['feature'] }), t('A-2'), t('A-3', { fixes: ['A-1'] }), t('A-4', { class: 'U' }), t('A-5', { status: 'cancelled' }), t('A-6', { labels: ['feature'] })];
    const r = RN.build({ ids: ['A-6', 'A-1', 'A-2', 'A-3', 'A-4', 'A-5', 'A-9'], tasks });
    expect(r.groups.Added.map((x: { id: string }) => x.id)).toEqual(['A-6', 'A-1']);
    expect(r.groups.Changed.map((x: { id: string }) => x.id)).toEqual(['A-2']);
    expect(r.groups.Fixed.map((x: { id: string }) => x.id)).toEqual(['A-3']);
    expect(r.groups.Hardened).toEqual([]);
    expect(r.leftOut).toEqual({ investigation: 1, notDone: 1, unknown: 1 });
    expect(r.count).toBe(4);
  });
});

describe('markdown', () => {
  const r = RN.build({ ids: ['A-1', 'A-2'], tasks: [t('A-1', { labels: ['feature'], title: 'New @team thing' }), t('A-2')] });

  it('the local draft: a heading with the tag, the groups that have tasks, the title as written', () => {
    const md = RN.markdown(r, { from: 'v1.0.0' });
    expect(md).toMatch(/^## Unreleased \(since v1\.0\.0\)/);
    expect(md).toContain('### Added');
    expect(md).toContain('- **New @team thing** (A-1)');
    expect(md).toContain('### Changed');
    expect(md).not.toContain('### Fixed');
  });

  it('the GitHub form: titles in code spans and the signature', () => {
    const md = RN.markdown(r, { from: null, github: true });
    expect(md).toMatch(/all history/);
    expect(md).toContain('- `New @team thing` (`A-1`)');
    expect(md.trim().split('\n').pop()).toBe('Posted by Ravenseat');
  });

  it('an empty range says so', () => {
    expect(RN.markdown(RN.build({ ids: [], tasks: [] }), { from: 'v2' })).toMatch(/No merged tasks since v2/);
  });
});
