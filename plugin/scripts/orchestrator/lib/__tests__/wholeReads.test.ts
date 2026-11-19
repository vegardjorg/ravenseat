// =============================================================
// wholeReads.test.ts: `ravenseat cost --reads` (lib/wholeReads.js on top of the one transcript reader,
// lib/timeCost.js analyzeTranscript with { detail: true }): the files tracks most often read WHOLE (a Read with no
// offset, limit or pages), across tracks, as candidates for a catalog excerpt or for splitting the file.
//   - a whole read against an excerpt read;
//   - the same file across several tracks (tracks counted once each, reads summed);
//   - sorting (tracks, then whole reads) and the limit;
//   - no data (one calm line);
//   - --json (one machine-readable answer);
//   - paths outside the repo (counted, never printed), and files no longer in the main tree.
// The fixtures are synthetic transcripts in Claude Code's JSONL shape, with neutral paths.
// =============================================================
import { describe, it, expect } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const T = require('../timeCost');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const WR = require('../wholeReads');

const T0 = Date.parse('2026-11-12T08:00:00Z');
const ts = (sec: number) => new Date(T0 + sec * 1000).toISOString();
const ROOT = '/work/app';
const USAGE = { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 100 };

/** One assistant turn with one tool call (one line, as Claude Code writes a single block). */
function call(id: string, sec: number, name: string, input: Record<string, unknown>, cwd = ROOT): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: ts(sec),
    cwd,
    message: { id: `m-${id}`, role: 'assistant', model: 'claude-opus-5-5', usage: USAGE, content: [{ type: 'tool_use', id, name, input }] },
  });
}
const prompt = (sec: number, t: string, cwd = ROOT) =>
  JSON.stringify({ type: 'user', timestamp: ts(sec), cwd, message: { role: 'user', content: t } });

/** A transcript's detail from a list of Read inputs (one turn each), in the working directory `cwd`. */
function detailOf(reads: Record<string, unknown>[], cwd = ROOT) {
  const lines = [prompt(0, 'Track work.', cwd)];
  reads.forEach((input, i) => lines.push(call(`u${i}`, 1 + i, 'Read', input, cwd)));
  return T.analyzeTranscript(lines.join('\n'), { detail: true }).detail;
}

/** The files that exist in the "main tree" of these tests, with their sizes. */
const FILES: Record<string, { lines: number; bytes: number }> = {
  'src/big.js': { lines: 1200, bytes: 48_000 },
  'src/mid.js': { lines: 300, bytes: 9_000 },
  'src/small.js': { lines: 40, bytes: 1_200 },
  'docs/guide.md': { lines: 500, bytes: 30_000 },
};
const exists = (rel: string) => Object.hasOwn(FILES, rel);
const sizeOf = (rel: string) => FILES[rel] ?? null;
const base = { roots: [ROOT], exists, sizeOf };

describe('readKind: a whole read against an excerpt', () => {
  it('a Read without offset, limit or pages is whole; with any of them it is an excerpt; other tools are no read', () => {
    expect(WR.readKind({ name: 'Read', input: { file_path: '/x/a.js' } })).toBe('whole');
    expect(WR.readKind({ name: 'Read', input: { file_path: '/x/a.js', offset: 10 } })).toBe('excerpt');
    expect(WR.readKind({ name: 'Read', input: { file_path: '/x/a.js', limit: 50 } })).toBe('excerpt');
    expect(WR.readKind({ name: 'Read', input: { file_path: '/x/a.pdf', pages: '1-3' } })).toBe('excerpt');
    // offset 0 is still an explicit excerpt request (the agent chose the window).
    expect(WR.readKind({ name: 'Read', input: { file_path: '/x/a.js', offset: 0, limit: 20 } })).toBe('excerpt');
    expect(WR.readKind({ name: 'Grep', input: { path: '/x' } })).toBe(null);
    // An image is read whole by nature and can be neither excerpted nor split: left out (an SVG is text and counts).
    expect(WR.readKind({ name: 'Read', input: { file_path: '/x/shot.PNG' } })).toBe(null);
    expect(WR.readKind({ name: 'Read', input: { file_path: '/x/photo.jpeg' } })).toBe(null);
    expect(WR.readKind({ name: 'Read', input: { file_path: '/x/icon.svg' } })).toBe('whole');
    expect(WR.readKind({ name: 'Read', input: {} })).toBe(null);
  });
});

describe('wholeReads: counting per file and track', () => {
  it('counts whole and excerpt reads apart, and lists only files read whole at least once', () => {
    const d = detailOf([
      { file_path: `${ROOT}/src/big.js` },
      { file_path: `${ROOT}/src/big.js` },
      { file_path: `${ROOT}/src/big.js`, offset: 100, limit: 50 },
      { file_path: `${ROOT}/src/mid.js`, limit: 40 },
    ]);
    const r = WR.wholeReads({ transcripts: [{ track: 'K-1', detail: d }], ...base });
    expect(r.whole_reads).toBe(2);
    expect(r.excerpt_reads).toBe(2);
    expect(r.files).toEqual([
      { path: 'src/big.js', tracks: 1, whole: 2, excerpt: 1, lines: 1200, kb: 47 },
    ]);
    expect(r.tracks).toBe(1);
  });

  it('counts the same file across several tracks once per track, and sums the reads', () => {
    const a = detailOf([{ file_path: `${ROOT}/src/mid.js` }, { file_path: `${ROOT}/src/mid.js` }]);
    const b = detailOf([{ file_path: `${ROOT}/src/mid.js` }]);
    // Two agents of the same track (a fix round) count as one track.
    const c = detailOf([{ file_path: `${ROOT}/src/mid.js` }]);
    const r = WR.wholeReads({
      transcripts: [
        { track: 'K-1', detail: a },
        { track: 'K-2', detail: b },
        { track: 'K-1', detail: c },
      ],
      ...base,
    });
    expect(r.files[0]).toMatchObject({ path: 'src/mid.js', tracks: 2, whole: 4 });
    expect(r.tracks).toBe(2);
  });

  it("resolves a path in the track's own worktree (its cwd) and a relative path to the same repo file", () => {
    // The worktree was removed after the merge, so it is not among the roots: the transcript's cwd stands in for it.
    const wt = '/trees/k-3';
    const d = detailOf([{ file_path: `${wt}/src/small.js` }, { file_path: 'src/small.js' }], wt);
    const r = WR.wholeReads({ transcripts: [{ track: 'K-3', detail: d }], ...base });
    expect(r.files).toEqual([{ path: 'src/small.js', tracks: 1, whole: 2, excerpt: 0, lines: 40, kb: 1.2 }]);
  });

  it('matches Windows paths case-insensitively but prints the repo spelling', () => {
    const d = detailOf([{ file_path: 'C:\\Work\\App\\src\\big.js' }, { file_path: 'c:/work/app/src/big.js' }], 'C:\\Work\\App');
    const r = WR.wholeReads({ transcripts: [{ track: 'K-1', detail: d }], ...base, roots: ['c:/work/app'], caseInsensitive: true });
    expect(r.files).toHaveLength(1);
    expect(r.files[0]).toMatchObject({ path: 'src/big.js', whole: 2 });
  });
});

describe('wholeReads: paths outside the repo', () => {
  it('counts a path outside every root, and a file no longer in the main tree, but never lists them', () => {
    const d = detailOf([
      { file_path: '/home/someone/private/notes.md' },
      { file_path: '/tmp/scratch/x.js' },
      { file_path: `${ROOT}/../other/src/big.js` },
      { file_path: `${ROOT}/src/deleted.js` },
      { file_path: `${ROOT}/src/big.js` },
    ]);
    const r = WR.wholeReads({ transcripts: [{ track: 'K-1', detail: d }], ...base });
    expect(r.outside).toBe(3);
    expect(r.gone).toBe(1);
    expect(r.files.map((f: { path: string }) => f.path)).toEqual(['src/big.js']);
    const text = WR.wholeReadLines(r, 'last 28 days').join('\n');
    expect(text).not.toMatch(/private|scratch|other|deleted|\/home|\/tmp/);
    expect(text).toMatch(/3 read\(s\) outside the repo/);
  });
});

describe('wholeReads: sorting and the limit', () => {
  const tracks = [
    { track: 'A', detail: detailOf([{ file_path: `${ROOT}/src/small.js` }, { file_path: `${ROOT}/docs/guide.md` }]) },
    {
      track: 'B',
      detail: detailOf([
        { file_path: `${ROOT}/src/small.js` },
        { file_path: `${ROOT}/src/mid.js` },
        { file_path: `${ROOT}/src/mid.js` },
        { file_path: `${ROOT}/src/mid.js` },
      ]),
    },
    { track: 'C', detail: detailOf([{ file_path: `${ROOT}/src/big.js` }, { file_path: `${ROOT}/src/big.js` }, { file_path: `${ROOT}/src/small.js` }]) },
  ];

  it('sorts by tracks, then whole reads, then path', () => {
    const r = WR.wholeReads({ transcripts: tracks, ...base });
    expect(r.files.map((f: { path: string }) => f.path)).toEqual(['src/small.js', 'src/mid.js', 'src/big.js', 'docs/guide.md']);
    expect(r.files_total).toBe(4);
  });

  it('keeps the top N and says how many more there are; sizes only for the listed files', () => {
    const asked: string[] = [];
    const r = WR.wholeReads({ transcripts: tracks, ...base, sizeOf: (rel: string) => (asked.push(rel), sizeOf(rel)), limit: 2 });
    expect(r.files.map((f: { path: string }) => f.path)).toEqual(['src/small.js', 'src/mid.js']);
    expect(r.files_total).toBe(4);
    expect(r.limit).toBe(2);
    expect(asked.sort()).toEqual(['src/mid.js', 'src/small.js']);
    const text = WR.wholeReadLines(r, 'last 28 days').join('\n');
    expect(text).toMatch(/2 more file\(s\); --limit 4 shows all/);
  });

  it('the default limit is 15', () => {
    expect(WR.DEFAULT_LIMIT).toBe(15);
  });
});

describe('wholeReads: the window', () => {
  it('counts only turns with a timestamp in [from, to)', () => {
    const d = detailOf([{ file_path: `${ROOT}/src/big.js` }, { file_path: `${ROOT}/src/big.js` }]);
    const r = WR.wholeReads({ transcripts: [{ track: 'A', detail: d }], ...base, from: T0 + 1500, to: T0 + 10_000 });
    expect(r.whole_reads).toBe(1);
  });
});

describe('wholeReadLines: the text', () => {
  it('no data gives one calm line', () => {
    const r = WR.wholeReads({ transcripts: [], ...base });
    expect(WR.wholeReadLines(r, 'last 28 days')).toEqual(['Whole-file reads by tracks (last 28 days): nothing yet.']);
  });

  it('lists tracks, whole, excerpt and size per file, and ends with the hint', () => {
    const d = detailOf([{ file_path: `${ROOT}/src/big.js` }]);
    const lines = WR.wholeReadLines(WR.wholeReads({ transcripts: [{ track: 'A', detail: d }], ...base }), 'last 28 days');
    expect(lines[0]).toMatch(/^Whole-file reads by tracks \(last 28 days; 1 track\(s\), 1 whole read\(s\), 0 excerpt read\(s\)/);
    expect(lines.join('\n')).toMatch(/1\s+1\s+0\s+1200 lines, 47 KB\s+src\/big\.js/);
    expect(lines[lines.length - 1]).toMatch(/^Hint: .*catalog excerpt.*split/);
  });
});

// ---- Process: `ravenseat cost --reads` reads the subagent transcripts of the window (and --json) ----
describe('queue.mjs cost --reads from real files', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { spawnSync } = require('node:child_process');
  const ORCHESTRATOR = path.join(__dirname, '..', '..');

  /** A temp project with a main tree, a queue folder, a time log and a transcripts folder; `run` calls queue.mjs. */
  function project() {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-reads-'));
    const root = path.join(folder, 'app');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'big.js'), 'x\n'.repeat(1000));
    fs.writeFileSync(path.join(root, 'src', 'small.js'), 'y\n'.repeat(10));
    fs.writeFileSync(path.join(folder, 'queue.json'), JSON.stringify({ resolved: [], projects: {}, tasks: [] }));
    const configFile = path.join(folder, 'queue.config.json');
    fs.writeFileSync(configFile, '{}');
    const tr = path.join(folder, 'transcripts');
    const log = path.join(folder, 'times.jsonl');
    fs.writeFileSync(log, '');
    const env = {
      ...process.env,
      QUEUE_FOLDER: folder,
      QUEUE_CONFIG: configFile,
      QUEUE_ROOT: root,
      QUEUE_GIT: root,
      QUEUE_TIME_LOG: log,
      QUEUE_TRANSCRIPTS: tr,
    };
    const run = (...args: string[]) => {
      const r = spawnSync(process.execPath, [path.join(ORCHESTRATOR, 'queue.mjs'), ...args], { encoding: 'utf8', env });
      return { code: r.status, out: r.stdout ?? '', error: r.stderr ?? '' };
    };
    return { folder, root, tr, log, run };
  }

  /** A transcript dated within the last hour, with one whole Read per file (absolute under `cwd`). */
  function transcript(cwd: string, files: string[]): string {
    const now = Date.now() - 3_600_000;
    const at = (sec: number) => new Date(now + sec * 1000).toISOString();
    const lines = [JSON.stringify({ type: 'user', timestamp: at(0), cwd, message: { role: 'user', content: 'Track work.' } })];
    files.forEach((f, i) =>
      lines.push(
        JSON.stringify({
          type: 'assistant',
          timestamp: at(1 + i),
          cwd,
          message: {
            id: `m${i}`,
            role: 'assistant',
            model: 'claude-opus-5-5',
            usage: USAGE,
            content: [{ type: 'tool_use', id: `u${i}`, name: 'Read', input: { file_path: f.startsWith('/') || /^[A-Za-z]:/.test(f) ? f : `${cwd}/${f}` } }],
          },
        }),
      ),
    );
    return lines.join('\n') + '\n';
  }

  it('with no transcripts prints one calm line, and --json gives an empty list', () => {
    const p = project();
    try {
      const t = p.run('cost', '--reads');
      expect(t.code, t.error).toBe(0);
      expect(t.out.trim()).toBe('Whole-file reads by tracks (last 28 days): nothing yet.');
      const j = p.run('cost', '--reads', '--json');
      expect(j.code, j.error).toBe(0);
      expect(JSON.parse(j.out)).toMatchObject({ files: [], files_total: 0, whole_reads: 0, limit: 15 });
    } finally {
      fs.rmSync(p.folder, { recursive: true, force: true });
    }
  });

  it('lists the files read whole across tracks, repo-relative, with --limit and --json; main sessions do not count', () => {
    const p = project();
    try {
      const root = p.root.replace(/\\/g, '/');
      const wt = path.join(p.folder, 'tree-k2').replace(/\\/g, '/');
      fs.mkdirSync(path.join(p.tr, 's1', 'subagents'), { recursive: true });
      // Track K-1 in the main tree; track K-2 in a worktree that no longer exists (its cwd is the root); and a read
      // outside the repo, which is counted but never printed.
      fs.writeFileSync(path.join(p.tr, 's1', 'subagents', 'agent-a1.jsonl'), transcript(root, ['src/big.js', 'src/small.js', `${p.folder.replace(/\\/g, '/')}/secret/notes.md`]));
      fs.writeFileSync(path.join(p.tr, 's1', 'subagents', 'agent-a2.jsonl'), transcript(wt, ['src/big.js', 'src/big.js']));
      // The main session reads big.js too: not a track, left out.
      fs.writeFileSync(path.join(p.tr, 's1.jsonl'), transcript(root, ['src/big.js', 'src/big.js', 'src/big.js']));
      const iso = new Date(Date.now() - 1_800_000).toISOString();
      fs.writeFileSync(
        p.log,
        [
          { time: iso, event: 'start', agent_id: 'a1', agent_type: 'track', track: 'K-1' },
          { time: iso, event: 'start', agent_id: 'a2', agent_type: 'track', track: 'K-2' },
        ]
          .map((r) => JSON.stringify(r))
          .join('\n') + '\n',
      );
      const j = p.run('cost', '--reads', '--json');
      expect(j.code, j.error).toBe(0);
      const data = JSON.parse(j.out);
      expect(data.files).toEqual([
        { path: 'src/big.js', tracks: 2, whole: 3, excerpt: 0, lines: 1000, kb: 2 },
        { path: 'src/small.js', tracks: 1, whole: 1, excerpt: 0, lines: 10, kb: 0 },
      ]);
      expect(data).toMatchObject({ tracks: 2, whole_reads: 4, outside: 1, limit: 15 });
      expect(j.out).not.toMatch(/secret/);
      const t = p.run('cost', '--reads', '--limit', '1');
      expect(t.code, t.error).toBe(0);
      expect(t.out).toMatch(/src\/big\.js/);
      expect(t.out).not.toMatch(/src\/small\.js/);
      expect(t.out).toMatch(/1 more file\(s\); --limit 2 shows all/);
      expect(t.out).toMatch(/1 read\(s\) outside the repo/);
      expect(t.out).not.toMatch(/secret|tree-k2/);
      expect(t.out).toMatch(/^Hint: /m);
      expect(p.run('cost', '--reads', '--limit', '0').code).not.toBe(0);
    } finally {
      fs.rmSync(p.folder, { recursive: true, force: true });
    }
  });
});
