// =============================================================
// agentPushBlock.test.ts: the git pre-push hook that stops a push from a track's worktree (lib/agentPushBlock.js, owner
// decision B1), against real git repos, real pushes to a local bare remote and real child processes (prepare-track.mjs,
// queue.mjs).
//
// Locks: (1) a push from a track worktree stops in git itself, with no text guard involved; (2) the main checkout and a
// worktree made by hand push as before; (3) an existing shell pre-push keeps running and keeps its bytes after a remove;
// (4) install is idempotent and a non-shell pre-push is left alone; (5) a relative core.hooksPath (husky's .husky/_) gets
// the block in the worktree's own folder, never in a tracked folder; (6) fill/start/resume install it, off removes it,
// `settings set` applies it at once; (7) doctor says when it is off, missing or cannot be installed.
// The global and system git config are switched off (a temporary GIT_CONFIG_GLOBAL), never the developer's own.
// =============================================================
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ORCH = path.resolve(__dirname, '..');
const QUEUE = path.join(ORCH, 'queue.mjs');
const PREPARE = path.join(ORCH, 'prepare-track.mjs');
const ID = ['-c', 'user.name=queue-test', '-c', 'user.email=queue-test@example.invalid'];
const APB = () => require('../lib/agentPushBlock.js');

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

/** A repo on develop with a bare remote, a queue folder and a config; nothing installed yet. */
function project(config: Record<string, unknown> = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-push-block-'));
  temporary.push(folder);
  const repo = path.join(folder, 'repo');
  const remote = path.join(folder, 'remote.git');
  const scratch = path.join(folder, 'scratch');
  fs.mkdirSync(repo);
  fs.mkdirSync(scratch);
  const globalConfig = path.join(folder, 'global-gitconfig');
  fs.writeFileSync(globalConfig, '');
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    QUEUE_FOLDER: folder,
    QUEUE_CONFIG: path.join(folder, 'queue.config.json'),
    QUEUE_ROOT: folder,
    QUEUE_GIT: repo,
    QUEUE_TIME_LOG: path.join(folder, 'times.jsonl'),
    QUEUE_TRANSCRIPTS: path.join(folder, 'transcripts'),
  } as NodeJS.ProcessEnv;
  delete env.QUEUE_SCRATCHPAD;
  delete env.QUEUE_SESSION;
  delete env.QUEUE_MERGE_RUNNING;
  const g = (args: string[], cwd = repo) =>
    execFileSync('git', ['-C', cwd, ...ID, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  execFileSync('git', ['init', '-q', '--bare', remote], { env });
  g(['init', '-q', '-b', 'develop']);
  fs.writeFileSync(path.join(repo, 'README.md'), 'start\n');
  g(['add', '--', 'README.md']);
  g(['commit', '-q', '-m', 'start']);
  g(['remote', 'add', 'origin', remote]);
  const setConfig = (c: Record<string, unknown>) =>
    fs.writeFileSync(env.QUEUE_CONFIG as string, JSON.stringify({ baseBranch: 'develop', sharedLinks: [], ...c }));
  setConfig(config);
  fs.writeFileSync(
    path.join(folder, 'queue.json'),
    JSON.stringify({ created: '2026-01-01T00:00:00.000Z', limits: {}, next_migr: 3600, resolved: [], tasks: [] }),
  );
  const hooksDir = (cwd = repo) => path.resolve(cwd, g(['rev-parse', '--git-path', 'hooks'], cwd));
  const prePush = (cwd = repo) => path.join(hooksDir(cwd), 'pre-push');
  /** A worktree on a new branch with one commit. */
  const worktree = (name: string) => {
    const wt = path.join(folder, name);
    g(['worktree', 'add', '-q', '-b', `queue/${name}`, wt, 'develop']);
    fs.writeFileSync(path.join(wt, `${name}.txt`), `${name}\n`);
    g(['add', '--', `${name}.txt`], wt);
    g(['commit', '-q', '-m', `feat: ${name}`], wt);
    return wt;
  };
  /** A push of HEAD to a branch on the bare remote. */
  const push = (cwd: string, to: string) => {
    const r = spawnSync('git', ['-C', cwd, 'push', '-q', 'origin', `HEAD:refs/heads/${to}`], { encoding: 'utf8', env });
    return { code: r.status, all: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  const remoteHas = (branch: string) =>
    spawnSync('git', ['-C', remote, 'rev-parse', '--verify', '-q', `refs/heads/${branch}`], { env }).status === 0;
  const prepare = (wt: string, track: string) => {
    const r = spawnSync(process.execPath, [PREPARE, track, '--branch', `queue/${track}`, '--scratchpad', scratch, '--continue'], {
      cwd: wt,
      encoding: 'utf8',
      env,
    });
    return { code: r.status, all: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  const run = (args: string[], cwd = folder) => {
    const r = spawnSync(process.execPath, [QUEUE, ...args], { encoding: 'utf8', env, cwd });
    return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '', all: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  /** The user's own pre-push: writes `ran-<n>.txt` in the folder each time git runs it. */
  const userHook = (file = prePush()) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const ran = path.join(folder, 'user-hook-ran.txt').split(path.sep).join('/');
    const text = `#!/bin/sh\n# the user's own pre-push\necho ran >> "${ran}"\nexit 0\n`;
    fs.writeFileSync(file, text);
    fs.chmodSync(file, 0o755);
    return { text, ran: path.join(folder, 'user-hook-ran.txt') };
  };
  return { folder, repo, remote, scratch, env, g, setConfig, hooksDir, prePush, worktree, push, remoteHas, prepare, run, userHook };
}

describe('the pure rules', () => {
  it('isShellScript knows sh, bash and env forms, and nothing else', () => {
    const { isShellScript } = APB();
    for (const t of ['#!/bin/sh\n', '#!/usr/bin/env sh\n', '#!/bin/bash -e\n', '#!/usr/bin/env -S bash\n', '#! /bin/dash\n'])
      expect(isShellScript(t), t).toBe(true);
    for (const t of ['#!/usr/bin/env node\n', '#!/usr/bin/python3\n', 'echo no shebang\n', '', '#!/bin/shell-tool\n'])
      expect(isShellScript(t), t).toBe(false);
  });

  it('insertBlock puts the block after the first line and keeps the rest; stripBlock gives the bytes back', () => {
    const { insertBlock, stripBlock, BLOCK } = APB();
    const original = '#!/usr/bin/env sh\n. "$(dirname "$0")/h"\n';
    const next = insertBlock(original);
    expect(next.startsWith(`#!/usr/bin/env sh\n${BLOCK}`)).toBe(true);
    expect(next.endsWith('. "$(dirname "$0")/h"\n')).toBe(true);
    expect(insertBlock(next)).toBe(next);
    expect(stripBlock(next)).toBe(original);
    expect(insertBlock('#!/usr/bin/env node\n')).toBeNull();
  });

  it('hookHash: a file that is only the block counts as no file; an inserted block hashes as the original', () => {
    const { hookHash, insertBlock, BLOCK } = APB();
    expect(hookHash(`#!/bin/sh\n${BLOCK}`, 'x')).toBeNull();
    const original = '#!/bin/sh\necho hi\n';
    const sha = crypto.createHash('sha256').update(original).digest('hex');
    expect(hookHash(original, 'x')).toBe(`x${sha}`);
    expect(hookHash(insertBlock(original), 'x')).toBe(`x${sha}`);
    expect(hookHash(Buffer.from(insertBlock(original)), '-')).toBe(`-${sha}`);
    // Anything added next to the block is still seen.
    expect(hookHash(`#!/bin/sh\n${BLOCK}echo added\n`, 'x')).not.toBeNull();
    // A block that differs by one character is not the known block: hashed as it is.
    expect(hookHash(`#!/bin/sh\n${BLOCK.replace('exit 1', 'exit 0')}`, 'x')).not.toBeNull();
  });
});

describe('install and remove in a real hooks folder', () => {
  it('no pre-push: writes an executable one; a second install changes nothing; remove deletes it', () => {
    const p = project();
    const { install, remove, status } = APB();
    expect(status(p.hooksDir())).toBe('missing');
    expect(install(p.hooksDir())).toBe('installed');
    const text = fs.readFileSync(p.prePush(), 'utf8');
    expect(text.startsWith('#!/bin/sh\n')).toBe(true);
    if (process.platform !== 'win32') expect(fs.statSync(p.prePush()).mode & 0o111).not.toBe(0);
    expect(install(p.hooksDir())).toBe('present');
    expect(fs.readFileSync(p.prePush(), 'utf8')).toBe(text);
    expect(status(p.hooksDir())).toBe('installed');
    expect(remove(p.hooksDir())).toBe('removed');
    expect(fs.existsSync(p.prePush())).toBe(false);
    expect(remove(p.hooksDir())).toBe('absent');
  });

  it("the user's shell pre-push is kept: it still runs, and remove gives its exact bytes back", () => {
    const p = project();
    const { install, remove } = APB();
    const hook = p.userHook();
    expect(install(p.hooksDir())).toBe('installed');
    expect(p.push(p.repo, 'develop').code).toBe(0);
    expect(fs.existsSync(hook.ran)).toBe(true);
    expect(remove(p.hooksDir())).toBe('removed');
    expect(fs.readFileSync(p.prePush(), 'utf8')).toBe(hook.text);
  });

  it('a pre-push in another language is left alone and reported', () => {
    const p = project();
    const { install, status } = APB();
    fs.mkdirSync(p.hooksDir(), { recursive: true });
    fs.writeFileSync(p.prePush(), '#!/usr/bin/env node\nprocess.exit(0);\n');
    expect(install(p.hooksDir())).toBe('unsupported');
    expect(fs.readFileSync(p.prePush(), 'utf8')).toBe('#!/usr/bin/env node\nprocess.exit(0);\n');
    expect(status(p.hooksDir())).toBe('unsupported');
  });
});

describe('a push from git itself', () => {
  it('a track worktree (prepare-track) cannot push; the main checkout and a hand-made worktree can', () => {
    const p = project();
    const hook = p.userHook();
    expect(APB().ensure(p.repo, {}).result).toBe('installed');
    const track = p.worktree('A');
    const ready = p.prepare(track, 'A');
    expect(ready.code, ready.all).toBe(0);
    expect(fs.existsSync(path.join(p.g(['rev-parse', '--absolute-git-dir'], track), APB().MARKER))).toBe(true);

    const stopped = p.push(track, 'queue/A');
    expect(stopped.code).not.toBe(0);
    expect(stopped.all).toContain('push stopped');
    expect(stopped.all).toContain('agentPushBlock');
    expect(p.remoteHas('queue/A')).toBe(false);

    expect(p.push(p.repo, 'develop').code).toBe(0);
    expect(p.remoteHas('develop')).toBe(true);
    expect(fs.existsSync(hook.ran)).toBe(true);

    const mine = p.worktree('mine');
    expect(p.push(mine, 'queue/mine').code).toBe(0);
    expect(p.remoteHas('queue/mine')).toBe(true);
  });

  it('prepare-track never marks the main checkout', () => {
    const p = project();
    const r = APB().prepareWorktree(p.repo, p.repo, {});
    expect(r.marker).toBe(false);
    expect(fs.existsSync(path.join(p.repo, '.git', APB().MARKER))).toBe(false);
  });

  it("a relative core.hooksPath (husky's .husky/_): the block goes into the worktree's own folder, ignored by git", () => {
    const p = project();
    p.g(['config', 'core.hooksPath', '.husky/_']);
    fs.mkdirSync(path.join(p.repo, '.husky', '_'), { recursive: true });
    fs.writeFileSync(path.join(p.repo, '.husky', '_', '.gitignore'), '*\n');
    p.userHook(path.join(p.repo, '.husky', '_', 'pre-push'));
    expect(APB().ensure(p.repo, {}).result).toBe('installed');
    const track = p.worktree('B');
    expect(p.prepare(track, 'B').code).toBe(0);
    expect(APB().status(path.join(track, '.husky', '_'))).toBe('installed');
    expect(p.g(['status', '--porcelain'], track)).toBe('');
    const stopped = p.push(track, 'queue/B');
    expect(stopped.code).not.toBe(0);
    expect(stopped.all).toContain('push stopped');
    expect(p.push(p.repo, 'develop').code).toBe(0);
  });

  it('a relative core.hooksPath to a tracked folder in the worktree is left alone (the block would be part of the change)', () => {
    const p = project();
    fs.mkdirSync(path.join(p.repo, 'githooks'));
    fs.writeFileSync(path.join(p.repo, 'githooks', 'pre-push'), '#!/bin/sh\nexit 0\n');
    p.g(['add', '--', 'githooks/pre-push']);
    p.g(['commit', '-q', '-m', 'hooks']);
    p.g(['config', 'core.hooksPath', 'githooks']);
    const track = p.worktree('C');
    const r = APB().prepareWorktree(track, p.repo, {});
    expect(r.result).toBe('tracked');
    expect(fs.readFileSync(path.join(track, 'githooks', 'pre-push'), 'utf8')).toBe('#!/bin/sh\nexit 0\n');
  });
});

describe('where it is installed', () => {
  it('fill installs it in the main checkout; off removes it at the next fill', () => {
    const p = project();
    p.run(['fill', '--scratchpad', p.scratch, '--max', '0']);
    expect(APB().status(p.hooksDir())).toBe('installed');
    p.setConfig({ agentPushBlock: { enabled: false } });
    p.run(['fill', '--scratchpad', p.scratch, '--max', '0']);
    expect(fs.existsSync(p.prePush())).toBe(false);
  });

  it('settings set agentPushBlock.enabled: off needs the confirm flow and removes it at once; on installs it at once', () => {
    const p = project();
    APB().ensure(p.repo, {});
    const refused = p.run(['settings', 'set', 'agentPushBlock.enabled', 'off']);
    expect(refused.code).toBe(1);
    expect(refused.all).toContain('agents can push from git itself when the text guard does not see the command');
    expect(APB().status(p.hooksDir())).toBe('installed');
    const off = p.run(['settings', 'set', 'agentPushBlock.enabled', 'off', '--i-understand', '--by', 'owner']);
    expect(off.code, off.all).toBe(0);
    expect(fs.existsSync(p.prePush())).toBe(false);
    const on = p.run(['settings', 'set', 'agentPushBlock.enabled', 'on']);
    expect(on.code, on.all).toBe(0);
    expect(APB().status(p.hooksDir())).toBe('installed');
  });
});

describe('doctor', () => {
  it('the row: missing is INFO, installed is OK, a non-shell pre-push is WARN, off and still there is INFO', () => {
    const p = project();
    const { doctorRow, install } = APB();
    expect(doctorRow(p.repo, {}).status).toBe('INFO');
    install(p.hooksDir());
    expect(doctorRow(p.repo, {}).status).toBe('OK');
    expect(doctorRow(p.repo, { agentPushBlock: { enabled: false } }).status).toBe('INFO');
    fs.writeFileSync(p.prePush(), '#!/usr/bin/env node\n');
    const warn = doctorRow(p.repo, {});
    expect(warn.status).toBe('WARN');
    expect(warn.message).toContain('agents can push from git itself when the text guard does not see the command');
  });

  it('ravenseat doctor shows the hook row and the WARN when off, and writes nothing', () => {
    const p = project();
    const before = p.run(['doctor']);
    expect(before.all).toMatch(/agent push block not installed yet/);
    expect(fs.existsSync(p.prePush())).toBe(false);
    p.setConfig({ agentPushBlock: { enabled: false } });
    const off = p.run(['doctor']);
    expect(off.all).toContain('AGENT PUSH BLOCK OFF');
    expect(off.all).toContain('agents can push from git itself when the text guard does not see the command');
  });
});
