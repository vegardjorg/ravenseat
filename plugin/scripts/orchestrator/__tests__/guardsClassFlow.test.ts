// =============================================================
// guardsClassFlow.test.ts: `ravenseat guards add --class <class> --area <area>` with the real queue.mjs (ROADMAP 0t,
// plans/feillogg-til-gater-2026-11-15.md section 3.7 point 5 and section 3.11).
//
// Locks: (1) the class and area land in the tracked registry as against.class and against.area, and nothing more than
// the class, the area and the one sentence; (2) a class that is not one of the project's (core or its own in
// docs/queue/failure-classes.json) is refused and nothing is written; (3) --from-task on a gate task proposed from the
// finding log fills the class and area from its source.
// The pure rules, and that the repeat count reads the entry as a guard for its class and area (findingRepeats.guardsFrom),
// are in lib/__tests__/guardRegistry.test.ts.
// =============================================================
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

const QUEUE = path.resolve(__dirname, '..', 'queue.mjs');
const ID = ['-c', 'user.name=queue-test', '-c', 'user.email=queue-test@example.invalid'];

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

function project({ tasks = [] as object[], files = {} as Record<string, string> } = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'guards-class-'));
  temporary.push(folder);
  const repo = path.join(folder, 'repo');
  const data = path.join(folder, 'data');
  for (const d of [repo, data]) fs.mkdirSync(d);
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
    fs.writeFileSync(path.join(repo, f), text);
  }
  const globalConfig = path.join(folder, 'global-gitconfig');
  fs.writeFileSync(globalConfig, '');
  const configFile = path.join(folder, 'queue.config.json');
  fs.writeFileSync(configFile, JSON.stringify({ baseBranch: 'main', mode: 'lite' }));
  fs.writeFileSync(path.join(data, 'queue.json'), JSON.stringify({ limits: {}, resolved: [], projects: {}, tasks }));
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CEILING_DIRECTORIES: folder,
    QUEUE_FOLDER: data,
    QUEUE_CONFIG: configFile,
    QUEUE_ROOT: repo,
    QUEUE_GIT: repo,
    QUEUE_TIME_LOG: path.join(folder, 'times.jsonl'),
  } as NodeJS.ProcessEnv;
  execFileSync('git', ['-C', repo, ...ID, 'init', '-q', '-b', 'main'], { env, stdio: 'ignore' });
  execFileSync('git', ['-C', repo, ...ID, 'commit', '-q', '--allow-empty', '-m', 'start'], { env, stdio: 'ignore' });
  const q = (...args: string[]) => {
    const r = spawnSync(process.execPath, [QUEUE, ...args], { encoding: 'utf8', env, cwd: repo, timeout: 60_000 });
    return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  const file = path.join(repo, '.ravenseat', 'guards.json');
  const registry = () => JSON.parse(fs.readFileSync(file, 'utf8')) as { guards: Record<string, unknown>[] };
  return { q, file, registry };
}

const ADD = ['guards', 'add', '--kind', 'gate', '--title', 'Lint for unchecked results', '--explain', 'Stops a result used without its error check.', '--command', 'npm run lint'];

describe('guards add --class --area', () => {
  it('writes the class and the area to the tracked registry, nothing more', () => {
    const p = project();
    const r = p.q(...ADD, '--class', 'unchecked-error', '--area', 'src/api');
    expect(r.code, r.out).toBe(0);
    const [g] = p.registry().guards;
    expect(g.against).toEqual({ signature: null, lesson: null, class: 'unchecked-error', area: 'src/api' });
    expect(Object.keys(g).sort()).toEqual(['against', 'built', 'command', 'explain', 'id', 'kind', 'measures', 'status', 'task', 'title']);
    expect(p.q('guards').out).toContain('class unchecked-error in src/api');
  });

  it('refuses a class that is not the project\'s, and writes nothing', () => {
    const p = project();
    const r = p.q(...ADD, '--class', 'no-such-class');
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('no-such-class');
    expect(fs.existsSync(p.file)).toBe(false);
    expect(p.q(...ADD, '--area', 'src/api', '--against', 'a lesson').code).not.toBe(0);
  });

  it('takes the project\'s own class from docs/queue/failure-classes.json', () => {
    const p = project({ files: { 'docs/queue/failure-classes.json': JSON.stringify({ classes: [{ id: 'audit-trail', title: 'Audit trail missing' }] }) } });
    const r = p.q(...ADD, '--class', 'audit-trail');
    expect(r.code, r.out).toBe(0);
    expect(p.registry().guards[0].against).toMatchObject({ class: 'audit-trail', area: null });
  });

  it('--from-task on a gate task from the finding log fills the class and area from its source', () => {
    const task = { id: 'GATE-1', title: 'Gate: Unchecked error or result in src/api', status: 'done', class: 'K', labels: ['gate', 'finding-log'], source: 'finding-log unchecked-error@src/api' };
    const p = project({ tasks: [task] });
    const r = p.q('guards', 'add', '--from-task', 'GATE-1', '--kind', 'gate', '--explain', 'Stops a result used without its error check.', '--command', 'npm run lint');
    expect(r.code, r.out).toBe(0);
    expect(p.registry().guards[0]).toMatchObject({ task: 'GATE-1', title: 'Unchecked error or result in src/api', against: { class: 'unchecked-error', area: 'src/api' } });
  });
});
