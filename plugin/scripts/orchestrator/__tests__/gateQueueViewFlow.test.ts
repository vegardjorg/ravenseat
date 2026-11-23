// =============================================================
// gateQueueViewFlow.test.ts: `ravenseat doctor` and `ravenseat pulse-check` show who holds a machine queue slot and who
// waits (lib/gateQueueView.js, roadmap 0s V12), through the real CLI.
//
// Locks: doctor has one INFO row `gatequeue` naming the holder and the waiter, and none with an empty queue; the pulse
// check adds one `GATE QUEUE:` line with --include-owner, a plain SILENT stays exactly one line, and the exit code is
// unchanged (display only). Nothing in the queue folder is removed. Own temp project and queue root.
// =============================================================
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

const QUEUE = path.resolve(__dirname, '..', 'queue.mjs');

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

function project({ held = true } = {}) {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gate-queue-view-flow-')));
  temporary.push(folder);
  const data = path.join(folder, 'data');
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, 'queue.json'), JSON.stringify({ limits: {}, resolved: [], tasks: [] }));
  const configFile = path.join(folder, 'queue.config.json');
  fs.writeFileSync(configFile, JSON.stringify({ baseBranch: 'main' }));
  const queueRoot = path.join(folder, 'gate-queue');
  if (held) {
    fs.mkdirSync(path.join(queueRoot, 'slot-0'), { recursive: true });
    fs.writeFileSync(
      path.join(queueRoot, 'slot-0', 'holder.json'),
      JSON.stringify({ pid: process.pid, project: 'demo', kind: 'heavy', command: 'npm test', track: 'A-1', started: new Date().toISOString(), beatSec: 30, staleSec: 300 }),
    );
    fs.mkdirSync(path.join(queueRoot, 'waiting'), { recursive: true });
    const arrived = new Date(Date.now() - 120_000).toISOString();
    fs.writeFileSync(path.join(queueRoot, 'waiting', `${process.pid}-${Date.parse(arrived)}.json`), JSON.stringify({ pid: process.pid, project: 'demo', kind: 'full', class: 'base', arrived }));
  }
  const env: Record<string, string | undefined> = {
    ...process.env,
    QUEUE_FOLDER: data,
    QUEUE_CONFIG: configFile,
    QUEUE_ROOT: folder,
    QUEUE_TIME_LOG: path.join(folder, 'time.jsonl'),
    QUEUE_GATE_QUEUE: 'on',
    QUEUE_GATE_QUEUE_DIR: queueRoot,
    QUEUE_LOAD: 'free=100',
  };
  delete env.QUEUE_GIT;
  const run = (...args: string[]) => {
    const r = spawnSync(process.execPath, [QUEUE, ...args], { encoding: 'utf8', env, cwd: folder, timeout: 90_000 });
    return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
  };
  return { queueRoot, run };
}

describe('doctor', () => {
  it('one INFO row with the holder and the waiter, and nothing removed', () => {
    const p = project();
    const r = p.run('doctor', '--json');
    const rows = JSON.parse(r.out).checks.filter((c: { name: string }) => c.name === 'gatequeue');
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('INFO');
    expect(rows[0].message).toMatch(/heavy `npm test` of demo \(A-1\)/);
    expect(rows[0].message).toMatch(/waiting: 1\. base full gates of demo/);
    expect(fs.existsSync(path.join(p.queueRoot, 'slot-0', 'holder.json'))).toBe(true);
    expect(fs.readdirSync(path.join(p.queueRoot, 'waiting'))).toHaveLength(1);
  }, 120_000);

  it('no row with an empty queue', () => {
    const r = project({ held: false }).run('doctor', '--json');
    expect(JSON.parse(r.out).checks.some((c: { name: string }) => c.name === 'gatequeue')).toBe(false);
  }, 120_000);
});

describe('pulse-check', () => {
  it('adds the GATE QUEUE line with --include-owner, and a plain SILENT stays one line', () => {
    const p = project();
    const owner = p.run('pulse-check', '--include-owner');
    expect(owner.code).toBe(0);
    expect(owner.out).toMatch(/^SILENT\n/);
    expect(owner.out).toMatch(/GATE QUEUE: slot 1: heavy `npm test` of demo \(A-1\).*1 waiting/);
    const plain = p.run('pulse-check');
    expect(plain.code).toBe(0);
    expect(plain.out.trim()).toBe('SILENT');
  }, 120_000);
});
