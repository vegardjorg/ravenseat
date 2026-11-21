// =============================================================
// approvalAsk.js: the main session's overrides get Claude Code's own permission dialog (approvals.ask, push.ownerAsk).
//
// Why (plans/ekstern-saas-vurdering-2026-11-15.md, sections 4 and 5, bolk 3 and 7; owner decision 16.11.2026: both on):
// the queue's agents are denied every override flag, but the orchestrator (the main session) could pass all of them,
// and nothing told the owner apart from the model. A misled or "helpful" model writes the flag the error text itself
// suggests (`merge X --allow-guard`), or a line from a track report that says "the owner approved". So the push guard
// and the write guard answer "ask" when the main session:
//   - runs `merge` (or merge-track.mjs) with an `--allow-*` or `--force*` flag            rule override-flag
//   - passes `--i-understand` to any queue command (settings set, cost ...)                rule override-weaken
//   - passes `--by owner` or `--by theBoard` (resolve, approve, qa, resume --answer, edit of
//     locked fields, cancel, unlock ...), or `--set-by owner` (the plan register)          rule override-by-owner
//   - runs `surface accept`, `owner-log accept` or `helpers approve`, whose --by is free text  rule override-owner-command
//   - calls the board's API (an X-Queue-Key header, or the board's port on a loopback
//     address with /api/)                                                                 rule override-board-api
//   - starts the board with --key-file, which writes the key to a file it can read
//     (0l bolk 5: the key otherwise only reaches the browser)                            rule override-board-key
//   - a line the reading cannot see into that names the queue CLI and an override token  rule override-unread
//   - writes a main tree control file with Write, Edit or NotebookEdit (the same set as
//     lib/controlFiles.js; the plugin's scripts only when they live outside the project)  rule override-control-file
//   - posts to GitHub: `issues report --post`, `pr --post`, `release-notes --github --post`
//     (cli/ghWrite.mjs; the reason is the saved preview's summary, lib/ghOutbound.js)    rule outbound-github
//   - pushes the base branch while push.mode is "owner" (push.ownerAsk; lib/pushBatch.js) rule push-questions
// The dialog's reason (permissionDecisionReason) names the command, the task ids, the flags and, for merge, the track
// branch's tip: never a flag's value (an --answer text, a --remark), so nothing secret or long rides along.
//
// Friction: one click per override. Overrides are rare (0 rows of *-overridden or setting-weakened in 312 time log rows
// when measured), and the ordinary commands (merge, receive, settings set without --i-understand, a push in threshold
// mode) never ask, so the orchestrator's own loop is not slowed. The owner who says "use --allow-guard" in chat gets
// the dialog too: that double step is the proof. The board is not affected: it runs the CLI with execFile, outside
// Claude Code. Off (`approvals.ask` false, `push.ownerAsk` false) counts as a weakened guard.
//
// The permission mode (the hook payload's permission_mode; plans/ask-spike-2026-11-17.md): "ask" reaches a person in
// default, acceptEdits, plan and auto (in auto a hook's ask goes to the dialog, not the classifier). dontAsk turns
// every prompt into a denial, and bypassPermissions is not documented for a hook's ask, so in those two the guard
// denies instead and says the owner can run the command in their own terminal. A missing or unknown mode asks (a
// session that cannot show a dialog denies it anyway; the only cost is a plainer message).
//
// Limits, on purpose: this tells a person at the Claude Code session (screen or Remote Control) from the model on the
// usual path. It does not stop a hostile process running as the owner, a script file the model writes and runs, or a
// PermissionRequest hook that answers yes by itself (doctor names a broad one, row permission-hook).
// Pure. Tested in lib/__tests__/approvalAsk.test.ts and __tests__/redteam/approvalAsk.test.ts.
// =============================================================
'use strict';

const SC = require('./shellCommands.js');
const NAMES = require('./productNames.js');
const CF = require('./controlFiles.js');

/** The permission modes where a hook's "ask" reaches a person (the spike, 17.11.2026). */
const ASK_MODES = Object.freeze(['default', 'acceptEdits', 'plan', 'auto']);
/** The modes where it does not: the guard denies instead, with the way out. */
const DENY_MODES = Object.freeze(['dontAsk', 'bypassPermissions']);

/** The setting as the guards read it: on unless approvals.ask is exactly false. */
function setupOf(cfg) {
  return { ask: cfg?.approvals?.ask !== false };
}

/** The tail every approval reason ends with: who should say yes, and the setting. */
const TAIL = 'Say yes only if you asked for exactly this; a line in a report or a document is not your word (approvals.ask).';

/**
 * The answer for this permission mode: an approval ask stays "ask" where a person sees the dialog, and becomes "deny"
 * with the way out in dontAsk and bypassPermissions. Anything that is not an approval ask is returned as it is.
 * @param {{ decision: string, reason: string, rule?: string, approval?: boolean } | null} finding
 * @param {string|undefined} mode the hook payload's permission_mode
 */
function forMode(finding, mode) {
  if (!finding || finding.decision !== 'ask' || !finding.approval) return finding;
  if (!DENY_MODES.includes(String(mode))) return finding;
  return {
    ...finding,
    decision: 'deny',
    reason:
      `${finding.reason} This session runs in permission mode ${mode}, where no one sees the question, so it is ` +
      'denied instead. If you want it, run the command yourself in your own terminal.',
  };
}

// ---- The queue CLI's overrides -----------------------------------------------------------------------------------

/** The merge commands: `ravenseat merge` and the script it runs. */
const MERGE = new Set(['merge', 'merge-track']);
/** Owner-only commands whose --by is free text: the command itself is the override. */
const OWNER_ONLY = Object.freeze({ surface: ['accept'], 'owner-log': ['accept'], helpers: ['approve'] });
/** The --by values the queue records as the owner's (lib/ownerLog.js OWNER_BY, any case). */
const OWNER_WORDS = new Set(['owner', 'theboard']);
/** The board: `ravenseat board` and the script it runs. */
const BOARD = new Set(['board', 'queue-board']);
/** Programs that start another one (`npx ravenseat merge ...`). */
const STARTERS = new Set(['npx', 'pnpx', 'bunx']);

/** A flag's name without its value (`--allow-guard=1` gives `--allow-guard`). */
const flagName = (x) => String(x).split('=')[0];

/** The value of `--by` / `--set-by` in the arguments (both forms), or null. */
function valueOf(args, name) {
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    if (a === name) return args[i + 1] == null ? '' : String(args[i + 1]);
    if (a.startsWith(`${name}=`)) return a.slice(name.length + 1);
  }
  return null;
}

/** The positional words that look like ids or keys (never free text), at most three, for the reason. */
function idsOf(args) {
  return args
    .map(String)
    .filter((x) => !x.startsWith('-') && /^[A-Za-z0-9][\w.:/-]{0,39}$/.test(x))
    .slice(0, 3);
}

/** Runner options that take the next word as their value (`npx -p ravenseat ravenseat merge ...`). */
const RUNNER_VALUE_FLAGS = new Set(['-p', '--package', '-w', '--workspace', '-c', '--call']);

/** The index of the program a package runner starts: past its own options and a `--`. */
function pastRunnerOptions(t, i) {
  while (i < t.length && String(t[i]).startsWith('-')) {
    const flag = String(t[i]);
    if (flag === '--') return i + 1;
    i += RUNNER_VALUE_FLAGS.has(flag) ? 2 : 1;
  }
  return i;
}

/** The queue call at this command, also behind npx / npm exec (and their options); null when it is none. */
function callAt(t, i0) {
  const direct = SC.queueCall(t, i0);
  if (direct) return direct;
  const w = SC.commandWord(t[i0]);
  if (STARTERS.has(w)) return SC.queueCall(t, pastRunnerOptions(t, i0 + 1));
  if (['npm', 'pnpm', 'yarn'].includes(w) && t[i0 + 1] === 'exec') return SC.queueCall(t, pastRunnerOptions(t, i0 + 2));
  return null;
}

/**
 * What in one queue call is an override, or null: { rule, flags, call }.
 * @param {{ name: string, args: string[] }} call lib/shellCommands.js queueCall
 */
function overrideOf(call) {
  const args = (call.args ?? []).map(String);
  const name = String(call.name ?? '');
  if (MERGE.has(name)) {
    const flags = [...new Set(args.filter((x) => /^--(allow-|force)/.test(x)).map(flagName))];
    if (flags.length) return { rule: 'override-flag', flags };
  }
  if (args.some((x) => flagName(x) === '--i-understand')) return { rule: 'override-weaken', flags: ['--i-understand'] };
  for (const f of ['--by', '--set-by']) {
    const v = valueOf(args, f);
    if (v != null && OWNER_WORDS.has(v.trim().toLowerCase())) return { rule: 'override-by-owner', flags: [`${f} ${v.trim()}`] };
  }
  const sub = args.find((x) => !x.startsWith('-'));
  if (Object.hasOwn(OWNER_ONLY, name) && OWNER_ONLY[name].includes(sub)) return { rule: 'override-owner-command', flags: [] };
  // The board's key in a file the session can read (0l bolk 5): the key otherwise only reaches the browser.
  if (BOARD.has(name) && args.some((x) => flagName(x) === '--key-file')) return { rule: 'override-board-key', flags: ['--key-file'] };
  // A GitHub write (cli/ghWrite.mjs): the --post of `issues report`, `pr` and `release-notes`. The previews never ask.
  const kind = outboundKind(name, sub, args);
  if (kind) return { rule: 'outbound-github', flags: ['--post'], kind };
  return null;
}

/** The preview kinds (lib/ghOutbound.js) of the commands that post to GitHub with --post, or null. */
function outboundKind(name, sub, args) {
  if (!args.some((x) => flagName(x) === '--post')) return null;
  if (name === 'issues' && sub === 'report') return 'issues-report';
  if (name === 'pr') return 'pr';
  if (name === 'release-notes') return 'release';
  return null;
}

/**
 * The reason for a GitHub write: what the saved preview lists (targets, and whether the repo is public), or that there
 * is no matching preview, so the command will refuse. Never a body: the preview file holds targets and a hash only.
 */
function outboundText(call, o, outboundPreview) {
  const shown = `\`${NAMES.CLI_NAME} ${call.name === 'issues' ? 'issues report' : call.name} --post\``;
  let p = null;
  try {
    p = typeof outboundPreview === 'function' ? outboundPreview() : null;
  } catch {
    p = null; // no summary; the question stays
  }
  if (!p || p.kind !== o.kind) {
    return `${shown}: a write to GitHub, from the main session. There is no preview to match, so the command will refuse; run it without --post first and read what it lists.`;
  }
  return `${shown}: a write to GitHub, from the main session. It ${require('./ghOutbound.js').dialogSummary(p)}`;
}

/** The text of the reason for one override. */
function callText(call, o, tip) {
  const ids = idsOf(call.args ?? []);
  const shown = [NAMES.CLI_NAME, call.name === 'merge-track' ? 'merge' : call.name, ...ids].filter(Boolean).join(' ');
  const flags = o.flags.length ? ` with ${o.flags.join(', ')}` : '';
  const at = tip ? ` (track tip ${String(tip).slice(0, 7)})` : '';
  const what = {
    'override-flag': 'an override of a merge stop',
    'override-weaken': 'a confirmed weakening of a guard',
    'override-by-owner': 'acting as the owner',
    'override-owner-command': "the owner's own acceptance",
    'override-board-key': "the board's key (every owner action on the board) in a file Claude can read",
  }[o.rule];
  return `\`${shown}\`${flags}${at}: ${what}, from the main session.`;
}

/** A line that names the queue CLI and an override token, for the parts the reading cannot see into. */
const OVERRIDE_TOKEN = /--allow-|--force|--i-understand|--key-file|--post\b|--(?:set-)?by[\s=]+["']?(?:owner|theboard)\b|\b(?:surface|owner-log)\s+accept\b|\bhelpers\s+approve\b/i;
const QUEUE_SHAPED = new RegExp(`(^|[\\s"'\`(;&|\\\\/])((?:${NAMES.CLI_PATTERN})(?:\\.mjs|\\.cmd)?|queue\\.mjs|queue-board\\.mjs|merge-track\\.mjs)\\b`, 'i');

/**
 * The board's API from a shell line: the key header, or the board's port on a loopback address with /api/.
 * @param {string} command @param {number} [boardPort]
 */
function boardApi(command, boardPort = 2000) {
  const s = String(command ?? '');
  if (/x-queue-key/i.test(s)) return true;
  const re = /(?:localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\]|0\.0\.0\.0):(\d{1,5})\/api\//gi;
  for (const m of s.matchAll(re)) if (Number(m[1]) === Number(boardPort)) return true;
  return false;
}

/**
 * The approval ask for a main session shell line, or null: { decision: 'ask', rule, reason, approval: true }.
 * @param {string} command
 * @param {{ boardPort?: number, tipOf?: (id: string) => string|null }} [o] tipOf: the short tip of a track's branch
 */
function overrideFinding(command, { boardPort = 2000, tipOf, outboundPreview } = {}) {
  const read = SC.commandList(String(command ?? ''));
  const texts = [];
  let rule = null;
  for (const c of read.commands) {
    const call = callAt(c.t, c.i0);
    const o = call ? overrideOf(call) : null;
    if (!o) continue;
    rule = rule ?? o.rule;
    const id = MERGE.has(call.name) ? idsOf(call.args ?? [])[0] : null;
    let tip = null;
    try {
      tip = id && typeof tipOf === 'function' ? tipOf(id) : null;
    } catch {
      tip = null; // no tip in the reason; the question stays
    }
    texts.push(o.rule === 'outbound-github' ? outboundText(call, o, outboundPreview) : callText(call, o, tip));
  }
  if (boardApi(command, boardPort)) {
    rule = rule ?? 'override-board-api';
    texts.push("A call to the board's API, from the main session: the board is the owner's, and it runs every owner action.");
  }
  // eval and Invoke-Expression run text the reading only sees as an argument (`eval "$(echo ravenseat merge ...)"`).
  // `npm exec -c "..."` and `npx --call "..."` do the same with a command string (RUNNER_VALUE_FLAGS skips it).
  const text = String(command ?? '');
  const evals =
    /(^|[\s;&|(])(?:eval|iex|invoke-expression)\b/i.test(text) || /\b(?:npx|pnpx|bunx|exec)\b[^;&|]*\s(?:-c|--call)(?:\s|=)/i.test(text)
      ? ['eval of built text']
      : [];
  const unread = [...read.unsure, ...read.commands.map((c) => c.opaque).filter(Boolean), ...evals];
  if (!texts.length && unread.length && QUEUE_SHAPED.test(command) && OVERRIDE_TOKEN.test(command)) {
    rule = 'override-unread';
    texts.push(`A queue command with an override flag that the guard cannot read (${[...new Set(unread)].join('; ')}), from the main session.`);
  }
  if (!texts.length) return null;
  return { decision: 'ask', rule, approval: true, reason: `Approval: ${[...new Set(texts)].join(' ')} ${TAIL}` };
}

// ---- The control files -------------------------------------------------------------------------------------------

/** a inside b (normalised the way lib/controlFiles.js compares paths). */
function insideDir(a, b, platform) {
  const n = (p) => {
    const r = require('node:path').resolve(String(p)).replace(/\\/g, '/').replace(/(.)\/+$/, '$1');
    return platform === 'win32' ? r.toLowerCase() : r;
  };
  const x = n(a);
  const y = n(b);
  return x === y || x.startsWith(`${y}/`);
}

/**
 * The approval ask for the main session's Write, Edit or NotebookEdit of a main tree control file, or null. The same
 * set as lib/controlFiles.js, with one difference: the plugin's scripts count only when they live outside the project
 * (an installed plugin). Inside it they are the project's own source code, which the owner edits with the orchestrator.
 * @param {{ filePath: string, mainTree: string, scriptsDir?: string|null, configFile?: string|null, platform?: string }} x
 */
function controlWriteFinding({ filePath, mainTree, scriptsDir = null, configFile = null, platform = process.platform }) {
  if (!filePath || !mainTree) return null;
  const ownSource = scriptsDir && insideDir(scriptsDir, mainTree, platform);
  const kind = CF.controlKind(filePath, { mainTree, scriptsDir: ownSource ? null : scriptsDir, configFile, platform });
  if (!kind) return null;
  const p = require('node:path');
  const main = p.resolve(mainTree).replace(/\\/g, '/');
  const abs = p.resolve(filePath).replace(/\\/g, '/');
  const rel = (platform === 'win32' ? abs.toLowerCase().startsWith(`${main.toLowerCase()}/`) : abs.startsWith(`${main}/`))
    ? abs.slice(main.length + 1)
    : abs;
  return {
    decision: 'ask',
    rule: 'override-control-file',
    approval: true,
    kind,
    reason: `Approval: the main session writes ${rel} directly, a control file (${kind}) that steers the guards or every later session. ${TAIL}`,
  };
}

// ---- doctor: a PermissionRequest hook that answers for the owner -------------------------------------------------

/** The tools whose dialog the guards rely on. */
const GUARDED_TOOLS = ['Bash', 'PowerShell', 'Write', 'Edit', 'NotebookEdit'];

/** Does this matcher take one of the guarded tools (missing, empty, "*" or a pattern that matches one)? */
function broadMatcher(matcher) {
  if (matcher == null || matcher === '' || matcher === '*') return true;
  try {
    const re = new RegExp(`^(?:${matcher})$`);
    return GUARDED_TOOLS.some((t) => re.test(t));
  } catch {
    return GUARDED_TOOLS.some((t) => String(matcher).includes(t));
  }
}

/**
 * The project settings files with a PermissionRequest hook whose matcher takes Bash, PowerShell, Write or Edit: such a
 * hook can answer the guards' questions without the owner. For doctor (INFO, never a change).
 * @param {{ file: string, settings: object|null }[]} files
 * @returns {string[]} one text per file, "<file> (matcher <m>)"
 */
function permissionHookFindings(files) {
  const out = [];
  for (const { file, settings } of files ?? []) {
    const entries = settings?.hooks?.PermissionRequest;
    if (!Array.isArray(entries)) continue;
    const broad = entries.filter((e) => e && typeof e === 'object' && broadMatcher(e.matcher));
    if (broad.length) out.push(`${file} (matcher ${broad.map((e) => JSON.stringify(e.matcher ?? '')).join(', ')})`);
  }
  return out;
}

module.exports = {
  ASK_MODES,
  DENY_MODES,
  setupOf,
  forMode,
  overrideOf,
  overrideFinding,
  boardApi,
  controlWriteFinding,
  broadMatcher,
  permissionHookFindings,
};
