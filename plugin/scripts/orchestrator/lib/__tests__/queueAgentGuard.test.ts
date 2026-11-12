// =============================================================
// queueAgentGuard.test.ts: the queue's agents cannot move the guards (review 2026-11-02, package A).
//
// Locks, one test per bypass form:
//   H1  a queue agent (track, track-d, reviewers, helpers, ask, reviewer-area) never runs `git push`, in any form
//       (HEAD:<base>, the base itself, --delete, :ref, --mirror, --all, --tags, -f, -C, send-pack, subtree push,
//       git-push, aliases). The main session keeps its rules (base push free with the batch question, other branches
//       and force denied), and deleting the base on the remote is denied for everyone.
//   H2  a queue agent runs only the allowed queue commands (prepare-track, gates, show, info, help, blockers, finding,
//       question, block, deliver, plan show|get), in the `ravenseat …`, `node …/queue.mjs …`, `node …/ravenseat.mjs …` and direct
//       script forms, never `--allow-guard`, `--force*` or `--by owner`. The orchestrator is free.
//   M1  the shell reading sees inside bash -c, sh -c, powershell -Command, pwsh -c, `&`, ( ), $( ), backticks,
//       ; && || |, git -c alias.x=…, git -C, env prefixes, cmd /c, eval/iex and runners; what it cannot read and looks
//       like a push gives ask (main session) or deny (queue agent).
//   M2  ask and reviewer-area (and every agent file in plugin/agents/) are guarded agents.
// The logic: lib/pushGuard.js, lib/shellCommands.js, lib/trackGuard.js (PLUGIN_AGENT_TYPES).
// =============================================================
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const PG = require('../pushGuard.js');
const SC = require('../shellCommands.js');
const TG = require('../trackGuard.js');

const STD = { baseBranch: 'staging', migrations: {}, deployCommands: [] };
const GUARDED: Set<string> = TG.queueAgentTypes();
const verdict = (command: string, context: Record<string, unknown> = {}) =>
  PG.assess(command, { ...STD, guardedTypes: GUARDED, knownPackage: () => true, ...context });
const decision = (command: string, context: Record<string, unknown> = {}) => verdict(command, context)?.decision ?? null;

/** The queue agent types the review names, with and without the plugin prefix. */
const AGENTS = ['track', 'ravenseat:track', 'track-d', 'ravenseat:track-d', 'reviewer', 'ravenseat:reviewer-security', 'ravenseat:ask', 'ask', 'ravenseat:reviewer-area', 'reviewer-area'];
const MAIN = { agentType: null, branch: 'staging' };

// ---- H1: queue agents never push --------------------------------------------------------------------------------------
describe('H1: a queue agent never pushes', () => {
  const forms: [string, string][] = [
    ['HEAD:<base>', 'git push origin HEAD:staging'],
    ['the base by name', 'git push origin staging'],
    ['a plain push on the base branch', 'git push'],
    ['refs/heads form', 'git push origin HEAD:refs/heads/staging'],
    ['its own branch', 'git push -u origin queue/A'],
    ['--delete', 'git push origin --delete staging'],
    ['-d', 'git push -d origin staging'],
    [':ref (empty source)', 'git push origin :staging'],
    ['--mirror', 'git push --mirror origin'],
    ['--all', 'git push --all origin'],
    ['--tags', 'git push --tags origin'],
    ['push -f', 'git push -f origin staging'],
    ['--force-with-lease', 'git push --force-with-lease origin staging'],
    ['git -C <main tree>', 'git -C C:/repo push origin HEAD:staging'],
    ['another remote', 'git push upstream HEAD:staging'],
    ['a URL as remote', 'git push https://example.invalid/r.git HEAD:staging'],
    ['send-pack', 'git send-pack origin staging'],
    ['subtree push', 'git subtree push --prefix=lib origin staging'],
    ['git-push program', 'git-push origin staging'],
    ['inline alias', 'git -c alias.p=push p origin staging'],
  ];
  for (const [name, command] of forms) {
    it(`denies ${name}: ${command}`, () => {
      for (const agentType of AGENTS) {
        const v = verdict(command, { agentType, branch: 'queue/A' });
        expect(v?.decision, `${agentType}: ${command}`).toBe('deny');
        expect(v?.reason, `${agentType}: ${command}`).toMatch(/Queue agents never push/);
      }
    });
  }
  it('denies a git alias defined in the repo config, and defining one', () => {
    expect(decision('git p origin staging', { agentType: 'track' })).toBe('deny');
    expect(verdict('git p', { agentType: 'track' })?.reason).toMatch(/not a git builtin/);
    expect(decision('git config alias.p push', { agentType: 'track' })).toBe('deny');
    expect(decision('git config --local alias.p "push -f"', { agentType: 'track' })).toBe('deny');
    expect(decision('git --config-env=alias.p=PUSHER p', { agentType: 'track' })).toBe('deny');
  });
  it('lets a queue agent run ordinary git', () => {
    for (const command of [
      'git status',
      'git log --oneline -5',
      'git diff staging...queue/A --stat',
      'git commit -m "push guard: deny every push for queue agents" -- lib/a.js',
      'git add -- lib/a.js && git commit -m x -- lib/a.js',
      'git config user.name x',
      'git -c alias.st=status st',
      'git -C C:/repo switch --detach',
      'git worktree list',
      'git rev-parse --abbrev-ref HEAD 2>&1',
      'git log --grep push',
    ])
      expect(decision(command, { agentType: 'track', branch: 'queue/A' }), command).toBeNull();
  });
  it('the main session keeps its rules: the base is free, force and other branches are denied', () => {
    expect(decision('git push origin staging', MAIN)).toBeNull();
    expect(decision('git push origin HEAD:staging', MAIN)).toBeNull();
    expect(decision('git push', MAIN)).toBeNull();
    expect(decision('git push origin staging 2>&1', MAIN)).toBeNull();
    expect(decision('git push origin staging > push.log 2>&1', MAIN)).toBeNull();
    expect(decision('git push -f origin staging', MAIN)).toBe('deny');
    expect(decision('git push origin queue/A', MAIN)).toBe('deny');
    expect(decision('git push --mirror origin', MAIN)).toBe('deny');
    expect(decision('git push', { ...MAIN, branch: null })).toBe('ask');
  });
  it('denies deleting the base on the remote for everyone, also the main session', () => {
    for (const command of ['git push origin --delete staging', 'git push origin :staging', 'git push -d origin staging']) {
      const v = verdict(command, MAIN);
      expect(v?.decision, command).toBe('deny');
      expect(v?.reason, command).toMatch(/Deleting baseBranch \(staging\)/);
    }
    // Another branch was already denied (only the base is pushed).
    expect(decision('git push origin --delete queue/A', MAIN)).toBe('deny');
  });
  it('the main session confirms send-pack and subtree push (forms the rules do not assess)', () => {
    expect(decision('git send-pack origin staging', MAIN)).toBe('ask');
    expect(decision('git subtree push --prefix=lib origin staging', MAIN)).toBe('ask');
  });
});

// ---- H2: queue agents run only the allowed queue commands ---------------------------------------------------------
describe('H2: a queue agent runs only the allowed queue commands', () => {
  const denied: [string, string][] = [
    ['ravenseat merge', 'ravenseat merge R'],
    ['ravenseat merge --allow-guard', 'ravenseat merge R --allow-guard'],
    ['ravenseat set', 'ravenseat set R done'],
    ['ravenseat edit owned_files', `ravenseat edit R --json '{"owned_files":[".claude/"]}'`],
    ['ravenseat edit --by owner', `ravenseat edit R --json '{"value":3}' --by owner`],
    ['ravenseat edit-many', 'ravenseat edit-many --file x.json'],
    ['ravenseat approve', 'ravenseat approve R'],
    ['ravenseat resolve', 'ravenseat resolve R-q1 --choice 1'],
    ['ravenseat undo', 'ravenseat undo'],
    ['ravenseat undo --by owner', 'ravenseat undo --by owner'],
    ['ravenseat queue <command>', 'ravenseat queue set R done'],
    ['ravenseat.cmd', 'ravenseat.cmd merge R'],
    ['bin/ravenseat path', 'C:/plugins/ravenseat/bin/ravenseat merge R'],
    ['node queue.mjs', 'node scripts/orchestrator/queue.mjs merge R'],
    ['node queue.mjs edit', 'node C:/x/plugin/scripts/orchestrator/queue.mjs edit R --json {}'],
    ['node ravenseat.mjs', 'node scripts/orchestrator/ravenseat.mjs set R done'],
    ['node merge-track.mjs', 'node scripts/orchestrator/merge-track.mjs queue/R --allow-guard'],
    ['ravenseat merge-track', 'ravenseat merge-track queue/R'],
    ['cd main && ravenseat merge', 'cd C:/repo && ravenseat merge R --allow-guard'],
    ['--force on an allowed command', 'ravenseat gates --quick --force'],
    ['--force-merge', 'ravenseat deliver R --force-merge'],
    ['--by owner on an allowed command', 'ravenseat question R-q1 --text x --by owner'],
    ['--by=theBoard', 'ravenseat block R other --by=theBoard'],
    ['ravenseat plan writes', 'ravenseat plan new --title x'],
    ['ravenseat start', 'ravenseat start R'],
    ['ravenseat release', 'ravenseat release R'],
    ['ravenseat helpers', 'ravenseat helpers off reviewer-gap'],
    ['ravenseat push-check', 'ravenseat push-check'],
  ];
  for (const [name, command] of denied) {
    it(`denies ${name}: ${command}`, () => {
      for (const agentType of AGENTS) expect(decision(command, { agentType }), `${agentType}: ${command}`).toBe('deny');
    });
  }
  it('lets a queue agent run what the mission and the agent files ask for', () => {
    for (const command of [
      'ravenseat prepare-track R --branch queue/R --scratchpad "C:/tmp/s"',
      'ravenseat prepare-track R-r1 --branch queue/R --continue --scratchpad "C:/tmp/s"',
      'ravenseat gates --precheck',
      'ravenseat gates --quick --log "C:/tmp/s/R/gates"',
      'ravenseat show',
      'ravenseat info R --field labels',
      'ravenseat help',
      'ravenseat',
      'ravenseat blockers',
      'ravenseat finding "Flaky date test" --detail "x"',
      'ravenseat finding list',
      'ravenseat question R-q1 --text "Which table?" --type question',
      'ravenseat block R other --note "waiting on owner"',
      'ravenseat deliver R',
      'ravenseat plan show PL-1',
      'ravenseat plan get PL-1',
      'node scripts/orchestrator/queue.mjs show',
      'node scripts/orchestrator/ravenseat.mjs info R',
      'node scripts/orchestrator/gates.mjs --quick',
    ])
      expect(decision(command, { agentType: 'track' }), command).toBeNull();
  });
  it('gives a reason that names the allowed commands and the override flag', () => {
    expect(verdict('ravenseat merge R', { agentType: 'track' })?.reason).toMatch(/`ravenseat merge` is not for queue agents.*Allowed: prepare-track/);
    expect(verdict('ravenseat merge R --allow-guard', { agentType: 'track' })?.reason).toMatch(/`--allow-guard` is the orchestrator's/);
    expect(verdict('ravenseat plan new', { agentType: 'reviewer-gap' })?.reason).toMatch(/only reads here/);
  });
  it('the orchestrator (no agent_type) and other agent types the agent guard leaves out run every queue command', () => {
    for (const command of ['ravenseat merge R --allow-guard', 'ravenseat set R done', 'ravenseat undo --by owner', 'node scripts/orchestrator/queue.mjs edit R --json {}']) {
      expect(decision(command, MAIN), command).toBeNull();
      expect(decision(command, { agentType: 'general-purpose', agentGuard: { except: ['general-purpose'] } }), command).toBeNull();
      // Guarded by default (owner decision B3).
      expect(decision(command, { agentType: 'general-purpose' }), command).toBe('deny');
    }
  });
});

// ---- M1: the shell reading ------------------------------------------------------------------------------------------
describe('M1: the push guard reads nested and wrapped commands', () => {
  // Each form wraps a forced push: the main session gets deny (force is never allowed).
  const forms: [string, string][] = [
    ['bash -c', 'bash -c "git push --force origin staging"'],
    ['bash -lc', 'bash -lc "git push --force origin staging"'],
    ['sh -c', "sh -c 'git push -f origin staging'"],
    ['zsh -c nested in bash -c', `bash -c "zsh -c 'git push -f origin staging'"`],
    ['powershell -Command', 'powershell -NoProfile -Command "git push --force origin staging"'],
    ['powershell -Command unquoted', 'powershell -Command git push -f origin staging'],
    ['pwsh -c', 'pwsh -c "git push -f origin staging"'],
    ['pwsh -Comm (prefix)', 'pwsh -Comm "git push -f origin staging"'],
    ['the & call operator', '& git push --force origin staging'],
    ['& with a quoted path', `& 'C:/Program Files/Git/cmd/git.exe' push --force origin staging`],
    ['a ( ) subshell', '(git push -f origin staging)'],
    ['$( )', 'echo $(git push -f origin staging)'],
    ['$( ) in double quotes', 'echo "done: $(git push -f origin staging)"'],
    ['backticks', 'echo `git push -f origin staging`'],
    ['backticks in double quotes', 'echo "x `git push -f origin staging`"'],
    ['a { } block', 'Invoke-Command -ScriptBlock { git push -f origin staging }'],
    ['after ;', 'git status; git push -f origin staging'],
    ['after &&', 'npm test && git push -f origin staging'],
    ['after ||', 'false || git push -f origin staging'],
    ['after a pipe', 'echo y | git push -f origin staging'],
    ['git -c alias.x=push', 'git -c alias.p=push p --force origin staging'],
    ['git -c alias with flags', 'git -c "alias.p=push --force" p origin staging'],
    ['git -c alias chain', 'git -c alias.a=b -c alias.b=push a -f origin staging'],
    ['git -c shell alias', 'git -c "alias.p=!git push -f origin staging" p'],
    ['git -C', 'git -C ../main push -f origin staging'],
    ['env prefix', 'GIT_TRACE=1 git push -f origin staging'],
    ['env command', 'env GIT_TRACE=1 git push -f origin staging'],
    ['cmd /c', 'cmd /c git push -f origin staging'],
    ['cmd.exe /C quoted', 'cmd.exe /C "git push --force origin staging"'],
    ['eval', 'eval "git push -f origin staging"'],
    ['iex', 'iex "git push -f origin staging"'],
    ['timeout runner', 'timeout 60 git push -f origin staging'],
    ['wsl runner', 'wsl git push -f origin staging'],
  ];
  for (const [name, command] of forms) {
    it(`sees the push in ${name}: ${command}`, () => {
      expect(decision(command, MAIN), command).toBe('deny');
      expect(decision(command, { agentType: 'track' }), command).toBe('deny');
    });
  }
  const unreadable: [string, string][] = [
    ['a variable as git', `$g = 'git'; & $g push -f origin staging`],
    ['node -e', `node -e "require('child_process').execSync('git push -f origin staging')"`],
    ['python -c', `python -c "import os; os.system('git push -f origin staging')"`],
    ['xargs', 'echo origin staging | xargs git push -f'],
    ['Start-Process', `Start-Process git -ArgumentList 'push','-f','origin','staging'`],
    ['a pipe into a shell', 'echo "git push -f origin staging" | bash'],
    ['find -exec', 'find . -name x -exec git push -f origin staging ;'],
  ];
  for (const [name, command] of unreadable) {
    it(`asks (main) and denies (agent) when it cannot read ${name}: ${command}`, () => {
      const main = verdict(command, MAIN);
      expect(main?.decision, command).toBe('ask');
      expect(main?.reason, command).toMatch(/cannot read this command/);
      expect(decision(command, { agentType: 'track' }), command).toBe('deny');
    });
  }
  it('denies an unreadable command that calls the queue CLI, for a queue agent only', () => {
    const command = `node -e "require('child_process').execSync('ravenseat merge R --allow-guard')"`;
    expect(decision(command, { agentType: 'track' })).toBe('deny');
    expect(decision(command, MAIN)).toBeNull();
  });
  it('sees a queue CLI call inside a wrapper for a queue agent', () => {
    for (const command of ['bash -c "ravenseat merge R"', 'powershell -Command "ravenseat set R done"', '(ravenseat undo)', 'cmd /c ravenseat edit R --json {}'])
      expect(decision(command, { agentType: 'track' }), command).toBe('deny');
  });
  it('lets text that only mentions push through (quotes, single-quoted backticks, echo)', () => {
    for (const command of [
      'echo "git push -f origin staging" > note.txt',
      `git commit -m 'docs: \`git push -f\` is denied' -- a.md`,
      'git commit -m "push guard: read bash -c" -- a.js',
      'grep -n "git push" lib/pushGuard.js',
      'node scripts/orchestrator/queue.mjs show',
    ]) {
      expect(decision(command, MAIN), command).toBeNull();
      expect(decision(command, { agentType: 'track' }), command).toBeNull();
    }
  });
  it('commandList: nested commands, redirections and the opaque reason', () => {
    const words = (command: string) => SC.commandList(command).commands.map((c: { word: string }) => c.word);
    expect(words('bash -c "cd x && git status" 2>&1 | tee log')).toEqual(['cd', 'git', 'tee']);
    expect(SC.commandList('git push origin staging 2>&1').commands[0].t).toEqual(['git', 'push', 'origin', 'staging']);
    expect(SC.commandList('git push origin staging >out.log').commands[0].t).toEqual(['git', 'push', 'origin', 'staging']);
    expect(SC.commandList('& $g push').commands[0].opaque).toMatch(/variable/);
    const deep = 'bash -c "bash -c \'bash -c \\"bash -c x\\"\'"';
    expect(SC.commandList(deep).commands.length + SC.commandList(deep).unsure.length).toBeGreaterThan(0);
  });
});

// ---- M2: ask and reviewer-area are guarded ------------------------------------------------------------------------
describe('M2: every shipped agent is a guarded queue agent', () => {
  it('PLUGIN_AGENT_TYPES lists exactly the files in plugin/agents/', () => {
    const folder = path.resolve(__dirname, '..', '..', '..', '..', 'agents');
    const files = fs
      .readdirSync(folder)
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.slice(0, -3))
      .sort();
    expect([...TG.PLUGIN_AGENT_TYPES].sort()).toEqual(files);
  });
  it('ask and reviewer-area are guarded with the default list (network, push, queue CLI)', () => {
    for (const agentType of ['ask', 'ravenseat:ask', 'reviewer-area', 'ravenseat:reviewer-area', 'triage']) {
      expect(PG.isGuardedAgent(agentType, GUARDED), agentType).toBe(true);
      expect(decision('curl https://example.invalid/x', { agentType }), agentType).toBe('deny');
      expect(decision('git push origin HEAD:staging', { agentType }), agentType).toBe('deny');
      expect(decision('ravenseat merge R', { agentType }), agentType).toBe('deny');
    }
    expect(PG.isGuardedAgent('general-purpose', GUARDED)).toBe(true); // owner decision B3: every subagent
    expect(PG.isGuardedAgent('general-purpose', GUARDED, { enabled: false })).toBe(false);
  });
});

// ---- The hook end to end -----------------------------------------------------------------------------------------
describe('hook-push-guard.mjs: queue agents', () => {
  const hook = path.resolve(__dirname, '..', '..', 'hook-push-guard.mjs');
  it('denies a track and ask their push and ravenseat merge, never the orchestrator', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ravenseat-agentguard-'));
    try {
      const folder = path.join(root, 'q');
      fs.mkdirSync(folder);
      fs.writeFileSync(path.join(folder, 'queue.json'), JSON.stringify({ tasks: [] }));
      const env: NodeJS.ProcessEnv = { ...process.env, QUEUE_ROOT: root, QUEUE_FOLDER: folder };
      env.QUEUE_CONFIG = path.join(root, 'no-config.json');
      const run = (command: string, agent_type?: string) => {
        const r = spawnSync(process.execPath, [hook], {
          input: JSON.stringify({ ...(agent_type ? { agent_type } : {}), tool_input: { command }, cwd: root }),
          encoding: 'utf8',
          env,
        });
        return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.permissionDecision : null;
      };
      expect(run('git push origin HEAD:main', 'ravenseat:track')).toBe('deny');
      expect(run('ravenseat merge R --allow-guard', 'ravenseat:track')).toBe('deny');
      expect(run('bash -c "git push origin HEAD:main"', 'ravenseat:ask')).toBe('deny');
      expect(run('ravenseat show', 'ravenseat:track')).toBeNull();
      expect(run('ravenseat merge R --allow-guard')).toBeNull(); // the orchestrator
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
  it('with an unreadable queue.config.json: git push asks (main) and is denied (queue agent); a track still runs only allowed commands', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ravenseat-agentguard-bad-'));
    try {
      const folder = path.join(root, 'q');
      fs.mkdirSync(folder);
      fs.writeFileSync(path.join(folder, 'queue.json'), JSON.stringify({ tasks: [] }));
      const file = path.join(root, 'queue.config.json');
      fs.writeFileSync(file, '{\n  "baseBranch": "staging",\n}\n');
      const env: NodeJS.ProcessEnv = { ...process.env, QUEUE_ROOT: root, QUEUE_FOLDER: folder, QUEUE_CONFIG: file };
      const run = (command: string, agent_type?: string) => {
        const r = spawnSync(process.execPath, [hook], {
          input: JSON.stringify({ ...(agent_type ? { agent_type } : {}), tool_input: { command }, cwd: root }),
          encoding: 'utf8',
          env,
        });
        return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null;
      };
      const main = run('git push origin staging');
      expect(main?.permissionDecision).toBe('ask');
      expect(main?.permissionDecisionReason).toMatch(/config unreadable/);
      expect(run('git push origin staging', 'ravenseat:track')?.permissionDecision).toBe('deny');
      expect(run('git status')).toBeNull();
      expect(run('ravenseat merge R', 'ravenseat:track')?.permissionDecision).toBe('deny');
      expect(run('ravenseat show', 'ravenseat:track')).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
