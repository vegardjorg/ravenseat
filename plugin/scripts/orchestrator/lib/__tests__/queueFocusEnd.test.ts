// =============================================================
// queueFocusEnd.test.ts: what the queue does when a focus has run out (every stage done) or its period is over.
//
// The setting `focus.continueWhenEmpty` in queue.config.json (default off), with a per-focus override
// `focus.continue_when_empty` (cq focus set ... --continue-when-empty on|off). Off: the queue is paused (fill starts
// nothing), the focus gets `finished_at`, and ONE owner question "Focus X is done: set a new focus or continue the
// regular queue?" is registered (shown in "Waiting on you"); the answer "Continue the regular queue" lifts the pause.
// On: the queue continues as before, with one informational line. A project that never set a focus is unaffected.
// Pure logic through lib/queueLogic.js, plus the CLI (queue.mjs focus, set, fill against a copy in a temporary folder).
// =============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

type Task = {
  id: string;
  title?: string;
  domain: string;
  class: 'K' | 'D' | 'D+' | 'U';
  status: string;
  mission?: string;
  value?: number;
  project?: string;
  qa_status?: string;
};
type Focus = {
  name?: string;
  from?: string;
  to?: string | null;
  order: string[];
  rest?: string;
  continue_when_empty?: boolean;
  finished_at?: string | null;
  history?: unknown[];
};
type Question = { type: string; text: string; choices?: string[]; source?: string };
type Queue = {
  tasks: Task[];
  resolved?: string[];
  resolutions?: Record<string, { answer: string | null }>;
  question?: Record<string, Question>;
  limits?: Record<string, number | boolean | string | null>;
  projects?: Record<string, { title: string; prefixes?: string[] }>;
  focus?: Focus;
  next_migr?: number;
  changelog?: unknown[];
};
type End = {
  state: 'none' | 'active' | 'paused' | 'continuing';
  reason: 'done' | 'expired' | null;
  question: string | null;
  created: boolean;
  source: 'focus' | 'config' | 'answer' | null;
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const L = require('../queueLogic') as {
  selectNext: (queue: Queue, now?: number) => { id: string }[];
  pickable: (queue: Queue, filter?: Record<string, unknown>, now?: number) => { id: string }[];
  rankingContext: (queue: Queue, now?: number) => { finished: boolean; halted: boolean; ended: boolean };
  focusStatus: (queue: Queue, option?: { now?: number }) => { notice: string | null; halted?: boolean } | null;
  cleanFocus: (
    queue: Queue,
    option?: { by?: string; now?: string; dry?: boolean },
  ) => { end?: End; kept: unknown };
  focusCleanLines: (r: unknown) => string[];
  focusEnd: (queue: Queue, now?: number) => End;
  syncFocusEnd: (queue: Queue, option?: { now?: string }) => End;
  focusEndQuestionId: (focus: Focus) => string;
  FOCUS_END_CHOICES: string[];
  setFocus: (queue: Queue, input: Record<string, unknown>, now?: string) => { error: string[]; focus?: Focus };
  removeFocus: (queue: Queue) => unknown;
  resolve: (queue: Queue, ids: string[], option?: { choice?: string; by?: string }) => { error: string[] };
};

const NOW = Date.parse('2026-10-07T12:00:00Z');
const ISO = '2026-10-07T12:00:00.000Z';
const t = (id: string, extra: Partial<Task> = {}): Task => ({
  id,
  domain: id.toLowerCase(),
  class: 'K',
  status: 'waiting',
  mission: 'x',
  title: id,
  ...extra,
});
const ids = (queue: Queue) => L.selectNext(queue, NOW).map((v) => v.id);

/** One finished stage (warehouse: SB-1 done) and two waiting tasks outside it. */
const finishedQueue = (focus: Partial<Focus> = {}): Queue => ({
  projects: {
    warehouse: { title: 'Warehouse', prefixes: ['SB-'] },
    tool: { title: 'Tool', prefixes: ['VK-'] },
  },
  limits: { maxConcurrent: 10, maxDPlus: 4, maxPerDomain: 7, maxDb: 6 },
  tasks: [t('SB-1', { status: 'done' }), t('VK-1', { value: 9 }), t('VK-2')],
  focus: { name: 'Goods', from: ISO, to: null, order: ['project:warehouse'], rest: 'fill', ...focus },
});

describe('a finished focus pauses the queue by default (continueWhenEmpty off)', () => {
  it('rest fill: an emptied focus no longer fills the queue with the rest', () => {
    const queue = finishedQueue();
    expect(L.rankingContext(queue, NOW).finished).toBe(true);
    expect(ids(queue)).toEqual([]);
  });

  it('rest wait: still nothing starts', () => {
    expect(ids(finishedQueue({ rest: 'wait' }))).toEqual([]);
  });

  it('an expired focus period pauses the queue as well', () => {
    const queue = finishedQueue({ to: '2026-10-01T00:00:00Z' });
    queue.tasks[0].status = 'waiting';
    expect(L.rankingContext(queue, NOW).ended).toBe(true);
    expect(ids(queue)).toEqual([]);
    expect(L.focusStatus(queue, { now: NOW })?.notice).toMatch(/is over.*paused/);
  });

  it('a project that never set a focus is unaffected', () => {
    const queue = finishedQueue();
    delete queue.focus;
    expect(ids(queue)).toEqual(['VK-1', 'VK-2']);
  });

  it('a focus with work left is unaffected', () => {
    const queue = finishedQueue();
    queue.tasks[0].status = 'waiting';
    expect(L.rankingContext(queue, NOW).finished).toBe(false);
    expect(ids(queue)).toEqual(['SB-1', 'VK-1', 'VK-2']);
  });

  it('a stage that is done with rests (QA waiting) is not finished', () => {
    const queue = finishedQueue();
    queue.tasks[0].qa_status = 'waiting';
    expect(L.rankingContext(queue, NOW).finished).toBe(false);
  });

  it('the notice says the focus is done, the queue is paused, and how to continue', () => {
    const n = L.focusStatus(finishedQueue(), { now: NOW })?.notice ?? '';
    expect(n).toMatch(/Focus "Goods" is done/);
    expect(n).toMatch(/paused/);
    expect(n).toMatch(/cq focus set/);
    expect(n).toMatch(/continueWhenEmpty/);
  });

  it('picking by hand still works (a manual choice, like a paused project)', () => {
    expect(L.pickable(finishedQueue(), {}, NOW).map((p) => p.id)).toContain('VK-1');
  });
});

describe('the record and the owner question', () => {
  it('syncFocusEnd stamps finished_at and registers ONE question with choices; again is a no-op', () => {
    const queue = finishedQueue();
    const e = L.syncFocusEnd(queue, { now: ISO });
    expect(e.state).toBe('paused');
    expect(e.reason).toBe('done');
    expect(e.created).toBe(true);
    expect(queue.focus!.finished_at).toBe(ISO);
    const id = L.focusEndQuestionId(queue.focus!);
    expect(e.question).toBe(id);
    const q = queue.question![id];
    expect(q.text).toMatch(/Focus "Goods" is done: set a new focus or continue the regular queue\?/);
    expect(q.choices).toEqual(L.FOCUS_END_CHOICES);
    const again = L.syncFocusEnd(queue, { now: '2026-10-07T13:00:00.000Z' });
    expect(again.created).toBe(false);
    expect(Object.keys(queue.question!)).toEqual([id]);
    expect(queue.focus!.finished_at).toBe(ISO);
  });

  it('cleanFocus (fill, receive, set) runs the sync and its lines say paused', () => {
    const queue = finishedQueue();
    const r = L.cleanFocus(queue, { by: 'test', now: ISO });
    expect(r.end?.state).toBe('paused');
    const lines = L.focusCleanLines(r).join('\n');
    expect(lines).toMatch(/queue paused/i);
    expect(lines).toMatch(/cq focus set/);
    expect(Object.keys(queue.question ?? {})).toHaveLength(1);
    L.cleanFocus(queue, { by: 'test', now: ISO });
    expect(Object.keys(queue.question ?? {})).toHaveLength(1);
  });

  it('dry cleanFocus changes nothing', () => {
    const queue = finishedQueue();
    const before = JSON.stringify(queue);
    expect(L.cleanFocus(queue, { by: 'test', now: ISO, dry: true }).end?.state).toBe('paused');
    expect(JSON.stringify(queue)).toBe(before);
  });

  it('answering "Continue the regular queue" lifts the pause', () => {
    const queue = finishedQueue();
    const e = L.syncFocusEnd(queue, { now: ISO });
    expect(L.resolve(queue, [e.question!], { choice: '2', by: 'owner' }).error).toEqual([]);
    expect(ids(queue)).toEqual(['VK-1', 'VK-2']);
    expect(L.focusEnd(queue, NOW).source).toBe('answer');
  });

  it('answering "Set a new focus" keeps the pause until a focus is set', () => {
    const queue = finishedQueue();
    const e = L.syncFocusEnd(queue, { now: ISO });
    L.resolve(queue, [e.question!], { choice: '1', by: 'owner' });
    expect(ids(queue)).toEqual([]);
    expect(L.syncFocusEnd(queue, { now: ISO }).created).toBe(false);
    expect(L.setFocus(queue, { order: ['project:tool'] }, ISO).error).toEqual([]);
    expect(queue.focus!.finished_at).toBeUndefined();
    expect(ids(queue)).toEqual(['VK-1', 'VK-2']);
  });

  it('new work in the stage: the stamp and the open question go away', () => {
    const queue = finishedQueue();
    L.syncFocusEnd(queue, { now: ISO });
    queue.tasks.push(t('SB-2'));
    const e = L.syncFocusEnd(queue, { now: ISO });
    expect(e.state).toBe('active');
    expect(queue.focus!.finished_at ?? null).toBeNull();
    expect(Object.keys(queue.question ?? {})).toEqual([]);
  });

  it('a new focus or focus off drops the open question of the old one', () => {
    const queue = finishedQueue();
    L.syncFocusEnd(queue, { now: ISO });
    L.removeFocus(queue);
    expect(Object.keys(queue.question ?? {})).toEqual([]);
    const q2 = finishedQueue();
    L.syncFocusEnd(q2, { now: ISO });
    L.setFocus(q2, { order: ['project:tool'] }, '2026-10-08T00:00:00.000Z');
    expect(Object.keys(q2.question ?? {})).toEqual([]);
  });
});

describe('continueWhenEmpty on (per-focus override)', () => {
  it('the queue continues as before, no question, one informational line', () => {
    const queue = finishedQueue({ continue_when_empty: true });
    expect(ids(queue)).toEqual(['VK-1', 'VK-2']);
    const r = L.cleanFocus(queue, { by: 'test', now: ISO });
    expect(r.end?.state).toBe('continuing');
    expect(queue.question).toBeUndefined();
    expect(queue.focus!.finished_at).toBe(ISO);
    const lines = L.focusCleanLines(r).filter((l) => /continu/i.test(l));
    expect(lines).toHaveLength(1);
  });

  it('expired with the override on: ranked as without focus (the old behavior)', () => {
    const queue = finishedQueue({ to: '2026-10-01T00:00:00Z', continue_when_empty: true });
    queue.tasks[0].status = 'waiting';
    expect(ids(queue)).toEqual(['VK-1', 'SB-1', 'VK-2']);
  });

  it('setFocus takes continue_when_empty and validates it', () => {
    const queue = finishedQueue();
    expect(L.setFocus(queue, { order: ['project:tool'], continue_when_empty: true }, ISO).focus?.continue_when_empty).toBe(true);
    expect(L.setFocus(queue, { order: ['project:tool'], continue_when_empty: 'yes' }, ISO).error.join()).toMatch(
      /continue_when_empty/,
    );
  });
});

describe('queue.mjs: config key, cq focus output and set (against a copy)', () => {
  const QUEUE_MJS = join(__dirname, '..', '..', 'queue.mjs');
  let folder: string;
  let configFile: string | null = null;
  function run(args: string[]): { code: number; out: string; error: string } {
    try {
      const out = execFileSync(process.execPath, [QUEUE_MJS, ...args], {
        env: {
          ...process.env,
          QUEUE_FOLDER: folder,
          QUEUE_GIT: folder,
          QUEUE_TIME_LOG: join(folder, 'times.jsonl'),
          ...(configFile ? { QUEUE_CONFIG: configFile } : {}),
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { code: 0, out, error: '' };
    } catch (e) {
      const x = e as { status: number; stdout: string; stderr: string };
      return { code: x.status, out: x.stdout ?? '', error: x.stderr ?? '' };
    }
  }
  const readQueue = (): Queue => JSON.parse(readFileSync(join(folder, 'queue.json'), 'utf8')) as Queue;

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'queue-focus-end-'));
    const queue = finishedQueue();
    queue.tasks[0].status = 'running';
    writeFileSync(join(folder, 'queue.json'), JSON.stringify({ ...queue, next_migr: 1000 }, null, 2));
    configFile = null;
  });
  afterEach(() => rmSync(folder, { recursive: true, force: true }));

  it('set <id> done empties the focus: paused line and one question; cq focus shows the setting', () => {
    const s = run(['set', 'SB-1', 'done', '--without-cost']);
    expect(s.code).toBe(0);
    expect(s.out).toMatch(/Focus "Goods" is done: queue paused/);
    const q = readQueue();
    expect(q.focus!.finished_at).toBeTruthy();
    expect(Object.keys(q.question ?? {})).toHaveLength(1);
    const f = run(['focus']);
    expect(f.out).toMatch(/continue when empty: off \(config focus\.continueWhenEmpty\)/);
    expect(f.out).toMatch(/FINISHED/);
    expect(run(['next']).out).toMatch(/Nothing can start now/);
  });

  it('config focus.continueWhenEmpty true: continues, with the informational line', () => {
    configFile = join(folder, 'queue.config.json');
    writeFileSync(configFile, JSON.stringify({ focus: { continueWhenEmpty: true } }));
    const s = run(['set', 'SB-1', 'done', '--without-cost']);
    expect(s.out).toMatch(/continuing the regular queue/);
    expect(readQueue().question).toBeUndefined();
    expect(run(['focus']).out).toMatch(/continue when empty: on \(config focus\.continueWhenEmpty\)/);
    expect(run(['next']).out).toMatch(/VK-1/);
  });

  it('focus set --continue-when-empty on|off sets the per-focus override', () => {
    expect(run(['focus', 'set', 'project:tool', '--continue-when-empty', 'on']).code).toBe(0);
    expect(readQueue().focus!.continue_when_empty).toBe(true);
    expect(run(['focus']).out).toMatch(/continue when empty: on \(this focus\)/);
    expect(run(['focus', 'set', 'project:tool', '--continue-when-empty', 'maybe']).code).toBe(1);
  });
});
