// =============================================================
// guardDefaults.test.ts: the review of warnings and stops: what softens in lite, and what never does.
//
// Why: lite is a first try, where a stop on a changed hook or a new library teaches nothing. The floor under the merge guard
// and the identity guard's empty case must hold whatever the settings say. Config runs against temporary folders.
// =============================================================
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const QC = require('../queueConfig.js') as any;
const G = require('../mergeGuard.js') as any;
const GI = require('../gitIdentity.js') as any;

const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-defaults-'));
afterAll(() => fs.rmSync(folder, { recursive: true, force: true }));
let n = 0;
/** The config as read from a queue.config.json with this content, past the process's buffer. */
const configOf = (own: unknown) => {
  const root = path.join(folder, String(n++));
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'queue.config.json'), JSON.stringify(own));
  return QC.config({ root });
};
const changed = (...paths: string[]) => paths.map((p) => ({ status: 'M', paths: [p] }));
const guard = (dependencyFiles: string | undefined, ...paths: string[]) =>
  G.assessGuard({ changes: changed(...paths), dependencyFiles });

describe('the defaults that follow the mode', () => {
  it('lite warns, full stops, and a value in the file wins in both', () => {
    expect(configOf({ mode: 'lite' })).toMatchObject({ gitSurface: 'warn', dependencyFiles: 'warn' });
    expect(configOf({})).toMatchObject({ gitSurface: 'stop', dependencyFiles: 'stop' });
    expect(configOf({ mode: 'lite', gitSurface: 'stop', dependencyFiles: 'stop' })).toMatchObject({
      gitSurface: 'stop',
      dependencyFiles: 'stop',
    });
    expect(configOf({ mode: 'full', gitSurface: 'warn' }).gitSurface).toBe('warn');
  });
});

describe('dependency files in the merge guard', () => {
  it('stop by default, a warning with the setting', () => {
    expect(guard(undefined, 'package.json')).toMatchObject({ stop: true, warned: [] });
    expect(guard('warn', 'package.json', 'sub/Cargo.toml', 'pyproject.toml', 'package-lock.json')).toMatchObject({
      stop: false,
      violations: [],
      warned: ['package.json', 'sub/Cargo.toml', 'pyproject.toml', 'package-lock.json'],
    });
  });

  it('warn softens nothing else: the floor and the test configs still stop', () => {
    for (const p of ['queue.config.json', '.claude/settings.json', 'scripts/orchestrator/package.json', 'vitest.config.ts', 'Makefile']) {
      expect(guard('warn', p)).toMatchObject({ stop: true, warned: [] });
    }
  });

  it('an owned dependency file says nothing', () => {
    const r = G.assessGuard({ changes: changed('package.json'), ownedFiles: ['package.json'], dependencyFiles: 'warn' });
    expect(r).toMatchObject({ stop: false, warned: [], violations: [] });
  });
});

describe('merge-track against a temporary repo', () => {
  const SCRIPT = path.resolve(__dirname, '..', '..', 'merge-track.mjs');
  const merge = (own: unknown) => {
    const root = path.join(folder, String(n++));
    fs.mkdirSync(root);
    const ID = ['-c', 'user.name=queue-test', '-c', 'user.email=owner@company.test'];
    const g = (...args: string[]) => execFileSync('git', ['-C', root, ...ID, ...args], { stdio: 'ignore' });
    g('init', '-q', '-b', 'main');
    g('config', 'user.name', 'queue-test');
    g('config', 'user.email', 'owner@company.test');
    fs.writeFileSync(path.join(root, 'package.json'), '{}\n');
    g('add', '.');
    g('commit', '-q', '-m', 'start');
    g('checkout', '-q', '-b', 'queue/A');
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"x"}\n');
    g('commit', '-q', '-am', 'a library');
    g('checkout', '-q', 'main');
    const configFile = path.join(root, 'cfg.json');
    fs.writeFileSync(configFile, JSON.stringify(own));
    return spawnSync(process.execPath, [SCRIPT, 'queue/A'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, QUEUE_CONFIG: configFile, QUEUE_ROOT: root, QUEUE_GIT: root, QUEUE_FOLDER: path.join(root, '.q') },
    });
  };

  it('full stops a dependency file with exit 4, lite warns and merges', () => {
    const full = merge({});
    expect(full.status).toBe(4);
    expect(full.stderr).toContain('GUARD');
    const lite = merge({ mode: 'lite' });
    expect(lite.status).toBe(0);
    expect(lite.stdout).toContain('WARNING dependency file(s) changed');
  }, 60_000);
});

describe('identity.allow', () => {
  const ident = 'Vera Test <ci@example.com>';
  it('accepts a listed address, exactly and whatever the case', () => {
    expect(GI.identityRefused(ident)).toBe(true);
    expect(GI.identityRefused(ident, ['CI@Example.com'])).toBe(false);
    expect(GI.identityRefused(ident, ['other@example.com', 'i@example.com'])).toBe(true);
  });
  it('a missing identity is refused whatever the list says', () => {
    expect(GI.identityRefused('', ['ci@example.com'])).toBe(true);
    expect(GI.identityRefused('Name <you@company.no>', 'nonsense')).toBe(false);
  });
});
