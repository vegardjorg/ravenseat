#!/usr/bin/env node
// =============================================================
// hook-push-guard.mjs: PreToolUse hook (Bash/PowerShell) that stops the expensive and irreversible commands before
// they run: forced push, push of branches other than baseBranch, and migration push to an environment that is not
// allowed (see lib/pushGuard.js for the rules and the reasoning, and docs/orchestration.md).
//
// What it does: reads the hook payload from stdin, finds the current branch and (when migrations.environmentFile is set)
// the contents of the environment file, and asks lib/pushGuard.js. The answer is "ask" (Claude Code shows a confirmation
// dialog), "deny" (blocked, with reason) or nothing (normal flow).
//
// Fails OPEN: an internal error (invalid payload, git missing) gives exit 0 without a decision and a line on stderr.
// The guard must never stop normal work because of a bug in itself. If node is missing on PATH, the hook gets exit 127,
// which Claude Code treats as non-blocking.
//
// For the queue's agents (agent_type track/track-d and every reviewer and helper agent, builtin or custom, the same list
// as the read guard) it also assesses network calls (curl, iwr, | sh, an unknown npx package); see lib/pushGuard.js.
// The orchestrator (the main session, no agent_type) is not affected.
//
// The batch threshold (config().push, lib/pushBatch.js): a plain push of baseBranch by the orchestrator gets "ask" when
// the base is red at the tip or fewer than push.minTasks merged tasks are unpushed. Counting costs ONE git call, made
// only when such a push is found: `git log --first-parent <remote>/<baseBranch>..refs/heads/<baseBranch>` with parents
// and subject; a merge commit "Merge branch '<branchPrefix><id>' ..." (what cq merge writes) is one merged task, and the
// newest row is the tip whose health base-health.json records. The local remote ref (as of the last fetch) is the
// "last push"; a missing remote ref (first push) or any error gives no question (fails open).
//
// The full gate (lib/gateEvidence.js): the same plain push also asks when the tip has no green, clean full-gate run
// recorded by the orchestrator's side (`cq gates --full` in the main checkout), with the hint to run it; only when
// gates.full has commands. For the queue's agents the guard denies a command that names the gate evidence store or
// passes --evidence/--cwd to the gate runner, so a track cannot record its own evidence.
//
// The secret precheck (config().secretScan, lib/secretScan.js): the same plain push of baseBranch by the orchestrator
// scans the added lines of `<remote>/<baseBranch>..<baseBranch>` (gitleaks when on PATH, else built-in patterns) and
// asks with file:line on a hit. Skipped silently over secretScan.maxBytes, on a timeout or any error (fails open).
// deployCommands: a command that starts with one of them gets "ask" (agents and the main session).
//
// The missing controls (lib/controls.js, push.controlsWarning): the same plain push asks when the project has no CI config
// or no gates, with what is missing and how many commits. Also on a first push, which is what a new user does. Never a deny.
//
// Test: lib/__tests__/pushGuard.test.ts (the logic). Smoke test of the hook itself:
//   echo '{"tool_input":{"command":"git push --force origin main"},"cwd":"."}' | node scripts/orchestrator/hook-push-guard.mjs
//   echo '{"agent_type":"track","tool_input":{"command":"curl https://x"},"cwd":"."}' | node scripts/orchestrator/hook-push-guard.mjs
// =============================================================

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
// Not a queue project (no queue.config.json): do nothing. A plugin's hooks run in every project the user opens.
if (!require('./lib/projectRoot.js').queueActive()) process.exit(0);
const { assess, readEnvironment, isGuardedAgent } = require('./lib/pushGuard.js');
const { config, dataFolder } = require('./lib/queueConfig.js');

function read(stdin) {
  try {
    return JSON.parse(stdin || '{}');
  } catch {
    return null;
  }
}

/**
 * The batch question for a plain push of baseBranch (lib/pushBatch.js guardQuestion), or null. One git call; the
 * source is the local base branch (a push of `HEAD:<base>` from elsewhere is measured by the base branch too; good
 * enough for a reminder). Any error: null (the push goes on).
 */
function batchQuestion(cwd, k) {
  try {
    const PB = require('./lib/pushBatch.js');
    const setup = PB.pushSetup(k);
    const run = (args) => git(cwd, args);
    const batch = PB.readBatch(run, {
      from: `refs/remotes/${k.remote}/${k.baseBranch}`,
      to: `refs/heads/${k.baseBranch}`,
      prefix: k.branchPrefix,
      withCommits: false,
    });
    if (!batch || batch.firstParent === 0) return null;
    const BH = require('./lib/baseHealth.js');
    const health = BH.verdict(BH.readState(path.join(dataFolder(), 'base-health.json')), batch.tip);
    // The full gate on exactly the tip being pushed, from the trusted gate evidence (lib/gateEvidence.js).
    const fullGate = require('./lib/gateEvidence.js').fullGateVerdict({ folder: dataFolder(), sha: batch.tip, cfg: k });
    return PB.guardQuestion({ batch, setup, health, fullGate });
  } catch {
    return null;
  }
}

/** The secret precheck question for a plain push of baseBranch (lib/secretScan.js), or null. Any error: null. */
function secretQuestion(cwd, k) {
  try {
    if (k.secretScan?.enabled === false) return null;
    const SS = require('./lib/secretScan.js');
    return SS.question(SS.scanPush({ cwd, remote: k.remote, branch: k.baseBranch, setup: k.secretScan }));
  } catch {
    return null;
  }
}

/** The question for a push with no CI config or no gates (lib/controls.js), or null. Any error: null. */
function controlsQuestion(cwd, k) {
  try {
    if (k.push?.controlsWarning === false) return null;
    const C = require('./lib/controls.js');
    const missing = C.missing(k, k.root);
    if (!missing.length) return null;
    const head = `refs/heads/${k.baseBranch}`;
    const remote = `refs/remotes/${k.remote}/${k.baseBranch}`;
    // A first push has no remote ref: everything on the branch goes.
    const range = git(cwd, ['rev-parse', '-q', '--verify', remote]) ? `${remote}..${head}` : head;
    return C.question({ missing, commits: Number(git(cwd, ['rev-list', '--count', range])) || 0 });
  } catch {
    return null;
  }
}

function git(cwd, args) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/** Main tree for an agent worktree (<root>/.claude/worktrees/<name>), otherwise the path itself. */
function mainTree(top) {
  return String(top).split(/[\\/]\.claude[\\/]worktrees[\\/]/)[0];
}

/** Only commands that can match: git, a deploy command or the first word of the migration command. Saves git calls. */
function canHit(command, k) {
  if (/\bgit\b/.test(command)) return true;
  const deploys = Array.isArray(k.deployCommands) ? k.deployCommands : [];
  if (deploys.some((d) => String(d || '').trim() && command.includes(String(d).trim().split(/\s+/)[0]))) return true;
  const word = String(k.migrations?.pushCommand || '')
    .split(/\s+/)
    .filter((x) => x && !x.startsWith('-') && !['npx', 'npm', 'pnpm', 'yarn', 'exec'].includes(x));
  return word.length > 0 && command.includes(word[0]);
}

/**
 * Does the project know the package? It is in package.json (all dependency fields) or has a bin in node_modules/.bin
 * (npx then does not fetch from the network). Read lazily, the first time npm/npx is actually assessed.
 */
function knownPackage(cwd) {
  let names = null;
  return (pkg) => {
    if (!names) {
      names = new Set();
      try {
        const pj = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
        for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'])
          for (const n of Object.keys(pj[field] || {})) names.add(n);
      } catch {
        // no package.json here: every package is unknown (gives "ask", never deny)
      }
    }
    if (names.has(pkg)) return true;
    const bin = path.join(cwd, 'node_modules', '.bin', pkg);
    return [bin, `${bin}.cmd`].some((f) => fs.existsSync(f));
  };
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  try {
    const p = read(input);
    const command = p?.tool_input?.command;
    if (!p || typeof command !== 'string') process.exit(0);
    const k = config();
    // agent_type exists only when the hook fires in a subagent (tracks, reviewers and helpers get the network guard).
    const agentType = typeof p.agent_type === 'string' ? p.agent_type : null;
    // The guarded types are read once (config + queue.json), and only in a subagent.
    const guardedTypes = agentType ? require('./lib/trackGuard.js').queueAgentTypes() : new Set();
    const guarded = isGuardedAgent(agentType, guardedTypes);
    // queue.config.json exists but does not parse (lib/configGuard.js, review H3): the project's base branch,
    // migration guard and deploy commands are unknown, so a push, migration or deploy shaped command gets ask (main
    // session) or deny (queue agent). The main session stops here: the other rules would run on defaults that are not
    // the project's. A queue agent goes on through the rules below, which do not depend on the config (it never
    // pushes, runs only the allowed queue commands, has no network).
    if (k.configError) {
      const answer = require('./lib/configGuard.js').answerForHook(command, k.configError, guarded);
      if (answer) {
        process.stdout.write(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: answer.decision,
              permissionDecisionReason: `push-guard: ${answer.reason}`,
            },
          }),
        );
        process.exit(0);
      }
      if (!guarded) process.exit(0);
    }
    const gitContext = canHit(command, k);
    if (!gitContext && !guarded) process.exit(0);
    // Gate evidence (lib/gateEvidence.js): a queue agent may not record or touch it (deny; the orchestrator is free).
    const tamper = guarded ? require('./lib/gateEvidence.js').tamperReason(command) : null;
    if (tamper) {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: `push-guard: ${tamper}`,
          },
        }),
      );
      process.exit(0);
    }

    const cwd = typeof p.cwd === 'string' && p.cwd ? p.cwd : process.cwd();
    // The git calls only when the command can be a push or a migration push.
    const branch = gitContext ? git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']) : null;
    const top = gitContext ? git(cwd, ['rev-parse', '--show-toplevel']) : null;
    const environment = gitContext
      ? readEnvironment([top, top && mainTree(top), k.root], k.migrations?.environmentFile)
      : null;
    const answer = assess(command, {
      branch: branch === 'HEAD' ? null : branch,
      environment,
      baseBranch: k.baseBranch,
      migrations: k.migrations,
      deployCommands: k.deployCommands,
      agentType,
      guardedTypes,
      knownPackage: guarded ? knownPackage(cwd) : undefined,
      batchQuestion: () => batchQuestion(cwd, k),
      secretQuestion: () => secretQuestion(cwd, k),
      controlsQuestion: () => controlsQuestion(cwd, k),
    });
    if (!answer) process.exit(0);

    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: answer.decision,
          permissionDecisionReason: `push-guard: ${answer.reason}`,
        },
      }),
    );
    process.exit(0);
  } catch (e) {
    process.stderr.write(
      `push-guard: internal error, letting the command through (${e?.message ?? e})\n`,
    );
    process.exit(0);
  }
});
