// =============================================================
// queueRoundOpen.test.ts: findings from test round 5, in the places the rules are enforced.
//
// Why: a task in review with a new round under way was flagged "in review" and called DELIVERED while its agent worked,
// and a hung agent in such a round got no SILENT. The rest are small texts that gave wrong advice: the fix round line,
// ravenseat show --json, ravenseat edit on an unknown id, the mascot's "empty queue", the ravenseat decide headings and the setup line.
// The ravenseat commands run against a temporary git repo (never the main repo or a real queue).
// =============================================================
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const L = require('../queueLogic.js') as any;
const T = require('../queueBoard.js') as { board: (q: unknown, o?: unknown) => any };
const D = require('../queueDecisions.js') as { decisions: (inbox: unknown) => any[] };
const M = require('../queueMascot.js') as any;
const U = require('../queueUpdate.js') as any;

const NOW = Date.parse('2026-11-05T10:00:00.000Z');
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const HOOKS = { sandbox: false, network: 'hook', hooks: true };
const LIMITS = { K: { cycle: 40, work: 40 } };

const earlier = { id: 'a1', round: 0, state: 'ended', reserved: ago(300), ended: ago(100), guard: HOOKS };
/** In review since an earlier delivery; `state` is the last attempt's. */
const inReview = (state: string | null, extra: Record<string, unknown> = {}) => ({
  id: 'R',
  title: 'Task R',
  status: 'review',
  class: 'K',
  branch: 'queue/R',
  started: ago(300),
  attempts: state ? [earlier, { id: 'a2', round: 1, state, reserved: ago(90), guard: HOOKS }] : [earlier],
  ...extra,
});
const board = (tasks: unknown[], option: Record<string, unknown> = {}) =>
  T.board({ tasks, limits: {} }, { now: NOW, ageLimits: LIMITS, ...option });
const card = (b: any) => b.columns.review.find((k: any) => k.id === 'R');

describe('a round under way is not "in review" (Q7)', () => {
  it('a review nobody works on ages as before', () => {
    const b = board([inReview(null)]);
    expect(card(b).aging).toMatchObject({ measure: 'cycle' });
    expect(D.decisions(b.inbox).map((x) => x.kind)).toEqual(['stuck-aging']);
  });

  it.each(['reserved', 'running'])('a %s round is not aged, and gets no card to flag it', (state) => {
    const b = board([inReview(state)]);
    expect(card(b).aging).toBeNull();
    expect(D.decisions(b.inbox)).toEqual([]);
  });

  it('takeover says WORKING, but a report from the round still counts as delivered', () => {
    const base = { status: 'review', commits: 3, workingRound: 1 };
    expect(L.assessActive(base)).toBe('WORKING (round 1 prepared or running, no report yet)');
    expect(L.assessActive({ ...base, workingRound: null })).toBe('DELIVERED (review)');
    expect(L.assessActive({ ...base, delivery: { status: 'DONE' } })).toMatch(/^DELIVERED \(track-result/);
    expect(L.assessActive({ ...base, noAgent: { prepared: true, round: 1 } })).toMatch(/^NO AGENT/);
    // A running track keeps its heuristic: a first start has an open attempt too.
    expect(L.assessActive({ status: 'running', commits: 2, uncommitted: 0, lastMs: 3_600_000, workingRound: 0 })).toMatch(
      /^DELIVERED/,
    );
  });
});

describe('a hung agent in a new round (Q7)', () => {
  const silent = (o: unknown, activity: Record<string, number> = {}, hasReport = () => false) =>
    L.silentTracks(
      { tasks: [o], limits: {} },
      { worktreeBranches: new Set(['queue/R']), lastActivity: activity, hasReport, now: NOW, limitMin: 30 },
    );

  it('is a candidate while the round is open, and not when no round is', () => {
    const list = (o: unknown) => L.silentCandidates({ tasks: [o] }, new Set(['queue/R'])).map((x: any) => x.id);
    expect(list(inReview('running'))).toEqual(['R']);
    expect(list(inReview(null))).toEqual([]);
  });

  it('counts from when the round was prepared, not the first start', () => {
    const young = inReview('running', {
      attempts: [earlier, { id: 'a2', round: 1, state: 'running', reserved: ago(10), guard: HOOKS }],
    });
    expect(silent(young)).toEqual([]);
    expect(silent(inReview('running')).map((x: any) => x.silent_ms)).toEqual([90 * 60_000]);
  });

  it('a report from the earlier round does not turn it off, one from this round does', () => {
    const o = inReview('running');
    expect(L.reportSinceStart(o, { mtimeMs: NOW - 200 * 60_000 })).toBe(false);
    expect(L.reportSinceStart(o, { mtimeMs: NOW - 5 * 60_000 })).toBe(true);
    // No open round: measured from the start, as before.
    expect(L.reportSinceStart(inReview(null), { mtimeMs: NOW - 200 * 60_000 })).toBe(true);
  });

  it('a long silence reaches the board as a card with the SILENT heading', () => {
    const [item] = D.decisions(
      board([inReview('running')], { silent: [{ id: 'R', branch: 'queue/R', silent_ms: 90 * 60_000 }] }).inbox,
    );
    expect(item).toMatchObject({ kind: 'stuck-silent', heading: 'SILENT' });
  });
});

describe('the ravenseat decide headings (Q9)', () => {
  it('name the problem on both kinds of card without an agent', () => {
    const [round] = D.decisions(
      board([inReview('reserved')], { withoutAgent: [{ id: 'R', prepared: true, round: 1, reason: 'context' }] }).inbox,
    );
    expect(round).toMatchObject({ heading: 'NO AGENT', kindName: 'Round without an agent' });
    const first = { ...inReview(null), status: 'running', attempts: [] };
    const [start] = D.decisions(board([first], { withoutAgent: [{ id: 'R' }] }).inbox);
    expect(start).toMatchObject({ heading: 'NO AGENT', kindName: 'Started without an agent' });
  });
});

describe('the line after a red gate (Q3)', () => {
  it('says to free the branch first only when the NOTE says it is held', () => {
    const held = 'x\nNOTE: queue/A is checked out in C:/w. If the old agent is done: git -C "C:/w" switch --detach\n';
    expect(L.fixRoundLine(held, 'ravenseat', 'A')).toMatch(/^If the old agent is done, run the git switch --detach/);
    expect(L.fixRoundLine(held, 'ravenseat', 'A')).toContain('Start the fix round in the SAME turn');
    expect(L.fixRoundLine('queue/A was checked out in C:/w, where the old agent is done: freed\n', 'ravenseat', 'A')).toMatch(
      /^Start the fix round in the SAME turn \(the line above\), then ravenseat receive A again\.$/,
    );
    expect(L.fixRoundLine(undefined, 'ravenseat', 'A')).toMatch(/^Start the fix round/);
  });
});

describe('the mascot and an empty queue (Q6)', () => {
  const none = { queue: [], batch: [], inProgress: [], review: [], proposed: [], built: [] };
  const busy = { columns: { ...none, inProgress: [{ id: 'P' }] } };
  const events = (columns: unknown) => M.detect(busy, { columns }).events.map((h: any) => h.event);

  it('a task in review or a proposal is not an empty queue', () => {
    expect(events({ ...none, review: [{ id: 'R' }] })).not.toContain('queue-empty');
    expect(events({ ...none, proposed: [{ id: 'F' }] })).not.toContain('queue-empty');
    expect(events(none)).toContain('queue-empty');
  });
});

describe('the setup line in ravenseat show (Q2)', () => {
  const line = (setupVersion: string | null, installed = '0.8.23', mode = 'plugin') =>
    U.setupBehindLine({ mode, installed, setupVersion });

  it('speaks only when setup was recorded for an older version', () => {
    expect(line('0.8.20')).toBe(
      'Setup is behind: ravenseat 0.8.23 is installed, the project was set up for ravenseat 0.8.20. Run: ravenseat setup --settings',
    );
    expect(line('0.8.23')).toBeNull();
    expect(line('0.8.24')).toBeNull();
    expect(line(null)).toBeNull();
    expect(line('0.8.20', '0.8.23', 'vendored')).toBeNull();
  });
});

describe('ravenseat against a temporary repo (Q1, Q10)', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-round-'));
  afterAll(() => fs.rmSync(folder, { recursive: true, force: true }));
  const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
  const repo = path.join(folder, 'repo');
  fs.mkdirSync(repo);
  const ID = ['-c', 'user.name=queue-test', '-c', 'user.email=queue-test@example.invalid'];
  const g = (args: string[]) => execFileSync('git', ['-C', repo, ...ID, ...args], { stdio: 'ignore' });
  g(['init', '-q', '-b', 'main']);
  g(['commit', '-q', '--allow-empty', '-m', 'start']);
  fs.writeFileSync(path.join(folder, 'queue.json'), JSON.stringify({ created: ago(10), limits: {}, resolved: [], tasks: [] }));
  const configFile = path.join(folder, 'queue.config.json');
  fs.writeFileSync(configFile, '{}');
  const run = (...args: string[]) => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'orchestrator', 'queue.mjs'), ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        QUEUE_FOLDER: folder,
        QUEUE_CONFIG: configFile,
        QUEUE_ROOT: folder,
        QUEUE_GIT: repo,
        QUEUE_TIME_LOG: path.join(folder, 'times.jsonl'),
        QUEUE_TRANSCRIPTS: path.join(folder, 'transcripts'),
      },
    });
    return { code: r.status, out: r.stdout ?? '', error: r.stderr ?? '' };
  };

  it('show refuses --json and says where JSON is, in both views', () => {
    for (const args of [['show', '--json'], ['show', '--full', '--json']]) {
      const r = run(...args);
      expect(r.code).toBe(1);
      expect(r.error).toContain('show has no --json');
      expect(r.out).toBe('');
    }
    expect(run('show').code).toBe(0);
  });

  it('edit on an unknown id says so, whatever flags it was given', () => {
    expect(run('edit', 'NOPE').error).toContain('Unknown task NOPE');
    expect(run('edit', 'NOPE', '--mistyped', 'x').error).toContain('Unknown task NOPE');
  });

  it('show has a setup line when setup.json records an older version', () => {
    fs.writeFileSync(path.join(folder, 'setup.json'), JSON.stringify({ pluginVersion: '0.0.1' }));
    expect(run('show').out).toContain('the project was set up for ravenseat 0.0.1. Run: ravenseat setup --settings');
    fs.rmSync(path.join(folder, 'setup.json'));
    expect(run('show').out).not.toContain('Setup is behind');
  });
});
