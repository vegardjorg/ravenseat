// =============================================================
// clientCouplingGate.test.ts: no NEW file outside lib/clients/ starts reading Claude Code's transcript or hook formats
// directly (plans: client adapters, roadmap 0w W1).
//
// The formats are client facts (lib/clients/claude/facts.js): the transcript JSONL fields (message.usage, the cache
// fields, compact_boundary, tool_use ids), the transcript paths (~/.claude/projects/<slug>/<session>/subagents/
// agent-<id>.jsonl) and the hook and status line payload fields (tool_input, last_assistant_message, hookSpecificOutput,
// context_window ...). Today about 40 files read them directly; W2 moves the reading into the adapter. Until then this
// gate holds the line:
//   - a file outside lib/clients/ that matches COUPLING and is not on ALLOWED fails (ask the adapter instead);
//   - a file on ALLOWED that no longer matches fails too, so the list only shrinks (remove the entry when W2 moves it).
// Comment lines do not count (prose may name the fields). Agent ids, agent types and session ids are left out on
// purpose: the queue's own time log rows carry the same names, so they would mostly hit the queue's own format.
// =============================================================
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ORCH = path.resolve(__dirname, '..', '..');

/** The direct reads of a Claude Code format, one pattern per kind (the facts file names the same fields). */
const COUPLING: Record<string, RegExp> = {
  'transcript field': new RegExp(
    [
      String.raw`message\??\.usage\b`,
      String.raw`\b(?:input_tokens|cache_read_input_tokens|cache_creation_input_tokens|ephemeral_(?:5m|1h)_input_tokens)\b`,
      String.raw`\b(?:isSidechain|isApiErrorMessage|apiErrorStatus|compact_boundary|tool_use_id|toolUseResult)\b`,
      String.raw`type\s*[!=]==?\s*['"](?:tool_use|tool_result|assistant)['"]`,
    ].join('|'),
  ),
  'transcript path': new RegExp(
    [
      String.raw`['"]subagents['"]`,
      String.raw`agent-\$\{`,
      String.raw`\^agent-`,
      String.raw`['"]\.claude['"]\s*,\s*['"]projects['"]`,
      String.raw`\b(?:agent_)?transcript_path\b`,
    ].join('|'),
  ),
  'hook field': new RegExp(
    [
      String.raw`\b(?:hook_event_name|tool_input|tool_response|stop_hook_active|last_assistant_message|notification_type|custom_instructions)\b`,
      String.raw`\b(?:hookSpecificOutput|hookEventName|permissionDecision)\b`,
      String.raw`\b(?:context_window|rate_limits)\b`,
    ].join('|'),
  ),
};

/**
 * The files that read a Claude Code format directly today (2026-11-16, W1). W2 moves them behind lib/clients/claude
 * and removes each entry here in the same commit; the bolk in the comment is the plan, not a rule.
 */
const ALLOWED: string[] = [
  // W2a: transcript paths and file finding (projects/<slug>/<session>/subagents/agent-<id>.jsonl)
  'cli/ask.mjs',
  'cli/cost.mjs',
  'cli/events.mjs',
  'cli/tracks.mjs',
  'hook-context.mjs',
  'lib/eventStatistics.js',
  'lib/fixRound.js',
  'lib/trackActivity.js',
  // W2b: transcript entries and usage (message.usage, content blocks, compact_boundary, API errors)
  'lib/approvalWait.js',
  'lib/askBundle.js',
  'lib/contextGuard.js',
  'lib/logic/results.js',
  'lib/timeCost.js',
  'lib/trackGuard.js',
  'lib/turnTools.js',
  'lib/usageLimit.js',
  // W2c: hook and status line payloads (stdin fields and hookSpecificOutput)
  'hook-after-compact.mjs',
  'hook-approval-wait.mjs',
  'hook-push-guard.mjs',
  'hook-read-guard.mjs',
  'hook-time.mjs',
  'hook-track-context.mjs',
  'hook-track-end.mjs',
  'hook-usage-limit.mjs',
  'hook-write-guard.mjs',
  'lib/eventRows.js',
  'lib/rateLimits.js',
  'lib/toolTrouble.js',
  'statusline.mjs',
];

/** Is a line a comment (//, /*, * continuation)? Comments may name the fields. */
const isComment = (line: string) => /^\s*(?:\/\/|\/\*|\*)/.test(line);

/** The kinds a line matches (empty for a comment or a line without a format read). */
function kindsOf(line: string): string[] {
  if (isComment(line)) return [];
  return Object.entries(COUPLING)
    .filter(([, re]) => re.test(line))
    .map(([k]) => k);
}

/** The .js and .mjs files under the orchestrator, without lib/clients/, __tests__ and node_modules (as clientNameGate). */
function coreFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === '__tests__' || e.name === 'node_modules') continue;
      if (path.relative(ORCH, p).split(path.sep).join('/') === 'lib/clients') continue;
      out.push(...coreFiles(p));
    } else if (/\.(?:js|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

/** file (relative, with /) -> the first hit "line: kind" per file. */
function hitsByFile(): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of coreFiles(ORCH)) {
    const rel = path.relative(ORCH, f).split(path.sep).join('/');
    const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const k = kindsOf(lines[i]);
      if (k.length) {
        out.set(rel, `${rel}:${i + 1}: ${k.join(', ')}`);
        break;
      }
    }
  }
  return out;
}

describe('client coupling gate', () => {
  it('the patterns catch direct format reads, not prose, own rows or the status line total', () => {
    for (const bad of [
      'const u = o?.message?.usage;',
      'tokens.cache_read += u.cache_read_input_tokens ?? 0;',
      "if (c?.type === 'tool_use' && c.id) open.set(c.id, c.name);",
      "path.join(dir, d.name, 'subagents', `agent-${id}.jsonl`)",
      "path.join(os.homedir(), '.claude', 'projects', slug)",
      'const tail = readTail(input.transcript_path);',
      'const command = p?.tool_input?.command;',
      'if (input.stop_hook_active) return;',
      "JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse' } })",
      'const cw = input?.context_window;',
    ])
      expect(kindsOf(bad), bad).not.toEqual([]);
    for (const ok of [
      '// reads message.usage from the transcript',
      ' * the hook payload has tool_input and hookSpecificOutput',
      "path.join('.claude', 'worktrees', id)",
      'if (r.agent_type) types.set(r.agent_id, r.agent_type);',
      'const total = cw?.total_input_tokens;',
      "const subagent = 'track';",
    ])
      expect(kindsOf(ok), ok).toEqual([]);
  });

  it('no file outside lib/clients/ reads a Claude Code format unless it is on the allowlist', () => {
    const hits = hitsByFile();
    expect(hits.size).toBeGreaterThan(10); // the scan sees the files at all
    const fresh = [...hits.keys()].filter((f) => !ALLOWED.includes(f)).map((f) => hits.get(f));
    expect(
      fresh,
      `read the format through the adapter (lib/clients/claude, facts.js) instead of directly:\n${fresh.join('\n')}`,
    ).toEqual([]);
  });

  it('the allowlist only shrinks: every entry still reads a format (remove it when W2 moves it)', () => {
    const hits = hitsByFile();
    const stale = ALLOWED.filter((f) => !hits.has(f));
    expect(stale, `no longer reads a Claude Code format, remove from ALLOWED:\n${stale.join('\n')}`).toEqual([]);
    expect(new Set(ALLOWED).size).toBe(ALLOWED.length);
  });

  it('the client facts are dated and sourced, and name every allowlisted reader', () => {
    const { FACTS, SOURCES } = require(path.join(ORCH, 'lib', 'clients', 'claude', 'facts.js'));
    const ids = new Set<string>();
    for (const f of FACTS) {
      expect(ids.has(f.id), `duplicate fact ${f.id}`).toBe(false);
      ids.add(f.id);
      expect(f.confirmed, f.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Object.keys(SOURCES), f.id).toContain(f.source);
      expect(['H', 'M', 'L'], f.id).toContain(f.fragility);
      expect(['W2', 'W3', 'W4'], f.id).toContain(f.move);
      expect(String(f.value).length, f.id).toBeGreaterThan(0);
      for (const r of f.readers) expect(fs.existsSync(path.join(ORCH, r)), `${f.id}: ${r} does not exist`).toBe(true);
    }
    // The facts are the map: a file the gate allows must say which fact it reads.
    const readers = new Set(FACTS.flatMap((f: { readers: string[] }) => f.readers));
    const unmapped = ALLOWED.filter((f) => !readers.has(f));
    expect(unmapped, `allowlisted but in no fact's readers (lib/clients/claude/facts.js):\n${unmapped.join('\n')}`).toEqual([]);
    // No personal paths in the facts (the observed source is field names only).
    expect(JSON.stringify(FACTS)).not.toMatch(/[A-Za-z]:\\\\|\/Users\/|\/home\//);
  });
});
