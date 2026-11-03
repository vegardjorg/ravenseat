// =============================================================
// gitExecSurface.test.ts: the rules for what in git can run code, and the comparison (lib/gitExecSurface.js).
//
// Locks: (1) which config keys count; (2) the `git config --null --list` parse keeps only those, with repeated values;
// (3) the hook files: added, changed and removed are named, and a chmod that arms a file counts on systems with exec bits;
// (4) a part that could not be read before compares as nothing, one that cannot be read after is a change; (5) reasons
// name keys, never values, and the list is cut after a few names.
// The behaviour against a real repo is in __tests__/gateCoverageTamper.test.ts.
// =============================================================
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as GX from '../gitExecSurface';

const temporary: string[] = [];
afterAll(() => {
  for (const m of temporary) fs.rmSync(m, { recursive: true, force: true });
});

const surface = (hooks: Record<string, string> | null, config: Record<string, string[]> | null, hooksDir = '/h') => ({
  hooksDir,
  hooks,
  config,
});

describe('isExecKey', () => {
  it('knows the keys that run a program, and nothing else', () => {
    for (const k of [
      'core.hooksPath', 'core.hookspath', 'core.fsmonitor', 'core.sshCommand', 'core.pager', 'credential.helper',
      'credential.https://example.invalid.helper', 'alias.st', 'filter.lfs.clean', 'filter.x.process', 'diff.external',
      'diff.tool.command', 'merge.ours.driver',
    ])
      expect(GX.isExecKey(k), k).toBe(true);
    for (const k of ['user.name', 'core.autocrlf', 'branch.main.remote', 'remote.origin.url', 'merge.ff', 'credential.username', '', null])
      expect(GX.isExecKey(k), String(k)).toBe(false);
  });
});

describe('parseConfigList', () => {
  it('keeps the executing keys, every value in order, a key without a value and values with newlines', () => {
    const text = [
      'user.name\nsomeone',
      'credential.helper\nfirst',
      'credential.helper\nsecond',
      'core.fsmonitor',
      'alias.two\nline one\nline two',
      '',
    ].join('\0');
    expect(GX.parseConfigList(text)).toEqual({
      'credential.helper': ['first', 'second'],
      'core.fsmonitor': [''],
      'alias.two': ['line one\nline two'],
    });
    expect(GX.parseConfigList('')).toEqual({});
    expect(GX.parseConfigList(null)).toEqual({});
  });
});

describe('hookFiles', () => {
  const folder = () => {
    const f = fs.mkdtempSync(path.join(os.tmpdir(), 'git-exec-surface-'));
    temporary.push(f);
    return f;
  };

  it('hashes by relative name, also in a subfolder, and {} for a missing folder', () => {
    const f = folder();
    fs.mkdirSync(path.join(f, '_'));
    fs.writeFileSync(path.join(f, 'pre-commit'), 'one');
    fs.writeFileSync(path.join(f, '_', 'husky.sh'), 'two');
    const a = GX.hookFiles(f);
    expect(Object.keys(a).sort()).toEqual(['_/husky.sh', 'pre-commit']);
    fs.writeFileSync(path.join(f, 'pre-commit'), 'changed');
    expect(GX.hookFiles(f)['pre-commit']).not.toBe(a['pre-commit']);
    expect(GX.hookFiles(f)['_/husky.sh']).toBe(a['_/husky.sh']);
    expect(GX.hookFiles(path.join(f, 'gone'))).toEqual({});
  });

  it.skipIf(process.platform === 'win32')('a chmod that arms a file counts (no exec bits on Windows)', () => {
    const f = folder();
    fs.writeFileSync(path.join(f, 'post-merge'), 'same');
    fs.chmodSync(path.join(f, 'post-merge'), 0o644);
    const a = GX.hookFiles(f);
    fs.chmodSync(path.join(f, 'post-merge'), 0o755);
    expect(GX.hookFiles(f)['post-merge']).not.toBe(a['post-merge']);
  });
});

describe('surfaceChanges', () => {
  it('nothing changed gives no reason', () => {
    const s = surface({ a: '1' }, { 'alias.x': ['y'] });
    expect(GX.surfaceChanges(s, surface({ a: '1' }, { 'alias.x': ['y'] }))).toEqual([]);
    expect(GX.surfaceChangeReason(s, s)).toBeNull();
  });

  it('names added, changed and removed hooks and changed keys, never values', () => {
    const before = surface({ a: '1', b: '2' }, { 'core.pager': ['less'], 'alias.gone': ['x'] });
    const after = surface({ a: '9', c: '3' }, { 'core.pager': ['VALUE'], 'alias.new': ['VALUE'] });
    expect(GX.surfaceChanges(before, after)).toEqual([
      'hook added: c',
      'hook changed: a',
      'hook removed: b',
      'git config changed: alias.gone, alias.new, core.pager',
    ]);
    expect(GX.surfaceChangeReason(before, after)).not.toContain('VALUE');
    expect(GX.surfaceChangeReason(before, after)).toContain('git hooks or config changed during the run');
  });

  it('cuts a long list of names', () => {
    const many = Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((n) => [n, '1']));
    expect(GX.surfaceChanges(surface({}, {}), surface(many, {}))).toEqual(['hook added: a, b, c, d, e and 2 more']);
  });

  it('a moved hooks folder is one change, not every file in it', () => {
    expect(GX.surfaceChanges(surface({ a: '1' }, {}), surface({ b: '1' }, {}, '/other'))).toEqual(['the effective hooks folder moved']);
  });

  it('what could not be read before compares as nothing; what cannot be read after is a change', () => {
    expect(GX.surfaceChanges(surface(null, null, null as never), surface({ a: '1' }, { 'alias.x': ['y'] }))).toEqual([]);
    expect(GX.surfaceChanges(surface({}, {}), surface(null, null, null as never))).toEqual([
      'the hooks folder can no longer be found',
      'the git config can no longer be read',
    ]);
  });
});
