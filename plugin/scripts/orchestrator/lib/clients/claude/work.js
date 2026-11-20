// =============================================================
// lib/clients/claude/work.js: which Claude Code tool calls are real work (roadmap 0æ N3, SPINNING).
//
// Why: a transcript that keeps growing looks alive to SILENT, also when the agent only loads tools, writes to-do lists,
// sleeps or reads the same file again. Which tool names are bookkeeping is the client's business, so the list lives here
// in the adapter and the core (lib/trackSpin.js) only asks callKind.
//
// The kinds:
//   - 'bookkeeping': the client's own planning and loading calls (to-do lists, tool search, skills, the app's turn tools);
//   - 'wait': a shell command that only sleeps, or a call that only waits on a background job;
//   - 'read': a read (Read, Grep, Glob, LS, NotebookRead, or a read-only shell command); the core counts the FIRST read
//     of the same thing as work and a repeat as not, so `key` names what was read;
//   - 'work': everything else (writing, editing, running tests or any other command, starting an agent).
// Pure. Tested in lib/__tests__/trackSpin.test.ts.
// =============================================================
'use strict';

const BOOKKEEPING = new Set([
  'TodoWrite', 'ToolSearch', 'Skill', 'ListSkills', 'SearchSkills', 'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate',
]);
/** The desktop app's own turn and chapter tools. */
const BOOKKEEPING_PREFIX = /^mcp__ccd_(turn|session)__/;
const WAIT_TOOLS = new Set(['TaskOutput', 'Monitor']);
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead']);
const SHELLS = new Set(['Bash', 'PowerShell']);
/** One sleep: sleep 30, timeout /t 30, Start-Sleep -Seconds 30 (also with a trailing `; echo done`-style no-op). */
const SLEEP_PART = /^\s*(?:sleep\s+[\d.]+[smh]?|timeout(?:\.exe)?\s+\/t\s+\d+(?:\s+\/nobreak)?(?:\s*>\s*nul)?|start-sleep(?:\s+-(?:s|seconds|milliseconds|m)\s*)?\s*[\d.]+|true|:|echo\s+[^;&|]*)\s*$/i;

/** Only sleeps (and harmless echos) joined by ; && ||, with at least one sleep. */
function onlySleeps(command) {
  const parts = String(command ?? '').split(/;|&&|\|\|/).filter((p) => p.trim());
  return parts.length > 0 && parts.every((p) => SLEEP_PART.test(p)) && parts.some((p) => /sleep|timeout/i.test(p));
}

/**
 * The kind of one tool call, and for a read the key of what it read.
 * @param {{ name?: string, input?: Record<string, unknown> }} call
 * @returns {{ kind: 'bookkeeping'|'wait'|'read'|'work', key?: string }}
 */
function callKind(call) {
  const name = String(call?.name ?? '');
  const input = call?.input && typeof call.input === 'object' ? call.input : {};
  if (BOOKKEEPING.has(name) || BOOKKEEPING_PREFIX.test(name)) return { kind: 'bookkeeping' };
  if (WAIT_TOOLS.has(name)) return { kind: 'wait' };
  if (READ_TOOLS.has(name)) return { kind: 'read', key: `${name}:${JSON.stringify(input)}` };
  if (SHELLS.has(name)) {
    const command = String(input.command ?? '');
    if (onlySleeps(command)) return { kind: 'wait' };
    let readOnly = false;
    try {
      readOnly = require('../../turnTools.js').readOnlyBash(command);
    } catch {
      // error-ignored: an unreadable command counts as work
    }
    if (readOnly) return { kind: 'read', key: `${name}:${command.trim()}` };
  }
  return { kind: 'work' };
}

module.exports = { callKind, onlySleeps };
