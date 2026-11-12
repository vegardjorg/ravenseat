#!/usr/bin/env node
// =============================================================
// ravenseat.mjs: one entry point for all the queue's scripts, so skills, agents and missions can say `ravenseat <...>` and work the
// same whether the scripts live in the project (vendored install) or in Claude Code's plugin folder (plugin install).
//
// Usage:
//   ravenseat <queue command> [args]     same as queue.mjs <queue command>, e.g. `ravenseat show`, `ravenseat fill --scratchpad <dir>`
//   ravenseat queue <command> [args]     the same, written out
//   ravenseat board [args]               queue-board.mjs
//   ravenseat takeover [args]            queue-takeover.mjs
//   ravenseat <script> [args]            <script>.mjs, e.g. `ravenseat prepare-track EX-1 --branch queue/EX-1 --scratchpad <dir>`
//   ravenseat help                       the key commands in groups (lib/cliHelp.js); in lite mode only the core loop
//   ravenseat help all                   every command
//   ravenseat help <command>             one queue command in full, or a script's header
//   ravenseat --version                  the plugin's version ("unknown" in a vendored copy without the plugin manifest)
//
// In a plugin, bin/ravenseat (and bin/ravenseat.cmd on Windows) calls this file; the plugin's bin/ folder is on the Bash tool's PATH.
// In a vendored install there is no `ravenseat` on PATH; there the command is `node scripts/orchestrator/ravenseat.mjs <...>`
// (install.mjs rewrites the skills and docs to that form). The project is found by lib/projectRoot.js, not by where
// this file lives.
// =============================================================
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HELP = createRequire(import.meta.url)('./lib/cliHelp.js');

// Short names for scripts whose file name is long or starts with "queue-".
const ALIASES = HELP.ALIASES;

/** The scripts a user or agent may start (hooks are started by Claude Code, not by hand). */
function scripts() {
  return fs
    .readdirSync(HERE)
    .filter((f) => f.endsWith('.mjs') && !f.startsWith('hook-') && f !== 'ravenseat.mjs')
    .map((f) => f.slice(0, -'.mjs'.length))
    .sort();
}

/** Is the project in lite mode ("mode": "lite" in queue.config.json)? Any error reading it = full (the default). */
function liteMode() {
  try {
    const require = createRequire(import.meta.url);
    return require('./lib/liteMode.js').isLite(require('./lib/queueConfig.js').config());
  } catch {
    return false;
  }
}

let [first, ...rest] = process.argv.slice(2);
if (first === '--version' || first === '-v') {
  let version = 'unknown';
  try {
    version = JSON.parse(fs.readFileSync(path.join(HERE, '..', '..', '.claude-plugin', 'plugin.json'), 'utf8')).version ?? version;
  } catch {
    /* a vendored copy has no plugin manifest */
  }
  console.log(`ravenseat ${version}`);
  process.exit(0);
}
// `ravenseat decide --help` asks about decide; running the command instead would answer something else, or change something.
// A script (ravenseat board, ravenseat setup) has its own --help, so it still goes there.
if (first && first !== 'help' && !HELP.ALIASES[first] && !scripts().includes(first) && (rest[0] === '--help' || rest[0] === '-h')) {
  [first, rest] = ['help', [first]];
}

if (!first || first === 'help' || first === '--help' || first === '-h') {
  // The texts and the parsing are in lib/cliHelp.js; the full usage list lives as the comment at the top of queue.mjs.
  const what = rest[0];
  const source = () => fs.readFileSync(path.join(HERE, 'queue.mjs'), 'utf8');
  let lines;
  if (!what) lines = HELP.shortHelp('ravenseat', { lite: liteMode() });
  else if (what === 'all') lines = HELP.fullHelp(source(), scripts());
  else if (HELP.ALIASES[what] || scripts().includes(what)) {
    lines = HELP.scriptHeader(fs.readFileSync(path.join(HERE, `${HELP.ALIASES[what] ?? what}.mjs`), 'utf8'));
  } else lines = HELP.commandHelp(source(), what);
  if (!lines) {
    console.error(HELP.unknownCommandMessage(what, HELP.knownCommands(scripts())));
    process.exit(1);
  }
  console.log(lines.join('\n'));
  process.exit(0);
}

// A script name (or alias) runs that script; everything else is a queue.mjs command.
const name = ALIASES[first] ?? (scripts().includes(first) ? first : null);
const file = path.join(HERE, `${name ?? 'queue'}.mjs`);
const args = name ? rest : [first, ...rest];

// queue.config.json exists but does not parse: a script stops here instead of running on the defaults (H3). A queue
// command is checked by queue.mjs itself (where `doctor` is exempt); `setup` is exempt (it never replaces the file).
if (name && name !== 'setup') createRequire(import.meta.url)('./lib/queueConfig.js').stopIfConfigUnreadable();

// A queue command runs in THIS process (review 2026-11-11, E2): a second node start cost about 100 ms or more on every
// command, and the orchestrator runs many per round. process.argv is set to what queue.mjs had as its own process
// ([node, queue.mjs, command, ...]), so every argv read in queue.mjs and cli/ sees the same as before. env, cwd and the
// stdio handles were inherited by the child, so they are the same here. The exit code is queue.mjs's own (process.exit,
// or 0 at the end), and an error that escapes it prints and exits 1, as the child did.
// The other scripts (board, prepare-track, gates, ...) still start as their own process: each is a separate program with
// its own exit handlers, signal handling and isMain check, and some run for a long time (the board server, gates).
if (file === path.join(HERE, 'queue.mjs')) {
  process.argv = [process.execPath, file, ...args];
  await import('./queue.mjs');
} else {
  const r = spawnSync(process.execPath, [file, ...args], { stdio: 'inherit' });
  if (r.error) {
    console.error(`ravenseat: could not start ${path.basename(file)}: ${r.error.message}`);
    process.exit(1);
  }
  process.exit(r.status ?? 1);
}
