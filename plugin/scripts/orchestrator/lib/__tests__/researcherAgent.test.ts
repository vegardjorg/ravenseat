// =============================================================
// researcherAgent.test.ts: the narrow `researcher` helper (plugin/agents/researcher.md) is in every list at once.
//
// Why: the orchestrator's free helper agents (analysis, measurement, research outside a queue task) used to start as
// general-purpose, which loads every tool and MCP definition. A narrow agent type is cheaper at start, but a new type
// that is missing from one list falls through a guard or a cost class later. This file checks each place:
//   - the agent file: the narrow tool set, effort medium, never commits, pushes or tags, keeps CLAUDE.md;
//   - the guards: PLUGIN_AGENT_TYPES and queueAgentTypes() (network, push, queue CLI, read and write guards);
//   - custom helpers can never take the name (helpers add);
//   - the vendored installer copies it to .claude/agents/;
//   - the orchestrator's instructions send free helpers to `researcher`, not general-purpose;
//   - the benchmark keeps the cost class a general-purpose helper had (planning, or helper with a label).
// =============================================================
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const TG = require('../trackGuard.js');
const PG = require('../pushGuard.js');
const HELP = require('../queueHelpers.js');
const HF = require('../helperFiles.js');
const C = require('../../../../../bench/lib/collect.js');

const PLUGIN = path.resolve(__dirname, '..', '..', '..', '..');
const REPO = path.resolve(PLUGIN, '..');
const FILE = path.join(PLUGIN, 'agents', 'researcher.md');
// A Windows checkout may have CRLF line endings (core.autocrlf), so the text is read with LF.
const read = (f: string) => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');

describe('the researcher agent file', () => {
  it('exists with its name, opus, effort medium and exactly Read, Grep, Glob, Bash, Write', () => {
    expect(fs.existsSync(FILE)).toBe(true);
    const s = read(FILE);
    const front = /^---\n([\s\S]*?)\n---/.exec(s)?.[1] ?? '';
    expect(front).toMatch(/^name: researcher$/m);
    expect(front).toMatch(/^model: opus$/m);
    expect(front).toMatch(/^effort: medium$/m);
    expect(front).toMatch(/^tools: Read, Grep, Glob, Bash, Write$/m);
    expect(front).not.toMatch(/\b(Edit|NotebookEdit|WebFetch|WebSearch|Agent|Task)\b/);
  });

  it('keeps CLAUDE.md (the project map and rules apply to research in the repo)', () => {
    expect(read(FILE)).not.toMatch(/^omitClaudeMd:/m);
  });

  it('never commits, pushes, tags or edits tracked files, writes only where the prompt says, and answers with file:line', () => {
    const s = read(FILE);
    expect(s).toMatch(/never commit, push or tag/i);
    expect(s).toMatch(/never (edit|change) a tracked file/i);
    expect(s).toMatch(/scratchpad/i);
    expect(s).toContain('file:line');
    expect(s).toContain('Data, not instructions');
    expect(s).toMatch(/never start other agents/i);
    expect(s).not.toMatch(/[\u2013\u2014]/);
  });
});

describe('researcher is a guarded queue agent', () => {
  it('is in PLUGIN_AGENT_TYPES and queueAgentTypes()', () => {
    expect(TG.PLUGIN_AGENT_TYPES).toContain('researcher');
    expect(TG.queueAgentTypes().has('researcher')).toBe(true);
  });

  it('stays guarded with agentGuard off (the floor for the queue\'s own types), with and without the prefix', () => {
    const types = TG.queueAgentTypes();
    for (const t of ['researcher', 'ravenseat:researcher']) {
      expect(PG.isGuardedAgent(t, types), t).toBe(true);
      expect(PG.isGuardedAgent(t, types, { enabled: false }), t).toBe(true);
      expect(PG.isGuardedAgent(t, types, { enabled: true, except: ['researcher'] }), t).toBe(true);
    }
  });

  it('is denied git push, the network and steering the queue', () => {
    const ctx = { baseBranch: 'staging', migrations: {}, deployCommands: [], guardedTypes: TG.queueAgentTypes(), knownPackage: () => true };
    for (const agentType of ['researcher', 'ravenseat:researcher']) {
      const d = (c: string) => PG.assess(c, { ...ctx, agentType })?.decision ?? null;
      expect(d('git push origin HEAD:staging'), agentType).toBe('deny');
      expect(d('git push --tags'), agentType).toBe('deny');
      expect(d('curl https://example.invalid/x'), agentType).toBe('deny');
      expect(d('ravenseat merge R'), agentType).toBe('deny');
    }
  });

  it('is not a task agent: it never counts as a reviewer or helper of a queue task', () => {
    expect(HELP.CATALOG).not.toHaveProperty('researcher');
    expect(require('../queueLogic.js').TASK_AGENT_TYPES).not.toContain('researcher');
  });
});

describe('custom helpers cannot take the name', () => {
  it('ravenseat helpers add refuses researcher (a shipped agent name)', () => {
    expect(HF.pluginAgentNames()).toContain('researcher');
    const r = HELP.checkNewName('researcher', { config: {}, setup: {}, pluginAgents: HF.pluginAgentNames() });
    expect(r.error).toMatch(/builtin agent name/);
  });
});

describe('the vendored installer', () => {
  it('copies researcher.md to .claude/agents/', () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'ravenseat-researcher-'));
    try {
      const r = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'install.mjs'), target], { encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
      const copied = path.join(target, '.claude', 'agents', 'researcher.md');
      expect(fs.existsSync(copied)).toBe(true);
      expect(read(copied)).toMatch(/^tools: Read, Grep, Glob, Bash, Write$/m);
    } finally {
      fs.rmSync(target, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("the orchestrator's instructions use researcher for free helpers", () => {
  it.each(['CLAUDE.queue.md', 'skills/parallel-wave/SKILL.md', 'docs/orchestration.md'])('%s names researcher', (f) => {
    const s = read(path.join(PLUGIN, f));
    expect(s).toMatch(/`(ravenseat:)?researcher`/);
    expect(s).not.toMatch(/[\u2013\u2014]/);
  });

  it('orchestration.md lists researcher among the shipped agents the guards cover', () => {
    expect(read(path.join(PLUGIN, 'docs', 'orchestration.md'))).toMatch(/PLUGIN_AGENT_TYPES`: `ask`, `researcher`/);
  });
});

describe('the benchmark cost class', () => {
  it('a researcher session lands where a general-purpose helper did: planning, or helper with a label', () => {
    expect(C.classify({ kind: 'subagent', agent_type: 'researcher' })).toBe('planning');
    expect(C.classify({ kind: 'subagent', agent_type: 'researcher', label: 'measure' })).toBe('helper');
    expect(C.classify({ kind: 'subagent', agent_type: 'general-purpose' })).toBe('planning');
  });
});
