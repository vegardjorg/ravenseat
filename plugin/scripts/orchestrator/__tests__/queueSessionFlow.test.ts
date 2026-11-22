// =============================================================
// queueSessionFlow.test.ts: the queue-start and queue-idle rows end to end (AW-5).
//
// Locks: `ravenseat fill` writes one queue-start row to the time log, a second fill writes none; `ravenseat
// pulse-check` that answers SILENT with no running track writes one queue-idle row, and a second SILENT pulse none; the
// next fill opens a new session. A pulse-check on a queue that was never started writes nothing (pulseCheckFlow.test.ts
// keeps that the only file changed is the orchestrator marker).
// Runs ravenseat.mjs against a temporary queue and repo. Never the main repo.
// =============================================================
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const RAVENSEAT = path.resolve(__dirname, '..', 'ravenseat.mjs');
const ID = ['-c', 'user.name=queue-test', '-c', 'user.email=queue-test@example.invalid'];
const OLD_ISO = new Date(Date.now() - 3 * 3600_000).toISOString();

const temporary: string[] = [];
afterAll(() => {
  for (const m of temporary) fs.rmSync(m, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
});

function project() {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-session-'));
  temporary.push(folder);
  const repo = path.join(folder, 'repo');
  const scratch = path.join(folder, 'scratch');
  fs.mkdirSync(repo);
  fs.mkdirSync(scratch);
  const g = (args: string[]) =>
    execFileSync('git', ['-C', repo, ...ID, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_COMMITTER_DATE: OLD_ISO, GIT_AUTHOR_DATE: OLD_ISO },
    });
  g(['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(repo, 'README.md'), 'start\n');
  g(['add', '--', 'README.md']);
  g(['commit', '-q', '-m', 'start']);
  fs.writeFileSync(
    path.join(folder, 'queue.json'),
    JSON.stringify({ created: OLD_ISO, limits: {}, next_migr: 3600, resolved: [], tasks: [] }, null, 2),
  );
  const configFile = path.join(folder, 'queue.config.json');
  fs.writeFileSync(configFile, JSON.stringify({ baseBranch: 'main' }));
  const timeLog = path.join(folder, 'times.jsonl');
  const env = {
    ...process.env,
    QUEUE_FOLDER: folder,
    QUEUE_CONFIG: configFile,
    QUEUE_ROOT: folder,
    QUEUE_GIT: repo,
    QUEUE_TIME_LOG: timeLog,
    QUEUE_TRANSCRIPTS: path.join(folder, 'transcripts'),
  } as NodeJS.ProcessEnv;
  delete env.QUEUE_SCRATCHPAD;
  delete env.QUEUE_SESSION;
  const run = (...args: string[]) => {
    const r = spawnSync(process.execPath, [RAVENSEAT, ...args], { encoding: 'utf8', env, cwd: folder });
    return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
  };
  /** The queue-start and queue-idle rows in the time log, in order. */
  const sessionRows = () => {
    if (!fs.existsSync(timeLog)) return [];
    return fs
      .readFileSync(timeLog, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((r) => r.event === 'queue-start' || r.event === 'queue-idle');
  };
  return { folder, scratch, run, sessionRows };
}

describe('queue-start and queue-idle rows', () => {
  it('a pulse on a queue that was never started writes no row', () => {
    const p = project();
    expect(p.run('pulse-check').out).toBe('SILENT\n');
    expect(p.sessionRows()).toEqual([]);
  });

  it('fill opens a session once, a SILENT pulse with nothing running closes it once, the next fill opens a new one', () => {
    const p = project();
    p.run('fill', '--scratchpad', p.scratch);
    p.run('fill', '--scratchpad', p.scratch);
    let rows = p.sessionRows();
    expect(rows.map((r) => r.event)).toEqual(['queue-start']);
    expect(rows[0]).toMatchObject({ command: 'fill', running: 0 });

    expect(p.run('pulse-check').out).toBe('SILENT\n');
    expect(p.run('pulse-check').out).toBe('SILENT\n');
    rows = p.sessionRows();
    expect(rows.map((r) => r.event)).toEqual(['queue-start', 'queue-idle']);
    expect(rows[1].since).toBe(rows[0].time);
    expect(typeof rows[1].duration_s).toBe('number');

    p.run('fill', '--scratchpad', p.scratch);
    expect(p.sessionRows().map((r) => r.event)).toEqual(['queue-start', 'queue-idle', 'queue-start']);
  }, 60_000);
});
