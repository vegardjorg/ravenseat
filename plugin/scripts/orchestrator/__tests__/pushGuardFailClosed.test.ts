// pushGuardFailClosed.test.ts: hook-push-guard.mjs with a broken lib/pushGuard.js (a copy of the hook and lib/ in a
// temporary folder). An internal error must still stop a forced push or a branch delete (deny), and let everything
// else through as before (fails open). Two forms: the module does not load, and assess() throws.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const ORCH = path.resolve(__dirname, '..');
const temporary: string[] = [];
afterAll(() => {
  for (const f of temporary) fs.rmSync(f, { recursive: true, force: true });
});

/** A copy of the hook and lib/ (without tests), with lib/pushGuard.js replaced by `broken`. */
function brokenHook(broken: string) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-failclosed-'));
  temporary.push(folder);
  const scripts = path.join(folder, 'scripts');
  fs.mkdirSync(scripts);
  fs.copyFileSync(path.join(ORCH, 'hook-push-guard.mjs'), path.join(scripts, 'hook-push-guard.mjs'));
  fs.cpSync(path.join(ORCH, 'lib'), path.join(scripts, 'lib'), {
    recursive: true,
    filter: (src) => !src.includes(`${path.sep}__tests__`),
  });
  fs.copyFileSync(path.join(scripts, 'lib', 'pushGuard.js'), path.join(scripts, 'lib', 'pushGuardReal.js'));
  fs.writeFileSync(path.join(scripts, 'lib', 'pushGuard.js'), broken);
  const project = path.join(folder, 'project');
  const data = path.join(project, 'data');
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, 'queue.json'), JSON.stringify({ tasks: [], resolved: [] }));
  const configFile = path.join(project, 'queue.config.json');
  fs.writeFileSync(configFile, JSON.stringify({ baseBranch: 'main' }));
  const env = { ...process.env, QUEUE_FOLDER: data, QUEUE_CONFIG: configFile, QUEUE_ROOT: project, QUEUE_GIT: project };
  return (command: string) => {
    const r = spawnSync(process.execPath, [path.join(scripts, 'hook-push-guard.mjs')], {
      cwd: project,
      env,
      encoding: 'utf8',
      input: JSON.stringify({ tool_input: { command }, cwd: project }),
    });
    return { code: r.status, out: r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null, error: r.stderr };
  };
}

describe.each([
  ['the module does not load', "throw new Error('broken on load');\n"],
  [
    'assess() throws',
    "const real = require('./pushGuardReal.js');\nmodule.exports = { ...real, assess() { throw new Error('broken in assess'); } };\n",
  ],
])('push guard with an internal error (%s)', (_name, broken) => {
  const hook = brokenHook(broken);

  it('denies a forced push, with the reason', () => {
    const r = hook('git push --force origin main');
    expect(r.code).toBe(0);
    expect(r.out?.permissionDecision).toBe('deny');
    expect(r.out?.permissionDecisionReason).toMatch(/internal error/);
    expect(r.error).toMatch(/push-guard: internal error/);
  });

  it('denies a branch delete', () => {
    expect(hook('git push origin --delete feature').out?.permissionDecision).toBe('deny');
  });

  it('lets an ordinary command through (fails open)', () => {
    const r = hook('git status');
    expect(r.code).toBe(0);
    expect(r.out).toBeNull();
  });

  it('lets a plain push through (fails open)', () => {
    const r = hook('git push origin main');
    expect(r.code).toBe(0);
    expect(r.out).toBeNull();
  });
});
