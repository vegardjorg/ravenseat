// =============================================================
// redteam/rt18-push-hook.test.ts: RT-18 "nothing pushes what it must not, however the command is written"
// (plans/redteam-plan.md, R3).
//
// Why: the push guard is a hook, so the promise holds only through the hook as Claude Code runs it. This test takes the
// PreToolUse entry from the plugin's own hooks.json (the matcher, the command and its args), runs it as a process with the
// JSON payload on stdin, in a real repo with a queue, for the Bash and the PowerShell tool, and with the forms a careless
// or clever command takes: -f, +ref, --force-with-lease, git -C, a cd first, wrapped in bash -c or powershell -c, and a
// push of another branch. pushGuard.test.ts has the decisions one by one; this is the wiring around them.
// =============================================================
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { project, SCRIPTS } from './project';

const PLUGIN = path.resolve(SCRIPTS, '..', '..');
type Hook = { matcher: string; hooks: { command: string; args: string[] }[] };

/** The PreToolUse hooks in hooks.json whose matcher takes this tool, with ${CLAUDE_PLUGIN_ROOT} filled in. */
function hooksFor(tool: string) {
  const all = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'hooks', 'hooks.json'), 'utf8')).hooks.PreToolUse as Hook[];
  return all
    .filter((h) => new RegExp(`^(?:${h.matcher})$`).test(tool))
    .flatMap((h) => h.hooks)
    .map((h) => ({ command: h.command, args: h.args.map((x) => x.replace('${CLAUDE_PLUGIN_ROOT}', PLUGIN)) }));
}

describe('RT-18: nothing pushes what it must not, however the command is written', () => {
  const p = project();
  /** The decision of the guard hooks for one command: deny, ask, or null (let through). */
  const decide = (tool: string, command: string, agent_type?: string) => {
    let decision: string | null = null;
    for (const h of hooksFor(tool)) {
      const r = spawnSync(h.command, h.args, {
        input: JSON.stringify({ tool_name: tool, tool_input: { command }, cwd: p.repo, ...(agent_type ? { agent_type } : {}) }),
        encoding: 'utf8',
        env: p.env,
        cwd: p.repo,
      });
      const d = r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput?.permissionDecision : null;
      if (d === 'deny' || (d === 'ask' && decision !== 'deny')) decision = d;
    }
    return decision;
  };

  it('hooks.json wires the guard for both shells', () => {
    for (const tool of ['Bash', 'PowerShell'])
      expect(hooksFor(tool).some((h) => h.args.some((a) => a.endsWith('hook-push-guard.mjs'))), tool).toBe(true);
  });

  const FORCED = [
    'git push --force origin main',
    'git push -f origin main',
    'git push origin +main',
    'git push --force-with-lease origin main',
    `git -C "${'.'}" push -f origin main`,
    'cd lib && git push --force origin main',
    "bash -c 'git push -f origin main'",
    'powershell -c "git push --force origin main"',
    'git push origin main --force',
    'git push origin main -f',
    'git   push   -f   origin   main',
    'GIT_TRACE=1 git push -f origin main',
    '"git" push -f origin main',
    'git push origin main:main --force',
    'git push origin -uf main',
    'echo ok; git push -f origin main',
    'git push --force-if-includes --force-with-lease origin main',
  ];
  const ELSEWHERE = ['git push origin queue/A', 'git push origin HEAD:refs/heads/other', 'git push --all origin', 'git push --mirror origin'];

  for (const tool of ['Bash', 'PowerShell']) {
    it(`${tool}: a forced push is refused in every form`, () => {
      for (const c of FORCED) expect(decide(tool, c), c).toBe('deny');
    });
    it(`${tool}: a push of another branch than main is refused`, () => {
      for (const c of ELSEWHERE) expect(decide(tool, c), c).toBe('deny');
    });
  }

  it('a track agent never pushes, not even main; the orchestrator may push main', () => {
    expect(decide('Bash', 'git push origin main', 'ravenseat:track')).toBe('deny');
    expect(decide('Bash', 'git push origin main')).not.toBe('deny');
  });
});
