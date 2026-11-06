// =============================================================
// queueDoneLock.test.ts: the finish line is fixed before the start (lib/doneCheck.js doneLockError, acceptance).
//
// Locks: (1) before the start anyone may change done_when and acceptance; (2) after the start an edit or undo without
// --by owner (or theBoard) is refused with "is locked after start; ask the owner (ravenseat question)" and nothing is written;
// (3) from inside a track worktree (the cwd on a queue/<id> branch) the change is refused whatever --by says;
// (4) acceptance round-trips through add --accept, edit --accept and info, and reaches the track block (the mission) and
// the reviewer-gap prompt; (5) the ownership fields the merge guard trusts (owned_files, shared_patch, owner_db,
// migr_block) follow the same lock (review H2). Runs queue.mjs against a temporary queue (QUEUE_FOLDER) and a temporary git repo with a
// worktree on queue/R, as queueDoneCheck.test.ts. Never the main repo or the real queue.
// =============================================================
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const D = require('../lib/doneCheck.js');
const L = require('../lib/queueLogic.js');

type Task = Record<string, unknown> & { id: string; status: string };
type Queue = { tasks: Task[]; changelog?: unknown[] };

const ROOT = path.resolve(__dirname, '..', '..', '..');
const ID = ['-c', 'user.name=queue-test', '-c', 'user.email=queue-test@example.invalid'];
const LOCKED = "locked after start; ask the owner (ravenseat question). On the owner's word: the same command with --by owner, or the board";

const temporary: string[] = [];
afterAll(() => {
  for (const m of temporary) fs.rmSync(m, { recursive: true, force: true });
});

const base = (id: string, status: string, extra: Record<string, unknown> = {}): Task => ({
  id,
  title: `Task ${id}`,
  domain: `dom-${id}`,
  class: 'K',
  status,
  mission: `The mission for ${id}.`,
  value: 5,
  content_min: 100,
  depends_on: [],
  waiting_on: [],
  owned_files: [`lib/${id}.ts`],
  owner_db: [],
  shared_patch: [],
  ...extra,
});

function setup() {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-done-lock-'));
  temporary.push(folder);
  const tasks = [
    base('W', 'waiting'),
    base('R', 'running', {
      started: '2026-01-01T00:00:00.000Z',
      branch: 'queue/R',
      done_when: 'node -e "process.exit(0)"',
      acceptance: ['The list shows the new row'],
    }),
  ];
  fs.writeFileSync(
    path.join(folder, 'queue.json'),
    JSON.stringify({ created: '2026-01-01T00:00:00.000Z', limits: {}, next_migr: 3600, resolved: [], tasks }),
  );
  const configFile = path.join(folder, 'queue.config.json');
  fs.writeFileSync(configFile, JSON.stringify({ baseBranch: 'develop' }));
  // A repo with a worktree on the track branch, so a call can run from "inside a track".
  const repo = path.join(folder, 'repo');
  const worktree = path.join(folder, 'wt-R');
  fs.mkdirSync(repo);
  const g = (args: string[], cwd = repo) =>
    execFileSync('git', ['-C', cwd, ...ID, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  g(['init', '-q', '-b', 'develop']);
  fs.writeFileSync(path.join(repo, 'README.md'), 'start\n');
  g(['add', '--', 'README.md']);
  g(['commit', '-q', '-m', 'start']);
  g(['branch', 'queue/R']);
  g(['worktree', 'add', '-q', worktree, 'queue/R']);
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
  // The default cwd is the temporary folder (outside any git tree); `cwd` runs from somewhere else (the worktree).
  const run = (args: string[], cwd = folder) => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'orchestrator', 'queue.mjs'), ...args], {
      encoding: 'utf8',
      env,
      cwd,
    });
    return { code: r.status, out: r.stdout ?? '', error: r.stderr ?? '' };
  };
  const queue = () => JSON.parse(fs.readFileSync(path.join(folder, 'queue.json'), 'utf8')) as Queue;
  const find = (id: string) => queue().tasks.find((o) => o.id === id) as Task;
  return { folder, repo, worktree, run, queue, find };
}

describe('doneLockError (pure)', () => {
  const running = { id: 'R', status: 'running', started: '2026-01-01T00:00:00.000Z', done_when: 'x' };
  it('allows anyone before the start, only the owner after it, nobody from a track worktree', () => {
    expect(D.doneLockError({ id: 'W', status: 'waiting' }, { done_when: 'y' }, { by: 'ravenseat' })).toBeNull();
    expect(D.doneLockError(running, { done_when: 'y' }, { by: 'ravenseat' })).toBe(`done_when is ${LOCKED}`);
    expect(D.doneLockError(running, { acceptance: ['a'], done_when: 'y' }, { by: 'R' })).toBe(
      `done_when and acceptance are ${LOCKED}`,
    );
    expect(D.doneLockError(running, { done_when: 'y' }, { by: 'owner' })).toBeNull();
    expect(D.doneLockError(running, { done_when: 'y' }, { by: 'theBoard' })).toBeNull();
    expect(D.doneLockError(running, { done_when: 'y' }, { by: 'owner', inTrack: 'queue/R' })).toMatch(
      /cannot be changed from inside a track worktree \(branch queue\/R\)/,
    );
    // The same value again and other fields are not a change of the finish line.
    expect(D.doneLockError(running, { done_when: 'x', value: 8 }, { by: 'ravenseat' })).toBeNull();
    // A released task keeps its `started` time and stays locked.
    expect(D.doneLockError({ ...running, status: 'waiting' }, { done_when: null }, { by: 'ravenseat' })).toBe(
      `done_when is ${LOCKED}`,
    );
  });

  it('locks the ownership the merge guard trusts (owned_files, shared_patch, owner_db, migr_block) the same way', () => {
    const r = { ...running, owned_files: ['lib/R.ts'], shared_patch: [], owner_db: [] };
    for (const field of ['owned_files', 'shared_patch', 'owner_db', 'migr_block']) {
      const change = { [field]: ['.claude/'] };
      expect(D.doneLockError({ id: 'W', status: 'waiting' }, change, { by: 'ravenseat' }), field).toBeNull();
      expect(D.doneLockError(r, change, { by: 'ravenseat' }), field).toBe(`${field} is ${LOCKED}`);
      expect(D.doneLockError(r, change, { by: 'R' }), field).toBe(`${field} is ${LOCKED}`);
      expect(D.doneLockError(r, change, { by: 'owner' }), field).toBeNull();
      expect(D.doneLockError(r, change, { by: 'theBoard' }), field).toBeNull();
      expect(D.doneLockError(r, change, { by: 'owner', inTrack: 'queue/R' }), field).toMatch(/from inside a track worktree/);
    }
    // The same list again is not a change.
    expect(D.doneLockError(r, { owned_files: ['lib/R.ts'] }, { by: 'ravenseat' })).toBeNull();
  });

  it('validates the acceptance shape', () => {
    expect(D.acceptanceErrors({ acceptance: ['ok'] })).toEqual([]);
    expect(D.acceptanceErrors({ acceptance: [] })[0]).toMatch(/list of 1 to 10/);
    expect(D.acceptanceErrors({ acceptance: 'one' })[0]).toMatch(/list of 1 to 10/);
    expect(D.acceptanceErrors({ acceptance: ['a\nb'] })[0]).toMatch(/one line/);
    expect(D.acceptanceErrors({ acceptance: ['x'.repeat(301)] })[0]).toMatch(/at most 300/);
  });

  it('puts the criteria and the done command in the reviewer-gap prompt only', () => {
    const o = { id: 'R', class: 'K', branch: 'queue/R', acceptance: ['Shows the row', 'Keeps the sort'], done_when: 'npm test' };
    const gap = L.reviewerPrompt({ o, type: 'reviewer-gap', folder: '/tmp/rev-R' });
    expect(gap.split('\n')[0]).toContain('You are reviewer-gap for track R');
    expect(gap).toContain('- A1: Shows the row');
    expect(gap).toContain('- A2: Keeps the sort');
    expect(gap).toContain('- D: the done command `npm test`');
    expect(gap).toContain('MET|NOT MET|UNCLEAR');
    expect(gap).toContain('Every NOT MET is a HIGH finding');
    expect(gap).toContain('First line in fixed format: FINDINGS H=<count>');
    expect(L.reviewerPrompt({ o, type: 'reviewer', folder: '/tmp/rev-R' })).not.toContain('A1:');
    expect(L.reviewerPrompt({ o: { id: 'X', class: 'K' }, type: 'reviewer-gap', folder: '/tmp' })).not.toContain(
      'Fixed acceptance criteria',
    );
  });

  it('gives the board card the criteria and the done command for the detail panel, only when set', () => {
    const B = require('../lib/queueBoard.js');
    const queue = {
      tasks: [
        base('R', 'running', { started: '2026-01-01T00:00:00.000Z', acceptance: ['Shows the row'], done_when: 'npm test' }),
        base('W', 'waiting'),
      ],
    };
    const t = B.board(queue, { now: Date.parse('2026-01-02T00:00:00.000Z') });
    const cards = Object.values(t.columns).flat() as { id: string; acceptance?: string[]; done_when?: string }[];
    const r = cards.find((k) => k.id === 'R');
    expect(r?.acceptance).toEqual(['Shows the row']);
    expect(r?.done_when).toBe('npm test');
    expect('acceptance' in (cards.find((k) => k.id === 'W') ?? {})).toBe(false);
  });
});

describe('queue.mjs edit, undo, add and trackFile with the done lock', () => {
  it('refuses agent edits after the start, allows the owner and the board, and refuses from a track worktree', () => {
    const { run, find, worktree } = setup();

    // ---- before the start: anyone (no --by) ----
    const w1 = run(['edit', 'W', '--accept', 'Saves the form', '--accept', 'Shows an error on empty input']);
    expect(w1.error).toBe('');
    expect(w1.code).toBe(0);
    expect(find('W').acceptance).toEqual(['Saves the form', 'Shows an error on empty input']);
    expect(run(['edit', 'W', '--json', JSON.stringify({ done_when: 'npm test' })]).code).toBe(0);
    expect(find('W').done_when).toBe('npm test');

    // ---- after the start: an agent (no --by, or a track id) is refused, nothing written ----
    const before = JSON.stringify(find('R'));
    const r1 = run(['edit', 'R', '--accept', 'Something easier']);
    expect(r1.code).toBe(1);
    expect(r1.error).toContain(`acceptance is ${LOCKED}`);
    const r2 = run(['edit', 'R', '--json', JSON.stringify({ done_when: 'node -e "0"' }), '--by', 'R']);
    expect(r2.code).toBe(1);
    expect(r2.error).toContain(`done_when is ${LOCKED}`);
    expect(run(['edit', 'R', '--json', JSON.stringify({ done_when: null })]).error).toContain(LOCKED);
    expect(JSON.stringify(find('R'))).toBe(before);
    // Another field on the started task is not locked.
    expect(run(['edit', 'R', '--json', JSON.stringify({ value: 7 })]).code).toBe(0);

    // ---- the owner and the board may ----
    expect(run(['edit', 'R', '--accept', 'The list shows the new row first', '--by', 'owner']).code).toBe(0);
    expect(find('R').acceptance).toEqual(['The list shows the new row first']);
    expect(run(['edit', 'R', '--json', JSON.stringify({ done_when: 'npm test' }), '--by', 'theBoard']).code).toBe(0);
    expect(find('R').done_when).toBe('npm test');

    // ---- undo follows the same rule: an agent cannot roll the owner's change back ----
    const u1 = run(['undo']);
    expect(u1.code).toBe(1);
    expect(u1.error).toContain(`done_when is ${LOCKED}`);
    expect(find('R').done_when).toBe('npm test');
    expect(run(['undo', '--by', 'owner']).code).toBe(0);
    expect(find('R').done_when).toBe('node -e "process.exit(0)"');

    // ---- from inside the track's worktree: refused whatever --by says, also for a task that has not started ----
    const t1 = run(['edit', 'R', '--accept', 'Easier', '--by', 'owner'], worktree);
    expect(t1.code).toBe(1);
    expect(t1.error).toContain('cannot be changed from inside a track worktree (branch queue/R)');
    const t2 = run(['edit', 'W', '--json', JSON.stringify({ done_when: null }), '--by', 'owner'], worktree);
    expect(t2.code).toBe(1);
    expect(t2.error).toContain('from inside a track worktree');
    expect(find('W').done_when).toBe('npm test');
    // Other fields still work from there (the lock is only on the finish line).
    expect(run(['edit', 'W', '--json', JSON.stringify({ value: 6 })], worktree).code).toBe(0);
  });

  it('refuses widening owned_files or shared_patch after the start, except for the owner (review H2)', () => {
    const { run, find, worktree } = setup();
    // Before the start: anyone.
    expect(run(['edit', 'W', '--json', JSON.stringify({ owned_files: ['lib/W.ts', 'lib/W2.ts'] })]).code).toBe(0);
    expect(find('W').owned_files).toEqual(['lib/W.ts', 'lib/W2.ts']);
    // After the start: an agent (no --by, or a track id) is refused and nothing is written.
    const before = JSON.stringify(find('R'));
    const r1 = run(['edit', 'R', '--json', JSON.stringify({ owned_files: ['lib/R.ts', '.claude/'] })]);
    expect(r1.code).toBe(1);
    expect(r1.error).toContain(`owned_files is ${LOCKED}`);
    const r2 = run(['edit', 'R', '--json', JSON.stringify({ shared_patch: ['.claude/settings.json'] }), '--by', 'R']);
    expect(r2.code).toBe(1);
    expect(r2.error).toContain(`shared_patch is ${LOCKED}`);
    expect(run(['edit', 'R', '--json', JSON.stringify({ owner_db: ['users'] })]).error).toContain(`owner_db is ${LOCKED}`);
    expect(JSON.stringify(find('R'))).toBe(before);
    // From the track's own worktree: refused whatever --by says.
    const t1 = run(['edit', 'R', '--json', JSON.stringify({ owned_files: ['.claude/'] }), '--by', 'owner'], worktree);
    expect(t1.code).toBe(1);
    expect(t1.error).toContain('cannot be changed from inside a track worktree (branch queue/R)');
    // The owner may, and an agent cannot undo the owner's change.
    expect(run(['edit', 'R', '--json', JSON.stringify({ owned_files: ['lib/R.ts', 'lib/R2.ts'] }), '--by', 'owner']).code).toBe(0);
    expect(find('R').owned_files).toEqual(['lib/R.ts', 'lib/R2.ts']);
    const u1 = run(['undo']);
    expect(u1.code).toBe(1);
    expect(u1.error).toContain(`owned_files is ${LOCKED}`);
    expect(run(['undo', '--by', 'owner']).code).toBe(0);
    expect(find('R').owned_files).toEqual(['lib/R.ts']);
  });

  it('round-trips acceptance through add, edit and info, and copies it into the mission', () => {
    const { run, find, folder } = setup();
    const task = base('N', 'waiting');
    delete (task as Record<string, unknown>).status;
    const a1 = run(['add', '--json', JSON.stringify(task), '--accept', 'Opens the detail panel', '--accept', 'Closes on Esc']);
    expect(a1.error).toBe('');
    expect(a1.code).toBe(0);
    expect(find('N').acceptance).toEqual(['Opens the detail panel', 'Closes on Esc']);
    // Several tasks with --accept, or a bad shape, are refused as a whole.
    const two = [base('N2', 'waiting'), base('N3', 'waiting')].map(({ status, ...rest }) => rest);
    expect(run(['add', '--json', JSON.stringify(two), '--accept', 'x']).error).toContain('--accept sets the criteria of one task');
    const bad = run(['add', '--json', JSON.stringify({ ...task, id: 'N4', acceptance: ['a\nb'] })]);
    expect(bad.error).toContain('one line');
    // edit replaces the list, info shows it, null removes it.
    expect(run(['edit', 'N', '--accept', 'Opens the detail panel on click']).code).toBe(0);
    expect(run(['info', 'N']).out).toContain('acceptance: 1) Opens the detail panel on click');
    expect(run(['info', 'N', '--field', 'acceptance']).out).toContain('Opens the detail panel on click');
    expect(run(['edit', 'N', '--json', JSON.stringify({ acceptance: null })]).code).toBe(0);
    expect('acceptance' in find('N')).toBe(false);

    // The started task's track block (the mission) carries the fixed criteria and the done command.
    const out = path.join(folder, 'track-R.md');
    const tf = run(['trackFile', 'R', '--out', out]);
    expect(tf.code).toBe(0);
    const block = fs.readFileSync(out, 'utf8');
    expect(block).toContain('**Acceptance criteria (fixed, do not change):**');
    expect(block).toContain('1. The list shows the new row');
    expect(block).toContain('**Done command (binding):**');
  });
});
