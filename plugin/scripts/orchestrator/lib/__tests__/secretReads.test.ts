// =============================================================
// secretReads.test.ts: a guarded agent that prints secrets in a shell command is logged (allowed) or, by choice,
// blocked (lib/secretReads.js, lib/guardLog.js, hook-push-guard.mjs; roadmap 1c SEC-T item 4).
//
// Why: `cat .env` or `printenv` in a track puts every key into its transcript, which Claude Code keeps for weeks. The
// default only logs (block can stop work); the row names the rule, never the command or a path. Temporary folders only.
// =============================================================
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

/* eslint-disable @typescript-eslint/no-require-imports */
const SR = require('../secretReads');
const GL = require('../guardLog');

const HOOK = path.resolve(__dirname, '..', '..', 'hook-push-guard.mjs');
const temporary: string[] = [];
afterAll(() => {
  for (const d of temporary) fs.rmSync(d, { recursive: true, force: true });
});

describe('readRule: which commands print secrets', () => {
  it('a reader of a .env or key file, and an env dump with no arguments', () => {
    expect(SR.readRule('cat .env')).toBe('env-file-read');
    expect(SR.readRule('cat ../app/.env.local')).toBe('env-file-read');
    expect(SR.readRule('type C:\\work\\.env.production')).toBe('env-file-read');
    expect(SR.readRule('Get-Content -Path .env -TotalCount 5')).toBe('env-file-read');
    expect(SR.readRule('gc .env')).toBe('env-file-read');
    expect(SR.readRule('head -n 3 "certs/server.key"')).toBe('key-file-read');
    expect(SR.readRule('tail deploy.pem')).toBe('key-file-read');
    expect(SR.readRule('less .env')).toBe('env-file-read');
    expect(SR.readRule('printenv')).toBe('env-dump');
    expect(SR.readRule('env | sort')).toBe('env-dump');
    expect(SR.readRule('set')).toBe('env-dump');
    expect(SR.readRule('Get-ChildItem env:')).toBe('env-dump');
    expect(SR.readRule('npm test && cat .env')).toBe('env-file-read');
  });

  it('not a hit: the example files, one named variable, a script with a flag, other files and commands', () => {
    for (const cmd of [
      'cat .env.example',
      'cat .env.sample',
      'printenv PATH',
      'env NODE_ENV=test node x.js',
      'set -e',
      'Get-ChildItem env:PATH',
      'cat README.md',
      'grep -c KEY .env.example',
      'git status',
      'npm test',
    ])
      expect(SR.readRule(cmd), cmd).toBeNull();
  });

  it('the setting: log by default, block and off by choice; anything else reads as log', () => {
    expect(SR.modeOf({})).toBe('log');
    expect(SR.modeOf({ guards: { secretReads: 'block' } })).toBe('block');
    expect(SR.modeOf({ guards: { secretReads: 'off' } })).toBe('off');
    expect(SR.modeOf({ guards: { secretReads: 'nonsense' } })).toBe('log');
  });

  it('the block reason tells the agent to reference the variable instead', () => {
    expect(SR.blockReason('env-file-read')).toMatch(/guards\.secretReads/);
    expect(SR.blockReason('env-file-read')).toContain('psql "$DATABASE_URL"');
  });
});

describe('the guard log row and the counts for the Checks tab', () => {
  it('a logged read is a guard-log row with guard secrets and the rule only', () => {
    const r = GL.row({ guard: 'secrets', rule: 'env-file-read', decision: 'log', agentType: 'track', task: 'A-1' });
    expect(r).toMatchObject({ wave: 'guard', event: 'guard-log', guard: 'secrets', rule: 'env-file-read', track: 'A-1' });
  });

  it('counts per track in the window; deny and ask counts are not changed by it', () => {
    const now = Date.parse('2026-11-20T12:00:00Z');
    const at = (h: number) => new Date(now - h * 3_600_000).toISOString();
    const rows = [
      { time: at(1), wave: 'guard', event: 'guard-log', guard: 'secrets', rule: 'env-file-read', track: 'A-1' },
      { time: at(2), wave: 'guard', event: 'guard-log', guard: 'secrets', rule: 'env-dump', track: 'A-1' },
      { time: at(3), wave: 'guard', event: 'guard-deny', guard: 'secrets', rule: 'env-dump', track: 'B-2' },
      { time: at(300), wave: 'guard', event: 'guard-log', guard: 'secrets', rule: 'env-dump', track: 'C-3' },
      { time: at(4), wave: 'guard', event: 'guard-log', guard: 'secrets', rule: 'env-dump', track: null },
    ];
    const c = SR.counts(rows, { from: now - 7 * 86_400_000 });
    expect(c.total).toBe(4);
    expect(c.byTrack).toEqual([
      { track: 'A-1', count: 2, blocked: 0, rules: ['env-dump', 'env-file-read'] },
      { track: 'B-2', count: 1, blocked: 1, rules: ['env-dump'] },
      { track: 'no task', count: 1, blocked: 0, rules: ['env-dump'] },
    ]);
    expect(GL.counts(rows).total).toEqual({ deny: 1, ask: 0 });
  });
});

describe('hook-push-guard.mjs: the wiring (a temporary queue project)', () => {
  function project(config: object) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ravenseat-secretreads-'));
    temporary.push(root);
    const data = path.join(root, 'data');
    fs.mkdirSync(data);
    fs.writeFileSync(path.join(root, 'queue.config.json'), JSON.stringify(config));
    fs.writeFileSync(path.join(data, 'queue.json'), JSON.stringify({ tasks: [], projects: {} }));
    const log = path.join(data, 'times.jsonl');
    const env = { ...process.env, QUEUE_ROOT: root, QUEUE_CONFIG: path.join(root, 'queue.config.json'), QUEUE_FOLDER: data, QUEUE_TIME_LOG: log };
    const run = (command: string, agent_type: string | null = 'track') => {
      const payload = { tool_name: 'Bash', tool_input: { command }, cwd: root, ...(agent_type ? { agent_type, agent_id: 'agent-x1' } : {}) };
      const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(payload), encoding: 'utf8', env, cwd: root });
      const out = r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput : null;
      const rows = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
      return { decision: out?.permissionDecision ?? null, reason: out?.permissionDecisionReason ?? '', rows, logText: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '' };
    };
    return { run };
  }

  it('log (default): the read goes on, one guard-log row names the rule, never the command or the path', () => {
    const p = project({});
    const r = p.run('cat config/.env.local');
    expect(r.decision).toBeNull();
    expect(r.rows).toEqual([expect.objectContaining({ event: 'guard-log', guard: 'secrets', rule: 'env-file-read', agent_type: 'track' })]);
    expect(r.logText).not.toContain('config/');
    expect(r.logText).not.toContain('cat ');
  }, 30_000);

  it('block: denied with the hint; off: nothing; the main session is never touched', () => {
    let r = project({ guards: { secretReads: 'block' } }).run('printenv');
    expect(r.decision).toBe('deny');
    expect(r.reason).toContain('$DATABASE_URL');
    expect(r.rows).toEqual([expect.objectContaining({ event: 'guard-deny', guard: 'secrets', rule: 'env-dump' })]);
    r = project({ guards: { secretReads: 'off' } }).run('printenv');
    expect(r.decision).toBeNull();
    expect(r.rows).toEqual([]);
    r = project({}).run('cat .env', null);
    expect(r.decision).toBeNull();
    expect(r.rows).toEqual([]);
  }, 30_000);
});
