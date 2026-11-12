// =============================================================
// agentGuard.test.ts: every non-empty agent_type gets the agent guards, with an exception list (owner decision B3,
// review 2026-11-11 S7; lib/agentGuard.js).
//
// Locks: (1) an agent type outside the queue's own (general-purpose, Explore, a user's own subagent) gets the push,
// network, queue CLI and write guards; (2) agentGuard.except and agentGuard.enabled: false take such a type out, never
// the queue's own types (the floor); (3) the main session (no agent_type) and a main session started with --agent (an
// agent_type but no agent_id) stay unguarded; (4) what a read-only helper the queue starts (the Explore agents of the
// plans skill) needs still runs: reading git, files and the queue's read-only views; (5) the hooks end to end read the
// setting from queue.config.json; (6) the setting has a registry row that weakens, and doctor names it.
// =============================================================
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const AG = require('../agentGuard.js');
const PG = require('../pushGuard.js');
const WG = require('../writeGuard.js');
const R = require('../settingsRegistry.js');
const SV = require('../settingsView.js');
const QC = require('../queueConfig.js');

const STD = { baseBranch: 'main', migrations: {}, deployCommands: [], knownPackage: () => true };
const QUEUE_TYPES = new Set(['reviewer', 'reviewer-security', 'ask', 'triage']);
const decision = (command: string, context: Record<string, unknown> = {}) =>
  PG.assess(command, { ...STD, guardedTypes: QUEUE_TYPES, ...context })?.decision ?? null;
const FOLDER = path.resolve(os.tmpdir(), 'ravenseat-agentguard-wg', 'q');
const write = (agentType: string | null, file: string, extra: Record<string, unknown> = {}) =>
  WG.assessWrite({ agentType, filePath: path.join(FOLDER, file), folder: FOLDER, guardedTypes: QUEUE_TYPES, ...extra });

/** Agent types that are not the queue's own: builtins and a user's own subagents, with and without a plugin prefix. */
const OTHERS = ['general-purpose', 'Explore', 'Plan', 'my-helper', 'someplugin:code-writer'];

describe('B3: every non-empty agent_type is guarded', () => {
  it('an agent type outside the queue\'s own gets the push, network and queue CLI guards', () => {
    for (const agentType of OTHERS) {
      expect(decision('git push origin HEAD:main', { agentType }), agentType).toBe('deny');
      expect(decision('curl https://example.invalid/x', { agentType }), agentType).toBe('deny');
      expect(decision('npm install', { agentType }), agentType).toBe('deny');
      expect(decision('ravenseat merge R', { agentType }), agentType).toBe('deny');
      expect(PG.isGuardedAgent(agentType, QUEUE_TYPES), agentType).toBe(true);
    }
  });

  it('the write guard applies to them too', () => {
    for (const agentType of OTHERS) {
      expect(write(agentType, 'queue.json'), agentType).not.toBeNull();
      expect(write(agentType, 'gate-evidence.json'), agentType).not.toBeNull();
      expect(write(agentType, 'notes.md'), agentType).toBeNull();
    }
  });

  it('the main session stays unguarded: no agent_type, or --agent without an agent_id', () => {
    expect(decision('curl https://example.invalid/x', { agentType: null })).toBeNull();
    expect(decision('curl https://example.invalid/x', { agentType: '' })).toBeNull();
    expect(decision('git push origin main', { agentType: null, branch: 'main' })).toBeNull();
    const mainWithAgent = { agentType: 'my-orchestrator', agentGuard: { subagent: false } };
    expect(decision('curl https://example.invalid/x', mainWithAgent)).toBeNull();
    expect(PG.isGuardedAgent('my-orchestrator', QUEUE_TYPES, { subagent: false })).toBe(false);
    expect(write('my-orchestrator', 'queue.json', { agentGuard: { subagent: false } })).toBeNull();
    // A queue type stays guarded even without an agent_id (as before B3).
    expect(PG.isGuardedAgent('track', QUEUE_TYPES, { subagent: false })).toBe(true);
  });
});

describe('B3: the exception list and the off switch', () => {
  it('except takes a type out, without case and with or without a plugin prefix', () => {
    const agentGuard = { except: ['General-Purpose', 'someplugin:code-writer', 'my-helper'] };
    expect(decision('curl https://example.invalid/x', { agentType: 'general-purpose', agentGuard })).toBeNull();
    expect(decision('curl https://example.invalid/x', { agentType: 'someplugin:code-writer', agentGuard })).toBeNull();
    expect(decision('curl https://example.invalid/x', { agentType: 'ravenseat:my-helper', agentGuard })).toBeNull();
    expect(decision('curl https://example.invalid/x', { agentType: 'Explore', agentGuard })).toBe('deny');
    expect(write('general-purpose', 'queue.json', { agentGuard })).toBeNull();
  });

  it('enabled: false guards only the queue\'s own types, as before B3', () => {
    const agentGuard = { enabled: false };
    for (const agentType of OTHERS) expect(decision('curl https://example.invalid/x', { agentType, agentGuard }), agentType).toBeNull();
    expect(write('general-purpose', 'queue.json', { agentGuard })).toBeNull();
  });

  it('neither can take out the queue\'s own types (the floor)', () => {
    const off = { enabled: false, except: ['track', 'track-d', 'reviewer', 'ravenseat:ask', 'triage'] };
    for (const agentType of ['track', 'ravenseat:track', 'track-d', 'reviewer', 'ravenseat:ask', 'triage']) {
      expect(decision('git push origin HEAD:main', { agentType, agentGuard: off }), agentType).toBe('deny');
      expect(decision('curl https://example.invalid/x', { agentType, agentGuard: { except: off.except } }), agentType).toBe('deny');
      expect(write(agentType, 'queue.json', { agentGuard: off }), agentType).not.toBeNull();
    }
  });

  it('policyOf reads a malformed setting as the default (guarded), never as off', () => {
    expect(AG.policyOf({})).toEqual({ enabled: true, except: [] });
    expect(AG.policyOf({ agentGuard: { enabled: 'no', except: 'general-purpose' } })).toEqual({ enabled: true, except: [] });
    expect(AG.policyOf({ agentGuard: { except: ['x', 3, ' ', ' Y '] } })).toEqual({ enabled: true, except: ['x', 'y'] });
    expect(AG.policyOf({ agentGuard: { enabled: false } }).enabled).toBe(false);
  });
});

describe('B3: what the read-only helpers the queue starts still need', () => {
  // The plans skill starts read-only Explore agents to check a plan against the code (skills/plans/SKILL.md, step 2).
  const READ_ONLY = [
    'git log --oneline -20',
    'git status --short',
    'git diff main...HEAD --stat',
    'git show HEAD:README.md',
    'git grep -n "agentGuard" -- lib',
    'git ls-files lib',
    'git branch --list "queue/*"',
    'grep -rn "isGuarded" lib',
    'rg -n "TODO" docs',
    'ls -la lib',
    'cat package.json',
    'head -n 40 docs/queue.md',
    'find . -name "*.md" -not -path "./node_modules/*"',
    'wc -l lib/pushGuard.js',
    'node --version',
    'ravenseat info A-1',
    'ravenseat show',
    'ravenseat plan show PL-1',
    'ravenseat plan get PL-1',
    'ravenseat blockers',
    'ravenseat help',
  ];
  it.each(READ_ONLY)('Explore may run: %s', (command) => {
    expect(PG.assess(command, { ...STD, guardedTypes: QUEUE_TYPES, agentType: 'Explore', branch: 'main' })).toBeNull();
  });
  it('and may write its own notes, but not the queue\'s state files', () => {
    expect(write('Explore', path.join('..', 'scratch', 'notes.md'))).toBeNull();
    expect(write('Explore', 'base-health.json')).not.toBeNull();
  });
  it('a queue command that changes the queue is denied with the reason that names what is allowed', () => {
    const r = PG.assess('ravenseat status A-1 done', { ...STD, guardedTypes: QUEUE_TYPES, agentType: 'Explore' });
    expect(r?.decision).toBe('deny');
    expect(r?.reason).toMatch(/Allowed: prepare-track, gates, show, info/);
  });
});

describe('B3: the hooks end to end read the setting', () => {
  const PUSH_HOOK = path.resolve(__dirname, '..', '..', 'hook-push-guard.mjs');
  const WRITE_HOOK = path.resolve(__dirname, '..', '..', 'hook-write-guard.mjs');
  const project = (config: Record<string, unknown> | null) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ravenseat-b3-'));
    const folder = path.join(root, 'q');
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, 'queue.json'), JSON.stringify({ tasks: [] }));
    const file = path.join(root, config ? 'queue.config.json' : 'no-config.json');
    if (config) fs.writeFileSync(file, JSON.stringify(config));
    const env: NodeJS.ProcessEnv = { ...process.env, QUEUE_ROOT: root, QUEUE_FOLDER: folder, QUEUE_CONFIG: file };
    const run = (hook: string, payload: Record<string, unknown>) => {
      const r = spawnSync(process.execPath, [hook], { input: JSON.stringify({ cwd: root, ...payload }), encoding: 'utf8', env });
      return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.permissionDecision : null;
    };
    const bash = (command: string, who: Record<string, unknown> = {}) => run(PUSH_HOOK, { tool_input: { command }, ...who });
    const edit = (who: Record<string, unknown>) =>
      run(WRITE_HOOK, { tool_name: 'Write', tool_input: { file_path: path.join(folder, 'queue.json'), content: '{}' }, ...who });
    return { root, bash, edit, done: () => fs.rmSync(root, { recursive: true, force: true }) };
  };

  it('by default a general-purpose subagent is denied push, network and the state files; the main session is not', () => {
    const p = project(null);
    try {
      const sub = { agent_type: 'general-purpose', agent_id: 'a1' };
      expect(p.bash('git push origin HEAD:main', sub)).toBe('deny');
      expect(p.bash('curl https://example.invalid/x', sub)).toBe('deny');
      expect(p.edit(sub)).toBe('deny');
      expect(p.bash('curl https://example.invalid/x')).toBeNull();
      expect(p.edit({})).toBeNull();
      // A main session started with --agent: an agent_type, no agent_id.
      expect(p.bash('curl https://example.invalid/x', { agent_type: 'general-purpose' })).toBeNull();
      expect(p.edit({ agent_type: 'general-purpose' })).toBeNull();
    } finally {
      p.done();
    }
  }, 60_000);

  it('agentGuard.except and agentGuard.enabled: false in queue.config.json let such a type through; a track stays guarded', () => {
    for (const agentGuard of [{ except: ['general-purpose'] }, { enabled: false }]) {
      const p = project({ agentGuard });
      try {
        const sub = { agent_type: 'general-purpose', agent_id: 'a1' };
        expect(p.bash('curl https://example.invalid/x', sub), JSON.stringify(agentGuard)).toBeNull();
        expect(p.edit(sub), JSON.stringify(agentGuard)).toBeNull();
        const track = { agent_type: 'ravenseat:track', agent_id: 'a2' };
        expect(p.bash('curl https://example.invalid/x', track)).toBe('deny');
        expect(p.edit(track)).toBe('deny');
      } finally {
        p.done();
      }
    }
  }, 60_000);
});

describe('B3: the setting', () => {
  it('STANDARD holds the defaults', () => {
    expect(QC.STANDARD.agentGuard).toEqual({ enabled: true, except: [] });
  });
  it('registry rows in Agent guards, advanced, both modes, weakening when off or with an exception', () => {
    const enabled = R.rowFor('agentGuard.enabled');
    const except = R.rowFor('agentGuard.except');
    for (const r of [enabled, except]) {
      expect(r, 'row').toBeTruthy();
      expect(r.category).toBe('guards');
      expect(r.level).toBe('advanced');
      expect(r.modes).toEqual(['lite', 'full']);
      expect(r.protects && r.whyNot && r.changes).toBeTruthy();
    }
    expect(enabled.weakens(false, true)).toBe(true);
    expect(enabled.weakens(true, true)).toBe(false);
    expect(except.weakens(['general-purpose'], [])).toBe(true);
    expect(except.weakens([], [])).toBe(false);
  });
  it('doctor: WARN AGENT GUARD OFF when off, INFO per exception, no line by default', () => {
    const rows = (agentGuard: unknown) =>
      SV.doctorRows({ config: { ...QC.STANDARD, agentGuard } }).filter((r: { message: string }) => /agentGuard|AGENT GUARD/.test(r.message));
    expect(rows({ enabled: true, except: [] })).toEqual([]);
    const off = rows({ enabled: false, except: [] });
    expect(off.map((r: { status: string }) => r.status)).toEqual(['WARN']);
    expect(off[0].message).toMatch(/AGENT GUARD OFF/);
    const two = rows({ enabled: true, except: ['general-purpose', 'my-helper'] });
    expect(two.map((r: { status: string }) => r.status)).toEqual(['INFO', 'INFO']);
    expect(two.map((r: { message: string }) => r.message).join('\n')).toMatch(/general-purpose[\s\S]*my-helper/);
  });
});
