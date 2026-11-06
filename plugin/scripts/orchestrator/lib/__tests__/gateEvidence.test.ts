// =============================================================
// gateEvidence.test.ts: the trusted gate evidence (lib/gateEvidence.js).
//
// Locks: (1) an entry needs a quick or full run, a real sha and a known cleanliness; (2) evidence for a commit is the
// NEWEST clean entry for exactly that sha that ran every needed command (a later red beats an earlier green, a dirty
// run, another sha, another kind or a missing command is no evidence); (3) the store survives a missing or broken file
// and keeps at most MAX_ENTRIES; (4) the full-gate verdict is "off" without full gates; (5) the push guard's tamper rule
// hits the store file and --evidence/--cwd on the gate runner, not other commands that mention gates; (6) a new entry has
// an id, writer "orchestrator" and the setup hash, the setup hash is stable and changes with any gate change, a changed
// setup is no evidence for the same sha (history kept), legacy entries read and count only where legacy is allowed, an
// entry with another writer never counts; (7) recordRun drops a change made to the store during the run and records red.
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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ravenseat-gate-evidence-'));
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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ravenseat-gate-evidence-'));
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
    expect(GE.tamperReason('node "C:/p/ravenseat.mjs" gates --full --cwd ..')).toMatch(/without --evidence/);
    expect(GE.tamperReason('ravenseat gates --quick --evidence')).toMatch(/without --evidence/);
    expect(GE.tamperReason('node scripts/orchestrator/gates.mjs --quick --log x')).toBeNull();
    expect(GE.tamperReason('git commit -m "gates --cwd docs"')).toBeNull();
    expect(GE.tamperReason('node tool.mjs --cwd x')).toBeNull();
    expect(GE.tamperReason(undefined as never)).toBeNull();
  });
});

describe('setup hash, writer and legacy entries', () => {
  const cmds = ['npm test'];
  const S1 = GE.setupHash({ quick: ['npm test'], full: ['npm run all'] });
  it('setupHash is stable for the same commands and changes with any change', () => {
    expect(S1).toMatch(/^[0-9a-f]{64}$/);
    expect(GE.setupHash({ quick: [' npm test '], full: ['npm run all', ''] })).toBe(S1);
    expect(GE.setupHash({ quick: ['npm test', 'npm run lint'], full: ['npm run all'] })).not.toBe(S1);
    expect(GE.setupHash({ quick: ['npm test'], full: [] })).not.toBe(S1);
    expect(GE.setupHash({ quick: ['a', 'b'] })).not.toBe(GE.setupHash({ quick: ['b', 'a'] }));
    expect(GE.setupHash(undefined)).toBe(GE.setupHash({}));
  });

  it('a new entry has an id, writer "orchestrator" and the setup hash', () => {
    const x = e({ setupHash: S1 });
    expect(x).toMatchObject({ writer: 'orchestrator', setup_hash: S1, by: 'gates.mjs' });
    expect(x?.id).toMatch(/^ge-/);
    expect(e()?.id).not.toBe(e()?.id);
    expect(e({ tampered: true })).toMatchObject({ ok: false, tampered: true });
  });

  it('the same sha with a changed setup is no evidence; the old entry stays as history', () => {
    const S2 = GE.setupHash({ quick: ['npm test', 'npm run lint'], full: ['npm run all'] });
    const list = [e({ setupHash: S1, time: '1' })];
    expect(GE.verdict(list, { sha: A, commands: cmds, setupHash: S1, legacy: false })).toBe('green');
    expect(GE.verdict(list, { sha: A, commands: cmds, setupHash: S2, legacy: false })).toBe('missing');
    expect(GE.verdict(list, { sha: A, commands: cmds, setupHash: S2 })).toBe('missing');
    // A run on the new setup is appended; both stay.
    const store = GE.add({ version: 1, entries: list }, e({ setupHash: S2, time: '2', exit: 1 }));
    expect(store.entries).toHaveLength(2);
    expect(GE.verdict(store.entries, { sha: A, commands: cmds, setupHash: S2 })).toBe('red');
    expect(GE.verdict(store.entries, { sha: A, commands: cmds, setupHash: S1 })).toBe('green');
  });

  it('legacy entries read and count only where legacy is allowed; another writer never counts', () => {
    const legacy = { time: 't', by: 'gates.mjs', sha: A, kind: 'quick', ok: true, exit: 0, clean: true, gates: cmds, failed: [] };
    expect(GE.isLegacy(legacy)).toBe(true);
    expect(GE.isLegacy(e())).toBe(false);
    expect(GE.verdict([legacy], { sha: A, commands: cmds })).toBe('green');
    expect(GE.verdict([legacy], { sha: A, commands: cmds, setupHash: S1 })).toBe('green');
    expect(GE.verdict([legacy], { sha: A, commands: cmds, setupHash: S1, legacy: false })).toBe('missing');
    expect(GE.verdict([legacy], { sha: A, commands: cmds, legacy: false })).toBe('missing');
    const track = { ...legacy, writer: 'track' };
    expect(GE.verdict([track], { sha: A, commands: cmds })).toBe('missing');
    expect(GE.verdict([{ ...track, setup_hash: S1 }], { sha: A, commands: cmds, setupHash: S1 })).toBe('missing');
    // A legacy file on disk is read as it was written, and the push check still accepts a legacy full run.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ravenseat-gate-evidence-'));
    temporary.push(dir);
    fs.writeFileSync(GE.storeFile(dir), JSON.stringify({ version: 1, entries: [{ ...legacy, kind: 'full', gates: ['npm run all'] }] }));
    expect(GE.readStore(GE.storeFile(dir)).entries[0]).toMatchObject({ sha: A, kind: 'full' });
    expect(GE.fullGateVerdict({ folder: dir, sha: A, cfg: { gates: { full: ['npm run all'] } } })).toBe('green');
    // An orchestrator full run for an older setup does not count for the push check.
    GE.append(GE.storeFile(dir), e({ kind: 'full', gates: ['npm run all'], setupHash: GE.setupHash({ full: ['old'] }) }));
    expect(GE.fullGateVerdict({ folder: dir, sha: A, cfg: { gates: { full: ['npm run all'] } } })).toBe('green');
    GE.append(GE.storeFile(dir), e({ kind: 'full', gates: ['npm run all'], exit: 1, setupHash: GE.setupHash({ full: ['npm run all'] }) }));
    expect(GE.fullGateVerdict({ folder: dir, sha: A, cfg: { gates: { full: ['npm run all'] } } })).toBe('red');
  });

  it('recordRun appends when the store did not change, and drops a change made during the run', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ravenseat-gate-evidence-'));
    temporary.push(dir);
    const file = GE.storeFile(dir);
    GE.append(file, e({ time: 'old', setupHash: S1 }));
    const before = GE.readStoreText(file);
    expect(GE.recordRun({ file, before, entry: e({ time: 'run1', setupHash: S1 }) })).toEqual({ recorded: true, tampered: false });
    expect(GE.readStore(file).entries.map((x) => x.time)).toEqual(['old', 'run1']);

    // A "gate" writes a forged green entry during the next run: dropped, and the run is red (tampered).
    const before2 = GE.readStoreText(file);
    GE.append(file, { ...e({ time: 'forged', setupHash: S1 }), sha: B } as never);
    expect(GE.recordRun({ file, before: before2, entry: e({ time: 'run2', setupHash: S1 }) })).toEqual({ recorded: true, tampered: true });
    const after = GE.readStore(file).entries;
    expect(after.map((x) => x.time)).toEqual(['old', 'run1', 'run2']);
    expect(after.at(-1)).toMatchObject({ ok: false, tampered: true });
    expect(GE.verdict(after, { sha: B, commands: cmds })).toBe('missing');

    // A store that did not exist before and was created during the run is dropped too.
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ravenseat-gate-evidence-'));
    temporary.push(dir2);
    const file2 = GE.storeFile(dir2);
    GE.append(file2, e({ time: 'forged' }));
    expect(GE.recordRun({ file: file2, before: null, entry: e({ time: 'run' }) }).tampered).toBe(true);
    expect(GE.readStore(file2).entries.map((x) => x.time)).toEqual(['run']);
    expect(GE.recordRun({ file: file2, before: null, entry: null })).toEqual({ recorded: false, tampered: false });
  });
});
