// =============================================================
// productNames.js: the one place that knows what this product's commands and plugin are called.
//
// WHY: the guards recognise the queue's own CLI and agents by name. A name they do not know is a hole: an agent could run
// `<new name> merge X-1` straight past the push guard. So every guard asks this file, and a test
// (lib/__tests__/productNames.test.ts) fails when plugin/bin/ or plugin.json holds a name that is not listed here.
//
// No dependencies: the hooks load this first.
// =============================================================
'use strict';

/** The name of the command today (plugin/bin/<name>). */
const CLI_NAME = 'ravenseat';
/** The name in plugin.json: the prefix of the skills (/<name>:queue) and agents (<name>:track). */
const PLUGIN_NAME = 'ravenseat';
/** Every name the CLI answers to. Guards recognise all of them. */
const CLI_NAMES = [CLI_NAME];
/** Every name the plugin goes by. */
const PLUGIN_NAMES = [PLUGIN_NAME];

/** For regexes: the CLI names as alternatives. */
const CLI_PATTERN = CLI_NAMES.join('|');

/** Is this word the queue's own CLI? Takes a command word without folder and .cmd (shellCommands.js commandWord). */
const isCliName = (word) => CLI_NAMES.includes(word);

/** The bare agent name from a hook payload or the time log: "<plugin>:track" -> "track". Other prefixes stay. */
function bareAgentType(type) {
  if (typeof type !== 'string') return type;
  const hit = PLUGIN_NAMES.find((n) => type.startsWith(`${n}:`));
  return hit ? type.slice(hit.length + 1) : type;
}

module.exports = { CLI_NAME, PLUGIN_NAME, CLI_NAMES, PLUGIN_NAMES, CLI_PATTERN, isCliName, bareAgentType };
