// =============================================================
// redteam/hooks.ts: runs the plugin's PreToolUse hooks the way Claude Code does, for the red team tests (RT-30..33).
//
// Why: a guard in a hook holds only through the hook as hooks.json wires it. This takes the entries from the plugin's
// own hooks.json (matcher, command, args), runs each as a process with the JSON payload on stdin, and returns the
// strictest decision: 'deny', 'ask' or null (let through). The same reading as rt18-push-hook.test.ts.
// =============================================================
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { SCRIPTS } from './project';

const PLUGIN = path.resolve(SCRIPTS, '..', '..');
type Hook = { matcher: string; hooks: { command: string; args: string[] }[] };

/** The PreToolUse hooks in hooks.json whose matcher takes this tool, with ${CLAUDE_PLUGIN_ROOT} filled in. */
export function hooksFor(tool: string) {
  const all = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'hooks', 'hooks.json'), 'utf8')).hooks.PreToolUse as Hook[];
  return all
    .filter((h) => new RegExp(`^(?:${h.matcher})$`).test(tool))
    .flatMap((h) => h.hooks)
    .map((h) => ({ command: h.command, args: h.args.map((x) => x.replace('${CLAUDE_PLUGIN_ROOT}', PLUGIN)) }));
}

/**
 * The decision of every hook for one tool call, and the reasons given. `agent` makes it a subagent's call
 * (agent_type plus an agent_id, as Claude Code sends inside a subagent); without it, the main session's.
 */
export function decide(
  p: { repo: string; env: NodeJS.ProcessEnv | Record<string, string | undefined> },
  tool: string,
  toolInput: Record<string, unknown>,
  agent?: string,
) {
  let decision: string | null = null;
  const reasons: string[] = [];
  for (const h of hooksFor(tool)) {
    const r = spawnSync(h.command, h.args, {
      input: JSON.stringify({ tool_name: tool, tool_input: toolInput, cwd: p.repo, ...(agent ? { agent_type: agent, agent_id: 'rt-agent-1' } : {}) }),
      encoding: 'utf8',
      env: p.env as NodeJS.ProcessEnv,
      cwd: p.repo,
    });
    const out = r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput : null;
    const d = out?.permissionDecision ?? null;
    if (out?.permissionDecisionReason) reasons.push(out.permissionDecisionReason);
    if (d === 'deny' || (d === 'ask' && decision !== 'deny')) decision = d;
  }
  return { decision, reason: reasons.join('\n') };
}

/** The main session's push of the base branch, through the Bash hooks. */
export const push = (p: Parameters<typeof decide>[0], command = 'git push origin main') => decide(p, 'Bash', { command });
