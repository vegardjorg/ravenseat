// =============================================================
// turnTools.test.ts: the "Turns and tools" measurements in `ravenseat cost` (lib/turnTools.js on top of the one
// transcript reader, lib/timeCost.js analyzeTranscript with { detail: true }):
//   1. tool calls per turn (median, p90) and the share of turns with more than one call,
//   2. serial single reads (runs of 3 or more turns that each make exactly one read call),
//   3. tool result size per tool (characters), top 5 by volume,
//   4. cost above and below the context threshold (cost.contextThresholdK),
//   5. turns that start from a background task notification, and their cost share,
//   6. a main session that worked in another repo (conservative heuristic), kept out of this project's totals.
// The fixtures are synthetic transcripts in Claude Code's JSONL shape (one line per content block, the same message
// id across the lines of one turn), with neutral paths.
// =============================================================
import { describe, it, expect } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const T = require('../timeCost');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const TT = require('../turnTools');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const KK = require('../queueConfig');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const REG = require('../settingsRegistry');

const T0 = Date.parse('2026-11-12T08:00:00Z');
const ts = (sec: number) => new Date(T0 + sec * 1000).toISOString();
const ROOT = '/work/app';

type Block = Record<string, unknown>;
type Usage = Record<string, unknown>;

/** A normal turn's usage: about 51k context, so below a 200k threshold. */
const SMALL: Usage = { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 1_000 };
/** A turn with about 300k context. */
const LARGE: Usage = { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 299_000, cache_creation_input_tokens: 1_000 };

/** One assistant turn, streamed as Claude Code writes it: one line per content block, the same message id. */
function turn(id: string, sec: number, blocks: Block[], usage: Usage = SMALL, cwd = ROOT): string[] {
  return blocks.map((b) =>
    JSON.stringify({
      type: 'assistant',
      timestamp: ts(sec),
      cwd,
      version: '2.1.320',
      message: { id, role: 'assistant', model: 'claude-opus-5-5', usage, content: [b] },
    }),
  );
}
const use = (id: string, name: string, input: Record<string, unknown>): Block => ({ type: 'tool_use', id, name, input });
const text = (t: string): Block => ({ type: 'text', text: t });
/** The tool results for a turn, in one user entry (as Claude Code writes them). */
const results = (sec: number, list: [string, string][], cwd = ROOT) =>
  JSON.stringify({
    type: 'user',
    timestamp: ts(sec),
    cwd,
    message: {
      role: 'user',
      content: list.map(([id, out]) => ({ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: out }] })),
    },
  });
const prompt = (sec: number, t: string, cwd = ROOT) =>
  JSON.stringify({ type: 'user', timestamp: ts(sec), cwd, message: { role: 'user', content: t } });
/** A background task notification as the main session gets it (origin and turnOrigin, plus the tag in the text). */
const notification = (sec: number) =>
  JSON.stringify({
    type: 'user',
    timestamp: ts(sec),
    cwd: ROOT,
    origin: { kind: 'task-notification', producer: 'session-task' },
    promptSource: 'system',
    turnOrigin: 'task_notification',
    message: {
      role: 'user',
      content: '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>Background command "npm test" completed (exit code 0)</summary>\n</task-notification>',
    },
  });
/** A system reminder entry (isMeta): never a new prompt. */
const meta = (sec: number) =>
  JSON.stringify({ type: 'user', isMeta: true, timestamp: ts(sec), cwd: ROOT, message: { role: 'user', content: '<system-reminder>x</system-reminder>' } });

const read = (id: string, file: string) => use(id, 'Read', { file_path: file });
const bash = (id: string, command: string) => use(id, 'Bash', { command });

/** The fixture session used by most tests (times in seconds from T0). */
function session(): string {
  const lines: string[] = [];
  lines.push(prompt(0, 'Fix the failing parser test in src/parse.js.'));
  // t1: two reads in one turn (parallel).
  lines.push(...turn('m1', 1, [text('Looking.'), read('u1', `${ROOT}/src/parse.js`), read('u2', `${ROOT}/src/lex.js`)]));
  lines.push(results(2, [['u1', 'a'.repeat(4000)], ['u2', 'b'.repeat(1000)]]));
  // t2..t4: three single reads in a row (one run of 3).
  lines.push(...turn('m2', 3, [use('u3', 'Grep', { pattern: 'tokenize', path: `${ROOT}/src` })]));
  lines.push(results(4, [['u3', 'c'.repeat(300)]]));
  lines.push(...turn('m3', 5, [bash('u4', `sed -n 1,40p ${ROOT}/src/util.js`)]));
  lines.push(results(6, [['u4', 'd'.repeat(2000)]]));
  lines.push(meta(6));
  lines.push(...turn('m4', 7, [use('u5', 'Glob', { pattern: 'src/**/*.test.js' })]));
  lines.push(results(8, [['u5', 'e'.repeat(100)]]));
  // t5: an edit (not a read: ends the run).
  lines.push(...turn('m5', 9, [use('u6', 'Edit', { file_path: `${ROOT}/src/parse.js`, old_string: 'x', new_string: 'y' })]));
  lines.push(results(10, [['u6', 'ok']]));
  // t6: a background test run, then the text that ends the reply.
  lines.push(...turn('m6', 11, [bash('u7', 'npm test')], LARGE));
  lines.push(results(12, [['u7', 'Command running in background with ID: b1']]));
  lines.push(...turn('m7', 13, [text('Waiting for the tests.')], LARGE));
  // The notification wakes the session: two turns from it (a read, then the closing text).
  lines.push(notification(600));
  lines.push(...turn('m8', 601, [bash('u8', 'cat /tmp/out.txt')], LARGE));
  lines.push(results(602, [['u8', 'f'.repeat(500)]]));
  lines.push(...turn('m9', 603, [text('Tests pass.')], LARGE));
  return lines.join('\n') + '\n';
}

const detailOf = (t: string) => T.analyzeTranscript(t, { detail: true }).detail;
const summaryOf = (t: string, thresholdK = 200) =>
  TT.summarize(TT.transcriptStats(detailOf(t), { thresholdTokens: thresholdK * 1000 }));

describe('the one transcript reader gives the turns in detail (no second parser)', () => {
  it('detail groups the streamed lines of a turn by message id, with calls, origin and the result sizes', () => {
    const d = detailOf(session());
    expect(d.turns).toHaveLength(9);
    expect(d.turns[0].calls.map((c: { name: string }) => c.name)).toEqual(['Read', 'Read']);
    expect(d.turns[0].origin).toBe('user');
    expect(d.turns[7].origin).toBe('notification');
    expect(d.resultChars.u1).toBe(4000);
    expect(d.cwd).toBe(ROOT);
  });

  it('without the option the result is unchanged (no detail field)', () => {
    expect(T.analyzeTranscript(session())).not.toHaveProperty('detail');
  });
});

describe('1. tool calls per turn', () => {
  it('median and p90 over all turns, and the share of tool turns with more than one call', () => {
    const s = summaryOf(session());
    // Calls per turn: 2,1,1,1,1,1,0,1,0 -> median 1, p90 2.
    expect(s.turns).toBe(9);
    expect(s.calls_per_turn).toEqual({ median: 1, p90: 2 });
    // 7 turns with a call, 1 of them with more than one.
    expect(s.tool_turns).toBe(7);
    expect(s.parallel_pct).toBe(14.3);
  });
});

describe('2. serial single reads', () => {
  it('a run of 3 single-read turns counts; a two-call turn and an edit break it', () => {
    const s = summaryOf(session());
    // Read turns: m1 (two reads), m2, m3, m4, m8 = 5; single-read turns in runs of 3+: m2..m4.
    expect(s.serial).toEqual({ runs: 1, turns_in_runs: 3, read_turns: 5, pct: 60 });
  });

  it('read-only Bash is a read; writing or running is not', () => {
    for (const c of [
      'cat a.txt | head -n 5',
      'sed -n 1,20p src/x.js',
      'grep -rn "foo" src 2>/dev/null',
      'ls -la',
      'cd /work/app && cat README.md',
      'git log --oneline -5',
      'wc -l src/*.js',
      'rg tokenize src',
    ])
      expect(TT.readOnlyBash(c), c).toBe(true);
    for (const c of [
      'sed -i s/a/b/ x.js',
      'cat a > b',
      'rm -rf build',
      'npm test',
      'find . -name "*.tmp" -delete',
      'git commit -m x',
      'cat <<EOF > out.txt\nx\nEOF',
      'node -e "console.log(1)"',
      'cd /work/app',
    ])
      expect(TT.readOnlyBash(c), c).toBe(false);
    expect(TT.isReadCall({ name: 'Read', input: {} })).toBe(true);
    expect(TT.isReadCall({ name: 'Write', input: {} })).toBe(false);
  });
});

describe('3. tool result size per tool', () => {
  it('total and median characters per tool, top 5 by volume, with approximate tokens (chars / 4)', () => {
    const s = summaryOf(session());
    expect(s.tool_output.unit).toBe('chars');
    const top = s.tool_output.top;
    expect(top.length).toBeLessThanOrEqual(5);
    expect(top[0]).toMatchObject({ name: 'Read', results: 2, chars: 5000, median_chars: 2500, approx_tokens: 1250 });
    expect(top[1]).toMatchObject({ name: 'Bash', results: 3, chars: 2000 + 41 + 500 });
    expect(top.map((t: { name: string }) => t.name)).toEqual(['Read', 'Bash', 'Grep', 'Glob', 'Edit']);
  });
});

describe('4. cost above and below the context threshold', () => {
  it('the turns whose context is above the threshold, as a share of cost', () => {
    const s = summaryOf(session());
    expect(s.context.threshold_k).toBe(200);
    expect(s.context.above_turns).toBe(4);
    expect(s.context.below_turns).toBe(5);
    expect(s.context.above_usd + s.context.below_usd).toBeCloseTo(s.usd, 6);
    expect(s.context.above_pct).toBeGreaterThan(70);
    // A higher threshold puts everything below.
    expect(summaryOf(session(), 400).context.above_turns).toBe(0);
  });

  it('the setting: cost.contextThresholdK, default 200, an Advanced row', () => {
    expect(KK.STANDARD.cost.contextThresholdK).toBe(200);
    const row = REG.rowFor('cost.contextThresholdK');
    expect(row).toMatchObject({ level: 'advanced', type: 'integer' });
  });
});

describe('5. turns after a background task notification', () => {
  it('counts the notifications (episodes), their turns and their cost share; a system reminder is no prompt', () => {
    const s = summaryOf(session());
    expect(s.notifications.episodes).toBe(1);
    expect(s.notifications.turns).toBe(2);
    expect(s.notifications.pct).toBeGreaterThan(0);
    expect(s.notifications.usd).toBeLessThan(s.usd);
  });

  it('a "Background command ... completed" text without origin counts too', () => {
    const lines = [
      prompt(0, 'go'),
      ...turn('a1', 1, [text('started')]),
      prompt(500, 'Background command "build" completed (exit code 0)'),
      ...turn('a2', 501, [text('done')]),
    ];
    expect(summaryOf(lines.join('\n')).notifications).toMatchObject({ episodes: 1, turns: 1 });
  });
});

describe('the window', () => {
  it('only the turns with a timestamp in [from, to) count', () => {
    const d = detailOf(session());
    const s = TT.summarize(TT.transcriptStats(d, { from: T0 + 500_000, to: T0 + 700_000, thresholdTokens: 200_000 }));
    expect(s.turns).toBe(2);
    expect(s.notifications.turns).toBe(2);
  });
});

describe('6. a main session that worked in another repo', () => {
  /** A session in ROOT whose tool calls point at `n` paths in `other` and `k` paths in ROOT. */
  function elsewhere(n: number, k: number, other = '/work/other-lib') {
    const lines = [prompt(0, 'Work on the library.')];
    for (let i = 0; i < n; i++) {
      lines.push(...turn(`o${i}`, 10 + i * 2, [read(`r${i}`, `${other}/src/f${i}.js`)]));
      lines.push(results(11 + i * 2, [[`r${i}`, 'x']]));
    }
    for (let i = 0; i < k; i++) {
      lines.push(...turn(`h${i}`, 500 + i * 2, [bash(`b${i}`, `cat ${ROOT}/notes/n${i}.md`)]));
      lines.push(results(501 + i * 2, [[`b${i}`, 'y']]));
    }
    return detailOf(lines.join('\n'));
  }
  const opts = { roots: [ROOT], neutral: ['/tmp'] };

  it('most path calls outside the project root, into one other root: another repo', () => {
    const r = TT.otherRepoCheck(elsewhere(12, 2), opts);
    expect(r).toMatchObject({ other: true, outside: 12, inside: 2, root: '/work/other-lib' });
  });

  it('conservative: too few path calls, or about half outside, is not another repo', () => {
    expect(TT.otherRepoCheck(elsewhere(6, 0), opts).other).toBe(false);
    expect(TT.otherRepoCheck(elsewhere(10, 10), opts).other).toBe(false);
  });

  it('temp and neutral paths do not count; Windows paths compare without case', () => {
    expect(TT.otherRepoCheck(elsewhere(12, 0, '/tmp/scratch'), opts)).toMatchObject({ other: false, outside: 0 });
    const win = (p: string) => p.replace(/^\/work/, 'C:\\Work').replace(/\//g, '\\');
    const lines = [prompt(0, 'x', 'C:\\work\\app')];
    for (let i = 0; i < 12; i++) {
      lines.push(...turn(`w${i}`, 10 + i, [read(`w${i}`, win(`/work/other-lib/f${i}.js`))], SMALL, 'C:\\work\\app'));
      lines.push(...turn(`v${i}`, 100 + i, [read(`v${i}`, win(`/work/app/g${i}.js`))], SMALL, 'C:\\work\\app'));
    }
    const r = TT.otherRepoCheck(detailOf(lines.join('\n')), { roots: ['C:\\work\\app'], neutral: [] });
    expect(r).toMatchObject({ other: false, outside: 12, inside: 12 });
  });

  it('the report keeps such a session out of the groups and lists its cost apart', () => {
    const rep = TT.turnsAndTools({
      transcripts: [
        { group: 'orchestrator', session: 's-orch', main: true, detail: detailOf(session()) },
        { group: 'main session', session: 's-lib', main: true, detail: elsewhere(12, 0) },
        { group: 'track', session: 's-orch', main: false, detail: detailOf(session()) },
      ],
      roots: [ROOT],
      neutral: ['/tmp'],
      thresholdK: 200,
      sessionUsd: new Map([['s-lib', 3.5]]),
    });
    expect(rep.groups.map((g: { group: string }) => g.group)).toEqual(['orchestrator', 'track']);
    expect(rep.otherRepo).toHaveLength(1);
    expect(rep.otherRepo[0]).toMatchObject({ session: 's-lib', root: '/work/other-lib', usd: 3.5, outside: 12 });
    const lines = TT.turnsToolsLines(rep, 'last 28 days');
    expect(lines[0]).toMatch(/^Turns and tools/);
    expect(lines.join('\n')).toMatch(/orchestrator/);
    expect(lines.join('\n')).toMatch(/worked in another repo/);
    expect(lines.join('\n')).not.toMatch(/[\u2013\u2014]/);
  });
});

// ---- Process: `ravenseat cost` reads the transcripts of the window and prints the block (and --json) ----
describe('queue.mjs cost: the Turns and tools block from real files', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { spawnSync } = require('node:child_process');
  const ORCHESTRATOR = path.join(__dirname, '..', '..');

  it('groups by orchestrator and agent type, and keeps a session that worked in another repo out of the totals', () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-turns-'));
    try {
      const root = path.join(folder, 'app');
      const sibling = path.join(folder, 'other-lib');
      fs.mkdirSync(root);
      fs.writeFileSync(path.join(folder, 'queue.json'), JSON.stringify({ resolved: [], projects: {}, tasks: [] }));
      const configFile = path.join(folder, 'queue.config.json');
      fs.writeFileSync(configFile, JSON.stringify({ cost: { contextThresholdK: 100 } }));
      const now = Date.now();
      const iso = (min: number) => new Date(now - min * 60_000).toISOString();
      // Transcript lines dated within the last hour (the fixture helpers use T0; shift each timestamp).
      const shift = (text: string) =>
        text
          .split('\n')
          .filter(Boolean)
          .map((l) => {
            const r = JSON.parse(l);
            if (r.timestamp) r.timestamp = new Date(Date.parse(r.timestamp) - T0 + now - 3_600_000).toISOString();
            return JSON.stringify(r).split(ROOT).join(root.replace(/\\/g, '/'));
          })
          .join('\n') + '\n';
      const tr = path.join(folder, 'transcripts');
      fs.mkdirSync(path.join(tr, 's-orch', 'subagents'), { recursive: true });
      fs.writeFileSync(path.join(tr, 's-orch.jsonl'), shift(session()));
      fs.writeFileSync(path.join(tr, 's-orch', 'subagents', 'agent-ab12.jsonl'), shift(session()));
      // The session that worked in the sibling folder: 12 reads there.
      const away = [prompt(0, 'Work on the library.')];
      for (let i = 0; i < 12; i++) {
        away.push(...turn(`o${i}`, 10 + i * 2, [read(`r${i}`, `${sibling.replace(/\\/g, '/')}/src/f${i}.js`)]));
        away.push(results(11 + i * 2, [[`r${i}`, 'x']]));
      }
      fs.writeFileSync(path.join(tr, 's-away.jsonl'), shift(away.join('\n')));
      const log = path.join(folder, 'times.jsonl');
      fs.writeFileSync(
        log,
        [
          { time: iso(50), event: 'session', session_id: 's-orch', usd: 2, orchestrator: true },
          { time: iso(40), event: 'session', session_id: 's-away', usd: 7 },
          { time: iso(30), event: 'start', agent_id: 'ab12', agent_type: 'track', track: 'ab12' },
        ]
          .map((r) => JSON.stringify(r))
          .join('\n') + '\n',
      );
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
      const j = run('cost', '--json');
      expect(j.code, j.error).toBe(0);
      const data = JSON.parse(j.out);
      const tt = data.turnsAndTools;
      expect(tt.threshold_k).toBe(100);
      expect(tt.groups.map((g: { group: string }) => g.group)).toEqual(['orchestrator', 'track']);
      expect(tt.groups[0].turns).toBe(9);
      expect(tt.otherRepo).toHaveLength(1);
      expect(tt.otherRepo[0]).toMatchObject({ session: 's-away', usd: 7, usd_source: 'status line' });
      // The other-repo session's $7 is not among the main sessions in the orchestration figures.
      expect(data.orchestration.other.gross_usd).toBe(0);
      expect(data.orchestration.gross_usd).toBe(2);
      const text = run('cost');
      expect(text.code, text.error).toBe(0);
      expect(text.out).toMatch(/Turns and tools/);
      expect(text.out).toMatch(/worked in another repo/);
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });
});
