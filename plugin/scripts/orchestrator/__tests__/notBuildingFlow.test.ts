// =============================================================
// notBuildingFlow.test.ts: "Not building" (roadmap 0f) through the real CLI, in a temporary project (lib/notBuilding.js,
// cli/notBuilding.mjs, cli/catalog.mjs, cli/taskEdit.mjs, cli/checks.mjs, cli/tasks.mjs, cli/doctor.mjs).
//
// Locks: (1) `cancel --keep` on a declined proposal writes a proposed not-building draft with the reason as its text,
// and the owner's accept turns it into status not-building under the owner lock; (2) a new task that reads like an
// accepted entry gets one INFO line at add, and nothing with notBuilding.match off; a draft not yet accepted never
// matches; the task is added either way; (3) `checks dismiss --keep` sets the card aside and writes a draft too;
// (4) catalog.captureAnswers off refuses --keep before anything changes, and a track cannot write a draft; (5) doctor
// names an entry whose revisit date has passed always, an old one only with --all; (6) `catalog show` lists the
// entries apart from the design choices; (7) reopening: a choice that supersedes the entry sets it superseded on accept.
// Runs queue.mjs against a temporary repo and queue folder. Never the main repo or the real queue.
// =============================================================
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const QUEUE = path.resolve(__dirname, '..', 'queue.mjs');
const ID = ['-c', 'user.name=queue-test', '-c', 'user.email=queue-test@example.invalid'];
const CAT = 'docs/queue/catalog';

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

function project(config: Record<string, unknown> = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-not-building-'));
  temporary.push(folder);
  const repo = path.join(folder, 'repo');
  const worktree = path.join(folder, 'wt-A');
  fs.mkdirSync(repo);
  const globalConfig = path.join(folder, 'global-gitconfig');
  fs.writeFileSync(globalConfig, '');
  const configFile = path.join(folder, 'queue.config.json');
  const setConfig = (c: Record<string, unknown>) =>
    fs.writeFileSync(configFile, JSON.stringify({ baseBranch: 'main', mode: 'lite', ...c }));
  setConfig(config);
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CEILING_DIRECTORIES: folder,
    QUEUE_FOLDER: folder,
    QUEUE_CONFIG: configFile,
    QUEUE_ROOT: repo,
    QUEUE_GIT: repo,
    QUEUE_TIME_LOG: path.join(folder, 'times.jsonl'),
    QUEUE_TRANSCRIPTS: path.join(folder, 'transcripts'),
    RAVENSEAT_CLAUDE_DIR: path.join(folder, 'claude'),
    RAVENSEAT_MANAGED_CLAUDE_MD: '',
    RAVENSEAT_INSTRUCTIONS_TOP: repo,
  } as NodeJS.ProcessEnv;
  delete env.QUEUE_SCRATCHPAD;
  delete env.QUEUE_SESSION;
  const write = (f: string, text: string, root = repo) => {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), text);
  };
  const g = (args: string[], cwd = repo) => execFileSync('git', ['-C', cwd, ...ID, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  write('package.json', JSON.stringify({ name: 'x' })); // no test script: the Checks card first-test applies
  write('lib/a.js', 'module.exports = {};\n');
  g(['init', '-q', '-b', 'main']);
  g(['add', '--', 'package.json', 'lib/a.js']);
  g(['commit', '-q', '-m', 'start']);
  g(['branch', 'queue/A']);
  g(['worktree', 'add', '-q', worktree, 'queue/A']);
  fs.writeFileSync(
    path.join(folder, 'queue.json'),
    JSON.stringify({ limits: {}, resolved: [], projects: { p: { title: 'P' } }, tasks: [] }),
  );
  const run = (args: string[], cwd = repo) => {
    const r = spawnSync(process.execPath, [QUEUE, ...args], { encoding: 'utf8', env, cwd });
    return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '', all: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  const read = (f: string) => fs.readFileSync(path.join(repo, f), 'utf8');
  const decisions = () => {
    try {
      return fs.readdirSync(path.join(repo, CAT, 'decisions')).filter((n) => /^D-\d+/.test(n));
    } catch {
      return [];
    }
  };
  const queue = () => JSON.parse(fs.readFileSync(path.join(folder, 'queue.json'), 'utf8'));
  /** A proposal from a reviewer (added_by "rev-…" makes it proposed, as an agent's would be). */
  const propose = (id: string, title: string) => {
    const file = path.join(folder, `${id}.json`);
    fs.writeFileSync(file, JSON.stringify([{ id, title, project: 'p', class: 'K', content_min: 30, value: 5, added_by: 'rev-1' }]));
    const r = run(['add', '--file', file]);
    expect(r.code, r.all).toBe(0);
    expect(queue().tasks.find((x: { id: string }) => x.id === id)?.status).toBe('proposed');
    return r;
  };
  return { folder, repo, worktree, run, write, read, decisions, queue, propose, setConfig };
}

/** A not-building entry accepted by the owner: propose by hand, then accept. Returns its id. */
function decided(p: ReturnType<typeof project>, title: string, keywords: string, extra: string[] = []) {
  const made = p.run(['catalog', 'propose', '--not-building', '--title', title, '--why', 'It costs more than it gives.', '--keywords', keywords, ...extra]);
  expect(made.code, made.all).toBe(0);
  const id = /D-\d{4}/.exec(made.out)?.[0] as string;
  const ok = p.run(['catalog', 'accept', id, '--by', 'owner']);
  expect(ok.code, ok.all).toBe(0);
  return id;
}

describe('not building: the way in', () => {
  it('cancel --keep on a declined proposal writes a draft with the reason; the owner accept makes it not-building', () => {
    const p = project();
    p.run(['catalog', 'init']);
    p.propose('A-1', 'Keepalive ping for the board');
    const r = p.run(['cancel', 'A-1', '--remark', 'declined: the poll already covers it', '--keep', '--by', 'owner']);
    expect(r.code, r.all).toBe(0);
    expect(r.out).toMatch(/KEEP: proposed D-0001 as not building/);
    expect(p.queue().tasks.find((x: { id: string }) => x.id === 'A-1').status).toBe('cancelled');
    const [name] = p.decisions();
    const text = p.read(`${CAT}/decisions/${name}`);
    expect(text).toMatch(/status: proposed/);
    expect(text).toMatch(/kind: not-building/);
    expect(text).toMatch(/the poll already covers it/);
    expect(text).toMatch(/source: declined proposal A-1/);
    expect(text).toMatch(/keywords: \[.*keepalive/);
    // Only the owner accepts it, and then it says not-building, never accepted.
    expect(p.run(['catalog', 'accept', 'D-0001']).code).not.toBe(0);
    const ok = p.run(['catalog', 'accept', 'D-0001', '--by', 'owner']);
    expect(ok.code, ok.all).toBe(0);
    expect(ok.out).toMatch(/as not building/);
    const after = p.read(`${CAT}/decisions/${name}`);
    expect(after).toMatch(/status: not-building/);
    expect(after).not.toMatch(/status: accepted/);
    expect(p.run(['catalog', 'check']).code).toBe(0);
  });

  it('the JSON answer of cancel --keep carries the KEEP line (the board shows it)', () => {
    const p = project();
    p.run(['catalog', 'init']);
    p.propose('A-2', 'Live Linear sync');
    const r = p.run(['cancel', 'A-2', '--remark', 'declined', '--keep', '--by', 'theBoard', '--json']);
    expect(r.code, r.all).toBe(0);
    const j = JSON.parse(r.out.trim().split(/\r?\n/).pop() as string);
    expect(j.ok).toBe(true);
    expect(j.keep.line).toMatch(/KEEP: proposed D-0001/);
    // No reason given: the draft says so, so the owner writes it before accepting.
    expect(p.read(`${CAT}/decisions/${p.decisions()[0]}`)).toMatch(/No reason was given/);
  });

  it('checks dismiss --keep sets the card aside and writes a draft from the card', () => {
    const p = project();
    p.run(['catalog', 'init']);
    const r = p.run(['checks', 'dismiss', 'first-test', '--keep', '--why', 'Tests come with the first real module.']);
    expect(r.code, r.all).toBe(0);
    expect(r.out).toMatch(/is set aside/);
    expect(r.out).toMatch(/KEEP: proposed D-0001 as not building/);
    const text = p.read(`${CAT}/decisions/${p.decisions()[0]}`);
    expect(text).toMatch(/source: Checks card first-test/);
    expect(text).toMatch(/Tests come with the first real module/);
  });

  it('captureAnswers off refuses --keep before anything changes, and a track cannot write a draft', () => {
    const p = project({ catalog: { captureAnswers: 'off' } });
    p.run(['catalog', 'init']);
    p.propose('A-3', 'Rename queue.config.json');
    const off = p.run(['cancel', 'A-3', '--remark', 'declined', '--keep', '--by', 'owner']);
    expect(off.code).not.toBe(0);
    expect(off.err).toMatch(/catalog\.captureAnswers is off/);
    expect(p.queue().tasks.find((x: { id: string }) => x.id === 'A-3').status).toBe('proposed');
    const aside = p.run(['checks', 'dismiss', 'first-test', '--keep']);
    expect(aside.code).not.toBe(0);
    expect(p.decisions()).toEqual([]);
    p.setConfig({});
    expect(p.run(['catalog', 'propose', '--not-building', '--title', 'X'], p.worktree).code).not.toBe(0);
    expect(p.decisions()).toEqual([]);
  });
});

describe('not building: the INFO line and doctor', () => {
  it('a new task that reads like an accepted entry gets one INFO line; a draft never matches; off says nothing', () => {
    const p = project();
    p.run(['catalog', 'init']);
    decided(p, 'Agent summaries on the board', 'agentSummaries,agent summaries');
    p.run(['catalog', 'propose', '--not-building', '--title', 'Keepalive ping', '--keywords', 'keepalive']);
    const r = p.run(['add', 'Show agentSummaries in the panel', '--id', 'T-1']);
    expect(r.code, r.all).toBe(0);
    expect(r.out).toMatch(/INFO not-building: T-1 looks like D-0001 "Agent summaries on the board" \(keyword agentSummaries\): chosen not to build \d{4}-\d{2}-\d{2} because it costs more than it gives\./);
    expect(r.out).toMatch(/Advice only, nothing is stopped/);
    expect(p.queue().tasks.some((x: { id: string }) => x.id === 'T-1')).toBe(true);
    // The draft D-0002 (keepalive) is not the owner's yet: no line.
    expect(p.run(['add', 'A keepalive for the socket', '--id', 'T-2']).out).not.toMatch(/INFO not-building/);
    p.setConfig({ notBuilding: { match: false } });
    expect(p.run(['add', 'More agentSummaries', '--id', 'T-3']).out).not.toMatch(/INFO not-building/);
  });

  it('plan capture: a captured plan with a keyword gets the INFO line, and is captured', () => {
    const p = project();
    p.run(['catalog', 'init']);
    decided(p, 'Live Linear sync', 'linear');
    const r = p.run(['plan', 'capture', 'Two-way Linear sync', '--text', 'Mirror the queue.']);
    expect(r.code, r.all).toBe(0);
    expect(r.out).toMatch(/Added PL-/);
    expect(r.out).toMatch(/INFO not-building: PL-\S+ looks like D-0001 "Live Linear sync" \(keyword linear\)/);
  });

  it('doctor names a passed revisit date always, an old entry only with --all; catalog show lists them apart', () => {
    const p = project();
    p.run(['catalog', 'init']);
    decided(p, 'Live Issues sync', 'issues sync', ['--revisit', 'after 2020-01-01 when the API is stable']);
    const doctor = p.run(['doctor']);
    expect(doctor.out).toMatch(/INFO\s+not-building/);
    expect(doctor.out).toMatch(/D-0001/);
    const show = p.run(['catalog', 'show']);
    expect(show.out).toMatch(/Not building/);
    expect(show.out).toMatch(/D-0001/);
    const one = p.run(['catalog', 'show', 'D-0001']);
    expect(one.out).toMatch(/keywords: issues sync/);
    expect(one.out).toMatch(/revisit: after 2020-01-01/);
  });

  it('a revisit without a date that is not old shows nothing in doctor, even with --all', () => {
    const p = project();
    p.run(['catalog', 'init']);
    decided(p, 'Rename queue.config.json', 'queue.config.json', ['--revisit', 'when a second config file appears']);
    expect(p.run(['doctor']).out).not.toMatch(/not-building/);
    expect(p.run(['doctor', '--all']).out).not.toMatch(/not-building/);
  });

  it('reopening: a design choice that supersedes the entry sets it superseded on accept, and it stops matching', () => {
    const p = project();
    p.run(['catalog', 'init']);
    const id = decided(p, 'Keepalive ping', 'keepalive');
    const re = p.run(['catalog', 'propose', '--title', 'Keepalive ping every 30 s', '--invariant', 'The board pings every 30 s.', '--paths', 'lib/**', '--supersedes', id]);
    expect(re.code, re.all).toBe(0);
    const ok = p.run(['catalog', 'accept', 'D-0002', '--by', 'owner']);
    expect(ok.code, ok.all).toBe(0);
    expect(ok.out).toMatch(/D-0001 is now superseded/);
    expect(p.run(['add', 'Add a keepalive', '--id', 'T-1']).out).not.toMatch(/INFO not-building/);
  });
});
