// =============================================================
// logBackend.test.ts: the log families of the storage layer (lib/store/logBackend.js, LAGRING step 5), in temporary
// folders and on the memory backend. Never the repo's data folder.
//
// Locks: append writes whole lines and repairs a torn tail; last(n) gives the last n rows from the end without the
// line being written; the sidecar index folds in only the new bytes and gives the same answer as a full scan, also when
// a writer appended without updating it, after a monthly rotation, with a broken sidecar and with a log rewritten
// shorter; the F-id index and the agent start index agree with the scans they replace (findingLog highestId, the
// backward scan in hook-time.mjs), and findingLog.append still numbers rows F-1, F-2 ... across a rotation.
// =============================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const LB = require('../store/logBackend.js');
const { createMemory } = require('../store/memoryBackend.js');

const temporary: string[] = [];
afterAll(() => {
  for (const d of temporary) fs.rmSync(d, { recursive: true, force: true });
});
const tmpFolder = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'log-backend-'));
  temporary.push(d);
  return d;
};

/** An index that counts rows and remembers the last `n`, to check incremental == full. */
const COUNT = {
  name: 'count',
  init: () => ({ rows: 0, lastN: null }),
  reduce: (s: any, r: any) => ({ rows: s.rows + 1, lastN: r.n ?? s.lastN }),
};

describe('append and last', () => {
  it('append writes one line per row and repairs a torn tail; last(n) reads from the end', () => {
    const file = path.join(tmpFolder(), 'log.jsonl');
    for (let n = 1; n <= 3; n++) LB.append(file, { n });
    fs.appendFileSync(file, '{"n": 4, "half'); // a writer died in the middle of its line
    LB.append(file, { n: 5 });
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    expect(lines.filter(Boolean).length).toBe(5);
    expect(JSON.parse(lines[4])).toEqual({ n: 5 }); // never glued to the half line
    expect(LB.last(file, 2).map((r: any) => r.n)).toEqual([3, 5]); // the half line is skipped
    expect(LB.last(file, 10).map((r: any) => r.n)).toEqual([1, 2, 3, 5]);
    expect(LB.last(path.join(path.dirname(file), 'none.jsonl'), 3)).toEqual([]);
  });

  it('last(n) across chunk borders on a long log, and never the line being written', () => {
    const mem = createMemory();
    const io = mem.io();
    const file = path.resolve('/mem-log/big.jsonl');
    mem.fs.mkdirSync(path.dirname(file), { recursive: true });
    const pad = 'x'.repeat(900);
    for (let n = 1; n <= 400; n++) mem.fs.appendFileSync(file, `${JSON.stringify({ n, pad })}\n`);
    mem.fs.appendFileSync(file, '{"n": 401'); // in progress
    expect(LB.last(file, 3, { fs: io.fs }).map((r: any) => r.n)).toEqual([398, 399, 400]);
    expect(LB.last(file, 150, { fs: io.fs }).length).toBe(150);
    expect(LB.last(file, 150, { fs: io.fs })[0].n).toBe(251);
  });
});

describe('the sidecar index', () => {
  it('folds in only the new bytes, and agrees with a full scan after appends it did not see', () => {
    const file = path.join(tmpFolder(), 'times.jsonl');
    for (let n = 1; n <= 5; n++) LB.append(file, { n });
    expect(LB.indexOf(file, COUNT)).toEqual({ rows: 5, lastN: 5 });
    const side = JSON.parse(fs.readFileSync(LB.sidecarOf(file, 'count'), 'utf8'));
    expect(side.size).toBe(fs.statSync(file).size);
    // Another writer appends without touching the sidecar (as the hooks do), and one row is half written.
    fs.appendFileSync(file, '{"n":6}\n{"n":7}\n{"n":8');
    expect(LB.indexOf(file, COUNT)).toEqual({ rows: 7, lastN: 7 });
    fs.appendFileSync(file, '}\n');
    expect(LB.indexOf(file, COUNT)).toEqual({ rows: 8, lastN: 8 });
  });

  it('rebuilds after a rotation, a broken sidecar and a log rewritten shorter', () => {
    const file = path.join(tmpFolder(), 'times.jsonl');
    for (let n = 1; n <= 4; n++) LB.append(file, { n, time: `2026-10-0${n}T00:00:00Z` });
    expect(LB.indexOf(file, COUNT).rows).toBe(4);
    // Rotated: a new file starts (other first bytes), soon longer than the old sidecar's size.
    fs.renameSync(file, path.join(path.dirname(file), 'times-2026-10.jsonl'));
    for (let n = 10; n <= 16; n++) LB.append(file, { n, time: '2026-11-01T00:00:00Z' });
    expect(LB.indexOf(file, COUNT)).toEqual({ rows: 7, lastN: 16 });
    fs.writeFileSync(LB.sidecarOf(file, 'count'), '{"version": 1, "si');
    expect(LB.indexOf(file, COUNT)).toEqual({ rows: 7, lastN: 16 });
    fs.writeFileSync(file, '{"n":99}\n');
    expect(LB.indexOf(file, COUNT)).toEqual({ rows: 1, lastN: 99 });
  });

  it('the F-id index equals the scan over the archives; the starts index equals the backward scan', () => {
    const dir = tmpFolder();
    const file = path.join(dir, 'findings.jsonl');
    fs.writeFileSync(path.join(dir, 'findings-2026-10.jsonl'), `${JSON.stringify({ id: 'F-7', caught_by: 'review' })}\n`);
    expect(LB.indexOf(file, LB.FINDINGS_LAST_ID).lastId).toBe(7); // no current file: the archives alone
    LB.append(file, { id: 'F-8', caught_by: 'gate' });
    LB.append(file, { update: 'fixed_by', item: 'F-8', fixed_by: 'abc1234' });
    expect(LB.indexOf(file, LB.FINDINGS_LAST_ID).lastId).toBe(8);

    const log = path.join(dir, 'times.jsonl');
    const now = Date.now();
    const at = (msAgo: number) => new Date(now - msAgo).toISOString();
    LB.append(log, { time: at(3000), event: 'start', agent_id: 'a1', wave: 'w1', track: 'T-1' });
    LB.append(log, { time: at(2000), event: 'start', agent_id: 'a2', wave: 'w2', track: 'T-2' });
    LB.append(log, { time: at(1000), event: 'done', agent_id: 'a1', wave: 'w1' });
    LB.append(log, { time: at(500), event: 'start', agent_id: 'a1', wave: 'w3', track: 'T-1' }); // a restart: the newest wins
    expect(LB.byId(log, LB.AGENT_STARTS, 'a1').wave).toBe('w3');
    expect(LB.byId(log, LB.AGENT_STARTS, 'a2').wave).toBe('w2');
    expect(LB.byId(log, LB.AGENT_STARTS, 'nobody')).toBeNull();
  });

  it('the starts index forgets agents older than the keep window, by the log\'s own clock', () => {
    const file = path.join(tmpFolder(), 'times.jsonl');
    const t0 = Date.UTC(2026, 10, 1);
    LB.append(file, { time: new Date(t0).toISOString(), event: 'start', agent_id: 'old', wave: 'w' });
    LB.append(file, { time: new Date(t0 + LB.START_KEEP_MS + 60_000).toISOString(), event: 'start', agent_id: 'new', wave: 'w' });
    expect(LB.byId(file, LB.AGENT_STARTS, 'old')).toBeNull();
    expect(LB.byId(file, LB.AGENT_STARTS, 'new')?.wave).toBe('w');
  });
});

describe('findingLog on the index', () => {
  it('append numbers F-1, F-2 ... and continues after a rotation and a lost sidecar', () => {
    const root = tmpFolder();
    const data = path.join(root, 'data');
    fs.mkdirSync(data);
    const prev = { QUEUE_FOLDER: process.env.QUEUE_FOLDER, QUEUE_CONFIG: process.env.QUEUE_CONFIG };
    process.env.QUEUE_FOLDER = data;
    process.env.QUEUE_CONFIG = path.join(root, 'none.json');
    try {
      const FL = require('../findingLog.js');
      const row = (title: string) => ({ caught_by: 'gate', severity: 'M', class: 'other', excerpt: title, signature: 'sig-1' });
      const ids = [FL.append(null, row('one'), { rules: false }).id, FL.append(null, row('two'), { rules: false }).id];
      expect(ids).toEqual(['F-1', 'F-2']);
      const file = FL.fileOf(null);
      // append went through the index: the sidecar was written when F-2 was numbered, so it covers F-1's row only.
      const side = JSON.parse(fs.readFileSync(LB.sidecarOf(file, 'lastid'), 'utf8'));
      expect(side.state.lastId).toBe(1);
      expect(side.size).toBeLessThan(fs.statSync(file).size);
      fs.renameSync(file, path.join(data, 'findings-2026-10.jsonl'));
      fs.rmSync(LB.sidecarOf(file, 'lastid'), { force: true });
      expect(FL.append(null, row('three'), { rules: false }).id).toBe('F-3');
      expect(FL.append(null, row('four'), { rules: false }).id).toBe('F-4');
    } finally {
      for (const [k, v] of Object.entries(prev)) if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
});

describe('hook-time.mjs on the starts index', () => {
  it('a done row gets the wave the agent started in, through the index, and again after the sidecar is lost', () => {
    const { spawnSync } = require('node:child_process');
    const data = tmpFolder();
    const log = path.join(data, 'times.jsonl');
    const env = { ...process.env, QUEUE_FOLDER: data, QUEUE_CONFIG: path.join(data, 'none.json'), QUEUE_TIME_LOG: log };
    delete env.QUEUE_SESSION;
    const hook = (event: string, agent: string) =>
      spawnSync(process.execPath, [path.join(__dirname, '..', '..', 'hook-time.mjs')], {
        input: JSON.stringify({ hook_event_name: event, agent_id: agent, agent_type: 'ravenseat:track' }),
        encoding: 'utf8',
        env,
        cwd: data,
      });
    const rows = () => fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    fs.writeFileSync(path.join(data, 'wave-active'), 'W1\n');
    hook('SubagentStart', 'agent-a');
    fs.writeFileSync(path.join(data, 'wave-active'), 'W2\n');
    hook('SubagentStart', 'agent-b');
    hook('SubagentStop', 'agent-a');
    expect(rows().at(-1)).toMatchObject({ event: 'done', agent_id: 'agent-a', wave: 'W1' });
    const side = LB.sidecarOf(log, 'starts');
    expect(JSON.parse(fs.readFileSync(side, 'utf8')).state.starts['agent-a'].wave).toBe('W1');
    fs.rmSync(side);
    fs.writeFileSync(path.join(data, 'wave-active'), 'W3\n');
    hook('SubagentStop', 'agent-b');
    expect(rows().at(-1)).toMatchObject({ event: 'done', agent_id: 'agent-b', wave: 'W2' });
    expect(fs.existsSync(side)).toBe(true);
  });
});
