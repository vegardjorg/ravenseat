// =============================================================
// setupMerge.test.ts: `ravenseat setup --update`, the three-way update of the project's copies (lib/setupMerge.js).
//
// Locks: a copy nobody edited follows the plugin, a copy with only the owner's edits stays, edits on both sides in
// different places merge, edits in the same place give a conflict that leaves the copy untouched and saves the merge
// with markers in the data folder, and a copy with no recorded base is never touched (it cannot be told apart).
// Why: before this the owner could only choose between losing their edits (--overwrite) and keeping an old mission
// template that every agent is briefed from.
// =============================================================
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PLUGIN_ROOT, setupProject } from '../../setup.mjs';

const require = createRequire(import.meta.url);
const SM = require('../setupMerge.js');

describe('the three-way decision', () => {
  const up = 'one\ntwo\nthree\nfour\nfive\n';
  it('the plain cases', () => {
    expect(SM.threeWay({ local: null, base: null, upstream: up }).action).toBe('copy');
    expect(SM.threeWay({ local: up.replace(/\n/g, '\r\n'), base: null, upstream: up }).action).toBe('same');
    expect(SM.threeWay({ local: 'x\n', base: null, upstream: up }).action).toBe('no-base');
    expect(SM.threeWay({ local: 'old\n', base: 'old\n', upstream: up })).toEqual({ action: 'update', text: up });
    expect(SM.threeWay({ local: 'mine\n', base: up, upstream: up }).action).toBe('own-edits');
  });

  it('edits in different places merge; edits in the same place conflict, with markers', () => {
    const base = 'ONE\ntwo\nthree\nfour\nfive\n';
    const local = 'ONE\ntwo\nthree\nfour\nfive\nmy own line\n';
    const merged = SM.threeWay({ local, base, upstream: up });
    expect(merged.action).toBe('merged');
    expect(merged.text).toBe('one\ntwo\nthree\nfour\nfive\nmy own line\n');
    const clash = SM.threeWay({ local: 'MINE\ntwo\nthree\nfour\nfive\n', base, upstream: up });
    expect(clash.action).toBe('conflict');
    expect(clash.text).toContain('<<<<<<< your copy');
    expect(clash.text).toContain('>>>>>>> plugin');
  });
});

describe('setup --update in a project', () => {
  let target: string;
  const saved = process.env.QUEUE_FOLDER;
  beforeEach(() => {
    target = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-setup-merge-'));
    delete process.env.QUEUE_FOLDER;
  });
  afterEach(() => {
    fs.rmSync(target, { recursive: true, force: true });
    if (saved === undefined) delete process.env.QUEUE_FOLDER;
    else process.env.QUEUE_FOLDER = saved;
  });
  const copy = () => path.join(target, 'CLAUDE.queue.md');
  const base = () => path.join(target, 'scripts', '.queue', 'setup-base', 'CLAUDE.queue.md');
  const plugin = () => fs.readFileSync(path.join(PLUGIN_ROOT, 'CLAUDE.queue.md'), 'utf8');

  it('the first setup records the base of every copy', () => {
    setupProject({ target });
    expect(fs.readFileSync(base(), 'utf8')).toBe(plugin());
  });

  it('an unedited old copy follows the plugin, and an edited one keeps the edit', () => {
    setupProject({ target });
    // An older plugin version wrote this copy, and the owner never touched it.
    fs.writeFileSync(copy(), 'old text\n');
    fs.writeFileSync(base(), 'old text\n');
    let log = setupProject({ target, update: true });
    expect(log.updated).toContain('CLAUDE.queue.md');
    expect(fs.readFileSync(copy(), 'utf8')).toBe(plugin());
    // Now the owner adds a line at the end; the plugin is unchanged, so the copy stays as the owner left it.
    fs.appendFileSync(copy(), '\nOur own rule.\n');
    log = setupProject({ target, update: true });
    expect(log.ownEdits).toContain('CLAUDE.queue.md');
    expect(fs.readFileSync(copy(), 'utf8')).toContain('Our own rule.');
  });

  it('a conflict leaves the copy untouched and saves the merge with markers in the data folder', () => {
    setupProject({ target });
    const first = plugin().split('\n')[0];
    fs.writeFileSync(base(), plugin().replace(first, 'BASE TITLE'));
    fs.writeFileSync(copy(), plugin().replace(first, 'MY TITLE'));
    const before = fs.readFileSync(copy(), 'utf8');
    const log = setupProject({ target, update: true });
    expect(log.conflicts).toEqual(['CLAUDE.queue.md']);
    expect(fs.readFileSync(copy(), 'utf8')).toBe(before);
    const saved = fs.readFileSync(path.join(target, 'scripts', '.queue', 'setup-merge', 'CLAUDE.queue.md'), 'utf8');
    expect(saved).toContain('MY TITLE');
    expect(saved).toContain('<<<<<<< your copy');
    // The base is not moved on: the next --update meets the same conflict until the owner resolves it.
    expect(fs.readFileSync(base(), 'utf8')).toContain('BASE TITLE');
  });

  it('queue.config.json is never merged and gets no base', () => {
    setupProject({ target });
    const cfg = path.join(target, 'queue.config.json');
    fs.writeFileSync(cfg, '{"baseBranch":"mine"}\n');
    setupProject({ target, update: true });
    expect(fs.readFileSync(cfg, 'utf8')).toBe('{"baseBranch":"mine"}\n');
    expect(fs.existsSync(path.join(target, 'scripts', '.queue', 'setup-base', 'queue.config.json'))).toBe(false);
  });

  it('the command line: --update says what it did, and refuses --overwrite with it', () => {
    setupProject({ target });
    fs.writeFileSync(copy(), 'old text\n');
    fs.writeFileSync(base(), 'old text\n');
    const SETUP = path.resolve(__dirname, '..', '..', 'setup.mjs');
    const env = { ...process.env } as NodeJS.ProcessEnv;
    delete env.QUEUE_FOLDER;
    const r = spawnSync(process.execPath, [SETUP, '--update', '--target', target], { encoding: 'utf8', env });
    expect(r.stdout).toContain('updated (you had not edited them): CLAUDE.queue.md');
    const both = spawnSync(process.execPath, [SETUP, '--update', '--overwrite', '--target', target], { encoding: 'utf8', env });
    expect(both.status).toBe(2);
  });

  it('a copy without a recorded base is never touched by --update, and --dry writes nothing', () => {
    setupProject({ target });
    fs.writeFileSync(copy(), 'from before bases were kept\n');
    fs.rmSync(base());
    let log = setupProject({ target, update: true, dry: true });
    expect(log.noBase).toContain('CLAUDE.queue.md');
    log = setupProject({ target, update: true });
    expect(fs.readFileSync(copy(), 'utf8')).toBe('from before bases were kept\n');
    // A dry run of an update that would apply writes nothing either.
    fs.writeFileSync(base(), 'from before bases were kept\n');
    log = setupProject({ target, update: true, dry: true });
    expect(log.updated).toContain('CLAUDE.queue.md');
    expect(fs.readFileSync(copy(), 'utf8')).toBe('from before bases were kept\n');
  });
});
