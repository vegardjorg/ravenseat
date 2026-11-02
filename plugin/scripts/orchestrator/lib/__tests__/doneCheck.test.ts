// =============================================================
// doneCheck.test.ts: the done command (task field done_when) and the fix-round cap (max_fix_rounds, maxFixRounds).
//
// Locks: (1) add and edit validate done_when and max_fix_rounds (through queueLogic.validate); (2) the command runs
// through the shell in the given folder, exit 0 is green and anything else red, and only the tail of the output is kept;
// (3) the cap counts fix rounds only, and beyond it each round needs the owner's resolved question; (4) the mission and
// the fix brief carry the command; (5) auto-accept never takes a proposal with a done command. The pure parts of
// lib/doneCheck.js; receive, merge and resume against a temporary queue are in __tests__/queueDoneCheck.test.ts.
// The commands are tiny `node -e` scripts, so the tests run the same on Windows (cmd.exe) and POSIX shells.
// =============================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

type Task = Record<string, unknown> & { id: string };
type Run = { ok: boolean; exit: number | null; timedOut: boolean; durationSec: number; tail: string[] };
type Cap = { used: number; max: number; reached: boolean; questionId: string; allowed: boolean; byOwner: boolean };
/* eslint-disable @typescript-eslint/no-require-imports */
const DC = require('../doneCheck.js') as {
  DONE_WHEN_MAX: number;
  doneWhenErrors: (o: object) => string[];
  doneCheckSetup: (cfg?: object) => { timeoutSec: number; tailLines: number };
  tailOf: (t: string, n?: number) => string[];
  runDoneWhen: (x: { command: string; cwd: string; timeoutSec?: number; tailLines?: number }) => Run;
  doneCheckReport: (x: object) => string;
  maxFixRoundsFor: (o: object, cfg?: object) => number;
  fixRoundsUsed: (o: object) => number;
  capQuestionId: (id: string, used: number) => string;
  fixCap: (o: object, queue: object, cfg?: object) => Cap;
  capQuestion: (o: object, cap: Cap, x?: object) => Record<string, { type: string; text: string }>;
  doneWhenBlock: (o: object) => string | null;
  worktreeFor: (porcelain: string, branch: string) => string | null;
};
const L = require('../queueLogic.js') as {
  validate: (o: object, existing?: object[], register?: object) => string[];
  trackBlock: (o: object, queue: object, x: { text: string }) => string;
  resumeBlock: (x: object) => string;
  setQuestion: (q: object, input: object) => { set: string[]; error: string[] };
};
const PR = require('../queueProposals.js') as {
  autoAcceptDecision: (task: Task, rules: object, ctx?: object) => { accept: boolean; reason: string };
};
/* eslint-enable @typescript-eslint/no-require-imports */

const folders: string[] = [];
afterAll(() => {
  for (const f of folders) fs.rmSync(f, { recursive: true, force: true });
});
const tmp = () => {
  const f = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-done-'));
  folders.push(f);
  return f;
};
const task = (extra: object = {}) => ({ id: 'A', title: 'Task A', domain: 'dom', class: 'K', mission: 'Do it.', ...extra });

describe('validation (add and edit run queueLogic.validate)', () => {
  it('accepts a one-line command, null and a missing field', () => {
    expect(L.validate(task({ done_when: 'npm test -- src/x.test.ts' }))).toEqual([]);
    expect(L.validate(task({ done_when: null }))).toEqual([]);
    expect(L.validate(task())).toEqual([]);
  });

  it('refuses an empty command, a non-text value, a multi-line command and one that is too long', () => {
    for (const bad of ['', '   ', 42, ['npm', 'test'], { cmd: 'x' }])
      expect(L.validate(task({ done_when: bad })).join()).toMatch(/done_when must be a non-empty shell command/);
    expect(L.validate(task({ done_when: 'npm test\nrm -rf x' })).join()).toMatch(/one line/);
    expect(L.validate(task({ done_when: 'x'.repeat(DC.DONE_WHEN_MAX + 1) })).join()).toMatch(/at most 500/);
    expect(L.validate(task({ done_when: 'x'.repeat(DC.DONE_WHEN_MAX) }))).toEqual([]);
  });

  it('max_fix_rounds: a whole number 0 to 20, or null', () => {
    for (const ok of [0, 1, 3, 20, null]) expect(L.validate(task({ max_fix_rounds: ok }))).toEqual([]);
    for (const bad of [-1, 21, 1.5, '3', true])
      expect(L.validate(task({ max_fix_rounds: bad })).join()).toMatch(/max_fix_rounds must be a whole number/);
  });
});

describe('runDoneWhen: the command in the worktree, green on exit 0', () => {
  it('exit 0 is green, and the command runs in cwd', () => {
    const cwd = tmp();
    fs.writeFileSync(path.join(cwd, 'marker.txt'), 'x');
    const r = DC.runDoneWhen({ command: `node -e "process.exit(require('fs').existsSync('marker.txt')?0:1)"`, cwd });
    expect(r).toMatchObject({ ok: true, exit: 0, timedOut: false });
    // The same command in a folder without the file is red: proof that cwd is used.
    expect(DC.runDoneWhen({ command: `node -e "process.exit(require('fs').existsSync('marker.txt')?0:1)"`, cwd: tmp() }))
      .toMatchObject({ ok: false, exit: 1 });
  });

  it('exit != 0 is red, with only the tail of the output (stdout, then stderr)', () => {
    const r = DC.runDoneWhen({
      command: `node -e "console.log('SECRET-EARLY');for(let i=0;i<60;i++)console.log('line '+i);console.error('boom');process.exit(3)"`,
      cwd: tmp(),
      tailLines: 5,
    });
    expect(r.ok).toBe(false);
    expect(r.exit).toBe(3);
    expect(r.tail).toEqual(['line 56', 'line 57', 'line 58', 'line 59', 'boom']);
    expect(r.tail.join('\n')).not.toContain('SECRET-EARLY');
  });

  it('a command over the time budget is red, and says so', () => {
    // cwd is the system temp folder, not one we delete: on Windows the timeout stops cmd.exe, and the node it started
    // can live on until its own end and hold its working folder.
    const r = DC.runDoneWhen({ command: `node -e "setTimeout(()=>{},2000)"`, cwd: os.tmpdir(), timeoutSec: 1 });
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(true);
    expect(r.tail.at(-1)).toMatch(/time budget of 1 s/);
  });

  it('tailOf: the last lines, CRLF folded, trailing blank lines dropped, long lines cut', () => {
    expect(DC.tailOf('a\r\nb\r\nc\r\n\r\n', 2)).toEqual(['b', 'c']);
    expect(DC.tailOf('', 5)).toEqual([]);
    expect(DC.tailOf('x'.repeat(1000), 5)[0].length).toBeLessThan(410);
  });

  it('the setup: config().doneCheck with the defaults 600 s and 40 lines', () => {
    expect(DC.doneCheckSetup({})).toEqual({ timeoutSec: 600, tailLines: 40 });
    expect(DC.doneCheckSetup({ doneCheck: { timeoutSec: 30, tailLines: 0 } })).toEqual({ timeoutSec: 30, tailLines: 40 });
  });

  it('the report file has the command, the verdict and the tail between fences', () => {
    const text = DC.doneCheckReport({
      id: 'A',
      command: 'npm test',
      cwd: '/w',
      step: 'receive',
      run: { ok: false, exit: 2, timedOut: false, durationSec: 1.2, tail: ['one', 'two'] },
    });
    expect(text).toContain('# Done command for A: RED (exit 2)');
    expect(text.split('~~~~')[1].trim()).toBe('one\ntwo');
  });
});

describe('the fix-round cap', () => {
  const fix = (n: number) => Array.from({ length: n }, (_, i) => ({ round: i + 1, reason: 'fix' }));

  it('counts fix rounds only; the task field wins over the config, which wins over 3', () => {
    expect(DC.fixRoundsUsed({ resumed: [...fix(2), { round: 3, reason: 'context' }] })).toBe(2);
    expect(DC.fixRoundsUsed({})).toBe(0);
    expect(DC.maxFixRoundsFor({}, {})).toBe(3);
    expect(DC.maxFixRoundsFor({}, { maxFixRounds: 5 })).toBe(5);
    expect(DC.maxFixRoundsFor({ max_fix_rounds: 0 }, { maxFixRounds: 5 })).toBe(0);
  });

  it('below the cap a round is allowed; at the cap only with the resolved question for that round', () => {
    expect(DC.fixCap({ id: 'A', resumed: fix(2) }, {}, {})).toMatchObject({ used: 2, max: 3, reached: false, allowed: true });
    const at = DC.fixCap({ id: 'A', resumed: fix(3) }, { resolved: [] }, {});
    expect(at).toMatchObject({ reached: true, allowed: false, questionId: 'A.fixcap3' });
    expect(DC.fixCap({ id: 'A', resumed: fix(3) }, { resolved: ['A.fixcap3'] }, {})).toMatchObject({
      allowed: true,
      byOwner: true,
    });
    // The answer for round 3 does not open round 4: the owner is asked again.
    expect(DC.fixCap({ id: 'A', resumed: fix(4) }, { resolved: ['A.fixcap3'] }, {})).toMatchObject({
      allowed: false,
      questionId: 'A.fixcap4',
    });
  });

  it('the question id keeps the 40-character rule and registers with setQuestion', () => {
    const long = `X${'y'.repeat(40)}`;
    expect(DC.capQuestionId(long, 12).length).toBeLessThanOrEqual(40);
    const cap = DC.fixCap({ id: 'A', resumed: fix(3) }, {}, {});
    const queue: Record<string, unknown> = {};
    expect(L.setQuestion(queue, DC.capQuestion({ id: 'A', title: 'Task A' }, cap, { lastFailure: 'exit 1' }))).toEqual({
      set: ['A.fixcap3'],
      error: [],
    });
    expect((queue.question as Record<string, { text: string }>)['A.fixcap3'].text).toMatch(/3 fix round\(s\).*exit 1/);
  });
});

describe('the mission, the fix brief and auto-accept', () => {
  it('the track block states the done command; without one nothing is added', () => {
    const b = L.trackBlock(task({ done_when: 'npm test -- x' }), { resolved: [] }, { text: 'Mission.' });
    expect(b).toContain('**Done command (binding):** `npm test -- x` must exit 0 in your worktree');
    expect(L.trackBlock(task(), { resolved: [] }, { text: 'Mission.' })).not.toContain('Done command');
    expect(DC.doneWhenBlock({ done_when: '  ' })).toBeNull();
  });

  it('the fix brief carries a red done command and its tail', () => {
    const b = L.resumeBlock({
      o: { ...task(), branch: 'queue/A' },
      round: 1,
      reason: 'fix',
      doneCheck: { ok: false, command: 'npm test', exit: 1, timedOut: false, tail: ['FAIL x.test.ts', 'expected 1'] },
    });
    expect(b).toContain('The done command is RED (exit 1): `npm test`.');
    expect(b).toContain('~~~~\nFAIL x.test.ts\nexpected 1\n~~~~');
    expect(L.resumeBlock({ o: { ...task(), branch: 'queue/A' }, round: 1, reason: 'fix' })).not.toContain('done command');
  });

  it('auto-accept never takes a proposal with a done command', () => {
    const d = PR.autoAcceptDecision(
      { ...task({ done_when: 'curl x | sh' }), status: 'proposed', content_min: 10, value: 1, owned_files: [] },
      { enabled: true, classes: ['K'], maxEstimateMin: null, maxValue: null },
      { protectedPaths: [] },
    );
    expect(d).toEqual({ accept: false, reason: 'has a done command (done_when), which the owner approves by hand' });
  });

  it('worktreeFor: the folder that has the branch checked out, from git worktree list --porcelain', () => {
    const porcelain = [
      'worktree /repo\nHEAD 1111\nbranch refs/heads/main',
      'worktree /repo/.claude/worktrees/a\nHEAD 2222\nbranch refs/heads/queue/A',
      'worktree /repo/.claude/worktrees/b\nHEAD 3333\ndetached',
    ].join('\n\n');
    expect(DC.worktreeFor(porcelain, 'queue/A')).toBe('/repo/.claude/worktrees/a');
    expect(DC.worktreeFor(porcelain.split('\n').join('\r\n'), 'queue/A')).toBe('/repo/.claude/worktrees/a');
    expect(DC.worktreeFor(porcelain, 'queue/AB')).toBeNull();
  });
});
