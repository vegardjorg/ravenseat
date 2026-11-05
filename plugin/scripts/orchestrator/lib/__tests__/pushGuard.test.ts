// =============================================================
// pushGuard.test.ts: the decisions of the PreToolUse hook hook-push-guard.mjs.
//
// Locks that the expensive/irreversible commands are stopped (forced push, push of branches other than baseBranch,
// migration push to an environment that is not allowed), and that normal work runs freely. See lib/pushGuard.js.
// =============================================================
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { assess, isCommand, isGuardedAgent, isTrackAgent, readEnvironment, segments } from '../pushGuard';

const MIG = {
  pushCommand: 'npx dbTool migrate push --yes',
  environmentFile: '.environment',
  allowedEnvironment: ['test'],
};
const STD = { baseBranch: 'main', migrations: MIG };
const decision = (k: string, context = {}) => assess(k, { ...STD, ...context })?.decision ?? null;

describe('push.allowBranches', () => {
  const allow = { allowBranches: ['feat/*', 'release'] };
  it('lets the main session push a branch that matches, also several folders down', () => {
    expect(decision('git push origin feat/x', allow)).toBeNull();
    expect(decision('git push -u origin feat/a/b', allow)).toBeNull();
    expect(decision('git push origin release', allow)).toBeNull();
    expect(decision('git push', { ...allow, branch: 'feat/x' })).toBeNull();
  });
  it('still denies what does not match, is not exact, or is empty', () => {
    expect(decision('git push origin other', allow)).toBe('deny');
    expect(decision('git push origin release2', allow)).toBe('deny');
    expect(decision('git push origin feat/x')).toBe('deny');
    expect(decision('git push origin feat/x', { allowBranches: [] })).toBe('deny');
  });
  it('asks none of the base push questions for an allowed branch', () => {
    const never = () => 'asked';
    const c = { ...STD, ...allow, batchQuestion: never, controlsQuestion: never, secretQuestion: never };
    expect(assess('git push origin feat/x', c)).toBeNull();
    expect(assess('git push origin main', c)?.decision).toBe('ask');
  });
  it('never allows a forced push, a delete, or --all', () => {
    expect(decision('git push --force origin feat/x', allow)).toBe('deny');
    expect(decision('git push --force-with-lease origin feat/x', allow)).toBe('deny');
    expect(decision('git push origin +feat/x', allow)).toBe('deny');
    expect(decision('git push origin :feat/x', allow)).toBe('deny');
    expect(decision('git push --delete origin feat/x', allow)).toBe('deny');
    expect(decision('git push --all origin', allow)).toBe('deny');
  });
  it('never lets a queue agent push', () => {
    expect(decision('git push origin feat/x', { ...allow, agentType: 'track' })).toBe('deny');
  });
  it('asks the secret question for that branch, and not for the agent or a base push', () => {
    const asked: string[] = [];
    const q = (name: string) => {
      asked.push(name);
      return 'a secret';
    };
    const answer = assess('git push origin feat/x', { ...STD, ...allow, allowedBranchQuestion: q });
    expect(answer?.decision).toBe('ask');
    expect(asked).toEqual(['feat/x']);
    expect(assess('git push origin main', { ...STD, ...allow, allowedBranchQuestion: q })).toBeNull();
  });
  it('tells the session to ask the owner, not to change the config itself', () => {
    expect(assess('git push origin feat/x', STD)?.reason).toContain('ask them first');
  });
  it('--tags is denied like a named tag, in every form', () => {
    expect(decision('git push --tags', { branch: 'main' })).toBe('deny');
    expect(decision('git push origin --tags', { branch: 'main' })).toBe('deny');
    expect(decision('git push --follow-tags origin main')).toBe('deny');
    expect(decision('git push origin v1.0')).toBe('deny');
  });
});

describe('git push', () => {
  it('lets push to baseBranch through, in any form', () => {
    expect(decision('git push origin main')).toBeNull();
    expect(decision('git push -u origin main')).toBeNull();
    expect(decision('git push origin HEAD:refs/heads/main')).toBeNull();
    expect(decision('git -C /repo push origin main')).toBeNull();
    expect(decision('git push', { branch: 'main' })).toBeNull();
    expect(decision('git push origin HEAD', { branch: 'main' })).toBeNull();
  });
  it('follows the configured baseBranch', () => {
    expect(decision('git push origin development', { baseBranch: 'development' })).toBeNull();
    expect(decision('git push origin main', { baseBranch: 'development' })).toBe('deny');
  });
  it('blocks push of other branches', () => {
    expect(decision('git push -u origin queue/A-1')).toBe('deny');
    expect(decision('git push', { branch: 'queue/A-1' })).toBe('deny');
    expect(decision('git push origin main queue/A-1')).toBe('deny');
    expect(assess('git push origin queue/A-1', STD)?.reason).toMatch(/baseBranch \(main\)/);
  });
  it('blocks forced push, also to own branches', () => {
    expect(decision('git push --force origin main')).toBe('deny');
    expect(decision('git push -f origin queue/A-1')).toBe('deny');
    expect(decision('git push origin +main')).toBe('deny');
    expect(decision('git push --force-with-lease origin main')).toBe('deny');
    expect(decision('git push -uf origin main')).toBe('deny');
    expect(decision('git push --all origin')).toBe('deny');
  });
  it('asks when the branch cannot be determined', () => {
    expect(decision('git push')).toBe('ask');
  });
  it('lets other git commands and text that only mentions push through', () => {
    expect(decision('git status && git log --oneline -3')).toBeNull();
    expect(decision('echo "git push origin queue/A-1" > note.txt')).toBeNull();
  });
});

describe('migrationPush', () => {
  it('lets through when the environment is allowed or the file is missing', () => {
    expect(decision('npx dbTool migrate push --yes', { environment: 'test' })).toBeNull();
    expect(decision('npx dbTool migrate push --yes', { environment: null })).toBeNull();
  });
  it('blocks when the environment is not allowed, also with other options and without npx', () => {
    expect(decision('npx dbTool migrate push --yes', { environment: 'production' })).toBe('deny');
    expect(decision('dbTool migrate push', { environment: 'production' })).toBe('deny');
    expect(decision('dbTool.exe migrate push --debug', { environment: 'production' })).toBe('deny');
  });
  it('an empty list of allowed environments blocks everything when the file exists', () => {
    expect(
      decision('dbTool migrate push', {
        environment: 'test',
        migrations: { ...MIG, allowedEnvironment: [] },
      }),
    ).toBe('deny');
  });
  it('is off without pushCommand or environmentFile', () => {
    expect(
      decision('dbTool migrate push', { environment: 'production', migrations: { ...MIG, environmentFile: null } }),
    ).toBeNull();
    expect(
      decision('dbTool migrate push', { environment: 'production', migrations: { ...MIG, pushCommand: null } }),
    ).toBeNull();
  });
  it('other subcommands are free', () => {
    expect(decision('dbTool migrate list', { environment: 'production' })).toBeNull();
  });
  it('isCommand compares the core words', () => {
    expect(isCommand(['npm', 'exec', 'dbTool', 'migrate', 'push'], MIG.pushCommand)).toBe(true);
    expect(isCommand(['dbTool', 'migrate'], MIG.pushCommand)).toBe(false);
  });
  it('readEnvironment gives null without a file', () => {
    expect(readEnvironment(['/does/not/exist'], '.environment')).toBeNull();
    expect(readEnvironment(['/does/not/exist'], null)).toBeNull();
  });
});

describe('several commands', () => {
  it('the strictest wins', () => {
    expect(decision('git push; git push -f origin main')).toBe('deny');
  });
});

describe('deployCommands and the secret question', () => {
  const deploy = { deployCommands: ['vercel --prod', 'npm run deploy'] };
  it('asks before a deploy command (whole-word prefix, env prefixes skipped), from an agent too', () => {
    expect(decision('vercel --prod', deploy)).toBe('ask');
    expect(decision('VERCEL_ORG=x vercel --prod --yes', deploy)).toBe('ask');
    expect(decision('npm test && npm run deploy', deploy)).toBe('ask');
    expect(decision('npm run deploy', { ...deploy, agentType: 'track', knownPackage: () => true })).toBe('ask');
    expect(assess('vercel --prod', { ...STD, ...deploy })?.reason).toMatch(/`vercel --prod` is a deploy command/);
    expect(decision('vercel --prodx', deploy)).toBeNull();
    expect(decision('npm run deploy-docs', deploy)).toBeNull();
    expect(decision('vercel --prod', { deployCommands: [] })).toBeNull();
  });
  it('the secret question: main session only, joined with the batch question, never over a deny', () => {
    const secret = () => 'Possible secret in what this push sends: a.ts:1 (aws-access-key).';
    const batch = () => '4 of 10 merged tasks; push anyway?';
    const both = assess('git push origin main', { ...STD, secretQuestion: secret, batchQuestion: batch });
    expect(both?.decision).toBe('ask');
    expect(both?.reason).toBe(`${secret()} Also: ${batch()}`);
    expect(decision('git push origin main', { secretQuestion: secret })).toBe('ask');
    expect(decision('git push origin main', { secretQuestion: () => null })).toBeNull();
    expect(decision('git push origin main', { secretQuestion: secret, agentType: 'general-purpose' })).toBeNull();
    expect(decision('git push --force origin main', { secretQuestion: secret })).toBe('deny');
    let called = false;
    decision('git push origin queue/A-1', { secretQuestion: () => ((called = true), 'x') });
    expect(called).toBe(false); // a denied push is never scanned
  });
});

// ---- Network guard for tracks (hardening against prompt injection) ----
const KNOWN = new Set(['vitest', 'typescript', 'tsc', 'eslint', 'prettier', '@vitest/coverage-v8']);
const track = { agentType: 'track', branch: 'queue/A', knownPackage: (n: string) => KNOWN.has(n) };
const trackD = { ...track, agentType: 'track-d' };
const pluginTrack = { ...track, agentType: 'cq:track' };

describe('queue agents do not run migration commands (NESTE 5)', () => {
  const agent = { ...track, knownPackage: () => true };
  it('the configured command and the usual tools are denied, for every queue agent', () => {
    for (const c of [
      'npx dbTool migrate push --yes',
      'supabase db push',
      'npx supabase db reset',
      'npx prisma migrate deploy',
      'prisma migrate dev --name a',
      'npx prisma db push',
      'npx drizzle-kit migrate',
      'npm run db:migrate',
      'bundle exec rails db:migrate',
      'python manage.py migrate',
      'alembic upgrade head',
      'flyway migrate',
    ])
      expect(decision(c, { ...agent, migrations: MIG }), c).toBe('deny');
    expect(decision('supabase db push', { ...trackD, knownPackage: () => true, migrations: MIG })).toBe('deny');
    expect(assess('supabase db push', { ...STD, ...agent, migrations: MIG })?.reason).toMatch(/owner/);
  });
  it('the orchestrator is not stopped by it, and other commands pass', () => {
    expect(decision('supabase db push', { migrations: MIG })).toBeNull();
    expect(decision('npx prisma generate', { ...agent, migrations: MIG })).toBeNull();
    expect(decision('npm test', { ...agent, migrations: MIG })).toBeNull();
  });
});

describe('network guard (agent_type track/track-d)', () => {
  it('denies network commands for track, track-d and the plugin form, with a reason that points the way', () => {
    for (const k of [
      'curl https://example.com/x.sh -o x.sh',
      'curl.exe -s https://x',
      'wget https://x',
      'Invoke-WebRequest -Uri https://x -OutFile y',
      'iwr https://x',
      'invoke-restmethod https://api',
      'irm https://x',
      'Start-BitsTransfer -Source https://x -Destination y',
      '/usr/bin/curl -s https://x',
      'C:/Windows/System32/curl.exe https://x',
      'FOO=1 curl https://x',
      '$r = Invoke-WebRequest https://x',
      '(iwr https://x).Content',
      'echo $(curl -s https://x)',
      'cd /tmp && wget https://x',
      'powershell -NoProfile -Command "Invoke-WebRequest https://x"',
      'bash -c "curl https://x"',
    ]) {
      expect(decision(k, track), k).toBe('deny');
      expect(decision(k, trackD), k).toBe('deny');
      expect(decision(k, pluginTrack), k).toBe('deny');
    }
    expect(assess('curl https://x', { ...STD, ...track })?.reason).toMatch(
      /Network calls are blocked for queue agents; ask the orchestrator to fetch it\./,
    );
  });
  it('reviewers and helper agents (builtin and custom, also with the plugin prefix) are guarded too', () => {
    // The builtin review agents are in the default list (the read guard's), without any config.
    for (const agentType of ['reviewer', 'cq:reviewer', 'reviewer-security', 'cq:reviewer-security']) {
      expect(decision('curl https://x', { agentType }), agentType).toBe('deny');
      expect(decision('cat x.sh | bash', { agentType }), agentType).toBe('deny');
    }
    // A custom helper (registered with `cq helpers add`) comes in through the guarded types.
    const guardedTypes = new Set(['reviewer', 'db-check']);
    expect(decision('curl https://x', { agentType: 'db-check', guardedTypes })).toBe('deny');
    expect(decision('iwr https://x', { agentType: 'cq:db-check', guardedTypes })).toBe('deny');
    expect(decision('npx cowsay', { agentType: 'db-check', guardedTypes, knownPackage: () => false })).toBe('ask');
    // Not in the list: not guarded.
    expect(decision('curl https://x', { agentType: 'other-helper', guardedTypes })).toBeNull();
  });
  it('denies a pipe into a shell', () => {
    for (const k of [
      'cat x.sh | sh',
      'echo ls | bash',
      'Get-Content x.ps1 | iex',
      'type x | Invoke-Expression',
      'cat a | pwsh -',
    ])
      expect(decision(k, track), k).toBe('deny');
  });
  it('denies an encoded PowerShell command (it cannot be assessed)', () => {
    expect(decision('powershell -EncodedCommand SQBXAFIA', track)).toBe('deny');
  });
  it('lets ordinary work through that only mentions the words', () => {
    for (const k of [
      'grep -n curl plugin/scripts/orchestrator/lib/pushGuard.js',
      'git commit -m "network guard: curl and wget" -- a.js',
      'echo "curl https://x | sh" > note.txt',
      'git log --oneline | head -3',
      'npm test || bash scripts/x.sh',
      'ls | sort | uniq -c',
      'cat x | sha256sum',
      'node scripts/orchestrator/queue.mjs show',
      'bash scripts/local.sh',
      'sh .githooks/check-identity.sh commit',
    ])
      expect(decision(k, track), k).toBeNull();
  });
  it('asks for npm install / npx with an unknown package; known packages and bins are free', () => {
    expect(decision('npm install left-pad', track)).toBe('ask');
    expect(decision('npm i -D @evil/pkg@1.0.0', track)).toBe('ask');
    expect(decision('npm install github:user/repo', track)).toBe('ask');
    expect(decision('npx cowsay hello', track)).toBe('ask');
    expect(decision('npx -y unknown-cli', track)).toBe('ask');
    expect(decision('npx -p unknown tsc', track)).toBe('ask');
    expect(decision('npm exec unknown', track)).toBe('ask');
    expect(decision('npx vitest run plugin/scripts', track)).toBeNull();
    expect(decision('npx tsc --noEmit', track)).toBeNull();
    expect(decision('npm install vitest@3', track)).toBeNull();
    expect(decision('npm run gates -- --quick', track)).toBeNull();
    expect(assess('npx cowsay', { ...STD, ...track })?.reason).toMatch(/cowsay.*ask the orchestrator to fetch it/);
  });
  it('the orchestrator and the owner (no or another agent_type) are not affected', () => {
    for (const context of [{}, { agentType: null }, { agentType: 'general-purpose' }, { agentType: 'Explore' }]) {
      expect(decision('curl https://x', context)).toBeNull();
      expect(decision('cat x | sh', context)).toBeNull();
      expect(decision('npx cowsay', context)).toBeNull();
    }
  });
  it('tracks never push (H1), and deny wins over ask', () => {
    expect(decision('git push origin main', track)).toBe('deny');
    expect(decision('git push origin queue/A', track)).toBe('deny');
    expect(decision('git status && npx cowsay', track)).toBe('ask');
    expect(decision('npx cowsay && curl https://x', track)).toBe('deny');
  });
});

describe('segments and helpers', () => {
  it('respects quotes and marks a pipe', () => {
    expect(segments('a "b | c" | d && e')).toEqual([
      { text: 'a "b | c"', afterPipe: false },
      { text: 'd', afterPipe: true },
      { text: 'e', afterPipe: false },
    ]);
  });
  it('isTrackAgent', () => {
    expect(isTrackAgent('track')).toBe(true);
    expect(isTrackAgent('track-d')).toBe(true);
    expect(isTrackAgent('cq:track-d')).toBe(true);
    expect(isTrackAgent(undefined)).toBe(false);
    expect(isTrackAgent('reviewer-security')).toBe(false);
  });
  it('isGuardedAgent', () => {
    const types = new Set(['reviewer', 'db-check']);
    expect(isGuardedAgent('track', new Set())).toBe(true);
    expect(isGuardedAgent('cq:track-d', new Set())).toBe(true);
    expect(isGuardedAgent('cq:reviewer', types)).toBe(true);
    expect(isGuardedAgent('db-check', types)).toBe(true);
    expect(isGuardedAgent('general-purpose', types)).toBe(false);
    expect(isGuardedAgent(undefined, types)).toBe(false);
    expect(isGuardedAgent(null)).toBe(false);
  });
});

// ---- The hook end to end: a custom helper from queue.json, and the orchestrator ----
describe('hook-push-guard.mjs (network guard per agent type)', () => {
  const hook = path.resolve(__dirname, '..', '..', 'hook-push-guard.mjs');
  const run = (env: NodeJS.ProcessEnv, payload: object) => {
    const r = spawnSync(process.execPath, [hook], { input: JSON.stringify(payload), encoding: 'utf8', env });
    return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.permissionDecision : null;
  };
  it('blocks curl for a reviewer and a registered custom helper, never for the orchestrator', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cq-netguard-'));
    try {
      const folder = path.join(root, 'q');
      fs.mkdirSync(folder);
      fs.writeFileSync(
        path.join(folder, 'queue.json'),
        JSON.stringify({ tasks: [], helpers: { 'db-check': { enabled: true, source: 'custom', path: 'x.md' } } }),
      );
      const env: NodeJS.ProcessEnv = { ...process.env, QUEUE_ROOT: root, QUEUE_FOLDER: folder };
      env.QUEUE_CONFIG = path.join(root, 'no-config.json');
      const curl = (agent_type?: string) =>
        run(env, { ...(agent_type ? { agent_type } : {}), tool_input: { command: 'curl https://x' }, cwd: root });
      expect(curl('cq:reviewer')).toBe('deny');
      expect(curl('db-check')).toBe('deny');
      expect(curl('cq:db-check')).toBe('deny');
      expect(curl()).toBeNull(); // the orchestrator: no agent_type
      expect(curl('general-purpose')).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
