// =============================================================
// loadSlots.test.ts: load-aware parallelism (lib/loadSlots.js, its use in lib/queueLogic.js and queue.mjs).
//
// The rule: all maxConcurrent slots at or above allSlotsFreeMemoryPct free memory (default 40), minSlots (default 1)
// at the hard load limit (minFreeMemoryPct, default 10), linear in between, rounded down; CPU optional; the lower of
// the two wins; unknown measurements never limit. The tests lock the rule where it is enforced: the pure function,
// selectNext/state/summaryView in queueLogic, and queue.mjs next/fill against a copy of a queue in a temporary folder
// with the measurement replaced by QUEUE_LOAD (vitest.config.mjs sets free=100 for every other test).
// =============================================================
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type Load = { freeMemoryPct?: number | null; cpuPct?: number | null } | null;
type Slots = {
  active: boolean;
  slots: number;
  max: number;
  newSlots: number;
  limited: boolean;
  by: 'memory' | 'cpu' | null;
  reason: string | null;
  text: string;
};
type Settings = {
  adaptive: boolean;
  minSlots: number;
  allSlotsFreeMemoryPct: number | null;
  allSlotsCpuPct: number | null;
  minSlotsCpuPct: number | null;
};
type Task = {
  id: string;
  title: string;
  domain: string;
  class: 'K' | 'D' | 'D+' | 'U';
  status: string;
  mission?: string;
  value?: number;
};
type Queue = { tasks: Task[]; limits?: Record<string, unknown>; next_migr?: number; resolved?: string[] };

/* eslint-disable @typescript-eslint/no-require-imports */
const LS = require('../loadSlots') as {
  DEFAULTS: Settings;
  settingsFrom: (lg?: Partial<Settings> | null, env?: Record<string, string | undefined>) => Settings;
  cpuOn: (s: Settings) => boolean;
  loadSlots: (input: {
    maxSlots: number;
    running?: number;
    load?: Load;
    hardMinFreeMemoryPct?: number | null;
    settings?: Settings;
  }) => Slots;
  parseOverride: (env?: string) => { freeMemoryPct: number | null; cpuPct: number | null } | null;
  measure: (opt?: { cpu?: boolean; sampleMs?: number; env?: string }) => {
    freeMemoryPct: number | null;
    cpuPct: number | null;
  };
};
const L = require('../queueLogic') as {
  selectNext: (queue: Queue, now?: number, opt?: { uncommitted?: string[]; load?: Load }) => { id: string }[];
  loadSlotsFor: (queue: Queue, load: Load) => Slots;
  state: (
    queue: Queue,
    dailyUsage?: number,
    opt?: { load?: Load },
  ) => { canStart: number; loadSlots?: { slots: number; max: number; limited: boolean; text: string } };
  summaryView: (queue: Queue, opt?: { load?: Load; dailyUsage?: number }) => string[];
};
/* eslint-enable @typescript-eslint/no-require-imports */

// Settings as on Windows/Linux by default, independent of the machine (macOS turns the memory part off).
const S = (over: Partial<Settings> = {}): Settings => ({ ...LS.settingsFrom({}, {}), allSlotsFreeMemoryPct: 40, ...over });
const slots = (free: number | null, extra: Record<string, unknown> = {}) =>
  LS.loadSlots({ maxSlots: 5, load: { freeMemoryPct: free }, hardMinFreeMemoryPct: 10, settings: S(), ...extra });

describe('loadSlots (pure rule)', () => {
  it('all slots at or above allSlotsFreeMemoryPct, minSlots at the hard limit, linear and rounded down between', () => {
    expect(slots(80).slots).toBe(5);
    expect(slots(40).slots).toBe(5);
    expect(slots(40).limited).toBe(false);
    // 1 + floor(4 * (25 - 10) / 30) = 3
    expect(slots(25).slots).toBe(3);
    // 1 + floor(4 * 8 / 30) = 2
    expect(slots(18).slots).toBe(2);
    expect(slots(10).slots).toBe(1);
    expect(slots(2).slots).toBe(1); // below the hard limit: the floor (the hard guard stops starts separately)
    expect(slots(39.9).slots).toBe(4);
  });

  it('the reason says how many of how many and why', () => {
    const r = slots(18);
    expect(r.limited).toBe(true);
    expect(r.by).toBe('memory');
    expect(r.reason).toBe('2 of 5 slots: free memory 18 % (all slots from 40 %)');
    expect(r.text).toBe(r.reason);
    expect(slots(90).text).toBe('5 of 5 slots');
    expect(slots(90).reason).toBeNull();
  });

  it('new slots = effective slots minus the agents already running, never negative', () => {
    expect(slots(18, { running: 0 }).newSlots).toBe(2);
    expect(slots(18, { running: 1 }).newSlots).toBe(1);
    expect(slots(18, { running: 4 }).newSlots).toBe(0);
    expect(slots(90, { running: 3 }).newSlots).toBe(2);
  });

  it('the floor is never 0, and never above maxConcurrent', () => {
    expect(slots(1, { settings: S({ minSlots: 0 }) }).slots).toBe(1);
    expect(slots(1, { settings: S({ minSlots: 3 }) }).slots).toBe(3);
    expect(slots(1, { maxSlots: 2, settings: S({ minSlots: 3 }) }).slots).toBe(2);
    expect(slots(1, { maxSlots: 0 }).slots).toBe(0);
  });

  it('unknown or no measurement never limits; adaptive off gives the fixed max', () => {
    expect(slots(null).slots).toBe(5);
    expect(LS.loadSlots({ maxSlots: 5, load: null, settings: S() })).toMatchObject({ slots: 5, active: false });
    expect(slots(12, { settings: S({ adaptive: false }) })).toMatchObject({ slots: 5, active: false, limited: false });
    expect(slots(12, { settings: S({ allSlotsFreeMemoryPct: null }) }).slots).toBe(5);
  });

  it('without a hard limit the memory ramp starts at 0 %', () => {
    // 1 + floor(4 * 20 / 40) = 3
    expect(slots(20, { hardMinFreeMemoryPct: null }).slots).toBe(3);
    expect(slots(0, { hardMinFreeMemoryPct: null }).slots).toBe(1);
  });

  it('CPU: only with both thresholds; all slots at or below allSlotsCpuPct, floor at minSlotsCpuPct; the lower wins', () => {
    const cpu = S({ allSlotsCpuPct: 60, minSlotsCpuPct: 95 });
    expect(LS.cpuOn(cpu)).toBe(true);
    expect(LS.cpuOn(S())).toBe(false);
    expect(LS.cpuOn(S({ allSlotsCpuPct: 90, minSlotsCpuPct: 60 }))).toBe(false);
    const at = (free: number, busy: number | null, s = cpu) =>
      LS.loadSlots({ maxSlots: 5, load: { freeMemoryPct: free, cpuPct: busy }, hardMinFreeMemoryPct: 10, settings: s });
    expect(at(90, 50).slots).toBe(5);
    expect(at(90, 99).slots).toBe(1);
    // 1 + floor(4 * (95 - 80) / 35) = 2
    const r = at(90, 80);
    expect(r.slots).toBe(2);
    expect(r.by).toBe('cpu');
    expect(r.reason).toBe('2 of 5 slots: CPU 80 % busy (all slots at or below 60 %)');
    // Memory lower than CPU: memory is the reason.
    expect(at(12, 70).by).toBe('memory');
    // CPU set but not measured, or CPU off: only memory counts.
    expect(at(90, null).slots).toBe(5);
    expect(at(90, 99, S()).slots).toBe(5);
  });
});

describe('settingsFrom and the measurement', () => {
  it('defaults, config values and QUEUE_LOAD_ADAPTIVE (wins over the config)', () => {
    const d = LS.settingsFrom({}, {});
    expect(d).toMatchObject({ adaptive: true, minSlots: 1, allSlotsCpuPct: null, minSlotsCpuPct: null });
    expect(LS.settingsFrom({ adaptive: false }, {}).adaptive).toBe(false);
    expect(LS.settingsFrom({ adaptive: false }, { QUEUE_LOAD_ADAPTIVE: 'on' }).adaptive).toBe(true);
    expect(LS.settingsFrom({}, { QUEUE_LOAD_ADAPTIVE: 'off' }).adaptive).toBe(false);
    expect(LS.settingsFrom({}, { QUEUE_LOAD_ADAPTIVE: 'maybe' }).adaptive).toBe(true);
    expect(LS.settingsFrom({ allSlotsFreeMemoryPct: null }, {}).allSlotsFreeMemoryPct).toBeNull();
    expect(LS.settingsFrom({ allSlotsFreeMemoryPct: 55, minSlots: 2.7 }, {})).toMatchObject({
      allSlotsFreeMemoryPct: 55,
      minSlots: 2,
    });
    expect(LS.settingsFrom({ minSlots: -1 }, {}).minSlots).toBe(1);
  });

  it('QUEUE_LOAD gives free and cpu; the real measurement is a percentage; CPU only when asked', () => {
    expect(LS.parseOverride('free=12.5,cpu=80')).toEqual({ freeMemoryPct: 12.5, cpuPct: 80 });
    expect(LS.parseOverride('free=30,x=1')).toEqual({ freeMemoryPct: 30, cpuPct: null });
    expect(LS.parseOverride('')).toBeNull();
    expect(LS.measure({ env: 'free=7' })).toEqual({ freeMemoryPct: 7, cpuPct: null });
    const m = LS.measure({ env: '' });
    expect(m.freeMemoryPct).toBeGreaterThan(0);
    expect(m.freeMemoryPct).toBeLessThanOrEqual(100);
    expect(m.cpuPct).toBeNull();
    const c = LS.measure({ env: '', cpu: true, sampleMs: 50 });
    expect(c.cpuPct === null || (c.cpuPct >= 0 && c.cpuPct <= 100)).toBe(true);
  });
});

// ---- queueLogic: selectNext, state and show use the slot count when a measurement is given ----------------------

const task = (id: string, extra: Partial<Task> = {}): Task => ({
  id,
  title: `Task ${id}`,
  domain: `dom-${id}`,
  class: 'K',
  status: 'waiting',
  mission: `The mission for ${id}.`,
  value: 5,
  ...extra,
});
const four = (running = 0): Queue => ({
  tasks: [
    ...['A', 'B', 'C', 'D'].map((id) => task(id)),
    ...Array.from({ length: running }, (_, i) => task(`R${i}`, { status: 'running' })),
  ],
  limits: { maxConcurrent: 4, maxDPlus: 2, maxPerDomain: 7, maxDb: 6, minFreeMemoryPct: 10 },
  resolved: [],
});
const darwin = process.platform === 'darwin'; // the memory ramp is off there by default

describe('queueLogic with the load', () => {
  it('selectNext opens fewer slots under load, all without a measurement or with enough memory', () => {
    expect(L.selectNext(four()).length).toBe(4);
    expect(L.selectNext(four(), Date.now(), { load: { freeMemoryPct: 90 } }).length).toBe(4);
    // 1 + floor(3 * 10 / 30) = 2 of 4
    expect(L.selectNext(four(), Date.now(), { load: { freeMemoryPct: 20 } }).length).toBe(darwin ? 4 : 2);
    // One already runs: 2 slots minus 1 = 1 new.
    expect(L.selectNext(four(1), Date.now(), { load: { freeMemoryPct: 20 } }).length).toBe(darwin ? 3 : 1);
  });

  it('loadSlotsFor uses maxConcurrent, running agents and the queue\'s hard limit', () => {
    if (darwin) return;
    const r = L.loadSlotsFor(four(1), { freeMemoryPct: 20 });
    expect(r).toMatchObject({ slots: 2, max: 4, newSlots: 1, limited: true });
    // A higher hard limit moves the bottom of the ramp: 1 + floor(3 * 5 / 15) = 2 at 30 % with a 25 % limit.
    const q = four();
    q.limits!.minFreeMemoryPct = 25;
    expect(L.loadSlotsFor(q, { freeMemoryPct: 30 }).slots).toBe(2);
  });

  it('state has loadSlots with the reason; show prints a LOAD line only when limited', () => {
    if (darwin) return;
    const t = L.state(four(), 0, { load: { freeMemoryPct: 20 } });
    expect(t.canStart).toBe(2);
    expect(t.loadSlots).toMatchObject({ slots: 2, max: 4, limited: true });
    expect(t.loadSlots!.text).toBe('2 of 4 slots: free memory 20 % (all slots from 40 %)');
    expect(L.state(four(), 0, { load: { freeMemoryPct: 90 } }).loadSlots).toMatchObject({ limited: false });
    expect(L.state(four(), 0).loadSlots).toBeUndefined();
    const show = L.summaryView(four(), { load: { freeMemoryPct: 20 }, dailyUsage: 0 }).join('\n');
    expect(show).toContain('LOAD: 2 of 4 slots: free memory 20 %');
    expect(show).toMatch(/STARTABLE NOW \(2;/);
    expect(L.summaryView(four(), { load: { freeMemoryPct: 90 }, dailyUsage: 0 }).join('\n')).not.toContain('LOAD:');
  });
});

// ---- queue.mjs next and fill against a copy -----------------------------------------------------------------------

describe('queue.mjs: load-aware next and fill', () => {
  const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
  const ID = ['-c', 'user.name=queue-test', '-c', 'user.email=queue-test@example.invalid'];
  const temporary: string[] = [];
  afterAll(() => temporary.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

  function setup() {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-loadslots-'));
    temporary.push(folder);
    const repo = path.join(folder, 'repo');
    fs.mkdirSync(repo);
    const g = (args: string[]) =>
      execFileSync('git', ['-C', repo, ...ID, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    g(['init', '-q', '-b', 'main']);
    fs.writeFileSync(path.join(repo, 'README.md'), 'start\n');
    g(['add', '--', 'README.md']);
    g(['commit', '-q', '-m', 'start']);
    fs.writeFileSync(path.join(folder, 'queue.json'), JSON.stringify({ ...four(), next_migr: 100 }));
    // Fixed settings so the test is the same on every platform.
    const configFile = path.join(folder, 'queue.config.json');
    fs.writeFileSync(configFile, JSON.stringify({ loadGuard: { minFreeMemoryPct: 10, allSlotsFreeMemoryPct: 40 } }));
    fs.mkdirSync(path.join(folder, 'docs'));
    fs.copyFileSync(path.join(ROOT, 'docs', 'mission-template.md'), path.join(folder, 'docs', 'mission-template.md'));
    const run = (args: string[], load: string, extra: Record<string, string> = {}) => {
      const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'orchestrator', 'queue.mjs'), ...args], {
        encoding: 'utf8',
        env: {
          ...process.env,
          QUEUE_FOLDER: folder,
          QUEUE_CONFIG: configFile,
          QUEUE_ROOT: folder,
          QUEUE_GIT: repo,
          QUEUE_TIME_LOG: path.join(folder, 'times.jsonl'),
          QUEUE_TRANSCRIPTS: path.join(folder, 'transcripts'),
          QUEUE_LOAD: load,
          ...extra,
        },
      });
      return { code: r.status, out: r.stdout ?? '', error: r.stderr ?? '' };
    };
    const running = () =>
      (JSON.parse(fs.readFileSync(path.join(folder, 'queue.json'), 'utf8')) as Queue).tasks.filter(
        (x) => x.status === 'running',
      ).length;
    return { folder, run, running, scratch: path.join(folder, 'scratch') };
  }

  it('next proposes 2 of 4 at 20 % free memory and says why; QUEUE_LOAD_ADAPTIVE=off gives all 4', () => {
    const { run } = setup();
    const r = run(['next'], 'free=20');
    expect(r.code).toBe(0);
    expect(r.out).toContain('LOAD: 2 of 4 slots: free memory 20 % (all slots from 40 %)');
    expect(r.out.split('\n').filter((l) => /^[A-D] /.test(l)).length).toBe(2);
    const off = run(['next'], 'free=20', { QUEUE_LOAD_ADAPTIVE: 'off' });
    expect(off.out).not.toContain('LOAD:');
    expect(off.out.split('\n').filter((l) => /^[A-D] /.test(l)).length).toBe(4);
    const free = run(['next'], 'free=60');
    expect(free.out).not.toContain('LOAD:');
    expect(free.out.split('\n').filter((l) => /^[A-D] /.test(l)).length).toBe(4);
  });

  it('fill starts 2 under load, then none while they run, and --over-load starts the rest', () => {
    const { run, running, scratch } = setup();
    const f = run(['fill', '--scratchpad', scratch], 'free=20');
    expect(f.error).toBe('');
    expect(f.code).toBe(0);
    expect(f.out).toContain('LOAD: 2 of 4 slots');
    expect(running()).toBe(2);
    const again = run(['fill', '--scratchpad', scratch], 'free=20');
    expect(again.out).toMatch(/Nothing can start now/);
    expect(again.out).toContain('LOAD: 2 of 4 slots');
    expect(running()).toBe(2);
    expect(run(['fill', '--scratchpad', scratch, '--over-load'], 'free=20').code).toBe(0);
    expect(running()).toBe(4);
    // Three fills, each running make-queue-common and make-mission: slow on a loaded machine.
  }, 180_000);

  it('state shows loadSlots; limit shows the slots now', () => {
    const { run } = setup();
    const s = JSON.parse(run(['state'], 'free=20').out) as { loadSlots?: { text: string } };
    expect(s.loadSlots?.text).toBe('2 of 4 slots: free memory 20 % (all slots from 40 %)');
    expect(run(['limit'], 'free=20').out).toContain('slots now: 2 of 4 slots: free memory 20 %');
  });
});

describe('the fix task for a red base goes ahead of the slots (test round 2: M14)', () => {
  const base = (over: Record<string, unknown> = {}) => task('BASE-1', { added_by: 'base gate', value: 10, ...over });
  const review = (id: string) => task(id, { status: 'review' });
  const queue = (tasks: unknown[], max = 2) => ({ tasks, limits: { maxConcurrent: max, maxDPlus: 2, maxPerDomain: 7, maxDb: 6, minFreeMemoryPct: 10 }, resolved: [] });
  it('deliveries that cannot merge hold every slot: the fix task still starts, and nothing else does', () => {
    const ids = L.selectNext(queue([review('R0'), review('R1'), task('A'), base()]) as never).map((v) => v.id);
    expect(ids).toEqual(['BASE-1']);
  });
  it('also when the load has closed the slots, and for the fix task from the CI watch', () => {
    const q = queue([task('A'), base()], 5);
    if (!darwin) expect(L.selectNext(q as never, Date.now(), { load: { freeMemoryPct: 11 } }).map((v) => v.id)).toContain('BASE-1');
    const ci = queue([review('R0'), review('R1'), task('CI-1', { added_by: 'ci watch' })]);
    expect(L.selectNext(ci as never).map((v) => v.id)).toEqual(['CI-1']);
  });
  it('an ordinary task of the same value still waits for a slot', () => {
    const q = queue([review('R0'), review('R1'), task('A', { value: 10 })]);
    expect(L.selectNext(q as never)).toEqual([]);
  });
});
