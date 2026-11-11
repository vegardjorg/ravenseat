// =============================================================
// trackFlaky.test.ts: the pure part of the flaky check on a track's gate (lib/trackFlaky.js): the switch, when a red
// run may rerun its red commands, the outcome of the rerun (with lib/baseHealth.js flakyResult), how often a command was
// flaky on the same track, and the lines receive and the review package show.
//
// Why: one flaky red on a track's quick gate cost a whole fix round with a new agent, without anything wrong in the code.
// The rerun must never turn a real red, another commit or a dirty tree into green, and it runs at most once.
// =============================================================
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const TF = require('../trackFlaky.js');

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

describe('setup', () => {
  it('on by default; gates.flakyRerun false turns it off', () => {
    expect(TF.setup({})).toEqual({ enabled: true });
    expect(TF.setup({ gates: { quick: ['x'] } })).toEqual({ enabled: true });
    expect(TF.setup({ gates: { flakyRerun: true } })).toEqual({ enabled: true });
    expect(TF.setup({ gates: { flakyRerun: false } })).toEqual({ enabled: false });
  });
});

describe('rerunPlan', () => {
  const base = { enabled: true, mainTree: false, failed: ['lint', 'test'], startSha: SHA, startClean: true };

  it('only the red commands, once each, in their order', () => {
    expect(TF.rerunPlan(base)).toEqual({ commands: ['lint', 'test'], reason: null });
    expect(TF.rerunPlan({ ...base, failed: ['test', 'test', ' '] })).toEqual({ commands: ['test'], reason: null });
  });

  it('nothing red: nothing to rerun and nothing to say', () => {
    expect(TF.rerunPlan({ ...base, failed: [] })).toEqual({ commands: [], reason: null });
  });

  it('no rerun when off, in the main checkout, without a commit or on a dirty tree, with the reason', () => {
    expect(TF.rerunPlan({ ...base, enabled: false })).toMatchObject({ commands: [], reason: expect.stringContaining('gates.flakyRerun') });
    expect(TF.rerunPlan({ ...base, mainTree: true })).toMatchObject({ commands: [], reason: expect.stringContaining('main checkout') });
    expect(TF.rerunPlan({ ...base, startSha: null })).toMatchObject({ commands: [], reason: expect.stringContaining('commit') });
    expect(TF.rerunPlan({ ...base, startClean: false })).toMatchObject({ commands: [], reason: expect.stringContaining('uncommitted') });
    expect(TF.rerunPlan({ ...base, startClean: undefined })).toMatchObject({ commands: [] });
  });
});

describe('outcome', () => {
  const first = { failed: ['test'], durationSec: 2 };

  it('green on the rerun, same commit, clean: green with flaky = the commands red the first time', () => {
    const r = TF.outcome({ first, rerun: { failed: [], durationSec: 1.5 }, startSha: SHA, after: { sha: SHA, clean: true } });
    expect(r).toMatchObject({ ok: true, flaky: ['test'], reason: null });
    expect(r.durationSec).toBe(3.5);
  });

  it('red again: red, never flaky', () => {
    const r = TF.outcome({ first, rerun: { failed: ['test'], durationSec: 1 }, startSha: SHA, after: { sha: SHA, clean: true } });
    expect(r.ok).toBe(false);
    expect(r.flaky).toBeUndefined();
    expect(r.reason).toContain('red again');
  });

  it('a green rerun on another commit or a dirty tree is red', () => {
    const moved = TF.outcome({ first, rerun: { failed: [], durationSec: 1 }, startSha: SHA, after: { sha: OTHER, clean: true } });
    expect(moved).toMatchObject({ ok: false, reason: expect.stringContaining('commit') });
    const dirty = TF.outcome({ first, rerun: { failed: [], durationSec: 1 }, startSha: SHA, after: { sha: SHA, clean: false } });
    expect(dirty).toMatchObject({ ok: false, reason: expect.stringContaining('uncommitted') });
    const unknown = TF.outcome({ first, rerun: { failed: [], durationSec: 1 }, startSha: SHA, after: { sha: null, clean: true } });
    expect(unknown.ok).toBe(false);
  });
});

describe('timesOnTrack', () => {
  const e = (track: string, flaky: string[], extra: Record<string, unknown> = {}) => ({
    id: `ge-${Math.random()}`,
    writer: 'orchestrator',
    track,
    kind: 'quick',
    ok: true,
    flaky,
    ...extra,
  });

  it('counts the trusted entries of the same track that name the command', () => {
    const entries = [e('A', ['test']), e('A', ['lint']), e('B', ['test']), e('A', ['test', 'lint']), e('A', ['test'], { writer: 'track' })];
    expect(TF.timesOnTrack(entries, { track: 'A', command: 'test' })).toBe(2);
    expect(TF.timesOnTrack(entries, { track: 'A', command: 'lint' })).toBe(2);
    expect(TF.timesOnTrack(entries, { track: 'B', command: 'lint' })).toBe(0);
    expect(TF.timesOnTrack([], { track: 'A', command: 'test' })).toBe(0);
  });
});

describe('the lines', () => {
  const record = { ok: true, tip: SHA, flaky: ['npm test'], flaky_times: { 'npm test': 2 } };

  it('receive: one FLAKY line per command, with the commit and how often on this track', () => {
    const lines = TF.summaryLines('A', record, { finding: 'F-3' });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('FLAKY A: `npm test`');
    expect(lines[0]).toContain(SHA.slice(0, 12));
    expect(lines[0]).toContain('2 times on this track');
    expect(lines[0]).toContain('F-3');
    expect(TF.summaryLines('A', { ok: true, tip: SHA })).toEqual([]);
    expect(TF.summaryLines('A', null)).toEqual([]);
  });

  it('the package section names the commands; none when nothing was flaky', () => {
    const s = TF.packageSection(record);
    expect(s).toContain('## Flaky gate commands');
    expect(s.join('\n')).toContain('`npm test`: red, then green on a rerun');
    expect(s.join('\n')).toContain('2 times on this track');
    expect(TF.packageSection({ ok: true, tip: SHA })).toEqual([]);
    expect(TF.packageSection(null)).toEqual([]);
  });
});
