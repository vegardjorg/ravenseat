// =============================================================
// gateBaseEnvFlow.test.ts: gates.mjs gives its --quick/--full commands QUEUE_GATE_BASE, the commit to diff against.
//
// Why: a gate that runs only the tests a change can reach (`node scripts/test-changed.mjs --gate`) must diff against what
// the track forked from. In a track's worktree that is the fork point against the base branch; after `ravenseat merge`
// HEAD is the base branch, so it is the merge step's --track-base. With no own commits (the main checkout) there is no
// such commit and the variable is not set, also when the caller's environment had one: the gate must then run everything.
// =============================================================
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

const GATES = path.join(path.resolve(__dirname, '..'), 'gates.mjs');
const ID = ['-c', 'user.name=queue-test', '-c', 'user.email=queue-test@example.invalid'];

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

/** Writes the QUEUE_GATE_BASE the gate command saw (or "unset") into the file named in argv[2]. */
const SHOW = "require('node:fs').writeFileSync(process.argv[2], process.env.QUEUE_GATE_BASE ?? 'unset');";

function project() {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-base-env-'));
  temporary.push(folder);
  const repo = path.join(folder, 'repo');
  const data = path.join(folder, 'data');
  for (const d of [repo, data]) fs.mkdirSync(d);
  const seen = path.join(folder, 'seen.txt');
  const g = (...args: string[]) => execFileSync('git', ['-C', repo, ...ID, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  g('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'show.cjs'), SHOW);
  g('add', '--', 'show.cjs');
  g('commit', '-q', '-m', 'start');
  const configFile = path.join(folder, 'queue.config.json');
  fs.writeFileSync(configFile, JSON.stringify({ baseBranch: 'main', gates: { quick: [`node show.cjs ${JSON.stringify(seen)}`] } }));
  const env: Record<string, string | undefined> = {
    ...process.env,
    QUEUE_FOLDER: data,
    QUEUE_CONFIG: configFile,
    QUEUE_ROOT: repo,
    QUEUE_GIT: repo,
    QUEUE_TIME_LOG: path.join(folder, 'time.jsonl'),
    QUEUE_GATE_QUEUE: 'off',
    QUEUE_LOAD: 'free=50',
    // A stale value from the caller must never reach the commands.
    QUEUE_GATE_BASE: 'stale-from-the-caller',
  };
  const run = (...extra: string[]) => {
    fs.rmSync(seen, { force: true });
    const r = spawnSync(process.execPath, [GATES, '--quick', '--cwd', repo, ...extra], { env: env as NodeJS.ProcessEnv, encoding: 'utf8' });
    return { code: r.status, all: `${r.stdout ?? ''}${r.stderr ?? ''}`, base: fs.existsSync(seen) ? fs.readFileSync(seen, 'utf8') : null };
  };
  return { g, run };
}

describe('QUEUE_GATE_BASE for the gate commands', () => {
  it('a branch with its own commit gets the fork point; the base branch itself (no own commits) gets none', () => {
    const p = project();
    const fork = p.g('rev-parse', 'HEAD');
    let r = p.run();
    expect(r.code, r.all).toBe(0);
    expect(r.base).toBe('unset');

    p.g('switch', '-q', '-c', 'queue/A-1');
    fs.writeFileSync(path.join(p.g('rev-parse', '--show-toplevel'), 'a.txt'), 'a\n');
    p.g('add', '--', 'a.txt');
    p.g('commit', '-q', '-m', 'A');
    r = p.run();
    expect(r.code, r.all).toBe(0);
    expect(r.base).toBe(fork);
  });

  it('--track-base (the merge step after the merge) wins over the fork point', () => {
    const p = project();
    const fork = p.g('rev-parse', 'HEAD');
    const r = p.run('--track-base', fork, '--track-tip', fork);
    expect(r.code, r.all).toBe(0);
    expect(r.base).toBe(fork);
  });
});
