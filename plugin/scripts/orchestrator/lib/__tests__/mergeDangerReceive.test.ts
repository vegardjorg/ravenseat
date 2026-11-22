// =============================================================
// mergeDangerReceive.test.ts: `ravenseat receive` reads the door and blast radius lines of a track report (MS-1).
//
// Locks: receive prints one DOOR line, stores merge_danger on the task and writes the section in 00-package.md; a report
// without the lines is "not stated", and the delivery still goes to review (never a refusal, never a stop). Runs
// queue.mjs against a temporary queue and git repo (as decisionSignals.test.ts), never the main repo or the real queue.
// =============================================================
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const ID = ['-c', 'user.name=queue-test', '-c', 'user.email=queue-test@example.invalid'];
const temporary: string[] = [];
afterAll(() => {
  for (const m of temporary) fs.rmSync(m, { recursive: true, force: true });
});

/** A queue with task A on queue/A, which changes one file; `report` is the track's track-result.md. */
const setup = (report: string) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-mdg-'));
  temporary.push(folder);
  const repo = path.join(folder, 'repo');
  const scratch = path.join(folder, 'scratch');
  fs.mkdirSync(repo);
  fs.mkdirSync(scratch);
  const g = (args: string[]) =>
    execFileSync('git', ['-C', repo, ...ID, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const put = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), text);
    g(['add', '--', file]);
  };
  g(['init', '-q', '-b', 'main']);
  put('src/a.js', 'module.exports = 1;\n');
  g(['commit', '-q', '-m', 'start']);
  g(['switch', '-q', '-c', 'queue/A']);
  put('src/a.js', 'module.exports = 2;\n');
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
    owned_files: ['src/a.js'],
    started: '2026-01-01T00:00:00.000Z',
    branch: 'queue/A',
    migr_block: null,
    scratchpad: scratch,
  };
  fs.writeFileSync(
    path.join(folder, 'queue.json'),
    JSON.stringify({ created: task.started, limits: {}, next_migr: 3600, resolved: [], tasks: [task] }),
  );
  const configFile = path.join(folder, 'queue.config.json');
  fs.writeFileSync(configFile, '{}');
  fs.mkdirSync(path.join(scratch, 'A'), { recursive: true });
  fs.writeFileSync(path.join(scratch, 'A', 'track-result.md'), report);
  const env = {
    ...process.env,
    QUEUE_FOLDER: folder,
    QUEUE_CONFIG: configFile,
    QUEUE_ROOT: folder,
    QUEUE_GIT: repo,
    QUEUE_TIME_LOG: path.join(folder, 'times.jsonl'),
    QUEUE_TRANSCRIPTS: path.join(folder, 'transcripts'),
  } as NodeJS.ProcessEnv;
  delete env.QUEUE_SCRATCHPAD;
  delete env.QUEUE_SESSION;
  const receive = () =>
    spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'orchestrator', 'queue.mjs'), 'receive', 'A'], { encoding: 'utf8', env, cwd: folder });
  const task0 = () => JSON.parse(fs.readFileSync(path.join(folder, 'queue.json'), 'utf8')).tasks[0];
  return { receive, task0 };
};

const RESULT = 'RESULT status=DONE branch=queue/A commits=1 migr=- gates=OK probe=- ownerQuestions=0 edge=-\n\n';

describe('queue.mjs receive with door and blast radius', () => {
  it('prints the DOOR line, stores the record and writes the package section', () => {
    const m = setup(`${RESULT}## Assumptions\nnone\n\nDoor: one-way\nBlast radius: data\n`);
    const r = m.receive();
    expect(r.stderr ?? '').toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("DOOR: A: one-way door, blast radius data (the track's call; nothing is blocked or approved by it).");
    const t = m.task0();
    expect(t.status).toBe('review');
    expect(t.merge_danger).toMatchObject({ door: 'one-way', blast: 'data' });
    const pack = fs.readFileSync(path.join(t.review_package, '00-package.md'), 'utf8');
    expect(pack).toMatch(/## Door and blast radius/);
    expect(pack).toMatch(/^- Door: one-way$/m);
    expect(pack).toMatch(/^- Blast radius: data$/m);
  });

  it('a report without the lines is not stated, and the delivery still goes to review', () => {
    const m = setup(RESULT);
    const r = m.receive();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('DOOR: A: door not stated, blast radius not stated');
    const t = m.task0();
    expect(t.status).toBe('review');
    expect(t.merge_danger).toMatchObject({ door: null, blast: null });
    expect(fs.readFileSync(path.join(t.review_package, '00-package.md'), 'utf8')).toMatch(/^- Door: not stated$/m);
  });
});
