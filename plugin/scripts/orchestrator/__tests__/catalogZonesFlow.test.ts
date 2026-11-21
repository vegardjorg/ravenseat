// =============================================================
// catalogZonesFlow.test.ts: `ravenseat catalog zones` and the zone NOTE at add, through the real CLI in a temporary
// project (PG-5, lib/zoneScan.js, cli/catalog.mjs, cli/tasks.mjs; plans/plan-gate-vurdering-2026-11-21.md section 6).
//
// Locks: (1) `catalog zones` only prints what the scan proposes and writes nothing; (2) --write writes each candidate as
// a proposed zone and refuses from a track worktree; (3) a proposed zone has no effect at add, an accepted one gives the
// NOTE line ("is in" for a file, "may touch" for a keyword), and zones.detect false silences it; (4) a second scan
// proposes nothing the catalog already covers.
// Runs queue.mjs against a temporary repo and queue folder. Never the main repo or the real queue.
// =============================================================
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const QUEUE = path.resolve(__dirname, '..', 'queue.mjs');
const ID = ['-c', 'user.name=queue-test', '-c', 'user.email=queue-test@example.invalid'];
const DECISIONS = 'docs/queue/catalog/decisions';

const temporary: string[] = [];
afterAll(() => {
  for (const m of temporary) {
    try {
      fs.rmSync(m, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    } catch {
      /* left for the OS */
    }
  }
});

function project() {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-zones-flow-'));
  temporary.push(folder);
  const repo = path.join(folder, 'repo');
  const worktree = path.join(folder, 'wt-A');
  fs.mkdirSync(repo);
  const globalConfig = path.join(folder, 'global-gitconfig');
  fs.writeFileSync(globalConfig, '');
  const configFile = path.join(folder, 'queue.config.json');
  const setConfig = (c: Record<string, unknown>) =>
    fs.writeFileSync(configFile, JSON.stringify({ baseBranch: 'main', mode: 'lite', ...c }));
  setConfig({});
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CEILING_DIRECTORIES: folder,
    QUEUE_FOLDER: folder,
    QUEUE_CONFIG: configFile,
    QUEUE_ROOT: repo,
    QUEUE_GIT: repo,
    QUEUE_TIME_LOG: path.join(folder, 'times.jsonl'),
    QUEUE_TRANSCRIPTS: path.join(folder, 'transcripts'),
    RAVENSEAT_CLAUDE_DIR: path.join(folder, 'claude'),
    RAVENSEAT_MANAGED_CLAUDE_MD: '',
    RAVENSEAT_INSTRUCTIONS_TOP: repo,
  } as NodeJS.ProcessEnv;
  delete env.QUEUE_SCRATCHPAD;
  delete env.QUEUE_SESSION;
  const write = (f: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
    fs.writeFileSync(path.join(repo, f), text);
  };
  const g = (args: string[], cwd = repo) =>
    execFileSync('git', ['-C', cwd, ...ID, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  write('package.json', JSON.stringify({ private: true, scripts: { test: 'vitest run' } }));
  write('db/migrations/001_start.sql', 'create table t (id int);\n');
  write('src/auth/session.ts', 'export const session = 1;\n');
  write('src/ui/page.ts', 'export const page = 1;\n');
  g(['init', '-q', '-b', 'main']);
  g(['add', '--', '.']);
  g(['commit', '-q', '-m', 'start']);
  g(['branch', 'queue/A']);
  g(['worktree', 'add', '-q', worktree, 'queue/A']);
  fs.writeFileSync(
    path.join(folder, 'queue.json'),
    JSON.stringify({ limits: {}, resolved: [], projects: { p: { title: 'P' } }, tasks: [] }),
  );
  const run = (args: string[], cwd = repo) => {
    const r = spawnSync(process.execPath, [QUEUE, ...args], { encoding: 'utf8', env, cwd });
    return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '', all: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  const decisions = () => (fs.existsSync(path.join(repo, DECISIONS)) ? fs.readdirSync(path.join(repo, DECISIONS)) : []);
  const add = (id: string, own: object) => {
    const file = path.join(folder, `${id}.json`);
    fs.writeFileSync(
      file,
      JSON.stringify([{ id, title: `Task ${id}`, project: 'p', class: 'K', content_min: 30, value: 5, added_by: 'test', ...own }]),
    );
    return run(['add', '--file', file]);
  };
  return { folder, repo, worktree, run, decisions, add, setConfig };
}

describe('ravenseat catalog zones', () => {
  it('prints the candidates and writes nothing without --write', () => {
    const p = project();
    const r = p.run(['catalog', 'zones', '--json']);
    expect(r.code, r.all).toBe(0);
    const { candidates } = JSON.parse(r.out);
    expect(candidates.map((c: any) => c.key).sort()).toEqual(['auth', 'data-model']);
    expect(candidates.find((c: any) => c.key === 'data-model').paths).toEqual(['db/migrations/**']);
    const text = p.run(['catalog', 'zones']);
    expect(text.out).toMatch(/Zone candidates \(2\)/);
    expect(text.out).toMatch(/Nothing is added yet/);
    expect(p.decisions().filter((f) => /^D-\d+/.test(f))).toEqual([]);
  });

  it('--write proposes them, is refused from a track, and a second scan proposes nothing new', () => {
    const p = project();
    const track = p.run(['catalog', 'zones', '--write'], p.worktree);
    expect(track.code).not.toBe(0);
    expect(p.decisions().filter((f) => /^D-\d+/.test(f))).toEqual([]);
    const r = p.run(['catalog', 'zones', '--write']);
    expect(r.code, r.all).toBe(0);
    expect(r.out).toMatch(/Proposed D-000\d \(zone\): Data model and migrations/);
    expect(r.out).toMatch(/Proposed D-000\d \(zone\): Sign-in and permissions/);
    const files = p.decisions().filter((f) => /^D-\d+/.test(f));
    expect(files).toHaveLength(2);
    const one = fs.readFileSync(path.join(p.repo, DECISIONS, files[0]), 'utf8');
    expect(one).toMatch(/^status: proposed$/m);
    expect(one).toMatch(/^kind: zone$/m);
    const check = JSON.parse(p.run(['catalog', 'check', '--json']).out);
    expect(check.errors).toEqual([]);
    expect(JSON.parse(p.run(['catalog', 'zones', '--json']).out).candidates).toEqual([]);
  });
});

describe('the zone NOTE line at add', () => {
  it('a proposed zone has no effect; accepted, a file gives "is in", a keyword "may touch"; off silences it', () => {
    const p = project();
    const w = p.run(['catalog', 'zones', '--write', '--json']);
    expect(w.code, w.all).toBe(0);
    const model = JSON.parse(w.out).written.find((x: any) => x.title === 'Data model and migrations').id;
    const before = p.add('T-1', { owned_files: ['db/migrations/002_more.sql'] });
    expect(before.code, before.all).toBe(0);
    expect(before.all).not.toMatch(/NOTE: T-1/);
    const acc = p.run(['catalog', 'accept', model, '--by', 'owner']);
    expect(acc.code, acc.all).toBe(0);
    const inZone = p.add('T-2', { owned_files: ['db/migrations/003_more.sql'] });
    expect(inZone.all).toContain(`NOTE: T-2 is in sensitive zone ${model} Data model and migrations (files: db/migrations/003_more.sql)`);
    const near = p.add('T-3', { owned_files: ['src/ui/page.ts'], title: 'Add a migration for the page' });
    expect(near.all).toContain(`NOTE: T-3 may touch sensitive zone ${model}`);
    const plain = p.add('T-4', { owned_files: ['src/ui/page.ts'] });
    expect(plain.all).not.toMatch(/NOTE: T-4/);
    p.setConfig({ zones: { detect: false } });
    const off = p.add('T-5', { owned_files: ['db/migrations/004_more.sql'] });
    expect(off.code, off.all).toBe(0);
    expect(off.all).not.toMatch(/NOTE: T-5/);
  });
});
