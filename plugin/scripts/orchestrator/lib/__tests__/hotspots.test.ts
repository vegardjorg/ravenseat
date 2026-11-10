// =============================================================
// hotspots.test.ts: shared config blocks (`hotspots` in queue.config.json, lib/hotspots.js; ownership 2 in
// plans/ROADMAP.md).
//
// Locks: no task can own a hotspot (add and edit refuse it in owned_files), an agreed change goes in `hotspot_patch`,
// which only one active task can hold at a time (a start conflict), the merge stops on a hotspot change that was not
// agreed (exit 4, --allow-guard overrides and logs), and a track gets a write warning when it writes one.
// Why: routes, registries, i18n and feature flags are where parallel tracks break each other, and before this the
// rule that the orchestrator changes them was only in the docs.
// =============================================================
import { afterAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const H = require('../hotspots.js');
const L = require('../queueLogic.js');
const WW = require('../writeWarn.js');

const temporary: string[] = [];
afterAll(() => {
  for (const d of temporary) fs.rmSync(d, { recursive: true, force: true });
});

const HOT = ['src/routes.ts', 'i18n/', '**/feature-flags.json'];

describe('which paths are hotspots', () => {
  it('a file, a folder and a glob, with backslashes and case ignored', () => {
    expect(H.isHotspot('src/routes.ts', HOT)).toBe(true);
    expect(H.isHotspot('src\\Routes.ts', HOT)).toBe(true);
    expect(H.isHotspot('i18n/nb.json', HOT)).toBe(true);
    expect(H.isHotspot('app/config/feature-flags.json', HOT)).toBe(true);
    expect(H.isHotspot('src/routes.test.ts', HOT)).toBe(false);
    expect(H.isHotspot('src/routes.ts', [])).toBe(false);
    expect(H.hotspotsOf({})).toEqual([]);
    expect(H.hotspotsOf({ hotspots: ['a.ts', 3, ''] })).toEqual(['a.ts']);
  });
});

describe('add and edit', () => {
  it('owned_files cannot hold a hotspot, also not through a folder above it', () => {
    expect(H.ownershipErrors({ owned_files: ['src/routes.ts'] }, HOT)[0]).toMatch(/src\/routes\.ts is a hotspot.*hotspot_patch/);
    expect(H.ownershipErrors({ owned_files: ['src/'] }, HOT)[0]).toMatch(/src\/ covers the hotspot src\/routes\.ts/);
    expect(H.ownershipErrors({ owned_files: ['i18n/nb.json'] }, HOT)).toHaveLength(1);
    expect(H.ownershipErrors({ owned_files: ['src/app.ts'], hotspot_patch: ['src/routes.ts'] }, HOT)).toEqual([]);
  });
  it('hotspot_patch must be a list of hotspots', () => {
    expect(H.ownershipErrors({ hotspot_patch: 'src/routes.ts' }, HOT)[0]).toMatch(/hotspot_patch must be a list/);
    expect(H.ownershipErrors({ hotspot_patch: ['src/app.ts'] }, HOT)[0]).toMatch(/src\/app\.ts is not a hotspot.*owned_files/);
  });
  it('without hotspots configured, nothing is refused', () => {
    expect(H.ownershipErrors({ owned_files: ['src/routes.ts'] }, [])).toEqual([]);
  });
});

describe('one agreed change at a time', () => {
  it('two active tasks with the same hotspot in hotspot_patch conflict', () => {
    const a = { id: 'A', status: 'running', hotspot_patch: ['src/routes.ts'] };
    const b = { id: 'B', status: 'waiting', hotspot_patch: ['src/routes.ts'] };
    const part = L.conflictPart(b, a);
    expect(part).toMatchObject({ type: 'hotspot', name: 'src/routes.ts', with: 'A' });
    expect(part.text).toMatch(/hotspot src\/routes\.ts is being changed by A/);
    expect(L.conflictPart({ ...b, hotspot_patch: ['i18n/nb.json'] }, a)).toBeNull();
  });
});

describe('the merge', () => {
  it('unagreed lists the hotspot changes the task did not agree', () => {
    const task = { id: 'A', hotspot_patch: ['src/routes.ts'] };
    expect(H.unagreed(['src/routes.ts', 'i18n/nb.json', 'src/app.ts'], task, HOT)).toEqual(['i18n/nb.json']);
    expect(H.unagreed(['src/routes.ts'], null, HOT)).toEqual(['src/routes.ts']);
    expect(H.unagreed(['src/routes.ts'], task, [])).toEqual([]);
  });

  it('merge-track.mjs stops with exit 4 on an unagreed hotspot; --allow-guard merges and logs it', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ravenseat-hotspot-'));
    temporary.push(repo);
    const g = (...a: string[]) => {
      const r = spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
      return r.stdout.trim();
    };
    g('init', '-q', '-b', 'main');
    g('config', 'user.name', 'Hotspot Test');
    g('config', 'user.email', 'hotspot@test.local');
    g('config', 'commit.gpgsign', 'false');
    fs.mkdirSync(path.join(repo, 'src'));
    fs.writeFileSync(path.join(repo, 'src', 'routes.ts'), 'export const routes = [];\n');
    g('add', 'src/routes.ts');
    g('commit', '-q', '-m', 'base');
    g('switch', '-q', '-c', 'queue/A');
    fs.writeFileSync(path.join(repo, 'src', 'routes.ts'), "export const routes = ['a'];\n");
    fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
    g('add', 'src/routes.ts', 'src/a.ts');
    g('commit', '-q', '-m', 'track');
    g('switch', '-q', 'main');
    const data = path.join(repo, 'data');
    fs.mkdirSync(data);
    fs.writeFileSync(path.join(data, 'queue.json'), JSON.stringify({ tasks: [{ id: 'A', status: 'review', branch: 'queue/A', owned_files: ['src/a.ts'] }] }));
    const cfg = path.join(repo, 'cfg.json');
    fs.writeFileSync(cfg, JSON.stringify({ baseBranch: 'main', hotspots: ['src/routes.ts'] }));
    const env = { ...process.env, QUEUE_ROOT: repo, QUEUE_CONFIG: cfg, QUEUE_FOLDER: data, QUEUE_TIME_LOG: path.join(data, 'times.jsonl') };
    const SCRIPT = path.resolve(__dirname, '..', '..', 'merge-track.mjs');
    const run = (...a: string[]) => spawnSync(process.execPath, [SCRIPT, 'queue/A', '--keep-worktree', ...a], { cwd: repo, encoding: 'utf8', env });
    const head = g('rev-parse', 'HEAD');
    const stop = run();
    expect(stop.status).toBe(4);
    expect(stop.stderr).toMatch(/HOTSPOT: queue\/A changes shared config that was not agreed/);
    expect(stop.stderr).toMatch(/src\/routes\.ts/);
    expect(g('rev-parse', 'HEAD')).toBe(head);
    const ok = run('--allow-guard');
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toMatch(/HOTSPOT OVERRIDDEN \(--allow-guard\) for queue\/A/);
    const rows = fs.readFileSync(path.join(data, 'times.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(rows.find((r) => r.hotspots)).toMatchObject({ event: 'guard-overridden', hotspots: ['src/routes.ts'] });
  });
});

describe('the write warning', () => {
  it("a track writing an unagreed hotspot, or another task's file, is told at once", () => {
    const task = { id: 'A', owned_files: ['src/a.ts'], hotspot_patch: [] };
    const tasks = [task, { id: 'B', status: 'running', owned_files: ['src/b.ts'] }];
    const hot = WW.assessTrackWrite({ rel: 'src/routes.ts', task, before: 'x', after: 'y', protectedPaths: [], hotspots: HOT, tasks });
    expect(hot.map((w: { kind: string }) => w.kind)).toEqual(['hotspot']);
    expect(hot[0].text).toMatch(/hotspot.*wiring spec/i);
    const foreign = WW.assessTrackWrite({ rel: 'src/b.ts', task, before: 'x', after: 'y', protectedPaths: [], hotspots: HOT, tasks });
    expect(foreign.map((w: { kind: string }) => w.kind)).toEqual(['foreign']);
    expect(foreign[0].text).toMatch(/owned by B/);
    const agreed = WW.assessTrackWrite({ rel: 'src/routes.ts', task: { ...task, hotspot_patch: ['src/routes.ts'] }, before: 'x', after: 'y', protectedPaths: [], hotspots: HOT, tasks });
    expect(agreed).toEqual([]);
  });
});
