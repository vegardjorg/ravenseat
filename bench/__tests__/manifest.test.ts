// =============================================================
// manifest.test.ts: validation, defaults, file loading and seeded pair assignment (bench/lib/manifest.js).
// =============================================================
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const Mf = require('../lib/manifest.js') as Record<string, any>;
const tmp: string[] = [];
afterAll(() => tmp.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const ok = () => ({
  experiment: 'e1',
  arms: [{ name: 'a', kind: 'cq' }, { name: 'b', kind: 'manual-fresh' }],
  tasks: [
    { id: 'T-1', arm: 'a', pair: 'p1' },
    { id: 'T-2', arm: 'b', pair: 'p1' },
  ],
});

describe('validate', () => {
  it('accepts a minimal manifest and the shipped synthetic example', () => {
    expect(Mf.validate(ok())).toEqual([]);
    const example = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'example', 'manifest.example.json'), 'utf8'));
    expect(Mf.validate(example)).toEqual([]);
  });

  it('reports every problem at once', () => {
    const m: any = ok();
    m.experiment = 'bad name';
    m.arms.push({ name: 'a', kind: 'robot', maxParallel: 0 });
    m.tasks.push({ id: 'T-3', arm: 'nope', pair: 'p2' }, { id: 'T-1', arm: 'a', outcome: 'maybe' });
    const e = Mf.validate(m).join('\n');
    expect(e).toMatch(/experiment must be/);
    expect(e).toMatch(/arm "a" is defined twice/);
    expect(e).toMatch(/kind must be one of/);
    expect(e).toMatch(/maxParallel/);
    expect(e).toMatch(/unknown arm "nope"/);
    expect(e).toMatch(/pair "p2" has only one task/);
    expect(e).toMatch(/listed twice in arm "a"/);
    expect(e).toMatch(/outcome must be one of/);
  });

  it('refuses two tasks with the same log label unless both name their sessions', () => {
    const m: any = ok();
    m.tasks = [{ id: 'T-1', arm: 'a', pair: 'p1' }, { id: 'T-1', arm: 'b', pair: 'p1' }];
    expect(Mf.validate(m).join()).toMatch(/label "T-1" is used by two tasks/);
    m.tasks[1].label = 'T-1-R';
    expect(Mf.validate(m)).toEqual([]);
    m.tasks = [
      { id: 'T-1', arm: 'a', pair: 'p1', sessions: ['s1'] },
      { id: 'T-1', arm: 'b', pair: 'p1', sessions: ['s2'] },
    ];
    expect(Mf.validate(m)).toEqual([]);
  });
});

describe('loadManifest and withDefaults', () => {
  it('fills defaults and resolves source paths relative to the manifest', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-mf-'));
    tmp.push(d);
    const f = path.join(d, 'm.json');
    fs.writeFileSync(f, JSON.stringify({ ...ok(), sources: { queue: 'q/queue.json' } }));
    const m = Mf.loadManifest(f);
    expect(m.sources.queue).toBe(path.join(d, 'q', 'queue.json'));
    expect(m.settings.bootstrap).toBe(2000);
    expect(m.tasks[0]).toMatchObject({ label: 'T-1', replay: null, sessions: [], outcome: null });
    fs.writeFileSync(f, JSON.stringify({ experiment: 'x', arms: [] }));
    expect(() => Mf.loadManifest(f)).toThrow(/arms must be a non-empty list/);
  });
});

describe('assignPairs', () => {
  it('gives every pair one task per arm, the same way for the same seed', () => {
    const pairs = Array.from({ length: 20 }, (_, i) => ({ pair: `p${i}`, ids: [`A-${i}`, `B-${i}`] }));
    const a = Mf.assignPairs(JSON.parse(JSON.stringify(pairs)), ['cq', 'manual'], 5);
    const b = Mf.assignPairs(JSON.parse(JSON.stringify(pairs)), ['cq', 'manual'], 5);
    expect(a).toEqual(b);
    for (let i = 0; i < 20; i++) {
      const arms = a.filter((x: any) => x.pair === `p${i}`).map((x: any) => x.arm).sort();
      expect(arms).toEqual(['cq', 'manual']);
    }
    // Randomised: the first id is not always in the same arm.
    const firstInCq = a.filter((x: any) => x.id.startsWith('A-') && x.arm === 'cq').length;
    expect(firstInCq).toBeGreaterThan(2);
    expect(firstInCq).toBeLessThan(18);
  });
});
