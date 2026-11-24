// =============================================================
// pushGuardBigLog.test.ts: the push guard's "what must stay out of git" deny (hook-push-guard.mjs trackingDeny) on a big
// history and on a history git cannot read (ARK-1 T2, architecture review A1a).
//
// Locks: (1) a first push whose `git log --name-only` prints more than 1 MB (6000 long file names, made with git mktree)
// and tracks a private path is still DENIED: the old 1 MB buffer turned the overflow into "nothing to deny"; (2) a push
// whose commits git cannot read (a missing tree object) is denied with "could not read", never let through unchecked.
// =============================================================
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const HOOK = path.resolve(__dirname, '..', 'hook-push-guard.mjs');
const ID = ['-c', 'user.name=queue-test', '-c', 'user.email=queue-test@example.invalid'];
const temporary: string[] = [];
afterAll(() => {
  for (const f of temporary) fs.rmSync(f, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
});

/** A repo on main with one commit holding `names` (one shared blob) and secret/key.txt; no remote (a first push). */
function bigRepo(names: number) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-biglog-'));
  temporary.push(root);
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  const g = (args: string[], input?: string) =>
    execFileSync('git', ['-C', repo, ...ID, ...args], { encoding: 'utf8', input, maxBuffer: 1 << 28 }).trim();
  g(['init', '-q', '-b', 'main']);
  const blob = g(['hash-object', '-w', '--stdin'], 'x\n');
  const secretTree = g(['mktree'], `100644 blob ${blob}\tkey.txt\n`);
  const pad = 'n'.repeat(200);
  let rows = `040000 tree ${secretTree}\tsecret\n`;
  for (let i = 0; i < names; i++) rows += `100644 blob ${blob}\tf${String(i).padStart(5, '0')}-${pad}.txt\n`;
  const tree = g(['mktree'], rows);
  const commit = g(['commit-tree', tree, '-m', 'start']);
  g(['update-ref', 'refs/heads/main', commit]);
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, 'queue.json'), JSON.stringify({ tasks: [], resolved: [] }));
  const configFile = path.join(root, 'queue.config.json');
  // Only the tracking deny is under test: the other push questions are off.
  fs.writeFileSync(
    configFile,
    JSON.stringify({
      baseBranch: 'main',
      privatePaths: ['secret/'],
      secretScan: { enabled: false },
      push: { controlsWarning: false, minTasks: 0 },
    }),
  );
  const env = { ...process.env, QUEUE_FOLDER: data, QUEUE_CONFIG: configFile, QUEUE_ROOT: repo, QUEUE_GIT: repo };
  const push = () => {
    const r = spawnSync(process.execPath, [HOOK], {
      cwd: repo,
      env,
      encoding: 'utf8',
      input: JSON.stringify({ tool_input: { command: 'git push origin main' }, cwd: repo }),
      timeout: 60_000,
    });
    return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null;
  };
  return { repo, g, tree, push };
}

describe('push guard: the tracking deny on a big or unreadable history', () => {
  it('denies a private path in a first push whose file list is over 1 MB', () => {
    const r = bigRepo(6000);
    // The premise: the list git prints is over the old 1 MB default buffer.
    expect(r.g(['log', '--format=', '--name-only', 'refs/heads/main', '--']).length).toBeGreaterThan(1024 * 1024);
    const out = r.push();
    expect(out?.permissionDecision).toBe('deny');
    expect(out?.permissionDecisionReason).toMatch(/privatePaths: secret\/key\.txt/);
  }, 90_000);

  it('denies, with "could not read", when git cannot read the commits', () => {
    const r = bigRepo(2);
    // Take the root tree object away: rev-parse still works, git log --name-only fails.
    const obj = path.join(r.repo, '.git', 'objects', r.tree.slice(0, 2), r.tree.slice(2));
    fs.chmodSync(obj, 0o644);
    fs.rmSync(obj);
    const out = r.push();
    expect(out?.permissionDecision).toBe('deny');
    expect(out?.permissionDecisionReason).toMatch(/could not read/);
  }, 90_000);
});
