// =============================================================
// renameRetrySites.test.ts: the atomic writes outside queue.json survive one refused rename (Windows EPERM).
//
// Why: on Windows a reader holding the target open for a moment (the board, an antivirus or indexer scan) makes a
// rename over it fail with EPERM. Each writer here goes through lib/stateFile.js renameWithRetry, so the first refusal is
// retried and the write lands. One writer per family: the plain node:fs writers (a spy on fs.renameSync refuses the
// first rename onto the target) and the writers that take an fs object (a copy of node:fs whose rename refuses once).
// lib/__tests__/renameGuard.test.ts keeps new raw renames out. Temporary folders only.
// =============================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import * as approvalWait from '../approvalWait';
import * as baseHealth from '../baseHealth';
import * as conflictPredict from '../conflictPredict';
import * as demoMode from '../demoMode';
import * as gateEvidence from '../gateEvidence';
import * as mergeLock from '../mergeLock';
import * as stateSnapshots from '../stateSnapshots';
import * as toolTrouble from '../toolTrouble';

const temporary: string[] = [];
afterAll(() => {
  for (const d of temporary) fs.rmSync(d, { recursive: true, force: true });
});
afterEach(() => vi.restoreAllMocks());
const tmpDir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ravenseat-rnm-'));
  temporary.push(d);
  return d;
};
const eperm = () => Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });

/** Makes node:fs refuse the first rename onto a path inside `folder`, then rename for real. Returns the refusal count. */
function refuseOnce(folder: string) {
  const real = fs.renameSync.bind(fs);
  const seen = { refused: 0 };
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (seen.refused === 0 && String(to).startsWith(folder)) {
      seen.refused++;
      throw eperm();
    }
    return real(from, to);
  });
  return seen;
}

const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));

describe('plain node:fs writers retry a refused rename', () => {
  it('baseHealth.writeState', () => {
    const d = tmpDir();
    const seen = refuseOnce(d);
    const file = path.join(d, 'base-health.json');
    baseHealth.writeState(file, { current: { ok: true } });
    expect(seen.refused).toBe(1);
    expect(readJson(file)).toEqual({ current: { ok: true } });
  });

  it('gateEvidence.writeStore', () => {
    const d = tmpDir();
    const seen = refuseOnce(d);
    const file = path.join(d, 'gate-evidence.json');
    gateEvidence.writeStore(file, { entries: [] });
    expect(seen.refused).toBe(1);
    expect(readJson(file)).toEqual({ entries: [] });
  });

  it('toolTrouble.write and approvalWait.write', () => {
    const d = tmpDir();
    let seen = refuseOnce(d);
    toolTrouble.write(d, { events: [] });
    expect(seen.refused).toBe(1);
    expect(readJson(path.join(d, toolTrouble.FILE))).toEqual({ events: [] });
    vi.restoreAllMocks();
    seen = refuseOnce(d);
    approvalWait.write(d, []);
    expect(seen.refused).toBe(1);
    expect(readJson(path.join(d, approvalWait.FILE))).toEqual([]);
  });

  it('the writers that swallow a failed write still land on a retry: conflictPredict, demoMode, mergeLock', () => {
    const d = tmpDir();
    let seen = refuseOnce(d);
    expect(conflictPredict.writeCache(path.join(d, 'conflicts.json'), { a: 1 })).toBe(true);
    expect(seen.refused).toBe(1);
    vi.restoreAllMocks();
    seen = refuseOnce(d);
    expect(demoMode.writeDismissed(d).ok).toBe(true);
    expect(seen.refused).toBe(1);
    expect(readJson(path.join(d, demoMode.OFFER_FILE)).dismissed).toBe(true);
    vi.restoreAllMocks();
    seen = refuseOnce(d);
    expect(mergeLock.writeState(d, { task: 'T-1', steps: [] })).toBe(true);
    expect(seen.refused).toBe(1);
    expect(readJson(mergeLock.stateFile(d, 'T-1')).task).toBe('T-1');
  });

  it('a lasting refusal still fails as before (writeState throws, writeCache returns false)', () => {
    const d = tmpDir();
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw eperm();
    });
    expect(() => baseHealth.writeState(path.join(d, 'b.json'), {})).toThrow(/EPERM/);
    expect(conflictPredict.writeCache(path.join(d, 'c.json'), {})).toBe(false);
  }, 20_000);
});

describe('writers that take an fs object retry a refused rename', () => {
  it('stateSnapshots.roll makes its first copy', () => {
    const d = tmpDir();
    const file = path.join(d, 'queue.json');
    fs.writeFileSync(file, '{"tasks":[]}\n');
    let refused = 0;
    const flaky = {
      ...fs,
      renameSync: (from: fs.PathLike, to: fs.PathLike) => {
        if (refused++ === 0) throw eperm();
        fs.renameSync(from, to);
      },
    };
    const tiers = stateSnapshots.tiersFrom({ tiers: stateSnapshots.DEFAULT_TIERS });
    const changed = stateSnapshots.roll(file, tiers, { fs: flaky });
    expect(refused).toBe(2);
    expect(changed).toEqual([tiers[0].name]);
    expect(readJson(stateSnapshots.copyPath(file, tiers[0].name))).toEqual({ tasks: [] });
  });
});
