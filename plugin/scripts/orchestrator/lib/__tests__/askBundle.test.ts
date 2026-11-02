// =============================================================
// askBundle.test.ts: `cq ask <id>`, the bundle for a question about an earlier track (lib/askBundle.js, cli/ask.mjs).
//
// Why: the bundle replaces resuming a huge track agent, so it must hold the pieces that answer questions (report,
// handover, mission, queue notes and owner answers, commits, transcript tail), stay under its size cap, and NEVER carry
// a secret (redacted with the secretScan patterns). Tested pure (redact, cap, transcriptTail, taskLog, buildBundle)
// and end to end: queue.mjs ask against a temporary repo, queue, time log and transcript (never the real ones).
// The fake secrets are built by concatenation so this file itself holds no key-shaped literal.
// =============================================================
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type Section = { name: string; source: string | null; chars: number; truncated: boolean; missing: string | null };
type Bundle = { text: string; chars: number; redactions: number; redactionRules: Record<string, number>; sections: Section[] };

const AB = require('../askBundle.js') as {
  DEFAULT_CAP: number;
  MIN_CAP: number;
  SHARES: Record<string, number>;
  ORDER: [string, string, string][];
  redact: (s: string) => { text: string; count: number; rules: Record<string, number> };
  cap: (s: string, max: number, keep?: string) => { text: string; truncated: boolean };
  capFrom: (v: unknown) => number;
  transcriptTail: (s: string, o?: { fromStart?: boolean }) => string;
  taskLog: (o: object, queue?: object) => string;
  taskHead: (o: object) => string;
  buildBundle: (o: object) => Bundle;
  answerInstruction: (id: string, q: string | null) => string[];
};
const S = require('../helperScan.js') as { scanHelper?: (s: string) => { level: string }; scan?: (s: string) => { level: string } };

const GH = 'ghp_' + 'A1b2'.repeat(9);
const AWS = 'AKIA' + 'ABCDEFGH12345678';
const JWT = 'eyJ' + 'hbGciOiJIUzI1' + '.' + 'eyJzdWIiOiIxMjM0' + '.' + 'SflKxwRJSMeKKF2QT4';
const PEM = '-----BEGIN ' + 'RSA PRIVATE KEY-----\nMIIEow\nabc\n-----END ' + 'RSA PRIVATE KEY-----';

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const temporary: string[] = [];
afterAll(() => {
  for (const m of temporary) fs.rmSync(m, { recursive: true, force: true });
});

describe('redact', () => {
  it('replaces provider keys, JWTs, Bearer values, private key blocks and generic secrets, never keeping the value', () => {
    const r = AB.redact(
      `token in text ${GH}\naws ${AWS}\nauth: Bearer abcdefghijklmnop123456\njwt ${JWT}\n${PEM}\nDB_PASSWORD=hunter2hunter2abc9\n`,
    );
    for (const secret of [GH, AWS, JWT, 'abcdefghijklmnop123456', 'MIIEow', 'hunter2hunter2abc9']) expect(r.text).not.toContain(secret);
    expect(r.text).toContain('[REDACTED:github-token]');
    expect(r.text).toContain('[REDACTED:aws-access-key]');
    expect(r.text).toContain('Bearer [REDACTED:bearer]');
    expect(r.text).toContain('[REDACTED:jwt]');
    expect(r.text).toContain('[REDACTED:private-key]');
    expect(r.text).toContain('DB_PASSWORD=[REDACTED:generic-secret]');
    expect(r.count).toBe(6);
    expect(Object.keys(r.rules).sort()).toEqual(['aws-access-key', 'bearer', 'generic-secret', 'github-token', 'jwt', 'private-key']);
  });

  it('leaves placeholders, env references and ordinary text alone', () => {
    const s = 'API_KEY=process.env.API_KEY\npassword: changeme-changeme-123\ntoken = ${SECRET_TOKEN_VALUE}\nThe lock is in lib/x.js:12.';
    const r = AB.redact(s);
    expect(r.text).toBe(s);
    expect(r.count).toBe(0);
  });

  it('replaces every occurrence, not only the first', () => {
    const r = AB.redact(`${GH} and again ${GH}`);
    expect(r.count).toBe(2);
    expect(r.text).not.toContain(GH);
  });
});

describe('cap', () => {
  it('keeps short text as it is', () => {
    expect(AB.cap('abc', 10)).toEqual({ text: 'abc', truncated: false });
  });
  it('keeps the head, the tail or both, marks the cut and stays within the limit', () => {
    const s = 'A'.repeat(500) + 'B'.repeat(500);
    const head = AB.cap(s, 200, 'head');
    const tail = AB.cap(s, 200, 'tail');
    const both = AB.cap(s, 200, 'both');
    for (const c of [head, tail, both]) {
      expect(c.truncated).toBe(true);
      expect(c.text.length).toBeLessThanOrEqual(200);
      expect(c.text).toContain('characters cut');
    }
    expect(head.text.startsWith('A')).toBe(true);
    expect(tail.text.endsWith('B')).toBe(true);
    expect(both.text.startsWith('A') && both.text.endsWith('B')).toBe(true);
  });
  it('capFrom: the default, a floor at MIN_CAP, and a valid number', () => {
    expect(AB.capFrom(undefined)).toBe(AB.DEFAULT_CAP);
    expect(AB.capFrom('abc')).toBe(AB.DEFAULT_CAP);
    expect(AB.capFrom(10)).toBe(AB.MIN_CAP);
    expect(AB.capFrom('20000')).toBe(20000);
  });
  it('the section shares add up to the whole cap and cover every section', () => {
    expect(Object.values(AB.SHARES).reduce((x, y) => x + y, 0)).toBeCloseTo(1, 5);
    expect(AB.ORDER.map((o) => o[0]).sort()).toEqual(Object.keys(AB.SHARES).sort());
  });
});

const row = (o: object) => JSON.stringify(o);
const assistant = (content: object[], timestamp = '2026-11-01T10:00:00.000Z') =>
  row({ type: 'assistant', timestamp, message: { role: 'assistant', content } });

describe('transcriptTail', () => {
  const text = [
    row({ type: 'user', message: { role: 'user', content: 'mission text' } }),
    assistant([{ type: 'text', text: 'I changed the lock because the old one raced.' }]),
    assistant([{ type: 'tool_use', name: 'Edit', input: { file_path: 'src/lock.js', old_string: 'x', new_string: 'y' } }]),
    row({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: `secret file body ${GH}` }] } }),
    'not json {',
    assistant([{ type: 'tool_use', name: 'SubagentHandback', input: { message: 'RESULT status=DONE lock fixed' } }]),
  ].join('\n');

  it('keeps assistant text, one line per tool call and the handback; leaves tool output out', () => {
    const t = AB.transcriptTail(text, { fromStart: true });
    expect(t).toContain('assistant (2026-11-01 10:00): I changed the lock because the old one raced.');
    expect(t).toContain('- tool Edit: src/lock.js');
    expect(t).toContain('handback (2026-11-01 10:00): RESULT status=DONE lock fixed');
    expect(t).not.toContain('secret file body');
    expect(t).not.toContain('mission text');
  });

  it('drops the first (partial) line when the text is a byte tail', () => {
    const t = AB.transcriptTail(text.slice(5));
    expect(t).toContain('I changed the lock');
    const cut = AB.transcriptTail(`${assistant([{ type: 'text', text: 'FIRST' }])}\n${assistant([{ type: 'text', text: 'SECOND' }])}`);
    expect(cut).not.toContain('FIRST');
    expect(cut).toContain('SECOND');
  });
});

describe('taskLog', () => {
  it('lists times, result, remarks, owner questions with answers and the changelog entries for the task only', () => {
    const o = {
      id: 'A-1',
      started: '2026-11-01T09:00:00Z',
      result: { line: 'RESULT status=DONE' },
      remarks: ['2026-11-01 note one'],
      waiting_on: ['q1'],
    };
    const queue = {
      question: { q1: { text: 'Keep the old lock?' }, q2: { text: 'About A-1 too' }, q3: { text: 'About A-12 only' } },
      resolutions: { q1: { answer: 'No, replace it', time: '2026-11-01T09:30:00Z', by: 'owner' } },
      changelog: [
        { nr: 4, at: '2026-11-01T09:10:00Z', by: 'owner', action: 'edit', changes: [{ id: 'A-1', field: 'value', before: 5, after: 8 }] },
        { nr: 5, at: '2026-11-01T09:11:00Z', by: 'owner', action: 'edit', changes: [{ id: 'B-2', field: 'value', before: 5, after: 8 }] },
      ],
    };
    const t = AB.taskLog(o, queue);
    expect(t).toContain('- started: 2026-11-01T09:00:00Z');
    expect(t).toContain('- result: RESULT status=DONE');
    expect(t).toContain('- remark: 2026-11-01 note one');
    expect(t).toContain('- question q1: Keep the old lock?');
    expect(t).toContain('answer (2026-11-01T09:30:00Z, by owner): No, replace it');
    expect(t).toContain('- question q2: About A-1 too');
    expect(t).toContain('answer: none recorded');
    expect(t).not.toContain('q3');
    expect(t).toContain('changelog #4');
    expect(t).not.toContain('changelog #5');
  });
});

describe('buildBundle', () => {
  it('has every section in order, says why a part is missing, redacts, and stays under the cap', () => {
    const b = AB.buildBundle({
      id: 'A-1',
      question: 'Why the lock?',
      maxChars: 8000,
      now: '2026-11-02T00:00:00.000Z',
      parts: {
        task: { text: '- id: A-1' },
        report: { text: `RESULT status=DONE\n${'r'.repeat(5000)}\nkey ${GH}\nEND OF REPORT`, source: '/s/A-1/report.md' },
        transcript: { text: 'x'.repeat(20000) + 'LAST LINE' },
        git: { missing: 'no branch' },
      },
    });
    expect(b.chars).toBeLessThanOrEqual(8000);
    expect(b.text).toContain('Question: Why the lock?');
    expect(b.text).toContain('(none: no branch)');
    expect(b.text).toContain('Source: /s/A-1/report.md');
    expect(b.text).toContain('RESULT status=DONE');
    expect(b.text).toContain('END OF REPORT');
    expect(b.text).toContain('LAST LINE');
    expect(b.text).not.toContain(GH);
    expect(b.redactions).toBe(1);
    const names = b.sections.map((s) => s.name);
    expect(names).toEqual(AB.ORDER.map((o) => o[0]));
    expect(b.sections.find((s) => s.name === 'transcript')!.truncated).toBe(true);
    expect(b.sections.find((s) => s.name === 'mission')!.missing).toBe('not found');
    const at = (h: string) => b.text.indexOf(h);
    expect(at('## Task')).toBeLessThan(at('## Mission'));
    expect(at('## Git')).toBeLessThan(at('## Transcript tail'));
  });

  it('the answer instruction asks for one paragraph, references and "unknown"', () => {
    const t = AB.answerInstruction('A-1', 'Why?').join('\n');
    expect(t).toContain('ONE paragraph');
    expect(t).toContain('"unknown"');
    expect(t).toContain('Do not resume the track agent');
  });
});

describe('the ask agent file', () => {
  it('is read-only and never asks to dig up redacted values', () => {
    const s = fs.readFileSync(path.join(ROOT, 'agents', 'ask.md'), 'utf8');
    expect(s).toMatch(/^tools: Read, Grep, Glob, Bash\s*$/m);
    expect(s).toMatch(/never start other\s+agents/i);
    expect(s).toContain('`unknown`');
    const scan = S.scanHelper ?? S.scan;
    if (scan) expect(scan(s).level).not.toBe('red');
  });
});

describe('queue.mjs ask (end to end)', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-ask-'));
  temporary.push(folder);
  const repo = path.join(folder, 'repo');
  const scratch = path.join(folder, 'scratch');
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, '-c', 'user.name=queue-test', '-c', 'user.email=queue-test@example.invalid', ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  fs.mkdirSync(repo);
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  git('add', 'a.txt');
  git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'queue/A');
  fs.writeFileSync(path.join(repo, 'lock.js'), 'lock\n');
  git('add', 'lock.js');
  git('commit', '-q', '-m', 'A: new lock', '-m', 'The old lock raced under load.');
  git('checkout', '-q', 'main');

  fs.writeFileSync(
    path.join(folder, 'queue.json'),
    JSON.stringify({
      created: '2026-10-01T00:00:00.000Z',
      limits: {},
      resolved: [],
      question: { q1: { text: 'Keep the old lock?' } },
      resolutions: { q1: { answer: 'Replace it', time: '2026-11-01T09:30:00Z', by: 'owner' } },
      tasks: [
        {
          id: 'A',
          title: 'Replace the lock',
          domain: 'dom',
          class: 'K',
          status: 'review',
          branch: 'queue/A',
          started: '2026-11-01T09:00:00.000Z',
          mission: 'Replace the racing lock.',
          value: 5,
          remarks: ['first remark'],
          waiting_on: ['q1'],
        },
        { id: 'B', title: 'Other', domain: 'dom', class: 'K', status: 'waiting', mission: 'x', value: 5 },
      ],
    }),
  );
  const configFile = path.join(folder, 'queue.config.json');
  fs.writeFileSync(configFile, JSON.stringify({}));
  fs.mkdirSync(path.join(scratch, 'A'), { recursive: true });
  fs.writeFileSync(path.join(scratch, 'A', 'report.md'), `RESULT status=DONE lock replaced\nUsed key ${GH} in a test.\n`);
  fs.writeFileSync(path.join(scratch, 'A', 'handover.md'), 'Nothing left.\n');
  const transcripts = path.join(folder, 'transcripts');
  fs.mkdirSync(path.join(transcripts, 'sess1', 'subagents'), { recursive: true });
  fs.writeFileSync(
    path.join(transcripts, 'sess1', 'subagents', 'agent-abc123.jsonl'),
    [
      row({ type: 'user', message: { role: 'user', content: 'Track A' } }),
      assistant([{ type: 'text', text: 'Chose a mutex because the old lock raced.' }]),
      row({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'TOOL OUTPUT BODY' }] } }),
    ].join('\n') + '\n',
  );
  const timeLog = path.join(folder, 'times.jsonl');
  fs.writeFileSync(
    timeLog,
    row({
      time: '2026-11-01T10:00:00.000Z',
      event: 'done',
      agent_id: 'abc123',
      agent_type: 'track',
      track: 'A',
      tokens: { input: 10, output: 10, cache_read: 0, cache_written: 0 },
    }) + '\n',
  );
  const env = {
    ...process.env,
    QUEUE_FOLDER: folder,
    QUEUE_CONFIG: configFile,
    QUEUE_ROOT: folder,
    QUEUE_GIT: repo,
    QUEUE_TIME_LOG: timeLog,
    QUEUE_TRANSCRIPTS: transcripts,
    QUEUE_SCRATCHPAD: scratch,
  };
  const run = (...args: string[]) => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'orchestrator', 'queue.mjs'), ...args], { encoding: 'utf8', env });
    return { code: r.status, out: r.stdout ?? '', error: r.stderr ?? '' };
  };
  const queueBefore = fs.readFileSync(path.join(folder, 'queue.json'), 'utf8');
  const timeLogBefore = fs.readFileSync(timeLog, 'utf8');

  it('prints the bundle with every part and the answer instruction, redacted, and changes nothing', () => {
    const r = run('ask', 'A', 'Why', 'the', 'mutex?');
    expect(r.error).toBe('');
    expect(r.code).toBe(0);
    for (const s of [
      'Question: Why the mutex?',
      'Replace the racing lock.',
      'RESULT status=DONE lock replaced',
      'Nothing left.',
      '- remark: first remark',
      'answer (2026-11-01T09:30:00Z, by owner): Replace it',
      'A: new lock',
      'The old lock raced under load.',
      'lock.js',
      'Chose a mutex because the old lock raced.',
      'agent abc123 (track)',
      'ONE paragraph',
    ])
      expect(r.out).toContain(s);
    expect(r.out).not.toContain(GH);
    expect(r.out).not.toContain('TOOL OUTPUT BODY');
    expect(fs.readFileSync(path.join(folder, 'queue.json'), 'utf8')).toBe(queueBefore);
    expect(fs.readFileSync(timeLog, 'utf8')).toBe(timeLogBefore);
  }, 60_000);

  it('--bundle writes the file in the scratchpad and prints its path; --json describes it', () => {
    const r = run('ask', 'A', 'Why?', '--bundle', '--json');
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out) as { ok: boolean; path: string; chars: number; redactions: number; sections: Section[]; bundle?: string };
    expect(j.ok).toBe(true);
    expect(path.resolve(j.path)).toBe(path.resolve(scratch, 'ask-A', 'bundle.md'));
    expect(j.bundle).toBeUndefined();
    expect(j.redactions).toBe(1);
    const text = fs.readFileSync(j.path, 'utf8');
    expect(text.length).toBe(j.chars);
    expect(text).not.toContain(GH);
    expect(j.sections.filter((s) => s.missing)).toEqual([]);

    const plain = run('ask', 'A', '--bundle', '--max-chars', '5000');
    expect(plain.code).toBe(0);
    expect(path.resolve(plain.out.split(/\r?\n/)[0])).toBe(path.resolve(scratch, 'ask-A', 'bundle.md'));
    expect(fs.readFileSync(path.join(scratch, 'ask-A', 'bundle.md'), 'utf8').length).toBeLessThanOrEqual(5000);
  }, 60_000);

  it('a task with nothing left behind still gets a bundle that says what is missing', () => {
    const r = run('ask', 'B', '--json');
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out) as { sections: Section[]; bundle: string };
    const missing = j.sections.filter((s) => s.missing).map((s) => s.name);
    expect(missing).toEqual(expect.arrayContaining(['report', 'handover', 'git', 'transcript']));
    expect(j.bundle).toContain('(none: no agent for this task in the time log)');
  }, 60_000);

  it('an unknown id or a missing id is an error (exit 1), also as JSON', () => {
    expect(run('ask', 'NOPE').code).toBe(1);
    const j = run('ask', 'NOPE', '--json');
    expect(j.code).toBe(1);
    expect(JSON.parse(j.out)).toEqual({ ok: false, error: 'Unknown task NOPE' });
    expect(run('ask').code).toBe(1);
  }, 60_000);
});
