// =============================================================
// queueQuestionChoices.test.ts: `choices` on owner questions (2-4 short answer options).
//
// A question can carry `choices`, so the owner answers with one click on the board or `cq resolve <id> --choice <n|text>`.
// The tests prove the rules where they are enforced: setQuestion (validation, all or nothing, a question without choices
// unchanged), resolve with a choice (the stored answer is the choice's text, plus a note), the printed lines for the
// orchestrator (choiceLines, cq question, cq resolutions, the after-compact text), and queue.mjs against a copy of the queue
// in a temporary folder (QUEUE_FOLDER), never the real one.
// =============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

type Question = {
  type: string;
  text: string;
  recommendation?: string;
  source?: string;
  choices?: string[];
  added_at: string;
};
type Queue = {
  tasks: Record<string, unknown>[];
  resolved?: string[];
  question?: Record<string, Question>;
  resolutions?: Record<string, { time: string; answer: string | null; by: string | null; logged?: boolean }>;
  limits?: Record<string, unknown>;
  next_migr?: number;
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const L = require('../queueLogic') as {
  setQuestion: (queue: Queue, input: unknown, now?: string) => { set: string[]; error: string[] };
  choicesError: (list: unknown) => string[];
  choiceLines: (q: unknown) => string[];
  pickChoice: (q: unknown, pick: unknown) => { choice: string | null; error: string | null };
  resolve: (
    queue: Queue,
    ids: string[],
    option?: { answer?: string | null; choice?: string | number | null; by?: string | null; now?: string },
  ) => { resolved: string[]; error: string[]; answer: string | null };
  questionOverview: (queue: Queue) => { sp: string; choices: string[] }[];
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const KV = require('../contextGuard') as {
  afterCompactText: (input: Record<string, unknown>) => string;
};

const T1 = '2026-10-01T10:00:00.000Z';

describe('choices: validation in setQuestion', () => {
  it('2-4 trimmed entries are stored; a question without choices is unchanged (no choices field)', () => {
    const queue: Queue = { tasks: [] };
    const r = L.setQuestion(
      queue,
      {
        Q1: { text: 'Which vendor?', choices: ['  Vendor A ', 'Vendor B'], recommendation: 'Vendor A' },
        Q2: { text: 'Free text question' },
      },
      T1,
    );
    expect(r).toEqual({ set: ['Q1', 'Q2'], error: [] });
    expect(queue.question?.Q1.choices).toEqual(['Vendor A', 'Vendor B']);
    expect(queue.question?.Q2).toEqual({ type: 'question', text: 'Free text question', added_at: T1 });
  });

  it('too few, too many, empty, too long, duplicate and not a list: a clear error, and nothing is changed', () => {
    expect(L.choicesError(['Only one'])[0]).toMatch(/2-4 entries \(has 1\)/);
    expect(L.choicesError(['a', 'b', 'c', 'd', 'e'])[0]).toMatch(/2-4 entries \(has 5\)/);
    expect(L.choicesError(['a', '   '])).toEqual(['choice 2 is empty (or not text)']);
    expect(L.choicesError(['a', 7])).toEqual(['choice 2 is empty (or not text)']);
    expect(L.choicesError(['a', 'x'.repeat(61)])).toEqual(['choice 2 is longer than 60 characters']);
    expect(L.choicesError(['a', 'x'.repeat(60)])).toEqual([]);
    expect(L.choicesError(['Yes', ' yes '])).toEqual(['choice 2 is a duplicate ("yes")']);
    expect(L.choicesError('Yes, No')[0]).toMatch(/must be a list/);

    const queue: Queue = { tasks: [] };
    const r = L.setQuestion(queue, {
      OK: { text: 'Valid', choices: ['Yes', 'No'] },
      BAD: { text: 'Invalid', choices: ['Yes', 'yes'] },
    });
    expect(r.set).toEqual([]);
    expect(r.error.join('\n')).toMatch(/BAD: choice 2 is a duplicate/);
    expect(queue.question).toBeUndefined();
  });

  it('an update keeps the choices when not given, and null removes them', () => {
    const queue: Queue = { tasks: [] };
    L.setQuestion(queue, { A: { text: 'First', choices: ['Yes', 'No'] } }, T1);
    L.setQuestion(queue, { A: { text: 'Other' } });
    expect(queue.question?.A.choices).toEqual(['Yes', 'No']);
    L.setQuestion(queue, { A: { choices: null } });
    expect(queue.question?.A).toEqual({ type: 'question', text: 'Other', added_at: T1 });
  });
});

describe('choices: answer by choice (resolve) and the printed lines', () => {
  const withChoices = (): Queue => ({
    tasks: [],
    question: {
      Q1: {
        type: 'question',
        text: 'Which vendor?',
        choices: ['Vendor A', 'Vendor B', 'Wait a month'],
        recommendation: 'Vendor B',
        added_at: T1,
      },
      Q2: { type: 'question', text: 'Free', added_at: T1 },
    },
  });

  it('pickChoice takes a number from 1 or the text (ignoring case); otherwise an error that lists the choices', () => {
    const q = withChoices().question!.Q1;
    expect(L.pickChoice(q, 2)).toEqual({ choice: 'Vendor B', error: null });
    expect(L.pickChoice(q, ' wait a MONTH ')).toEqual({ choice: 'Wait a month', error: null });
    expect(L.pickChoice(q, '4').error).toBe('choice 4 does not exist (1. Vendor A, 2. Vendor B, 3. Wait a month)');
    expect(L.pickChoice(q, '0').error).toMatch(/does not exist/);
    expect(L.pickChoice(q, 'Vendor C').error).toMatch(/unknown choice "Vendor C"/);
    expect(L.pickChoice(withChoices().question!.Q2, 1).error).toMatch(/has no choices/);
  });

  it('the stored answer is the choice text, with the free text as a note; errors change nothing', () => {
    const queue = withChoices();
    expect(L.resolve(queue, ['Q1'], { choice: '2', answer: ' from March ', by: 'owner', now: T1 })).toEqual({
      resolved: ['Q1'],
      error: [],
      answer: 'Vendor B (note: from March)',
    });
    expect(queue.resolutions?.Q1).toEqual({
      time: T1,
      answer: 'Vendor B (note: from March)',
      by: 'owner',
      logged: false,
    });
    // An empty note is no note (with a choice the answer is never empty).
    const q2 = withChoices();
    expect(L.resolve(q2, ['Q1'], { choice: 1, answer: '' }).answer).toBe('Vendor A');

    const q3 = withChoices();
    expect(L.resolve(q3, ['Q1', 'Q2'], { choice: 1 }).error).toEqual(['--choice takes exactly one question id']);
    expect(L.resolve(q3, ['Q2'], { choice: 1 }).error[0]).toMatch(/Q2: the question has no choices/);
    expect(L.resolve(q3, ['Q1'], { choice: 9 }).error[0]).toMatch(/Q1: choice 9 does not exist/);
    expect(q3.resolved).toBeUndefined();
    expect(q3.resolutions).toBeUndefined();
  });

  it('choiceLines numbers the choices and marks the one equal to the recommendation; none without choices', () => {
    const queue = withChoices();
    expect(L.choiceLines(queue.question!.Q1)).toEqual(['1. Vendor A', '2. Vendor B (recommended)', '3. Wait a month']);
    expect(L.choiceLines(queue.question!.Q2)).toEqual([]);
    expect(L.questionOverview(queue).find((r) => r.sp === 'Q2')?.choices).toEqual([]);
  });

  it('the after-compact text shows the open question with its choices numbered', () => {
    const queue = withChoices();
    const text = KV.afterCompactText({
      show: '',
      question: L.questionOverview(queue),
      unpushed: 0,
      compactions: 1,
    });
    expect(text).toContain('  Q1: Which vendor? (recommendation: Vendor B)\n    1. Vendor A\n    2. Vendor B\n    3. Wait a month');
    expect(text).toContain('  Q2: Free\n');
  });
});

describe('queue.mjs: question --choice, resolve --choice, and the lists', () => {
  const QUEUE_MJS = join(__dirname, '..', '..', 'queue.mjs');
  let folder: string;

  function run(args: string[]): { code: number; out: string; error: string } {
    try {
      const out = execFileSync(process.execPath, [QUEUE_MJS, ...args], {
        env: {
          ...process.env,
          QUEUE_FOLDER: folder,
          QUEUE_GIT: folder,
          QUEUE_TIME_LOG: join(folder, 'times.jsonl'),
        },
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
    folder = mkdtempSync(join(tmpdir(), 'queue-choices-'));
    const queue: Queue = {
      tasks: [],
      resolved: [],
      limits: { maxConcurrent: 5, maxDPlus: 2, maxPerDomain: 7, maxDb: 6 },
      next_migr: 100,
    };
    writeFileSync(join(folder, 'queue.json'), JSON.stringify(queue));
  });
  afterEach(() => rmSync(folder, { recursive: true, force: true }));

  it('question <id> --choice ... (repeated) registers the choices; an invalid list stops and changes nothing', () => {
    const bad = run(['question', 'V1', '--text', 'Which vendor?', '--choice', 'A']);
    expect(bad.code).toBe(1);
    expect(bad.error).toMatch(/V1: choices must have 2-4 entries \(has 1\)/);
    expect(readQueue().question).toBeUndefined();

    const ok = run([
      'question', 'V1', '--text', 'Which vendor?', '--choice', 'Vendor A', '--choice', 'Vendor B',
      '--recommendation', 'Vendor A',
    ]);
    expect(ok.code, ok.error).toBe(0);
    expect(readQueue().question?.V1.choices).toEqual(['Vendor A', 'Vendor B']);

    const list = run(['question']).out;
    expect(list).toContain('    1. Vendor A (recommended)');
    expect(list).toContain('    2. Vendor B');
    expect(list).toContain('cq resolve V1 --choice <1-2>');

    expect(run(['question', 'V1', '--no-choices']).code).toBe(0);
    expect(readQueue().question?.V1.choices).toBeUndefined();
  });

  it('add with { tasks, question } takes choices; an invalid choice list stops the tasks too (all or nothing)', () => {
    const task = {
      id: 'C',
      title: 'Task C',
      domain: 'client',
      class: 'K',
      mission: 'Do C.',
      depends_on: [],
      waiting_on: ['V2'],
      owned_files: [],
      owner_db: [],
      shared_patch: [],
    };
    const file = (name: string, content: unknown) => {
      const p = join(folder, name);
      writeFileSync(p, JSON.stringify(content));
      return p;
    };
    const bad = run([
      'add', '--file',
      file('bad.json', { tasks: [task], question: { V2: { text: 'Go?', choices: ['Yes', 'x'.repeat(61)] } } }),
    ]);
    expect(bad.code).toBe(1);
    expect(bad.error).toContain('question V2: choice 2 is longer than 60 characters');
    expect(readQueue().tasks).toEqual([]);

    const ok = run([
      'add', '--file',
      file('ok.json', { tasks: [task], question: { V2: { text: 'Go?', choices: ['Yes', 'No'] } } }),
    ]);
    expect(ok.code, ok.error).toBe(0);
    expect(readQueue().question?.V2.choices).toEqual(['Yes', 'No']);
  });

  it('resolve <id> --choice <n|text> [--answer note] stores the choice text; resolutions prints the choices', () => {
    run(['question', 'V1', '--text', 'Which vendor?', '--choice', 'Vendor A', '--choice', 'Vendor B']);
    const wrong = run(['resolve', 'V1', '--choice', '3']);
    expect(wrong.code).toBe(1);
    expect(wrong.error).toContain('choice 3 does not exist (1. Vendor A, 2. Vendor B)');
    expect(readQueue().resolved).toEqual([]);

    const r = run(['resolve', 'V1', '--choice', '2', '--answer', 'cheaper', '--by', 'owner']);
    expect(r.code, r.error).toBe(0);
    expect(r.out).toContain('Resolved: V1 (choice: Vendor B (note: cheaper))');
    expect(readQueue().resolutions?.V1).toMatchObject({ answer: 'Vendor B (note: cheaper)', by: 'owner' });

    // By the text as well, and without a note.
    expect(run(['resolve', 'V1', '--choice', 'vendor a']).code).toBe(0);
    expect(readQueue().resolutions?.V1.answer).toBe('Vendor A');
    const res = run(['resolutions']).out;
    expect(res).toContain('    1. Vendor A\n    2. Vendor B');
    expect(res).toContain('answer: Vendor A');
  });
});
