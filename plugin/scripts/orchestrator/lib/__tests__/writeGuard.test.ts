// =============================================================
// writeGuard.test.ts: the write guard for the queue's trusted state files (lib/writeGuard.js, hook-write-guard.mjs).
//
// Locks: (1) a queue agent's Write, Edit or NotebookEdit on the gate evidence store (anywhere, also its temporary file),
// on the data folder's queue.json or base-health.json is denied; (2) the orchestrator (no agent_type), agent types the
// agent guard leaves out (agentGuard, owner decision B3) and other files are let through; (3) the hook end to end denies a track's Write on the store and says nothing
// for the orchestrator; (4) outside a queue project (no queue.config.json, no QUEUE_* variable) the hook is inert.
// =============================================================
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/* eslint-disable @typescript-eslint/no-require-imports */
const WG = require('../writeGuard.js') as {
  targetPath: (toolInput: object) => string | null;
  assessWrite: (x: { agentType: string | null; filePath: string; folder: string; guardedTypes?: Set<string>; agentGuard?: object }) => { reason: string } | null;
};

const HOOK = path.resolve(__dirname, '..', '..', 'hook-write-guard.mjs');
const FOLDER = path.resolve(os.tmpdir(), 'ravenseat-wg', 'q');
const types = new Set(['reviewer', 'triage']);

describe('writeGuard (pure)', () => {
  it('finds the target of Write, Edit and NotebookEdit', () => {
    expect(WG.targetPath({ file_path: 'a.txt' })).toBe('a.txt');
    expect(WG.targetPath({ notebook_path: 'n.ipynb' })).toBe('n.ipynb');
    expect(WG.targetPath({})).toBeNull();
  });

  it('denies a queue agent the trusted state files, never the orchestrator', () => {
    const at = (f: string) => path.join(FOLDER, f);
    for (const agentType of ['track', 'ravenseat:track', 'track-d', 'ravenseat:reviewer']) {
      expect(WG.assessWrite({ agentType, filePath: at('gate-evidence.json'), folder: FOLDER, guardedTypes: types })?.reason).toMatch(/gate evidence/);
      expect(WG.assessWrite({ agentType, filePath: at('queue.json'), folder: FOLDER, guardedTypes: types })).not.toBeNull();
      expect(WG.assessWrite({ agentType, filePath: at('base-health.json'), folder: FOLDER, guardedTypes: types })).not.toBeNull();
      // The owner log (owner decision B2) and its temporary file.
      expect(WG.assessWrite({ agentType, filePath: at('owner-log.json'), folder: FOLDER, guardedTypes: types })?.reason).toMatch(/owner log/);
      expect(WG.assessWrite({ agentType, filePath: at('owner-log.json.42.tmp'), folder: FOLDER, guardedTypes: types })).not.toBeNull();
    }
    // The store's temporary file, and a store outside the data folder (no track needs one anywhere).
    expect(WG.assessWrite({ agentType: 'track', filePath: at('gate-evidence.json.123.tmp'), folder: FOLDER, guardedTypes: types })).not.toBeNull();
    expect(WG.assessWrite({ agentType: 'track', filePath: path.join(os.tmpdir(), 'x', 'gate-evidence.json'), folder: FOLDER, guardedTypes: types })).not.toBeNull();
    // Let through: the orchestrator, an unguarded agent type, another file, a queue.json outside the data folder.
    expect(WG.assessWrite({ agentType: null, filePath: at('gate-evidence.json'), folder: FOLDER, guardedTypes: types })).toBeNull();
    expect(WG.assessWrite({ agentType: 'general-purpose', filePath: at('queue.json'), folder: FOLDER, guardedTypes: types, agentGuard: { except: ['general-purpose'] } })).toBeNull();
    // Another agent type is guarded by default (owner decision B3, lib/agentGuard.js).
    expect(WG.assessWrite({ agentType: 'general-purpose', filePath: at('queue.json'), folder: FOLDER, guardedTypes: types })).not.toBeNull();
    expect(WG.assessWrite({ agentType: 'track', filePath: at('A-1/track-result.md'), folder: FOLDER, guardedTypes: types })).toBeNull();
    expect(WG.assessWrite({ agentType: 'track', filePath: path.join(os.tmpdir(), 'app', 'queue.json'), folder: FOLDER, guardedTypes: types })).toBeNull();
  });
});

describe('hook-write-guard.mjs', () => {
  const run = (env: NodeJS.ProcessEnv, payload: object, cwd?: string) => {
    const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(payload), encoding: 'utf8', env, cwd });
    return { status: r.status, out: r.stdout, decision: r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.permissionDecision : null };
  };

  it("denies a track's Write on the gate evidence store and lets the orchestrator through", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ravenseat-writeguard-'));
    try {
      const folder = path.join(root, 'q');
      fs.mkdirSync(folder);
      fs.writeFileSync(path.join(folder, 'queue.json'), JSON.stringify({ tasks: [] }));
      const env: NodeJS.ProcessEnv = { ...process.env, QUEUE_ROOT: root, QUEUE_FOLDER: folder, QUEUE_CONFIG: path.join(root, 'no-config.json') };
      const store = path.join(folder, 'gate-evidence.json');
      const write = run(env, { agent_type: 'ravenseat:track', tool_name: 'Write', tool_input: { file_path: store, content: '{}' }, cwd: root });
      expect(write.decision).toBe('deny');
      expect(JSON.parse(write.out).hookSpecificOutput.permissionDecisionReason).toContain('gate evidence');
      const editQueue = run(env, { agent_type: 'track', tool_name: 'Edit', tool_input: { file_path: path.join(folder, 'queue.json') }, cwd: root });
      expect(editQueue.decision).toBe('deny');
      expect(run(env, { tool_name: 'Write', tool_input: { file_path: store }, cwd: root }).decision).toBeNull();
      expect(run(env, { agent_type: 'track', tool_name: 'Write', tool_input: { file_path: path.join(root, 'src', 'a.ts') }, cwd: root }).decision).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('is inert outside a queue project', () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'ravenseat-writeguard-off-'));
    try {
      const env = { ...process.env };
      for (const k of Object.keys(env)) if (k.startsWith('QUEUE_')) delete env[k];
      delete env.CLAUDE_PROJECT_DIR;
      const r = run(env, { agent_type: 'track', tool_name: 'Write', tool_input: { file_path: path.join(project, 'gate-evidence.json') } }, project);
      expect(r.status).toBe(0);
      expect(r.out).toBe('');
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });
});
