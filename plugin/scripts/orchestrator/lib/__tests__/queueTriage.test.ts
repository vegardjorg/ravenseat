// =============================================================
// queueTriage.test.ts: the intake triage (lib/queueTriage.js, cli/triage.mjs, the triage part of fill, start, resolve).
//
// An old or agent-added task gets a cheap read-only check before a full track starts on it. The tests lock the rule
// where it is enforced: the pure functions (when a verdict is needed, what each verdict does, the owner's choice), the
// helper framework (triage is a helper with a switch and a measurement, never a reviewer), and queue.mjs against a copy
// of the queue in a temporary folder (fill skips the untriaged task and starts the others, the verdicts, config off).
// =============================================================
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* eslint-disable @typescript-eslint/no-require-imports */
const T = require('../queueTriage.js');
const H = require('../queueHelpers.js');
const K = require('../queueConfig.js');
/* eslint-enable @typescript-eslint/no-require-imports */

type Task = Record<string, unknown> & { id: string; status: string };
type Queue = { tasks: Task[]; resolved?: string[]; question?: Record<string, Record<string, unknown>>; [k: string]: unknown };

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-01T12:00:00.000Z');
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();
const conf = (own: Record<string, unknown> = {}) => K.merge(K.STANDARD, own);
const task = (id: string, extra: Record<string, unknown> = {}): Task => ({
  id,
  title: `Task ${id}`,
  domain: `dom-${id}`,
  class: 'K',
  status: 'waiting',
  mission: `The mission for ${id}.`,
  value: 5,
  content_min: 30,
  added_at: ago(0),
  ...extra,
});
const setupFor = (queue: Queue | null = null, own: Record<string, unknown> = {}) => T.triageSetup(conf(own), queue);
const need = (o: Task, queue: Queue, own: Record<string, unknown> = {}, now = NOW) =>
  T.needsTriage(o, queue, { now, setup: setupFor(queue, own) });

describe('when a task needs a triage verdict (needsTriage)', () => {
  it('a task added minAgeDays (3) ago or more needs one; a newer one does not', () => {
    const q: Queue = { tasks: [task('OLD', { added_at: ago(4) }), task('EDGE', { added_at: ago(3) }), task('NEW', { added_at: ago(1) })] };
    expect(need(q.tasks[0], q)).toEqual({ need: true, reason: 'added or last edited 4 days ago' });
    expect(need(q.tasks[1], q).need).toBe(true);
    expect(need(q.tasks[2], q)).toEqual({ need: false, reason: null });
  });

  it('a content edit (the changelog) resets the age; a rank change does not', () => {
    const o = task('A', { added_at: ago(10) });
    const edited: Queue = { tasks: [o], changelog: [{ nr: 1, at: ago(1), by: 'x', action: 'edit', changes: [{ id: 'A', field: 'mission' }] }] };
    expect(need(o, edited).need).toBe(false);
    const ranked: Queue = { tasks: [o], changelog: [{ nr: 1, at: ago(1), by: 'x', action: 'rank', changes: [{ id: 'A', field: 'rank' }] }] };
    expect(need(o, ranked).need).toBe(true);
    // A newer mission file counts as an edit too (the caller passes its mtime).
    expect(T.needsTriage(o, { tasks: [o] }, { now: NOW, setup: setupFor(), missionMtimeMs: NOW - DAY }).need).toBe(false);
  });

  it('an agent-added task needs one once, whatever its age (a proposal that was approved, or added_by an agent)', () => {
    const tracks = task('X-1', { status: 'done' });
    const byAgent = task('P', { added_by: 'X-1' });
    const approved = task('Q', { approved: ago(0), added_by: 'owner' });
    const q: Queue = { tasks: [tracks, byAgent, approved] };
    expect(need(byAgent, q).reason).toBe('added by an agent (X-1)');
    expect(need(approved, q).reason).toBe('added by an agent (approved proposal)');
    // agentAdded false turns that part off.
    expect(need(byAgent, q, { triage: { agentAdded: false } }).need).toBe(false);
    // Once triaged, it is not asked again for being agent-added.
    expect(need({ ...byAgent, triage: { verdict: 'ready', at: ago(0) } }, q).need).toBe(false);
  });

  it('never for fix tasks or continuations (fixes, a branch, started before, resumed)', () => {
    const q: Queue = { tasks: [] };
    for (const extra of [{ fixes: ['B'] }, { branch: 'queue/A' }, { started: ago(5) }, { resumed: [{ round: 1 }] }])
      expect(need(task('A', { added_at: ago(30), ...extra }), q).need).toBe(false);
    // Only waiting tasks.
    expect(need(task('A', { added_at: ago(30), status: 'proposed' }), q).need).toBe(false);
  });

  it('a verdict newer than the last edit holds until it is itself minAgeDays old; an edit after it asks again', () => {
    const o = task('A', { added_at: ago(10), triage: { verdict: 'ready', at: ago(1) } });
    expect(need(o, { tasks: [o] }).need).toBe(false);
    const oldVerdict = task('A', { added_at: ago(10), triage: { verdict: 'ready', at: ago(5) } });
    expect(need(oldVerdict, { tasks: [oldVerdict] }).reason).toBe('the last verdict (ready) is 5 days ago'.replace('days ago', 'days old'));
    // An edit after the verdict: the age counts from the edit (1 day), so no verdict is needed by age.
    const after: Queue = { tasks: [o], changelog: [{ nr: 1, at: ago(0.5), by: 'x', action: 'edit', changes: [{ id: 'A', field: 'title' }] }] };
    expect(need(o, after).need).toBe(false);
    // ... but with a lower age limit it is asked again.
    expect(need(o, after, { triage: { minAgeDays: 0.25 } }).need).toBe(true);
  });

  it('the triage bookkeeping (the adjust note, the owner answer to a triage question) is not an edit', () => {
    const o = task('A', {
      added_at: ago(10),
      triage: { verdict: 'adjust', at: ago(1) },
      bonus: [
        { time: ago(1), text: 'TRIAGE adjust (x): moved' },
        { time: ago(0.5), text: 'OWNER_ANSWER triage-A (x): Keep' },
      ],
    });
    expect(T.lastEdit(o, { tasks: [o] })).toBe(Date.parse(ago(10)));
    // Another addition counts.
    const p = { ...o, bonus: [...(o.bonus as object[]), { time: ago(0.2), text: 'more' }] };
    expect(T.lastEdit(p, { tasks: [p] })).toBe(Date.parse(ago(0.2)));
  });

  it('config off: the helper switch (queue.json or config), minAgeDays null with agentAdded false', () => {
    const o = task('A', { added_at: ago(10) });
    const off: Queue = { tasks: [o], helpers: { triage: { enabled: false } } };
    expect(setupFor(off).on).toBe(false);
    expect(need(o, off).need).toBe(false);
    expect(need(o, { tasks: [o] }, { helpers: { triage: { enabled: false } } }).need).toBe(false);
    expect(need(o, { tasks: [o] }, { triage: { minAgeDays: null } }).need).toBe(false);
    expect(T.whenText(T.ruleSetup(conf({ triage: { minAgeDays: null, agentAdded: false } })))).toMatch(/never runs/);
  });

  it('lite mode: off by default, on when the owner switched it on in the queue', () => {
    const o = task('A', { added_at: ago(10) });
    expect(setupFor({ tasks: [o] }, { mode: 'lite' })).toMatchObject({ on: false, why: expect.stringMatching(/lite/) });
    const on: Queue = { tasks: [o], helpers: { triage: { enabled: true } } };
    expect(setupFor(on, { mode: 'lite' }).on).toBe(true);
    expect(need(o, on, { mode: 'lite' }).need).toBe(true);
  });

  it('triageCandidates: only startable ones (no blockers, not parked), in ranked order, with asked', () => {
    const q: Queue = {
      tasks: [
        task('LOW', { added_at: ago(9), value: 2 }),
        task('HIGH', { added_at: ago(9), value: 9, triage_asked: new Date(NOW - 10 * 60_000).toISOString() }),
        task('BLOCKED', { added_at: ago(9), depends_on: ['LOW'] }),
        task('FRESH'),
      ],
    };
    const list = T.triageCandidates(q, { now: NOW, setup: setupFor(q) });
    expect(list.map((x: { id: string }) => x.id)).toEqual(['HIGH', 'LOW']);
    expect(list[0].asked).toBe(true);
    expect(list[1].asked).toBe(false);
    // An hour later the step may be given again (askAgainMin 60).
    expect(T.triageCandidates(q, { now: NOW + 60 * 60_000, setup: setupFor(q) })[0].asked).toBe(false);
  });
});

describe('the verdicts (recordVerdict) and the owner choice', () => {
  const fresh = (): Queue => ({ tasks: [task('A', { added_at: ago(10) }), task('B')], resolved: [] });
  const at = new Date(NOW).toISOString();

  it('ready: recorded, the task is startable, no addition to the mission', () => {
    const q = fresh();
    expect(T.recordVerdict(q, 'A', { verdict: 'ready', by: 'orch', now: at }).error).toBeNull();
    const o = q.tasks[0];
    expect(o.triage).toEqual({ verdict: 'ready', at, by: 'orch' });
    expect(o.triage_log).toHaveLength(1);
    expect(o.bonus).toBeUndefined();
    expect(need(o, q, {}, NOW).need).toBe(false);
  });

  it('adjust: the note is added to the mission (bonus), then startable', () => {
    const q = fresh();
    expect(T.recordVerdict(q, 'A', { verdict: 'adjust', note: 'src/old.js moved to src/new.js', now: at }).error).toBeNull();
    const o = q.tasks[0];
    expect(o.bonus).toEqual([{ time: at, text: 'TRIAGE adjust (2026-11-01): src/old.js moved to src/new.js' }]);
    expect(need(o, q, {}, NOW).need).toBe(false);
    expect(o.waiting_on).toBeUndefined();
  });

  it('done and stale: an owner question with choices; the task waits on it and is never closed by itself', () => {
    const q = fresh();
    const r = T.recordVerdict(q, 'A', { verdict: 'done', note: 'src/a.js:12 already does it', now: at });
    expect(r).toMatchObject({ error: null, question: 'triage-A' });
    const o = q.tasks[0];
    expect(o.status).toBe('waiting');
    expect(o.waiting_on).toEqual(['triage-A']);
    expect(q.question!['triage-A']).toMatchObject({
      type: 'question',
      recommendation: 'Close as done',
      choices: ['Close as done', 'Keep and start anyway', 'Rewrite'],
    });
    expect(String(q.question!['triage-A'].text)).toContain('src/a.js:12 already does it.');
    expect(T.choicesFor('stale')[0]).toBe('Close as stale');
    // A second done/stale round gets a new question id (the first one stays resolved).
    q.resolved = ['triage-A'];
    expect(T.questionIdFor(q, 'A')).toBe('triage-A-2');
  });

  it('done, stale and adjust need a note; an unknown verdict or a task that is not waiting is refused', () => {
    const q = fresh();
    expect(T.recordVerdict(q, 'A', { verdict: 'done' }).error).toMatch(/needs --note/);
    expect(T.recordVerdict(q, 'A', { verdict: 'stale', note: '  ' }).error).toMatch(/needs --note/);
    expect(T.recordVerdict(q, 'A', { verdict: 'adjust' }).error).toMatch(/needs --note/);
    expect(T.recordVerdict(q, 'A', { verdict: 'maybe' }).error).toMatch(/--verdict must be/);
    expect(T.recordVerdict(q, 'NOPE', { verdict: 'ready' }).error).toMatch(/unknown task/);
    q.tasks[0].status = 'running';
    expect(T.recordVerdict(q, 'A', { verdict: 'ready' }).error).toMatch(/status running/);
    expect(q.tasks[0].triage).toBeUndefined();
  });

  it('the owner chooses: close cancels, keep makes it startable, rewrite parks it; free text does nothing', () => {
    for (const [choice, check] of [
      ['Close as done', (o: Task) => expect(o.status).toBe('cancelled')],
      ['Keep and start anyway', (o: Task) => expect((o.triage as { kept_at: string }).kept_at).toBe(at)],
      ['Rewrite', (o: Task) => expect(o.parked).toBeTruthy()],
    ] as const) {
      const q = fresh();
      T.recordVerdict(q, 'A', { verdict: 'done', note: 'x.js:1', now: at });
      const r = T.ownerChoice(q, 'triage-A', choice, { by: 'owner', now: at });
      expect(r.error).toBeNull();
      check(q.tasks[0]);
    }
    const q = fresh();
    T.recordVerdict(q, 'A', { verdict: 'stale', note: 'gone', now: at });
    expect(T.ownerChoice(q, 'triage-A', 'let me think', { now: at }).action).toBe('none');
    expect(q.tasks[0].status).toBe('waiting');
    expect(T.ownerChoice(q, 'other-question', 'Close as stale')).toBeNull();
  });

  it('the verdict counts for the measurement', () => {
    const q = fresh();
    T.recordVerdict(q, 'A', { verdict: 'stale', note: 'gone', now: at });
    T.recordVerdict(q, 'B', { verdict: 'ready', now: at });
    expect(T.verdictStatistics(q)).toEqual({ ready: 1, done: 0, stale: 1, adjust: 0, total: 2, saved: 1 });
  });
});

describe('triage in the helper framework', () => {
  it('is a builtin helper, on by default, with its rule as the "When" text and the verdicts as the measurement', () => {
    const q = { tasks: [task('A', { triage_log: [{ verdict: 'done', at: ago(1) }] })] };
    const row = H.helperRows(conf(), q).find((r: { name: string }) => r.name === 'triage');
    expect(row).toMatchObject({ source: 'builtin', enabled: true, phase: 'intake', title: 'Intake triage' });
    expect(row.when).toMatch(/3\+ days ago/);
    expect(row.measurement).toMatch(/verdicts ready=0 done=1 stale=0 adjust=0/);
    // Off in lite mode until switched on.
    expect(H.helperRows(conf({ mode: 'lite' }), q).find((r: { name: string }) => r.name === 'triage').enabled).toBe(false);
  });

  it('is never chosen as a reviewer, whatever its conditions say', () => {
    const c = conf({ helpers: { triage: { enabled: true, classes: ['K', 'U'], labels: ['bug'] } }, reviewers: { K: ['triage'] } });
    const types = H.reviewersForTask({ id: 'A', class: 'K', labels: ['bug'] }, { config: c }).map((x: { type: string }) => x.type);
    expect(types).not.toContain('triage');
    // But it counts for the cost per task (the agent types the time log is matched on).
    expect(H.allReviewerTypes(c)).toContain('triage');
  });
});

// ---- queue.mjs against a copy -------------------------------------------------------------------------------
const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const ID = ['-c', 'user.name=queue-test', '-c', 'user.email=queue-test@example.invalid'];
const temporary: string[] = [];
afterAll(() => {
  for (const m of temporary) fs.rmSync(m, { recursive: true, force: true });
});

function harness(tasks: Task[], config: Record<string, unknown> = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-triage-'));
  temporary.push(folder);
  const repo = path.join(folder, 'repo');
  const scratch = path.join(folder, 'scratch');
  fs.mkdirSync(repo);
  const g = (args: string[]) => execFileSync('git', ['-C', repo, ...ID, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  g(['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(repo, 'README.md'), 'start\n');
  g(['add', 'README.md']);
  g(['commit', '-q', '-m', 'start']);
  fs.writeFileSync(path.join(folder, 'queue.json'), JSON.stringify({ created: ago(0), limits: {}, next_migr: 1, resolved: [], tasks }));
  const configFile = path.join(folder, 'queue.config.json');
  fs.writeFileSync(configFile, JSON.stringify(config));
  fs.mkdirSync(path.join(folder, 'docs'));
  fs.copyFileSync(path.join(ROOT, 'docs', 'mission-template.md'), path.join(folder, 'docs', 'mission-template.md'));
  const env = {
    ...process.env,
    QUEUE_FOLDER: folder,
    QUEUE_CONFIG: configFile,
    QUEUE_ROOT: folder,
    QUEUE_GIT: repo,
    QUEUE_TIME_LOG: path.join(folder, 'times.jsonl'),
    QUEUE_LOAD_ADAPTIVE: 'off',
  };
  const run = (...args: string[]) => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'orchestrator', 'queue.mjs'), ...args], { encoding: 'utf8', env });
    return { code: r.status, out: r.stdout, error: r.stderr };
  };
  const queue = () => JSON.parse(fs.readFileSync(path.join(folder, 'queue.json'), 'utf8')) as Queue;
  const find = (id: string) => queue().tasks.find((x) => x.id === id)!;
  const fill = () => run('fill', '--scratchpad', scratch, '--over-load');
  return { run, find, fill, scratch };
}

// Real time here (queue.mjs uses Date.now()).
const realAgo = (days: number) => new Date(Date.now() - days * DAY).toISOString();

describe('queue.mjs: fill, next, start, triage and resolve', () => {
  it('fill skips the untriaged old task, starts the others, and gives the triage step once (same turn)', () => {
    const h = harness([task('OLD', { added_at: realAgo(10), value: 9 }), task('NEW', { added_at: realAgo(0) })]);
    const next = h.run('next');
    expect(next.out).toMatch(/Needs an intake triage verdict first .*OLD \(added or last edited 10 days ago\)/);
    expect(next.out).toMatch(/^NEW /m);
    const f = h.fill();
    expect(f.error).toBe('');
    expect(f.code).toBe(0);
    expect(h.find('NEW').status).toBe('running');
    expect(h.find('OLD').status).toBe('waiting');
    expect(h.find('OLD').triage_asked).toBeTruthy();
    expect(f.out).toMatch(/TRIAGE 1 task\(s\) first/);
    const prompt = path.join(h.scratch, 'triage-OLD.md');
    expect(fs.readFileSync(prompt, 'utf8')).toContain('The mission for OLD.');
    // The triage agent is in the same-turn block with the track.
    const block = f.out.slice(f.out.indexOf('Start these in the SAME turn:'));
    expect(block).toMatch(/subagent_type=(ravenseat:)?track /);
    expect(block).toMatch(/subagent_type=(ravenseat:)?triage · message: You are the triage helper for track OLD/);
    // The next fill does not ask again while the agent may be running, and still does not start OLD.
    const again = h.fill();
    expect(again.out).not.toMatch(/TRIAGE 1 task/);
    expect(again.out).toMatch(/Waiting on a triage verdict \(step already given\): OLD/);
    expect(h.find('OLD').status).toBe('waiting');
    // start refuses without --force; fill --ids too.
    expect(h.run('start', 'OLD').error).toMatch(/needs an intake triage verdict/);
    expect(h.run('fill', '--scratchpad', h.scratch, '--ids', 'OLD', '--over-load').error).toMatch(/needs an intake triage verdict/);
  }, 60_000);

  it('adjust: the note reaches the track prompt, and the next fill starts the task', () => {
    const h = harness([task('OLD', { added_at: realAgo(10) })]);
    expect(h.fill().out).toMatch(/Nothing can start now[\s\S]*TRIAGE 1 task/);
    const r = h.run('triage', 'OLD', '--verdict', 'adjust', '--note', 'README.md is now docs/README.md');
    expect(r.error).toBe('');
    expect(r.out).toMatch(/triage adjust/);
    const f = h.fill();
    expect(f.code).toBe(0);
    expect(h.find('OLD').status).toBe('running');
    expect(fs.readFileSync(path.join(h.scratch, 'prompt-OLD.md'), 'utf8')).toContain('TRIAGE adjust');
    expect(fs.readFileSync(path.join(h.scratch, 'prompt-OLD.md'), 'utf8')).toContain('docs/README.md');
  }, 60_000);

  it('ready starts it; done asks the owner, and the owner closes it with a choice', () => {
    const h = harness([task('OLD', { added_at: realAgo(10) }), task('GONE', { added_at: realAgo(10) })]);
    h.fill();
    expect(h.run('triage', 'OLD', '--verdict', 'ready').out).toMatch(/It can start/);
    const d = h.run('triage', 'GONE', '--verdict', 'done', '--note', 'README.md:1 does it');
    expect(d.out).toMatch(/owner question triage-GONE/);
    expect(h.find('GONE').waiting_on).toEqual(['triage-GONE']);
    h.fill();
    expect(h.find('OLD').status).toBe('running');
    expect(h.find('GONE').status).toBe('waiting');
    const res = h.run('resolve', 'triage-GONE', '--choice', '1', '--by', 'owner');
    expect(res.out).toMatch(/Triage GONE: cancelled/);
    expect(h.find('GONE').status).toBe('cancelled');
  }, 60_000);

  it('config off: with the helper switched off, fill starts the old task as before', () => {
    const h = harness([task('OLD', { added_at: realAgo(10) })], { helpers: { triage: { enabled: false } } });
    const f = h.fill();
    expect(f.out).not.toMatch(/TRIAGE/);
    expect(h.find('OLD').status).toBe('running');
    // And the switch from the board / ravenseat helpers works the same way.
    const h2 = harness([task('OLD', { added_at: realAgo(10) })]);
    expect(h2.run('helpers', 'off', 'triage').out).toMatch(/triage: off/);
    h2.fill();
    expect(h2.find('OLD').status).toBe('running');
    expect(h2.run('triage').out).toMatch(/Intake triage is off/);
  }, 60_000);
});
