// =============================================================
// askCatalog.test.ts: the ten question categories (ask-catalog/categories.json, table 4.1 of
// plans/autonomi-nivaa-utredning.md) and the loader in lib/askCatalog.js.
//
// The categories are data: key, title, covers and the enforcement label. The loader is pure (parseCategories takes the
// text), refuses a broken file, and an unknown key gives an error that lists the keys, so an agent can fix its question.
// =============================================================
import { describe, it, expect } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const AC = require('../askCatalog.js') as {
  KEYS: string[];
  UNCATEGORIZED: string;
  categories: () => { key: string; title: string; covers: string; enforcement: string }[];
  parseCategories: (text: string) => { key: string; title: string; covers: string; enforcement: string }[];
  categoryError: (key: unknown) => string | null;
  isCategory: (key: unknown) => boolean;
  titleOf: (key: unknown) => string;
  categoryOf: (q: unknown) => string;
};

describe('the category catalog', () => {
  it('has the ten rows of table 4.1, in order, each with a title, what it covers and the enforcement label', () => {
    const rows = AC.categories();
    expect(rows.map((r) => r.key)).toEqual([
      'legal',
      'security',
      'architecture',
      'database',
      'dependency',
      'delete',
      'product',
      'followups',
      'ui',
      'technical',
    ]);
    for (const r of rows) {
      expect(r.title.length).toBeGreaterThan(3);
      expect(r.covers.length).toBeGreaterThan(3);
      expect(r.enforcement.length).toBeGreaterThan(3);
    }
    expect(rows.find((r) => r.key === 'database')?.enforcement).toBe('Stopped');
    expect(rows.find((r) => r.key === 'legal')?.title).toBe('Legal and privacy');
    expect(AC.KEYS).toEqual(rows.map((r) => r.key));
  });

  it('holds data only: no levels or overrides yet (phase 2)', () => {
    for (const r of AC.categories()) expect(Object.keys(r).sort()).toEqual(['covers', 'enforcement', 'key', 'title']);
  });

  it('refuses a broken file: not a list, a missing field, a key twice', () => {
    expect(() => AC.parseCategories('{}')).toThrow(/list/);
    expect(() => AC.parseCategories('[{"key":"a","title":"A"}]')).toThrow(/covers/);
    const row = '{"key":"a","title":"A","covers":"x","enforcement":"Stopped"}';
    expect(() => AC.parseCategories(`[${row},${row}]`)).toThrow(/twice/);
    expect(AC.parseCategories(`[${row}]`)).toEqual([{ key: 'a', title: 'A', covers: 'x', enforcement: 'Stopped' }]);
  });
});

describe('categoryError, titleOf and categoryOf', () => {
  it('accepts a known key and gives an error listing every key for an unknown one', () => {
    expect(AC.categoryError('database')).toBeNull();
    expect(AC.isCategory('ui')).toBe(true);
    const e = AC.categoryError('db');
    expect(e).toMatch(/unknown category "db"/);
    for (const k of AC.KEYS) expect(e).toContain(k);
    expect(AC.categoryError('')).toMatch(/category/);
    expect(AC.categoryError(undefined)).toMatch(/category/);
    expect(AC.isCategory(AC.UNCATEGORIZED)).toBe(false);
  });

  it('names a category by its title, and an old post without one is uncategorized', () => {
    expect(AC.titleOf('dependency')).toBe('New libraries');
    expect(AC.titleOf('nope')).toBe('Uncategorized');
    expect(AC.categoryOf({ category: 'legal' })).toBe('legal');
    expect(AC.categoryOf({ text: 'old post' })).toBe('uncategorized');
    expect(AC.categoryOf({ category: 'gone' })).toBe('uncategorized');
    expect(AC.categoryOf(null)).toBe('uncategorized');
  });
});
