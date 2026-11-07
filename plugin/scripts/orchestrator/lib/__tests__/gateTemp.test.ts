// =============================================================
// gateTemp.test.ts: the rules for a gate run's own temp folder and the doctor line (lib/gateTemp.js).
// The whole flow with the real gates.mjs is in __tests__/gateTempFlow.test.ts.
// =============================================================
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const GT = require('../gateTemp.js');

const made: string[] = [];
const base = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-temp-unit-'));
  made.push(d);
  return d;
};
afterAll(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});

describe('withTemp', () => {
  it('points all three variables to the folder and leaves the rest alone', () => {
    const env = GT.withTemp({ PATH: 'x', TEMP: 'old', TMP: 'old', TMPDIR: 'old' }, 'new');
    expect(env).toEqual({ PATH: 'x', TEMP: 'new', TMP: 'new', TMPDIR: 'new' });
  });

  it('leaves no variant in another case behind: Windows would pick either', () => {
    const env = GT.withTemp({ Temp: 'old', tmp: 'old' }, 'new');
    expect(env).toEqual({ TEMP: 'new', TMP: 'new', TMPDIR: 'new' });
  });

  it('without a folder the environment is unchanged', () => {
    const env = { TEMP: 'old' };
    expect(GT.withTemp(env, null)).toBe(env);
  });
});

describe('create', () => {
  it('makes a folder with the pid in its name under the base', () => {
    const b = base();
    const dir = GT.create({ base: b, pid: 4242 });
    expect(path.dirname(dir)).toBe(b);
    expect(path.basename(dir)).toMatch(/^ravenseat-gate-run-4242-/);
    expect(fs.statSync(dir).isDirectory()).toBe(true);
  });

  it('fails open: a base that cannot be used gives null, and the gate runs with the normal temp folder', () => {
    expect(GT.create({ base: path.join(base(), 'does', 'not', 'exist') })).toBeNull();
  });
});

describe('remove', () => {
  it('removes the folder with what is in it', () => {
    const dir = GT.create({ base: base() });
    fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'a', 'b', 'f.txt'), 'x');
    expect(GT.remove(dir)).toEqual({ removed: true, link: false });
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('never removes through a link: the folder stays and what the link points at is untouched', () => {
    const b = base();
    const outside = path.join(b, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
    const dir = GT.create({ base: b });
    fs.mkdirSync(path.join(dir, 'deep'));
    fs.symlinkSync(outside, path.join(dir, 'deep', 'link'), 'junction');
    expect(GT.remove(dir)).toEqual({ removed: false, link: true });
    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8')).toBe('keep');
  });

  it('a folder that is already gone is fine', () => {
    expect(GT.remove(path.join(base(), 'gone')).removed).toBe(true);
  });
});

describe('sweep: what a killed run left', () => {
  const HOUR = 3_600_000;
  const old = (dir: string) => {
    const t = new Date(Date.now() - 2 * HOUR);
    fs.utimesSync(dir, t, t);
  };

  it('removes an old folder whose process is gone', () => {
    const b = base();
    const dir = GT.create({ base: b, pid: 111 });
    old(dir);
    expect(GT.sweep(b, { alive: () => false })).toBe(1);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('leaves a running process and a young folder alone', () => {
    const b = base();
    const alive = (pid: number) => pid === 222;
    const running = GT.create({ base: b, pid: 222, alive });
    old(running);
    const young = GT.create({ base: b, pid: 333, alive });
    expect(GT.sweep(b, { alive })).toBe(0);
    expect(fs.existsSync(running)).toBe(true);
    expect(fs.existsSync(young)).toBe(true);
  });

  it('never touches the gate queue or anything else in the temp folder', () => {
    const b = base();
    const others = ['ravenseat-gate-queue-me', 'ravenseat-gate-run-notapid', 'pip-abc', 'merge-track-1'].map((n) => path.join(b, n));
    for (const o of others) {
      fs.mkdirSync(o);
      old(o);
    }
    expect(GT.sweep(b, { alive: () => false })).toBe(0);
    for (const o of others) expect(fs.existsSync(o)).toBe(true);
  });

  it('leaves a leftover that holds a link', () => {
    const b = base();
    const outside = path.join(b, 'outside');
    fs.mkdirSync(outside);
    const dir = GT.create({ base: b, pid: 444 });
    fs.symlinkSync(outside, path.join(dir, 'link'), 'junction');
    old(dir);
    expect(GT.sweep(b, { alive: () => false })).toBe(0);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('create sweeps, so leftovers do not pile up', () => {
    const b = base();
    const dir = GT.create({ base: b, pid: 555 });
    old(dir);
    GT.create({ base: b, pid: 666, alive: () => false });
    expect(fs.existsSync(dir)).toBe(false);
  });
});

describe('usage: the doctor line', () => {
  it('counts per prefix, the largest first, and Ravenseat\'s own apart', () => {
    const names = ['pip-a', 'pip-b', 'pip-c', 'nsp_1', 'nsp_2', 'x.tmp', 'merge-track-1', 'queue-plan-config-2', 'ravenseat-gate-queue-me'];
    const u = GT.usage(names);
    expect(u.total).toBe(9);
    expect(u.own).toBe(3);
    expect(u.top.slice(0, 2)).toEqual([{ prefix: 'pip', count: 3 }, { prefix: 'nsp', count: 2 }]);
  });

  it('a quiet temp folder is a plain OK line', () => {
    const l = GT.doctorLine(['pip-a', 'pip-b', 'merge-track-1']);
    expect(l.status).toBe('OK');
    expect(l.message).toContain('3 entries in the temp folder');
    expect(l.message).toContain('pip 2');
    expect(l.message).toContain("Ravenseat's own: 1");
  });

  it('a very full one is a hint, never a problem, and names who left the most', () => {
    const names = Array.from({ length: GT.FULL_ENTRIES }, (_, i) => `pip-${i}`);
    const l = GT.doctorLine(names);
    expect(l.status).toBe('INFO');
    expect(l.message).toContain(`pip ${GT.FULL_ENTRIES}`);
    expect(l.fix).toMatch(/plugin/i);
  });

  it('stays fast at the size that made it worth having: names only, no sizes', () => {
    const names = Array.from({ length: 200_000 }, (_, i) => `pip-${i}`);
    const t0 = Date.now();
    GT.doctorLine(names);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
