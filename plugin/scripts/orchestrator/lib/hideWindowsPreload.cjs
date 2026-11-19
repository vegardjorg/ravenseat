// Loaded through NODE_OPTIONS (--require) below a detached start (lib/hideWindows.cjs): makes windowsHide the default
// for this node process's own process calls. Never throws: a process must start even if this fails.
'use strict';

try {
  require('./hideWindows.cjs').installHideDefault();
  // ESM imports of node:child_process read the built-in's exports; sync them with the wrapped functions.
  require('node:module').syncBuiltinESMExports();
} catch {
  // error-ignored: the process runs as before, only with visible windows
}
