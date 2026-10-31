// =============================================================
// loadSampler.test.ts: the load sampler (bench/lib/loadSampler.js): override, real OS sample with an injected process
// list, CPU delta, running tracks from a queue file, and the background loop with its stop file and duration.
// =============================================================
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LS = require('../lib/loadSampler.js') as Record<string, any>;
const tmp: string[] = [];
afterAll(() => tmp.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const dir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-load-'));
  tmp.push(d);
  return d;
};

describe('sampleOnce', () => {
  it('BENCH_LOAD replaces the measurement', () => {
    const s = LS.sampleOnce({ env: 'free=12.5,cpu=80,procs=300,node=14,disk=40,tracks=6', now: () => new Date(0) });
    expect(s).toMatchObject({
      time: '1970-01-01T00:00:00.000Z',
      free_memory_pct: 12.5,
      cpu_pct: 80,
      processes: 300,
      node_processes: 14,
      disk_free_pct: 40,
      running_tracks: 6,
      source: 'override',
    });
  });

  it('measures the real machine; process counts come from the injected list; CPU needs two readings', () => {
    const state = {};
    const opt = { env: '', state, listProcesses: () => ['node.exe', 'Code.exe', 'node', 'bash'], diskDir: os.tmpdir() };
    const a = LS.sampleOnce(opt);
    expect(a.source).toBe('os');
    expect(a.free_memory_pct).toBeGreaterThan(0);
    expect(a.free_memory_pct).toBeLessThanOrEqual(100);
    expect(a.processes).toBe(4);
    expect(a.node_processes).toBe(2);
    expect(a.cpu_pct).toBeNull();
    if (process.platform === 'win32') expect(a.load_1m).toBeNull();
    const b = LS.sampleOnce(opt);
    expect(b.cpu_pct === null || (b.cpu_pct >= 0 && b.cpu_pct <= 100)).toBe(true);
  });

  it('a failing process listing gives null, not a guess', () => {
    const s = LS.sampleOnce({ env: '', listProcesses: () => null });
    expect(s.processes).toBeNull();
    expect(s.node_processes).toBeNull();
  });

  it('cpuPct computes the busy share from two readings', () => {
    expect(LS.cpuPct({ idle: 100, total: 200 }, { idle: 150, total: 400 })).toBe(75);
    expect(LS.cpuPct(null, { idle: 1, total: 2 })).toBeNull();
  });

  it('counts running tracks in an English or a Norwegian queue file', () => {
    const d = dir();
    const en = path.join(d, 'queue.json');
    const no = path.join(d, 'ko.json');
    fs.writeFileSync(en, JSON.stringify({ tasks: [{ status: 'running' }, { status: 'done' }, { status: 'running' }] }));
    fs.writeFileSync(no, JSON.stringify({ oppgaver: [{ status: 'kjorer' }, { status: 'ferdig' }] }));
    expect(LS.runningTracks(en)).toBe(2);
    expect(LS.runningTracks(no)).toBe(1);
    expect(LS.runningTracks(path.join(d, 'missing.json'))).toBeNull();
  });
});

describe('startSampler', () => {
  it('appends JSONL rows and stops when the stop file appears', async () => {
    const d = dir();
    const out = path.join(d, 'load.jsonl');
    const s = LS.startSampler({ out, intervalMs: 20, env: 'free=50' });
    await new Promise((r) => setTimeout(r, 120));
    fs.writeFileSync(`${out}.stop`, 'x');
    const n = await s.done;
    expect(n).toBeGreaterThanOrEqual(2);
    const rows = LS.readLoad(fs.readFileSync(out, 'utf8'));
    expect(rows).toHaveLength(n);
    expect(rows.every((r: any) => r.free_memory_pct === 50)).toBe(true);
  });

  it('stops by itself after the duration, and stop() is safe to call twice', async () => {
    const d = dir();
    const out = path.join(d, 'load.jsonl');
    const s = LS.startSampler({ out, intervalMs: 10, durationMs: 50, env: 'free=1' });
    const n = await s.done;
    expect(n).toBeGreaterThanOrEqual(1);
    s.stop();
    s.stop();
  });

  it('readLoad skips broken lines and sorts by time', () => {
    const rows = LS.readLoad('{"time":"2030-01-02T00:00:00Z"}\n{broken\n{"time":"2030-01-01T00:00:00Z"}\n');
    expect(rows.map((r: any) => r.time)).toEqual(['2030-01-01T00:00:00Z', '2030-01-02T00:00:00Z']);
  });
});
