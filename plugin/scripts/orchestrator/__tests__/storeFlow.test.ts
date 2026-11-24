// =============================================================
// storeFlow.test.ts: the storage layer through the real CLI (lib/store/, cli/store.mjs, LAGRING-1a), in a temporary
// project and data folder. Never the main repo or the real queue.
//
// Locks: (1) `catalog propose` never hands out an id twice: a deleted proposal does not free its id, and concurrent
// proposals get one id each; (2) concurrent `catalog accept`s keep every ledger record; (3) a plans.json write keeps
// plans.json.prev and a corrupt plans.json stops with the restore hint (the command and doctor); (4) doctor lists a data
// folder entry the register does not know and an orphaned tmp file, and deletes nothing; (5) `store sweep --tmp --dry`
// lists and deletes nothing, and `store sweep` is refused from a track worktree; (6) `guards add` takes its id from the
// shared reservation, so two branches never get the same G-id, and refuses an id the registry already has.
// =============================================================
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const QUEUE = path.resolve(__dirname, '..', 'queue.mjs');
const ID = ['-c', 'user.name=queue-test', '-c', 'user.email=queue-test@example.invalid'];
const CAT = 'docs/queue/catalog';
const DEAD_PID = 2_000_000_001;

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
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-store-flow-'));
  temporary.push(folder);
  const repo = path.join(folder, 'repo');
  const data = path.join(folder, 'data');
  const worktree = path.join(folder, 'wt-A');
  fs.mkdirSync(repo);
  fs.mkdirSync(data);
  const globalConfig = path.join(folder, 'global-gitconfig');
  fs.writeFileSync(globalConfig, '');
  const configFile = path.join(folder, 'queue.config.json');
  fs.writeFileSync(configFile, JSON.stringify({ baseBranch: 'main', mode: 'lite' }));
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CEILING_DIRECTORIES: folder,
    QUEUE_FOLDER: data,
    QUEUE_CONFIG: configFile,
    QUEUE_ROOT: repo,
    QUEUE_GIT: repo,
    QUEUE_TIME_LOG: path.join(data, 'times.jsonl'),
    QUEUE_TRANSCRIPTS: path.join(folder, 'transcripts'),
    QUEUE_HOOKS: path.join(folder, 'no-hooks.json'),
    RAVENSEAT_CLAUDE_DIR: path.join(folder, 'claude'),
    RAVENSEAT_MANAGED_CLAUDE_MD: '',
    RAVENSEAT_INSTRUCTIONS_TOP: repo,
    DISABLE_UPDATES: '1',
  } as NodeJS.ProcessEnv;
  delete env.QUEUE_SCRATCHPAD;
  delete env.QUEUE_SESSION;
  const g = (args: string[], cwd = repo) => execFileSync('git', ['-C', cwd, ...ID, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
  g(['init', '-q', '-b', 'main']);
  g(['add', '--', 'package.json']);
  g(['commit', '-q', '-m', 'start']);
  g(['branch', 'queue/A']);
  g(['worktree', 'add', '-q', worktree, 'queue/A']);
  fs.writeFileSync(path.join(data, 'queue.json'), JSON.stringify({ limits: {}, resolved: [], projects: { p: { title: 'P' } }, tasks: [] }));
  const run = (args: string[], cwd = repo) => {
    const r = spawnSync(process.execPath, [QUEUE, ...args], { encoding: 'utf8', env, cwd, timeout: 60_000 });
    return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '', all: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  const runAsync = (args: string[], cwd = repo) =>
    new Promise<{ code: number | null; all: string }>((resolve) => {
      const c = spawn(process.execPath, [QUEUE, ...args], { env, cwd });
      let all = '';
      c.stdout.on('data', (d) => (all += d));
      c.stderr.on('data', (d) => (all += d));
      c.on('exit', (code) => resolve({ code, all }));
    });
  const decisions = () => {
    try {
      return fs.readdirSync(path.join(repo, CAT, 'decisions')).filter((n) => /^D-\d{4}-/.test(n)).sort();
    } catch {
      return [];
    }
  };
  return { folder, repo, data, worktree, run, runAsync, decisions };
}

const propose = (title: string) => ['catalog', 'propose', '--title', title, '--invariant', `Rule for ${title}.`, '--paths', 'lib/**', '--json'];

describe('catalog propose and accept on the store', () => {
  it('a deleted proposal does not free its id', () => {
    const p = project();
    const first = p.run(propose('First rule'));
    expect(first.code, first.all).toBe(0);
    expect(JSON.parse(first.out).id).toBe('D-0001');
    for (const n of p.decisions()) fs.rmSync(path.join(p.repo, CAT, 'decisions', n));
    const second = p.run(propose('Second rule'));
    expect(second.code, second.all).toBe(0);
    expect(JSON.parse(second.out).id).toBe('D-0002');
  }, 60_000);

  it('concurrent proposals never share an id', async () => {
    const p = project();
    const rs = await Promise.all(['Alpha rule', 'Beta rule', 'Gamma rule', 'Delta rule'].map((t) => p.runAsync(propose(t))));
    for (const r of rs) expect(r.code, r.all).toBe(0);
    const ids = p.decisions().map((n) => n.slice(0, 6));
    expect(ids.length).toBe(4);
    expect(new Set(ids).size).toBe(4);
  }, 120_000);

  it('concurrent accepts keep every record in the ledger', async () => {
    const p = project();
    for (const t of ['One rule', 'Two rule', 'Three rule']) expect(p.run(propose(t)).code).toBe(0);
    const rs = await Promise.all(['D-0001', 'D-0002', 'D-0003'].map((id) => p.runAsync(['catalog', 'accept', id, '--by', 'owner'])));
    for (const r of rs) expect(r.code, r.all).toBe(0);
    const ledger = JSON.parse(fs.readFileSync(path.join(p.data, 'catalog-accepted.json'), 'utf8'));
    expect(Object.keys(ledger.decisions).sort()).toEqual(['D-0001', 'D-0002', 'D-0003']);
    // No tmp file of a decision write is left in the catalog.
    expect(fs.readdirSync(path.join(p.repo, CAT, 'decisions')).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  }, 120_000);
});

describe('plans.json on the store', () => {
  it('a write keeps plans.json.prev; a corrupt plans.json gives the restore hint in the command and in doctor', () => {
    const p = project();
    expect(p.run(['plan', 'capture', 'First idea', '--text', 'One.']).code).toBe(0);
    const two = p.run(['plan', 'capture', 'Second idea', '--text', 'Two.']);
    expect(two.code, two.all).toBe(0);
    const file = path.join(p.data, 'plans.json');
    expect(fs.existsSync(`${file}.prev`)).toBe(true);
    expect(JSON.parse(fs.readFileSync(`${file}.prev`, 'utf8')).entries.length).toBe(1);
    fs.writeFileSync(file, '{"entries": [');
    const list = p.run(['plan', 'show']);
    expect(list.code).not.toBe(0);
    expect(list.all).toMatch(/plans\.json does not parse/);
    expect(list.all).toMatch(/plans\.json\.prev holds the previous good state \(1 plan\(s\)/);
    const doctor = p.run(['doctor']);
    expect(doctor.all).toMatch(/plans\.json does not parse/);
    expect(doctor.all).toMatch(/plans\.json\.prev holds the previous good state/);
  }, 120_000);
});

describe('doctor and store sweep', () => {
  const seed = (data: string) => {
    fs.writeFileSync(path.join(data, 'my-own-notes.txt'), 'x');
    const orphan = path.join(data, `plans.json.${DEAD_PID}.tmp`);
    fs.writeFileSync(orphan, '{"half');
    const old = (Date.now() - 3 * 3600_000) / 1000;
    fs.utimesSync(orphan, old, old);
    return orphan;
  };

  it('doctor lists an unknown entry and an orphaned tmp file, with the command, and deletes nothing', () => {
    const p = project();
    const orphan = seed(p.data);
    const r = p.run(['doctor']);
    expect(r.all).toMatch(/INFO\s+store\s+.*my-own-notes\.txt/);
    expect(r.all).toMatch(new RegExp(`plans\\.json\\.${DEAD_PID}\\.tmp`));
    expect(r.all).toMatch(/store sweep --tmp/);
    expect(fs.existsSync(orphan)).toBe(true);
    expect(fs.existsSync(path.join(p.data, 'my-own-notes.txt'))).toBe(true);
  }, 120_000);

  it('store sweep --tmp --dry lists and deletes nothing; without --dry it removes the orphan', () => {
    const p = project();
    const orphan = seed(p.data);
    const dry = p.run(['store', 'sweep', '--tmp', '--dry']);
    expect(dry.code, dry.all).toBe(0);
    expect(dry.all).toMatch(new RegExp(`plans\\.json\\.${DEAD_PID}\\.tmp`));
    expect(dry.all).toMatch(/nothing was removed/i);
    expect(fs.existsSync(orphan)).toBe(true);
    const wet = p.run(['store', 'sweep', '--tmp']);
    expect(wet.code, wet.all).toBe(0);
    expect(fs.existsSync(orphan)).toBe(false);
    expect(fs.existsSync(path.join(p.data, 'my-own-notes.txt'))).toBe(true);
  }, 60_000);

  it('store sweep is refused from a track worktree', () => {
    const p = project();
    const orphan = seed(p.data);
    const r = p.run(['store', 'sweep', '--tmp'], p.worktree);
    expect(r.code).not.toBe(0);
    expect(r.all).toMatch(/track worktree/);
    expect(fs.existsSync(orphan)).toBe(true);
  }, 60_000);
});

describe('guards add on the store', () => {
  const ADD = ['guards', 'add', '--kind', 'review', '--title', 'Check one', '--explain', 'A review point.', '--against', 'a lesson'];

  it('two branches never get the same G-id; a hand-added id is stepped over, and a duplicate is named', () => {
    const p = project();
    const main = p.run(ADD);
    expect(main.code, main.all).toBe(0);
    expect(main.all).toMatch(/Added G-1 /);
    // The track's branch has no G-1 in its own guards.json, and still gets G-2 from the shared reservation.
    const track = p.run(ADD, p.worktree);
    expect(track.code, track.all).toBe(0);
    expect(track.all).toMatch(/Added G-2 /);
    // A hand edit added G-3: the next add steps over it (G-4), never a second G-3.
    const file = path.join(p.repo, '.ravenseat', 'guards.json');
    const reg = JSON.parse(fs.readFileSync(file, 'utf8'));
    reg.guards.push({ ...reg.guards[0], id: 'G-3', task: null });
    fs.writeFileSync(file, `${JSON.stringify(reg, null, 2)}\n`);
    const dup = p.run(ADD);
    expect(dup.code, dup.all).toBe(0);
    expect(dup.all).toMatch(/Added G-4 /);
    reg.guards.push({ ...reg.guards[0], id: 'G-3', task: null });
    fs.writeFileSync(file, `${JSON.stringify(reg, null, 2)}\n`);
    const listed = p.run(['guards']);
    expect(listed.all).toMatch(/G-3 appears 2 times/);
  }, 120_000);
});
