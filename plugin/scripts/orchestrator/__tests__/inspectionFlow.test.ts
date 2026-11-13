// =============================================================
// inspectionFlow.test.ts: the inspection queue and the guard registry end to end, with the real gates.mjs and queue.mjs.
//
// Locks: (1) the same red gate command in two tracks gives the same short excerpt in the time log, and never a secret;
// (2) `ravenseat inspection` makes ONE proposal for it (INSP-1, proposed, never auto-accepted, to the batch queue), and
// a second scan adds nothing; (3) the owner's cancel makes the entry rejected, and no new proposal follows; (4) snooze
// cancels the task and holds the entry; (5) a built task: `guards add --from-task` writes the tracked registry with the
// signature, and `guards --json` fills the measures from the gate rows; (6) the pulse proposes by itself, once an hour;
// (7) inspection.mode off: no scan and no proposal.
// The pure rules are in lib/__tests__/inspection.test.ts, lib/__tests__/guardRegistry.test.ts and
// lib/__tests__/failureSignature.test.ts.
// =============================================================
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

const HERE = path.resolve(__dirname, '..');
const GATES = path.join(HERE, 'gates.mjs');
const QUEUE = path.join(HERE, 'queue.mjs');
const ID = ['-c', 'user.name=queue-test', '-c', 'user.email=queue-test@example.invalid'];
const SECRET = `ghp_${'c'.repeat(40)}`;

const temporary: string[] = [];
afterAll(() => {
  for (const m of temporary) {
    try {
      fs.rmSync(m, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    } catch {
      /* left for the OS */
    }
  }
});

/** A red gate command: the same error each time, with a path, a line number and a secret in the output. */
const FAIL = `
console.log('running the sample checks');
console.log('TOKEN=${SECRET}');
console.error('Error: sample value missing in ' + __filename + ':12:5');
process.exit(1);
`;

type Task = { id: string; status: string; added_by?: string; batched?: boolean; title?: string };

function project(config: Record<string, unknown> = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'inspection-flow-'));
  temporary.push(folder);
  const repo = path.join(folder, 'repo');
  const data = path.join(folder, 'data');
  const tempBase = path.join(folder, 'temp');
  for (const d of [repo, data, tempBase]) fs.mkdirSync(d);
  const g = (args: string[]) => execFileSync('git', ['-C', repo, ...ID, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  g(['init', '-q', '-b', 'develop']);
  fs.writeFileSync(path.join(repo, 'fail.cjs'), FAIL);
  g(['add', '--', 'fail.cjs']);
  g(['commit', '-q', '-m', 'start']);
  const configFile = path.join(folder, 'queue.config.json');
  fs.writeFileSync(
    configFile,
    JSON.stringify({ baseBranch: 'develop', gates: { quick: ['node fail.cjs'] }, loadGuard: { minFreeMemoryPct: 10 }, ...config }),
  );
  fs.writeFileSync(
    path.join(data, 'queue.json'),
    JSON.stringify({ created: '2026-01-01T00:00:00.000Z', limits: {}, next_migr: 3600, resolved: [], projects: { app: { title: 'App', prefixes: ['A-'] } }, tasks: [] }),
  );
  const timeLog = path.join(folder, 'time.jsonl');
  const env: Record<string, string | undefined> = {
    ...process.env,
    QUEUE_FOLDER: data,
    QUEUE_CONFIG: configFile,
    QUEUE_ROOT: repo,
    QUEUE_GIT: repo,
    QUEUE_TIME_LOG: timeLog,
    QUEUE_GATE_QUEUE: 'off',
    QUEUE_LOAD: 'free=50',
    TEMP: tempBase,
    TMP: tempBase,
    TMPDIR: tempBase,
  };
  delete env.QUEUE_GATE_QUEUE_DIR;
  delete env.QUEUE_SCRATCHPAD;
  delete env.QUEUE_SESSION;
  const gate = (track: string) =>
    spawnSync(process.execPath, [GATES, '--quick', '--cwd', repo, '--track', track], { env: env as NodeJS.ProcessEnv, encoding: 'utf8' });
  const q = (...args: string[]) => {
    const r = spawnSync(process.execPath, [QUEUE, ...args], { env: env as NodeJS.ProcessEnv, encoding: 'utf8', cwd: repo, timeout: 60_000 });
    return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  const queue = () => JSON.parse(fs.readFileSync(path.join(data, 'queue.json'), 'utf8')) as { tasks: Task[] };
  const insp = (): Record<string, Record<string, unknown>> => JSON.parse(fs.readFileSync(path.join(data, 'inspection.json'), 'utf8')).entries;
  const setTask = (id: string, fields: Record<string, unknown>) => {
    const file = path.join(data, 'queue.json');
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    Object.assign(s.tasks.find((t: Task) => t.id === id), fields);
    fs.writeFileSync(file, JSON.stringify(s));
  };
  const rows = () =>
    fs
      .readFileSync(timeLog, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  return { folder, repo, data, env, timeLog, gate, q, queue, insp, setTask, rows };
}

describe('the inspection queue', () => {
  it('two tracks red the same way give one proposal; a cancel rejects it, and nothing is proposed again', () => {
    const p = project();
    expect(p.gate('A-1').status).toBe(1);
    expect(p.gate('B-1').status).toBe(1);
    const gateRows = p.rows().filter((r) => r.event === 'gate');
    expect(gateRows).toHaveLength(2);
    const [a, b] = gateRows.map((r) => r.errors['node fail.cjs']);
    expect(a).toBe(b);
    expect(a).toContain('Error: sample value missing in');
    expect(a).toContain(':<line>:<col>');
    expect(fs.readFileSync(p.timeLog, 'utf8')).not.toContain(SECRET);

    const first = p.q('inspection');
    expect(first.code, first.out).toBe(0);
    expect(first.out).toContain('INSP-1');
    const tasks = p.queue().tasks.filter((t) => t.id.startsWith('INSP-'));
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ id: 'INSP-1', status: 'proposed', added_by: 'inspection agent', batched: true });
    expect(tasks[0].title).toContain('node fail.cjs');
    const [entry] = Object.values(p.insp());
    expect(entry).toMatchObject({ status: 'proposed', proposal: 'INSP-1', incidents: 2, count: 2, sources: ['gate'] });

    // A second scan: the same entry, no second task.
    p.q('inspection');
    expect(p.queue().tasks.filter((t) => t.id.startsWith('INSP-'))).toHaveLength(1);

    // The owner says no.
    expect(p.q('cancel', 'INSP-1').code).toBe(0);
    const after = p.q('inspection', '--json');
    expect(after.code, after.out).toBe(0);
    expect(Object.values(p.insp())[0]).toMatchObject({ status: 'rejected', rejectedAtIncidents: 2 });
    expect(p.queue().tasks.filter((t) => t.id.startsWith('INSP-'))).toHaveLength(1);
    // A third track the same way is not yet double: still rejected.
    p.gate('C-1');
    p.q('inspection');
    expect(Object.values(p.insp())[0]).toMatchObject({ status: 'rejected', incidents: 3 });
    // A fourth reaches twice the incidents at rejection: proposed again, as a new task.
    p.gate('D-1');
    p.q('inspection');
    expect(Object.values(p.insp())[0]).toMatchObject({ status: 'proposed', proposal: 'INSP-2' });
    // gates --health shows the last state, read-only.
    const before = fs.readFileSync(path.join(p.data, 'inspection.json'), 'utf8');
    const health = spawnSync(process.execPath, [GATES, '--health'], { env: p.env as NodeJS.ProcessEnv, encoding: 'utf8' });
    expect(health.stdout).toContain('Inspection queue');
    expect(health.stdout).toContain('proposed by INSP-2');
    expect(fs.readFileSync(path.join(p.data, 'inspection.json'), 'utf8')).toBe(before);
  });

  it('snooze cancels the proposal and holds the entry until its date', () => {
    const p = project();
    p.gate('A-1');
    p.gate('B-1');
    p.q('inspection');
    const s = p.q('inspection', 'snooze', 'INSP-1', '--days', '7');
    expect(s.code, s.out).toBe(0);
    expect(p.queue().tasks.find((t) => t.id === 'INSP-1')?.status).toBe('cancelled');
    p.q('inspection');
    const [entry] = Object.values(p.insp());
    expect(entry.status).toBe('snoozed');
    expect(String(entry.snoozedUntil).slice(0, 10) > new Date().toISOString().slice(0, 10)).toBe(true);
    expect(p.queue().tasks.filter((t) => t.id.startsWith('INSP-'))).toHaveLength(1);
  });

  it('a built proposal goes into the tracked guard registry with its signature, and the measures come from the gate rows', () => {
    const p = project();
    p.gate('A-1');
    p.gate('B-1');
    p.q('inspection');
    p.setTask('INSP-1', { status: 'done' });
    const listed = p.q('inspection');
    expect(listed.out).toContain('not in the guard registry yet');
    expect(listed.out).toContain('guards add --from-task INSP-1');

    const added = p.q('guards', 'add', '--from-task', 'INSP-1', '--kind', 'gate', '--explain', 'Stops the sample value from going missing again.', '--command', 'node fail.cjs');
    expect(added.code, added.out).toBe(0);
    expect(added.out).toContain('G-1');
    const file = path.join(p.repo, '.ravenseat', 'guards.json');
    const text = fs.readFileSync(file, 'utf8');
    expect(text).not.toContain('\r');
    const reg = JSON.parse(text);
    const [signature] = Object.keys(p.insp());
    expect(reg.guards[0]).toMatchObject({ id: 'G-1', kind: 'gate', task: 'INSP-1', status: 'active', against: { signature }, command: 'node fail.cjs' });
    expect(reg.guards[0].measures).toEqual({ runs: null, redRuns: null, caughtSince: null, lastRed: null });
    // A second entry for the same task is refused.
    expect(p.q('guards', 'add', '--from-task', 'INSP-1', '--kind', 'none', '--explain', 'Again.').code).not.toBe(0);

    const json = JSON.parse(p.q('guards', '--json').out);
    expect(json.guards[0].measures).toMatchObject({ runs: 2, redRuns: 2, caughtSince: 2 });
    expect(p.q('guards').out).toContain('caught 2 times since built');
    expect(p.q('inspection').out).not.toContain('not in the guard registry yet');

    expect(p.q('guards', 'retire', 'G-1').code).toBe(0);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).guards[0].status).toBe('retired');
  });

  it('the pulse proposes by itself, at most once an hour; mode off scans nothing', () => {
    const p = project();
    p.gate('A-1');
    p.gate('B-1');
    const pulse = p.q('orchestrator', 'pulse', '--session', 'test');
    expect(pulse.code, pulse.out).toBe(0);
    expect(pulse.out).toContain('INSP-1');
    expect(p.queue().tasks.filter((t) => t.id.startsWith('INSP-'))).toHaveLength(1);
    // Within the hour: no scan (the state is not rewritten).
    const before = fs.readFileSync(path.join(p.data, 'inspection.json'), 'utf8');
    p.q('orchestrator', 'pulse', '--session', 'test');
    expect(fs.readFileSync(path.join(p.data, 'inspection.json'), 'utf8')).toBe(before);

    const off = project({ inspection: { mode: 'off' } });
    off.gate('A-1');
    off.gate('B-1');
    off.q('orchestrator', 'pulse', '--session', 'test');
    const r = off.q('inspection');
    expect(r.out).toContain('off');
    expect(off.queue().tasks).toHaveLength(0);
    expect(fs.existsSync(path.join(off.data, 'inspection.json'))).toBe(false);
  });
});
