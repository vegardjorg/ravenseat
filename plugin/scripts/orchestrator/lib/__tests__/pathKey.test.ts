// =============================================================
// pathKey.test.ts: one comparable form for paths (lib/pathKey.js, ARK-1 T4, architecture review C).
//
// Locks: (1) key() folds case on win32 AND darwin (both file systems fold by default), never on linux; (2) the real path
// is used where the path exists, so a link into a folder compares as the folder; (3) rel() and inside(); (4) the guards
// on a folding platform (darwin simulated through the injectable platform): a write to `claude.md` or
// `QUEUE.CONFIG.JSON` in a main tree spelled in another case is caught like the canonical name, by the control file
// guard (lib/controlFiles.js), the main session's ask (lib/approvalAsk.js), the state file guard (lib/writeGuard.js)
// and the private read rule (lib/privatePaths.js).
// =============================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/* eslint-disable @typescript-eslint/no-require-imports */
const PK = require('../pathKey.js');
const CF = require('../controlFiles.js');
const AA = require('../approvalAsk.js');
const WG = require('../writeGuard.js');
const PP = require('../privatePaths.js');

// A main tree that does not exist (so no real path changes it), in mixed case.
const MAIN = path.resolve('/no-such-ark-root/Users/Me/Proj');
const lower = (p: string) => p.toLowerCase();
const upperName = (p: string, name: string) => path.join(path.dirname(p), name);

describe('key', () => {
  it('folds case on win32 and darwin, not on linux', () => {
    for (const platform of ['win32', 'darwin']) expect(PK.key(path.join(MAIN, 'A.md'), { platform })).toBe(PK.key(lower(path.join(MAIN, 'a.md')), { platform }));
    expect(PK.key(path.join(MAIN, 'A.md'), { platform: 'linux' })).not.toBe(PK.key(path.join(MAIN, 'a.md'), { platform: 'linux' }));
    expect(PK.folds('darwin')).toBe(true);
    expect(PK.folds('win32')).toBe(true);
    expect(PK.folds('linux')).toBe(false);
  });

  it('uses "/" separators and drops a trailing slash', () => {
    const k = PK.key(`${MAIN}${path.sep}`, { platform: 'linux' });
    expect(k).not.toMatch(/\\/);
    expect(k.endsWith('/')).toBe(false);
  });

  it('reads Git Bash /c/x as C:/x on win32', () => {
    expect(PK.key('/c/Some/Where', { platform: 'win32', real: false })).toBe('c:/some/where');
  });
});

const temporary: string[] = [];
afterAll(() => {
  for (const f of temporary) fs.rmSync(f, { recursive: true, force: true });
});

describe('the real path', () => {
  it('a link into a folder compares as the folder', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ark-pathkey-')));
    temporary.push(root);
    const target = path.join(root, 'target');
    fs.mkdirSync(target);
    const link = path.join(root, 'link');
    fs.symlinkSync(target, link, 'junction');
    expect(PK.key(path.join(link, 'CLAUDE.md'))).toBe(PK.key(path.join(target, 'CLAUDE.md')));
    expect(PK.inside(path.join(link, 'x', 'y.txt'), target)).toBe(true);
  });

  it('a CLAUDE.md that is a link to AGENTS.md is still a control file, and a link to CLAUDE.md is one too', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ark-pathkey-link-')));
    temporary.push(root);
    fs.writeFileSync(path.join(root, 'AGENTS.md'), 'x');
    try {
      fs.symlinkSync(path.join(root, 'AGENTS.md'), path.join(root, 'CLAUDE.md'), 'file');
      fs.symlinkSync(path.join(root, 'CLAUDE.md'), path.join(root, 'notes.md'), 'file');
    } catch {
      return; // file links need a privilege on Windows: the folder link test above covers the real path there
    }
    expect(CF.controlKind(path.join(root, 'CLAUDE.md'), { mainTree: root })).toBe(CF.KIND.instructions);
    expect(PK.keys(path.join(root, 'CLAUDE.md')).length).toBe(2);
  });

  it('real: false keeps the path as written', () => {
    expect(PK.key('/a/B', { platform: 'linux', real: false })).toBe(path.resolve('/a/B').replace(/\\/g, '/'));
  });
});

describe('rel and inside', () => {
  it('rel is the path below root in key form, or null', () => {
    expect(PK.rel(path.join(MAIN, 'Docs', 'A.md'), MAIN, { platform: 'darwin' })).toBe('docs/a.md');
    expect(PK.rel(path.join(MAIN, 'Docs', 'A.md'), MAIN, { platform: 'linux' })).toBe('Docs/A.md');
    expect(PK.rel(path.join(MAIN, '..', 'Other', 'A.md'), MAIN, { platform: 'darwin' })).toBeNull();
    expect(PK.rel(MAIN, MAIN, { platform: 'darwin' })).toBe('');
  });

  it('inside: the same folder or below it, never a sibling with the same prefix', () => {
    expect(PK.inside(MAIN, MAIN)).toBe(true);
    expect(PK.inside(path.join(MAIN, 'a'), MAIN)).toBe(true);
    expect(PK.inside(`${MAIN}-other`, MAIN)).toBe(false);
    expect(PK.inside(lower(path.join(MAIN, 'a')), MAIN, { platform: 'darwin' })).toBe(true);
    expect(PK.inside(lower(path.join(MAIN, 'a')), MAIN, { platform: 'linux' })).toBe(lower(MAIN) === MAIN);
  });
});

describe('the guards on a folding platform (darwin)', () => {
  const platform = 'darwin';
  const mainLower = lower(MAIN);

  it('controlFiles: claude.md and QUEUE.CONFIG.JSON in a main tree spelled in another case', () => {
    const where = { mainTree: MAIN, platform };
    expect(CF.controlKind(path.join(mainLower, 'claude.md'), where)).toBe(CF.controlKind(path.join(MAIN, 'CLAUDE.md'), where));
    expect(CF.controlKind(path.join(mainLower, 'claude.md'), where)).not.toBeNull();
    expect(CF.controlKind(upperName(path.join(mainLower, 'x'), 'QUEUE.CONFIG.JSON'), where)).toBe(CF.controlKind(path.join(MAIN, 'queue.config.json'), where));
    expect(CF.controlKind(upperName(path.join(mainLower, 'x'), 'QUEUE.CONFIG.JSON'), where)).not.toBeNull();
    // A config file outside the main tree, named in another case.
    const configFile = path.resolve('/no-such-ark-cfg/Q/queue.config.json');
    expect(CF.controlKind(lower(configFile).toUpperCase(), { ...where, configFile })).not.toBeNull();
    // The denial a track gets.
    const d = CF.assessControlWrite({ agentType: 'track', filePath: path.join(mainLower, 'claude.md'), mainTree: MAIN, platform });
    expect(d?.rule).toBe('control-file');
    expect(d?.reason).toMatch(/claude\.md/);
  });

  it('linux does not fold: another case is another file', () => {
    if (lower(MAIN) === MAIN) return;
    expect(CF.controlKind(path.join(mainLower, 'claude.md'), { mainTree: MAIN, platform: 'linux' })).toBeNull();
  });

  it("approvalAsk: the main session's write asks with the path below the main tree", () => {
    const f = AA.controlWriteFinding({ filePath: path.join(mainLower, 'claude.md'), mainTree: MAIN, platform });
    expect(f?.decision).toBe('ask');
    expect(f?.reason).toMatch(/writes claude\.md directly/);
  });

  it('writeGuard: queue.json in the data folder spelled in another case', () => {
    const folder = path.join(MAIN, 'Data');
    const r = WG.assessWrite({ agentType: 'track', filePath: path.join(lower(folder), 'QUEUE.JSON'), folder, platform });
    expect(r?.reason).toMatch(/QUEUE\.JSON/);
    // The platform is honoured: linux does not fold, so the other case is another folder.
    if (lower(folder) !== folder)
      expect(WG.assessWrite({ agentType: 'track', filePath: path.join(lower(folder), 'QUEUE.JSON'), folder, platform: 'linux' })).toBeNull();
  });

  it('privatePaths: a read: false folder read through another case', () => {
    const cfg = { privatePaths: [{ path: 'Notes/', read: false }] };
    expect(PP.readDenied(path.join(mainLower, 'notes', 'a.md'), { root: MAIN, cfg, platform })).not.toBeNull();
    expect(PP.readDenied(path.join(mainLower, 'other', 'a.md'), { root: MAIN, cfg, platform })).toBeNull();
    if (mainLower !== MAIN) expect(PP.readDenied(path.join(mainLower, 'notes', 'a.md'), { root: MAIN, cfg, platform: 'linux' })).toBeNull();
  });
});
