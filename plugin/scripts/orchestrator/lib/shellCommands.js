// =============================================================
// shellCommands.js: the shell reading the push guard (lib/pushGuard.js) works on. Pure, no I/O beyond one lazy
// directory listing (the orchestrator's own script names).
//
// WHY: the push guard used to read only the outer command, split on ; && || | and newlines. A push wrapped in
// `bash -c "…"`, `powershell -Command "…"`, `cmd /c`, the PowerShell call operator `& git …`, a subshell `( … )`,
// `$( … )`, backticks or a git alias given inline (`git -c alias.p=push p`) slipped past it. This module turns one
// command line into the list of simple commands that will actually run:
//   - split on ; && || | & newline ( ) { } ` and $( outside quotes (segments), keeping redirections (2>&1, &>file);
//   - per segment: tokens, redirections dropped, env prefixes and plain starters (command, exec, env, sudo, nohup,
//     time) skipped (firstWordIndex);
//   - recursion (at most MAX_DEPTH levels) into the inner command of a shell (bash/sh/zsh/dash -c, pwsh/powershell
//     -Command, cmd /c|/k), eval/iex/Invoke-Expression, runners that take a command (timeout, nice, wsl, doas),
//     `$( … )` and backticks inside a double-quoted word, and a git shell alias (`-c alias.x=!…`);
//   - quotes inside a word and a backslash in a command word are read as the shell does (`g"i"t`, `g\it`, `git pu"s"h`);
//   - a brace list outside quotes (`{git,push}`, `git {push,-f}`) is expanded by the shell, so the line counts as unread;
//   - a command the reading cannot see into is marked `opaque` with a reason: an encoded PowerShell command, a
//     variable as the command word (`& $g push`), Start-Process, xargs, find -exec, a pipe into a shell, inline
//     interpreter code (node -e, python -c …), a git command that runs a command itself (rebase -x, -c core.pager=…,
//     submodule foreach, bisect run …; gitRunsCommand), or nesting deeper than MAX_DEPTH. A segment that sets a
//     variable git runs as a program (GIT_EDITOR, GIT_SSH_COMMAND …) makes the line unread. The push guard asks (main session)
//     or denies (queue agents) when such a command line also looks like a push or a queue CLI call.
// gitInvocation() finds the git subcommand after the global options (-C, -c, --git-dir …) and expands inline aliases
// (-c alias.<name>=<value>); queueCall() finds a call of the queue's own CLI (`ravenseat …`, `node …/queue.mjs …`, any of
// the orchestrator's scripts) and gives the command name the push guard checks against its allow-list.
//
// Known limits (on purpose, a guard and not a shell): a script file's contents (`bash x.sh`), a git alias stored in
// the repo config (queue agents get a deny on any git subcommand that is not a known builtin instead), and a command
// built from string pieces inside an interpreter (`node -e` with "pu"+"sh") are not seen. A relative Windows path with
// no extension (`tools\git`) reads as an escaped word. The aim is the usual ways of writing a command, not every way.
// Tested in lib/__tests__/shellCommands.test.ts, lib/__tests__/queueAgentGuard.test.ts (M1, nested shells) and
// lib/__tests__/pushGuard.test.ts.
// =============================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { CLI_NAMES, isCliName } = require('./productNames.js');

/** How deep the reading follows nested shells, eval and $( ). Deeper nesting is opaque. */
const MAX_DEPTH = 4;

/** Simple tokens: whitespace split, and quotes removed wherever they stand in a word, as the shell does (`g"i"t` is git). */
function tokens(chunk) {
  return (String(chunk || '').match(/(?:"[^"]*"|'[^']*'|\S)+/g) || []).map((t) => t.replace(/"([^"]*)"|'([^']*)'/g, (_, a, b) => a ?? b));
}

/**
 * Split a command into segments, respecting quotes. Splits on ; && || | & newline ( ) { } ` and $( .
 * An & that is part of a redirection (2>&1, >&2, &>file) does not split. Each segment gets { text, afterPipe }
 * (afterPipe = the segment comes right after a single "|").
 * @param {string} command
 */
function segments(command) {
  const s = String(command || '');
  const out = [];
  let buf = '';
  let quote = null;
  let afterPipe = false;
  const cut = (nextAfterPipe) => {
    if (buf.trim()) out.push({ text: buf.trim(), afterPipe });
    buf = '';
    afterPipe = nextAfterPipe;
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      buf += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      buf += c;
      continue;
    }
    if (c === '|') {
      if (s[i + 1] === '|') {
        i++;
        cut(false);
      } else cut(true);
      continue;
    }
    if (c === '&') {
      // A redirection: 2>&1, >&2, <&3 (the & follows > or <) and &>file, &>>file (the & comes before >).
      if ((s[i - 1] === '>' || s[i - 1] === '<') && s[i + 1] !== '&') {
        buf += c;
        continue;
      }
      if (s[i + 1] === '>') {
        buf += c;
        continue;
      }
      if (s[i + 1] === '&') i++;
      cut(false);
      continue;
    }
    if (c === '$' && s[i + 1] === '(') {
      i++;
      cut(false);
      continue;
    }
    if (';\n\r(){}`'.includes(c)) {
      cut(false);
      continue;
    }
    buf += c;
  }
  cut(false);
  return out;
}

/** A redirection on its own (`>`, `2>`, `>>`, `2>&1`, `&>`, `*>`); with an fd target (&1) it takes no file word. */
const REDIRECT_ALONE = /^(\d*|&|\*)(>>?|<|>\|)(&\d*-?)?$/;
/** A redirection glued to its file (`>out.txt`, `2>/dev/null`, `&>log`). */
const REDIRECT_GLUED = /^(\d*|&|\*)(>>?|<)[^&>\s]\S*$/;

/** The tokens without redirections and their file words. */
function stripRedirects(t) {
  const out = [];
  for (let i = 0; i < t.length; i++) {
    const x = t[i];
    const alone = REDIRECT_ALONE.exec(x);
    if (alone) {
      if (!alone[3]) i++; // `> file`: the file word goes too
      continue;
    }
    if (REDIRECT_GLUED.test(x)) continue;
    out.push(x);
  }
  return out;
}

/**
 * A backslash in a word that is no path is an escape: `g\it` runs git. It is a path with a drive, a leading .\ ~ \ or /,
 * another /, or a program's extension (`tools\git.exe`).
 */
const withoutEscapes = (t) =>
  /\\/.test(t) && !/^[A-Za-z]:|^\.{0,2}[\\/~]|\/|\.(exe|cmd|bat|ps1|mjs|js)$/i.test(t) ? t.replace(/\\/g, '') : t;

/** The command word in a token: without path, without .exe/.cmd/.bat/.ps1, lower case. */
const commandWord = (t) =>
  withoutEscapes(String(t || ''))
    .split(/[\\/]/)
    .pop()
    .replace(/\.(exe|cmd|bat|ps1)$/i, '')
    .toLowerCase();

/** Skip env prefixes (FOO=bar), "command", "exec", "env", "sudo" and PowerShell assignment ($x = …). */
function firstWordIndex(t) {
  let i = 0;
  for (;;) {
    if (i < t.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t[i])) i++;
    else if (i < t.length && ['command', 'exec', 'env', 'sudo', 'nohup', 'time', 'builtin'].includes(t[i])) i++;
    else if (i + 1 < t.length && /^\$[A-Za-z_][\w:]*$/.test(t[i]) && t[i + 1] === '=') i += 2;
    else if (i < t.length && /^\$[A-Za-z_][\w:]*=$/.test(t[i])) i++;
    else return i;
  }
}

/** Shells whose -c / -Command / /c argument is a command line of its own. */
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'pwsh', 'powershell', 'cmd']);
/** eval and its PowerShell forms: the rest of the words is a command line. */
const EVALS = new Set(['eval', 'iex', 'invoke-expression']);
/** Runners whose remaining words (after their options and a duration) are a command: `timeout 10 git push`. */
const RUNNERS = new Set(['timeout', 'nice', 'ionice', 'wsl', 'doas', 'stdbuf', 'chronic', 'unbuffer', 'caffeinate']);
/** Programs that run a command the reading cannot follow (their arguments are built at run time). */
const OPAQUE_RUNNERS = new Set([
  'xargs',
  'parallel',
  'watch',
  'start-process',
  'saps',
  'start',
  'invoke-command',
  'icm',
  'start-job',
  'sajb',
  'invoke-item',
  'ii',
  'runas',
]);
/** Interpreters and the flags that give them inline code. */
const INLINE_CODE = {
  node: /^(-e|-p|--eval|--print|-pe)$/,
  bun: /^(-e|--eval|-p|--print)$/,
  deno: /^(eval)$/,
  python: /^-c$/,
  python3: /^-c$/,
  py: /^-c$/,
  perl: /^-[eE]$/,
  ruby: /^-e$/,
  php: /^-r$/,
  osascript: /^-e$/,
};
/** The -c / -Command / /c flags (PowerShell accepts any prefix of -Command, from -c). */
const SHELL_FLAG = /^(-c|-co|-com|-comm|-comma|-comman|-command|\/c|\/k|\/r)$/i;
/** PowerShell's encoded command flag (any prefix of -EncodedCommand from -e, and -ec). */
const ENCODED_FLAG = /^-(e|ec|en|enc|enco|encod|encode|encoded|encodedc|encodedco|encodedcom|encodedcomm|encodedcomma|encodedcomman|encodedcommand)$/i;

/**
 * What a simple command runs inside itself: { text } (a command line to read too), { opaque } (a reason the reading
 * cannot see into it) or null (an ordinary command).
 * @param {string[]} t tokens, @param {number} i0 the command word's index, @param {boolean} afterPipe
 */
function innerCommand(t, i0, afterPipe) {
  const raw = t[i0];
  const word = commandWord(raw);
  // A variable or expression as the command word: `& $g push`, `$cmd`, `${x}`. The value is not known here.
  if (/^[$@]/.test(raw)) return { opaque: `the command word ${raw} is a variable` };
  if (SHELLS.has(word)) {
    const ps = word === 'pwsh' || word === 'powershell';
    for (let j = i0 + 1; j < t.length; j++) {
      if (ps && ENCODED_FLAG.test(t[j])) return { opaque: `an encoded PowerShell command (${t[j]})` };
      // bash/sh take -c also combined with other one-letter flags (-lc, -ec); cmd takes /c and /k; PowerShell any
      // prefix of -Command.
      const flag = ps || word === 'cmd' ? SHELL_FLAG.test(t[j]) : /^-[A-Za-z]*c[A-Za-z]*$/.test(t[j]);
      if (flag) {
        const rest = t.slice(j + 1);
        return rest.length ? { text: rest.join(' ') } : { opaque: `${raw} ${t[j]} without a command` };
      }
    }
    if (afterPipe) return { opaque: `a pipe into a shell (${raw})` };
    return null;
  }
  if (EVALS.has(word)) {
    const rest = t.slice(i0 + 1);
    return rest.length ? { text: rest.join(' ') } : { opaque: `${raw} without arguments (it reads the pipe)` };
  }
  if (RUNNERS.has(word)) {
    let j = i0 + 1;
    while (j < t.length && (t[j].startsWith('-') || /^\d+(\.\d+)?[smhd]?$/.test(t[j]))) j++;
    return j < t.length ? { text: t.slice(j).join(' ') } : null;
  }
  if (OPAQUE_RUNNERS.has(word)) return { opaque: `${raw} runs a command built at run time` };
  if (word === 'find' && t.some((x, k) => k > i0 && /^-(exec|execdir|ok|okdir)$/.test(x)))
    return { opaque: 'find -exec runs a command per file' };
  const inline = INLINE_CODE[word];
  if (inline && t.some((x, k) => k > i0 && inline.test(x))) return { opaque: `inline ${word} code` };
  if (word === 'git') {
    const g = gitInvocation(t, i0);
    if (g?.shell != null) return { text: g.shell };
    const runs = g ? gitRunsCommand(t, i0, g) : null;
    if (runs) return { opaque: runs };
  }
  return null;
}

/**
 * Does this git command run another command that the reading cannot follow (review 2026-11-11, S2)? The reason, or
 * null. `git rebase -x "git push …"`, `git -c core.pager="git push …" log`, `git submodule foreach "…"`, `git bisect run
 * …`, the filter-branch filters, `difftool -x`, and the program options `--upload-pack`, `--receive-pack` and `--exec`.
 * A config key given with -c counts when lib/gitExecSurface.js says it runs a program; aliases are left out here, since
 * gitInvocation already reads an inline alias. Opaque, not denied by itself: the push guard denies only when the line
 * also looks like a push (or a queue CLI call), so `git rebase -x "npm test"` stays free.
 * @param {string[]} t @param {number} i0 @param {{ sub: string, args: string[] }} g
 */
function gitRunsCommand(t, i0, g) {
  const { isExecKey } = require('./gitExecSurface.js');
  for (let i = i0 + 1; i < t.length && t[i].startsWith('-'); i += GIT_VALUE_OPTIONS.has(t[i]) ? 2 : 1) {
    const o = t[i];
    const kv = o === '-c' || o === '--config-env' ? t[i + 1] : o.startsWith('--config-env=') ? o.slice(13) : null;
    const key = String(kv ?? '').split('=')[0];
    if (key && !/^alias\./i.test(key) && isExecKey(key)) return `git ${o} ${key} runs a program`;
  }
  const sub = String(g.sub).toLowerCase();
  const args = g.args;
  const has = (re) => args.some((a) => re.test(a));
  if (has(/^--(upload-pack|receive-pack|exec)(=|$)/)) return `git ${sub} with a program option runs a command`;
  if (sub === 'rebase' && has(/^(-[A-Za-z]*x|--exec(=|$))/)) return 'git rebase -x runs a command per commit';
  if (sub === 'submodule' && args.includes('foreach')) return 'git submodule foreach runs a command per submodule';
  if (sub === 'bisect' && args.includes('run')) return 'git bisect run runs a command per step';
  if (sub === 'filter-branch' && has(/^--(tree|index|env|parent|msg|commit|tag-name)-filter$|^--setup$/))
    return 'git filter-branch runs its filters as shell commands';
  if ((sub === 'difftool' || sub === 'mergetool') && has(/^(-x|--extcmd)(=|$)/)) return `git ${sub} -x runs a command`;
  if (sub === 'clone' && has(/^-u/)) return 'git clone -u runs a program';
  return null;
}

/**
 * Environment variables git (or ssh under it) runs as a program, or that inject config: setting one is a command the
 * reading cannot see. The editor and pager variables git falls back to are included.
 */
const GIT_EXEC_ENV =
  /^(GIT_EDITOR|GIT_SEQUENCE_EDITOR|GIT_PAGER|GIT_SSH|GIT_SSH_COMMAND|GIT_ASKPASS|SSH_ASKPASS|GIT_EXTERNAL_DIFF|GIT_PROXY_COMMAND|GIT_EXEC_PATH|GIT_CONFIG_PARAMETERS|GIT_CONFIG_COUNT|GIT_CONFIG_KEY_\d+|GIT_CONFIG_VALUE_\d+|GIT_CONFIG_GLOBAL|GIT_CONFIG_SYSTEM|EDITOR|VISUAL|PAGER)$/i;

/**
 * The reason, when a segment sets such a variable: as a prefix (`GIT_EDITOR=… git commit`), with export, env or set, or in
 * PowerShell (`$env:GIT_EDITOR = …`). null otherwise.
 * @param {string[]} t the segment's tokens
 */
function execEnvAssignment(t) {
  for (let j = 0; j < t.length; j++) {
    const m = /^(\$env:)?([A-Za-z_]\w*)(=|$)/i.exec(t[j]);
    if (!m || !GIT_EXEC_ENV.test(m[2])) continue;
    if (m[3] === '=' || (m[1] && t[j + 1] === '=')) return `${m[2]} is set, and git runs it as a program`;
  }
  return null;
}

/** The commands inside `$( … )` and backticks in a (double-quoted) word: they run before the outer command. */
function innerSubstitutions(word) {
  const out = [];
  const w = String(word || '');
  for (const m of w.matchAll(/\$\(([^()]*)\)/g)) if (m[1].trim()) out.push(m[1]);
  for (const m of w.matchAll(/`([^`]*)`/g)) if (m[1].trim()) out.push(m[1]);
  return out;
}

/**
 * Every simple command a command line runs, nested ones included.
 * Returns { commands: [{ t, i0, word, afterPipe, opaque }], unsure: [reason] }:
 *   t        the tokens (redirections removed), i0 the index of the command word, word its commandWord;
 *   opaque   null, or the reason the reading cannot see what this command runs;
 *   unsure   reasons the line as a whole could not be read (nesting deeper than MAX_DEPTH).
 * @param {string} command
 * @param {number} [depth]
 */
/**
 * Drops the text of a heredoc that only writes it away: `cat > file <<'EOF'` and `git commit -F - <<'EOF'`. A report that
 * quotes a forbidden command is not that command. Narrow on purpose: the delimiter must be quoted (otherwise $( ) in the
 * text runs), nothing may follow on the line (a pipe could feed a shell), and any other receiver keeps its text, since
 * `bash <<'EOF'` runs it. Without a closing delimiter nothing is dropped.
 */
function withoutWrittenHeredocs(command) {
  const lines = String(command || '').split(/\r?\n/);
  const opens = /(?:^|&&|;)\s*(cat\s[^|;&`$()<]*|git\s+commit\s[^|;&`$()<>]*-F\s+-\s*)<<(-?)\s*(['"])([A-Za-z_][\w-]*)\3([^|;&`$()<]*)$/;
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]);
    const m = opens.exec(lines[i]);
    // cat without a file sends the text on to whatever reads its output.
    if (!m || (m[1].startsWith('cat') && !m[1].includes('>') && !m[5].includes('>'))) continue;
    const isEnd = (l) => (m[2] ? l.replace(/^\t+/, '') : l) === m[4];
    const end = lines.findIndex((l, n) => n > i && isEnd(l));
    if (end > i) i = end;
  }
  return out.join('\n');
}

/** A brace list the shell expands, outside quotes: `{git,push}`, `git {push,-f}`. `HEAD@{1}` has no comma and is not one. */
const hasBraceList = (command) => /\{[^{}\s]*,[^{}\s]*\}/.test(String(command || '').replace(/"[^"]*"|'[^']*'/g, '""'));

function commandList(command, depth = 0) {
  const out = { commands: [], unsure: [] };
  if (hasBraceList(withoutWrittenHeredocs(command))) out.unsure.push('a brace list the shell expands');
  const nested = (text) => {
    if (depth >= MAX_DEPTH) {
      out.unsure.push(`nested more than ${MAX_DEPTH} levels`);
      return;
    }
    const r = commandList(text, depth + 1);
    out.commands.push(...r.commands);
    out.unsure.push(...r.unsure);
  };
  for (const seg of segments(withoutWrittenHeredocs(command))) {
    const t = stripRedirects(tokens(seg.text));
    // Before the command word is found: a segment that is only an assignment (`export GIT_EDITOR=…`) has none.
    const env = execEnvAssignment(t);
    if (env) out.unsure.push(env);
    const i0 = firstWordIndex(t);
    if (i0 >= t.length) continue;
    // $( ) and backticks inside double quotes run too (outside quotes segments() has already split them off); a
    // single-quoted word is literal in bash, so it is skipped.
    for (const raw of seg.text.match(/"[^"]*"|'[^']*'|\S+/g) || [])
      if (!raw.startsWith("'")) for (const s of innerSubstitutions(raw)) nested(s);
    const inner = innerCommand(t, i0, seg.afterPipe);
    if (inner && inner.text != null) {
      nested(inner.text);
      continue;
    }
    out.commands.push({ t, i0, word: commandWord(t[i0]), afterPipe: seg.afterPipe, opaque: inner?.opaque ?? null });
  }
  return out;
}

// ---- git ------------------------------------------------------------------------------------------------------------

/** git's global options that take a separate value. */
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--list-cmds', '--attr-source']);

/**
 * The git subcommand and its arguments, after the global options, with inline aliases expanded
 * (`git -c alias.p=push p -f` gives sub "push", args ["-f"]). `git-push` / `git-send-pack` as a program count too.
 * Returns null when this is not git, else { sub, args, shell?, aliasFromEnv? }:
 *   shell         the command line of a shell alias (`-c alias.x=!…`), to be read as a command of its own;
 *   aliasFromEnv  the subcommand is an alias whose value comes from an environment variable (--config-env), unseen.
 * @param {string[]} t @param {number} i0
 */
function gitInvocation(t, i0) {
  const w = commandWord(t[i0]);
  const dashed = /^git-([a-z-]+)$/.exec(w);
  if (dashed) return { sub: dashed[1], args: t.slice(i0 + 1) };
  if (w !== 'git') return null;
  const aliases = new Map();
  const fromEnv = new Set();
  const record = (kv, env) => {
    const m = /^alias\.([^=]+)=(.*)$/is.exec(String(kv || ''));
    if (!m) return;
    if (env) fromEnv.add(m[1].toLowerCase());
    else aliases.set(m[1].toLowerCase(), m[2]);
  };
  let i = i0 + 1;
  while (i < t.length && t[i].startsWith('-')) {
    const o = t[i];
    if (o === '-c') record(t[i + 1], false);
    else if (o === '--config-env') record(t[i + 1], true);
    else if (o.startsWith('--config-env=')) record(o.slice('--config-env='.length), true);
    if (GIT_VALUE_OPTIONS.has(o)) i += 2;
    else i++;
  }
  if (i >= t.length) return null;
  let sub = t[i].replace(/\\/g, ''); // `git pu\sh` is push; a subcommand is never a path
  let args = t.slice(i + 1);
  for (let n = 0; n < 8; n++) {
    const key = sub.toLowerCase();
    if (fromEnv.has(key)) return { sub, args, aliasFromEnv: true };
    if (!aliases.has(key)) break;
    const v = aliases.get(key).trim();
    if (v.startsWith('!')) return { sub, args, shell: [v.slice(1), ...args].join(' ') };
    const vt = tokens(v);
    if (!vt.length) break;
    aliases.delete(key); // git never expands an alias into itself
    sub = vt[0];
    args = [...vt.slice(1), ...args];
  }
  return { sub, args };
}

/**
 * git's own subcommands (porcelain, plumbing and the usual helpers). For a queue agent any other subcommand is an
 * alias from the repo config (or a typo): the guard cannot see what it expands to, so it is denied.
 */
const GIT_SUBCOMMANDS = new Set(
  (
    'add am annotate apply archive bisect blame branch bundle cat-file check-attr check-ignore check-mailmap ' +
    'check-ref-format checkout checkout-index cherry cherry-pick citool clean clone column commit commit-graph ' +
    'commit-tree config count-objects credential describe diff diff-files diff-index diff-tree difftool fetch ' +
    'fetch-pack filter-branch fmt-merge-msg for-each-ref for-each-repo format-patch fsck gc get-tar-commit-id grep ' +
    'gui hash-object help hook index-pack init init-db instaweb interpret-trailers lfs log ls-files ls-remote ' +
    'ls-tree mailinfo mailsplit maintenance merge merge-base merge-file merge-index merge-one-file merge-tree ' +
    'mergetool mktag mktree multi-pack-index mv name-rev notes pack-objects pack-redundant pack-refs patch-id ' +
    'prune prune-packed pull push range-diff read-tree rebase receive-pack reflog refs remote repack replace ' +
    'request-pull rerere reset restore rev-list rev-parse revert rm send-email send-pack shortlog show ' +
    'show-branch show-index show-ref sparse-checkout stage stash status stripspace submodule subtree switch ' +
    'symbolic-ref tag unpack-file unpack-objects update-index update-ref update-server-info upload-archive ' +
    'upload-pack var verify-commit verify-pack verify-tag version whatchanged worktree write-tree'
  ).split(' '),
);

/** Is this git call a push in some form (push, send-pack, `subtree push`)? */
function isGitPush(g) {
  if (!g) return false;
  const sub = String(g.sub).toLowerCase();
  if (sub === 'push' || sub === 'send-pack') return true;
  if (sub === 'subtree') return g.args.find((x) => !x.startsWith('-')) === 'push';
  return false;
}

// ---- the queue's own CLI ----------------------------------------------------------------------------------------------

let scriptNames = null;
/** The orchestrator's scripts (the folder above lib/), without .mjs. Read once; an error gives the fixed core names. */
function orchestratorScripts() {
  if (scriptNames) return scriptNames;
  scriptNames = new Set([...CLI_NAMES, 'queue', 'merge-track', 'gates', 'prepare-track', 'push-check']);
  try {
    for (const f of fs.readdirSync(path.resolve(__dirname, '..')))
      if (f.endsWith('.mjs') && !f.startsWith('hook-')) scriptNames.add(f.slice(0, -'.mjs'.length).toLowerCase());
  } catch {
    // the fixed names only
  }
  return scriptNames;
}

/** The short script names ravenseat.mjs knows (lib/cliHelp.js ALIASES). */
const CLI_ALIASES = { board: 'queue-board', takeover: 'queue-takeover' };

/**
 * A call of the queue's own CLI: `ravenseat <command>`, `node …/ravenseat.mjs <command>`, `node …/queue.mjs <command>` or one of
 * the orchestrator's scripts (`node …/merge-track.mjs …`, `./gates.mjs`). Returns null, or { name, args }:
 * name = the queue command (show, merge …) or the script name (merge-track, gates …), '' for bare `ravenseat` (help);
 * args = the words after it.
 * @param {string[]} t @param {number} i0
 */
function queueCall(t, i0) {
  const scripts = orchestratorScripts();
  const scriptOf = (tok) => {
    const m = /(?:^|[\\/])([A-Za-z0-9_-]+)\.mjs$/i.exec(String(tok || ''));
    return m && scripts.has(m[1].toLowerCase()) ? m[1].toLowerCase() : null;
  };
  const w = commandWord(t[i0]);
  let script = null;
  let rest = [];
  if (isCliName(w)) {
    script = w;
    rest = t.slice(i0 + 1);
  } else if (['node', 'bun', 'deno'].includes(w)) {
    let j = i0 + 1;
    while (j < t.length && (t[j].startsWith('-') || t[j] === 'run')) j++;
    script = scriptOf(t[j]);
    rest = t.slice(j + 1);
  } else {
    script = scriptOf(t[i0]);
    rest = t.slice(i0 + 1);
  }
  if (!script) return null;
  const cli = isCliName(script);
  if (cli || script === 'queue') {
    if (cli && rest[0] === 'queue') rest = rest.slice(1);
    const first = rest[0] ?? '';
    const name = cli ? (CLI_ALIASES[first] ?? first) : first;
    return { name: name.startsWith('-') ? 'help' : name, args: rest.slice(1) };
  }
  return { name: script, args: rest };
}

module.exports = {
  MAX_DEPTH,
  tokens,
  segments,
  stripRedirects,
  commandWord,
  firstWordIndex,
  commandList,
  gitInvocation,
  isGitPush,
  GIT_SUBCOMMANDS,
  queueCall,
  SHELLS,
};
