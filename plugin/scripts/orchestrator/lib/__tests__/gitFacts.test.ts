// =============================================================
// gitFacts.test.ts: the per-process memo for git path facts (lib/gitFacts.js).
//
// Locks: (1) only path questions count as facts (never HEAD, refs, config or the hooks folder); (2) the same question
// in the same folder is asked once, a different folder or other arguments ask again; (3) a failed answer is not kept;
// (4) invalidate() forgets everything, and run() does it after a layout command or a config write, never after a read;
// (5) a folder that is gone is asked again; (6) a git variable that moves the repository is part of the key.
// =============================================================
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as GF from '../gitFacts';

const temporary: string[] = [];
afterAll(() => {
  for (const m of temporary) fs.rmSync(m, { recursive: true, force: true });
});
const folder = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'git-facts-'));
  temporary.push(d);
  return d;
};

beforeEach(() => GF.invalidate());

describe('isFactQuery', () => {
  it('takes the path questions', () => {
    for (const args of [
      ['rev-parse', '--show-toplevel'],
      ['rev-parse', '--git-dir', '--git-common-dir'],
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      ['rev-parse', '--git-path', 'MERGE_HEAD', '--git-path', 'rebase-merge'],
      ['rev-parse', '--is-inside-work-tree'],
    ])
      expect(GF.isFactQuery(args), args.join(' ')).toBe(true);
  });
  it('never takes HEAD, refs, the hooks folder, config or other commands', () => {
    for (const args of [
      ['rev-parse', 'HEAD'],
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ['rev-parse', '-q', '--verify', 'refs/heads/main'],
      ['rev-parse', '--git-dir', 'HEAD'],
      ['rev-parse', '--git-path', 'hooks'],
      ['rev-parse', '--git-path', 'hooks/pre-push'],
      ['rev-parse', '--git-path'],
      ['rev-parse'],
      ['config', '--get', 'core.hooksPath'],
      ['config', '--null', '--list'],
      ['worktree', 'list', '--porcelain'],
      ['status', '--porcelain'],
    ])
      expect(GF.isFactQuery(args), args.join(' ')).toBe(false);
  });
});

describe('remember and run', () => {
  it('asks the same question in the same folder once', () => {
    const d = folder();
    let calls = 0;
    const exec = () => `answer ${++calls}`;
    expect(GF.run(d, ['rev-parse', '--git-dir'], exec)).toBe('answer 1');
    expect(GF.run(d, ['rev-parse', '--git-dir'], exec)).toBe('answer 1');
    // The same folder written another way is the same key.
    expect(GF.run(`${d}${path.sep}.`, ['rev-parse', '--git-dir'], exec)).toBe('answer 1');
    expect(calls).toBe(1);
  });
  it('asks again for another folder or other arguments', () => {
    const a = folder();
    const b = folder();
    let calls = 0;
    const exec = () => `answer ${++calls}`;
    GF.run(a, ['rev-parse', '--git-dir'], exec);
    expect(GF.run(b, ['rev-parse', '--git-dir'], exec)).toBe('answer 2');
    expect(GF.run(a, ['rev-parse', '--git-common-dir'], exec)).toBe('answer 3');
    expect(calls).toBe(3);
  });
  it('never keeps an answer that is not a path fact', () => {
    const d = folder();
    let calls = 0;
    const exec = () => `sha ${++calls}`;
    GF.run(d, ['rev-parse', 'HEAD'], exec);
    GF.run(d, ['rev-parse', 'HEAD'], exec);
    GF.run(d, ['config', '--get', 'user.name'], exec);
    GF.run(d, ['config', '--get', 'user.name'], exec);
    expect(calls).toBe(4);
    expect(GF.size()).toBe(0);
  });
  it('does not keep a failure', () => {
    const d = folder();
    let calls = 0;
    const exec = () => (++calls === 1 ? null : 'found');
    expect(GF.run(d, ['rev-parse', '--show-toplevel'], exec)).toBeNull();
    expect(GF.run(d, ['rev-parse', '--show-toplevel'], exec)).toBe('found');
    expect(GF.run(d, ['rev-parse', '--show-toplevel'], exec)).toBe('found');
    expect(calls).toBe(2);
  });
  it('asks again when the folder is gone', () => {
    const d = folder();
    let calls = 0;
    const exec = () => `answer ${++calls}`;
    GF.run(d, ['rev-parse', '--git-dir'], exec);
    fs.rmSync(d, { recursive: true, force: true });
    expect(GF.run(d, ['rev-parse', '--git-dir'], exec)).toBe('answer 2');
  });
  it('keys on GIT_DIR and the other variables that move the repository', () => {
    const d = folder();
    let calls = 0;
    const exec = () => `answer ${++calls}`;
    const before = process.env.GIT_DIR;
    try {
      GF.run(d, ['rev-parse', '--git-dir'], exec);
      process.env.GIT_DIR = path.join(d, 'other.git');
      expect(GF.run(d, ['rev-parse', '--git-dir'], exec)).toBe('answer 2');
    } finally {
      if (before === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = before;
    }
  });
  it('remember keeps a derived fact under its own name', () => {
    const d = folder();
    let calls = 0;
    expect(GF.remember(d, ['main checkout'], () => `main ${++calls}`)).toBe('main 1');
    expect(GF.remember(d, ['main checkout'], () => `main ${++calls}`)).toBe('main 1');
    expect(GF.remember(d, ['something else'], () => `other ${++calls}`)).toBe('other 2');
  });
});

describe('invalidate', () => {
  it('forgets every kept answer', () => {
    const d = folder();
    let calls = 0;
    const exec = () => `answer ${++calls}`;
    GF.run(d, ['rev-parse', '--git-dir'], exec);
    GF.invalidate();
    expect(GF.size()).toBe(0);
    expect(GF.run(d, ['rev-parse', '--git-dir'], exec)).toBe('answer 2');
  });
  it('run() forgets after a layout command or a config write, never after a read', () => {
    const d = folder();
    const exec = () => 'x';
    for (const args of [
      ['worktree', 'add', '-q', 'wt', 'branch'],
      ['worktree', 'remove', 'wt'],
      ['worktree', 'prune'],
      ['init', '-q'],
      ['clone', 'a', 'b'],
      ['checkout', 'main'],
      ['-C', d, 'switch', '--detach'],
      ['config', 'core.hooksPath', 'x'],
      ['config', '--unset', 'core.hooksPath'],
      ['config', 'set', 'user.name', 'x'],
    ]) {
      GF.run(d, ['rev-parse', '--git-dir'], exec);
      expect(GF.size(), args.join(' ')).toBe(1);
      GF.run(d, args, exec);
      expect(GF.size(), args.join(' ')).toBe(0);
    }
    GF.run(d, ['rev-parse', '--git-dir'], exec);
    for (const args of [['config', '--get', 'user.name'], ['config', '--null', '--list'], ['config', 'get', 'user.name'], ['status'], ['-c', 'core.quotepath=off', 'diff']])
      GF.run(d, args, exec);
    expect(GF.size()).toBe(1);
  });
  it('run() forgets even when the layout command throws', () => {
    const d = folder();
    GF.run(d, ['rev-parse', '--git-dir'], () => 'x');
    expect(() => GF.run(d, ['worktree', 'add', 'wt'], () => { throw new Error('failed'); })).toThrow('failed');
    expect(GF.size()).toBe(0);
  });
});

describe('changesFacts', () => {
  it('reads the subcommand after the global options', () => {
    expect(GF.changesFacts(['-C', '/x', '-c', 'a=b', 'worktree', 'add', 'y'])).toBe(true);
    expect(GF.changesFacts(['-c', 'worktree=1', 'status'])).toBe(false);
    expect(GF.changesFacts(['--no-optional-locks', 'rev-parse', '--git-dir'])).toBe(false);
    expect(GF.changesFacts([])).toBe(false);
  });
});
