// Hidden windows by default (lib/hideWindows.cjs). On Windows a detached process has no console, and windowsHide on its
// own start does not reach what it starts: every git, cmd or npm call below it opened a console window of its own. The
// preload makes windowsHide the default for every process call, and the detached starts pass the preload on through
// NODE_OPTIONS, so children and grandchildren (test runs included) start hidden too.
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const HW = require('../hideWindows.cjs');

/** A fake child_process whose calls record the arguments they got. */
function fakeCp() {
  const calls: Record<string, unknown[][]> = {};
  const cp: Record<string, unknown> = {};
  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']) {
    calls[name] = [];
    cp[name] = (...a: unknown[]) => {
      calls[name].push(a);
      return name;
    };
  }
  return { cp, calls };
}

describe('hideWindows: windowsHide is the default for every process call', () => {
  it('adds windowsHide to each call form, without changing the caller object', () => {
    const { cp, calls } = fakeCp();
    HW.installHideDefault(cp);
    const opts = { cwd: '.' };
    const cb = () => {};
    (cp.spawn as Function)('git', ['status'], opts);
    (cp.spawn as Function)('git');
    (cp.spawnSync as Function)('git', opts);
    (cp.execFile as Function)('git', ['x'], cb);
    (cp.execFile as Function)('git', cb);
    (cp.execFile as Function)('git', null, opts, cb);
    (cp.execFileSync as Function)('git', ['x']);
    (cp.exec as Function)('git status', cb);
    (cp.execSync as Function)('git status', opts);
    (cp.fork as Function)('x.js', ['a']);

    expect(calls.spawn[0]).toEqual(['git', ['status'], { cwd: '.', windowsHide: true }]);
    expect(calls.spawn[1]).toEqual(['git', [], { windowsHide: true }]);
    expect(calls.spawnSync[0]).toEqual(['git', { cwd: '.', windowsHide: true }]);
    expect(calls.execFile[0]).toEqual(['git', ['x'], { windowsHide: true }, cb]);
    expect(calls.execFile[1]).toEqual(['git', { windowsHide: true }, cb]);
    expect(calls.execFile[2]).toEqual(['git', null, { cwd: '.', windowsHide: true }, cb]);
    expect(calls.execFileSync[0]).toEqual(['git', ['x'], { windowsHide: true }]);
    expect(calls.exec[0]).toEqual(['git status', { windowsHide: true }, cb]);
    expect(calls.execSync[0]).toEqual(['git status', { cwd: '.', windowsHide: true }]);
    expect(calls.fork[0]).toEqual(['x.js', ['a'], { windowsHide: true }]);
    expect(opts).toEqual({ cwd: '.' });
  });

  it('keeps an explicit windowsHide: false, and installing twice wraps once', () => {
    const { cp, calls } = fakeCp();
    HW.installHideDefault(cp);
    HW.installHideDefault(cp);
    (cp.spawnSync as Function)('git', [], { windowsHide: false });
    expect(calls.spawnSync[0]).toEqual(['git', [], { windowsHide: false }]);
    expect(calls.spawnSync).toHaveLength(1);
  });

  it('hiddenWindowsEnv adds the preload once, keeps NODE_OPTIONS already set, and leaves other platforms alone', () => {
    expect(HW.hiddenWindowsEnv({ A: '1' }, 'linux')).toEqual({ A: '1' });
    expect(HW.hiddenWindowsEnv({ RAVENSEAT_HIDE_WINDOWS: 'off' }, 'win32')).toEqual({ RAVENSEAT_HIDE_WINDOWS: 'off' });
    const env = HW.hiddenWindowsEnv({ PATH: 'p', NODE_OPTIONS: '--max-old-space-size=4096' }, 'win32');
    expect(env.PATH).toBe('p');
    expect(env.NODE_OPTIONS).toContain('--max-old-space-size=4096');
    expect(env.NODE_OPTIONS).toContain(`--require "${HW.PRELOAD}"`);
    expect(HW.hiddenWindowsEnv(env, 'win32').NODE_OPTIONS).toBe(env.NODE_OPTIONS);
    expect(HW.hiddenWindowsEnv({}, 'win32').NODE_OPTIONS).toBe(`--require "${HW.PRELOAD}"`);
  });

  it('reaches a child and a grandchild, CommonJS and ESM alike', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-hide-'));
    try {
      const grand = path.join(dir, 'grand.mjs');
      fs.writeFileSync(
        grand,
        "import { spawnSync } from 'node:child_process';\nprocess.stdout.write(String(spawnSync.ravenseatHidesWindows === true));\n",
      );
      const child = path.join(dir, 'child.cjs');
      fs.writeFileSync(
        child,
        [
          "const cp = require('node:child_process');",
          "const g = cp.spawnSync(process.execPath, [process.argv[2]], { encoding: 'utf8' });",
          "process.stdout.write(String(cp.spawn.ravenseatHidesWindows === true) + ' ' + g.stdout);",
        ].join('\n'),
      );
      const r = spawnSync(process.execPath, [child, grand], { encoding: 'utf8', env: HW.hiddenWindowsEnv(process.env, 'win32') });
      expect(r.stderr).toBe('');
      expect(r.stdout).toBe('true true');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the detached starts pass the preload on', () => {
    const lib = path.join(__dirname, '..');
    for (const f of ['waitMode.js', 'treeRun.js', 'queueUpdate.js', '../gates.mjs']) {
      expect(fs.readFileSync(path.join(lib, f), 'utf8'), f).toContain('hiddenWindowsEnv(');
    }
  });
});
