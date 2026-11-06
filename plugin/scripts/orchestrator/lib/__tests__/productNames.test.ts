// =============================================================
// productNames.test.ts: every name the product has or had reaches every guard, tried against the real guards.
//
// Locks: (1) no file in plugin/bin/ and no plugin.json name is unknown to productNames.js, so a new name cannot leave a
// guard behind; (2) each guard treats every CLI and plugin name the same. The names are listed by hand here on purpose:
// a search-and-replace over the code must not be able to drop an old name unnoticed.
// =============================================================
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const N = require('../productNames.js');
const SC = require('../shellCommands.js');
const GE = require('../gateEvidence.js');
const CG = require('../contextGuard.js');
const PF = require('../projectFiles.js');
const { bareAgentType } = require('../projectRoot.js');

const ORCH = path.resolve(__dirname, '..', '..');
const PLUGIN = path.resolve(ORCH, '..', '..');
const HOOK_PUSH = path.join(ORCH, 'hook-push-guard.mjs');
const HOOK_CONTEXT = path.join(ORCH, 'hook-track-context.mjs');

// Spelled out: the point of the matrix. Not built from N.CLI_NAMES.
const ALL_NAMES = ['ravenseat', 'c' + 'q'];

const temporary: string[] = [];
afterAll(() => {
  for (const m of temporary) fs.rmSync(m, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
});

function folder() {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'queue-names-')));
  temporary.push(repo);
  return repo;
}

function project() {
  const repo = folder();
  fs.writeFileSync(path.join(repo, 'queue.config.json'), JSON.stringify({ baseBranch: 'main' }));
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(repo) } as NodeJS.ProcessEnv;
  for (const k of ['QUEUE_ROOT', 'QUEUE_GIT', 'QUEUE_CONFIG', 'CLAUDE_PROJECT_DIR']) delete env[k];
  execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'main'], { env, stdio: 'ignore' });
  const run = (hook: string, input: object) =>
    spawnSync(process.execPath, [hook], { input: JSON.stringify({ cwd: repo, ...input }), encoding: 'utf8', env, cwd: repo });
  return { repo, run };
}

describe('the list of names', () => {
  it('holds every name, whatever the current one is', () => {
    expect(N.CLI_NAMES).toEqual(expect.arrayContaining(ALL_NAMES));
    expect(N.PLUGIN_NAMES).toEqual(expect.arrayContaining(ALL_NAMES));
    expect(N.CLI_NAMES).toContain(N.CLI_NAME);
    expect(N.PLUGIN_NAMES).toContain(N.PLUGIN_NAME);
  });
  it('knows every command in plugin/bin/ and the name in plugin.json', () => {
    for (const f of fs.readdirSync(path.join(PLUGIN, 'bin'))) expect(N.CLI_NAMES).toContain(f.replace(/\.cmd$/, ''));
    const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8'));
    expect(manifest.name).toBe(N.PLUGIN_NAME);
  });
});

describe.each(ALL_NAMES)('the CLI name %s', (name) => {
  it('is a queue call in every written form', () => {
    for (const line of [
      `${name} merge X-1`,
      `${name}.cmd merge X-1`,
      `/some/bin/${name} merge X-1`,
      `node scripts/orchestrator/${name}.mjs merge X-1`,
      `${name} queue merge X-1`,
    ]) {
      expect(SC.queueCall(SC.tokens(line), 0), line).toMatchObject({ name: 'merge', args: ['X-1'] });
    }
    expect(SC.queueCall(SC.tokens(`${name} board`), 0)).toMatchObject({ name: 'queue-board' });
  });

  it('the real push guard refuses the orchestrator commands for an agent', () => {
    const p = project();
    const decision = (agent_type: string, command: string) => {
      const r = p.run(HOOK_PUSH, { tool_name: 'Bash', tool_input: { command }, agent_type });
      return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.permissionDecision : null;
    };
    for (const agent of ['track', 'cq:track', 'ravenseat:track', 'reviewer', 'ravenseat:reviewer']) {
      expect(decision(agent, `${name} merge X-1`), agent).toBe('deny');
      expect(decision(agent, `${name}.cmd merge X-1`), agent).toBe('deny');
      expect(decision(agent, `node "${p.repo}/${name}.mjs" merge X-1`), agent).toBe('deny');
    }
    // The main session has no agent type and is not touched.
    const main = p.run(HOOK_PUSH, { tool_name: 'Bash', tool_input: { command: `${name} merge X-1` } });
    expect(main.stdout).toBe('');
  });

  it('the gate evidence guard refuses --evidence and --cwd', () => {
    expect(GE.tamperReason(`${name} gates --quick --evidence x`)).toMatch(/without --evidence/);
    expect(GE.tamperReason(`${name}.cmd gates --cwd ..`)).toMatch(/without --evidence/);
    expect(GE.tamperReason(`node "C:/p/${name}.mjs" gates --full --cwd ..`)).toMatch(/without --evidence/);
    expect(GE.tamperReason(`${name} gates --quick`)).toBeNull();
  });

  it('an orchestrator call in the transcript counts, and any other command does not', () => {
    const at = '2026-11-06T10:00:00.000Z';
    const line = (command: string) =>
      JSON.stringify({ type: 'assistant', timestamp: at, message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command } }] } });
    expect(CG.lastOrchestratorCall(line(`${name} fill --scratchpad x`))).toBe(Date.parse(at));
    expect(CG.lastOrchestratorCall(line(`node x/${name}.mjs start A-1`))).toBe(Date.parse(at));
    expect(CG.lastOrchestratorCall(line(`${name} show`))).toBeNull();
  });
});

describe.each(ALL_NAMES)('the plugin name %s', (name) => {
  it('bareAgentType strips it, and leaves another prefix alone', () => {
    expect(bareAgentType(`${name}:track`)).toBe('track');
    expect(bareAgentType(`${name}:track-d`)).toBe('track-d');
    expect(bareAgentType('track')).toBe('track');
    expect(bareAgentType('other:track')).toBe('other:track');
  });

  it('a status line under that plugin folder is noticed when it is stale', () => {
    const repo = folder();
    fs.mkdirSync(path.join(repo, '.claude'));
    const command = `node "C:\\x\\cache\\ravenseat\\${name}\\0.0.1\\scripts\\orchestrator\\statusline.mjs"`;
    fs.writeFileSync(path.join(repo, '.claude', 'settings.local.json'), JSON.stringify({ statusLine: { command } }));
    expect(PF.staleStatusLines(PLUGIN, repo)).toEqual([{ file: '.claude/settings.local.json', version: '0.0.1' }]);
  });
});

describe('the context hook', () => {
  it('asks productNames for the track, and has no name of its own', () => {
    const source = fs.readFileSync(HOOK_CONTEXT, 'utf8');
    expect(source).toContain('bareAgentType(firstInput');
    expect(source).not.toMatch(/\(\?:cq:\)/);
  });
  it.each(['track', 'track-d', ...ALL_NAMES.map((n) => `${n}:track`), ...ALL_NAMES.map((n) => `${n}:track-d`)])(
    '%s passes the first check',
    (agent_type) => {
      const bare = bareAgentType(agent_type);
      expect(bare).toMatch(/^track(?:-d)?$/);
    },
  );
  it('exits silently for another agent, in a real run', () => {
    const p = project();
    const r = p.run(HOOK_CONTEXT, { agent_type: 'other:track', tool_name: 'Bash', tool_input: { command: 'x' } });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });
});
