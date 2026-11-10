// =============================================================
// ownershipRanking.test.ts: the ranking knows about ownership contention (logic/ranking.js scoreParts, logic/conflicts.js
// contenders), and DB ownership is compared without the default schema and the argument list (dbKey).
//
// Why: two waiting tasks that own the same file cannot run at the same time. The one that starts first holds the file
// until it is done, so the queue should prefer the short one (it frees the file sooner) and hold back the long one.
// `users` and `public.users` are the same table, and `fn(uuid)` and `fn` the same function name, so they must collide.
// =============================================================
import { describe, expect, it } from 'vitest';

type Task = Record<string, unknown> & { id: string; status: string };
type Parts = { score: number; contended: number; hot_factor: number; minutes: number };

// eslint-disable-next-line @typescript-eslint/no-require-imports
const L = require('../queueLogic') as {
  scoreParts: (o: Task, tasks: Task[], now?: number) => Parts;
  contenders: (o: Task, tasks: Task[]) => string[];
  conflictPart: (a: Task, b: Task) => { type: string; name: string } | null;
  dbKey: (s: string) => string;
};

const NOW = Date.parse('2026-11-10T12:00:00Z');
const t = (id: string, extra: Record<string, unknown> = {}): Task => ({
  id,
  status: 'waiting',
  class: 'K',
  value: 5,
  content_min: 30,
  owned_files: [],
  ...extra,
});

describe('contenders: the open tasks that own an overlapping file', () => {
  it('counts exact files and folders both ways, never itself, never done or cancelled tasks', () => {
    const tasks = [
      t('A', { owned_files: ['src/a.ts', 'lib/'] }),
      t('B', { owned_files: ['src/a.ts'] }),
      t('C', { owned_files: ['lib/x/y.ts'] }),
      t('D', { owned_files: ['src/'] }),
      t('E', { owned_files: ['src/a.ts'], status: 'done' }),
      t('F', { owned_files: ['src/a.ts'], status: 'cancelled' }),
      t('G', { owned_files: ['other.ts'] }),
    ];
    expect(L.contenders(tasks[0], tasks).sort()).toEqual(['B', 'C', 'D']);
    expect(L.contenders(tasks[6], tasks)).toEqual([]);
    // Backslashes and ./ are the same path.
    const w = [t('X', { owned_files: ['.\\src\\a.ts'] }), t('Y', { owned_files: ['src/a.ts'] })];
    expect(L.contenders(w[0], w)).toEqual(['Y']);
  });
});

describe('scoreParts: a short task on a contended file is preferred, a long one held back', () => {
  it('gives +10 % per contender at 60 min or less, and -10 % per contender above 120 min', () => {
    const tasks = [
      t('SHORT', { owned_files: ['hot.ts'], content_min: 30 }),
      t('LONG', { owned_files: ['hot.ts'], content_min: 180 }),
      t('MID', { owned_files: ['hot.ts'], content_min: 90 }),
    ];
    const s = L.scoreParts(tasks[0], tasks, NOW);
    const l = L.scoreParts(tasks[1], tasks, NOW);
    const m = L.scoreParts(tasks[2], tasks, NOW);
    expect([s.contended, l.contended, m.contended]).toEqual([2, 2, 2]);
    expect(s.hot_factor).toBeCloseTo(1.2);
    expect(l.hot_factor).toBeCloseTo(0.8);
    expect(m.hot_factor).toBe(1);
    // The factor is part of the score, so the explanation can never drift from the number.
    const alone = L.scoreParts(t('SHORT', { content_min: 30 }), [t('SHORT', { content_min: 30 })], NOW);
    expect(s.score).toBeCloseTo(alone.score * 1.2, 1);
  });

  it('has no effect without contention, and the factor is capped (five contenders, at least 0.5)', () => {
    const lone = [t('A', { owned_files: ['a.ts'] }), t('B', { owned_files: ['b.ts'] })];
    expect(L.scoreParts(lone[0], lone, NOW).hot_factor).toBe(1);
    expect(L.scoreParts(lone[0], lone, NOW).contended).toBe(0);
    const many = [t('L', { owned_files: ['hot.ts'], content_min: 300 })];
    for (let i = 0; i < 9; i++) many.push(t(`S${i}`, { owned_files: ['hot.ts'] }));
    const p = L.scoreParts(many[0], many, NOW);
    expect(p.contended).toBe(9);
    expect(p.hot_factor).toBeCloseTo(0.5);
    expect(L.scoreParts(many[1], many, NOW).hot_factor).toBeCloseTo(1.5);
  });
});

describe('dbKey and the DB conflict: the default schema and the argument list are ignored', () => {
  it('normalizes', () => {
    expect(L.dbKey('public.users')).toBe('users');
    expect(L.dbKey('"Public"."Users"')).toBe('users');
    expect(L.dbKey('  my_fn(uuid, text) ')).toBe('my_fn');
    expect(L.dbKey('auth.users')).toBe('auth.users');
  });

  it('users and public.users collide, auth.users and users do not, fn(uuid) and fn do', () => {
    const a = t('A', { owner_db: ['public.users'] });
    const b = t('B', { owner_db: ['users'], status: 'running' });
    expect(L.conflictPart(a, b)?.type).toBe('db');
    const c = t('C', { owner_db: ['auth.users'] });
    expect(L.conflictPart(c, b)).toBeNull();
    const d = t('D', { owner_db: ['my_fn(uuid)'] });
    const e = t('E', { owner_db: ['public.my_fn'], status: 'running' });
    expect(L.conflictPart(d, e)?.type).toBe('db');
  });
});
