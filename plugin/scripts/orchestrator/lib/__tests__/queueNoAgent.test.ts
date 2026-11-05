// =============================================================
// queueNoAgent.test.ts: tracks marked running that no agent works on ("STARTED WITHOUT AGENT").
//
// Why: `fill` and `start` only mark a track running; the orchestrator starts the agent from the "Start these" lines.
// When fill ran where nobody read the output (a merge in the background, a script chaining merges), tracks stood
// "running" for hours without an agent and the queue stalled with no error. The rule is enforced in
// queueLogic.startedWithoutAgent (pure) and shown by queue.mjs show/state/pulse, so both are tested here: the pure
// function, and queue.mjs against a temporary git repo with a real worktree (never the main repo or the real queue).
// =============================================================
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type Task = Record<string, unknown> & { id: string; status: string };
type Hit = { id: string; branch: string; migr_block: string | null; age_ms: number };

const L = require('../queueLogic') as {
  startedWithoutAgent: (
    queue: { tasks: Task[] },
    option?: {
      worktreeBranches?: Set<string>;
      hasReport?: (o: Task) => boolean;
      now?: number;
      graceMin?: number;
    },
  ) => Hit[];
  withoutAgentLines: (list: Hit[]) => string[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  reservedWithoutAgent: (queue: { tasks: Task[] }, option?: any) => (Hit & { prepared?: boolean; round?: number; reason?: string })[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  noAgentTracks: (queue: { tasks: Task[] }, option?: any) => (Hit & { prepared?: boolean })[];
  reportSinceStart: (o: Task, report: { mtimeMs: number } | null) => boolean;
  waitingOnCancelled: (queue: { tasks: Task[] }) => { id: string; dep: string }[];
  waitingOnCancelledLines: (list: { id: string; dep: string }[]) => string[];
  fillExcerpt: (out: string) => string[];
  NO_AGENT_GRACE_MIN: number;
  SILENT_CARD_MIN: number;
};

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const ID = ['-c', 'user.name=queue-test', '-c', 'user.email=queue-test@example.invalid'];
const temporary: string[] = [];
afterAll(() => {
  for (const m of temporary) fs.rmSync(m, { recursive: true, force: true });
});

const NOW = Date.parse('2026-10-31T10:00:00.000Z');
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const running = (id: string, extra: Partial<Task> = {}): Task => ({
  id,
  status: 'running',
  class: 'K',
  branch: `queue/${id}`,
  started: ago(60),
  ...extra,
});

describe('startedWithoutAgent (pure)', () => {
  it('finds a running track older than the grace time with no worktree and no report', () => {
    const hits = L.startedWithoutAgent(
      { tasks: [running('A', { migr_block: '3600-3609' })] },
      { worktreeBranches: new Set(), now: NOW },
    );
    expect(hits).toEqual([{ id: 'A', branch: 'queue/A', migr_block: '3600-3609', age_ms: 60 * 60_000 }]);
  });

  it('leaves out a track whose branch is checked out in a worktree (the agent ran prepare-track)', () => {
    const hits = L.startedWithoutAgent(
      { tasks: [running('A')] },
      { worktreeBranches: new Set(['queue/A']), now: NOW },
    );
    expect(hits).toEqual([]);
  });

  it('gives a newly started track the grace time (the agent has not reached prepare-track yet)', () => {
    const fresh = running('A', { started: ago(L.NO_AGENT_GRACE_MIN - 1) });
    expect(L.startedWithoutAgent({ tasks: [fresh] }, { now: NOW })).toEqual([]);
    const late = running('A', { started: ago(L.NO_AGENT_GRACE_MIN) });
    expect(L.startedWithoutAgent({ tasks: [late] }, { now: NOW })).toHaveLength(1);
  });

  it('leaves out a delivered track (track-result.md exists, the worktree may be gone)', () => {
    const hits = L.startedWithoutAgent(
      { tasks: [running('A')] },
      { hasReport: (o) => o.id === 'A', now: NOW },
    );
    expect(hits).toEqual([]);
  });

  it('only looks at running tracks: picked, cloud, review, waiting and done are left out', () => {
    const tasks = [
      running('P', { picked_by: 'owner' }),
      running('C', { cloud: { started: ago(60) } }),
      running('R', { status: 'review' }),
      running('W', { status: 'waiting' }),
      running('D', { status: 'done' }),
      running('X', { started: 'not a date' }),
      running('N', { branch: undefined }),
    ];
    expect(L.startedWithoutAgent({ tasks }, { now: NOW })).toEqual([]);
  });

  it('the warning says what to do and names each track; nothing when all is well', () => {
    expect(L.withoutAgentLines([])).toEqual([]);
    const lines = L.withoutAgentLines(
      L.startedWithoutAgent({ tasks: [running('A'), running('B')] }, { now: NOW }),
    );
    expect(lines[0]).toMatch(/^STARTED WITHOUT AGENT \(2\)/);
    expect(lines[0]).toContain('cq set <id> waiting');
    expect(lines[0]).toContain('fill --ids <id>');
    expect(lines.slice(1).map((l) => l.trim().split(/\s+/)[0])).toEqual(['A', 'B']);
  });
});

// A prepared round on a task the old worktree may still hold. The agent's start row is what turns it into running.
const HOOKS = { sandbox: false, network: 'hook', hooks: true };
const prepared = (id: string, extra: Partial<Task> = {}): Task =>
  running(id, {
    status: 'review',
    started: ago(120),
    resumed: [{ round: 1, reason: 'context', time: ago(30) }],
    attempts: [
      { id: 'a1', round: 0, state: 'ended', reserved: ago(120), ended: ago(60), guard: HOOKS },
      { id: 'a2', round: 1, state: 'reserved', reserved: ago(30), guard: HOOKS },
    ],
    ...extra,
  });
// An older agent, on another task: the proof that the start hook works in this project.
const HOOK_WORKS = [
  { time: ago(200), track: 'OLD', event: 'start', agent_id: 'x1', agent_type: 'track' },
  { time: ago(190), track: 'OLD', event: 'done', agent_id: 'x1', agent_type: 'track' },
];

describe('reservedWithoutAgent: an attempt no agent took (test report R1)', () => {
  it('finds a prepared round with no start row, whatever the old worktree does and whichever the reason', () => {
    for (const reason of ['context', 'fix']) {
      const o = prepared('G7', { resumed: [{ round: 1, reason, time: ago(30) }] });
      const hits = L.reservedWithoutAgent({ tasks: [o] }, { rows: HOOK_WORKS, now: NOW });
      expect(hits).toMatchObject([{ id: 'G7', prepared: true, round: 1, reason, age_ms: 30 * 60_000 }]);
      // The old worktree holds the branch: noAgentTracks still sees it.
      const both = L.noAgentTracks({ tasks: [o] }, { worktreeBranches: new Set(['queue/G7']), rows: HOOK_WORKS, now: NOW });
      expect(both.map((x) => x.id)).toEqual(['G7']);
    }
  });

  it('is quiet when an agent took the round: its start row, an unlabelled start, a commit or a report', () => {
    const o = prepared('G7');
    const tasks = { tasks: [o] };
    const label = (r: number) => (r ? `G7-r${r}` : 'G7');
    const live = [...HOOK_WORKS, { time: ago(20), track: label(1), event: 'start', agent_id: 'a9', agent_type: 'track' }];
    expect(L.reservedWithoutAgent(tasks, { rows: live, now: NOW })).toEqual([]);
    const unlabelled = [...HOOK_WORKS, { time: ago(20), track: null, event: 'start', agent_id: 'a9', agent_type: 'track' }];
    expect(L.reservedWithoutAgent(tasks, { rows: unlabelled, now: NOW })).toEqual([]);
    expect(L.reservedWithoutAgent(tasks, { rows: HOOK_WORKS, now: NOW, lastCommitMs: () => Date.parse(ago(5)) })).toEqual([]);
    expect(L.reservedWithoutAgent(tasks, { rows: HOOK_WORKS, now: NOW, reportOf: () => ({ mtimeMs: Date.parse(ago(5)) }) })).toEqual([]);
    // The ones from before the reservation say nothing about this round.
    expect(L.reservedWithoutAgent(tasks, { rows: HOOK_WORKS, now: NOW, lastCommitMs: () => Date.parse(ago(90)) })).toHaveLength(1);
    expect(L.reservedWithoutAgent(tasks, { rows: HOOK_WORKS, now: NOW, reportOf: () => ({ mtimeMs: Date.parse(ago(90)) }) })).toHaveLength(1);
  });

  it('is quiet in the grace time, for a task waiting for review, and on what it cannot judge', () => {
    const fresh = prepared('A', { attempts: [{ id: 'a2', round: 1, state: 'reserved', reserved: ago(L.NO_AGENT_GRACE_MIN - 1), guard: HOOKS }] });
    const ended = prepared('B', { attempts: [{ id: 'a1', round: 0, state: 'ended', reserved: ago(120), ended: ago(60), guard: HOOKS }] });
    const noHooks = prepared('C', { attempts: [{ id: 'a2', round: 1, state: 'reserved', reserved: ago(30), guard: { hooks: false } }] });
    const picked = prepared('D', { picked_by: 'owner' });
    const tasks = { tasks: [fresh, ended, noHooks, picked] };
    expect(L.reservedWithoutAgent(tasks, { rows: HOOK_WORKS, now: NOW })).toEqual([]);
    // The hook is off or broken: no start row at all, so no reservation can be judged.
    expect(L.reservedWithoutAgent({ tasks: [prepared('G7')] }, { rows: [], now: NOW })).toEqual([]);
  });

  it('a first start held by an old worktree is not prepared: it goes back in the queue, not through resume', () => {
    const o = running('G1', { attempts: [{ id: 'a1', round: 0, state: 'reserved', reserved: ago(30), guard: HOOKS }] });
    const [hit] = L.noAgentTracks({ tasks: [o] }, { worktreeBranches: new Set(['queue/G1']), rows: HOOK_WORKS, now: NOW });
    expect(hit.id).toBe('G1');
    expect(hit.prepared).toBeUndefined();
    expect(L.withoutAgentLines([hit])[0]).toMatch(/^STARTED WITHOUT AGENT \(1\)/);
  });

  it('reads the log only when a candidate exists, and lists a task once', () => {
    let reads = 0;
    const rows = () => (reads++, HOOK_WORKS);
    L.noAgentTracks({ tasks: [running('Z', { started: ago(1) })] }, { worktreeBranches: new Set(), rows, now: NOW });
    expect(reads).toBe(0);
    const o = running('G1', { attempts: [{ id: 'a1', round: 0, state: 'reserved', reserved: ago(30), guard: HOOKS }] });
    expect(L.noAgentTracks({ tasks: [o] }, { worktreeBranches: new Set(), rows, now: NOW })).toHaveLength(1);
  });

  it('the round warning gives the command that makes the same round again', () => {
    const lines = L.withoutAgentLines(L.reservedWithoutAgent({ tasks: [prepared('G7')] }, { rows: HOOK_WORKS, now: NOW }));
    expect(lines[0]).toMatch(/^ROUND WITHOUT AGENT \(1\)/);
    expect(lines[1]).toContain('cq resume G7 --reason context');
  });
});

describe('a report from before the start (test report R2)', () => {
  it('turns no warning off; one from this start does', () => {
    const o = running('A');
    const old = { mtimeMs: Date.parse(ago(90)) };
    const fresh = { mtimeMs: Date.parse(ago(5)) };
    expect(L.reportSinceStart(o, old)).toBe(false);
    expect(L.reportSinceStart(o, fresh)).toBe(true);
    expect(L.reportSinceStart(o, null)).toBe(false);
    const q = { tasks: [o] };
    expect(L.noAgentTracks(q, { worktreeBranches: new Set(), reportOf: () => old, now: NOW })).toHaveLength(1);
    expect(L.noAgentTracks(q, { worktreeBranches: new Set(), reportOf: () => fresh, now: NOW })).toEqual([]);
  });
});

describe('waiting on a cancelled task (test report R7)', () => {
  it('names the waiting task and what it waits on', () => {
    const tasks = [
      running('F9', { status: 'cancelled' }),
      running('F10', { status: 'waiting', depends_on: ['F9', 'F8'] }),
      running('F8', { status: 'waiting' }),
      running('F11', { status: 'running', depends_on: ['F9'] }),
    ];
    const list = L.waitingOnCancelled({ tasks });
    expect(list).toEqual([{ id: 'F10', dep: 'F9' }]);
    expect(L.waitingOnCancelledLines(list)[1]).toContain('F10  waits on F9');
    expect(L.waitingOnCancelledLines([])).toEqual([]);
  });
});

describe('the cards in cq decide (test report R1, R4)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const T = require('../queueBoard.js') as { board: (q: unknown, o?: unknown) => any };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const D = require('../queueDecisions.js') as { decisions: (inbox: unknown) => any[] };
  const cards = (tasks: Task[], option: Record<string, unknown>) =>
    D.decisions(T.board({ tasks, limits: {} }, { now: NOW, ...option }).inbox);
  const silent = (min: number) => [{ id: 'A', branch: 'queue/A', silent_ms: min * 60_000 }];

  it('a prepared round gets a card that only says what the orchestrator does', () => {
    const [card] = cards([prepared('G7')], {
      withoutAgent: [{ id: 'G7', branch: 'queue/G7', prepared: true, round: 1, reason: 'context' }],
    });
    expect(card).toMatchObject({ kind: 'stuck-no-agent', id: 'G7' });
    expect(card.context.join(' ')).toContain('cq resume G7 --reason context');
    expect(card.options.map((x: { label: string }) => x.label)).toEqual(['Seen']);
  });

  it('a first start keeps the existing card with its choices', () => {
    const [card] = cards([running('A')], { withoutAgent: [{ id: 'A', branch: 'queue/A' }] });
    expect(card.kind).toBe('stuck-no-agent');
    expect(card.options.length).toBeGreaterThan(1);
  });

  it('a short silence stays off the cards, a long one gets one, and it goes when the track lives again', () => {
    expect(cards([running('A')], { silent: silent(30) })).toEqual([]);
    const [card] = cards([running('A')], { silent: silent(L.SILENT_CARD_MIN) });
    expect(card).toMatchObject({ kind: 'stuck-silent', id: 'A', kindName: 'Silent' });
    expect(card.options.map((x: { label: string }) => x.label)).toEqual(['Seen', 'Put it back in the queue']);
    expect(cards([running('A')], { silent: [] })).toEqual([]);
  });
});

describe('fillExcerpt in merge', () => {
  it('ends with the note that the tracks are only marked and that merge must not run unread', () => {
    const out = ['something', 'FILLED 1 track(s)', 'A: running', 'Start these in the SAME turn:', '  track A'].join(
      '\n',
    );
    const lines = L.fillExcerpt(out);
    expect(lines[0]).toBe('fill: FILLED 1 track(s)');
    expect(lines.at(-1)).toMatch(/only marked running/);
    expect(lines.at(-1)).toContain('--without-fill');
  });

  it('no note when nothing was filled', () => {
    expect(L.fillExcerpt('Nothing can be started now')).toEqual(['fill: Nothing can be started now']);
  });
});

describe('queue.mjs show, state and pulse warn (against a temporary repo)', () => {
  it('warns about a running track without a worktree, and stops warning once a worktree has the branch', () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-noagent-'));
    temporary.push(folder);
    const repo = path.join(folder, 'repo');
    fs.mkdirSync(repo);
    const g = (args: string[]) =>
      execFileSync('git', ['-C', repo, ...ID, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    g(['init', '-q', '-b', 'main']);
    fs.writeFileSync(path.join(repo, 'README.md'), 'start\n');
    g(['add', '--', 'README.md']);
    g(['commit', '-q', '-m', 'start']);
    const old = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    fs.writeFileSync(
      path.join(folder, 'queue.json'),
      JSON.stringify({
        created: old,
        limits: {},
        next_migr: 3600,
        resolved: [],
        tasks: [
          {
            id: 'A',
            title: 'Task A',
            domain: 'dom-a',
            class: 'K',
            status: 'running',
            branch: 'queue/A',
            started: old,
            value: 5,
            content_min: 60,
            migr_tens: 0,
            depends_on: [],
            waiting_on: [],
            owned_files: ['lib/A.ts'],
          },
        ],
      }),
    );
    const configFile = path.join(folder, 'queue.config.json');
    fs.writeFileSync(configFile, JSON.stringify({}));
    const env = {
      ...process.env,
      QUEUE_FOLDER: folder,
      QUEUE_CONFIG: configFile,
      QUEUE_ROOT: folder,
      QUEUE_GIT: repo,
      QUEUE_TIME_LOG: path.join(folder, 'times.jsonl'),
      QUEUE_TRANSCRIPTS: path.join(folder, 'transcripts'),
    };
    const run = (...args: string[]) => {
      const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'orchestrator', 'queue.mjs'), ...args], {
        encoding: 'utf8',
        env,
      });
      return { code: r.status, out: r.stdout ?? '', error: r.stderr ?? '' };
    };

    const show = run('show');
    expect(show.error).toBe('');
    // First in the output, so the after-compact hook's trimming never cuts it.
    expect(show.out.split('\n')[0]).toMatch(/^STARTED WITHOUT AGENT \(1\)/);
    expect(show.out).toMatch(/^\s+A\s+queue\/A\s+running for/m);
    expect(run('show', '--full').out.split('\n')[0]).toMatch(/^STARTED WITHOUT AGENT \(1\)/);
    const state = JSON.parse(run('state').out) as { withoutAgent: Hit[] };
    expect(state.withoutAgent.map((x) => x.id)).toEqual(['A']);
    expect(run('orchestrator', 'pulse', '--session', 'test').out).toContain('STARTED WITHOUT AGENT (1)');

    // The agent has run prepare-track: its worktree has the branch checked out.
    g(['worktree', 'add', '-q', '-b', 'queue/A', path.join(folder, 'wt-A')]);
    expect(run('show').out).not.toContain('STARTED WITHOUT AGENT');
    expect((JSON.parse(run('state').out) as { withoutAgent: Hit[] }).withoutAgent).toEqual([]);
  });
});
