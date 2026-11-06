// =============================================================
// gateCoverageTamper.test.ts: what a gate run can do outside the commit, against real git repos and the real gates.mjs.
//
// Locks: (1) the scenario this guards against: a gate command runs scrubbed, but it can plant a hook in the shared .git,
// and that hook runs at the orchestrator's next git command WITH the token the gate never saw. Detection does not stop
// that (nothing is restored), it makes the run red and names the hook; (2) a change to a config value that runs a
// program, or to core.hooksPath, is red and named without its value; a config change that runs nothing is not; (3) a
// track's own run is red too, and records nothing; (4) the limit, on purpose: an ignored, untracked file changes a gate's
// result on the same sha and setup, and the entries show the counts; (5) the shared links and their lockfile hashes.
// Runs gates.mjs against a temporary repo with a worktree (QUEUE_FOLDER, QUEUE_ROOT, QUEUE_GIT), never the main repo. The
// global and system git config are switched off, so a developer's own core.hooksPath cannot change the result.
// =============================================================
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const GATES = path.join(ROOT, 'scripts', 'orchestrator', 'gates.mjs');
const ID = ['-c', 'user.name=queue-test', '-c', 'user.email=queue-test@example.invalid'];
const TOKEN = 'test-token-not-for-gates';

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

/** A temporary project: a repo on develop, the branch queue/A checked out in a worktree, one committed file per `files`. */
function project(config: Record<string, unknown>, files: Record<string, string> = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-gate-coverage-'));
  temporary.push(folder);
  const repo = path.join(folder, 'repo');
  const worktree = path.join(folder, 'wt-A');
  fs.mkdirSync(repo);
  const noConfig = path.join(folder, 'no-gitconfig');
  fs.writeFileSync(noConfig, '');
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: noConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    QUEUE_FOLDER: folder,
    QUEUE_CONFIG: path.join(folder, 'queue.config.json'),
    QUEUE_ROOT: folder,
    QUEUE_GIT: repo,
    QUEUE_TIME_LOG: path.join(folder, 'times.jsonl'),
    GITHUB_TOKEN: TOKEN,
  } as NodeJS.ProcessEnv;
  const g = (args: string[], cwd = repo) =>
    execFileSync('git', ['-C', cwd, ...ID, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  g(['init', '-q', '-b', 'develop']);
  fs.writeFileSync(path.join(repo, 'README.md'), 'start\n');
  g(['add', '--', 'README.md']);
  g(['commit', '-q', '-m', 'start']);
  g(['branch', 'queue/A']);
  g(['worktree', 'add', '-q', worktree, 'queue/A']);
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(worktree, name)), { recursive: true });
    fs.writeFileSync(path.join(worktree, name), text);
    g(['add', '--', name], worktree);
  }
  if (Object.keys(files).length) g(['commit', '-q', '-m', 'the track'], worktree);
  fs.writeFileSync(env.QUEUE_CONFIG as string, JSON.stringify({ baseBranch: 'develop', ...config }));
  /** gates.mjs as ravenseat receive runs it: --evidence in the track's worktree. */
  const gates = () => {
    const r = spawnSync(process.execPath, [GATES, '--quick', '--evidence', '--cwd', worktree, '--track', 'A'], {
      cwd: worktree,
      encoding: 'utf8',
      env,
    });
    return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  const evidence = () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(folder, 'gate-evidence.json'), 'utf8')).entries as Record<string, unknown>[];
    } catch {
      return [];
    }
  };
  return { folder, repo, worktree, env, g, gates, evidence, tip: () => g(['rev-parse', 'queue/A']) };
}

/** A script that plants a post-merge hook in the effective hooks folder; the hook notes the token it finds. */
const planter = (hookOut: string, seen: string) =>
  [
    "const cp = require('child_process'), fs = require('fs'), path = require('path');",
    `fs.writeFileSync(${JSON.stringify(seen)}, process.env.GITHUB_TOKEN || 'none');`,
    "const hooks = path.resolve(cp.execFileSync('git', ['rev-parse', '--git-path', 'hooks'], { encoding: 'utf8' }).trim());",
    'fs.mkdirSync(hooks, { recursive: true });',
    "const f = path.join(hooks, 'post-merge');",
    `fs.writeFileSync(f, ${JSON.stringify(`#!/bin/sh\necho "$GITHUB_TOKEN" > "${hookOut.split(path.sep).join('/')}"\n`)});`,
    'fs.chmodSync(f, 0o755);',
    '',
  ].join('\n');

describe('a gate command and the shared .git', () => {
  it('a planted hook runs at the orchestrator\'s next git command, with the token the gate was scrubbed of', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-gate-hook-'));
    temporary.push(base);
    const hookOut = path.join(base, 'hook-saw.txt');
    const seen = path.join(base, 'gate-saw.txt');
    const p = project({ gates: { quick: ['node plant.cjs'] } }, { 'plant.cjs': planter(hookOut, seen) });
    const r = p.gates();
    // The gate itself was scrubbed.
    expect(fs.readFileSync(seen, 'utf8')).toBe('none');
    expect(fs.existsSync(hookOut)).toBe(false);
    // Detected: red although the command exited 0, the hook named, what to inspect said.
    expect(r.code).toBe(1);
    expect(r.out).toContain('hook added: post-merge');
    expect(r.out).toContain('git rev-parse --git-path hooks');
    expect(p.evidence().at(-1)).toMatchObject({ sha: p.tip(), ok: false, exit: 0, tampered: true, writer: 'orchestrator' });
    expect(p.evidence().at(-1).tamper_reason).toContain('hook added: post-merge');
    // Not prevented: the orchestrator's next git command, the merge of the track in the main checkout with its full
    // environment, runs the hook, and the hook has the token. This is why the run must be red and read by a person.
    p.g(['merge', '-q', '--no-ff', '--no-edit', 'queue/A']);
    expect(fs.readFileSync(hookOut, 'utf8').trim()).toBe(TOKEN);
  });

  it('a gate that leaves hooks and config alone stays green; the entry has no tamper fields', () => {
    const p = project({ gates: { quick: ['node -e "process.exit(0)"'] } });
    const r = p.gates();
    expect(r.code).toBe(0);
    expect(r.out).toContain('ALL GREEN');
    expect(p.evidence().at(-1)).toMatchObject({ ok: true });
    expect(p.evidence().at(-1)).not.toHaveProperty('tampered');
    expect(p.evidence().at(-1)).not.toHaveProperty('tamper_reason');
  });

  it('a config value that runs a program is red and named, never with its value; other config is not watched', () => {
    const SECRET = 'value-that-must-not-be-echoed';
    const p = project({ gates: { quick: [`git config core.sshCommand ${SECRET}`, 'git config alias.st status'] } });
    const r = p.gates();
    expect(r.code).toBe(1);
    expect(r.out).toContain('git config changed: alias.st, core.sshcommand');
    expect(r.out).not.toContain(`changed: ${SECRET}`);
    expect(JSON.stringify(p.evidence().at(-1).tamper_reason)).not.toContain(SECRET);
    expect(p.evidence().at(-1)).toMatchObject({ ok: false, tampered: true });

    const q = project({ gates: { quick: ['git config user.nickname someone'] } });
    expect(q.gates().code).toBe(0);
  });

  it('a moved hooks folder (core.hooksPath) is red and named', () => {
    const p = project({ gates: { quick: ['git config core.hooksPath elsewhere'] } });
    const r = p.gates();
    expect(r.code).toBe(1);
    expect(r.out).toContain('the effective hooks folder moved');
    expect(r.out).toContain('core.hookspath');
  });

  it('a track\'s own run is red too and records nothing', () => {
    const p = project({ gates: { quick: ['git config core.pager cat'] } });
    const r = spawnSync(process.execPath, [GATES, '--quick'], { cwd: p.worktree, encoding: 'utf8', env: p.env });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('git config changed: core.pager');
    expect(p.evidence()).toHaveLength(0);
  });
});

describe('what the evidence covers', () => {
  // Green only where the ignored, untracked file local.flag exists.
  const GATE = `node -e "process.exit(require('fs').existsSync('local.flag')?0:1)"`;

  it('same sha, different result: an ignored, untracked file decides the gate, and the entry shows it', () => {
    const p = project({ gates: { quick: [GATE] } }, { '.gitignore': 'local.flag\n' });
    const sha = p.tip();
    const red = p.gates();
    expect(red.code).toBe(1);
    expect(red.out).toContain(`Evidence for ${sha.slice(0, 12)}: ran locally in the track's worktree.`);
    expect(p.evidence().at(-1)).toMatchObject({ sha, ok: false, clean: true, runner: 'local-worktree', untracked: 0, ignored_present: 0, shared_links: [] });

    fs.writeFileSync(path.join(p.worktree, 'local.flag'), 'on\n');
    const green = p.gates();
    expect(green.code).toBe(0);
    expect(green.out).toContain('ran locally in the track\'s worktree, 1 ignored.');
    // The same commit and the same setup, the other result: the sha does not name what decided it.
    const [before, after] = p.evidence().slice(-2);
    expect(after).toMatchObject({ sha, ok: true, clean: true, runner: 'local-worktree', untracked: 0, ignored_present: 1 });
    expect(after.sha).toBe(before.sha);
    expect(after.setup_hash).toBe(before.setup_hash);
    // No file names: the entry says how many, never which.
    expect(JSON.stringify({ ...after, gates: [], failed: [] })).not.toContain('local.flag');
    expect(p.tip()).toBe(sha);
  });

  it('counts untracked files one by one and an ignored folder as one; files a gate leaves behind are not counted', () => {
    const made = `node -e "require('fs').writeFileSync('made-by-gate.txt','x')"`;
    const p = project({ gates: { quick: [made] } }, { '.gitignore': 'dist/\n' });
    fs.mkdirSync(path.join(p.worktree, 'notes', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(p.worktree, 'notes', 'a.txt'), 'a');
    fs.writeFileSync(path.join(p.worktree, 'notes', 'deep', 'b.txt'), 'b');
    fs.mkdirSync(path.join(p.worktree, 'dist'));
    fs.writeFileSync(path.join(p.worktree, 'dist', 'x.js'), 'x');
    fs.writeFileSync(path.join(p.worktree, 'dist', 'y.js'), 'y');
    expect(p.gates().code).toBe(0);
    expect(p.evidence().at(-1)).toMatchObject({ untracked: 2, ignored_present: 1 });
  });

  it('lists the configured links that are links here, with the lockfile hash beside them; a link is not counted as a file', () => {
    const lock = '{"lockfileVersion":3}\n';
    const p = project(
      { gates: { quick: ['node -e "process.exit(0)"'] }, sharedLinks: ['node_modules', 'not_there'] },
      { '.gitignore': 'node_modules/\n', 'package-lock.json': lock },
    );
    // A shared folder as prepare-track makes it: the main checkout has it and its own, older lockfile.
    fs.mkdirSync(path.join(p.repo, 'node_modules'));
    fs.writeFileSync(path.join(p.repo, 'package-lock.json'), '{"lockfileVersion":2}\n');
    fs.symlinkSync(path.join(p.repo, 'node_modules'), path.join(p.worktree, 'node_modules'), 'junction');
    const r = p.gates();
    expect(r.code).toBe(0);
    const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
    const e = p.evidence().at(-1) as Record<string, unknown>;
    expect(e.shared_links).toEqual([
      { path: 'node_modules', lock_hash: sha256(lock), target_lock_hash: sha256('{"lockfileVersion":2}\n') },
    ]);
    expect(e).toMatchObject({ untracked: 0, ignored_present: 0 });
    expect(r.out).toContain("shared node_modules (its lockfile differs from the commit's)");

    // The same lockfile on both sides: no target hash, no remark.
    fs.writeFileSync(path.join(p.repo, 'package-lock.json'), lock);
    const r2 = p.gates();
    expect((p.evidence().at(-1) as Record<string, unknown>).shared_links).toEqual([{ path: 'node_modules', lock_hash: sha256(lock) }]);
    expect(r2.out).toContain("ran locally in the track's worktree, shared node_modules.");
  });

  it('a run in the main checkout says so; a real folder at a shared path is not a shared link', () => {
    const p = project({ gates: { quick: ['node -e "process.exit(0)"'] } });
    fs.mkdirSync(path.join(p.repo, 'node_modules'));
    fs.writeFileSync(path.join(p.repo, 'node_modules', 'x'), 'x');
    fs.mkdirSync(path.join(p.repo, '.git', 'info'), { recursive: true });
    fs.writeFileSync(path.join(p.repo, '.git', 'info', 'exclude'), 'node_modules\n');
    const r = spawnSync(process.execPath, [GATES, '--quick'], { cwd: p.repo, encoding: 'utf8', env: p.env });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('ran locally in the main checkout, 1 ignored.');
    expect(p.evidence().at(-1)).toMatchObject({ main_tree: true, runner: 'local-worktree', shared_links: [], ignored_present: 1 });
  });
});
