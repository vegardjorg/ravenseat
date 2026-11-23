// =============================================================
// settings/guards.js: the rows of File and read guards and Command and secret guards (section 7, the two mixed).
//
// Part of the settings registry (SPLIT-1): lib/settingsRegistry.js puts the area files together, in the order of
// AREAS there, into SETTINGS. A new row goes into the area file of its category, inside the section of that category,
// with its "Friction:" comment, as row(key, category, type, title, explanation, options) from ./rowKit.js; its default
// goes into lib/queueConfig.js STANDARD and its table row into plugin/docs/queue.md. A `requires` goes into
// ./requires.js. The row's place in this list is its place on the board and in `ravenseat settings`.
//
// Used by: lib/settingsRegistry.js.
// Tested in: lib/__tests__/settingsRegistry.test.ts (coverage, complete rows) and
// lib/__tests__/settingsRegistrySplit.test.ts (no row lost, moved or changed by the split).
// =============================================================
'use strict';

const { row, BASIC, offWeakens, rankWeakens, listLosesEntries } = require('./rowKit.js');

/** The rows of this area, in the order they are shown. */
const ROWS = Object.freeze([
  // ---- 7. Agent guards: File and read guards ('files') and Command and secret guards ('guards'), mixed in this list ----
  row('protectedPaths', 'files', 'list', 'Protected paths',
    'Paths a track may only change when its task owns them: hooks, settings, agents, the queue scripts and test configs. ' +
      'A list replaces the defaults; { "add": [...], "remove": [...] } changes them (the floor is never removed).', {
      weakens: listLosesEntries,
      protects: 'Agents changing hooks, settings and test configs without the task owning those files.',
      whyNot: 'These files run code or give instructions with your rights in the orchestrator session.',
      changes: 'The merge guard no longer stops changes to the paths left out (the floor holds). Doctor will report it.',
    }),
  row('dependencyFiles', 'files', 'choice', 'Dependency files',
    'A task that changes a dependency file it does not own: stop like a protected path, or warn.', {
      choices: ['stop', 'warn'],
      defaultByMode: { lite: 'warn', full: 'stop' },
      weakens: rankWeakens(['stop', 'warn']),
      protects: 'A track that adds or changes a library without the task owning the dependency file.',
      whyNot: 'A new library runs its install scripts on your machine and becomes part of what you ship.',
      changes: 'Such a change gives a warning, and the merge goes on. Doctor will report it.',
    }),
  row('gitSurface', 'files', 'choice', 'Git hooks and config',
    'Git hooks and git settings that run code (core.hooksPath and similar) are compared with what you accepted. Stop: ' +
    'a change stops receive and merge until you accept it. Warn: only a warning. Off: no check. The default is stop in ' +
    'full mode, since a hook runs with your rights on your next commit or push, and warn in lite, where a first try ' +
    'should not meet a hard stop.', {
      choices: ['stop', 'warn', 'off'],
      defaultByMode: { lite: 'warn', full: 'stop' },
      weakens: rankWeakens(['stop', 'warn', 'off']),
      protects: 'A git hook or git setting added while a track ran, which then runs on your next commit or push.',
      whyNot: 'Hooks and settings like core.hooksPath run code with your rights, outside every other guard.',
      changes: 'A changed hook or setting no longer stops receive, merge and the push check. Doctor will report it.',
    }),
  row('secretScan.enabled', 'guards', 'onoff', 'Secret scan before push',
    'The added lines of a push are scanned for secrets, and a hit asks first, naming the file and line.', {
      weakens: offWeakens,
      protects: 'Pushing a key, token or password that a track wrote into the code.',
      whyNot: 'A pushed secret stays in the remote\'s history and must be rotated, even after the commit is removed.',
      changes: 'Pushes go out without a secret scan. Doctor will report it.',
    }),
  // Friction: none, it never stops work: one line in the mission frame, and a SUSPICIOUS CONTENT line at receive plus a
  // section in the review package. On by default (the owner's decision of 18.11.2026, roadmap 0æ N4): a file a track
  // reads must not be able to speak as the owner. A false hit costs one line; a report can always quote the mark.
  row('injection.ownerMark', 'guards', 'onoff', 'Owner mark on missions',
    'Each mission gets a mark of its own on the owner answers and orchestrator additions in it. Receive flags, as ' +
    'Suspicious content, a report that claims owner approval without that mark. A warning, never a stop. Off: no mark.'),
  // The opt-in checks (lib/optInChecks.js): off by default, so switching one off again never weakens the standard.
  row('secretScan.atReceive', 'guards', 'onoff', 'Secret scan at receive',
    'Off by default. On: receive scans the track\'s own commits for secrets; a hit blocks the merge until a clean receive or merge --allow-secret.', {
      weakens: offWeakens,
      protects: 'A key a track committed being merged into the base branch, where its history keeps it.',
      whyNot: 'Once merged, the key is in the base branch\'s history; the push check only stops it from leaving the machine.',
      changes: 'Receive no longer scans the track\'s commits, and merge does not stop on a key.',
    }),
  row('secretScan.allowlist', 'guards', 'onoff', 'Keys in approved commands and .mcp.json',
    'Looks for keys (tokens, passwords) in the commands Claude Code has approved (.claude/settings*.json) and in the ' +
    'MCP servers in .mcp.json (env, headers, args, url), also in the agents\' worktrees. Off by default, like every ' +
    'opt-in check; on, doctor does this on each run.', {
      weakens: offWeakens,
      protects: 'A token typed in a command that "Yes, and don\'t ask again" stored in clear text, or pasted into a tracked .mcp.json.',
      whyNot: 'A key in the tracked .claude/settings.json or .mcp.json is in the repo and its history.',
      changes: 'Doctor no longer reads the approved commands or .mcp.json.',
    }),
  row('permissionsCheck.enabled', 'guards', 'onoff', 'Broad permissions check',
    'Off by default. On: doctor names the broad rules in the tracked .claude/settings.json: any shell command, network tools, rm, git push, WebFetch without a domain, and defaultMode bypassPermissions or acceptEdits.', {
      weakens: offWeakens,
      protects: 'A shared rule that lets every session on every clone run any command, send data over the network or push without a question.',
      whyNot: 'A rule in the tracked settings.json applies to everyone who opens the repo and to every agent.',
      changes: 'Doctor no longer reads the shared permissions.',
    }),
  row('dbGuard.localOnly', 'guards', 'onoff', 'Probe gates only against a local database',
    'Off by default. On: a database probe gate (pg_prove, supabase test db, sqlx test) whose database URL or host is not localhost, 127.0.0.1, ::1 or a Docker service name is refused, red with one line.', {
      weakens: offWeakens,
      protects: 'Probes that write and test refusals running against a shared or remote database, for example a DATABASE_URL left on staging.',
      whyNot: 'A probe that does not roll back changes data other people use.',
      changes: 'Probe gates run against whatever database their command or environment names.',
    }),
  row('gitignoreCheck.enabled', 'guards', 'onoff', 'Project .gitignore check',
    'Off by default. On: doctor checks that the project\'s own .gitignore, not only your global one, ignores what Ravenseat keeps local.', {
      weakens: offWeakens,
      protects: 'Your personal settings or the queue\'s data committed from a teammate\'s clone or CI, which has no global gitignore of yours.',
      whyNot: 'What only your global gitignore ignores is one `git add .` from the repo elsewhere.',
      changes: 'Doctor no longer checks the project\'s .gitignore.',
    }),
  row('secretScan.maxBytes', 'guards', 'integer', 'Secret scan size limit (bytes)',
    'A larger diff is not scanned, and the push asks instead.'),
  row('secretScan.timeoutMs', 'guards', 'integer', 'Secret scan time limit (ms)',
    'The time limit per git or gitleaks call in the secret scan. A scan that does not finish in time makes the push ' +
    'ask you first; it is never let through unchecked.'),
  // Friction: none, it stops nothing and costs no tokens: `ravenseat secrets scan --history` runs only on the owner's
  // command, and reads this many commits (about 2 s for 200 on Ravenseat's own repo). 200 covers months of work in most
  // projects; --all-history reads everything when the owner wants it (roadmap 6b, lib/repoSecretScan.js).
  row('secretScan.historyDepth', 'guards', 'integer', 'Key scan: commits read with --history',
    'How many of the newest commits `ravenseat secrets scan --history` reads for keys that were added and maybe deleted ' +
    'again. --all-history reads every commit. Only on your command; doctor never reads the history.'),
  // Friction: one INFO line in doctor, never WARN or a stop. On (14 days) because a key can land in any commit and the
  // scan is free; 0 turns the reminder off. Findings from the last scan show as WARN whatever this says.
  row('secretScan.rescanDays', 'guards', 'integer', 'Key scan reminder (days)',
    'Doctor suggests `ravenseat secrets scan --history` when it has never run, or when the last scan is older than this ' +
    'many days. 0 = no reminder. Doctor never runs the scan itself.'),
  row('deployCommands', 'guards', 'list', 'Deploy commands',
    'The push guard asks before any command that starts with one of these. Empty = off.',
    { protects: 'An agent that starts a deploy without asking you first.' }),
  row('claudeFingerprint', 'files', 'onoff', 'Claude setup fingerprint',
    'Receive warns when your own Claude setup (~/.claude) changed while a track ran. Only hashes are stored.', {
      weakens: offWeakens,
      protects: 'A track changing your own Claude settings, agents, skills or hooks outside the repository.',
      whyNot: 'Git does not see ~/.claude, so a change there would go unnoticed and apply to every later session.',
      changes: 'Receive no longer compares your Claude setup before and after a track. Doctor will report it.',
    }),
  // Friction: a track works in its own worktree and never needs the main tree's control files, so the guard only
  // stops what was never meant to happen; the shell reading can stop a copy out of a control file (cp <main>/... .),
  // which the denial explains. The fingerprint costs a few milliseconds at fill and receive and only warns. On by
  // default by the owner's decision of 16.11.2026 (plans/ekstern-saas-vurdering-2026-11-15.md, bolk 1).
  row('controlFiles.guard', 'files', 'onoff', 'Control file write guard',
    'Queue agents may not write the main tree\'s queue.config.json, .claude/, CLAUDE*.md, .git/hooks/, .git/config or ' +
    'the plugin\'s scripts, with the file tools or the shell. Their own worktree copies stay free; the main session is not affected.', {
      ...BASIC,
      weakens: offWeakens,
      protects: 'A track switching off a guard, adding a hook or rewriting the instructions by writing the main tree\'s control files directly.',
      whyNot: 'Every override flag is denied to the agents, but a direct write to these files gets around all of them.',
      changes: 'Queue agents can write the main tree\'s control files again. Doctor will report it.',
    }),
  row('controlFiles.fingerprint', 'files', 'onoff', 'Control file fingerprint',
    'Fill and start record a short hash of each main tree control file; receive warns (CONTROL FILES CHANGED) about a ' +
    'change that no commit explains. Only hashes are stored.', {
      weakens: offWeakens,
      protects: 'A change to the main tree\'s control files while a track ran that the write guard did not see (a script the agent ran).',
      whyNot: 'Ignored files such as .claude/settings.local.json and .git/config never show in git, so a change there goes unnoticed.',
      changes: 'Receive no longer compares the main tree\'s control files before and after a track. Doctor will report it.',
    }),
  // Friction: none, it only appends a row when a guard has already decided. On by default by the owner's decision of
  // 16.11.2026 (bolk 6, measurement only): the overrides are measured for two weeks before approval with presence.
  // A log, not a guard, but it keeps weakens until that measuring is over (owner decision 2026-11-17).
  row('guardLog.enabled', 'guards', 'onoff', 'Guard decision log',
    'Every deny and ask from the push, write and read guard is one row in the time log: guard, rule, agent type, task ' +
    'and time, never the command. Doctor and the board count them per track.', {
      weakens: offWeakens,
      protects: 'Seeing afterwards how often the guards stopped or asked an agent, and which track kept trying.',
      whyNot: 'Without the rows a track that hits a guard again and again leaves no trace, and the overrides cannot be measured.',
      changes: 'The guards still decide, but their decisions are no longer logged. Doctor will report it.',
    }),
  // Friction: none at "log" (the default): the read goes on and one row lands in the time log. "block" can stop work
  // (a track that needs a value to debug a connection), so it is a choice, never the default (roadmap 1c SEC-T).
  row('guards.secretReads', 'guards', 'choice', 'Agents reading secrets',
    'A guarded agent that prints secrets in a shell command (cat, type, Get-Content, head, tail or less of a .env file or ' +
    'a .pem/.key file, printenv, env or set with no arguments, Get-ChildItem env:): log (allowed, one row in the time ' +
    'log, shown on the Checks tab), block (denied, the agent is told to reference the variable instead, for example ' +
    'psql "$DATABASE_URL"), or off. The value would also land in the transcript (~/.claude/projects).', {
      choices: ['block', 'log', 'off'],
      weakens: rankWeakens(['block', 'log', 'off']),
      protects: 'A key printed into an agent\'s transcript without anyone seeing that it happened.',
      whyNot: 'Off leaves no trace when an agent prints a .env file or the environment into its transcript.',
      changes: 'Agents can print secrets into their transcripts and nothing is logged.',
    }),
  // Friction: low. It stops work only when the push or write guard itself is broken (node missing, a crash before its
  // own catch, the 10 s timeout): Bash, PowerShell, Monitor, Write, Edit and NotebookEdit are then refused until it is
  // fixed. Default block by owner exception to "can stop work = off" (23.11, C2): since Claude Code v2.1.329 a call
  // from Code Mode runs after a hook failure, and a guard that fails open guards nothing (lib/hookFailure.js).
  row('guards.onHookFailure', 'guards', 'choice', 'When a guard itself fails',
    'What Claude Code does when the push guard or the write guard process fails (cannot start, crashes, times out, ' +
    'prints invalid output): block refuses the call ("onFailure": "block" on those two hooks), allow lets it run. ' +
    'The guards\' own decisions are unchanged. A vendored install gets the value from setup; the plugin\'s ' +
    'hooks/hooks.json always blocks. The read guard and the measurement hooks never block on failure.', {
      level: 'advanced',
      choices: ['block', 'allow'],
      weakens: rankWeakens(['block', 'allow']),
      protects: 'A push or protected write getting through when the guard itself fails.',
      whyNot: 'With allow, a guard that crashes or does not start lets every push and protected write through unchecked.',
      changes: 'A call the push or write guard could not check runs anyway. Doctor will report it.',
    }),
  // Friction: a false hit replaces harmless text with [REDACTED:env-value] in a stored log; values under 6 characters
  // and plain ones (true, localhost, numbers) are skipped to keep that rare. It stops nothing, so it is on (SP-1).
  row('redact.envValues', 'guards', 'onoff', 'Redact the project\'s own .env values',
    'Everything Ravenseat stores from transcripts and commands (gate and done tails, the review package, the SILENT ' +
    'snapshot, the time log\'s remark) also loses the exact values in the main tree\'s .env files (.env, .env.local, ' +
    '.env.*; never .env.example), held in memory only. Catches a short password no pattern knows.', {
      level: 'basic',
      weakens: offWeakens,
      protects: 'A database password or short token from your .env printed in a gate log or a transcript and stored by Ravenseat.',
      whyNot: 'The pattern redaction misses values without a known format or shorter than 16 characters.',
      changes: 'Only the patterns redact stored text; your own .env values can be stored in clear text.',
    }),
  // Friction: one click per override from the main session, which is rare (0 such rows in 312 when measured); the
  // orchestrator's ordinary commands never ask. On by default by the owner's decision of 16.11.2026 (bolk 3): the one
  // cheap thing that tells the owner apart from a misled model on the usual path (lib/approvalAsk.js).
  row('approvals.ask', 'guards', 'onoff', 'Ask before the main session overrides',
    'Claude Code asks you before the main session merges with --allow-* or --force*, passes --i-understand or --by owner, ' +
    'accepts the git surface, an owner row or a helper, calls the board\'s API or writes a control file directly. In ' +
    'dontAsk and bypassPermissions it is denied instead: run the command yourself in your terminal.', {
      weakens: offWeakens,
      protects: 'The model passing an override or acting as you because a report, a document or a compacted session said you agreed.',
      whyNot: 'Without the question an override from the main session cannot be told apart from yours: the CLI only sees the flag.',
      changes: 'The main session passes overrides and writes the control files without a question. Doctor will report it.',
    }),
  row('agentGuard.enabled', 'guards', 'onoff', 'Guard every agent type',
    'The push, network, queue command and state file guards apply to every subagent, also general-purpose, Explore and ' +
    'your own. Off: only the queue\'s own agent types, which are always guarded.', {
      ...BASIC,
      weakens: offWeakens,
      protects: 'An agent the queue did not define (a builtin or your own subagent) pushing, fetching from the network or ' +
        'writing the queue\'s state files.',
      whyNot: 'Any subagent can read text that tells it to push or send something out; the guards are what stop it.',
      changes: 'Agent types outside the queue\'s own get no push, network or write guard. Doctor will report AGENT GUARD OFF.',
    }),
  row('agentGuard.except', 'guards', 'list', 'Agent types not guarded',
    'Agent types the guards leave out, without case and with or without a plugin prefix. The queue\'s own types stay guarded.', {
      weakens: (v) => Array.isArray(v) && v.some((x) => typeof x === 'string' && x.trim() !== ''),
      protects: 'The agent types named here pushing, fetching from the network or writing the queue\'s state files.',
      whyNot: 'A named type runs with the main session\'s rules: it can push and reach the network whatever it was told.',
      changes: 'The named agent types get no push, network or write guard. Doctor will list each one.',
    }),
  row('agentPushBlock.enabled', 'guards', 'onoff', 'Git push block in track worktrees',
    'A git pre-push hook stops a push from a track\'s worktree, also one the text guard never saw (a script the agent ran). ' +
    'It runs in front of any pre-push hook you have; your own pushes from the main checkout are not affected.', {
      weakens: offWeakens,
      protects: 'A track pushing through git itself, from a script or a command form the push guard cannot read.',
      whyNot: 'The push guard reads command text; a push started by a script or a tool runs past it unseen.',
      changes: 'The hook is removed at the next fill, start or resume, and agents can push from git itself when the text ' +
        'guard does not see the command. Doctor will report it.',
    }),
  row('ownership.sharedPatchCollides', 'files', 'onoff', 'Shared patch collides with owned files',
    'A path in a task\'s shared_patch collides with another active task\'s owned_files: the second task waits to start, ' +
    'and a merge that patches a file another active task owns stops. Off: shared_patch is compared only with shared_patch.', {
      fullWhy: 'shared_patch is a field of the full task format',
      weakens: offWeakens,
      protects: 'Two tasks changing the same file at once because one lists it in shared_patch and the other owns it.',
      whyNot: 'The owner builds on the file while the other task patches it, and the merge goes in under it with no stop.',
      changes: 'Both tasks can start, and the merge no longer stops on a shared_patch path another active task owns. ' +
        'Doctor will report it.',
    }),
  row('readGuard.agentTypes', 'files', 'list', 'More guarded agent types',
    'More agent types the read guard applies to (tracks and reviewers are always included).'),
  row('readGuard.autoLoaded', 'files', 'list', 'Auto-loaded files',
    'Files Claude Code loads itself, which must never be read again with Read.'),
  row('readGuard.largeFiles', 'files', 'list', 'Large files', 'Patterns for files that must always be read in excerpts.'),
  row('readGuard.maxLines', 'files', 'integer', 'Read warning (lines)',
    'A read of more lines than this gets a warning (300 by default); the stop comes at readGuard.blockLines.'),
  row('readGuard.blockLines', 'files', 'integer', 'Read stop (lines)',
    'A read of more lines than this is stopped (2000 by default), so one large file cannot fill an agent\'s context.',
    { protects: 'One large file read whole that fills an agent\'s context.' }),
  // Friction: none, it stops nothing and only adds up to about 60 lines to a denial that happens anyway; the scan reads
  // at most 1 MiB for at most 200 ms and fails open to the old text. On by default by the owner's decision of 16.11.2026
  // (roadmap 0y Y1, plans/projectarchitect-vurdering-2026-11-16.md): it saves the agent a Grep round per denial.
  row('readGuard.outline', 'files', 'onoff', 'Outline in the read denial',
    'A denied whole-file Read of a large file also lists the file\'s headings and top-level declarations with their line ' +
    'numbers (Markdown, JS/TS, SQL; at most 60), so the agent can read with offset and limit straight away. Off: the ' +
    'denial text without it.'),
  row('reads.mode', 'files', 'choice', 'Read ownership',
    'A task that reads a file an active task changes: wait until it is done, or start and name the overlap.',
    {
      choices: ['wait', 'warn'],
      fullWhy: 'read ownership uses the reads field of the full task format',
      protects: 'A task that reads a file while another task is changing it.',
    }),
  row('hotspots', 'files', 'list', 'Hotspots',
    'Shared config blocks parallel tracks break each other on; only an agreed change gets through. Empty = off.',
    {
      fullWhy: 'hotspot changes are agreed in the full task format (hotspot_patch)',
      protects: 'Parallel tracks that break each other in a shared config block.',
    }),
  row('contextGuard.blockOtherChats', 'files', 'onoff', 'Stop other chats at 400k',
    'Chats that are not the orchestrator are stopped at 400k context instead of only getting the notice.',
    { protects: 'A chat other than the orchestrator that keeps going past 400k context.' }),
]);

module.exports = { ROWS };
