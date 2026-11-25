// =============================================================
// storeRegister.test.ts: the family register (lib/store/families.js) is the one list of the files the queue writes,
// and the old hand lists read from it (LAGRING-1 leftovers, track rest3).
//
// Locks: (1) every file the scripts name in the data folder (path.join(FOLDER, '<name>') or
// path.join(dataFolder(), '<name>')) belongs to a family; (2) the owner log, the owner mark key, the guard registry and
// the GitHub write state take their file names from the register, never from a literal of their own; (3) the never-share
// list (lib/queueShare.js) refuses every family the register marks share "never", and a file name it refuses is
// "never" in the register too, so the two can no longer drift.
// =============================================================
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/* eslint-disable @typescript-eslint/no-require-imports */
const FAM = require('../store/families.js');
const QS = require('../queueShare.js');
const ORCH = path.resolve(__dirname, '..', '..');

/** The script files under the orchestrator folder (tests and node_modules left out). */
function scripts(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '__tests__' || e.name === 'node_modules' || e.name === 'demo-data') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) scripts(p, out);
    else if (/\.(?:m?js)$/.test(e.name)) out.push(p);
  }
  return out;
}

// A data folder path with a literal name: the cli's FOLDER, or a dataFolder() call of any module.
const DATA_JOIN = /path\.join\(\s*(?:FOLDER|(?:[A-Za-z_]+\.)?dataFolder\(\))\s*,\s*'([^'/]+)'/g;

describe('every file the queue names in the data folder is in the register', () => {
  it('path.join(FOLDER | dataFolder(), <name>) classifies as a family', () => {
    const unknown: string[] = [];
    let seen = 0;
    for (const file of scripts(ORCH)) {
      const text = fs.readFileSync(file, 'utf8');
      for (const m of text.matchAll(DATA_JOIN)) {
        seen++;
        if (!FAM.classify(m[1], false) && !FAM.classify(m[1], true)) unknown.push(`${m[1]} (${path.relative(ORCH, file)})`);
      }
    }
    // The scan must find the known writes, or it would pass on nothing.
    expect(seen).toBeGreaterThan(20);
    expect(unknown, 'add a family in lib/store/families.js').toEqual([]);
  });
});

describe('the hand lists read from the register', () => {
  it('the owner log, the owner mark key and the guard registry take their names from it', () => {
    expect(require('../ownerLog.js').FILE_NAME).toBe(FAM.family('owner-log').file);
    expect(require('../ownerMark.js').KEY_FILE).toBe(FAM.family('owner-mark-key').file);
    expect(require('../guardRegistry.js').DEFAULT_FILE).toBe(FAM.family('guards').file);
    expect(require('../queueConfig.js').STANDARD.inspection.registryFile).toBe(FAM.family('guards').file);
  });

  it('the guard registry family names the setting that moves it, and resolves it', () => {
    const f = FAM.family('guards');
    expect(f.pathSetting).toBe('inspection.registryFile');
    expect(FAM.treeFileOf('guards', {})).toBe(f.file);
    expect(FAM.treeFileOf('guards', { inspection: { registryFile: 'docs/guards.json' } })).toBe('docs/guards.json');
  });

  it('the GitHub write log and the outbound preview are families of their own, never shared', () => {
    expect(FAM.family('gh-write-ledger')).toMatchObject({ file: 'issue-reports.json', share: 'never', kind: 'doc' });
    expect(FAM.family('gh-outbound-preview')).toMatchObject({ file: 'outbound-preview.json', share: 'never' });
    expect(require('../ghOutbound.js').PREVIEW_FILE).toBe(FAM.family('gh-outbound-preview').file);
  });

  it.each([
    ['lib/ownerLog.js', 'owner-log.json'],
    ['lib/ownerMark.js', 'owner-mark.key'],
    ['lib/guardRegistry.js', '.ravenseat/guards.json'],
    ['lib/queueConfig.js', '.ravenseat/guards.json'],
    ['cli/ghWrite.mjs', 'issue-reports.json'],
    ['lib/ghOutbound.js', 'outbound-preview.json'],
  ])('%s has no literal %s in code', (rel, name) => {
    // Comments may name the file; code must not.
    const code = fs
      .readFileSync(path.join(ORCH, rel), 'utf8')
      .split(/\r?\n/)
      .filter((l) => !/^\s*(?:\/\/|\*|\/\*)/.test(l))
      .join('\n');
    expect(code.includes(`'${name}'`), `${rel} hand-codes ${name}`).toBe(false);
  });
});

describe('the never-share list and the register agree', () => {
  /** The single file names of the data folder families. */
  const dataFiles = () =>
    FAM.all()
      .filter((f: any) => f.root === 'data')
      .flatMap((f: any) => [f.file, ...f.match.filter((m: unknown) => typeof m === 'string')].filter(Boolean).map((n: string) => [n, f]));

  it('every share "never" file of the register is refused by share.include', () => {
    for (const [n, f] of dataFiles()) if (f.share === 'never') expect(QS.includeProblem(n), `${n} (${f.name})`).toMatch(/can never be shared/);
  });

  it('a register file share.include refuses is share "never" in the register', () => {
    for (const [n, f] of dataFiles()) if (QS.includeProblem(n)) expect(f.share, `${n} (${f.name}) is refused but not "never"`).toBe('never');
  });

  it('the refusal names the family note', () => {
    expect(QS.includeProblem('approval-waits.json')).toMatch(/agents waiting on a permission prompt/);
  });

  it('the transaction journal is a family (share never, owned by the store), and its recovery has a settings row', () => {
    expect(FAM.family('journal')).toMatchObject({ dir: '.journal', share: 'never', owner: 'lib/store/index.js' });
    expect(FAM.classify('.journal', true)?.name).toBe('journal');
    const REG = require('../settingsRegistry.js');
    const row = REG.SETTINGS.find((r: any) => r.key === 'store.journalRecover');
    expect(row).toMatchObject({ category: 'history', type: 'choice', choices: ['auto', 'report'] });
    expect(require('../queueConfig.js').STANDARD.store.journalRecover).toBe('auto');
  });
});
