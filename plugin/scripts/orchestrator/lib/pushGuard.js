// =============================================================
// pushGuard.js: pure logic for the PreToolUse hook hook-push-guard.mjs.
//
// WHY: a few commands are expensive or irreversible (push that rewrites shared history, push to the wrong branch,
// migrations against the wrong environment). A hook sees the command BEFORE it runs and can stop it with a reason,
// instead of the rule only living as text the agents can forget. Normal work is not blocked.
//
// Decisions (Claude Code PreToolUse: allow | ask | deny):
//   deny  forced push (--force, -f, --force-with-lease, +ref): shared history is never rewritten.
//   ask   the same on branches in push.allowBranches only, from the main session: the owner's own branch, their call.
//   deny  `git push` to a branch other than baseBranch (config().baseBranch), and --all/--mirror. Tracks are merged
//         locally; only baseBranch is pushed (in batches).
//   ask   `git push` where the branch cannot be determined (detached HEAD).
//   deny  the migration command (config().migrations.pushCommand) when the environment file (migrations.environmentFile)
//         exists and its contents are not in migrations.allowedEnvironment. If the file is missing, the guard has no say.
// Push to baseBranch is let through, with one question: the batch threshold (config().push, lib/pushBatch.js).
//   ask   a plain (non-force) `git push` of baseBranch by the orchestrator (the main session, no agent_type) when the
//         base is red at the tip, or when fewer than push.minTasks merged tasks are unpushed (and push.maxAgeHours does
//         not make the batch ready). Both push modes: in "owner" mode the owner is the one pushing, and a reminder
//         dialog is cheap. push.minTasks 0 turns the count question off (the red-base question stays). Never deny: the
//         owner can always push. The counting needs git, so the hook passes it in as context.batchQuestion (called only
//         when such a push is found, so every other command costs nothing extra).
//   ask   the same plain push of baseBranch by the orchestrator when the secret precheck (lib/secretScan.js, config
//         secretScan) finds a possible secret in what the push sends: the question names file:line, never the value.
//         The hook passes it in as context.secretQuestion; with the batch question both are asked in one dialog.
//   ask   a command that starts with one of config().deployCommands (after env prefixes), from an agent or the main
//         session: a deploy is a deliberate step. A simple prefix match; empty list = off.
//
// Network guard for the queue's agents (hardening against prompt injection). Applies to every subagent, that is when the
// hook payload has an agent_type (owner decision B3, lib/agentGuard.js): the queue's own types (track, track-d, the
// reviewer and helper agents, builtin or custom: trackGuard.js queueAgentTypes(), also with the plugin prefix,
// "ravenseat:track") always, and any other type (general-purpose, Explore, a user's own) unless agentGuard.except names
// it or agentGuard.enabled is false. None of them needs the network. The orchestrator (the main session, the field is
// missing) and the owner are not affected:
//   deny  curl, wget, Invoke-WebRequest/iwr, Invoke-RestMethod/irm, Start-BitsTransfer as a command (also inside
//         `powershell -c "…"`, `bash -c "…"`, `$(…)`, `eval` and runners such as `wsl` and `timeout`: the line is read with
//         shellCommands.js, as for the push guard), a pipe into a shell (`| sh`, `| bash`, `| iex` …), and a
//         variable as the command word with an address after it.
//   deny  npm/pnpm/yarn/bun install, ci, add, update, rebuild, uninstall and the like, and deleting node_modules:
//         node_modules in a worktree is a link into the main tree, so it would change the main tree and every track.
//   ask   npx/npm exec with a package name that is not in package.json (and not in node_modules/.bin): it fetches and
//         runs code from the network.
//   The reason points the way: "Network calls are blocked for queue agents; ask the orchestrator to fetch it."
//   Known gaps (on purpose, lightweight): `node -e "fetch(…)"`, `git clone`, .NET classes in PowerShell. The guard is
//   an extra layer; the merge guard (mergeGuard.js) and "data, not instructions" in the agent definitions are the others.
//
// assess() is pure: takes the command and the context (current branch, the contents of the environment file, the
// agent type, the known packages) and does no I/O. Base branch and migration setup come from config() only when the
// context does not give them.
// =============================================================

const fs = require('node:fs');
const path = require('node:path');

const SC = require('./shellCommands.js');
const NAMES = require('./productNames.js');
const { tokens, segments, commandWord, firstWordIndex } = SC;

/** Does the name match a push.allowBranches pattern? "*" is any text, also a slash. Exact otherwise. */
function allowedBranch(name, patterns) {
  return (Array.isArray(patterns) ? patterns : []).some((p) => {
    if (typeof p !== 'string' || !p) return false;
    const r = p.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
    return new RegExp(`^${r}$`).test(name);
  });
}

/**
 * Which branches does a `git push` with these arguments match?
 * Returns { template: [branch], force, all, tags, deletes: [branch] } (all = --all/--mirror, i.e. all branches; tags =
 * --tags/--follow-tags, whatever else is named; deletes = the remote branches the push deletes: `--delete`/`-d`, or a
 * refspec with an empty source, `:branch`).
 */
function pushTemplate(args, currentBranch) {
  let force = false;
  let all = false;
  let del = false;
  let tags = false;
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--force' || a === '-f' || a.startsWith('--force-with-lease')) force = true;
    else if (a === '--all' || a === '--mirror' || a === '--branches') all = true;
    else if (a === '--delete') del = true;
    else if (a === '--tags' || a === '--follow-tags') tags = true;
    else if (a === '-o' || a === '--push-option' || a === '--repo' || a === '--receive-pack' || a === '--exec') i++;
    else if (/^-[a-zA-Z]+$/.test(a)) {
      // short flags, also combined (-uf, -fd)
      if (a.includes('f')) force = true;
      if (a.includes('d')) del = true;
    } else if (!a.startsWith('-')) pos.push(a);
  }
  const refspecs = pos.slice(1); // first positional is the remote
  if (all) return { template: [], force, all, tags, deletes: [] };
  if (refspecs.length === 0)
    return { template: currentBranch ? [currentBranch] : ['<unknown>'], force, all, tags, deletes: [] };
  const deletes = [];
  const template = refspecs.map((r) => {
    let x = r;
    if (x.startsWith('+')) {
      force = true;
      x = x.slice(1);
    }
    const dst = x.includes(':') ? x.split(':').pop() : x;
    const name = dst.replace(/^refs\/heads\//, '');
    const branch = name === 'HEAD' || name === '' ? currentBranch || '<unknown>' : name;
    if (del || (x.startsWith(':') && name)) deletes.push(branch);
    return branch;
  });
  return { template, force, all, tags, deletes };
}

/** The usual tools' commands that change a database. A queue agent writes the migration; it does not run it. */
const MIGRATION_COMMANDS = [
  'supabase db push',
  'supabase db reset',
  'supabase migration up',
  'prisma migrate',
  'prisma db push',
  'drizzle-kit push',
  'drizzle-kit migrate',
  'knex migrate:latest',
  'db:migrate', // npm run, rails, rake, sequelize
  'manage.py migrate',
  'alembic upgrade',
  'flyway migrate',
  'dbmate up',
  'dbmate migrate',
];
/** Commands that only name a migration command in their text (git commit, grep db:migrate): never a run of one. */
const ONLY_MENTIONS = new Set(['git', 'grep', 'rg', 'echo', 'cat', 'ls', ...NAMES.CLI_NAMES]);

/** Programs that only start another program (npx foo, npm exec foo): skipped when commands are compared. */
const STARTERS = new Set(['npx', 'pnpx', 'bunx', 'exec', 'env', 'command', 'npm', 'pnpm', 'yarn']);

/**
 * The core of a command: the words that are not options, without starters and env prefixes in front.
 * "npx dbTool migrate push --yes" gives ['dbTool', 'migrate', 'push'].
 */
function core(t) {
  const out = [];
  for (const x of t) {
    if (x.startsWith('-')) continue;
    if (out.length === 0 && (STARTERS.has(x) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(x))) continue;
    out.push(x.replace(/\.(exe|cmd)$/i, '').replace(/^.*[\\/]/, ''));
  }
  return out;
}

/** Is `candidate` (token list) a run of `command` (text)? The core words must be contiguous. */
function isCommand(candidate, command) {
  const k = core(tokens(String(command || '')));
  if (k.length === 0) return false;
  const c = core(candidate);
  for (let i = 0; i + k.length <= c.length; i++) {
    if (k.every((word, j) => c[i + j] === word)) return true;
  }
  return false;
}

/** The migration command this run is, or null: the configured one or a usual tool's. */
function migrationMatch(t, migrations) {
  if (ONLY_MENTIONS.has(core(t)[0])) return null;
  return [migrations?.pushCommand, ...MIGRATION_COMMANDS].find((m) => m && isCommand(t, m)) ?? null;
}

/** The config values the guard needs, from the context or (by default) from config(). */
function values(context) {
  let k = null;
  const get = () => {
    if (!k) k = require('./queueConfig.js').config();
    return k;
  };
  const baseBranch = context.baseBranch ?? get().baseBranch;
  const migrations = context.migrations ?? get().migrations ?? {};
  const deployCommands = context.deployCommands ?? get().deployCommands ?? [];
  return { baseBranch, migrations, deployCommands: Array.isArray(deployCommands) ? deployCommands : [] };
}

/** Words joined by single spaces, without env prefixes (FOO=bar) and "command"/"exec"/"env" in front. */
function plainCommand(t) {
  let i = 0;
  while (i < t.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t[i]) || ['command', 'exec', 'env'].includes(t[i]))) i++;
  return t.slice(i).join(' ');
}

/** The deploy command this chunk starts with (a whole-word prefix match), or null. */
function deployMatch(t, deployCommands) {
  const line = plainCommand(t);
  for (const d of deployCommands) {
    const want = tokens(String(d || '')).join(' ');
    if (want && (line === want || line.startsWith(`${want} `))) return want;
  }
  return null;
}

// ---- Network guard for the queue's agents ---------------------------------------------------------------------------

/** The track agent types (the hook payload's agent_type, without a plugin prefix). Always network guarded. */
const TRACK_AGENT_TYPES = new Set(['track', 'track-d']);
/** The agent type without a plugin prefix ("ravenseat:reviewer" -> "reviewer"). */
const bare = (agentType) => String(agentType || '').replace(/^.*:/, '');
const isTrackAgent = (agentType) => TRACK_AGENT_TYPES.has(bare(agentType));

/**
 * Is this agent guarded (network, push, queue CLI, migrations; owner decision B3, lib/agentGuard.js)? Every non-empty
 * agent_type is, by default: tracks, the reviewer and helper agents (builtin and custom, the same list the read guard
 * uses, trackGuard.js queueAgentTypes()) and any other subagent (general-purpose, Explore, a user's own). The setting
 * agentGuard (queue.config.json) can take types outside the queue's own out (except, or enabled: false); the queue's own
 * types are always guarded. The main session (the orchestrator) has no agent_type and is never guarded; a main session
 * started with --agent has no agent_id, which the hook passes as policy.subagent false.
 * @param {string|null|undefined} agentType  the hook payload's agent_type
 * @param {Set<string>} [types]  the queue's own types beyond track/track-d; default queueAgentTypes() (reads the config)
 * @param {{ enabled?: boolean, except?: string[], subagent?: boolean }} [policy]  default: every subagent is guarded
 */
function isGuardedAgent(agentType, types, policy) {
  const t = bare(agentType);
  if (!t) return false;
  if (TRACK_AGENT_TYPES.has(t)) return true;
  let set = types;
  if (!set) {
    try {
      set = require('./trackGuard.js').queueAgentTypes();
    } catch {
      set = new Set(); // the policy below still guards every other subagent
    }
  }
  const AG = require('./agentGuard.js');
  return AG.isGuarded(agentType, { queueTypes: set, policy: policy ?? AG.DEFAULTS, subagent: policy?.subagent });
}

const NETWORK_REASON = 'Network calls are blocked for queue agents; ask the orchestrator to fetch it.';
/** Command words (lower case, without path and .exe) that fetch from or send to the network. */
const NETWORK_COMMANDS = new Set([
  'curl',
  'wget',
  'invoke-webrequest',
  'iwr',
  'invoke-restmethod',
  'irm',
  'start-bitstransfer',
]);

/** The name in an npm package spec: "@scope/name@1.2" gives "@scope/name", "name@^1" gives "name". null = path/URL/git. */
function packageName(spec) {
  const s = String(spec || '');
  if (!s || /^(\.|\/|~|[A-Za-z]:[\\/])/.test(s) || /:/.test(s) || /\.(tgz|tar\.gz)$/.test(s)) return null;
  if (s.startsWith('@')) {
    const m = s.match(/^(@[^/@\s]+\/[^@\s]+)/);
    return m ? m[1] : null;
  }
  if (s.includes('/')) return null; // GitHub short form (user/repo)
  return s.split('@')[0] || null;
}

/** The packages npx fetches: -p/--package <pkg>, otherwise the first positional argument (the command). */
function npxPackages(args) {
  const out = [];
  let first = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      if (!first && args[i + 1]) first = args[i + 1];
      break;
    }
    if (a === '-p' || a === '--package') {
      if (args[i + 1]) out.push(args[i + 1]);
      i++;
    } else if (a.startsWith('--package=')) out.push(a.slice('--package='.length));
    else if (a.startsWith('-')) continue;
    else {
      first = a;
      break;
    }
  }
  // With -p the positional one is a bin name in the package, not a new package.
  if (out.length === 0 && first) out.push(first);
  return out;
}

/** The packages an npm install/npx command will fetch that are not known. */
function unknownPackages(t, i0, knownPackage) {
  const word = commandWord(t[i0]);
  const rest = t.slice(i0 + 1);
  const specs = [];
  if (word === 'npm' || word === 'pnpm' || word === 'yarn') {
    const sub = rest.find((x) => !x.startsWith('-'));
    const after = rest.slice(rest.indexOf(sub) + 1);
    if (['install', 'i', 'add', 'in', 'isntall'].includes(sub)) {
      for (const x of after) if (!x.startsWith('-')) specs.push(x);
    } else if (sub === 'exec' || sub === 'dlx' || (word === 'pnpm' && sub === 'x')) {
      specs.push(...npxPackages(after));
    } else return [];
  } else if (word === 'npx' || word === 'bunx' || word === 'pnpx') {
    specs.push(...npxPackages(rest));
  } else return [];
  const known = typeof knownPackage === 'function' ? knownPackage : () => false;
  return specs.filter((x) => {
    const name = packageName(x);
    return !name || !known(name);
  });
}

/** npm, pnpm, yarn and bun subcommands that write node_modules (install, remove, rebuild, relink). */
const NODE_MODULES_WRITERS = new Set([
  'install', 'i', 'in', 'isntall', 'add', 'a', 'ci', 'clean-install', 'install-clean', 'update', 'up', 'upgrade',
  'rebuild', 'rb', 'uninstall', 'remove', 'rm', 'r', 'un', 'unlink', 'prune', 'dedupe', 'ddp', 'link', 'ln', 'import',
]);
const NODE_MODULES_REASON =
  'node_modules in a worktree is a link into the main tree, so this changes the main tree and every other track. ' +
  'Change package.json and say in the report that the orchestrator must install; queue agents never install.';
/** Programs that delete files. */
const REMOVERS = new Set(['rm', 'rmdir', 'remove-item', 'ri', 'del', 'erase', 'rd', 'unlink']);
const inNodeModules = (x) => /(^|[\\/])node_modules([\\/]|$)/i.test(String(x).replace(/^['"]|['"]$/g, ''));

/** Does this simple command write through the node_modules link? (yarn with no subcommand installs.) */
function writesNodeModules(t, i0) {
  const word = commandWord(t[i0]);
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(word)) {
    const sub = t.slice(i0 + 1).find((x) => !x.startsWith('-'));
    if (sub == null) return word === 'yarn';
    return NODE_MODULES_WRITERS.has(String(sub).toLowerCase());
  }
  if (REMOVERS.has(word)) return t.slice(i0 + 1).some((x) => !x.startsWith('-') && inNodeModules(x));
  return false;
}

/** Words that suggest a network call, for a line the reading could not see all of. */
const NETWORK_SHAPED = /curl|wget|invoke-(webrequest|restmethod)|\biwr\b|\birm\b|https?:\/\//i;

/**
 * Assess the network guard for one command (called only for guarded agents, isGuardedAgent). Returns a list of findings.
 * Reads the line with SC.commandList, the same reading the push guard uses, so runners (`wsl`, `timeout`), eval, `$( )`
 * and nested shells are followed here too. Also stops writes through the node_modules link.
 */
function assessNetwork(command, context) {
  const findings = [];
  const read = SC.commandList(command);
  if (read.unsure.length && NETWORK_SHAPED.test(command))
    findings.push({
      decision: 'deny',
      reason: `The guard cannot read this command (${read.unsure.join('; ')}) and it looks like a network call. ${NETWORK_REASON}`,
    });
  for (const c of read.commands) {
    const { t, i0, word } = c;
    if (NETWORK_COMMANDS.has(word)) {
      findings.push({ decision: 'deny', reason: `\`${t[i0]}\`: ${NETWORK_REASON}` });
      continue;
    }
    if (c.opaque) {
      // A pipe into a shell or eval, and an encoded PowerShell command, run text the guard cannot see.
      if (/pipe into a shell|encoded PowerShell|reads the pipe/.test(c.opaque))
        findings.push({ decision: 'deny', reason: `It runs text as code (${c.opaque}). ${NETWORK_REASON}` });
      // A variable as the command word with an address after it: the program is not known, the address is.
      else if (/^[$@]/.test(t[i0]) && t.slice(i0 + 1).some((x) => /^['"]?[a-z][a-z0-9+.-]*:\/\//i.test(x)))
        findings.push({ decision: 'deny', reason: `${c.opaque}, with an address after it. ${NETWORK_REASON}` });
      continue;
    }
    if (writesNodeModules(t, i0)) {
      findings.push({ decision: 'deny', reason: `\`${t.slice(i0, i0 + 2).join(' ')}\`: ${NODE_MODULES_REASON}` });
      continue;
    }
    const unknown = unknownPackages(t, i0, context.knownPackage);
    if (unknown.length > 0) {
      findings.push({
        decision: 'ask',
        reason: `\`${t[i0]}\` fetches a package that is not in package.json (${unknown.join(', ')}). ${NETWORK_REASON}`,
      });
    }
  }
  return findings;
}

// ---- Push and queue CLI rules for the queue's agents (H1, H2) -------------------------------------------------------

/**
 * The program-valued key (lib/gitExecSurface.js isExecKey) a `git config` call changes, or null. Reading forms
 * (--get, --get-all, --get-regexp, --get-urlmatch, -l, --list, `get`, `list`) change nothing; any other form that names
 * such a key (set, --add, --replace-all, --unset, `set`, `unset`) counts (review 2026-11-11, S5).
 * @param {string[]} args the arguments after `config`
 */
function configSetsExecKey(args) {
  const { isExecKey } = require('./gitExecSurface.js');
  const a = args.map((x) => String(x));
  const first = a.find((x) => !x.startsWith('-')) ?? '';
  if (a.some((x) => /^(--get(-all|-regexp|-urlmatch)?|-l|--list)$/i.test(x)) || /^(get|list)$/i.test(first)) return null;
  return a.find((x) => !x.startsWith('-') && x.includes('.') && isExecKey(x.split('=')[0])) ?? null;
}

const AGENT_PUSH_REASON =
  'Queue agents never push (any remote, branch, refspec or form): the orchestrator merges your branch and pushes the ' +
  'base in batches. Commit on your own branch and deliver.';

/**
 * The queue commands a queue agent may run (an allow-list; everything else is denied for them). What tracks and the
 * review and helper agents legitimately need (agents/*.md, docs/mission-template.md): the setup and the gates, the
 * read-only views, and the few writes that report upwards (a finding, an owner question, a blocker, deliver). A list
 * value limits the command to those sub-words (`ravenseat plan show|get`). `add` has its own rule (agentAddReason).
 */
const AGENT_QUEUE_COMMANDS = Object.freeze({
  'prepare-track': true,
  gates: true,
  help: true,
  '': true, // bare `ravenseat`: the help
  show: true,
  info: true,
  blockers: true,
  finding: true,
  question: true,
  block: true,
  deliver: true,
  plan: ['show', 'get'],
});
/** For the reasons: the allowed commands as text. */
const AGENT_QUEUE_LIST = 'prepare-track, gates, show, info, help, blockers, finding, question, block, deliver, plan show|get, add (on its own, from your own track branch, with no cd)';

/**
 * The deny reason for a queue agent's ravenseat add, or null. It is only allowed from the agent's own track branch, because
 * there the CLI makes it a proposal and sets added_by from the branch (cli/tasks.mjs). Anywhere else the CLI would take it
 * for the orchestrator's, and the task would be ready to start with no owner having seen it. So: never --approved, a queue
 * branch where the command runs, and nothing in the line that moves it somewhere else.
 */
function agentAddReason(call, { branch, branchPrefix, moved }) {
  if (call.args.some((x) => x === '--approved' || x.startsWith('--approved=')))
    return '`ravenseat add --approved` is for the orchestrator and the owner. Without it your task becomes a proposal the owner approves.';
  if (moved)
    return '`ravenseat add` must run in your worktree as it is, with no cd or QUEUE_ variable in the same command: that is how the queue knows which track added it. Run it on its own.';
  if (!branch || !branchPrefix || !branch.startsWith(branchPrefix) || branch === branchPrefix)
    return `\`ravenseat add\` is only for a track, from its own branch (${branchPrefix ?? 'the queue prefix'}<id>). Elsewhere put it in your report or use ravenseat finding.`;
  return null;
}

/** The deny reason for a queue agent's call of the queue CLI, or null (allowed). */
function agentQueueReason(call, where = {}) {
  const name = String(call.name);
  const shown = name ? `${NAMES.CLI_NAME} ${name}` : NAMES.CLI_NAME;
  const flag = call.args.find((x) => x === '--allow-guard' || /^--force/.test(x));
  if (flag)
    return `\`${flag}\` is the orchestrator's and the owner's override; a queue agent never passes it (\`${shown}\`).`;
  const by = call.args.findIndex((x) => x === '--by' || x.startsWith('--by='));
  if (by >= 0) {
    const who = call.args[by].startsWith('--by=') ? call.args[by].slice(5) : call.args[by + 1];
    if (['owner', 'theboard'].includes(String(who ?? '').trim().toLowerCase()))
      return `A queue agent never acts as the owner (\`--by ${who}\`); ask the owner with ravenseat question.`;
  }
  if (name === 'add') return agentAddReason(call, where);
  const rule = Object.hasOwn(AGENT_QUEUE_COMMANDS, name) ? AGENT_QUEUE_COMMANDS[name] : false;
  if (rule === true) return null;
  if (Array.isArray(rule)) {
    const sub = call.args.find((x) => !x.startsWith('-'));
    if (rule.includes(sub)) return null;
    return `\`${shown} ${sub ?? ''}\`: a queue agent only reads here (\`${shown} ${rule.join('|')}\`).`;
  }
  return (
    `\`${shown}\` is not for queue agents: merging, status changes, edits, approvals, answers and undo belong to the ` +
    `orchestrator and the owner. Allowed: ${AGENT_QUEUE_LIST}. Put what you need in track-result.md or ask with ravenseat question.`
  );
}

/** Does the command line look like a push (git and the word push / send-pack)? Used when it cannot be read. */
const pushShaped = (command) => /git/i.test(command) && /\bpush\b|send-pack/i.test(command);
/** Does the command line mention the queue CLI? Used when it cannot be read (queue agents only). */
const QUEUE_SHAPED = new RegExp(
  `(^|[\\s"'\`(;&|\\\\/])((?:${NAMES.CLI_PATTERN})(?:\\.mjs|\\.cmd)?|queue\\.mjs|merge-track\\.mjs)\\b`,
  'i',
);
const queueShaped = (command) => QUEUE_SHAPED.test(command);

/**
 * Assess one command.
 * context: {
 *   branch: string|null            current branch,
 *   environment: string|null           the contents of migrations.environmentFile (trimmed), null when the file does not exist,
 *   baseBranch?: string            default config().baseBranch,
 *   allowBranches?: string[]       config().push.allowBranches: other branches the main session may push,
 *   allowedBranchQuestion?: (name) => string|null  the secret precheck for such a push,
 *   migrations?: { pushCommand, environmentFile, allowedEnvironment }   default config().migrations,
 *   agentType?: string|null        the hook payload's agent_type; tracks, reviewers and helpers get the network guard,
 *                                  never push, and run only the allowed queue commands,
 *   knownPackage?: (name) => bool  is the npm package known (package.json or node_modules/.bin)? Only for guarded agents,
 *   guardedTypes?: Set<string>    the guarded agent types beyond track/track-d; default trackGuard.queueAgentTypes(),
 *   agentGuard?: { enabled?, except?, subagent? }  the agentGuard setting (lib/agentGuard.js policyOf) and whether the
 *                                  payload came from a subagent (it has an agent_id); default: every subagent is guarded,
 *   batchQuestion?: () => string|null   the batch threshold question for a plain push of baseBranch (the hook reads
 *                                  git and base-health.json); asked only for the main session, and only when nothing
 *                                  else is found. null = no question.
 *   secretQuestion?: () => string|null  the secret precheck question for the same push (lib/secretScan.js), same rules.
 *   controlsQuestion?: () => string|null  the same push with no CI config or no gates (lib/controls.js), same rules.
 *   deployCommands?: string[]      default config().deployCommands,
 *   branchPrefix?: string          config().branchPrefix: a queue agent's `ravenseat add` must run on such a branch,
 * }
 * The command line is read with lib/shellCommands.js (nested shells, eval, $( ), subshells and inline git aliases
 * included). A part it cannot see into, in a line that looks like a push (or, for a queue agent, a queue CLI call),
 * gives ask for the main session and deny for a queue agent.
 * Returns null (no decision) or { decision: 'ask'|'deny', reason }.
 * With several matches the strictest wins (deny over ask).
 */
function assess(command, context = {}) {
  const { baseBranch, migrations, deployCommands } = values(context);
  const guarded = isGuardedAgent(context.agentType, context.guardedTypes, context.agentGuard);
  const findings = [];
  let basePush = false;
  const allowedPushes = [];
  const read = SC.commandList(command);
  const unread = [...read.unsure];
  // A queue agent's `ravenseat add` is judged by the branch where it runs: a line that moves or repoints it first is not that branch.
  let moved = /\bQUEUE_[A-Z_]+\s*=/.test(command);
  for (const c of read.commands) {
    const { t, i0 } = c;
    if (c.opaque) unread.push(c.opaque);

    const g = SC.gitInvocation(t, i0);
    const sub = g ? String(g.sub).toLowerCase() : null;
    if (g && guarded) {
      if (SC.isGitPush(g)) findings.push({ decision: 'deny', reason: AGENT_PUSH_REASON });
      else if (g.aliasFromEnv)
        findings.push({
          decision: 'deny',
          reason: `\`git ${g.sub}\` is an alias from an environment variable (--config-env); queue agents do not use git aliases.`,
        });
      else if (sub === 'config' && g.args.some((x) => /^alias\./i.test(x)))
        findings.push({
          decision: 'deny',
          reason: 'Queue agents do not define git aliases (git config alias.*): the push guard cannot see what they run.',
        });
      else if (sub === 'config' && configSetsExecKey(g.args))
        findings.push({
          decision: 'deny',
          reason:
            `Queue agents do not set git config keys that run a program (${configSetsExecKey(g.args)}): it would run at the ` +
            "orchestrator's next git command. Reading them (git config --get) is fine.",
        });
      else if (!SC.GIT_SUBCOMMANDS.has(sub))
        findings.push({
          decision: 'deny',
          reason:
            `\`git ${g.sub}\` is not a git builtin (an alias from the git config?): queue agents use the plain git ` +
            'commands, so the guard can see what runs.',
        });
    } else if (g && sub === 'push') {
      const { template, force, all, tags, deletes } = pushTemplate(g.args, context.branch || null);
      // A branch in push.allowBranches is the owner's own (a pull request branch after a rebase): forced asks first. The
      // base, an unknown branch and an agent stay denied, and a delete or --all has its own rule below.
      const forceAllowed =
        force &&
        !all &&
        !tags &&
        !context.agentType &&
        !deletes.length &&
        template.length > 0 &&
        template.every((m) => m !== baseBranch && m !== '<unknown>' && allowedBranch(m, context.allowBranches));
      if (forceAllowed) {
        const secrets =
          typeof context.allowedBranchQuestion === 'function'
            ? template.map((name) => context.allowedBranchQuestion(name)).filter(Boolean)
            : [];
        findings.push({
          decision: 'ask',
          reason: [
            `Forced push of ${template.join(', ')} replaces that branch's history on the remote. It is allowed by push.allowBranches, so it is your call.`,
            ...secrets,
          ].join(' Also: '),
        });
      } else if (force) {
        findings.push({
          decision: 'deny',
          reason:
            'Forced push is forbidden: shared history is never rewritten. Merge instead, and push normally. For your own pull request branch, the owner can add it to push.allowBranches in queue.config.json; then a forced push asks first.',
        });
      } else if (all) {
        findings.push({
          decision: 'deny',
          reason: `\`git push --all/--mirror\` pushes all branches. Only baseBranch (${baseBranch}) is pushed.`,
        });
      } else if (deletes.includes(baseBranch)) {
        findings.push({
          decision: 'deny',
          reason: `Deleting baseBranch (${baseBranch}) on the remote is blocked (\`--delete\` or \`:${baseBranch}\`).`,
        });
      } else if (tags) {
        findings.push({
          decision: 'deny',
          reason: `\`git push --tags\` is blocked: only baseBranch (${baseBranch}) is pushed. Tags go by name, from your own terminal or with the owner's yes to a pattern in push.allowBranches.`,
        });
      } else {
        const named = template.filter((m) => m !== baseBranch && m !== '<unknown>');
        const allowed = named.filter((m) => !deletes.includes(m) && allowedBranch(m, context.allowBranches));
        const others = named.filter((m) => !allowed.includes(m));
        allowedPushes.push(...allowed);
        if (others.length > 0) {
          findings.push({
            decision: 'deny',
            reason: `Push of ${others.join(', ')} is blocked: only baseBranch (${baseBranch}) is pushed, and in batches. Track branches are merged locally. For pull requests, the owner can allow branches with push.allowBranches in queue.config.json; ask them first.`,
          });
        } else if (template.includes('<unknown>')) {
          findings.push({
            decision: 'ask',
            reason: `Could not determine which branch is pushed. Confirm that it is baseBranch (${baseBranch}).`,
          });
        } else if (template.includes(baseBranch)) basePush = true;
      }
    } else if (g && (SC.isGitPush(g) || (g.aliasFromEnv && pushShaped(command)))) {
      // send-pack, `subtree push`, or an alias the guard cannot see: the main session confirms.
      findings.push({
        decision: 'ask',
        reason: `\`git ${g.sub}\` may push in a form the push guard does not assess. Confirm the target is baseBranch (${baseBranch}).`,
      });
    }

    if (guarded) {
      const call = SC.queueCall(t, i0);
      const reason = call ? agentQueueReason(call, { branch: context.branch, branchPrefix: context.branchPrefix, moved }) : null;
      if (['cd', 'pushd', 'popd', 'chdir', 'set-location', 'push-location', 'pop-location', 'sl'].includes(String(SC.commandWord(t[i0])).toLowerCase())) moved = true;
      if (reason) findings.push({ decision: 'deny', reason });
      const migration = migrationMatch(t, migrations);
      if (migration)
        findings.push({
          decision: 'deny',
          reason:
            `\`${migration}\` changes a database. Queue agents write the migration file and do not run it: the owner decides when ` +
            'it runs. Say in your result that it has not run.',
        });
    }

    const deploy = deployCommands.length ? deployMatch(t, deployCommands) : null;
    if (deploy)
      findings.push({
        decision: 'ask',
        reason: `\`${deploy}\` is a deploy command (deployCommands in queue.config.json). Confirm that this should go live now.`,
      });

    if (
      migrations.pushCommand &&
      migrations.environmentFile &&
      isCommand(t, migrations.pushCommand)
    ) {
      const environment = context.environment;
      const allowedOnes = Array.isArray(migrations.allowedEnvironment) ? migrations.allowedEnvironment : [];
      if (environment !== null && environment !== undefined && !allowedOnes.includes(environment)) {
        findings.push({
          decision: 'deny',
          reason:
            `Migration push to "${environment}" is blocked: ${migrations.environmentFile} points to an environment that is not in ` +
            `migrations.allowedEnvironment (${allowedOnes.length ? allowedOnes.join(', ') : 'empty list'}). Link to the correct environment first.`,
        });
      }
    }
  }
  // A part the reading could not see into (lib/shellCommands.js): when the line looks like a push (or, for a queue
  // agent, a queue CLI call), the main session confirms and a queue agent is stopped.
  if (unread.length) {
    const why = [...new Set(unread)].join('; ');
    if (pushShaped(command))
      findings.push(
        guarded
          ? {
              decision: 'deny',
              reason: `The push guard cannot read this command (${why}) and it looks like a push. ${AGENT_PUSH_REASON}`,
            }
          : {
              decision: 'ask',
              reason:
                `The push guard cannot read this command (${why}) and it looks like a push. Confirm what it pushes ` +
                `(only baseBranch ${baseBranch}, never forced).`,
            },
      );
    else if (guarded && queueShaped(command))
      findings.push({
        decision: 'deny',
        reason: `The push guard cannot read this command (${why}) and it calls the queue CLI. Run ravenseat directly; allowed for queue agents: ${AGENT_QUEUE_LIST}.`,
      });
  }
  // The network guard applies to the queue's agents: tracks, reviewers and helper agents (never the orchestrator).
  if (guarded) findings.push(...assessNetwork(command, context));
  // The secret precheck, the missing controls and the batch threshold: only for the orchestrator (no agent_type; tracks
  // never push) and only when nothing else hit. All the questions go in one dialog.
  if (basePush && findings.length === 0 && !context.agentType) {
    const questions = [context.secretQuestion, context.controlsQuestion, context.batchQuestion]
      .map((f) => (typeof f === 'function' ? f() : null))
      .filter(Boolean);
    if (questions.length) findings.push({ decision: 'ask', reason: questions.join(' Also: ') });
  }
  // A branch the owner allowed (push.allowBranches): no batch or CI question, but a secret is as bad on any branch.
  if (allowedPushes.length && findings.length === 0 && !context.agentType && typeof context.allowedBranchQuestion === 'function') {
    const questions = allowedPushes.map((name) => context.allowedBranchQuestion(name)).filter(Boolean);
    if (questions.length) findings.push({ decision: 'ask', reason: questions.join(' Also: ') });
  }
  if (findings.length === 0) return null;
  return findings.find((f) => f.decision === 'deny') || findings[0];
}

/**
 * Reads the environment file (migrations.environmentFile, relative to the root). Tries `rotate` in order (the worktree
 * first, then mainTree, since the file is often gitignored and only lives in mainTree). Gives trimmed content or null.
 * @param {string[]} rotate
 * @param {string|null} environmentFile
 */
function readEnvironment(rotate, environmentFile) {
  if (!environmentFile) return null;
  for (const root of rotate.filter(Boolean)) {
    try {
      return fs.readFileSync(path.resolve(root, environmentFile), 'utf8').trim();
    } catch {
      // not here; try the next
    }
  }
  return null;
}

module.exports = {
  assess,
  AGENT_PUSH_REASON,
  AGENT_QUEUE_COMMANDS,
  readEnvironment,
  isCommand,
  isTrackAgent,
  isGuardedAgent,
  segments,
  TRACK_AGENT_TYPES,
};
