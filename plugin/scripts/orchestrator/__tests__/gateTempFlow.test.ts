// =============================================================
// gateTempFlow.test.ts: a gate run's own temp folder, with the real gates.mjs and real gate commands.
//
// Locks: the gate commands of one run share a folder of their own under the real temp folder; it is gone afterwards, also
// after a red run; two runs get different folders; a link in it leaves the folder in place and the target untouched;
// gateTemp.enabled false turns it off; the gate queue stays in the real temp folder, so runs still share it.
//
// Every run gets a base temp folder of its own through TEMP/TMP/TMPDIR, so nothing here reads the machine's temp folder.
// =============================================================
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

const HERE = path.resolve(__dirname, '..');
const GATES = path.join(HERE, 'gates.mjs');
const QUEUE = path.join(HERE, 'queue.mjs');
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

/** Writes where the temp folder is and leaves a file in it, as a leaking test would. */
const LEAK = `
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const tmp = os.tmpdir();
fs.writeFileSync(path.join(fs.mkdtempSync(path.join(tmp, 'leak-')), 'f.txt'), 'x');
fs.appendFileSync(process.argv[2], tmp + '\\n');
if (process.argv[3] === 'link') fs.symlinkSync(process.argv[4], path.join(tmp, 'link'), 'junction');
process.exit(process.argv[3] === 'red' ? 1 : 0);
`;

function project(gateArgs: string[][], extra: Record<string, unknown> = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-temp-flow-'));
  temporary.push(folder);
  const repo = path.join(folder, 'repo');
  const data = path.join(folder, 'data');
  const tempBase = path.join(folder, 'temp');
  const seen = path.join(folder, 'seen.txt');
  for (const d of [repo, data, tempBase]) fs.mkdirSync(d);
  const g = (args: string[]) => execFileSync('git', ['-C', repo, ...ID, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  g(['init', '-q', '-b', 'develop']);
  fs.writeFileSync(path.join(repo, 'leak.cjs'), LEAK);
  g(['add', '--', 'leak.cjs']);
  g(['commit', '-q', '-m', 'start']);
  const quick = gateArgs.map((a) => ['node', 'leak.cjs', JSON.stringify(seen), ...a.map((x) => JSON.stringify(x))].join(' '));
  const configFile = path.join(folder, 'queue.config.json');
  fs.writeFileSync(configFile, JSON.stringify({ gates: { quick }, loadGuard: { minFreeMemoryPct: 10 }, ...extra }));
  const timeLog = path.join(folder, 'time.jsonl');
  const env: Record<string, string | undefined> = {
    ...process.env,
    QUEUE_FOLDER: data,
    QUEUE_CONFIG: configFile,
    QUEUE_ROOT: repo,
    QUEUE_GIT: repo,
    QUEUE_TIME_LOG: timeLog,
    QUEUE_GATE_QUEUE: 'off',
    QUEUE_LOAD: 'free=50',
    TEMP: tempBase,
    TMP: tempBase,
    TMPDIR: tempBase,
  };
  delete env.QUEUE_GATE_QUEUE_DIR;
  const run = () => spawnSync(process.execPath, [GATES, '--quick', '--cwd', repo], { env: env as NodeJS.ProcessEnv, encoding: 'utf8' });
  const folders = () => (fs.existsSync(seen) ? fs.readFileSync(seen, 'utf8').trim().split('\n') : []);
  return { folder, repo, data, env, tempBase, timeLog, run, folders, configFile };
}

const same = (a: string, b: string) => fs.realpathSync(a) === fs.realpathSync(b);

describe('a gate run\'s own temp folder', () => {
  it('the commands of one run share a folder under the real temp folder, and it is gone afterwards', () => {
    const p = project([[], []]);
    const r = p.run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const [first, second] = p.folders();
    expect(first).toBe(second);
    expect(path.basename(first)).toMatch(/^ravenseat-gate-run-/);
    expect(same(path.dirname(first), p.tempBase)).toBe(true);
    // The leak went with the folder, and the temp folder has nothing new at all.
    expect(fs.existsSync(first)).toBe(false);
    expect(fs.readdirSync(p.tempBase)).toEqual([]);
  });

  it('a red run cleans up too, and stays red', () => {
    const p = project([['red']]);
    const r = p.run();
    expect(r.status).toBe(1);
    expect(fs.readdirSync(p.tempBase)).toEqual([]);
  });

  it('two runs get different folders', () => {
    const p = project([[]]);
    p.run();
    p.run();
    const [a, b] = p.folders();
    expect(a).not.toBe(b);
  });

  it('a link in the folder: the folder stays, the run says so, the target is untouched and the result does not change', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-temp-outside-'));
    temporary.push(outside);
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
    const p = project([['link', outside]]);
    const r = p.run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8')).toBe('keep');
    const [dir] = p.folders();
    expect(fs.existsSync(dir)).toBe(true);
    expect(r.stdout).toContain(dir);
    expect(r.stdout).toMatch(/link/);
  });

  it('gateTemp.enabled false: the commands get the normal temp folder, and nothing is removed', () => {
    const p = project([[]], { gateTemp: { enabled: false } });
    const r = p.run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const [dir] = p.folders();
    expect(same(dir, p.tempBase)).toBe(true);
    expect(fs.readdirSync(p.tempBase).some((n) => n.startsWith('leak-'))).toBe(true);
  });

  it('the gate queue stays in the real temp folder, so runs in other folders still share it', () => {
    const p = project([[]]);
    p.env.QUEUE_GATE_QUEUE = 'on';
    fs.writeFileSync(p.timeLog, `${JSON.stringify({ event: 'gate', kind: 'quick', duration_s: 500 })}\n`);
    const r = p.run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(fs.readdirSync(p.tempBase).filter((n) => n.startsWith('ravenseat-gate-queue-'))).toHaveLength(1);
    expect(fs.readdirSync(p.tempBase).filter((n) => n.startsWith('ravenseat-gate-run-'))).toEqual([]);
  });

  it('--precheck runs in a folder of its own and cleans up too', () => {
    const p = project([]);
    const seen = path.join(p.folder, 'seen.txt');
    fs.writeFileSync(p.configFile, JSON.stringify({ gates: { precheck: [`node leak.cjs ${JSON.stringify(seen)}`] }, loadGuard: { minFreeMemoryPct: 10 } }));
    fs.writeFileSync(path.join(p.repo, 'new.txt'), 'x');
    execFileSync('git', ['-C', p.repo, ...ID, 'add', '--', 'new.txt']);
    const r = spawnSync(process.execPath, [GATES, '--precheck', '--base', 'HEAD', '--cwd', p.repo], { env: p.env as NodeJS.ProcessEnv, encoding: 'utf8' });
    expect(p.folders(), r.stdout + r.stderr).toHaveLength(1);
    expect(path.basename(p.folders()[0])).toMatch(/^ravenseat-gate-run-/);
    expect(fs.readdirSync(p.tempBase)).toEqual([]);
  });
});

describe('ravenseat doctor', () => {
  it('has one temp line with the count per prefix, and the setting is a known key', () => {
    const p = project([[]], { gateTemp: { enabled: true } });
    for (const n of ['pip-a', 'pip-b', 'merge-track-1']) fs.mkdirSync(path.join(p.tempBase, n));
    const r = spawnSync(process.execPath, [QUEUE, 'doctor', '--json'], { env: p.env as NodeJS.ProcessEnv, encoding: 'utf8' });
    const checks = JSON.parse(r.stdout).checks as { name: string; status: string; message: string }[];
    const line = checks.find((c) => c.name === 'temp');
    expect(line?.status).toBe('OK');
    expect(line?.message).toContain('3 entries');
    expect(line?.message).toContain('pip 2');
    expect(checks.filter((c) => /gateTemp/.test(c.message))).toEqual([]);
  });
});
