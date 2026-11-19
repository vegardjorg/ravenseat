// =============================================================
// hideWindows.cjs: windowsHide as the default for every process call, and the env that passes it on.
//
// Why: on Windows a process started with `detached: true` has no console. `windowsHide` on that start hides only that
// one process; every console program it or its children start later (git, cmd, npm, gh) opens a console window of its
// own unless that call passes windowsHide too. A test run that makes git repos calls git hundreds of times, so a gate
// or a wait run behind a detached start made the screen blink once per call.
//
// What it does:
//   installHideDefault(cp)  wraps spawn, spawnSync, execFile, execFileSync, exec, execSync and fork so a call without
//                           windowsHide gets windowsHide: true. An explicit value (false included) is kept, and the
//                           caller's options object is never changed (a copy is passed on). Installing twice wraps once.
//   hiddenWindowsEnv(env)   a copy of env whose NODE_OPTIONS also loads the preload (hideWindowsPreload.cjs), so every
//                           node process below a detached start installs the default too, children and grandchildren
//                           alike. Only on Windows (the flag means nothing elsewhere, so other platforms get env as is),
//                           and not with windows.hideConsoles false in queue.config.json or RAVENSEAT_HIDE_WINDOWS=off
//                           (escape hatches: hiding a window has no friction, so it is on by default).
//
// windowsHide changes nothing for the user beyond the missing window: output, exit codes and stdio are the same.
// =============================================================
'use strict';

const path = require('node:path');

/** The preload file, with forward slashes: NODE_OPTIONS reads a backslash inside quotes as an escape. */
const PRELOAD = path.join(__dirname, 'hideWindowsPreload.cjs').replace(/\\/g, '/');

const MARK = 'ravenseatHidesWindows';

/** A plain options object (not an argument list, not a callback, not null). */
function isOptions(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Sets windowsHide at index i of the argument list a, as a copy of the options there; inserts options when there are none. */
function hideAt(a, i) {
  if (isOptions(a[i])) {
    if (a[i].windowsHide === undefined) a[i] = { ...a[i], windowsHide: true };
  } else if (a[i] === undefined) {
    a[i] = { windowsHide: true };
  } else {
    a.splice(i, 0, { windowsHide: true }); // a callback sits there: options go before it
  }
  return a;
}

/** (file, args?, options?, callback?): spawn, spawnSync, execFile, execFileSync, fork. */
function fileForm(a) {
  if (Array.isArray(a[1]) || a[1] === null) return hideAt(a, 2);
  if (isOptions(a[1])) return hideAt(a, 1);
  if (a[1] === undefined) {
    a[1] = [];
    return hideAt(a, 2);
  }
  return hideAt(a, 1); // (file, callback)
}

/** (command, options?, callback?): exec, execSync. */
function commandForm(a) {
  return hideAt(a, 1);
}

const FORMS = {
  spawn: fileForm,
  spawnSync: fileForm,
  execFile: fileForm,
  execFileSync: fileForm,
  fork: fileForm,
  exec: commandForm,
  execSync: commandForm,
};

/**
 * Wraps the process calls of cp (node:child_process by default) so windowsHide defaults to true.
 * @param {object} [cp]
 * @returns {object} cp
 */
function installHideDefault(cp = require('node:child_process')) {
  for (const [name, form] of Object.entries(FORMS)) {
    const original = cp[name];
    if (typeof original !== 'function' || original[MARK]) continue;
    const wrapped = function (...a) {
      return original.apply(this, form(a));
    };
    Object.defineProperty(wrapped, MARK, { value: true });
    cp[name] = wrapped;
  }
  return cp;
}

/**
 * A copy of env whose NODE_OPTIONS also loads the preload, on Windows only. Existing NODE_OPTIONS are kept, and a
 * preload already there is not added twice.
 * @param {Record<string, string | undefined>} env
 * @param {string} [platform]
 * @param {boolean} [enabled] windows.hideConsoles (read from the queue config when left out; on when it cannot be read)
 */
function hiddenWindowsEnv(env, platform = process.platform, enabled = configOn()) {
  const out = { ...env };
  if (!enabled) return out;
  // RAVENSEAT_HIDE_WINDOWS=off: the escape hatch if the preload ever gets in a project's way (windows show again).
  if (platform !== 'win32' || /^(off|0|false|no)$/i.test(String(out.RAVENSEAT_HIDE_WINDOWS ?? ''))) return out;
  const part = `--require "${PRELOAD}"`;
  const now = out.NODE_OPTIONS ?? '';
  if (now.includes(part)) return out;
  out.NODE_OPTIONS = now ? `${now} ${part}` : part;
  return out;
}

/** windows.hideConsoles from the queue config; true when the config cannot be read (the default). */
function configOn() {
  try {
    return require('./queueConfig.js').config()?.windows?.hideConsoles !== false;
  } catch {
    return true; // error-ignored: the default holds
  }
}

module.exports = { installHideDefault, hiddenWindowsEnv, PRELOAD, MARK };
