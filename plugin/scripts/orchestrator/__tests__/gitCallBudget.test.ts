// =============================================================
// gitCallBudget.test.ts: one `queue.mjs merge` in a fixture stays under a git-call budget (roadmap 1d, TT-3).
//
// Why: every git call is a process start, about 35 ms on Windows, and process starts are most of a command's time there.
// lib/gitFacts.js and a few merged rev-parse calls took one merge from 66 git calls to the count below. This test keeps
// that gain from eroding: a new call in the merge path has to fit the budget, or the budget is raised on purpose.
//
// How: a preload (NODE_OPTIONS --require) in the spawned queue.mjs and everything it starts appends one line per git
// child process to a log file. The fixture is the one in __tests__/queueBaseGate.test.ts test 1: a repo on develop, a
// track A in review with one new file, the quick gate `node check.js`, gateEvidence.mode off and the injected merge
// runner, so the merge runs the base gate first (nothing recorded yet), merges, runs gates.mjs on the merge commit and
// marks the task done. Never the main repo or the real queue.
// =============================================================
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const QUEUE = path.join(ROOT, 'scripts', 'orchestrator', 'queue.mjs');
const ID = ['-c', 'user.name=queue-test', '-c', 'user.email=queue-test@example.invalid'];
const CHECK_JS =
  "const fs = require('fs'); const path = require('path');\n" +
  "for (const f of fs.readdirSync('lib').sort()) require(path.resolve('lib', f));\n" +
  "console.log('check ok');\n";

// The budget: the count after TT-3 (48 on 2026-11-21: 31 in queue.mjs, 14 in gates.mjs, the runner's merge and the
// child queue.mjs's `set done`) plus a small margin for a platform difference. Raise it only for a call the merge needs.
const BUDGET = 52;

// One line per git child process: the script that started it and the subcommand. Patches the exported functions
// (execFileSync and execSync call the module's own spawnSync, so nothing is counted twice).
const PRELOAD = String.raw`
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const FILE = process.env.GIT_CALL_LOG;
const script = path.basename(process.argv[1] || '?');
const sub = (args) => {
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    if (a === '-C' || a === '-c') { i++; continue; }
    if (!a.startsWith('-')) return a;
  }
  return '?';
};
const log = (file, args) => {
  try {
    if (!FILE || path.basename(String(file)).toLowerCase().replace(/\.exe$/, '') !== 'git') return;
    const list = Array.isArray(args) ? args.map(String) : [];
    fs.appendFileSync(FILE, JSON.stringify({ script, sub: sub(list), args: list }) + '\n');
  } catch {}
};
for (const name of ['spawnSync', 'spawn', 'execFileSync', 'execFile']) {
  const orig = cp[name];
  cp[name] = function (file, args, ...rest) { log(file, args); return orig.call(this, file, args, ...rest); };
}
for (const name of ['execSync', 'exec']) {
  const orig = cp[name];
  cp[name] = function (command, ...rest) {
    const s = String(command);
    if (/^\s*"?git(\.exe)?"?\s/.test(s)) log('git', s.trim().split(/\s+/).slice(1));
    return orig.call(this, command, ...rest);
  };
}
require('node:module').syncBuiltinESMExports();
`;

const temporary: string[] = [];
afterAll(() => {
  for (const m of temporary) {
    try { fs.rmSync(m, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch { /* left for the OS */ }
  }
});

/** The fixture of queueBaseGate test 1 with one track, and the merge run with the counting preload. */
function mergeOnce() {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-gitbudget-'));
  temporary.push(folder);
  const repo = path.join(folder, 'repo');
  const scratch = path.join(folder, 'scratch');
  fs.mkdirSync(path.join(repo, 'lib'), { recursive: true });
  fs.mkdirSync(scratch);
  const g = (args: string[], cwd = repo) =>
    execFileSync('git', ['-C', cwd, ...ID, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  g(['init', '-q', '-b', 'develop']);
  fs.writeFileSync(path.join(repo, 'check.js'), CHECK_JS);
  fs.writeFileSync(path.join(repo, 'lib', 'a.js'), "exports.name = () => 'a';\n");
  g(['add', '--', 'check.js', 'lib/a.js']);
  g(['commit', '-q', '-m', 'start']);
  g(['branch', 'queue/A', 'develop']);
  const wt = path.join(folder, 'wt-A');
  g(['worktree', 'add', '-q', wt, 'queue/A']);
  fs.writeFileSync(path.join(wt, 'lib', 'b.js'), 'exports.b = 1;\n');
  g(['add', '--', 'lib/b.js'], wt);
  g(['commit', '-q', '-m', 'feat: A'], wt);
  const task = {
    id: 'A', title: 'Task A', domain: 'dom', class: 'K', status: 'review', mission: 'The mission for A.', value: 5,
    content_min: 30, depends_on: [], waiting_on: [], owned_files: ['lib/b.js'], started: '2026-01-01T00:00:00.000Z',
    branch: 'queue/A', scratchpad: scratch,
  };
  fs.writeFileSync(
    path.join(folder, 'queue.json'),
    JSON.stringify({ created: '2026-01-01T00:00:00.000Z', limits: {}, next_migr: 3600, resolved: [], tasks: [task] }),
  );
  const configFile = path.join(folder, 'queue.config.json');
  fs.writeFileSync(configFile, JSON.stringify({ baseBranch: 'develop', gateEvidence: { mode: 'off' }, gates: { quick: ['node check.js'] } }));
  const runner = path.join(folder, 'runner.mjs');
  fs.writeFileSync(
    runner,
    [
      "import { spawnSync } from 'node:child_process';",
      `const ID = ${JSON.stringify(ID)};`,
      'export default ({ step, cmd, args }) => {',
      '  const repo = process.env.QUEUE_GIT;',
      "  const r = step === 'merge'",
      "    ? spawnSync('git', ['-C', repo, ...ID, 'merge', '--no-ff', '--no-edit', args[1]], { encoding: 'utf8' })",
      "    : spawnSync(cmd, args, { cwd: repo, encoding: 'utf8', env: process.env });",
      "  return { code: r.status ?? 1, out: (r.stdout ?? '') + (r.stderr ?? '') + (step === 'merge' && r.status === 0 ? '\\nMerged by the test runner' : '') };",
      '};',
      '',
    ].join('\n'),
  );
  const preload = path.join(folder, 'count-git.cjs');
  fs.writeFileSync(preload, PRELOAD);
  const log = path.join(folder, 'git-calls.jsonl');
  const env = {
    ...process.env,
    QUEUE_FOLDER: folder,
    QUEUE_CONFIG: configFile,
    QUEUE_ROOT: folder,
    QUEUE_GIT: repo,
    QUEUE_TIME_LOG: path.join(folder, 'times.jsonl'),
    QUEUE_TRANSCRIPTS: path.join(folder, 'transcripts'),
    QUEUE_MERGE_RUNNING: runner,
    GIT_CALL_LOG: log,
    // The preload path in quotes (a temp folder can hold a space) and with "/": NODE_OPTIONS reads "\" as an escape.
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require "${preload.replace(/\\/g, '/')}"`.trim(),
  } as NodeJS.ProcessEnv;
  delete env.QUEUE_SCRATCHPAD;
  delete env.QUEUE_SESSION;
  const r = spawnSync(process.execPath, [QUEUE, 'merge', 'A', '--without-fill'], { encoding: 'utf8', env, cwd: repo });
  const calls = fs.existsSync(log)
    ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { script: string; sub: string; args: string[] })
    : [];
  const queue = JSON.parse(fs.readFileSync(path.join(folder, 'queue.json'), 'utf8'));
  return { code: r.status, out: r.stdout ?? '', error: r.stderr ?? '', calls, status: queue.tasks.find((t: { id: string }) => t.id === 'A')?.status };
}

describe('the git calls of one merge', () => {
  it(`stays within ${BUDGET} git calls, with the same result`, () => {
    const m = mergeOnce();
    expect(m.error).toBe('');
    expect(m.code).toBe(0);
    expect(m.out).toContain('BASE GREEN: develop at');
    expect(m.status).toBe('done');
    // The preload ran (a merge without git calls would mean it did not, and the budget would prove nothing).
    expect(m.calls.length).toBeGreaterThan(10);
    const bySub: Record<string, number> = {};
    for (const c of m.calls) bySub[`${c.script} ${c.sub}`] = (bySub[`${c.script} ${c.sub}`] ?? 0) + 1;
    expect(m.calls.length, `git calls by script and subcommand: ${JSON.stringify(bySub)}`).toBeLessThanOrEqual(BUDGET);
    // The path questions are asked once per folder: no repeat of the same rev-parse path question in one process.
    const pathQuestions = m.calls
      .filter((c) => c.sub === 'rev-parse' && c.args.some((a) => ['--git-dir', '--git-common-dir', '--show-toplevel'].includes(a)))
      .map((c) => `${c.script} ${c.args.join(' ').replace(/\\/g, '/')}`);
    expect(pathQuestions.length, pathQuestions.join('\n')).toBe(new Set(pathQuestions).size);
  }, 180_000);
});
