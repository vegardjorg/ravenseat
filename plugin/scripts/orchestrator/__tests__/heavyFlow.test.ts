// =============================================================
// heavyFlow.test.ts: `ravenseat heavy -- <command>` and the PreToolUse hint, with real processes (roadmap 0s V10).
//
// Locks: heavy takes a machine queue slot, runs the command with the slot held (holder kind heavy, with the command and
// a heartbeat), gives the command's exit code back and frees the slot; the command gets QUEUE_GATE_QUEUE=off, so a gate
// inside it never waits for the slot its parent holds; with a slot held by a live process it waits and says so; with
// the queue off it just runs; a missing command is a usage error (exit 2). The hook: a track's bare `npm test` gets
// context pointing at the wrapper (warn, the default, the command runs), a deny with processGuard.heavyQueue deny,
// nothing with off, nothing for the main session, nothing for a line already wrapped, and nothing with the gate queue
// off. Every run has its own temp project and queue root, never the machine's real queue.
// =============================================================
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

const HERE = path.resolve(__dirname, '..');
const QUEUE = path.join(HERE, 'queue.mjs');
const HOOK = path.join(HERE, 'hook-push-guard.mjs');

const temporary: string[] = [];
afterAll(() => {
  for (const m of temporary) {
    try {
      fs.rmSync(m, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    } catch {
      /* left for the OS */
    }
  }
});

function project(config: Record<string, unknown> = {}, queueOn = true) {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'heavy-flow-')));
  temporary.push(folder);
  const data = path.join(folder, 'data');
  fs.mkdirSync(data);
  const configFile = path.join(folder, 'queue.config.json');
  fs.writeFileSync(configFile, JSON.stringify({ baseBranch: 'main', ...config }));
  const queueRoot = path.join(folder, 'gate-queue');
  const env: Record<string, string | undefined> = {
    ...process.env,
    QUEUE_FOLDER: data,
    QUEUE_CONFIG: configFile,
    QUEUE_ROOT: folder,
    QUEUE_TIME_LOG: path.join(folder, 'time.jsonl'),
    QUEUE_GATE_QUEUE: queueOn ? 'on' : 'off',
    QUEUE_GATE_QUEUE_DIR: queueRoot,
  };
  delete env.QUEUE_GIT;
  const heavy = (...args: string[]) => {
    const r = spawnSync(process.execPath, [QUEUE, 'heavy', ...args], { encoding: 'utf8', env, cwd: folder, timeout: 50_000 });
    return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
  };
  const hook = (command: string, agent: string | null = 'track') => {
    const payload = { tool_name: 'Bash', tool_input: { command }, cwd: folder, ...(agent ? { agent_type: agent, agent_id: 'a1' } : {}) };
    const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(payload), encoding: 'utf8', env, cwd: folder });
    return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput ?? {} : null;
  };
  return { folder, env, queueRoot, heavy, hook };
}

/** A node one-liner as a shell word (double quotes on both platforms; the script has none of its own). */
const nodeLine = (js: string) => `node -e "${js}"`;

describe('ravenseat heavy', () => {
  it('runs the command in a slot, gives its exit code back and frees the slot', () => {
    const p = project();
    const r = p.heavy('--', nodeLine('process.exit(3)'));
    expect(r.code).toBe(3);
    expect(fs.existsSync(path.join(p.queueRoot, 'slot-0'))).toBe(false);
  });

  it('holds the slot while the command runs, as kind heavy with the command and a heartbeat', () => {
    const p = project();
    const check =
      "const f=require('path').join(process.env.CHECK_DIR,'slot-0','holder.json');" +
      "const h=JSON.parse(require('fs').readFileSync(f,'utf8'));" +
      "process.exit(h.kind==='heavy'&&String(h.command).includes('node')&&h.staleSec>0&&process.env.QUEUE_GATE_QUEUE==='off'?0:6)";
    const r = spawnSync(process.execPath, [QUEUE, 'heavy', '--', nodeLine(check)], {
      encoding: 'utf8',
      env: { ...p.env, CHECK_DIR: p.queueRoot },
      cwd: p.folder,
      timeout: 50_000,
    });
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
  });

  it('waits for a slot held by a live process, says so, and runs once it is free', async () => {
    const p = project();
    const dir = path.join(p.queueRoot, 'slot-0');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'holder.json'), JSON.stringify({ pid: process.pid, project: 'other', kind: 'full', started: new Date().toISOString(), beatSec: 30, staleSec: 300 }));
    const child = spawn(process.execPath, [QUEUE, 'heavy', '--', nodeLine('process.exit(0)')], { env: p.env, cwd: p.folder });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const done = new Promise<number | null>((resolve) => child.on('close', (c) => resolve(c)));
    const t0 = Date.now();
    while (!/GATE QUEUE: waiting/.test(out) && Date.now() - t0 < 20_000) await new Promise((r) => setTimeout(r, 100));
    expect(out).toMatch(/GATE QUEUE: waiting/);
    expect(out).toMatch(/full gates of other/);
    fs.rmSync(dir, { recursive: true, force: true });
    expect(await done).toBe(0);
  }, 60_000);

  it('just runs the command when the gate queue is off', () => {
    const p = project({}, false);
    const r = p.heavy('--', nodeLine('process.exit(4)'));
    expect(r.code).toBe(4);
    expect(fs.existsSync(p.queueRoot)).toBe(false);
  });

  it('a missing command is a usage error', () => {
    const p = project();
    expect(p.heavy().code).toBe(2);
    expect(p.heavy('--').code).toBe(2);
  });
});

describe('the hook for heavy commands in a track', () => {
  it('warn (the default): context pointing at the wrapper, no decision', () => {
    const out = project().hook('npm test');
    expect(out?.permissionDecision).toBeUndefined();
    expect(out?.additionalContext).toMatch(/heavy -- npm test/);
  });

  it('deny with processGuard.heavyQueue deny, with the command to run instead', () => {
    const out = project({ processGuard: { heavyQueue: 'deny' } }).hook('npx vitest run');
    expect(out?.permissionDecision).toBe('deny');
    expect(out?.permissionDecisionReason).toMatch(/heavy -- npx vitest run/);
  });

  it('nothing with off, for the main session, for a wrapped line, or with the gate queue off', () => {
    expect(project({ processGuard: { heavyQueue: 'off' } }).hook('npm test')).toBe(null);
    expect(project().hook('npm test', null)).toBe(null);
    expect(project().hook('ravenseat heavy -- npm test')).toBe(null);
    expect(project({ gateQueue: { enabled: false } }, false).hook('npm test')).toBe(null);
  });
});
