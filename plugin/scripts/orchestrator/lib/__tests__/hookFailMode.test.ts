// =============================================================
// hookFailMode.test.ts: a blocking guard never fails open on a timer (ARK-1 T1, architecture review B).
//
// (1) Guard test (renameGuard.test.ts pattern): every hook script that hooks.json or settings.queue.json marks
//     `"onFailure": "block"` must not hold a timer that exits 0. Such a timer turned "too slow to decide" into "allow"
//     before Claude Code's own 10 s limit could block the call.
// (2) Behaviour: the write guard on a slow path (stdin never closes) answers with a deny that says what happened and how
//     to retry. With guards.onHookFailure "allow" it gives no answer, as the owner chose.
// =============================================================
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/* eslint-disable @typescript-eslint/no-require-imports */
const HF = require('../hookFailure.js');
const ORCH = path.resolve(__dirname, '..', '..');
const PLUGIN = path.resolve(ORCH, '..', '..');

/** The scripts a hook file marks onFailure "block". */
function blockingScripts(file: string): string[] {
  const hooks = JSON.parse(fs.readFileSync(path.join(PLUGIN, file), 'utf8')).hooks ?? {};
  const out = new Set<string>();
  for (const groups of Object.values(hooks) as any[])
    for (const g of groups ?? [])
      for (const h of g.hooks ?? []) {
        const s = HF.scriptOf(h);
        if (s && h.onFailure === 'block') out.add(s);
      }
  return [...out];
}

// A timer whose callback exits with code 0 (or no code): `setTimeout(() => process.exit(0), n)` and its variants.
const EXIT0_TIMER = /setTimeout\(\s*(?:\(\)|function\s*\(\))\s*(?:=>)?\s*\{?\s*process\.exit\(\s*0?\s*\)/;

describe('guard test: a blocking hook has no timer that exits 0', () => {
  it.each(['hooks/hooks.json', 'settings.queue.json'])('%s', (file) => {
    const scripts = blockingScripts(file);
    // The two guards are marked block (hookFailure.test.ts locks that); an empty list would make this test pass on nothing.
    expect(scripts.length).toBeGreaterThan(0);
    for (const s of scripts) {
      const text = fs.readFileSync(path.join(ORCH, s), 'utf8');
      expect(EXIT0_TIMER.test(text), `${s} has a timer that exits 0 although it is marked onFailure block`).toBe(false);
    }
  });

  it('the pattern catches the old form', () => {
    expect(EXIT0_TIMER.test('const guard = setTimeout(() => process.exit(0), 5000);')).toBe(true);
    expect(EXIT0_TIMER.test('setTimeout(function () { process.exit(); }, 10)')).toBe(true);
    expect(EXIT0_TIMER.test('setTimeout(() => process.exit(1), 5000)')).toBe(false);
  });
});

const temporary: string[] = [];
afterAll(() => {
  for (const f of temporary) fs.rmSync(f, { recursive: true, force: true });
});

/** Runs the write guard with stdin left open (a slow path), and resolves with its exit code and stdout. */
function slowWriteGuard(config: object | null, timeLog?: string, head?: string): Promise<{ code: number | null; out: string }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ravenseat-wg-slow-'));
  temporary.push(root);
  const folder = path.join(root, 'q');
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, 'queue.json'), JSON.stringify({ tasks: [] }));
  const configFile = path.join(root, 'queue.config.json');
  if (config) fs.writeFileSync(configFile, JSON.stringify(config));
  const env = { ...process.env, QUEUE_ROOT: root, QUEUE_FOLDER: folder, QUEUE_CONFIG: configFile, WRITE_GUARD_BUDGET_MS: '300' } as Record<string, string | undefined>;
  if (timeLog) env.QUEUE_TIME_LOG = timeLog;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ORCH, 'hook-write-guard.mjs')], { cwd: root, env, stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    // Half a payload and no end: the guard waits for the rest, as on a stalled pipe or a machine under load.
    child.stdin.write(head ?? '{"agent_type":"track","tool_name":"Write",');
    const stop = setTimeout(() => child.kill(), 20000);
    child.on('exit', (code) => {
      clearTimeout(stop);
      resolve({ code, out });
    });
  });
}

describe('the write guard on a slow path', () => {
  it('denies with the reason and how to retry (guards.onHookFailure block, the default)', async () => {
    const r = await slowWriteGuard(null);
    expect(r.code).toBe(0);
    const answer = JSON.parse(r.out).hookSpecificOutput;
    expect(answer.permissionDecision).toBe('deny');
    expect(answer.permissionDecisionReason).toMatch(/did not finish/);
    expect(answer.permissionDecisionReason).toMatch(/again/);
  }, 30000);

  it('the time-out deny writes one guard log row (rule timeout), never the path or the content', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ravenseat-wg-log-'));
    temporary.push(dir);
    const log = path.join(dir, 'time-log.jsonl');
    // A fake secret built at run time, in the half payload: it must never reach the row.
    const secret = ['tok', 'en', '-', 'x'.repeat(6), '9'].join('');
    const head = `{"agent_type":"track","tool_name":"Write","tool_input":{"file_path":"/x/${secret}.env","content":"${secret}"},`;
    const r = await slowWriteGuard(null, log, head);
    expect(JSON.parse(r.out).hookSpecificOutput.permissionDecision).toBe('deny');
    const rows = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ wave: 'guard', event: 'guard-deny', guard: 'write', rule: 'timeout' });
    expect(JSON.stringify(rows)).not.toContain(secret);
  }, 30000);

  it('still denies when the guard log row cannot be written', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ravenseat-wg-log-'));
    temporary.push(dir);
    // The log path is a folder: the append fails, the block must stand.
    const r = await slowWriteGuard(null, dir);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).hookSpecificOutput.permissionDecision).toBe('deny');
  }, 30000);

  it('gives no answer with guards.onHookFailure allow', async () => {
    const r = await slowWriteGuard({ guards: { onHookFailure: 'allow' } });
    expect(r.code).toBe(0);
    expect(r.out).toBe('');
  }, 30000);
});
