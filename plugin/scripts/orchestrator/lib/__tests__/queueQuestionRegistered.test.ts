// =============================================================
// queueQuestionRegistered.test.ts: receive compares the track's `ownerQuestions=<n>` with the questions the track
// registered with `ravenseat question` (section 6.3 of plans/autonomi-nivaa-utredning.md).
//
// Why: a question written as free text in the report has no category, context or consequence, so the owner must see
// that the agent did not fill it in. Receive never refuses for this: the card is marked, and the merge goes on.
// =============================================================
import { afterAll, describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const L = require('../queueLogic.js') as any;

const queue = () => ({
  tasks: [],
  question: {
    'Q-A': { type: 'question', text: 'First?', track: 'T-1' },
    'Q-B': { type: 'question', text: 'Second?', track: 'T-1' },
    'Q-C': { type: 'question', text: 'Other track?', track: 'T-2' },
    'Q-D': { type: 'question', text: 'From the orchestrator?' },
  },
});

describe('registeredQuestions', () => {
  it('lists the open questions the track registered, in id order', () => {
    expect(L.registeredQuestions(queue(), 'T-1', 2)).toEqual({ registered: ['Q-A', 'Q-B'], unfilled: 0 });
  });

  it('counts what the track said it asked but did not register as unfilled', () => {
    expect(L.registeredQuestions(queue(), 'T-1', 3)).toEqual({ registered: ['Q-A', 'Q-B'], unfilled: 1 });
    expect(L.registeredQuestions(queue(), 'T-3', 2)).toEqual({ registered: [], unfilled: 2 });
  });

  it('never counts below zero, and a bad count is zero', () => {
    expect(L.registeredQuestions(queue(), 'T-1', 1)).toEqual({ registered: ['Q-A', 'Q-B'], unfilled: 0 });
    expect(L.registeredQuestions(queue(), 'T-1', 'x')).toEqual({ registered: ['Q-A', 'Q-B'], unfilled: 0 });
    expect(L.registeredQuestions({}, 'T-1', 1)).toEqual({ registered: [], unfilled: 1 });
  });

  it('the receive note says what happened in one line, and nothing when all are registered', () => {
    expect(L.registeredQuestionNote('T-1', { registered: ['Q-A'], unfilled: 1 }, 'ravenseat')).toBe(
      'NOTE: T-1 asked 1 owner question as free text instead of registering it with ravenseat question. ' +
        'The card says "Not filled in by the agent" (no category, context or consequence). Registered: Q-A.',
    );
    expect(L.registeredQuestionNote('T-1', { registered: [], unfilled: 2 }, 'ravenseat')).toContain('asked 2 owner questions as free text');
    expect(L.registeredQuestionNote('T-1', { registered: ['Q-A'], unfilled: 0 }, 'ravenseat')).toBeNull();
  });
});

// ---- receive: the NOTE line and the marked card ------------------------------------------------------------------

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const ID = ['-c', 'user.name=queue-test', '-c', 'user.email=queue-test@example.invalid'];
const temporary: string[] = [];
afterAll(() => {
  for (const m of temporary) fs.rmSync(m, { recursive: true, force: true });
});

describe('queue.mjs receive with owner questions', () => {
  /** Task A on queue/A with one commit; the report says ownerQuestions=<asked>; `question` is the queue's question map. */
  const setup = (asked: number, question: object) => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-qreg-'));
    temporary.push(folder);
    const repo = path.join(folder, 'repo');
    const scratch = path.join(folder, 'scratch');
    fs.mkdirSync(repo);
    fs.mkdirSync(scratch);
    const g = (args: string[]) => execFileSync('git', ['-C', repo, ...ID, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const put = (file: string, text: string) => {
      fs.writeFileSync(path.join(repo, file), text);
      g(['add', '--', file]);
    };
    g(['init', '-q', '-b', 'main']);
    put('a.txt', 'start\n');
    g(['commit', '-q', '-m', 'start']);
    g(['switch', '-q', '-c', 'queue/A']);
    put('a.txt', 'track A\n');
    g(['commit', '-q', '-m', 'track A']);
    g(['switch', '-q', 'main']);
    const task = {
      id: 'A',
      title: 'Task A',
      domain: 'dom-A',
      class: 'K',
      status: 'running',
      mission: 'The mission for A.',
      value: 5,
      content_min: 60,
      depends_on: [],
      waiting_on: [],
      owned_files: ['a.txt'],
      started: '2026-01-01T00:00:00.000Z',
      branch: 'queue/A',
      migr_block: null,
      scratchpad: scratch,
    };
    fs.writeFileSync(path.join(folder, 'queue.json'), JSON.stringify({ created: task.started, limits: {}, next_migr: 3600, resolved: [], tasks: [task], question }));
    fs.mkdirSync(path.join(scratch, 'A'), { recursive: true });
    fs.writeFileSync(
      path.join(scratch, 'A', 'track-result.md'),
      `RESULT status=DONE branch=queue/A commits=1 migr=- gates=OK probe=- ownerQuestions=${asked} edge=-\n\n` +
        '## Owner questions\n1. Should the export include archived rows?\n',
    );
    const env = {
      ...process.env,
      QUEUE_FOLDER: folder,
      QUEUE_ROOT: folder,
      QUEUE_GIT: repo,
      QUEUE_TIME_LOG: path.join(folder, 'times.jsonl'),
      QUEUE_TRANSCRIPTS: path.join(folder, 'transcripts'),
    } as NodeJS.ProcessEnv;
    delete env.QUEUE_SCRATCHPAD;
    delete env.QUEUE_SESSION;
    delete env.QUEUE_CONFIG;
    const receive = () =>
      spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'orchestrator', 'queue.mjs'), 'receive', 'A'], { encoding: 'utf8', env, cwd: folder });
    const task0 = () => JSON.parse(fs.readFileSync(path.join(folder, 'queue.json'), 'utf8')).tasks[0];
    return { receive, task0 };
  };
  const block = (t: any) => (t.blocks ?? []).find((b: any) => b.code === 'track-question' && !b.to);

  it('a question in free text: one NOTE line, the card marked, and the delivery still goes to review', () => {
    const m = setup(1, {});
    const r = m.receive();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('NOTE: A asked 1 owner question as free text instead of registering it with');
    const t = m.task0();
    expect(t.status).toBe('review');
    expect(block(t)).toMatchObject({ unfilled: 1, registered: [] });
  });

  it('every question registered: no NOTE, and the card lists them', () => {
    const m = setup(1, { 'Q-X': { type: 'question', text: 'Archived rows?', track: 'A', category: 'product' } });
    const r = m.receive();
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('as free text');
    expect(block(m.task0())).toMatchObject({ unfilled: 0, registered: ['Q-X'] });
  });
});
