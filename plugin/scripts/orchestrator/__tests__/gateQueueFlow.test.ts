// =============================================================
// gateQueueFlow.test.ts: gates.mjs with the gate queue and the memory sampling, with real processes, and `ravenseat machine`.
//
// Locks: of two concurrent heavy runs the second one waits, says for whom, and has `wait_sec` in its gate row; the time
// budget does not run during the wait; a killed holder does not stop the next run (the pid check); a red run gives its slot
// back; a light run does not queue; a gate command gets the queue turned off; a red run with low free memory says it is
// probably load and stays red.
//
// vitest.config.mjs turns the queue off for the whole test run (QUEUE_GATE_QUEUE=off), so that no other test file queues.
// These tests turn it on and give each run its own temp root in QUEUE_GATE_QUEUE_DIR: they share nothing with the machine's
// real queue or with other test files. Never the main repo or the real queue.
// =============================================================
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

const HERE = path.resolve(__dirname, '..');
const GATES = path.join(HERE, 'gates.mjs');
const QUEUE = path.join(HERE, 'queue.mjs');
const ID = ['-c', 'user.name=queue-test', '-c', 'user.email=queue-test@example.invalid'];
const sleepGate = (ms: number) => `node -e "setTimeout(()=>{},${ms})"`;

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

type Options = { quick?: string[]; full?: string[]; lastSec?: number | null; extra?: Record<string, unknown> };

/** A temp git repo with its config, time log and own queue root. */
function project({ quick = [], full = [], lastSec = 500, extra = {} }: Options) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-queue-flow-'));
  temporary.push(folder);
  const repo = path.join(folder, 'repo');
  const data = path.join(folder, 'data');
  fs.mkdirSync(repo);
  fs.mkdirSync(data);
  const g = (args: string[]) => execFileSync('git', ['-C', repo, ...ID, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  g(['init', '-q', '-b', 'develop']);
  fs.writeFileSync(path.join(repo, 'README.md'), 'start\n');
  g(['add', '--', 'README.md']);
  g(['commit', '-q', '-m', 'start']);
  const configFile = path.join(folder, 'queue.config.json');
  fs.writeFileSync(configFile, JSON.stringify({ gates: { quick, full }, loadGuard: { minFreeMemoryPct: 10 }, ...extra }));
  const timeLog = path.join(folder, 'time.jsonl');
  if (lastSec != null)
    fs.writeFileSync(
      timeLog,
      `${JSON.stringify({ event: 'gate', kind: 'quick', duration_s: lastSec })}\n${JSON.stringify({ event: 'gate', kind: 'full', duration_s: lastSec })}\n`,
    );
  const queueRoot = path.join(folder, 'gate-queue');
  const env: Record<string, string | undefined> = {
    ...process.env,
    QUEUE_FOLDER: data,
    QUEUE_CONFIG: configFile,
    QUEUE_ROOT: repo,
    QUEUE_GIT: repo,
    QUEUE_TIME_LOG: timeLog,
    QUEUE_GATE_QUEUE: 'on',
    QUEUE_GATE_QUEUE_DIR: queueRoot,
    QUEUE_LOAD: 'free=50',
  };
  const lastRow = () => {
    const rows = fs.readFileSync(timeLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    return rows[rows.length - 1];
  };
  return { folder, repo, data, env, queueRoot, timeLog, lastRow };
}

type Run = { status: number | null; out: string };
/** Starts gates.mjs. `done` resolves with its exit code and output; `child` is there for killing it. */
function start(p: ReturnType<typeof project>, ...args: string[]) {
  const child = spawn(process.execPath, [GATES, ...args, '--cwd', p.repo], { env: p.env as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const done = new Promise<Run>((resolve) => child.on('close', (status) => resolve({ status, out })));
  return { child, done, output: () => out };
}

async function until(what: string, ok: () => boolean, ms = 30_000) {
  const t0 = Date.now();
  while (!ok()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const holderFile = (p: ReturnType<typeof project>) => path.join(p.queueRoot, 'slot-0', 'holder.json');

describe('two concurrent heavy runs', () => {
  it('the second one waits, says for whom, and has wait_sec in its row', async () => {
    const p = project({ quick: [sleepGate(4000)] });
    const first = start(p, '--quick', '--track', 'FIRST');
    await until('the first run holds the slot', () => fs.existsSync(holderFile(p)));
    const firstPid = JSON.parse(fs.readFileSync(holderFile(p), 'utf8')).pid;
    expect(firstPid).toBe(first.child.pid);

    const second = start(p, '--quick', '--track', 'SECOND');
    await until('the second run says it waits', () => second.output().includes('GATE QUEUE'));
    expect(second.output()).toContain(`pid ${firstPid}`);
    expect(second.output()).toContain('(FIRST)');

    const [a, b] = await Promise.all([first.done, second.done]);
    expect(a.status).toBe(0);
    expect(b.status).toBe(0);
    expect(a.out).not.toContain('GATE QUEUE');
    const row = p.lastRow();
    expect(row.track).toBe('SECOND');
    expect(row.wait_sec).toBeGreaterThan(0);
    // The wait is not part of the duration: the slot is what kept it out, not the gate.
    expect(row.duration_s).toBeLessThan(row.wait_sec + 30);
    expect(fs.existsSync(path.join(p.queueRoot, 'slot-0'))).toBe(false);
  }, 90_000);
});

describe('the time budget', () => {
  it('does not run during the wait', async () => {
    const p = project({ quick: [sleepGate(100)] });
    // Held by this test's own process: a living pid that is not the run's.
    fs.mkdirSync(path.join(p.queueRoot, 'slot-0'), { recursive: true });
    fs.writeFileSync(holderFile(p), JSON.stringify({ pid: process.pid, kind: 'full', project: 'other', started: new Date().toISOString() }));
    const run = start(p, '--quick', '--timeout-sec', '5');
    await until('the run says it waits', () => run.output().includes('GATE QUEUE'));
    await new Promise((r) => setTimeout(r, 6000));
    fs.rmSync(path.join(p.queueRoot, 'slot-0'), { recursive: true });
    const r = await run.done;
    expect(r.out).not.toContain('time budget of');
    expect(r.status).toBe(0);
    const row = p.lastRow();
    // It waited longer than the whole budget and was still not stopped.
    expect(row.wait_sec).toBeGreaterThan(5);
    expect(row.timed_out ?? false).toBe(false);
  }, 60_000);

  it('still stops a gate over the budget, with the words ravenseat merge looks for', async () => {
    const p = project({ quick: [sleepGate(60_000)], lastSec: null });
    const log = path.join(p.folder, 'gates.log');
    const r = await start(p, '--quick', '--timeout-sec', '2', '--log', log).done;
    expect(r.status).toBe(1);
    expect(fs.readFileSync(log, 'utf8')).toMatch(/time budget/);
  }, 60_000);
});

describe('the slot', () => {
  it('is taken over from a holder that was killed (the pid check is the safety net)', async () => {
    const p = project({ quick: [sleepGate(6000)] });
    const first = start(p, '--quick');
    await until('the first run holds the slot', () => fs.existsSync(holderFile(p)));
    first.child.kill('SIGKILL');
    await first.done;
    expect(fs.existsSync(holderFile(p))).toBe(true); // it had no chance to clean up
    // Lighter gate for the next run, so the test does not wait for the first run's sleeping child.
    fs.writeFileSync(p.env.QUEUE_CONFIG as string, JSON.stringify({ gates: { quick: [sleepGate(10)] } }));
    const r = await start(p, '--quick').done;
    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(p.queueRoot, 'slot-0'))).toBe(false);
  }, 60_000);

  it('is given back after a red run', async () => {
    const p = project({ quick: ['node -e "process.exit(3)"'] });
    const r = await start(p, '--quick').done;
    expect(r.status).toBe(1);
    expect(fs.existsSync(path.join(p.queueRoot, 'slot-0'))).toBe(false);
    expect(p.lastRow().wait_sec).toBe(0);
  }, 60_000);

  it('is not needed by a run without history', async () => {
    const p = project({ quick: ['node -e "0"'], lastSec: null });
    fs.mkdirSync(path.join(p.queueRoot, 'slot-0'), { recursive: true });
    fs.writeFileSync(holderFile(p), JSON.stringify({ pid: process.pid, started: new Date().toISOString() }));
    const r = await start(p, '--quick').done;
    expect(r.status).toBe(0);
    expect(r.out).not.toContain('GATE QUEUE');
    expect(p.lastRow()).not.toHaveProperty('wait_sec');
  }, 60_000);

  it('is not needed by a heavy run when turned off in the config', async () => {
    const p = project({ quick: ['node -e "0"'], extra: { gateQueue: { enabled: false } } });
    p.env.QUEUE_GATE_QUEUE = undefined;
    fs.mkdirSync(path.join(p.queueRoot, 'slot-0'), { recursive: true });
    fs.writeFileSync(holderFile(p), JSON.stringify({ pid: process.pid, started: new Date().toISOString() }));
    const r = await start(p, '--quick').done;
    expect(r.status).toBe(0);
    expect(r.out).not.toContain('GATE QUEUE');
  }, 60_000);

  it('is never asked for by a gate command: it runs with the queue turned off', async () => {
    const p = project({ quick: [`node -e "require('fs').writeFileSync('seen.txt', String(process.env.QUEUE_GATE_QUEUE))"`] });
    const r = await start(p, '--quick').done;
    expect(r.status).toBe(0);
    expect(fs.readFileSync(path.join(p.repo, 'seen.txt'), 'utf8')).toBe('off');
  }, 60_000);
});

describe('free memory during the run', () => {
  const RED = 'node -e "process.exit(1)"';

  it('a red run below the limit says it is probably load, with the figure, and stays red', async () => {
    const p = project({ quick: [RED], lastSec: null });
    p.env.QUEUE_LOAD = 'free=5';
    const log = path.join(p.folder, 'gates.log');
    const r = await start(p, '--quick', '--log', log).done;
    expect(r.status).toBe(1);
    expect(r.out).toContain('free memory fell to 5 %');
    expect(r.out).toContain('probably load');
    expect(r.out).toMatch(/RED: 1 of 1/);
    expect(fs.readFileSync(log, 'utf8')).toContain('probably load');
    const row = p.lastRow();
    expect(row.min_free_memory_pct).toBe(5);
    expect(row.exit).toBe(1);
  }, 60_000);

  it('says nothing on a red run above the limit, or on a green run below it', async () => {
    const red = project({ quick: [RED], lastSec: null });
    const r1 = await start(red, '--quick').done;
    expect(r1.status).toBe(1);
    expect(r1.out).not.toContain('probably load');
    expect(red.lastRow().min_free_memory_pct).toBe(50);

    const green = project({ quick: ['node -e "0"'], lastSec: null });
    green.env.QUEUE_LOAD = 'free=5';
    const r2 = await start(green, '--quick').done;
    expect(r2.status).toBe(0);
    expect(r2.out).not.toContain('probably load');
    expect(green.lastRow().min_free_memory_pct).toBe(5);
  }, 60_000);
});

describe('ravenseat machine', () => {
  const machine = (p: ReturnType<typeof project>, ...args: string[]) =>
    spawnSync(process.execPath, [QUEUE, 'machine', ...args], { env: { ...p.env, QUEUE_MACHINE: 'mem=32,cores=8' } as NodeJS.ProcessEnv, encoding: 'utf8' });

  it('shows the cores, the memory, the free memory and the suggestion, and changes nothing', () => {
    const p = project({ full: ['node -e "0"'] });
    const r = machine(p);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('8');
    expect(r.stdout).toContain('32 GB');
    expect(r.stdout).toContain('50 %');
    expect(r.stdout).toContain('Suggested maxConcurrent: 4');
    expect(r.stdout).toContain('Estimate');
    expect(fs.existsSync(path.join(p.data, 'queue.json'))).toBe(false);
  }, 60_000);

  it('--measure refuses with an explanation while a track runs', () => {
    const p = project({ full: [`node -e "require('fs').writeFileSync('ran.txt','x')"`] });
    fs.writeFileSync(path.join(p.data, 'queue.json'), JSON.stringify({ tasks: [{ id: 'A', title: 'A', domain: 'd', class: 'K', status: 'running' }] }));
    const r = machine(p, '--measure');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Not measured');
    expect(r.stderr).toContain('A');
    expect(fs.existsSync(path.join(p.repo, 'ran.txt'))).toBe(false);
  }, 60_000);

  it('--measure runs the full check once and shows the time, the lowest free memory and a suggestion', () => {
    const p = project({ full: [`node -e "require('fs').appendFileSync('ran.txt','x')"`], lastSec: null });
    const r = machine(p, '--measure');
    expect(r.status).toBe(0);
    expect(fs.readFileSync(path.join(p.repo, 'ran.txt'), 'utf8')).toBe('x');
    expect(r.stdout).toMatch(/Time: [\d.]+ s/);
    expect(r.stdout).toContain('50 % before, 50 % at the lowest');
    expect(r.stdout).toContain('for this project on this machine: 4');
    expect(r.stdout).toContain('Estimate');
  }, 60_000);

  it('--measure keeps the exit code of a red check', () => {
    const p = project({ full: ['node -e "process.exit(1)"'], lastSec: null });
    const r = machine(p, '--measure');
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('RED');
  }, 60_000);

  it('--measure says so when there is no full check', () => {
    const p = project({ full: [] });
    const r = machine(p, '--measure');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('gates.full is empty');
  }, 60_000);
});
