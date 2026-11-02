// =============================================================
// baseHealth.test.ts: the pure parts of the base gate (lib/baseHealth.js).
//
// Locks: (1) the setup: on when there are commands (the quick gates by default, also in lite mode), off with
// enabled: false or without commands, sameAsQuick only for exactly the quick gates; (2) the verdict is per tip, a moved
// tip is unknown; (3) a red base refuses every merge except the fix task's and a forced one; (4) the skip rule needs the
// same tree AND a green, clean run of every base gate command on exactly the track tip; (5) the fix task id numbers on
// from the merged task (A-BASE1 -> A-BASE2) and the fix task has value 10, fixes, the base gate as done command and no
// output in its mission; (6) runBaseGate stops at the first red command; (7) the history is capped; (8) the screen
// excerpt keeps the error line of a long stack trace. The merge flow itself is in __tests__/queueBaseGate.test.ts.
// The commands are tiny `node -e` scripts (cmd.exe and POSIX shells read them the same).
// =============================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

type Entry = Record<string, unknown> & { tip: string; status: string };
type State = { current: Entry | null; history: Entry[] };
/* eslint-disable @typescript-eslint/no-require-imports */
const BH = require('../baseHealth.js') as {
  HISTORY_MAX: number;
  baseGateSetup: (cfg?: object) => { enabled: boolean; commands: string[]; sameAsQuick: boolean; timeoutSec: number; tailLines: number };
  readState: (file: string) => State;
  writeState: (file: string, s: State) => void;
  record: (s: State, e: Entry) => State;
  verdict: (s: State, tip: string) => string;
  mergeAllowed: (x: { state: State; tip: string; id: string; force?: boolean }) => { allow: boolean; forced: boolean };
  gateRows: (text: string) => object[];
  skipEvidence: (x: object) => { skip: boolean; reason: string };
  runBaseGate: (x: object) => { ok: boolean; failed: string | null; exit: number | null; tail: string[] };
  fixTaskId: (tasks: object[], x: { cause?: string | null; tip: string }) => string;
  fixTask: (x: object) => Record<string, unknown>;
  excerpt: (tail: string[], max?: number) => string[];
  healthLine: (x: object) => string | null;
};

const temporary: string[] = [];
afterAll(() => {
  for (const m of temporary) fs.rmSync(m, { recursive: true, force: true });
});

const T1 = 'a'.repeat(40);
const T2 = 'b'.repeat(40);

describe('baseGateSetup', () => {
  it('defaults to the quick gates, on when there are commands, off by switch or without commands', () => {
    expect(BH.baseGateSetup({ gates: { quick: ['npm test'] } })).toMatchObject({
      enabled: true,
      commands: ['npm test'],
      sameAsQuick: true,
      timeoutSec: 900,
      tailLines: 40,
    });
    expect(BH.baseGateSetup({ gates: { quick: [] } }).enabled).toBe(false);
    // Lite mode has no rule of its own: commands decide.
    expect(BH.baseGateSetup({ mode: 'lite', gates: { quick: [] } }).enabled).toBe(false);
    expect(BH.baseGateSetup({ mode: 'lite', gates: { quick: ['npm test'] } }).enabled).toBe(true);
    expect(BH.baseGateSetup({ gates: { quick: ['npm test'] }, baseGate: { enabled: false } }).enabled).toBe(false);
    const own = BH.baseGateSetup({
      gates: { quick: ['npm run lint'] },
      baseGate: { commands: ['npm run lint', ' npm test ', ''], timeoutSec: 60, tailLines: 7 },
      doneCheck: { tailLines: 3 },
    });
    expect(own).toMatchObject({ enabled: true, commands: ['npm run lint', 'npm test'], sameAsQuick: false, timeoutSec: 60, tailLines: 7 });
    // An explicit empty list turns it off even with quick gates; tailLines falls back to doneCheck.
    expect(BH.baseGateSetup({ gates: { quick: ['x'] }, baseGate: { commands: [] } }).enabled).toBe(false);
    expect(BH.baseGateSetup({ gates: { quick: ['x'] }, doneCheck: { tailLines: 3 } }).tailLines).toBe(3);
  });
});

describe('the state, the verdict and the guard', () => {
  it('is per tip; red refuses except the fix task and a forced merge; the history is capped', () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'basehealth-'));
    temporary.push(folder);
    const file = path.join(folder, 'base-health.json');
    expect(BH.readState(file)).toEqual({ current: null, history: [] });
    fs.writeFileSync(file, '{ broken');
    expect(BH.readState(file).current).toBeNull();
    let s = BH.record({ current: null, history: [] }, { tip: T1, status: 'red', fix_task: 'A-BASE1' });
    BH.writeState(file, s);
    s = BH.readState(file);
    expect(BH.verdict(s, T1)).toBe('red');
    expect(BH.verdict(s, T2)).toBe('unknown');
    expect(BH.mergeAllowed({ state: s, tip: T1, id: 'C' })).toMatchObject({ allow: false });
    expect(BH.mergeAllowed({ state: s, tip: T1, id: 'A-BASE1' })).toMatchObject({ allow: true, forced: false });
    expect(BH.mergeAllowed({ state: s, tip: T1, id: 'C', force: true })).toMatchObject({ allow: true, forced: true });
    // Unknown is not refused here: the caller checks first and asks again.
    expect(BH.mergeAllowed({ state: s, tip: T2, id: 'C' }).allow).toBe(true);
    for (let i = 0; i < BH.HISTORY_MAX + 5; i++) s = BH.record(s, { tip: String(i), status: 'green' });
    expect(s.history.length).toBe(BH.HISTORY_MAX);
    expect(s.current?.tip).toBe(String(BH.HISTORY_MAX + 4));
  });
});

describe('skipEvidence', () => {
  const rows = (extra: object = {}) => [
    { event: 'gate', kind: 'quick', sha: T2, ok: true, clean: true, gates: ['npm test'], time: 't', ...extra },
  ];
  const tree = (m: Record<string, string>) => (sha: string) => m[sha] ?? null;
  it('needs the same tree and a green clean run of every command on the track tip', () => {
    const same = tree({ [T1]: 'tree1', [T2]: 'tree1' });
    const base = { newTip: T1, trackTip: T2, treeOf: same, commands: ['npm test'] };
    expect(BH.skipEvidence({ ...base, rows: rows() }).skip).toBe(true);
    // A fast-forward (the new tip is the track tip) needs no tree lookup.
    expect(BH.skipEvidence({ ...base, newTip: T2, treeOf: () => null, rows: rows() }).skip).toBe(true);
    expect(BH.skipEvidence({ ...base, treeOf: tree({ [T1]: 'x', [T2]: 'y' }), rows: rows() }).skip).toBe(false);
    expect(BH.skipEvidence({ ...base, rows: rows({ ok: false }) }).skip).toBe(false);
    expect(BH.skipEvidence({ ...base, rows: rows({ clean: false }) }).skip).toBe(false);
    expect(BH.skipEvidence({ ...base, rows: rows({ clean: undefined }) }).skip).toBe(false);
    expect(BH.skipEvidence({ ...base, rows: rows({ sha: T1 }) }).skip).toBe(false);
    expect(BH.skipEvidence({ ...base, rows: rows({ kind: 'precheck' }) }).skip).toBe(false);
    expect(BH.skipEvidence({ ...base, commands: ['npm test', 'npm run e2e'], rows: rows() }).skip).toBe(false);
    expect(BH.gateRows('x\n{"event":"gate","sha":"s"}\n{"event":"start"}\n{broken "gate"')).toEqual([{ event: 'gate', sha: 's' }]);
  });
});

describe('the fix task', () => {
  it('numbers on from the merged task, has value 10, fixes, the done command and no output in the mission', () => {
    expect(BH.fixTaskId([], { cause: 'A', tip: T1 })).toBe('A-BASE1');
    expect(BH.fixTaskId([{ id: 'A-BASE1' }], { cause: 'A-BASE1', tip: T1 })).toBe('A-BASE2');
    expect(BH.fixTaskId([], { cause: null, tip: T1 })).toBe('BASE-aaaaaaa');
    expect(BH.fixTaskId([{ id: 'BASE-aaaaaaa' }], { tip: T1 })).toBe('BASE-aaaaaaa-2');
    expect(BH.fixTaskId([], { cause: 'X'.repeat(40), tip: T1 }).length).toBeLessThanOrEqual(41);
    const t = BH.fixTask({
      tasks: [],
      causeTask: { id: 'A', title: 'Task A', domain: 'api', feature: 'Login' },
      tip: T1,
      branch: 'main',
      commands: ['npm test', 'npm run lint'],
      tailFile: '/tmp/base-health-x.md',
      failed: 'npm test',
      project: 'web',
    });
    expect(t).toMatchObject({
      id: 'A-BASE1',
      class: 'K',
      domain: 'api',
      feature: 'Login',
      project: 'web',
      value: 10,
      fixes: ['A'],
      done_when: 'npm test && npm run lint',
      added_by: 'base gate',
    });
    expect(String(t.mission)).toContain(T1);
    expect(String(t.mission)).toContain('/tmp/base-health-x.md');
    const long = BH.fixTask({ tasks: [], tip: T1, branch: 'main', commands: ['x'.repeat(300), 'y'.repeat(300)], tailFile: 'f' });
    expect(long.done_when).toBeUndefined();
    expect(long.fixes).toBeUndefined();
    expect(long.domain).toBe('general');
  });
});

describe('runBaseGate', () => {
  it('runs the commands in order and stops at the first red one', () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'basehealth-run-'));
    temporary.push(folder);
    const marker = path.join(folder, 'third-ran');
    const r = BH.runBaseGate({
      commands: [
        'node -e "console.log(1)"',
        'node -e "console.log(\'boom\');process.exit(3)"',
        `node -e "require('fs').writeFileSync('third-ran','x')"`,
      ],
      cwd: folder,
      timeoutSec: 60,
      tailLines: 5,
    });
    expect(r).toMatchObject({ ok: false, exit: 3, failed: 'node -e "console.log(\'boom\');process.exit(3)"' });
    expect(r.tail).toContain('boom');
    expect(fs.existsSync(marker)).toBe(false);
    expect(BH.runBaseGate({ commands: ['node -e "process.exit(0)"'], cwd: folder, timeoutSec: 60 }).ok).toBe(true);
  });
});

describe('the lines', () => {
  it('keeps the error line of a long stack trace and says green, red or unknown in one line', () => {
    const tail = ['TypeError: x is not a function', ...Array.from({ length: 30 }, (_, i) => `    at frame ${i}`)];
    const e = BH.excerpt(tail);
    expect(e.length).toBeLessThanOrEqual(11);
    expect(e[0]).toBe('TypeError: x is not a function');
    expect(e).toContain('…');
    expect(e.at(-1)).toBe('    at frame 29');
    expect(BH.excerpt(['a', 'b'])).toEqual(['a', 'b']);
    const setup = { enabled: true };
    const now = Date.parse('2026-01-01T02:00:00Z');
    const at = '2026-01-01T00:00:00Z';
    const red = { current: { tip: T1, status: 'red', at, made_red_by: { task: 'B' }, fix_task: 'B-BASE1' }, history: [] };
    expect(BH.healthLine({ state: red, tip: T1, setup, branch: 'main', now })).toBe(
      'BASE main: RED at aaaaaaaaaaaa by the merge of B (2 h ago); fix task B-BASE1 (cq merge B-BASE1 is allowed). cq merge refuses other tracks.',
    );
    const green = { current: { tip: T1, status: 'green', at }, history: [] };
    expect(BH.healthLine({ state: green, tip: T1, setup, branch: 'main', now })).toBe('BASE main: GREEN at aaaaaaaaaaaa (checked 2 h ago).');
    expect(BH.healthLine({ state: green, tip: T2, setup, branch: 'main', now })).toContain('unknown at bbbbbbbbbbbb');
    expect(BH.healthLine({ state: { current: null, history: [] }, tip: T1, setup, branch: 'main' })).toContain('not checked yet');
    expect(BH.healthLine({ state: green, tip: T1, setup: { enabled: false }, branch: 'main' })).toBeNull();
  });
});

describe('mergePlan and executeMerge with the base-gate step', () => {
  const L = require('../queueLogic.js') as {
    mergePlan: (x: object) => { step: string[] };
    executeMerge: (x: object) => { ok: boolean; lines: string[] };
  };
  it('runs base-gate after the quick gates only when asked, and a red one does not stop done and fill', () => {
    const o = { id: 'A' };
    const plain = L.mergePlan({ o, files: [], migrations: { folder: null } });
    expect(plain.step).toEqual(['merge', 'gates', 'done', 'fill']);
    const plan = L.mergePlan({ o, files: [], migrations: { folder: null }, baseGate: true });
    expect(plan.step).toEqual(['merge', 'gates', 'base-gate', 'done', 'fill']);
    const ran: string[] = [];
    const res = L.executeMerge({
      o,
      plan,
      branch: 'queue/A',
      currentBranch: 'main',
      base: 'main',
      migrations: { folder: null },
      run: ({ step }: { step: string }) => {
        ran.push(step);
        return step === 'base-gate' ? { code: 1, out: '`npm test` exit 1' } : { code: 0, out: 'ok' };
      },
    });
    expect(res.ok).toBe(true);
    expect(ran).toEqual(['merge', 'gates', 'base-gate', 'done', 'fill']);
    expect(res.lines).toContain('base gate: RED, the base fix task is added: `npm test` exit 1');
  });
});
