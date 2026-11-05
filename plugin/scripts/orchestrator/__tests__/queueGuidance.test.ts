// =============================================================
// queueGuidance.test.ts: `cq guidance` and what it reaches, through real queue.mjs and hook processes against a temporary
// repo: the doctor lines, the push question, push-check, and base gate off giving no FAIL.
// =============================================================
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPTS = path.join(ROOT, 'scripts', 'orchestrator');
const temporary: string[] = [];
afterAll(() => {
  for (const m of temporary) fs.rmSync(m, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}, 60_000);

function project(config: Record<string, unknown> = {}) {
  const folder = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'queue-gd-')));
  temporary.push(folder);
  const g = (...args: string[]) =>
    execFileSync('git', ['-C', folder, '-c', 'user.name=t', '-c', 'user.email=t@firm.no', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  g('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(folder, 'a.txt'), 'a\n');
  g('add', '--', 'a.txt');
  g('commit', '-q', '-m', 'start');
  const data = path.join(folder, 'data');
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, 'queue.json'), JSON.stringify({ tasks: [], resolved: [] }));
  const configFile = path.join(folder, 'queue.config.json');
  fs.writeFileSync(configFile, JSON.stringify({ baseBranch: 'main', ...config }));
  const env = { ...process.env, QUEUE_FOLDER: data, QUEUE_CONFIG: configFile, QUEUE_ROOT: folder, QUEUE_GIT: folder, QUEUE_SECRET_SCANNER: 'builtin' };
  const cq = (...args: string[]) => {
    const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'queue.mjs'), ...args], { cwd: folder, env, encoding: 'utf8' });
    return { code: r.status, out: r.stdout, error: r.stderr };
  };
  const hook = (command: string) => {
    const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'hook-push-guard.mjs')], {
      cwd: folder,
      env,
      encoding: 'utf8',
      input: JSON.stringify({ tool_input: { command }, cwd: folder }),
    });
    return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null;
  };
  const pushCheck = () => spawnSync(process.execPath, [path.join(SCRIPTS, 'push-check.mjs')], { cwd: folder, env, encoding: 'utf8' }).stdout;
  // A bare origin and one unpushed commit: push-check has something to compare with.
  const origin = () => {
    const bare = path.join(folder, 'origin.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
    g('remote', 'add', 'origin', bare);
    g('push', '-q', 'origin', 'main');
    fs.writeFileSync(path.join(folder, 'b.txt'), 'b\n');
    g('add', '--', 'b.txt');
    g('commit', '-q', '-m', 'more');
  };
  return { cq, hook, pushCheck, g, origin, folder };
}

describe('cq guidance', () => {
  it('switches, stores and refuses anything else', () => {
    const p = project();
    expect(p.cq('guidance').out).toContain('Guidance: guided');
    expect(p.cq('guidance', 'quiet').out).toContain('Guidance: quiet');
    expect(p.cq('guidance').out).toContain('Guidance: quiet');
    expect(p.cq('guidance', 'guided').out).toContain('Guidance: guided');
    expect(p.cq('guidance', 'odd').code).toBe(1);
  });

  it('stops the advice in doctor, the push question and push-check, and the secret scan still asks', () => {
    const p = project();
    p.origin();
    expect(p.pushCheck()).toContain('Controls:');
    expect(p.cq('doctor').out).toContain('no CI config found');
    expect(p.hook('git push origin main')?.permissionDecisionReason).toContain('no CI config');
    p.cq('guidance', 'quiet');
    const doctor = p.cq('doctor').out;
    expect(doctor).not.toContain('no CI config found');
    expect(doctor).toContain('guidance is quiet');
    const answer = p.hook('git push origin main');
    expect(answer?.permissionDecisionReason ?? '').not.toContain('no CI config');
    expect(p.pushCheck()).not.toContain('Controls:');
    // Not the secret scan: a key on the branch still asks, with the guidance quiet.
    fs.writeFileSync(path.join(p.folder, 'k.txt'), `${['AKIA', 'IOSFODNN7ABCDEFG'].join('')}\n`);
    p.g('add', '--', 'k.txt');
    p.g('commit', '-q', '-m', 'key');
    const secret = p.hook('git push origin main');
    expect(secret?.permissionDecision).toBe('ask');
    expect(secret?.permissionDecisionReason).toContain('k.txt');
  });

});

describe('fixes around the switches', () => {
  it('baseGate.enabled: false is valid in doctor', () => {
    const r = project({ baseGate: { enabled: false } }).cq('doctor');
    expect(r.out).not.toContain('baseGate.enabled');
    expect(r.out).not.toMatch(/FAIL\s+config/);
  });

  it('a wrong type there is still a fault', () => {
    expect(project({ baseGate: { enabled: 5 } }).cq('doctor').out).toContain('baseGate.enabled');
  });

  it('push-check respects push.controlsWarning', () => {
    const on = project();
    on.origin();
    expect(on.pushCheck()).toContain('Controls:');
    const off = project({ push: { controlsWarning: false } });
    off.origin();
    const text = off.pushCheck();
    expect(text).toContain('main');
    expect(text).not.toContain('Controls:');
  });

  it('push.allowBranches lets the main session push that branch, and only that', () => {
    const p = project({ push: { allowBranches: ['feat/*'] } });
    p.g('switch', '-q', '-c', 'feat/x');
    expect(p.hook('git push -u origin feat/x')).toBeNull();
    expect(p.hook('git push origin other')?.permissionDecision).toBe('deny');
  });
});
