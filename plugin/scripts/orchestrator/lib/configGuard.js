// =============================================================
// configGuard.js: what the push guard answers when queue.config.json exists but cannot be read or parsed (H3 in
// plans/review-2026-11-02.md).
//
// WHY: a parse error used to give the defaults in silence (a hook's stderr is not shown at exit 0). With the defaults
// the base branch is "main", migrations are off (the environment guard for a migration push is gone), the gate lists
// are empty and deployCommands is []: a push to production, a migration push or a deploy would go through unasked.
// The guard cannot know the project's own rules while the file is broken, so it fails CLOSED for the dangerous verbs
// only, and normal work (edits, tests, builds, git status) goes on:
//   - a push, migration or deploy shaped command: "ask" in the main session (the owner sees the reason and decides),
//     "deny" for the queue's agents (a track has no business pushing or deploying while the config is unreadable);
//   - anything else: no answer (null), so the other rules are not run on defaults that are not the project's.
// The shapes are deliberately broad (a false "ask" costs one click; a missed prod push costs much more). The deploy
// and migration commands the broken file names are still picked out of its raw text when they can be (best effort),
// so a project's own "npm run release" is caught too.
//
// Pure apart from commandsFromFile (one small file read). Used by: hook-push-guard.mjs, through answerForHook.
// Tested in: lib/__tests__/configUnreadable.test.ts.
// =============================================================

const fs = require('node:fs');

/** Split a command into segments on ; && || | & newlines and the openers of subshells (good enough for a guard). */
function segments(command) {
  return String(command || '')
    .split(/\r?\n|&&|\|\||;|\||&|\$\(|`|\(|\)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The built-in shapes: [kind, regular expression on one segment]. */
const SHAPES = Object.freeze([
  // git with any global options (-C <dir>, -c k=v, --no-pager ...), then push; or an alias defined as push on the line.
  ['push', /(^|[\s"'\\/])git(\.exe)?(\s+(-C|-c|--git-dir|--work-tree)\s+\S+|\s+-\S+)*\s+push\b|\balias\.[^=\s]+=!?\s*push\b/i],
  ['migration', /\bmigrate\b|\bmigration\s+(up|apply|run|deploy|repair)\b|\bdb\s*:?\s*(push|reset|deploy|migrate|upgrade)\b|\balembic\s+(upgrade|downgrade)\b|\b(flyway|liquibase)\b/i],
  ['deploy', /\bdeploy\b|\bvercel\b[^]*--prod\b|\b(terraform|tofu)\s+(apply|destroy)\b|\bkubectl\s+(apply|delete|rollout)\b|\bhelm\s+(install|upgrade|uninstall)\b|\bpulumi\s+(up|destroy)\b|\beas\s+(submit|update)\b|\b(npm|pnpm|yarn)\s+publish\b/i],
]);

/**
 * The deploy and migration commands named in the raw text of a broken config, best effort: the strings in a
 * "deployCommands": [ ... ] list and the "pushCommand": "..." value. Invalid JSON elsewhere does not matter.
 * @param {string} text
 * @returns {string[]}
 */
function commandsFromText(text) {
  const s = String(text || '');
  const out = [];
  const list = /"deployCommands"\s*:\s*\[([^\]]*)\]/.exec(s);
  if (list) for (const m of list[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)) out.push(m[1]);
  const push = /"pushCommand"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(s);
  if (push) out.push(push[1]);
  return out.map((c) => c.trim()).filter(Boolean);
}

/** commandsFromText on the file; [] when it cannot be read. */
function commandsFromFile(file) {
  try {
    return commandsFromText(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}

/** The core words of a configured command ("npx supabase db push" -> "supabase db push"), for a plain includes. */
function coreOf(command) {
  return String(command || '')
    .trim()
    .split(/\s+/)
    .filter((w) => !['npx', 'exec', 'pnpm', 'yarn'].includes(w))
    .join(' ');
}

/**
 * Which dangerous kind is the command, or null? push, migration or deploy (built-in shapes), or "configured" (one of
 * `extraCommands`, found in the broken file).
 * @param {string} command
 * @param {string[]} [extraCommands]
 */
function dangerousKind(command, extraCommands = []) {
  for (const seg of segments(command)) {
    for (const [kind, re] of SHAPES) if (re.test(seg)) return kind;
  }
  const whole = String(command || '');
  for (const c of extraCommands) {
    const core = coreOf(c);
    if (core && whole.includes(core)) return 'configured';
  }
  return null;
}

/** "file:line:column" when the position is known, otherwise the file. */
function where(error) {
  if (!error) return 'queue.config.json';
  return error.line ? `${error.file}:${error.line}${error.column ? `:${error.column}` : ''}` : error.file;
}

/**
 * The answer while the config is unreadable: { decision: 'ask'|'deny', reason } for a dangerous command, else null.
 * @param {string} command
 * @param {{ error: { file: string, line?: number|null, column?: number|null } | null, guarded?: boolean,
 *           extraCommands?: string[] }} o  guarded = a queue agent (lib/pushGuard.js isGuardedAgent)
 */
function assessUnreadableConfig(command, o = {}) {
  if (!o.error) return null;
  const kind = dangerousKind(command, o.extraCommands ?? []);
  if (!kind) return null;
  const what = kind === 'configured' ? 'a deploy or migration command' : `a ${kind} command`;
  const reason =
    `config unreadable: queue.config.json does not parse (${where(o.error)}), so the project's base branch, ` +
    `migration guard and deploy commands are unknown and this is ${what}. Fix the file (ravenseat doctor shows the error)` +
    (o.guarded ? '; a queue agent may not run it until then.' : ', or confirm only if you are sure this is safe.');
  return { decision: o.guarded ? 'deny' : 'ask', reason };
}

/**
 * The one call the push guard hook makes. Wiring in hook-push-guard.mjs (right after `const k = config()`):
 *   if (k.configError) {
 *     const types = agentType ? require('./lib/trackGuard.js').queueAgentTypes() : new Set();
 *     const answer = require('./lib/configGuard.js').answerForHook(command, k.configError, isGuardedAgent(agentType, types));
 *     if (answer) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse',
 *       permissionDecision: answer.decision, permissionDecisionReason: `push-guard: ${answer.reason}` } }));
 *     process.exit(0); // never run the other rules on defaults that are not the project's
 *   }
 * @param {string} command
 * @param {{ file: string, line?: number|null, column?: number|null }} error  config().configError
 * @param {boolean} guarded
 */
function answerForHook(command, error, guarded) {
  return assessUnreadableConfig(command, { error, guarded, extraCommands: commandsFromFile(error?.file) });
}

module.exports = { segments, commandsFromText, dangerousKind, assessUnreadableConfig, answerForHook };
