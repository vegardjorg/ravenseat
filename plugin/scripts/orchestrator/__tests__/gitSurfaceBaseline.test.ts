// =============================================================
// gitSurfaceBaseline.test.ts: the accepted baseline of what in git runs code (lib/gitSurfaceBaseline.js), against real
// git repos and real child processes (queue.mjs, gates.mjs, push-check.mjs).
//
// Locks: (1) a rerun on the same sha after a planted hook stays red, with no green entry; (2) a gate that plants a hook at
// receive is an owner stop, not a fix round: nothing in the queue changes, a rerun stops before running gates, and
// removing the hook or `ravenseat surface accept --by owner` lets it through; (3) a hook planted outside any gate run is seen at
// the next receive; (4) ravenseat merge refuses on drift and the planted post-merge hook does not fire; (5) push-check exits 2;
// (6) a gate that rewrites or removes the baseline file gets it back and is red; (7) accept is the owner's: refused
// from a track worktree, without --by owner, and denied to agents by the push guard; (8) config values are never stored
// or shown; (9) a worktree and the main checkout read the same surface, also with a relative core.hooksPath; (10) doctor
// warns and writes nothing; (11) a legitimate change (a hook manager, a global alias) gets the plain message, without
// the word TAMPERED or queue vocabulary, in lite mode too, and accept clears it in one command.
// The global and system git config are switched off (a temporary GIT_CONFIG_GLOBAL), never the developer's own.
// =============================================================
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ORCH = path.resolve(__dirname, '..');
const QUEUE = path.join(ORCH, 'queue.mjs');
const GATES = path.join(ORCH, 'gates.mjs');
const PUSH_CHECK = path.join(ORCH, 'push-check.mjs');
const ID = ['-c', 'user.name=queue-test', '-c', 'user.email=queue-test@example.invalid'];
const RES = 'RESULT status=DONE branch=queue/A commits=1 migr=- gates=OK probe=- ownerQuestions=0 edge=-';
const OK_GATE = 'node -e "process.exit(0)"';
const baselineLib = () => require('../lib/gitSurfaceBaseline.js');

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

type Task = Record<string, unknown> & { id: string; status: string };

/** A temporary project: a repo on develop, queue/A in a worktree with one commit, a queue with task A running. */
function project(config: Record<string, unknown> = { gates: { quick: [OK_GATE] } }, files: Record<string, string> = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-git-surface-'));
  temporary.push(folder);
  const repo = path.join(folder, 'repo');
  const worktree = path.join(folder, 'wt-A');
  const scratch = path.join(folder, 'scratch');
  fs.mkdirSync(repo);
  fs.mkdirSync(scratch);
  const globalConfig = path.join(folder, 'global-gitconfig');
  fs.writeFileSync(globalConfig, '');
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    QUEUE_FOLDER: folder,
    QUEUE_CONFIG: path.join(folder, 'queue.config.json'),
    QUEUE_ROOT: folder,
    QUEUE_GIT: repo,
    QUEUE_TIME_LOG: path.join(folder, 'times.jsonl'),
    QUEUE_TRANSCRIPTS: path.join(folder, 'transcripts'),
  } as NodeJS.ProcessEnv;
  delete env.QUEUE_SCRATCHPAD;
  delete env.QUEUE_SESSION;
  delete env.QUEUE_MERGE_RUNNING;
  const g = (args: string[], cwd = repo) =>
    execFileSync('git', ['-C', cwd, ...ID, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  g(['init', '-q', '-b', 'develop']);
  fs.writeFileSync(path.join(repo, 'README.md'), 'start\n');
  g(['add', '--', 'README.md']);
  g(['commit', '-q', '-m', 'start']);
  g(['branch', 'queue/A']);
  g(['worktree', 'add', '-q', worktree, 'queue/A']);
  for (const [name, text] of Object.entries({ 'lib/A.ts': 'export const a = 1;\n', ...files })) {
    fs.mkdirSync(path.dirname(path.join(worktree, name)), { recursive: true });
    fs.writeFileSync(path.join(worktree, name), text);
    g(['add', '--', name], worktree);
  }
  g(['commit', '-q', '-m', 'feat: A'], worktree);
  const task: Task = {
    id: 'A', title: 'Task A', domain: 'dom-A', class: 'K', status: 'running', mission: 'The mission for A.', value: 5,
    content_min: 60, depends_on: [], waiting_on: [], owned_files: ['lib/A.ts'], started: '2026-01-01T00:00:00.000Z',
    branch: 'queue/A', migr_block: null, scratchpad: scratch,
  };
  fs.writeFileSync(
    path.join(folder, 'queue.json'),
    JSON.stringify({ created: task.started, limits: {}, next_migr: 3600, resolved: [], tasks: [task] }),
  );
  const setConfig = (c: Record<string, unknown>) =>
    fs.writeFileSync(env.QUEUE_CONFIG as string, JSON.stringify({ baseBranch: 'develop', maxFixRounds: 3, ...c }));
  setConfig(config);
  fs.mkdirSync(path.join(scratch, 'A'), { recursive: true });
  fs.writeFileSync(path.join(scratch, 'A', 'track-result.md'), `${RES}\n`);
  const run = (args: string[], opts: { cwd?: string; extraEnv?: NodeJS.ProcessEnv } = {}) => {
    const r = spawnSync(process.execPath, [QUEUE, ...args], {
      encoding: 'utf8',
      env: { ...env, ...opts.extraEnv },
      cwd: opts.cwd ?? folder,
    });
    return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '', all: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  const gates = () => {
    const r = spawnSync(process.execPath, [GATES, '--quick', '--evidence', '--cwd', worktree, '--track', 'A'], {
      cwd: worktree,
      encoding: 'utf8',
      env,
    });
    return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  const pushCheck = (...args: string[]) => {
    const r = spawnSync(process.execPath, [PUSH_CHECK, '--from', 'develop', '--to', 'develop', ...args], {
      cwd: folder,
      encoding: 'utf8',
      env,
    });
    return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  const evidence = () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(folder, 'gate-evidence.json'), 'utf8')).entries as Record<string, unknown>[];
    } catch {
      return [];
    }
  };
  const find = () => JSON.parse(fs.readFileSync(path.join(folder, 'queue.json'), 'utf8')).tasks[0] as Task;
  const hooksDir = () => path.resolve(repo, g(['rev-parse', '--git-path', 'hooks']));
  /** Plants a hook by hand, as an agent's own Bash could; it writes `marker` when it runs. */
  const plant = (name = 'post-merge', marker = path.join(folder, 'hook-fired.txt')) => {
    fs.mkdirSync(hooksDir(), { recursive: true });
    const f = path.join(hooksDir(), name);
    fs.writeFileSync(f, `#!/bin/sh\necho fired > "${marker.split(path.sep).join('/')}"\n`);
    fs.chmodSync(f, 0o755);
    return { file: f, marker };
  };
  const baselineFile = path.join(folder, 'git-surface.json');
  return { folder, repo, worktree, scratch, env, g, run, gates, pushCheck, evidence, find, hooksDir, plant, setConfig, baselineFile, globalConfig };
}

/** A gate script that plants a post-merge hook in the effective hooks folder. Re-planting writes the same bytes. */
const PLANT_GATE = [
  "const cp = require('child_process'), fs = require('fs'), path = require('path');",
  "const hooks = path.resolve(cp.execFileSync('git', ['rev-parse', '--git-path', 'hooks'], { encoding: 'utf8' }).trim());",
  'fs.mkdirSync(hooks, { recursive: true });',
  "fs.writeFileSync(path.join(hooks, 'post-merge'), '#!/bin/sh\\nexit 0\\n');",
  '',
].join('\n');

/** What a person who did nothing wrong must read: no accusation and no queue vocabulary. */
function expectFriendly(text: string) {
  expect(text).not.toMatch(/tamper/i);
  expect(text).not.toMatch(/\btracks?\b/i);
  expect(text).not.toMatch(/\bclass\b/i);
  expect(text).toMatch(/normal after installing a hook tool/);
  expect(text).toMatch(/run code at the next git command/);
  expect(text).toContain('surface accept --by owner');
  expect(text).toMatch(/Nothing changed/);
}

describe('the rerun is not green over a planted hook', () => {
  it('a rerun on the same sha stays red, and no green entry appears', () => {
    const p = project({ gates: { quick: ['node plant.cjs'] } }, { 'plant.cjs': PLANT_GATE });
    p.run(['surface', 'accept', '--by', 'owner']);
    const first = p.gates();
    expect(first.code).toBe(1);
    expect(first.out).toContain('hook added: post-merge');
    const second = p.gates();
    expect(second.code).toBe(1);
    expect(second.out).toContain('hook added: post-merge');
    expect(p.evidence().filter((e) => e.ok === true)).toEqual([]);
    expect(p.evidence().at(-1)).toMatchObject({ ok: false, tampered: true, exit: 0 });
  });

  it("a track's own run (no evidence) compares during the run only: an owner's new hook does not make it red", () => {
    const p = project();
    p.run(['surface', 'accept', '--by', 'owner']);
    p.plant();
    const r = spawnSync(process.execPath, [GATES, '--quick'], { cwd: p.worktree, encoding: 'utf8', env: p.env });
    expect(r.status).toBe(0);
    expect(p.evidence()).toEqual([]);
  });
});

describe('ravenseat receive: tampered is an owner stop, not a fix round', () => {
  const noFixRound = (p: ReturnType<typeof project>, all: string) => {
    expect(p.find().status).toBe('running');
    expect(JSON.stringify(p.find())).not.toContain('gate-red');
    expect(p.find()).not.toHaveProperty('gate_check');
    expect(p.find()).not.toHaveProperty('resumed');
    expect(all).not.toMatch(/fix round in the SAME turn/);
    expect(all).not.toContain('NOT DONE');
    expect(fs.existsSync(path.join(p.scratch, 'prompt-A-r1.md'))).toBe(false);
  };

  it('a gate plants a hook: stop, status unchanged; a harmless gate still stops first; removing the hook lets it through', () => {
    const p = project({ gates: { quick: ['node plant.cjs'] } }, { 'plant.cjs': PLANT_GATE });
    const r = p.run(['receive', 'A']);
    expect(r.code).toBe(1);
    expect(r.all).toContain('hook added: post-merge');
    expect(r.all).toContain('TAMPERED');
    noFixRound(p, r.all);
    expect(p.evidence().at(-1)).toMatchObject({ ok: false, tampered: true });

    // Rerun with a harmless gate: stopped before any gate runs.
    const ran = path.join(p.folder, 'gate-ran.txt');
    const marker = `node -e "require('fs').writeFileSync(${JSON.stringify(ran).replace(/"/g, "'")},'x')"`;
    p.setConfig({ gates: { quick: [marker] } });
    const again = p.run(['receive', 'A']);
    expect(again.code).toBe(1);
    expectFriendly(again.err);
    expect(again.err).toContain('hook added: post-merge');
    expect(fs.existsSync(ran)).toBe(false);
    noFixRound(p, again.all);

    // The owner removes it: receive runs the gates again.
    fs.rmSync(path.join(p.hooksDir(), 'post-merge'));
    const ok = p.run(['receive', 'A']);
    expect(ok.code).toBe(0);
    expect(fs.existsSync(ran)).toBe(true);
    expect(p.find().status).toBe('review');
  });

  it('the same flow with ravenseat surface accept --by owner instead of removal', () => {
    const p = project({ gates: { quick: ['node plant.cjs'] } }, { 'plant.cjs': PLANT_GATE });
    expect(p.run(['receive', 'A']).code).toBe(1);
    expect(p.run(['receive', 'A']).code).toBe(1);
    const a = p.run(['surface', 'accept', '--by', 'owner']);
    expect(a.code).toBe(0);
    // The hook is now the accepted one; re-planting it changes nothing, so the gate is green.
    const ok = p.run(['receive', 'A']);
    expect(ok.code).toBe(0);
    expect(p.find().status).toBe('review');
    expect(JSON.parse(fs.readFileSync(p.baselineFile, 'utf8'))).toMatchObject({ v: 1, by: 'owner' });
  });

  it('a done command that changes the executing git config: the same owner stop', () => {
    const p = project({});
    const q = JSON.parse(fs.readFileSync(path.join(p.folder, 'queue.json'), 'utf8'));
    q.tasks[0].done_when = 'git config core.pager cat';
    fs.writeFileSync(path.join(p.folder, 'queue.json'), JSON.stringify(q));
    const r = p.run(['receive', 'A']);
    expect(r.code).toBe(1);
    expect(r.all).toContain('TAMPERED: git hooks or config changed during the run (git config changed: core.pager)');
    noFixRound(p, r.all);
    expect(p.find()).not.toHaveProperty('done_check');
  });

  it('a store-only tamper is an owner stop too; the rerun simply runs again', () => {
    const p = project({});
    const store = path.join(p.folder, 'gate-evidence.json');
    const flag = path.join(p.folder, 'forged-once');
    fs.writeFileSync(
      path.join(p.worktree, 'forge.cjs'),
      [
        "const fs = require('fs');",
        `if (!fs.existsSync(${JSON.stringify(flag)})) {`,
        `  fs.writeFileSync(${JSON.stringify(flag)}, 'x');`,
        `  fs.writeFileSync(${JSON.stringify(store)}, '{"version":1,"entries":[]}');`,
        '}',
        '',
      ].join('\n'),
    );
    p.g(['add', '--', 'forge.cjs'], p.worktree);
    p.g(['commit', '-q', '-m', 'forge'], p.worktree);
    p.setConfig({ gates: { quick: ['node forge.cjs'] } });
    const r = p.run(['receive', 'A']);
    expect(r.code).toBe(1);
    expect(r.all).toContain('the evidence store changed during the run');
    noFixRound(p, r.all);
    const again = p.run(['receive', 'A']);
    expect(again.code).toBe(0);
    expect(p.find().status).toBe('review');
  });

  it('a hook planted outside any gate run (an agent\'s Bash) is caught at the next receive', () => {
    const p = project();
    expect(p.run(['receive', 'A']).code).toBe(0);
    p.plant();
    const r = p.run(['receive', 'A']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('hook added: post-merge');
    expectFriendly(r.err);
  });

  it('start, fill and resume record the baseline silently, and only when it is missing', () => {
    const p = project();
    p.run(['surface']);
    expect(fs.existsSync(p.baselineFile)).toBe(false);
    p.run(['resume', 'A', '--reason', 'context', '--scratchpad', p.scratch]);
    expect(fs.existsSync(p.baselineFile)).toBe(true);
    const text = fs.readFileSync(p.baselineFile, 'utf8');
    p.plant();
    p.run(['resume', 'A', '--reason', 'context', '--scratchpad', p.scratch]);
    expect(fs.readFileSync(p.baselineFile, 'utf8')).toBe(text);
  });
});

describe('ravenseat merge and push-check on drift', () => {
  /** A real merge with plain git in the main checkout, for a task in review; the other steps as ravenseat merge would run them. */
  const runner = (p: ReturnType<typeof project>) => {
    const f = path.join(p.folder, 'runner.mjs');
    fs.writeFileSync(
      f,
      [
        "import { spawnSync } from 'node:child_process';",
        `const ID = ${JSON.stringify(ID)};`,
        'export default ({ step, cmd, args }) => {',
        '  const repo = process.env.QUEUE_GIT;',
        "  const r = step === 'merge'",
        "    ? spawnSync('git', ['-C', repo, ...ID, 'merge', '--no-ff', '--no-edit', args[1]], { encoding: 'utf8' })",
        "    : spawnSync(cmd, args, { cwd: repo, encoding: 'utf8', env: process.env });",
        "  return { code: r.status ?? 1, out: (r.stdout ?? '') + (r.stderr ?? '') };",
        '};',
        '',
      ].join('\n'),
    );
    return { QUEUE_MERGE_RUNNING: f } as NodeJS.ProcessEnv;
  };

  it('ravenseat merge refuses, the planted post-merge did not fire and the branch is not merged', () => {
    const p = project();
    expect(p.run(['receive', 'A']).code).toBe(0);
    const { marker } = p.plant();
    const m = p.run(['merge', 'A', '--without-fill'], { extraEnv: runner(p) });
    expect(m.code).toBe(1);
    expect(m.err).toContain('hook added: post-merge');
    expectFriendly(m.err);
    expect(fs.existsSync(marker)).toBe(false);
    expect(spawnSync('git', ['-C', p.repo, 'merge-base', '--is-ancestor', 'queue/A', 'develop'], { env: p.env }).status).not.toBe(0);
    expect(p.find().status).toBe('review');
    expect(JSON.stringify(p.find())).not.toContain('gate-red');

    // Removed: the merge goes through.
    fs.rmSync(path.join(p.hooksDir(), 'post-merge'));
    expect(p.run(['merge', 'A', '--without-fill'], { extraEnv: runner(p) }).code).toBe(0);
    expect(p.find().status).toBe('done');
  });

  it('a merge cut off part-way still gets a clear message, and --resume stops the same way', () => {
    const p = project();
    expect(p.run(['receive', 'A']).code).toBe(0);
    // As a cut-off merge leaves it: merged, the state lists the merge step.
    p.g(['merge', '-q', '--no-ff', '--no-edit', 'queue/A']);
    fs.writeFileSync(
      path.join(p.folder, 'merge-state-A.json'),
      JSON.stringify({ task: 'A', branch: 'queue/A', base: 'develop', plan: ['merge', 'done'], steps_done: ['merge'], current: 'done' }),
    );
    p.plant();
    const m = p.run(['merge', 'A', '--resume', '--without-fill'], { extraEnv: runner(p) });
    expect(m.code).toBe(1);
    expect(m.err).toContain('hook added: post-merge');
    expect(m.err).toContain('merge A --resume');
    expect(p.find().status).toBe('review');
    fs.rmSync(path.join(p.hooksDir(), 'post-merge'));
    expect(p.run(['merge', 'A', '--resume', '--without-fill'], { extraEnv: runner(p) }).code).toBe(0);
    expect(p.find().status).toBe('done');
  });

  it('push-check exits 2 on drift, before its report; normal output has no word about it', () => {
    const p = project();
    const clean = p.pushCheck();
    p.run(['surface', 'accept', '--by', 'owner']);
    const same = p.pushCheck();
    expect(same.code).toBe(0);
    expect(same.out).toBe(clean.out);
    p.plant();
    const r = p.pushCheck();
    expect(r.code).toBe(2);
    expect(r.out).toContain('hook added: post-merge');
    expectFriendly(r.out);
    const json = p.pushCheck('--json');
    expect(json.code).toBe(2);
    expect(JSON.parse(json.out).surface_drift).toContain('hook added: post-merge');
  });
});

describe('the baseline file', () => {
  /** A gate that plants a hook and overwrites (or removes) the baseline, so the hook would look accepted. */
  const rewriter = (file: string, how: 'rewrite' | 'remove') =>
    [
      PLANT_GATE,
      "const fs2 = require('fs');",
      how === 'remove'
        ? `fs2.rmSync(${JSON.stringify(file)}, { force: true });`
        : `fs2.writeFileSync(${JSON.stringify(file)}, JSON.stringify({ v: 1, forged: true }));`,
      '',
    ].join('\n');

  for (const how of ['rewrite', 'remove'] as const) {
    it(`a gate that tries to ${how} it along with a hook: the old text is back and the run is red`, () => {
      const p = project();
      p.run(['surface', 'accept', '--by', 'owner']);
      const before = fs.readFileSync(p.baselineFile, 'utf8');
      fs.writeFileSync(path.join(p.worktree, 'evil.cjs'), rewriter(p.baselineFile, how));
      p.g(['add', '--', 'evil.cjs'], p.worktree);
      p.g(['commit', '-q', '-m', 'evil'], p.worktree);
      p.setConfig({ gates: { quick: ['node evil.cjs'] } });
      const r = p.gates();
      expect(r.code).toBe(1);
      expect(r.out).toContain('the accepted baseline file changed during the run');
      expect(r.out).toContain('hook added: post-merge');
      expect(fs.readFileSync(p.baselineFile, 'utf8')).toBe(before);
      expect(p.evidence().at(-1)).toMatchObject({ ok: false, tampered: true });
    });
  }

  it('a baseline that cannot be parsed is a stop, never a new silent first use', () => {
    const p = project();
    fs.writeFileSync(p.baselineFile, '{ not json');
    const r = p.run(['receive', 'A']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('baseline');
    expect(fs.readFileSync(p.baselineFile, 'utf8')).toBe('{ not json');
  });

  it('holds no config values, also not in ravenseat surface', () => {
    const VALUE = 'value-marker-that-must-not-appear';
    const p = project();
    p.g(['config', 'core.sshCommand', VALUE]);
    p.run(['surface', 'accept', '--by', 'owner']);
    const text = fs.readFileSync(p.baselineFile, 'utf8');
    expect(text).not.toContain(VALUE);
    expect(Object.keys(JSON.parse(text).config)).toContain('core.sshcommand');
    expect(JSON.parse(text).config['core.sshcommand']).toMatch(/^[0-9a-f]{64}$/);
    p.g(['config', 'core.sshCommand', `${VALUE}-2`]);
    const shown = p.run(['surface']);
    expect(shown.all).toContain('core.sshcommand');
    expect(shown.all).not.toContain(VALUE);
  });

  it('a worktree and the main checkout give no drift against each other, also with a relative core.hooksPath', () => {
    const GB = baselineLib();
    const p = project();
    const prior = { ...process.env };
    Object.assign(process.env, { GIT_CONFIG_GLOBAL: p.globalConfig, GIT_CONFIG_NOSYSTEM: '1' });
    try {
      GB.ensure(p.folder, p.repo);
      expect(GB.driftReason(p.folder, p.repo)).toBeNull();
      expect(GB.driftReason(p.folder, p.worktree)).toBeNull();
      // Accepted from the worktree, read in the main checkout: the same.
      GB.accept(p.folder, p.worktree, 'owner');
      expect(GB.driftReason(p.folder, p.repo)).toBeNull();

      p.g(['config', 'core.hooksPath', '.husky']);
      fs.mkdirSync(path.join(p.repo, '.husky'));
      fs.writeFileSync(path.join(p.repo, '.husky', 'pre-commit'), '#!/bin/sh\n');
      GB.accept(p.folder, p.repo, 'owner');
      expect(GB.driftReason(p.folder, p.worktree)).toBeNull();
      expect(GB.driftReason(p.folder, p.repo)).toBeNull();
    } finally {
      for (const k of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM']) {
        if (prior[k] === undefined) delete process.env[k];
        else process.env[k] = prior[k];
      }
    }
  });
});

describe('ravenseat surface', () => {
  it('prints whether it matches and changes nothing; a missing baseline stays missing', () => {
    const p = project();
    const none = p.run(['surface']);
    expect(none.code).toBe(0);
    expect(none.out).toMatch(/No accepted baseline yet/);
    expect(fs.existsSync(p.baselineFile)).toBe(false);
    p.run(['surface', 'accept', '--by', 'owner']);
    expect(p.run(['surface']).out).toMatch(/match the accepted baseline/);
    const { file } = p.plant();
    const text = fs.readFileSync(p.baselineFile, 'utf8');
    const shown = p.run(['surface']);
    expect(shown.code).toBe(0);
    expect(shown.out).toContain('hook added');
    expect(shown.out).toContain('post-merge');
    expect(shown.out.split(/\s{2,}|\n/).map((s) => s.trim().toLowerCase())).toContain(fs.realpathSync.native(file).toLowerCase());
    expect(fs.readFileSync(p.baselineFile, 'utf8')).toBe(text);
  });

  it('accept is refused without --by owner and from a track worktree; the push guard denies it to agents', () => {
    const p = project();
    for (const args of [['accept'], ['accept', '--by', 'agent'], ['accept', '--by']]) {
      const r = p.run(['surface', ...args]);
      expect(r.code, args.join(' ')).toBe(1);
      expect(r.err).toMatch(/--by owner/);
    }
    expect(fs.existsSync(p.baselineFile)).toBe(false);
    const inTrack = p.run(['surface', 'accept', '--by', 'owner'], { cwd: p.worktree });
    expect(inTrack.code).toBe(1);
    expect(inTrack.err).toMatch(/track worktree/);
    expect(fs.existsSync(p.baselineFile)).toBe(false);
    expect(p.run(['surface', 'accept', '--by', 'theBoard']).code).toBe(0);
    expect(p.run(['surface', 'nonsense']).code).toBe(1);

    const PG = require('../lib/pushGuard.js');
    for (const command of ['ravenseat surface', 'ravenseat surface accept --by owner', 'node scripts/orchestrator/queue.mjs surface accept --by owner']) {
      expect(PG.assess(command, { agentType: 'track', branch: 'queue/A', environment: null })?.decision, command).toBe('deny');
    }
  });

  it('the file guards name the baseline for queue agents, as they do the evidence store', () => {
    const WG = require('../lib/writeGuard.js');
    const GE = require('../lib/gateEvidence.js');
    expect(WG.assessWrite({ agentType: 'track', filePath: path.join('C:\\data', 'git-surface.json'), folder: 'C:\\data', guardedTypes: [] })).not.toBeNull();
    expect(GE.tamperReason('rm .queue/git-surface.json')).toMatch(/git-surface/);
  });
});

describe('the gitSurface setting', () => {
  const OK = { gates: { quick: [OK_GATE] } };

  it('warn: receive and push-check go on past a difference and say so', () => {
    const p = project({ ...OK, gitSurface: 'warn' });
    expect(p.run(['surface']).code).toBe(0);
    baselineLib().ensure(p.folder, p.repo);
    p.plant();
    const r = p.run(['receive', 'A']);
    expect(r.code).toBe(0);
    expect(r.err).toContain('gitSurface is warn');
    expect(r.err).toContain('hook added: post-merge');
    expect(p.find().status).toBe('review');
    const check = p.pushCheck();
    expect(check.code).not.toBe(2);
    expect(check.out).toContain('gitSurface is warn');
    const json = spawnSync(process.execPath, [PUSH_CHECK, '--from', 'develop', '--to', 'develop', '--json'], { cwd: p.folder, encoding: 'utf8', env: p.env });
    expect(() => JSON.parse(json.stdout)).not.toThrow();
  });

  it('warn: a gate that plants a hook is named, the run stays green and not tampered', () => {
    const p = project({ gates: { quick: ['node plant.cjs'] }, gitSurface: 'warn' }, { 'plant.cjs': PLANT_GATE });
    const r = p.run(['receive', 'A']);
    expect(r.code).toBe(0);
    expect(r.err).toContain('gitSurface is warn');
    expect(r.err).toContain('hook added: post-merge');
    expect(p.evidence().at(-1)).toMatchObject({ ok: true });
    expect(p.evidence().at(-1)?.tampered).toBeFalsy();
    expect(p.find().status).toBe('review');
  });

  it('off: no word about it, and a gate that plants a hook stays green', () => {
    const p = project({ gates: { quick: ['node plant.cjs'] }, gitSurface: 'off' }, { 'plant.cjs': PLANT_GATE });
    baselineLib().ensure(p.folder, p.repo);
    p.plant('pre-push');
    const r = p.run(['receive', 'A']);
    expect(r.code).toBe(0);
    expect(r.all).not.toMatch(/gitSurface|TAMPERED|accepted baseline/);
    expect(p.find().status).toBe('review');
    expect(p.pushCheck().code).not.toBe(2);
  });

  it('off and warn: ravenseat surface and ravenseat doctor still report the real state', () => {
    const p = project({ ...OK, gitSurface: 'warn' });
    baselineLib().ensure(p.folder, p.repo);
    p.plant();
    const surface = p.run(['surface']);
    expect(surface.out).toContain('gitSurface is warn');
    expect(surface.out).toContain('post-merge');
    const check = () => JSON.parse(p.run(['doctor', '--json']).out).checks.find((c: { name: string }) => c.name === 'surface');
    expect(check().status).toBe('WARN');
    p.setConfig({ ...OK, gitSurface: 'off' });
    expect(check()).toMatchObject({ status: 'OK' });
    expect(check().message ?? JSON.stringify(check())).toContain('gitSurface is off');
  });

  it('a gate that writes gitSurface off into the config during a stop run is named and red', () => {
    const write = [
      "const fs = require('fs');",
      'const f = process.env.CONFIG_TO_WEAKEN;',
      "fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf8')), gitSurface: 'off' }));",
      '',
    ].join('\n');
    const p = project({ gates: { quick: ['node weaken.cjs'] } }, { 'weaken.cjs': write });
    const r = p.run(['receive', 'A'], { extraEnv: { CONFIG_TO_WEAKEN: p.env.QUEUE_CONFIG as string } });
    expect(r.code).toBe(1);
    expect(r.all).toContain('gitSurface setting was weakened');
    expect(p.evidence().at(-1)).toMatchObject({ ok: false, tampered: true });
  });

  it('a wrong value counts as stop and doctor names it; the stop text names the setting', () => {
    const p = project({ ...OK, gitSurface: 'nope' });
    baselineLib().ensure(p.folder, p.repo);
    p.plant();
    const r = p.run(['receive', 'A']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('"gitSurface": "warn"');
    const doctor = JSON.parse(p.run(['doctor', '--json']).out).checks.find((c: { name: string; status: string }) => c.name === 'config' && c.status === 'FAIL');
    expect(doctor.message).toContain('gitSurface is "nope"');
    expect(baselineLib().modeOf({ gitSurface: 'nope' })).toBe('stop');
    expect(baselineLib().modeOf({})).toBe('stop');
    expect(baselineLib().modeOf({ gitSurface: 'off' })).toBe('off');
  });
});

describe('ravenseat doctor', () => {
  it('WARN on drift with the fix hint, OK otherwise, and nothing written', () => {
    const p = project();
    const list = () => fs.readdirSync(p.folder).sort();
    const doctor = () => JSON.parse(p.run(['doctor', '--json']).out).checks.filter((c: { name: string }) => c.name === 'surface');

    const before = list();
    expect(doctor()).toMatchObject([{ status: 'OK' }]);
    expect(list()).toEqual(before);
    expect(fs.existsSync(p.baselineFile)).toBe(false);

    p.run(['surface', 'accept', '--by', 'owner']);
    expect(doctor()).toMatchObject([{ status: 'OK' }]);
    p.plant();
    const text = fs.readFileSync(p.baselineFile, 'utf8');
    const files = list();
    const [warned] = doctor();
    expect(warned.status).toBe('WARN');
    expect(warned.message).toContain('hook added: post-merge');
    expect(warned.fix).toContain('surface accept --by owner');
    expect(list()).toEqual(files);
    expect(fs.readFileSync(p.baselineFile, 'utf8')).toBe(text);
  });
});

describe('a legitimate change is explained, not accused', () => {
  it('a husky-style core.hooksPath in a tracked folder: the plain message with the hint, and accept clears it in one command', () => {
    const p = project();
    p.run(['surface', 'accept', '--by', 'owner']);
    expect(p.run(['receive', 'A']).code).toBe(0);
    // What `npx husky init` leaves: a tracked .husky folder, generated wrappers in .husky/_, core.hooksPath.
    fs.mkdirSync(path.join(p.repo, '.husky', '_'), { recursive: true });
    fs.writeFileSync(path.join(p.repo, '.husky', 'pre-commit'), 'npm test\n');
    fs.writeFileSync(path.join(p.repo, '.husky', '_', 'pre-commit'), '#!/usr/bin/env sh\n. "$(dirname "$0")/h"\n');
    p.g(['add', '--', '.husky/pre-commit']);
    p.g(['commit', '-q', '-m', 'husky']);
    p.g(['config', 'core.hooksPath', '.husky/_']);

    const r = p.run(['receive', 'A']);
    expect(r.code).toBe(1);
    expectFriendly(r.err);
    expect(r.err).toContain('core.hookspath');
    expect(r.err).toContain('looks like a hook manager');

    const shown = p.run(['surface']);
    expect(shown.out).toContain('looks like a hook manager');
    expect(shown.out).toMatch(/hooks folder moved/);
    expect(shown.out).toContain('.husky');
    expect(shown.out).toMatch(/core\.hookspath[\s\S]*local/);

    expect(p.run(['surface', 'accept', '--by', 'owner']).code).toBe(0);
    expect(p.run(['surface']).out).toMatch(/match the accepted baseline/);
    expect(p.run(['receive', 'A']).code).toBe(0);
  });

  it('a hook written by lefthook in the normal hooks folder gets the hint; a hook with no such word does not', () => {
    const p = project();
    p.run(['surface', 'accept', '--by', 'owner']);
    p.plant('pre-push');
    expect(p.run(['surface']).out).not.toContain('looks like a hook manager');
    fs.writeFileSync(path.join(p.hooksDir(), 'pre-commit'), '#!/bin/sh\n# generated by lefthook\nlefthook run pre-commit\n');
    expect(p.run(['surface']).out).toContain('looks like a hook manager (lefthook)');
    // A hint never accepts anything.
    const r = p.pushCheck();
    expect(r.code).toBe(2);
  });

  it('a global alias change: the plain message, the user\'s own file shown by ravenseat surface, accept clears it', () => {
    const p = project();
    p.run(['surface', 'accept', '--by', 'owner']);
    fs.writeFileSync(p.globalConfig, '[alias]\n\tst = status --value-marker\n');
    const r = p.run(['receive', 'A']);
    expect(r.code).toBe(1);
    expectFriendly(r.err);
    expect(r.err).toContain('alias.st');
    expect(r.err).not.toContain('value-marker');
    expect(r.err).not.toContain('looks like a hook manager');

    const shown = p.run(['surface']);
    expect(shown.out).toContain('alias.st');
    expect(shown.out).toMatch(/global/);
    expect(shown.out).toContain(path.basename(p.globalConfig));
    expect(shown.all).not.toContain('value-marker');

    expect(p.run(['surface', 'accept', '--by', 'owner']).code).toBe(0);
    expect(p.run(['receive', 'A']).code).toBe(0);
  });

  it('the message reads the same in lite mode with gitSurface stop', () => {
    const p = project({ mode: 'lite', gitSurface: 'stop', gates: { quick: [OK_GATE] } });
    p.run(['surface', 'accept', '--by', 'owner']);
    fs.writeFileSync(p.globalConfig, '[alias]\n\tst = status\n');
    const r = p.run(['receive', 'A']);
    expect(r.code).toBe(1);
    expectFriendly(r.err);
  });

  it('lite without a setting warns and goes on', () => {
    const p = project({ mode: 'lite', gates: { quick: [OK_GATE] } });
    p.run(['surface', 'accept', '--by', 'owner']);
    fs.writeFileSync(p.globalConfig, '[alias]\n\tst = status\n');
    const r = p.run(['receive', 'A']);
    expect(r.err).toContain('gitSurface is warn');
    expect(r.err).not.toContain('Nothing was received');
  });
});

describe('the pure rules', () => {
  it('parseConfigOrigins keeps executing keys and their origin, never a value', () => {
    const GB = baselineLib();
    const text =
      'global\0file:C:/Users/x/.gitconfig\0alias.st\nstatus --secret\0' +
      'local\0file:.git/config\0core.bare\nfalse\0' +
      'local\0file:.git/config\0core.sshcommand\nssh -i secret\0';
    const out = GB.parseConfigOrigins(text);
    expect(out).toEqual({
      'alias.st': ['global: C:/Users/x/.gitconfig'],
      'core.sshcommand': ['local: .git/config'],
    });
    expect(JSON.stringify(out)).not.toContain('secret');
  });

  it('hookManagerHint is a hint from the shape only', () => {
    const GB = baselineLib();
    expect(GB.hookManagerHint({ moved: true, movedToTracked: true, hookTexts: [] })).toBe('looks like a hook manager');
    expect(GB.hookManagerHint({ moved: true, movedToTracked: false, hookTexts: [] })).toBeNull();
    expect(GB.hookManagerHint({ moved: false, movedToTracked: false, hookTexts: ['#!/bin/sh\n. husky.sh\n'] })).toBe('looks like a hook manager (husky)');
    expect(GB.hookManagerHint({ moved: false, movedToTracked: false, hookTexts: ['#!/bin/sh\ncurl evil\n'] })).toBeNull();
  });

  it('toBaseline hashes the config and keeps what could not be read as null', () => {
    const GB = baselineLib();
    const form = GB.toBaseline({ hooksDir: null, hooks: null, config: { 'alias.a': ['x'] } });
    expect(form.hooksDir).toBeNull();
    expect(form.hooks).toBeNull();
    expect(form.config['alias.a']).toMatch(/^[0-9a-f]{64}$/);
    expect(GB.toBaseline({ hooksDir: null, hooks: null, config: null }).config).toBeNull();
  });
});
