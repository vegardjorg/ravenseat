// =============================================================
// clientNameGate.test.ts: the core never asks for the client name (plans: client adapters, "Strukturkrav").
//
// Outside lib/clients/ (the adapters and the registry) and the tests, no script under plugin/scripts/orchestrator
// may compare with a client id or switch on one: no `=== 'claude'`, `'codex' !==`, `case 'antigravity':`. The core
// uses an adapter's capabilities and interface instead (lib/clients/index.js clientFor). The word claude itself is
// fine (paths like .claude/worktrees, the Claude Code docs); only comparisons against a client id fail here.
// =============================================================
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ORCH = path.resolve(__dirname, '..', '..');
const CLIENT_IDS = ['claude', 'codex', 'antigravity'];
const ID = `(?:${CLIENT_IDS.join('|')})`;
const Q = '[\'"`]';
/** A comparison with a client id on either side, or a switch case on one (any case, any quote). */
const NAME_CHECK = new RegExp(
  `(?:[!=]==?\\s*${Q}${ID}${Q})|(?:${Q}${ID}${Q}\\s*[!=]==?)|(?:\\bcase\\s+${Q}${ID}${Q})`,
  'i',
);

/** The .js and .mjs files under the orchestrator, without lib/clients/, __tests__ and node_modules. */
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

describe('client name gate', () => {
  it('the pattern catches comparisons and cases, not paths or prose', () => {
    for (const bad of [
      "if (client === 'claude')",
      'x.client !== "codex"',
      "'antigravity' == id",
      'case `codex`:',
      "if (c=='Claude')",
    ])
      expect(bad).toMatch(NAME_CHECK);
    for (const ok of [
      "path.join('.claude', 'worktrees')",
      '// the Claude Code adapter',
      "const dir = '.claude/worktrees/queue-' + id",
      "clientFor(o.client).id === adapter.id",
    ])
      expect(ok).not.toMatch(NAME_CHECK);
  });

  it('no core script compares with a client id', () => {
    const files = coreFiles(ORCH);
    expect(files.length).toBeGreaterThan(20);
    expect(files.some((f) => f.includes(`${path.sep}clients${path.sep}`))).toBe(false);
    const hits: string[] = [];
    for (const f of files)
      fs.readFileSync(f, 'utf8')
        .split(/\r?\n/)
        .forEach((line, i) => {
          if (NAME_CHECK.test(line)) hits.push(`${path.relative(ORCH, f)}:${i + 1}: ${line.trim()}`);
        });
    expect(hits, `ask the adapter (lib/clients/) instead of the client name:\n${hits.join('\n')}`).toEqual([]);
  });
});
