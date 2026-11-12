// =============================================================
// doctorRepo.test.ts: the repo-state checks of `ravenseat doctor` (scripts/orchestrator/cli/doctorRepo.mjs).
//
// Why (review 2026-11-02, section 4): three ways a user breaks the queue without any message.
//   - A merge left half-done in the main checkout (MERGE_HEAD): the next `ravenseat merge` fails in a confusing way.
//   - `disableAllHooks: true` in a Claude settings file: every guard (push, read, context, end gate) is off, silently.
//   - `git reset --hard` on the base branch after merges: the tasks stay `done` while their work is gone from base.
// Each must give a WARN with a fix hint, never a FAIL, and the doctor must write nothing. Tested against temporary git
// repos and a temporary home folder (HOME/USERPROFILE), never the real project or the real ~/.claude.
// =============================================================
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PLUGIN = path.resolve(__dirname, '..', '..', '..', '..');
const QUEUE = path.join(PLUGIN, 'scripts', 'orchestrator', 'queue.mjs');
const temporary: string[] = [];
afterAll(() => {
  for (const m of temporary) fs.rmSync(m, { recursive: true, force: true });
});

type Check = { status: 'OK' | 'INFO' | 'WARN' | 'FAIL'; name: string; message: string; fix: string | null };

function project(tasks: object[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-doctor-repo-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-doctor-home-'));
  temporary.push(root, home);
  const g = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
      cwd: root,
      stdio: 'pipe',
      encoding: 'utf8',
    });
  g('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(root, 'README.md'), 'x\n');
  g('add', 'README.md');
  g('commit', '-q', '-m', 'start');
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  const write = (t: object[]) =>
    fs.writeFileSync(path.join(data, 'queue.json'), JSON.stringify({ tasks: t, projects: {} }));
  write(tasks);
  const configFile = path.join(root, 'queue.config.json');
  fs.writeFileSync(configFile, JSON.stringify({ baseBranch: 'main', loadGuard: { minFreeMemoryPct: null } }));
  const env = {
    ...process.env,
    QUEUE_ROOT: root,
    QUEUE_FOLDER: data,
    QUEUE_CONFIG: configFile,
    QUEUE_GIT: root,
    QUEUE_HOOKS: path.join(PLUGIN, 'hooks', 'hooks.json'),
    QUEUE_TIME_LOG: path.join(data, 'times.jsonl'),
    HOME: home,
    USERPROFILE: home,
  };
  const json = () => {
    const r = spawnSync(process.execPath, [QUEUE, 'doctor', '--json'], { encoding: 'utf8', env, cwd: root });
    return JSON.parse(r.stdout) as { ok: boolean; checks: Check[] };
  };
  const named = (name: string) => json().checks.filter((c) => c.name === name);
  return { root, home, data, g, write, json, named };
}

describe('ravenseat doctor: repo state', () => {
  it('a clean repo: merge, hooks-off and in-base are OK', () => {
    const p = project([{ id: 'A-1', status: 'done', class: 'K' }]);
    const c = p.json().checks;
    expect(c.find((x) => x.name === 'merge')).toMatchObject({ status: 'OK' });
    expect(c.find((x) => x.name === 'hooks-off')).toMatchObject({ status: 'OK' });
    // A-1 has no branch and no stored merge commit: nothing to check, said plainly (graceful).
    expect(c.find((x) => x.name === 'in-base')).toMatchObject({ status: 'OK' });
  }, 60_000);

  it('a lingering MERGE_HEAD in the main checkout gives a WARN with merge --abort as the fix', () => {
    const p = project([]);
    p.g('checkout', '-q', '-b', 'side');
    fs.writeFileSync(path.join(p.root, 'README.md'), 'side\n');
    p.g('commit', '-q', '-am', 'side');
    p.g('checkout', '-q', 'main');
    fs.writeFileSync(path.join(p.root, 'README.md'), 'main\n');
    p.g('commit', '-q', '-am', 'main');
    try {
      p.g('merge', '--no-edit', 'side'); // conflict: MERGE_HEAD stays
    } catch {
      /* expected */
    }
    expect(fs.existsSync(path.join(p.root, '.git', 'MERGE_HEAD'))).toBe(true);
    const [m] = p.named('merge');
    expect(m.status).toBe('WARN');
    expect(m.message).toMatch(/unfinished merge.*MERGE_HEAD/);
    expect(m.message).toMatch(/1 unresolved file/);
    expect(m.fix).toMatch(/merge --abort/);
    expect(p.json().ok).toBe(true); // a WARN never fails the run
  }, 60_000);

  it('disableAllHooks in project, local or user settings gives a WARN naming each file', () => {
    const p = project([]);
    fs.mkdirSync(path.join(p.root, '.claude'));
    fs.writeFileSync(path.join(p.root, '.claude', 'settings.local.json'), JSON.stringify({ disableAllHooks: true }));
    fs.writeFileSync(path.join(p.root, '.claude', 'settings.json'), JSON.stringify({ disableAllHooks: false }));
    fs.mkdirSync(path.join(p.home, '.claude'));
    fs.writeFileSync(path.join(p.home, '.claude', 'settings.json'), JSON.stringify({ disableAllHooks: true }));
    const s = p.named('hooks-off');
    expect(s).toHaveLength(1);
    expect(s[0].status).toBe('WARN');
    expect(s[0].message).toContain('settings.local.json');
    expect(s[0].message).toContain(path.join(p.home, '.claude', 'settings.json'));
    expect(s[0].message).not.toMatch(/[\\/]\.claude[\\/]settings\.json.*[\\/]\.claude[\\/]settings\.json/); // false is fine
    expect(s[0].fix).toMatch(/disableAllHooks/);
  }, 60_000);

  it('a broken settings file is not this check’s business (no crash, no FAIL)', () => {
    const p = project([]);
    fs.mkdirSync(path.join(p.root, '.claude'));
    fs.writeFileSync(path.join(p.root, '.claude', 'settings.json'), '{ broken');
    expect(p.named('hooks-off')[0].status).toBe('OK');
  }, 60_000);

  it('done tasks whose branch or merge commit is not in base give a WARN; merged ones and cancelled ones do not', () => {
    const p = project([]);
    // queue/A-1: merged into main. queue/A-2: never merged (as after git reset --hard on main). A-3: a stored merge
    // commit that main no longer contains, branch deleted. A-4: cancelled, unmerged (not counted). A-5: done, branch gone.
    p.g('checkout', '-q', '-b', 'queue/A-1');
    fs.writeFileSync(path.join(p.root, 'a1.txt'), '1\n');
    p.g('add', 'a1.txt');
    p.g('commit', '-q', '-m', 'a1');
    p.g('checkout', '-q', 'main');
    p.g('merge', '-q', '--no-ff', '--no-edit', 'queue/A-1');
    p.g('checkout', '-q', '-b', 'queue/A-2');
    fs.writeFileSync(path.join(p.root, 'a2.txt'), '2\n');
    p.g('add', 'a2.txt');
    p.g('commit', '-q', '-m', 'a2');
    p.g('checkout', '-q', 'main');
    p.g('merge', '-q', '--no-ff', '--no-edit', 'queue/A-2');
    const lost = p.g('rev-parse', 'HEAD').trim();
    p.g('reset', '-q', '--hard', 'HEAD~1'); // the merge of A-2 is gone from main
    p.g('branch', '-q', 'queue/A-4', 'queue/A-2');
    p.write([
      { id: 'A-1', status: 'done', branch: 'queue/A-1' },
      { id: 'A-2', status: 'done', branch: 'queue/A-2' },
      { id: 'A-3', status: 'done', branch: 'queue/A-3', merge_commit: lost },
      { id: 'A-4', status: 'cancelled', branch: 'queue/A-4' },
      { id: 'A-5', status: 'done', branch: 'queue/A-5' },
    ]);
    const [c] = p.named('in-base');
    expect(c.status).toBe('WARN');
    expect(c.message).toMatch(/2 done task\(s\)/);
    expect(c.message).toContain('A-2 (queue/A-2)');
    expect(c.message).toContain(`A-3 (${lost.slice(0, 9)})`);
    expect(c.message).not.toMatch(/A-1|A-4/);
    expect(c.message).toMatch(/1 not checked/); // A-5: branch gone, nothing stored
    expect(c.fix).toMatch(/git merge --no-ff/);
  }, 60_000);
});
