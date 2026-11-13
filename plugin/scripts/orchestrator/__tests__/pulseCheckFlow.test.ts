// =============================================================
// pulseCheckFlow.test.ts: `ravenseat pulse-check`, the pulse in one read-only call (cli/pulseCheck.mjs).
//
// Why: a repeated pulse (a scheduled or looped prompt overnight) ran several commands per tick (orchestrator pulse,
// state, next), each a full-context turn, also when nothing needed doing. pulse-check gathers it in one call and answers
// exactly `SILENT` when there is nothing to do.
//
// Locks: (1) an idle queue gives exactly "SILENT" and exit 0, and the only file written is the orchestrator marker;
// (2) each item kind gives "ACTION: <n>", one line per item with the exact next command, and exit 13: a delivered track
// to receive, a track no agent took, a silent track, free slots with startable tasks, a finished wait-mode run nobody
// collected, and open wiring items on a merged task; (3) things that need no action stay silent (a running wait-mode
// run, a collected one, wiring on a task that is not merged, an owner question); (4) owner questions are only a count,
// and only with --include-owner, never ACTION; (5) a usage error is exit 2 and writes nothing; (6) nothing but the
// marker is written also when there is ACTION (the pulse's report_seen is not updated, nothing starts); (7) what only
// `orchestrator pulse` does is not lost: a cloud track that finished or stopped, a new cloud tip not read yet, a
// predicted conflict the pulse has not reported and a proposal auto-accept would take become ACTION items (a cloud
// finish that waits on the owner's yes is an owner count), and after the pulse has run the tick is SILENT again.
// pulse-check never fetches and never writes the pulse's caches.
// Runs ravenseat.mjs (which runs queue commands in-process) against a temporary queue and repo. Never the main repo.
// =============================================================
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const RAVENSEAT = path.resolve(__dirname, '..', 'ravenseat.mjs');
const ID = ['-c', 'user.name=queue-test', '-c', 'user.email=queue-test@example.invalid'];
const RES = 'RESULT status=DONE branch=queue/A commits=1 migr=- gates=OK probe=- ownerQuestions=0 edge=-';
const OLD_MS = Date.now() - 3 * 3600_000;
const OLD_ISO = new Date(OLD_MS).toISOString();
const EXIT_ACTION = 13;

const temporary: string[] = [];
afterAll(() => {
  for (const m of temporary) fs.rmSync(m, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
});

type Task = Record<string, unknown> & { id: string; status: string };

/** A task with the fields the queue needs; `extra` overrides. */
const task = (id: string, extra: Partial<Task> = {}): Task => ({
  id,
  title: `Task ${id}`,
  domain: `dom-${id}`,
  class: 'K',
  status: 'waiting',
  mission: `The mission for ${id}.`,
  value: 5,
  content_min: 60,
  migr_tens: 0,
  depends_on: [],
  waiting_on: [],
  owned_files: [`lib/${id}.ts`],
  added_by: 'owner',
  added_at: new Date().toISOString(),
  ...extra,
});

/** Sets a file tree's times to OLD_MS (a hung agent wrote nothing since). */
function age(p: string) {
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const q = path.join(p, e.name);
    if (e.isDirectory()) age(q);
    fs.utimesSync(q, OLD_MS / 1000, OLD_MS / 1000);
  }
  fs.utimesSync(p, OLD_MS / 1000, OLD_MS / 1000);
}

/** A temporary project: a queue folder, a repo on main with one old commit, and the run helper. */
function project(tasks: Task[] = [], queueExtra: object = {}, config: object = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-pulse-check-'));
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
    }).trim();
  g(['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(repo, 'README.md'), 'start\n');
  g(['add', '--', 'README.md']);
  g(['commit', '-q', '-m', 'start']);
  fs.writeFileSync(
    path.join(folder, 'queue.json'),
    JSON.stringify({ created: OLD_ISO, limits: {}, next_migr: 3600, resolved: [], tasks, ...queueExtra }, null, 2),
  );
  const configFile = path.join(folder, 'queue.config.json');
  fs.writeFileSync(configFile, JSON.stringify({ baseBranch: 'main', ...config }));
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
  const run = (...args: string[]) => {
    const r = spawnSync(process.execPath, [RAVENSEAT, ...args], { encoding: 'utf8', env, cwd: folder });
    return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
  };
  return { folder, repo, scratch, g, run };
}

/** Every file under `root` (outside .git) with a hash of its content and its mtime. */
function snapshot(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (p: string) => {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const q = path.join(p, e.name);
      if (e.isDirectory()) walk(q);
      else {
        const hash = crypto.createHash('sha1').update(fs.readFileSync(q)).digest('hex');
        out.set(path.relative(root, q), `${hash} ${fs.statSync(q).mtimeMs}`);
      }
    }
  };
  walk(root);
  return out;
}

/** The files that changed, appeared or went away between two snapshots. */
function changed(before: Map<string, string>, after: Map<string, string>) {
  const keys = new Set([...before.keys(), ...after.keys()]);
  return [...keys].filter((k) => before.get(k) !== after.get(k)).sort();
}

describe('ravenseat pulse-check', () => {
  it('an idle queue: exactly SILENT, exit 0, and only the orchestrator marker is written', () => {
    const p = project();
    const before = snapshot(p.folder);
    const r = p.run('pulse-check', '--session', 'night');
    expect(r.err).toBe('');
    expect(r.out).toBe('SILENT\n');
    expect(r.code).toBe(0);
    expect(changed(before, snapshot(p.folder))).toEqual(['orchestrator.json']);
    const marker = JSON.parse(fs.readFileSync(path.join(p.folder, 'orchestrator.json'), 'utf8'));
    expect(marker.session).toBe('night');
    // A second call keeps the session and stays silent.
    expect(p.run('pulse-check').out).toBe('SILENT\n');
  });

  it('free slots with a startable task: ACTION with the fill command, exit 13, nothing started', () => {
    const p = project([task('T1')]);
    const before = snapshot(p.folder);
    const r = p.run('pulse-check', '--scratchpad', p.scratch);
    expect(r.code).toBe(EXIT_ACTION);
    const lines = r.out.trimEnd().split('\n');
    expect(lines[0]).toBe('ACTION: 1');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/^START 1 task\(s\) can start \(T1\)/);
    expect(lines[1]).toContain(`Next: ravenseat fill --scratchpad ${p.scratch}`);
    // Nothing started: queue.json is the same, only the marker changed.
    expect(changed(before, snapshot(p.folder))).toEqual(['orchestrator.json']);
    // Without a scratchpad the command names the placeholder.
    expect(p.run('pulse-check').out).toContain('Next: ravenseat fill --scratchpad <scratchpad>');
  });

  it('a delivered track: ACTION with receive, and report_seen is not written (unlike orchestrator pulse)', () => {
    const p = project([task('A', { status: 'running', branch: 'queue/A', started: OLD_ISO, migr_block: null })]);
    const report = path.join(p.scratch, 'A', 'track-result.md');
    fs.mkdirSync(path.dirname(report), { recursive: true });
    fs.writeFileSync(report, `${RES}\n\nThe report.\n`);
    const before = snapshot(p.folder);
    const r = p.run('pulse-check', '--scratchpad', p.scratch);
    expect(r.code).toBe(EXIT_ACTION);
    const lines = r.out.trimEnd().split('\n');
    expect(lines[0]).toBe('ACTION: 1');
    expect(lines[1]).toMatch(/^RECEIVE A: track-result\.md DONE/);
    expect(lines[1]).toContain(`Next: ravenseat receive A --scratchpad ${p.scratch}`);
    expect(changed(before, snapshot(p.folder))).toEqual(['orchestrator.json']);
    // Asked again: still there (nothing marked it seen), so a tick never loses a delivery.
    expect(p.run('pulse-check', '--scratchpad', p.scratch).out).toContain('RECEIVE A');
  });

  it('a track no agent took: ACTION with the way back', () => {
    const p = project([task('A', { status: 'running', branch: 'queue/A', started: OLD_ISO, migr_block: null })]);
    const r = p.run('pulse-check');
    expect(r.code).toBe(EXIT_ACTION);
    const lines = r.out.trimEnd().split('\n');
    expect(lines[0]).toBe('ACTION: 1');
    expect(lines[1]).toMatch(/^NO AGENT A: marked running for .+, no agent started\./);
    expect(lines[1]).toContain('Next: ravenseat set A waiting, then ravenseat fill --ids A --scratchpad <scratchpad>');
  });

  it('a silent track (the silentMin limit): ACTION with resume', () => {
    const p = project([task('A', { status: 'running', branch: 'queue/A', started: OLD_ISO, migr_block: null })]);
    const wt = path.join(p.folder, 'wt-A');
    p.g(['worktree', 'add', '-q', '-b', 'queue/A', wt]);
    age(wt);
    const r = p.run('pulse-check');
    expect(r.code).toBe(EXIT_ACTION);
    const lines = r.out.trimEnd().split('\n');
    expect(lines[0]).toBe('ACTION: 1');
    expect(lines[1]).toMatch(/^SILENT A: no sign of life for .+ \(limit 20 min\)\./);
    expect(lines[1]).toContain('Next: ravenseat explain A, then ravenseat resume A --reason context');
    // silentMin 0 turns the check off, as everywhere else.
    const q = JSON.parse(fs.readFileSync(path.join(p.folder, 'queue.json'), 'utf8'));
    q.limits.silentMin = 0;
    fs.writeFileSync(path.join(p.folder, 'queue.json'), JSON.stringify(q, null, 2));
    expect(p.run('pulse-check').out).toBe('SILENT\n');
  });

  it('a finished wait-mode run nobody collected: ACTION with --wait; running and collected runs stay silent', () => {
    const p = project();
    const runs = path.join(p.folder, 'runs');
    fs.mkdirSync(runs);
    const meta = (id: string, command: string) =>
      fs.writeFileSync(
        path.join(runs, `${id}.json`),
        JSON.stringify({ id, command, args: ['--quick'], what: `ravenseat ${command} --quick`, startedAt: OLD_ISO }),
      );
    // Finished, its output never shown.
    meta('gates-aaa111', 'gates');
    fs.writeFileSync(path.join(runs, 'gates-aaa111.out'), 'GREEN\n');
    fs.writeFileSync(path.join(runs, 'gates-aaa111.done.json'), JSON.stringify({ exit: 0 }));
    // Finished and collected (everything shown).
    meta('gates-bbb222', 'gates');
    fs.writeFileSync(path.join(runs, 'gates-bbb222.out'), 'GREEN\n');
    fs.writeFileSync(path.join(runs, 'gates-bbb222.done.json'), JSON.stringify({ exit: 0 }));
    fs.writeFileSync(path.join(runs, 'gates-bbb222.shown.json'), JSON.stringify({ out: 6, err: 0 }));
    // Still running (a live pid: this test's own process).
    meta('merge-ccc333', 'merge');
    fs.writeFileSync(path.join(runs, 'merge-ccc333.pid'), String(process.pid));
    const before = snapshot(p.folder);
    const r = p.run('pulse-check');
    expect(r.code).toBe(EXIT_ACTION);
    const lines = r.out.trimEnd().split('\n');
    expect(lines[0]).toBe('ACTION: 1');
    expect(lines[1]).toMatch(/^RUN gates-aaa111 finished \(exit 0\): ravenseat gates --quick\./);
    expect(lines[1]).toContain('Next: ravenseat gates --wait gates-aaa111');
    expect(changed(before, snapshot(p.folder))).toEqual(['orchestrator.json']);
  });

  it('open wiring on a merged task: ACTION with the close command; on a task not merged yet: silent', () => {
    const wiring = [{ id: 'W1', file: 'src/routes.ts', text: 'add the route', status: 'open' }];
    const p = project([
      task('B', { status: 'review', branch: 'queue/B', started: OLD_ISO, delivered: OLD_ISO, wiring }),
      task('C', { status: 'review', branch: 'queue/C', started: OLD_ISO, delivered: OLD_ISO, wiring }),
    ]);
    // B's merge ran and stopped at the done step (the wiring stop); C was never merged.
    fs.writeFileSync(
      path.join(p.folder, 'merge-state-B.json'),
      JSON.stringify({ task: 'B', steps_done: ['merge', 'gates'], stopped: { step: 'done', message: 'NOT DONE' } }),
    );
    const before = snapshot(p.folder);
    const r = p.run('pulse-check');
    expect(r.code).toBe(EXIT_ACTION);
    const lines = r.out.trimEnd().split('\n');
    expect(lines[0]).toBe('ACTION: 1');
    expect(lines[1]).toMatch(/^WIRING B: 1 open item\(s\) \(W1 src\/routes\.ts\)/);
    expect(lines[1]).toContain('Next: ravenseat wiring B W1 --commit <sha>');
    expect(lines[1]).toContain('ravenseat merge B --resume');
    expect(changed(before, snapshot(p.folder))).toEqual(['orchestrator.json']);
  });

  it('several kinds at once: one line each, counted in the header', () => {
    const p = project([
      task('T1'),
      task('A', { status: 'running', branch: 'queue/A', started: OLD_ISO, migr_block: null }),
      task('D', { status: 'done', branch: 'queue/D', started: OLD_ISO, wiring: [{ id: 'W1', file: 'a.ts', text: 'x', status: 'open' }] }),
    ]);
    const r = p.run('pulse-check');
    expect(r.code).toBe(EXIT_ACTION);
    const lines = r.out.trimEnd().split('\n');
    expect(lines[0]).toBe(`ACTION: ${lines.length - 1}`);
    expect(lines.map((l) => l.split(' ')[0]).slice(1).sort()).toEqual(['NO', 'START', 'WIRING']);
  });

  it('owner questions: never ACTION; a count only with --include-owner', () => {
    const p = project([task('T1', { waiting_on: ['Q1'] })], {
      question: { Q1: { type: 'question', text: 'Which one?' }, Q2: { type: 'question', text: 'Done?' } },
      resolved: ['Q2'],
    });
    const r = p.run('pulse-check');
    expect(r.out).toBe('SILENT\n');
    expect(r.code).toBe(0);
    const o = p.run('pulse-check', '--include-owner');
    expect(o.code).toBe(0);
    expect(o.out).toBe('SILENT\nFOR THE OWNER: 1 open question(s). Next (in the morning): ravenseat decide\n');
  });

  it('a usage error: exit 2 and nothing written', () => {
    const p = project();
    const before = snapshot(p.folder);
    const bad = p.run('pulse-check', '--bogus');
    expect(bad.code).toBe(2);
    expect(bad.err).toMatch(/pulse-check/);
    expect(p.run('pulse-check', 'extra').code).toBe(2);
    expect(p.run('pulse-check', '--session').code).toBe(2);
    expect(changed(before, snapshot(p.folder))).toEqual([]);
  });

  it('is in the help', () => {
    const p = project();
    const h = p.run('help', 'pulse-check');
    expect(h.code).toBe(0);
    expect(h.out).toContain('ravenseat pulse-check');
  });
});

describe('ravenseat pulse-check: what only orchestrator pulse does is not lost', () => {
  /** A bare remote `origin` for the repo, and a second clone that pushes like a cloud session would. */
  function withRemote(p: ReturnType<typeof project>) {
    const remote = path.join(p.folder, 'remote.git');
    execFileSync('git', ['init', '-q', '--bare', remote], { stdio: 'ignore' });
    p.g(['remote', 'add', 'origin', remote]);
    p.g(['push', '-q', 'origin', 'main']);
    const other = path.join(p.folder, 'cloud-clone');
    execFileSync('git', ['clone', '-q', remote, other], { stdio: 'ignore' });
    const push = (branch: string, message: string, fromRepo = false) => {
      const dir = fromRepo ? p.repo : other;
      const git = (args: string[]) =>
        execFileSync('git', ['-C', dir, ...ID, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      // A clone of a bare remote has no local main when the remote HEAD is not main: start from origin/main there.
      git(['checkout', '-q', '-B', branch, fromRepo ? 'main' : 'origin/main']);
      fs.writeFileSync(path.join(dir, `${branch.replace(/\//g, '-')}.txt`), 'x\n');
      git(['add', '-A']);
      git(['commit', '-q', '-m', message]);
      git(['push', '-q', 'origin', branch]);
      git(['checkout', '-q', fromRepo ? 'main' : '--detach']);
    };
    return { remote, push };
  }
  const cloudTask = (id: string) =>
    task(id, { status: 'picked', picked_by: 'cloud', cloud: { started: OLD_ISO }, started: OLD_ISO });

  it('a cloud track that finished: ACTION with collect auto, an owner count with collect ask; a stop is ACTION', () => {
    const p = project([cloudTask('A'), cloudTask('S')], {}, { features: { cloud: true }, cloud: { collect: 'auto' } });
    const r0 = withRemote(p);
    // Pushed from the repo itself, so the tips are local and pulse-check reads the marker without a fetch.
    r0.push('queue/A', 'feat: A\n\nCLOUD-DONE A', true);
    r0.push('queue/S', 'wip\n\nCLOUD-STOP S needs a local secret', true);
    const before = snapshot(p.folder);
    const r = p.run('pulse-check');
    expect(r.code).toBe(EXIT_ACTION);
    const lines = r.out.trimEnd().split('\n');
    expect(lines[0]).toBe('ACTION: 2');
    expect(lines).toContain('CLOUD A: finished in the cloud (queue/A). Next: ravenseat cloud collect A');
    expect(lines).toContain('CLOUD S: stopped in the cloud (queue/S). Next: ravenseat cloud check');
    // Read-only: the pulse's cloud-check.json is not written.
    expect(changed(before, snapshot(p.folder))).toEqual(['orchestrator.json']);

    // collect ask (the default): collecting waits on the owner's yes, so it is a count for the morning, not ACTION.
    fs.writeFileSync(path.join(p.folder, 'queue.config.json'), JSON.stringify({ baseBranch: 'main', features: { cloud: true } }));
    const ask = p.run('pulse-check', '--include-owner');
    const askLines = ask.out.trimEnd().split('\n');
    expect(askLines[0]).toBe('ACTION: 1');
    expect(askLines[1]).toMatch(/^CLOUD S: stopped/);
    expect(askLines.at(-1)).toBe(
      'FOR THE OWNER: 1 finished cloud track(s) to collect on your yes (A). Next (in the morning): ravenseat decide',
    );
  });

  it('a new cloud tip that is not local yet: ACTION with cloud check, and pulse-check fetches nothing', () => {
    const p = project([cloudTask('A')], {}, { features: { cloud: true } });
    const r0 = withRemote(p);
    r0.push('queue/A', 'feat: A\n\nCLOUD-DONE A');
    const r = p.run('pulse-check');
    expect(r.code).toBe(EXIT_ACTION);
    const lines = r.out.trimEnd().split('\n');
    expect(lines[0]).toBe('ACTION: 1');
    expect(lines[1]).toBe('CLOUD A: a new tip on queue/A, not read yet. Next: ravenseat cloud check');
    const tip = spawnSync('git', ['-C', p.repo, 'rev-parse', '-q', '--verify', 'refs/remotes/origin/queue/A'], { encoding: 'utf8' });
    expect(tip.status).not.toBe(0);
    // A cloud track still working (no branch yet) is silent.
    const q = project([cloudTask('B')], {}, { features: { cloud: true } });
    withRemote(q);
    expect(q.run('pulse-check').out).toBe('SILENT\n');
  });

  it('a predicted conflict the pulse has not reported: ACTION with orchestrator pulse; after the pulse, SILENT', () => {
    const p = project([
      task('A', { status: 'review', branch: 'queue/A', started: OLD_ISO, delivered: OLD_ISO }),
      task('B', { status: 'review', branch: 'queue/B', started: OLD_ISO, delivered: OLD_ISO }),
    ]);
    for (const [b, text] of [
      ['queue/A', 'from A\n'],
      ['queue/B', 'from B\n'],
    ]) {
      p.g(['checkout', '-q', '-b', b, 'main']);
      fs.writeFileSync(path.join(p.repo, 'README.md'), text);
      p.g(['commit', '-q', '-am', `change in ${b}`]);
      p.g(['checkout', '-q', 'main']);
    }
    const before = snapshot(p.folder);
    const r = p.run('pulse-check');
    expect(r.code).toBe(EXIT_ACTION);
    const lines = r.out.trimEnd().split('\n');
    expect(lines[0]).toBe('ACTION: 1');
    expect(lines[1]).toMatch(/^CONFLICTS: PREDICTED CONFLICT A x B: README\.md/);
    expect(lines[1]).toContain('Next: ravenseat orchestrator pulse');
    // The prediction cache is the pulse's: pulse-check does not write it.
    expect(changed(before, snapshot(p.folder))).toEqual(['orchestrator.json']);
    // The pulse reports it and records it; the next tick is silent while no tip moves.
    expect(p.run('orchestrator', 'pulse').out).toContain('PREDICTED CONFLICT A x B');
    expect(p.run('pulse-check').out).toBe('SILENT\n');
  });

  it('a proposal auto-accept would take: ACTION with orchestrator pulse; nothing accepted by pulse-check', () => {
    const p = project([task('P1', { status: 'proposed', added_by: 'T-9', class: 'K', content_min: 30 })], {
      proposals: { autoAccept: { enabled: true, classes: ['K'], maxEstimateMin: 60 } },
    });
    const before = snapshot(p.folder);
    const r = p.run('pulse-check');
    expect(r.code).toBe(EXIT_ACTION);
    const lines = r.out.trimEnd().split('\n');
    expect(lines[0]).toBe('ACTION: 1');
    expect(lines[1]).toBe("AUTO-ACCEPT 1 proposal(s) fit the owner's rules (P1). Next: ravenseat orchestrator pulse");
    expect(changed(before, snapshot(p.folder))).toEqual(['orchestrator.json']);
  });
});
