// =============================================================
// sinceFlow.test.ts: `ravenseat since [--window last-seen|24h|7d] [--json] [--mark] [--max <n>]` (cli/since.mjs,
// roadmap 3e AW-4, plans/borte-flate-vurdering-2026-11-21.md).
//
// Locks: (1) the text is the window line, four one-line parts and the event list, from lib/awaySummary.js (the same join
// the board's band uses); (2) --json gives the window, counts and events; (3) without a seen mark it says so and shows
// 24 hours; (4) --mark writes seen.json (by cli) after printing, and the next run starts there; without --mark nothing is
// written; (5) a quiet window is one line "Nothing ran since ..."; (6) a usage error is exit 2 and writes nothing.
// Runs ravenseat.mjs against a temporary queue. Never the main repo.
// =============================================================
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const RAVENSEAT = path.resolve(__dirname, '..', 'ravenseat.mjs');
const ID = ['-c', 'user.name=queue-test', '-c', 'user.email=queue-test@example.invalid'];
const H = 3_600_000;
const ago = (h: number) => new Date(Date.now() - h * H).toISOString();

const temporary: string[] = [];
afterAll(() => {
  for (const m of temporary) fs.rmSync(m, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
});

const task = (id: string, extra: object = {}) => ({
  id,
  title: `Task ${id}`,
  domain: `dom-${id}`,
  class: 'K',
  status: 'waiting',
  mission: `The mission for ${id}.`,
  value: 5,
  content_min: 60,
  depends_on: [],
  waiting_on: [],
  owned_files: [`lib/${id}.ts`],
  added_by: 'owner',
  added_at: ago(48),
  ...extra,
});

function project(tasks: object[], rows: object[] = []) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-since-'));
  temporary.push(folder);
  const repo = path.join(folder, 'repo');
  fs.mkdirSync(repo);
  const g = (args: string[]) => execFileSync('git', ['-C', repo, ...ID, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  g(['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(repo, 'README.md'), 'start\n');
  g(['add', '--', 'README.md']);
  g(['commit', '-q', '-m', 'start']);
  fs.writeFileSync(path.join(folder, 'queue.json'), JSON.stringify({ created: ago(72), limits: {}, resolved: [], tasks }, null, 2));
  fs.writeFileSync(path.join(folder, 'times.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
  const configFile = path.join(folder, 'queue.config.json');
  fs.writeFileSync(configFile, JSON.stringify({ baseBranch: 'main' }));
  const env = {
    ...process.env,
    QUEUE_FOLDER: folder,
    QUEUE_CONFIG: configFile,
    QUEUE_ROOT: folder,
    QUEUE_GIT: repo,
    QUEUE_TIME_LOG: path.join(folder, 'times.jsonl'),
    QUEUE_TRANSCRIPTS: path.join(folder, 'transcripts'),
  } as NodeJS.ProcessEnv;
  const run = (...args: string[]) => {
    const r = spawnSync(process.execPath, [RAVENSEAT, 'since', ...args], { encoding: 'utf8', env, cwd: folder });
    return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
  };
  return { folder, run, seen: path.join(folder, 'seen.json') };
}

const night = () =>
  project(
    [
      task('EX-1', { status: 'done', started: ago(9), done: ago(7) }),
      task('EX-2', { status: 'done', started: ago(8), done: ago(5), resumed: [{ reason: 'fix', round: 1, time: ago(6) }] }),
      task('EX-3', { status: 'done', started: ago(40), done: ago(30) }),
    ],
    [
      { time: ago(9.5), event: 'queue-start', command: 'fill', running: 0 },
      { time: ago(6.5), event: 'gate', track: 'EX-2', kind: 'quick', ok: false, failed: ['npm test'], attempt: 1 },
      { time: ago(6), event: 'fixRound', task: 'EX-2', reason: 'fix', round: 1 },
    ],
  );

describe('ravenseat since', () => {
  it('without a mark: the last 24 hours, said so, four parts and the events; nothing written', () => {
    const p = night();
    const r = p.run();
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^Since you left: last 24 hours \(no seen mark yet/m);
    expect(r.out).toMatch(/^Done: 2 merged, 1 recovered without you/m);
    expect(r.out).toMatch(/^Stuck: 0 blocked now/m);
    expect(r.out).toMatch(/^Waiting on you: 0/m);
    expect(r.out).toMatch(/^not read: spend -> no session cost rows in the window/m);
    expect(r.out).toMatch(/x EX-2 quick gate red: npm test/);
    expect(r.out).not.toMatch(/EX-3/);
    expect(fs.existsSync(p.seen)).toBe(false);
  });

  it('--json gives the window, the counts and the events', () => {
    const p = night();
    const r = p.run('--json', '--window', '7d');
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out);
    expect(j.window).toMatchObject({ choice: '7d', used: '7d', text: 'last 7 days' });
    expect(j.counts).toMatchObject({ merged: 3, recovered: 1, waiting: 0 });
    expect(j.events.map((e: { kind: string }) => e.kind)).toContain('gate-red');
  });

  it('--mark writes the mark after printing; the next run starts there and is quiet', () => {
    const p = night();
    const first = p.run('--mark');
    expect(first.code).toBe(0);
    expect(first.out).toMatch(/^Done: 2 merged/m);
    expect(first.out).toMatch(/Seen mark set to /);
    const seen = JSON.parse(fs.readFileSync(p.seen, 'utf8'));
    expect(seen.by).toBe('cli');
    const next = p.run();
    expect(next.out).toMatch(/^Nothing ran since \d\d:\d\d\./);
    expect(next.out.trim().split('\n')).toHaveLength(1);
  });

  it('a usage error is exit 2 and writes nothing', () => {
    const p = night();
    for (const args of [['--window', 'week'], ['--window'], ['--max', 'x'], ['--what']]) {
      const r = p.run(...args);
      expect(r.code, args.join(' ')).toBe(2);
      expect(r.err).toMatch(/Use: ravenseat since/);
    }
    expect(fs.existsSync(p.seen)).toBe(false);
  });
});
