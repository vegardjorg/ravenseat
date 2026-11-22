// =============================================================
// queueQuestionCard.test.ts: the question card fields (section 6.1 and 6.2 of plans/autonomi-nivaa-utredning.md, owner
// question 7 answered "as recommended" on 2026-11-06).
//
// A NEW owner question of type `question` from `ravenseat question` or `ravenseat add` must carry category, context,
// if_yes, if_no and a recommendation; if_yes and if_no differ; the recommendation is one of the choices when there are
// choices. The rule is enforced in setQuestion (the one write path) when the caller asks for it (strict: the two commands
// people and agents use). System questions, the types condition, lawyer and owner-task, and old posts are never refused.
// The CLI part runs queue.mjs against a queue in a temporary folder (QUEUE_FOLDER), never the real one.
// =============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

type Q = Record<string, unknown>;
type Queue = { tasks: Record<string, unknown>[]; resolved?: string[]; question?: Record<string, Q>; [k: string]: unknown };

// eslint-disable-next-line @typescript-eslint/no-require-imports
const L = require('../queueLogic') as {
  setQuestion: (
    queue: Queue,
    input: unknown,
    now?: string,
    opts?: { strict?: boolean; track?: string | null },
  ) => { set: string[]; error: string[] };
  questionOverview: (queue: Queue) => Record<string, unknown>[];
};

const full = {
  text: 'Use date-fns for time zones in the report?',
  category: 'dependency',
  context: 'The report shows the wrong day at midnight for users outside UTC. The project has no date library today.',
  if_yes: 'One new package (about 20 kB), and the bug is fixed in this round.',
  if_no: 'About 40 lines of our own code. One more round, and it must be kept up when the DST rules change.',
  recommendation: 'Use date-fns',
  choices: ['Use date-fns', 'Write it ourselves'],
};
const NOW = '2026-11-22T05:00:00.000Z';

describe('setQuestion: the new card fields', () => {
  it('stores category, context, if_yes and if_no (trimmed) on a complete new question', () => {
    const queue: Queue = { tasks: [] };
    const r = L.setQuestion(queue, { 'Q-7': { ...full, if_yes: `  ${full.if_yes} ` } }, NOW, { strict: true });
    expect(r.error).toEqual([]);
    expect(queue.question?.['Q-7']).toMatchObject({
      type: 'question',
      category: 'dependency',
      context: full.context,
      if_yes: full.if_yes,
      if_no: full.if_no,
      recommendation: 'Use date-fns',
    });
  });

  it('refuses a new question without the fields, names what is missing and how to add it, and changes nothing', () => {
    const queue: Queue = { tasks: [] };
    const r = L.setQuestion(queue, { 'Q-7': { text: 'Use date-fns?' } }, NOW, { strict: true });
    expect(queue.question).toBeUndefined();
    expect(r.error).toHaveLength(1);
    const e = r.error[0];
    expect(e).toMatch(/^Q-7: /);
    expect(e).toMatch(/missing: category, context, if_yes, if_no, recommendation/);
    expect(e).toContain('--if-yes');
    expect(e).toContain('--category');
    expect(e).toContain('legal');
  });

  it('refuses if_yes equal to if_no (ignoring case and spaces) and a recommendation that is not a choice', () => {
    const same = L.setQuestion({ tasks: [] }, { Q1: { ...full, if_no: ` ${full.if_yes.toUpperCase()} ` } }, NOW, { strict: true });
    expect(same.error[0]).toMatch(/if_yes and if_no say the same/);
    const notAChoice = L.setQuestion({ tasks: [] }, { Q1: { ...full, recommendation: 'The best one' } }, NOW, { strict: true });
    expect(notAChoice.error[0]).toMatch(/recommendation must be one of the choices/);
    // Without choices any recommendation will do.
    const free = L.setQuestion({ tasks: [] }, { Q1: { ...full, choices: undefined, recommendation: 'Use it' } }, NOW, { strict: true });
    expect(free.error).toEqual([]);
  });

  it('holds the limits: context 600, if_yes and if_no 300 characters', () => {
    const long = (n: number) => 'x'.repeat(n);
    const c = L.setQuestion({ tasks: [] }, { Q1: { ...full, context: long(601) } }, NOW, { strict: true });
    expect(c.error[0]).toMatch(/context must be at most 600 characters/);
    const y = L.setQuestion({ tasks: [] }, { Q1: { ...full, if_yes: long(301) } }, NOW, { strict: true });
    expect(y.error[0]).toMatch(/if_yes must be at most 300 characters/);
    // Without strict the new fields keep their limits too (they are new, nothing old is longer).
    const n = L.setQuestion({ tasks: [] }, { Q1: { text: 'x', if_no: long(301) } }, NOW);
    expect(n.error[0]).toMatch(/if_no must be at most 300 characters/);
  });

  it('refuses an unknown category always, and lists the keys', () => {
    const r = L.setQuestion({ tasks: [] }, { Q1: { text: 'x', category: 'db' } }, NOW);
    expect(r.error[0]).toMatch(/unknown category "db": use one of legal, security/);
  });

  it('never refuses the exempt types, system questions (no strict) or an update of an old post', () => {
    for (const type of ['condition', 'lawyer', 'owner-task']) {
      const r = L.setQuestion({ tasks: [] }, { Q1: { type, text: 'Waiting on the DPA' } }, NOW, { strict: true });
      expect(r.error, type).toEqual([]);
    }
    expect(L.setQuestion({ tasks: [] }, { Q1: { text: 'Fix round cap reached: go on?' } }, NOW).error).toEqual([]);
    const old: Queue = { tasks: [], question: { OLD: { type: 'question', text: 'Old post', added_at: NOW } } };
    expect(L.setQuestion(old, { OLD: { recommendation: 'Yes' } }, NOW, { strict: true }).error).toEqual([]);
    expect(old.question?.OLD).toMatchObject({ text: 'Old post', recommendation: 'Yes' });
  });

  it('records the track that registered it from the tool, never from the input', () => {
    const queue: Queue = { tasks: [] };
    expect(L.setQuestion(queue, { Q1: full }, NOW, { strict: true, track: 'T-4' }).error).toEqual([]);
    expect(queue.question?.Q1.track).toBe('T-4');
    const spoof = L.setQuestion({ tasks: [] }, { Q2: { ...full, track: 'T-9' } }, NOW, { strict: true });
    expect(spoof.error[0]).toMatch(/unknown field track/);
  });
});

describe('questionOverview: the fields for the card', () => {
  it('has category (uncategorized for an old post), if_yes and if_no', () => {
    const queue: Queue = {
      tasks: [],
      question: { NEW: { ...full, type: 'question', added_at: NOW }, OLD: { type: 'question', text: 'Old', added_at: NOW } },
    };
    const rows = L.questionOverview(queue);
    expect(rows.find((r) => r.sp === 'NEW')).toMatchObject({ category: 'dependency', if_yes: full.if_yes, if_no: full.if_no });
    expect(rows.find((r) => r.sp === 'OLD')).toMatchObject({ category: 'uncategorized', if_yes: null, if_no: null });
  });
});

describe('queue.mjs: question and add with the card fields', () => {
  const QUEUE_MJS = join(__dirname, '..', '..', 'queue.mjs');
  let folder: string;
  function run(args: string[]): { code: number; out: string; error: string } {
    try {
      const out = execFileSync(process.execPath, [QUEUE_MJS, ...args], {
        env: { ...process.env, QUEUE_FOLDER: folder, QUEUE_GIT: folder, QUEUE_TIME_LOG: join(folder, 'times.jsonl') },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { code: 0, out, error: '' };
    } catch (e) {
      const x = e as { status: number; stdout: string; stderr: string };
      return { code: x.status, out: String(x.stdout ?? ''), error: String(x.stderr ?? '') };
    }
  }
  const readQueue = (): Queue => JSON.parse(readFileSync(join(folder, 'queue.json'), 'utf8'));
  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'queue-card-'));
    writeFileSync(join(folder, 'queue.json'), JSON.stringify({ tasks: [], resolved: [], limits: { maxConcurrent: 5 }, next_migr: 100 }));
  });
  afterEach(() => rmSync(folder, { recursive: true, force: true }));

  it('question without the fields is refused with how to fix it; with --category, --context, --if-yes, --if-no it is set', () => {
    const bad = run(['question', 'Q-7', '--text', 'Use date-fns?']);
    expect(bad.code).toBe(1);
    expect(bad.error).toMatch(/missing: category, context, if_yes, if_no, recommendation/);
    expect(readQueue().question).toBeUndefined();
    const ok = run([
      'question', 'Q-7', '--text', full.text, '--category', 'dependency', '--context', full.context,
      '--if-yes', full.if_yes, '--if-no', full.if_no, '--recommendation', 'Use date-fns',
      '--choice', 'Use date-fns', '--choice', 'Write it ourselves',
    ]);
    expect(ok.code, ok.error).toBe(0);
    expect(readQueue().question?.['Q-7']).toMatchObject({ category: 'dependency', if_yes: full.if_yes, if_no: full.if_no });
    // The list shows the card fields.
    const list = run(['question']);
    expect(list.out).toContain('category: dependency');
    expect(list.out).toContain(`if you follow the recommendation: ${full.if_yes.slice(0, 30)}`);
  });

  it('a condition needs none of the fields', () => {
    const r = run(['question', 'C1', '--type', 'condition', '--text', 'The DPA is signed']);
    expect(r.code, r.error).toBe(0);
  });

  it('add with a question without the fields is refused, nothing is added', () => {
    const file = join(folder, 'add.json');
    writeFileSync(
      file,
      JSON.stringify({
        tasks: [{ id: 'A1', title: 'A', class: 'K', domain: 'x', mission: 'Do it', waiting_on: ['Q1'] }],
        question: { Q1: { type: 'question', text: 'Which one?' } },
      }),
    );
    const r = run(['add', '--file', file]);
    expect(r.code).not.toBe(0);
    expect(r.error + r.out).toMatch(/question Q1: .*missing: category/);
    expect(readQueue().tasks).toEqual([]);
  });
});
