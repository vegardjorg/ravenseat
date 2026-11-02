// =============================================================
// gateEvidence.test.ts: the trusted gate evidence (lib/gateEvidence.js).
//
// Locks: (1) an entry needs a quick or full run, a real sha and a known cleanliness; (2) evidence for a commit is the
// NEWEST clean entry for exactly that sha that ran every needed command (a later red beats an earlier green, a dirty
// run, another sha, another kind or a missing command is no evidence); (3) the store survives a missing or broken file
// and keeps at most MAX_ENTRIES; (4) the full-gate verdict is "off" without full gates; (5) the push guard's tamper rule
// hits the store file and --evidence/--cwd on the gate runner, not other commands that mention gates.
// =============================================================
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as GE from '../gateEvidence';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const temporary: string[] = [];
afterAll(() => {
  for (const d of temporary) fs.rmSync(d, { recursive: true, force: true });
});

const e = (x: Record<string, unknown> = {}) =>
  GE.entry({ kind: 'quick', sha: A, clean: true, exit: 0, gates: ['npm test'], time: 't1', ...x } as never);

describe('entry', () => {
  it('only quick or full runs with a sha and a known cleanliness', () => {
    expect(e()).toMatchObject({ by: 'gates.mjs', sha: A, kind: 'quick', ok: true, clean: true, gates: ['npm test'], main_tree: false });
    expect(e({ exit: 1, failed: ['npm test'], timedOut: true })).toMatchObject({ ok: false, failed: ['npm test'], timed_out: true });
    expect(e({ kind: 'precheck' })).toBeNull();
    expect(e({ sha: null })).toBeNull();
    expect(e({ sha: 'HEAD' })).toBeNull();
    expect(e({ clean: undefined })).toBeNull();
  });
});

describe('latest and verdict', () => {
  const cmds = ['npm test'];
  it('the newest clean entry for exactly the sha that ran every command', () => {
    const list = [e({ time: '1' }), e({ time: '2', exit: 1 })];
    expect(GE.latest(list, { sha: A, commands: cmds })?.time).toBe('2');
    expect(GE.verdict(list, { sha: A, commands: cmds })).toBe('red');
    expect(GE.verdict([...list, e({ time: '3' })], { sha: A, commands: cmds })).toBe('green');
    expect(GE.verdict([e({ clean: false })], { sha: A, commands: cmds })).toBe('missing');
    expect(GE.verdict([e()], { sha: B, commands: cmds })).toBe('missing');
    expect(GE.verdict([e()], { sha: A, kinds: ['full'], commands: cmds })).toBe('missing');
    expect(GE.verdict([e()], { sha: A, commands: ['npm test', 'npm run lint'] })).toBe('missing');
    expect(GE.verdict([e({ gates: ['npm test', 'npm run lint'] })], { sha: A, commands: cmds })).toBe('green');
    expect(GE.verdict([e()], { sha: A, commands: [] })).toBe('off');
    expect(GE.latest([e()], { sha: null, commands: cmds })).toBeNull();
  });
});

describe('the store', () => {
  it('reads missing and broken files as empty, appends atomically and keeps the newest MAX_ENTRIES', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cq-gate-evidence-'));
    temporary.push(dir);
    const file = GE.storeFile(dir);
    expect(path.basename(file)).toBe('gate-evidence.json');
    expect(GE.readStore(file).entries).toEqual([]);
    fs.writeFileSync(file, '{broken');
    expect(GE.readStore(file).entries).toEqual([]);
    expect(GE.append(file, e())).toBe(true);
    expect(GE.append(file, null)).toBe(false);
    expect(GE.readStore(file).entries).toHaveLength(1);
    let store = GE.readStore(file);
    for (let i = 0; i < GE.MAX_ENTRIES + 5; i++) store = GE.add(store, e({ time: String(i) }));
    expect(store.entries).toHaveLength(GE.MAX_ENTRIES);
    expect(store.entries.at(-1)?.time).toBe(String(GE.MAX_ENTRIES + 4));
  });
  it('fullGateVerdict: off without full gates, missing without a store, green with a clean full run', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cq-gate-evidence-'));
    temporary.push(dir);
    const cfg = { gates: { full: ['npm run all'] } };
    expect(GE.fullGateVerdict({ folder: dir, sha: A, cfg: { gates: { full: [] } } })).toBe('off');
    expect(GE.fullGateVerdict({ folder: dir, sha: A, cfg })).toBe('missing');
    GE.append(GE.storeFile(dir), e({ kind: 'full', gates: ['npm run all'] }));
    expect(GE.fullGateVerdict({ folder: dir, sha: A, cfg })).toBe('green');
    expect(GE.fullGateVerdict({ folder: dir, sha: B, cfg })).toBe('missing');
  });
});

describe('tamperReason', () => {
  it('hits the store and --evidence/--cwd on the gate runner only', () => {
    expect(GE.tamperReason('cat scripts/.queue/gate-evidence.json')).toMatch(/only by the orchestrator/);
    expect(GE.tamperReason('node scripts/orchestrator/gates.mjs --quick --evidence')).toMatch(/without --evidence and --cwd/);
    expect(GE.tamperReason('node "C:/p/cq.mjs" gates --full --cwd ..')).toMatch(/without --evidence/);
    expect(GE.tamperReason('cq gates --quick --evidence')).toMatch(/without --evidence/);
    expect(GE.tamperReason('node scripts/orchestrator/gates.mjs --quick --log x')).toBeNull();
    expect(GE.tamperReason('git commit -m "gates --cwd docs"')).toBeNull();
    expect(GE.tamperReason('node tool.mjs --cwd x')).toBeNull();
    expect(GE.tamperReason(undefined as never)).toBeNull();
  });
});
