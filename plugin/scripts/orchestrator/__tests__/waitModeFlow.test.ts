// =============================================================
// waitModeFlow.test.ts: the wait mode for long calls (lib/waitMode.js) through the real CLI in a temporary project.
//
// Why: Claude Code's Bash tool stops a call after 120 s by default (600 s at most), so a long gate run was moved to the
// background, and every completion notification cost one more turn with the full context (and a wait over 300 s misses
// the prompt cache). `ravenseat gates`, `receive` and `merge` now block for at most wait.blockSec and otherwise print one
// RUNNING line with the exact next command and Bash timeout; that command waits for the SAME run.
//
// Locks: (1) a run that finishes within the budget prints what gates.mjs prints and keeps its exit code; (2) a slow run
// prints RUNNING (exit 75) and keeps running after the call ended, and the printed next command shows the rest of the
// output once and ends with the run's exit code; (3) the same gates on the same commit are never started twice while one
// runs: a second call waits for the first run; (4) a run over the hard cap is ended and reported red as timed out;
// (5) wait.blockSec 0 (or QUEUE_WAIT=off) keeps the old blocking behaviour; (6) an unknown run id is a usage error.
// Small budgets come from QUEUE_WAIT_BLOCK_SEC and QUEUE_WAIT_HARD_SEC so the tests stay fast.
// =============================================================
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const RAVENSEAT = path.resolve(__dirname, '..', 'ravenseat.mjs');
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

/** A gate command that appends one line to `file` (relative to the repo), sleeps `ms` and exits with `code`. */
const fakeGate = (file: string, ms: number, code = 0) =>
  `node -e "require('fs').appendFileSync('${file}','start ');setTimeout(()=>{require('fs').appendFileSync('${file}','end ');process.exit(${code})},${ms})"`;

function project(gates: string[], extra: object = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-wait-'));
  temporary.push(folder);
  const repo = path.join(folder, 'repo');
  fs.mkdirSync(repo);
  const globalConfig = path.join(folder, 'global-gitconfig');
  fs.writeFileSync(globalConfig, '');
  const configFile = path.join(folder, 'queue.config.json');
  fs.writeFileSync(configFile, JSON.stringify({ baseBranch: 'main', mode: 'lite', gates: { quick: gates, full: gates }, ...extra }));
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    QUEUE_FOLDER: folder,
    QUEUE_CONFIG: configFile,
    QUEUE_ROOT: repo,
    QUEUE_GIT: repo,
    QUEUE_TIME_LOG: path.join(folder, 'times.jsonl'),
    QUEUE_TRANSCRIPTS: path.join(folder, 'transcripts'),
  } as NodeJS.ProcessEnv;
  delete env.QUEUE_WAIT;
  delete env.QUEUE_WAIT_BLOCK_SEC;
  delete env.QUEUE_WAIT_HARD_SEC;
  execFileSync('git', ['-C', repo, ...ID, 'init', '-q', '-b', 'main'], { env, stdio: 'ignore' });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), '*.log\nran*.txt\n');
  execFileSync('git', ['-C', repo, 'add', '-A'], { env, stdio: 'ignore' });
  execFileSync('git', ['-C', repo, ...ID, 'commit', '-q', '-m', 'init'], { env, stdio: 'ignore' });
  fs.writeFileSync(path.join(folder, 'queue.json'), JSON.stringify({ limits: {}, resolved: [], projects: {}, tasks: [] }));
  const run = (args: string[], more: Record<string, string> = {}) => {
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [RAVENSEAT, ...args], { encoding: 'utf8', env: { ...env, ...more }, cwd: repo });
    return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '', sec: (Date.now() - t0) / 1000 };
  };
  const ran = (file: string) => {
    try {
      return fs.readFileSync(path.join(repo, file), 'utf8');
    } catch {
      return '';
    }
  };
  return { run, ran, folder, repo };
}

/** The RUNNING line's parts: the run id, the next command's arguments (after the CLI name) and the Bash timeout. */
function runningLine(out: string) {
  const line = out.trim().split(/\r?\n/).pop() ?? '';
  const m = /^RUNNING: .+, started .+\. Next: (?:ravenseat|node \S*ravenseat\.mjs) (.+) \(Bash timeout (\d+)\)$/.exec(line);
  expect(m, `no RUNNING line in:\n${out}`).not.toBeNull();
  const next = m![1].split(' ');
  return { next, timeoutMs: Number(m![2]), id: next[next.indexOf('--wait') + 1] };
}

describe('wait mode for long calls', () => {
  it('a run within the budget prints what the gate prints and keeps its exit code', () => {
    const green = project([fakeGate('ran.txt', 50)]);
    const g = green.run(['gates', '--quick']);
    expect(g.code).toBe(0);
    expect(g.out).toMatch(/ALL GREEN: 1 gate\(s\) --quick/);
    expect(g.out).not.toMatch(/RUNNING/);
    const red = project([fakeGate('ran.txt', 50, 3)]);
    const r = red.run(['gates', '--quick']);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/RED: 1 of 1 gate\(s\) --quick failed/);
  }, 60_000);

  it('a slow run prints RUNNING; the next command waits for the same run and ends with its result', () => {
    const p = project([fakeGate('ran.txt', 5000)]);
    const first = p.run(['gates', '--quick'], { QUEUE_WAIT_BLOCK_SEC: '1' });
    expect(first.code).toBe(75);
    expect(first.sec).toBeLessThan(4.5);
    const line = runningLine(first.out);
    expect(line.next.slice(0, 2)).toEqual(['gates', '--wait']);
    expect(line.timeoutMs).toBeGreaterThan(1000);
    expect(line.timeoutMs).toBeLessThanOrEqual(600_000);
    // The run goes on after the call ended (the detached runner holds it): the gate is not done yet, and ends below.
    expect(p.ran('ran.txt')).not.toContain('end');
    const second = p.run(line.next, { QUEUE_WAIT_BLOCK_SEC: '30' });
    expect(second.code).toBe(0);
    expect(second.out).toMatch(/ALL GREEN: 1 gate\(s\) --quick/);
    expect(second.out).not.toMatch(/RUNNING/);
    // One gate line in all: what the first call showed is not shown again.
    const both = `${first.out}${second.out}`;
    expect(both.match(/ALL GREEN/g)).toHaveLength(1);
    expect(p.ran('ran.txt')).toBe('start end ');
  }, 60_000);

  it('the same gates on the same commit are not started twice while one runs', () => {
    const p = project([fakeGate('ran.txt', 4000)]);
    const first = p.run(['gates', '--quick'], { QUEUE_WAIT_BLOCK_SEC: '1' });
    const { id } = runningLine(first.out);
    const again = p.run(['gates', '--quick'], { QUEUE_WAIT_BLOCK_SEC: '30' });
    expect(again.out).toContain(id);
    expect(again.out).toMatch(/already running/i);
    expect(again.code).toBe(0);
    expect(p.ran('ran.txt')).toBe('start end ');
  }, 60_000);

  it('a run over the hard cap is ended and reported red as timed out', () => {
    const p = project([fakeGate('ran.txt', 30_000)]);
    const first = p.run(['gates', '--quick'], { QUEUE_WAIT_BLOCK_SEC: '1', QUEUE_WAIT_HARD_SEC: '3' });
    const { next } = runningLine(first.out);
    const second = p.run(next, { QUEUE_WAIT_BLOCK_SEC: '20' });
    expect(second.code).toBe(1);
    expect(second.sec).toBeLessThan(15);
    expect(`${second.out}${second.err}`).toMatch(/RED: .*stopped after the time budget of 3 s/);
    expect(p.ran('ran.txt')).toBe('start ');
  }, 60_000);

  it('wait.blockSec 0 and QUEUE_WAIT=off keep the old blocking call', () => {
    const off = project([fakeGate('ran.txt', 2500)], { wait: { blockSec: 0 } });
    const a = off.run(['gates', '--quick']);
    expect(a.code).toBe(0);
    expect(a.out).toMatch(/ALL GREEN/);
    const env = project([fakeGate('ran.txt', 2500)]);
    const b = env.run(['gates', '--quick'], { QUEUE_WAIT: 'off', QUEUE_WAIT_BLOCK_SEC: '1' });
    expect(b.code).toBe(0);
    expect(b.out).toMatch(/ALL GREEN/);
    expect(b.out).not.toMatch(/RUNNING/);
  }, 60_000);

  it('an unknown run id is a usage error', () => {
    const p = project([fakeGate('ran.txt', 50)]);
    const r = p.run(['gates', '--wait', 'gates-nosuchrun']);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/no run gates-nosuchrun/);
  }, 30_000);
});
