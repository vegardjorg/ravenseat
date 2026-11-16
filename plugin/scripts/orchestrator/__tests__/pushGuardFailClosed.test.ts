// pushGuardFailClosed.test.ts: hook-push-guard.mjs with a broken lib/pushGuard.js (a copy of the hook and lib/ in a
// temporary folder). An internal error must still stop a forced push or a branch delete (deny), and let everything
// else through as before (fails open). Two forms: the module does not load, and assess() throws. And the same when the
// client registry (lib/clients/index.js) does not load, or the registry and the hook reader (hookInput.js) both fail:
// failSafe never goes through the registry, and with no reader at all it reads tool_input.command itself (0w W2c).
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

/**
 * A copy of the hook and lib/ (without tests), with lib/pushGuard.js replaced by `broken`, or, with `files`, each
 * given file under lib/ (path relative to lib/) replaced by its text.
 */
function brokenHook(broken: string | null, files: Record<string, string> = {}) {
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
  if (broken !== null) fs.writeFileSync(path.join(scripts, 'lib', 'pushGuard.js'), broken);
  for (const [rel, text] of Object.entries(files)) fs.writeFileSync(path.join(scripts, 'lib', rel), text);
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

const NO_LOAD = "throw new Error('broken on load');\n";

describe.each([
  ['the client registry does not load', { 'clients/index.js': NO_LOAD }],
  ['the registry and the hook reader both fail', { 'clients/index.js': NO_LOAD, 'clients/claude/hookInput.js': NO_LOAD }],
])('push guard when %s', (_name, files) => {
  const hook = brokenHook(null, files);

  it('denies a forced push, with the reason', () => {
    const r = hook('git push --force origin main');
    expect(r.code).toBe(0);
    expect(r.out?.hookEventName).toBe('PreToolUse');
    expect(r.out?.permissionDecision).toBe('deny');
    expect(r.out?.permissionDecisionReason).toMatch(/^push-guard: .*internal error/);
    expect(r.error).toMatch(/push-guard: internal error/);
  });

  it('denies a branch delete', () => {
    expect(hook('git push origin --delete feature').out?.permissionDecision).toBe('deny');
  });

  it('lets an ordinary command and a plain push through (fails open)', () => {
    expect(hook('git status').out).toBeNull();
    expect(hook('git push origin main').out).toBeNull();
  });
});
