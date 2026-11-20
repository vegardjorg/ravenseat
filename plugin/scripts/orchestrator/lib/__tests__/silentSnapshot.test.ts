// =============================================================
// silentSnapshot.test.ts: the evidence snapshot written when a track turns SILENT (lib/silentSnapshot.js, roadmap 0y Y4).
//
// Why: a SILENT track is looked at long after it hung, and by then the evidence (what the agent did last, the
// background job it waited on, the process that hung) is gone. The snapshot keeps it in one local, capped file. The
// rules tested here: redaction BEFORE writing (key/token/password arguments, env assignments, URL credentials, inline
// scripts dropped when unsure), the transcript tail, the background jobs that never reported back, the process filter,
// the size cap, one file per silence and the retention. Then queue.mjs show end to end against a temporary repo.
// All values are harmless fakes.
// =============================================================
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* eslint-disable @typescript-eslint/no-require-imports */
const S = require('../silentSnapshot');

const temporary: string[] = [];
afterAll(() => {
  for (const m of temporary) fs.rmSync(m, { recursive: true, force: true });
});
const tmp = (prefix: string) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporary.push(d);
  return d;
};

const R = '[redacted]';

describe('redaction before writing (harmless fake values)', () => {
  it('a flag named like a key, token, secret or password loses its value, joined or as the next argument', () => {
    expect(S.redactCommand('node tool.mjs --token=FAKE_VALUE_123 --out dist')).toBe(`node tool.mjs --token=${R} --out dist`);
    expect(S.redactCommand('cli login --password not-a-real-pass --user tester')).toBe(`cli login --password ${R} --user tester`);
    expect(S.redactCommand('cli --api-key FAKEKEY --client-secret=FAKE2')).toBe(`cli --api-key ${R} --client-secret=${R}`);
  });

  it('an env assignment keeps its name and loses its value', () => {
    expect(S.redactCommand('MY_SETTING=fake-value node run.mjs')).toBe(`MY_SETTING=${R} node run.mjs`);
    expect(S.redactCommand('env A=1 B=two node x.js')).toBe(`env A=${R} B=${R} node x.js`);
  });

  it('a URL loses its user info and its query string, the host and path stay', () => {
    expect(S.redactCommand('git clone https://someone:fakepass@example.invalid/repo.git')).toBe(
      `git clone https://${R}@example.invalid/repo.git`,
    );
    expect(S.redactCommand('curl https://example.invalid/api?k=fake&x=1')).toBe(`curl https://example.invalid/api?${R}`);
  });

  it('an inline script (-e, -c, -Command, --eval) is dropped whole: unsure means drop', () => {
    expect(S.redactCommand('node -e "console.log(1)"')).toBe(`node -e ${R}`);
    expect(S.redactCommand('bash -c "echo hello"')).toBe(`bash -c ${R}`);
    expect(S.redactCommand('powershell -NoProfile -Command "Get-Date"')).toBe(`powershell -NoProfile -Command ${R}`);
  });

  it('a long token-like argument is dropped; paths, words and short ids stay', () => {
    const fake = 'fake1fake2fake3fake4fake5fake6fake7';
    expect(S.redactCommand(`tool ${fake}`)).toBe(`tool ${R}`);
    expect(S.redactCommand('node C:/work/tree/plugin/scripts/orchestrator/queue.mjs show --full')).toBe(
      'node C:/work/tree/plugin/scripts/orchestrator/queue.mjs show --full',
    );
    expect(S.redactCommand('git log -1 --format=%ct refs/heads/queue/A')).toBe('git log -1 --format=%ct refs/heads/queue/A');
  });

  it('free text (the transcript tail) gets the same treatment', () => {
    const t = S.redactText('set password=not-a-real-pass then Authorization: Bearer FAKE_BEARER and https://u:p@example.invalid/x');
    expect(t).not.toContain('not-a-real-pass');
    expect(t).not.toContain('FAKE_BEARER');
    expect(t).not.toContain('u:p@');
    expect(t).toContain('example.invalid/x');
  });
});

/** A transcript row as JSON text. */
const row = (o: object) => JSON.stringify({ timestamp: '2026-11-20T03:00:00.000Z', ...o });
const use = (id: string, name: string, input: object) =>
  row({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const result = (id: string, text: string) =>
  row({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] } });
const said = (text: string) => row({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const user = (text: string) => row({ type: 'user', message: { role: 'user', content: text } });

const TRANSCRIPT = [
  user('the mission'),
  said('Starting the tests in the background.'),
  use('tu1', 'Bash', { command: 'npm test', run_in_background: true }),
  result('tu1', 'Command running in background with ID: job1. Output is being written to: out1'),
  use('tu2', 'Bash', { command: 'node build.mjs --token=FAKE_VALUE_123', run_in_background: true }),
  result('tu2', 'Command running in background with ID: job2. Output is being written to: out2'),
  use('tu3', 'Read', { file_path: 'lib/a.js' }),
  result('tu3', 'file text'),
  user('<task-notification>\n<task-id>job1</task-id>\n<status>completed</status>\n</task-notification>'),
  said('Waiting for the build.'),
].join('\n');

describe('the transcript: tail and background jobs', () => {
  it('lists the background jobs that never reported back, with the command redacted', () => {
    const jobs = S.openBackgroundJobs(TRANSCRIPT);
    expect(jobs.map((j: { id: string }) => j.id)).toEqual(['job2']);
    expect(jobs[0].command).toBe(`node build.mjs --token=${R}`);
    expect(jobs[0].tool).toBe('Bash');
  });

  it('the tail keeps the newest rows, one short redacted line each', () => {
    const tail = S.transcriptTail(TRANSCRIPT, { maxRows: 4 });
    expect(tail).toHaveLength(4);
    expect(tail[tail.length - 1]).toMatch(/assistant: Waiting for the build\./);
    expect(tail.join('\n')).toContain('Read lib/a.js');
    expect(S.transcriptTail(TRANSCRIPT, { maxRows: 50 }).join('\n')).not.toContain('FAKE_VALUE_123');
  });

  it('a broken row or an empty transcript gives no crash', () => {
    expect(S.transcriptTail('{not json\n')).toEqual([]);
    expect(S.openBackgroundJobs('')).toEqual([]);
  });
});

describe('the worktree path in every form a command line can use (Windows short names)', () => {
  // On a CI runner the temp folder is C:\Users\RUNNER~1\... in a command line, while git reports the worktree as
  // C:/Users/runneradmin/...: the filter must treat both as the same folder.
  it('pathForms adds the 8.3 short form the platform reports, without duplicates', () => {
    const long = 'C:/Users/runneradmin/AppData/Local/Temp/q/wt-A';
    const forms = S.pathForms(long, { platform: 'win32', short: () => 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\q\\wt-A', real: (p: string) => p });
    expect(forms).toContain(long);
    expect(forms).toContain('C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\q\\wt-A');
    expect(S.pathForms(long, { platform: 'linux', short: () => 'x', real: (p: string) => p })).toEqual([long]);
    expect(S.pathForms(null)).toEqual([]);
  });

  it('a process that names the short form is found', () => {
    const list = [{ pid: 10, ppid: 1, name: 'node', cmd: 'node C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\q\\wt-A\\run.mjs' }];
    const needles = S.pathForms('C:/Users/runneradmin/AppData/Local/Temp/q/wt-A', {
      platform: 'win32',
      short: () => 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\q\\wt-A',
      real: (p: string) => p,
    });
    expect(S.relevantProcesses(list, { needles }).map((p: any) => p.pid)).toEqual([10]);
  });
});

describe('the processes: only those that name the worktree or the branch, and their children', () => {
  const list = [
    { pid: 10, ppid: 1, name: 'node', cmd: 'node C:\\work\\wt-A\\run.mjs --api-key FAKEKEY' },
    { pid: 11, ppid: 10, name: 'git', cmd: 'git status' },
    { pid: 12, ppid: 11, name: 'cat', cmd: 'cat x' },
    { pid: 20, ppid: 1, name: 'editor', cmd: 'editor C:\\other\\file.txt' },
    { pid: 30, ppid: 1, name: 'git', cmd: 'git log refs/heads/queue/A' },
  ];
  it('matches the worktree path in either slash direction, the branch, and their descendants; redacts each', () => {
    const got = S.relevantProcesses(list, { needles: ['C:/work/wt-A', 'queue/A'] });
    expect(got.map((p: { pid: number }) => p.pid)).toEqual([10, 11, 12, 30]);
    expect(got[0].cmd).toBe(`node C:\\work\\wt-A\\run.mjs --api-key ${R}`);
  });
  it('caps the count', () => {
    expect(S.relevantProcesses(list, { needles: ['C:/work/wt-A'], max: 2 })).toHaveLength(2);
  });
});

describe('writing: cap, one file per silence, retention, gitignored folder', () => {
  const base = {
    id: 'A',
    branch: 'queue/A',
    last_activity: '2026-11-20T02:00:00.000Z',
    silent_ms: 3_600_000,
    worktree: 'C:/work/wt-A',
    agent: 'agent1',
    tail: ['03:00:00 assistant: hello'],
    jobs: [{ id: 'job2', tool: 'Bash', time: '2026-11-20T03:00:00.000Z', command: 'node build.mjs' }],
    processes: [{ pid: 10, ppid: 1, name: 'node', cmd: 'node run.mjs' }],
    processNote: null,
    now: Date.parse('2026-11-20T03:00:00.000Z'),
  };

  it('the text has the three parts and stays under the cap, the oldest tail rows left out first', () => {
    const text = S.snapshotText(base, { maxKB: 64 });
    expect(text).toContain('SILENT');
    expect(text).toMatch(/Transcript tail/);
    expect(text).toMatch(/Background jobs that never reported back \(1\)/);
    expect(text).toMatch(/Processes .*\(1/);
    const many = Array.from({ length: 2000 }, (_, i) => `03:00:00 assistant: row ${i} ${'x'.repeat(80)}`);
    const capped = S.snapshotText({ ...base, tail: many }, { maxKB: 8 });
    expect(Buffer.byteLength(capped, 'utf8')).toBeLessThanOrEqual(8 * 1024);
    expect(capped).toContain('row 1999');
    expect(capped).not.toContain('row 0 ');
    expect(capped).toMatch(/older rows left out/);
  });

  it('writes one file per silence (the same silence again reuses it) and keeps the newest N', () => {
    const dir = path.join(tmp('snap-'), 'silent-snapshots');
    const p1 = S.writeSnapshot(dir, base, { keep: 2, maxKB: 64 });
    expect(fs.existsSync(p1)).toBe(true);
    expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')).toMatch(/^\*/);
    expect(S.writeSnapshot(dir, base, { keep: 2, maxKB: 64 })).toBe(p1);
    const later = (h: number) => ({ ...base, last_activity: `2026-11-20T0${h}:30:00.000Z` });
    const p2 = S.writeSnapshot(dir, later(3), { keep: 2, maxKB: 64 });
    fs.utimesSync(p1, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    const p3 = S.writeSnapshot(dir, later(4), { keep: 2, maxKB: 64 });
    const left = fs.readdirSync(dir).filter((f) => f.endsWith('.txt')).sort();
    expect(left).toEqual([path.basename(p2), path.basename(p3)].sort());
  });

  it('settings: on by default, keep and maxKB with sane fallbacks', () => {
    expect(S.settingsFrom({})).toEqual({ enabled: true, keep: 20, maxKB: 64 });
    expect(S.settingsFrom({ silentSnapshot: { enabled: false } }).enabled).toBe(false);
    expect(S.settingsFrom({ silentSnapshot: { keep: -1, maxKB: 'x' } })).toEqual({ enabled: true, keep: 20, maxKB: 64 });
  });
});

describe('queue.mjs show writes the snapshot and names it on the SILENT line (against a temporary repo)', () => {
  const ID = ['-c', 'user.name=queue-test', '-c', 'user.email=queue-test@example.invalid'];
  it('one snapshot per silence, redacted, and none with silentSnapshot.enabled false', () => {
    const folder = tmp('queue-snap-');
    const repo = path.join(folder, 'repo');
    fs.mkdirSync(repo);
    const oldMs = Date.now() - 3 * 3600_000;
    const oldIso = new Date(oldMs).toISOString();
    const g = (args: string[]) =>
      execFileSync('git', ['-C', repo, ...ID, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, GIT_COMMITTER_DATE: oldIso, GIT_AUTHOR_DATE: oldIso },
      }).trim();
    g(['init', '-q', '-b', 'main']);
    fs.writeFileSync(path.join(repo, 'README.md'), 'start\n');
    g(['add', '--', 'README.md']);
    g(['commit', '-q', '-m', 'start']);
    const wt = path.join(folder, 'wt-A');
    g(['worktree', 'add', '-q', '-b', 'queue/A', wt]);
    const age = (p: string) => {
      for (const e of fs.readdirSync(p, { withFileTypes: true })) {
        const q = path.join(p, e.name);
        if (e.isDirectory()) age(q);
        fs.utimesSync(q, oldMs / 1000, oldMs / 1000);
      }
      fs.utimesSync(p, oldMs / 1000, oldMs / 1000);
    };
    age(wt);
    // The agent's transcript and its time log rows (old, like the rest).
    const transcripts = path.join(folder, 'transcripts');
    const sub = path.join(transcripts, 'session1', 'subagents');
    fs.mkdirSync(sub, { recursive: true });
    const tfile = path.join(sub, 'agent-agentA.jsonl');
    fs.writeFileSync(tfile, `${TRANSCRIPT}\n`);
    fs.utimesSync(tfile, oldMs / 1000, oldMs / 1000);
    fs.writeFileSync(
      path.join(folder, 'times.jsonl'),
      `${JSON.stringify({ time: oldIso, event: 'start', agent_id: 'agentA', track: 'A', agent_type: 'track' })}\n`,
    );
    // A fake process list (the seam QUEUE_SNAPSHOT_PROCESSES), so the test never lists the machine's processes.
    const procs = path.join(folder, 'procs.json');
    fs.writeFileSync(
      procs,
      JSON.stringify([
        { pid: 10, ppid: 1, name: 'node', cmd: `node ${wt}${path.sep}run.mjs --password not-a-real-pass` },
        { pid: 20, ppid: 1, name: 'editor', cmd: 'editor elsewhere.txt' },
      ]),
    );
    fs.writeFileSync(
      path.join(folder, 'queue.json'),
      JSON.stringify({
        created: oldIso,
        limits: {},
        next_migr: 3600,
        resolved: [],
        tasks: [
          {
            id: 'A', title: 'Task A', domain: 'dom-a', class: 'K', status: 'running', branch: 'queue/A', started: oldIso,
            value: 5, content_min: 60, migr_tens: 0, depends_on: [], waiting_on: [], owned_files: ['lib/A.ts'],
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
      QUEUE_TRANSCRIPTS: transcripts,
      QUEUE_SNAPSHOT_PROCESSES: procs,
    };
    const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
    const run = (...args: string[]) => {
      const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'orchestrator', 'queue.mjs'), ...args], {
        encoding: 'utf8',
        env,
      });
      return { out: r.stdout ?? '', error: r.stderr ?? '' };
    };
    const snapDir = path.join(folder, 'silent-snapshots');
    const files = () => (fs.existsSync(snapDir) ? fs.readdirSync(snapDir).filter((f) => f.endsWith('.txt')) : []);

    const show = run('show');
    expect(show.error).toBe('');
    expect(show.out.split('\n')[0]).toMatch(/^SILENT \(1\)/);
    expect(files()).toHaveLength(1);
    const file = path.join(snapDir, files()[0]);
    expect(show.out).toContain(`evidence: ${file}`);
    const text = fs.readFileSync(file, 'utf8');
    expect(text).toContain('job2');
    expect(text).not.toContain('job1 ');
    expect(text).toContain('Waiting for the build.');
    expect(text).toContain('run.mjs --password [redacted]');
    expect(text).not.toContain('not-a-real-pass');
    expect(text).not.toContain('FAKE_VALUE_123');
    expect(text).not.toContain('elsewhere.txt');
    // The pulse names it too, and the same silence writes no second file.
    expect(run('pulse-check', '--session', 'test', '--scratchpad', folder).out).toContain(`Evidence: ${file}`);
    expect((JSON.parse(run('state').out) as { silent: { snapshot?: string }[] }).silent[0].snapshot).toBe(file);
    expect(files()).toHaveLength(1);

    // Off: nothing written and no evidence line.
    fs.rmSync(snapDir, { recursive: true, force: true });
    fs.writeFileSync(configFile, JSON.stringify({ silentSnapshot: { enabled: false } }));
    const off = run('show');
    expect(off.out.split('\n')[0]).toMatch(/^SILENT \(1\)/);
    expect(off.out).not.toContain('evidence:');
    expect(files()).toHaveLength(0);
  });
});
