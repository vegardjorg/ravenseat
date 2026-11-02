// =============================================================
// compactCount.test.ts: incremental compaction counting (review 2026-11-02, M11).
//
// The rule is enforced in lib/trackGuard.js (countCompactionsFrom, cachedCompactions) and used by hook-context.mjs
// (UserPromptSubmit) and hook-after-compact.mjs. The tests prove it there:
//   - the pure counter with a counting fs wrapper: after the first call only the new tail is read;
//   - chunk boundaries, a half-written last line and a shrunk file give the same count as reading the whole file;
//   - hook-context.mjs run as a process on a large synthetic transcript: after the first message the cache file holds the
//     position, and a second message sees only what was appended (the old part is rewritten in place to prove it is not
//     read again).
// Everything runs in a temporary folder (QUEUE_FOLDER), never the real queue.
// =============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs, { mkdtempSync, rmSync, writeFileSync, readFileSync, appendFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

type Count = { pos: number; n: number; read: number };
/* eslint-disable @typescript-eslint/no-require-imports */
const V = require('../trackGuard') as {
  countCompactionsFrom: (
    p: string,
    prev?: { pos?: number; n?: number },
    o?: { fsImpl?: typeof fs; chunk?: number },
  ) => Count;
  cachedCompactions: (
    cacheFile: string,
    p: string,
    o?: { fsImpl?: typeof fs; chunk?: number; now?: number },
  ) => { n: number; read: number };
};
const KV = require('../contextGuard') as { countCompactions: (t: string) => number };
/* eslint-enable @typescript-eslint/no-require-imports */

const BOUNDARY = JSON.stringify({ type: 'system', subtype: 'compact_boundary' });
const filler = (i: number) =>
  JSON.stringify({ type: 'user', message: { content: `row ${i} ${'x'.repeat(200)} æøå` } });

/** A counting fs wrapper: the bytes readSync returns, summed. */
function countingFs() {
  const seen = { bytes: 0 };
  const f = {
    ...fs,
    readSync: (...args: Parameters<typeof fs.readSync>) => {
      const got = (fs.readSync as (...a: unknown[]) => number)(...args);
      seen.bytes += got;
      return got;
    },
  } as unknown as typeof fs;
  return { f, seen };
}

describe('trackGuard.countCompactionsFrom: only the new tail is read', () => {
  let folder: string;
  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'cq-compact-count-'));
  });
  afterEach(() => rmSync(folder, { recursive: true, force: true }));

  it('a large transcript is read once; the next call reads only the appended bytes', () => {
    const file = join(folder, 't.jsonl');
    const rows: string[] = [];
    for (let i = 0; i < 60_000; i++) rows.push(i % 20_000 === 0 ? BOUNDARY : filler(i));
    writeFileSync(file, rows.join('\n') + '\n');
    const size = fs.statSync(file).size;
    expect(size).toBeGreaterThan(10 * 1024 * 1024);

    const a = countingFs();
    const first = V.countCompactionsFrom(file, {}, { fsImpl: a.f });
    expect(first).toEqual({ pos: size, n: 3, read: size });
    expect(a.seen.bytes).toBe(size);

    const extra = `${filler(1)}\n${BOUNDARY}\n`;
    appendFileSync(file, extra);
    const b = countingFs();
    const second = V.countCompactionsFrom(file, first, { fsImpl: b.f });
    expect(second.n).toBe(4);
    expect(second.pos).toBe(size + Buffer.byteLength(extra));
    expect(b.seen.bytes).toBe(Buffer.byteLength(extra));

    // Nothing new: nothing is read.
    const c = countingFs();
    expect(V.countCompactionsFrom(file, second, { fsImpl: c.f })).toMatchObject({ n: 4, read: 0 });
    expect(c.seen.bytes).toBe(0);
  });

  it('small chunks, multibyte text and lines across chunk borders give the same count as the whole file', () => {
    const file = join(folder, 't.jsonl');
    const text = [filler(1), BOUNDARY, filler(2), BOUNDARY, BOUNDARY, filler(3)].join('\n') + '\n';
    writeFileSync(file, text);
    for (const chunk of [1, 7, 64, 1000, 1 << 20]) {
      expect(V.countCompactionsFrom(file, {}, { chunk }).n).toBe(KV.countCompactions(text));
    }
  });

  it('a half-written last line is counted when it is complete; a shrunk file starts over', () => {
    const file = join(folder, 't.jsonl');
    writeFileSync(file, `${BOUNDARY}\n${BOUNDARY.slice(0, 10)}`);
    const a = V.countCompactionsFrom(file);
    expect(a).toMatchObject({ n: 1, pos: BOUNDARY.length + 1 });
    appendFileSync(file, `${BOUNDARY.slice(10)}\n`);
    const b = V.countCompactionsFrom(file, a);
    expect(b.n).toBe(2);
    writeFileSync(file, `${BOUNDARY}\n`); // new, smaller file under the same name
    expect(V.countCompactionsFrom(file, b).n).toBe(1);
  });

  it('cachedCompactions remembers the position per transcript and survives a broken cache', () => {
    const cache = join(folder, 'compact-count.json');
    const t1 = join(folder, 'a.jsonl');
    const t2 = join(folder, 'b.jsonl');
    writeFileSync(t1, `${BOUNDARY}\n${filler(1)}\n`);
    writeFileSync(t2, `${BOUNDARY}\n${BOUNDARY}\n`);
    expect(V.cachedCompactions(cache, t1).n).toBe(1);
    expect(V.cachedCompactions(cache, t2).n).toBe(2);
    const stored = JSON.parse(readFileSync(cache, 'utf8'));
    expect(Object.keys(stored)).toHaveLength(2);
    expect(V.cachedCompactions(cache, t1)).toEqual({ n: 1, read: 0 });
    writeFileSync(cache, '{ broken');
    expect(V.cachedCompactions(cache, t1)).toMatchObject({ n: 1 });
  });
});

describe('hook-context.mjs: the orchestrator transcript is not read whole on every message', () => {
  const ORCHESTRATOR = join(__dirname, '..', '..');
  let folder: string;
  const env = () => ({
    ...process.env,
    CONTEXT_BLOCK_OTHERS: '',
    QUEUE_FOLDER: folder,
    QUEUE_GIT: folder,
    QUEUE_TIME_LOG: join(folder, 'times.jsonl'),
    CONTEXT_WARNING: '',
    CONTEXT_STOP: '',
    CONTEXT_WIND_DOWN: '',
    CONTEXT_STOP_ORCHESTRATOR: '',
    CONTEXT_COMPACT: '',
    COST_GUARD_BY: '1',
  });
  function run(file: string, args: string[], input?: string) {
    return execFileSync(process.execPath, [join(ORCHESTRATOR, file), ...args], {
      env: env(),
      encoding: 'utf8',
      input,
      stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
  }
  const call = () =>
    JSON.stringify({
      type: 'assistant',
      timestamp: new Date().toISOString(),
      message: {
        content: [
          { type: 'tool_use', name: 'Bash', input: { command: 'node scripts/orchestrator/queue.mjs orchestrator pulse' } },
        ],
      },
    });
  const usage = (n: number) =>
    JSON.stringify({
      type: 'assistant',
      timestamp: new Date().toISOString(),
      message: { content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, cache_read_input_tokens: n - 1 } },
    });

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'cq-compact-hook-'));
    writeFileSync(
      join(folder, 'queue.json'),
      JSON.stringify({
        tasks: [],
        limits: { maxConcurrent: 5, maxDPlus: 2, maxPerDomain: 7, maxDb: 5 },
        next_migr: 100,
      }),
    );
  });
  afterEach(() => rmSync(folder, { recursive: true, force: true }));

  it('the second message counts only the appended tail (the old part rewritten in place is not read again)', () => {
    run('queue.mjs', ['orchestrator', 'pulse', '--session', 'queue A']);
    const file = join(folder, 'orchestrator.jsonl');
    const rows = [BOUNDARY, BOUNDARY];
    for (let i = 0; i < 40_000; i++) rows.push(filler(i));
    rows.push(call(), usage(300_000));
    writeFileSync(file, rows.join('\n') + '\n');
    expect(fs.statSync(file).size).toBeGreaterThan(8 * 1024 * 1024);
    const hook = () =>
      JSON.parse(run('hook-context.mjs', [], JSON.stringify({ session_id: 's1', transcript_path: file, prompt: 'hello' })));

    // Two compactions in the transcript: the proposal is no. 3, and the cache holds the end position.
    expect(hook().systemMessage).toContain('compaction no. 3');
    const cacheFile = join(folder, 'compact-count.json');
    expect(existsSync(cacheFile)).toBe(true);
    const cached = Object.values(JSON.parse(readFileSync(cacheFile, 'utf8')))[0] as { pos: number; n: number };
    expect(cached).toMatchObject({ pos: fs.statSync(file).size, n: 2 });

    // Rewrite the two old boundary rows in place (same length, no longer boundaries). A full read would now count 0.
    const fd = fs.openSync(file, 'r+');
    const blank = Buffer.from(`{"type":"user"${' '.repeat(BOUNDARY.length - 15)}}`);
    expect(blank.length).toBe(BOUNDARY.length);
    fs.writeSync(fd, blank, 0, blank.length, 0);
    fs.writeSync(fd, blank, 0, blank.length, BOUNDARY.length + 1);
    fs.closeSync(fd);
    // One new compaction appended: incremental = 3 (proposal no. 4); a full read would say 1 (proposal no. 2).
    appendFileSync(file, `${BOUNDARY}\n${call()}\n${usage(300_000)}\n`);
    expect(hook().systemMessage).toContain('compaction no. 4');
  });
});
