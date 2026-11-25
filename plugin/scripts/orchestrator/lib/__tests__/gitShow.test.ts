// =============================================================
// gitShow.test.ts: receive tells "the file is not at that commit" from "git failed" (lib/gitShow.js).
//
// (1) A real repository: an existing file gives its text, a path not in the commit gives null, a bad object throws a
//     GitReadError (before the fix both read as null, "missing").
// (2) Injected runs: a time-out and a git that does not start are errors, never missing.
// (3) Guard test: receive's reads at a commit go through gitShow, never through a helper that turns every failure into
//     null (cli/merge/receive.mjs, cli/merge/receiveChecks.mjs).
// =============================================================
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/* eslint-disable @typescript-eslint/no-require-imports */
const GS = require('../gitShow.js');
const CLI = path.resolve(__dirname, '..', '..', 'cli');

let repo = '';
let tip = '';
beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'git-show-'));
  const g = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  g('init', '-q');
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src', 'a.txt'), 'hello\n');
  g('add', '.');
  g('commit', '-q', '-m', 'one');
  tip = g('rev-parse', 'HEAD').trim();
});
afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));

describe('showAt on a real repository', () => {
  it('gives the text of a file in the commit', () => {
    expect(GS.showAt(tip, 'src/a.txt', { cwd: repo })).toBe('hello\n');
  });

  it('gives a Buffer with buffer', () => {
    expect(Buffer.isBuffer(GS.showAt(tip, 'src/a.txt', { cwd: repo, buffer: true }))).toBe(true);
  });

  it('gives null for a path that is not in the commit', () => {
    expect(GS.showAt(tip, 'src/gone.txt', { cwd: repo })).toBeNull();
  });

  it('throws a GitReadError for a bad object, never null', () => {
    const bad = 'f'.repeat(40);
    expect(() => GS.showAt(bad, 'src/a.txt', { cwd: repo })).toThrow(GS.GitReadError);
    expect(() => GS.showAt('no-such-branch', 'src/a.txt', { cwd: repo })).toThrow(/could not read src\/a\.txt/);
  });
});

describe('showAt with injected runs', () => {
  it('a time-out is an error', () => {
    const run = () => ({ status: null, stdout: '', stderr: '', timedOut: true, spawnError: null });
    expect(() => GS.showAt('abc', 'x.js', { run })).toThrow(/timed out/);
  });

  it('a git that does not start is an error', () => {
    const run = () => ({ status: null, stdout: '', stderr: '', timedOut: false, spawnError: 'ENOENT' });
    expect(() => GS.showAt('abc', 'x.js', { run })).toThrow(/did not run/);
  });

  it('a show that fails while ls-tree lists the path is an error, not missing', () => {
    const run = (args: string[]) =>
      args[0] === 'show'
        ? { status: 128, stdout: '', stderr: 'fatal: something else\n', timedOut: false, spawnError: null }
        : { status: 0, stdout: 'x.js\n', stderr: '', timedOut: false, spawnError: null };
    expect(() => GS.showAt('abc', 'x.js', { run })).toThrow(/something else/);
  });

  it('a failed show and a failed ls-tree is an error', () => {
    const run = () => ({ status: 128, stdout: '', stderr: 'fatal: bad object abc\n', timedOut: false, spawnError: null });
    expect(() => GS.showAt('abc', 'x.js', { run })).toThrow(/bad object/);
  });
});

describe('guard test: receive reads a file at a commit through gitShow', () => {
  it.each(['merge/receive.mjs', 'merge/receiveChecks.mjs'])('%s', (file) => {
    const text = fs.readFileSync(path.join(CLI, file), 'utf8');
    // git(['show', `rev:path`]) or gitLarge(['show', ...]): both helpers return null on every failure.
    expect(/\bgit(?:Large)?\(\s*\[\s*'show'/.test(text), `${file} reads a file at a commit with a null-on-error helper`).toBe(false);
  });
});
