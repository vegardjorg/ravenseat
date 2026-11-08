// =============================================================
// lib/kickstart.js: what `ravenseat kickstart` knows: which checks the project already has, and the next step toward a small
// set of controls. Pure logic: the files, git and the queue are passed in.
//
// The aim is understanding, not a setup to finish. A user who has never heard of CI reads one plain step with why it
// matters, and decides. Nothing here starts work or spends tokens: a step becomes a PROPOSED task the owner approves, and
// a step the owner cancelled stays declined. Ravenseat holds no stack-specific setup code: the track agent writes it in
// the user's own repo, from the mission below.
//
//   detectChecks({ exists, read })     the project's own check commands (Node/TypeScript and Python), each with its source
//   gateLists(checks)                  those commands as gates.quick and gates.full
//   gatePrograms(commands), programFound(p, o)   the programs gate commands start, and whether one is installed
//                                      (doctor's gates line, cli/doctorBaseline.mjs); nothing is run
//   steps({ facts, tasks })            the steps in order, each with a state; see STATES
//   nextStep(list)                     the first step the owner can act on now
//
// Used by: cli/kickstart.mjs, cli/doctorBaseline.mjs. Tested in: lib/__tests__/kickstart.test.ts and __tests__/kickstartFlow.test.ts.
// =============================================================

/** done: in place. next: can be acted on now. queued: a task exists. declined: the owner cancelled it. later: waits on an earlier step. */
const STATES = ['done', 'next', 'queued', 'declined', 'later'];

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** npm's placeholder from `npm init`: it always fails, so it is not a check. */
const isPlaceholderTest = (script) => /no test specified/i.test(String(script));

/** The command that runs a package.json script, for the package manager the lockfile shows. */
function nodeRunner(exists) {
  if (exists('pnpm-lock.yaml')) return { name: 'pnpm', test: 'pnpm test', run: (s) => `pnpm run ${s}` };
  if (exists('yarn.lock')) return { name: 'yarn', test: 'yarn test', run: (s) => `yarn run ${s}` };
  if (exists('bun.lockb') || exists('bun.lock')) return { name: 'bun', test: 'bun run test', run: (s) => `bun run ${s}` };
  return { name: 'npm', test: 'npm test', run: (s) => `npm run ${s}` };
}

function nodeChecks(exists, read) {
  const pkg = parseJson(read('package.json') ?? '');
  const scripts = pkg && typeof pkg.scripts === 'object' && pkg.scripts ? pkg.scripts : {};
  const run = nodeRunner(exists);
  const out = [];
  const source = 'package.json';
  const types = ['typecheck', 'type-check', 'check-types', 'tsc'].find((s) => scripts[s]);
  if (types) out.push({ kind: 'types', command: run.run(types), source });
  else if (exists('tsconfig.json')) out.push({ kind: 'types', command: 'npx tsc --noEmit', source: 'tsconfig.json' });
  if (scripts.lint) out.push({ kind: 'lint', command: run.run('lint'), source });
  if (scripts.test && !isPlaceholderTest(scripts.test)) out.push({ kind: 'test', command: run.test, source });
  if (scripts.build) out.push({ kind: 'build', command: run.run('build'), source });
  return out;
}

function pythonChecks(exists, read) {
  const pyproject = read('pyproject.toml') ?? '';
  const prefix = exists('uv.lock') ? 'uv run ' : exists('poetry.lock') ? 'poetry run ' : '';
  const out = [];
  if (/^\[tool\.mypy\]/m.test(pyproject) || exists('mypy.ini'))
    out.push({ kind: 'types', command: `${prefix}mypy .`, source: exists('mypy.ini') ? 'mypy.ini' : 'pyproject.toml' });
  if (/^\[tool\.ruff/m.test(pyproject) || exists('ruff.toml'))
    out.push({ kind: 'lint', command: `${prefix}ruff check .`, source: exists('ruff.toml') ? 'ruff.toml' : 'pyproject.toml' });
  if (/^\[tool\.pytest/m.test(pyproject) || exists('pytest.ini') || exists('tests'))
    out.push({ kind: 'test', command: `${prefix}pytest`, source: exists('pytest.ini') ? 'pytest.ini' : exists('tests') ? 'tests/' : 'pyproject.toml' });
  return out;
}

/**
 * The project's own check commands, read from its files. Only what the files show; an unknown stack gives no checks, and
 * the /ravenseat:kickstart skill can then read the project itself.
 * @param {{ exists: (file: string) => boolean, read: (file: string) => string|null }} fsLike
 * @returns {{ stacks: string[], checks: { kind: string, command: string, source: string }[] }}
 */
function detectChecks({ exists, read }) {
  const stacks = [];
  const checks = [];
  if (exists('package.json')) {
    stacks.push(exists('tsconfig.json') ? 'Node/TypeScript' : 'Node');
    checks.push(...nodeChecks(exists, read));
  }
  if (exists('pyproject.toml') || exists('requirements.txt') || exists('setup.py')) {
    stacks.push('Python');
    checks.push(...pythonChecks(exists, read));
  }
  return { stacks, checks };
}

/** quick runs before every delivery, so it leaves out the build; full has everything. */
function gateLists(checks) {
  const commands = (kinds) => checks.filter((c) => kinds.includes(c.kind)).map((c) => c.command);
  return { quick: commands(['types', 'lint', 'test']), full: commands(['types', 'lint', 'test', 'build']) };
}

/**
 * Gate commands that name a package.json script the project does not have: such a gate is red on every run. Only the
 * plain forms (`npm test`, `npm run lint`, `pnpm run x`, `yarn test`, `bun run x`); anything else is not judged.
 * @param {string[]} commands
 * @param {string|null} packageJson the text of package.json, or null when there is none
 * @returns {string[]} the commands that cannot run
 */
function missingScripts(commands, packageJson) {
  const pkg = parseJson(packageJson ?? '');
  const scripts = pkg && typeof pkg.scripts === 'object' && pkg.scripts ? pkg.scripts : {};
  return commands.filter((c) => {
    const m = /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?([^\s-]\S*)/.exec(String(c).trim());
    if (!m) return false;
    const named = /^\S+\s+run\s/.test(String(c).trim()) || m[1] === 'test';
    return named && !scripts[m[1]];
  });
}

/** One command that checks nothing: true, exit 0, an echo, an empty or exit-0-only node -e. */
const NO_OP =
  /^(?:true|:|exit(?:\s+0)?|cmd(?:\.exe)?\s+\/[cC]\s+exit(?:\s+0)?|echo(?:\s.*)?|node\s+(?:-e|--eval)\s+(["']?)\s*(?:process\.exit\(\s*0?\s*\)\s*;?)?\s*\1)$/i;

/**
 * The gate commands that check nothing (red team RT-17): a no-op as above, chained no-ops (&&, ;), or a package script
 * (npm test, npm run x, pnpm/yarn/bun) whose body is one. A gate list of only these is always green, whatever the code
 * does. Pure; a script that is not in package.json is not a no-op here (missingScripts reports it).
 * @param {string[]} commands
 * @param {string|null} packageJson the text of package.json
 * @returns {string[]}
 */
function noOpCommands(commands, packageJson) {
  const pkg = parseJson(packageJson ?? '');
  const scripts = pkg && typeof pkg.scripts === 'object' && pkg.scripts ? pkg.scripts : {};
  const plain = (c, depth = 0) =>
    String(c)
      .split(/&&|;/)
      .map((x) => x.trim())
      .every((x) => {
        if (NO_OP.test(x)) return true;
        const m = /^(?:npm|pnpm|yarn|bun)\s+(?:run(?:-script)?\s+)?([^\s-]\S*)$/.exec(x);
        return !!m && depth < 3 && typeof scripts[m[1]] === 'string' && plain(scripts[m[1]], depth + 1);
      });
  return commands.filter((c) => typeof c === 'string' && c.trim() && plain(c));
}

/** Words the shell runs itself (sh and cmd.exe), so not a program on PATH. Compared in lower case. */
const BUILTINS = new Set([
  ':', '.', '[', '[[', 'true', 'false', 'cd', 'echo', 'exit', 'export', 'set', 'unset', 'source', 'test', 'eval', 'exec',
  'pushd', 'popd', 'type', 'command', 'builtin', 'read', 'printf', 'pwd', 'shift', 'return', 'wait', 'trap', 'ulimit',
  'umask', 'alias', 'if', 'then', 'else', 'fi', 'for', 'while', 'do', 'done', 'case', 'esac', '!', '{', '}',
  'call', 'rem', 'dir', 'copy', 'del', 'erase', 'md', 'mkdir', 'rd', 'rmdir', 'ren', 'rename', 'move', 'cls', 'ver',
  'vol', 'setlocal', 'endlocal', 'goto', 'start', 'title', 'chdir', 'mklink', 'assoc', 'ftype', 'path', 'prompt', 'break',
]);
/**
 * Not looked up: npm and npx come with Node (doctor checks node), and the script an npm command names is judged by
 * missingScripts. pnpm, yarn and bun are separate installs and are looked up.
 */
const NOT_LOOKED_UP = new Set(['npm', 'npx']);

/** A command line cut at &&, ||, ;, | and & outside quotes; a redirection like 2>&1 is not a cut. */
function segments(command) {
  const out = [];
  let cur = '';
  let quote = null;
  const s = String(command);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
      cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      cur += c;
    } else if (c === '&' && s[i - 1] === '>') {
      cur += c;
    } else if (c === ';' || c === '|' || c === '&') {
      if (s[i + 1] === c) i++;
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

/**
 * The programs the gate commands start, for doctor's "is it installed" check (red team scenario 14): per command
 * segment (split at &&, ||, ;, |, &), the first word after env assignments (FOO=1) and an opening "(", quotes removed.
 * Left out: shell builtins, npm and npx (see NOT_LOOKED_UP), and a word the shell expands ($VAR, $(...), backticks,
 * %VAR%, a glob), which cannot be judged without running it. Pure; nothing is run.
 * @param {string[]} commands
 * @returns {{ program: string, command: string, path: boolean }[]}  one per distinct program; `path` when the word
 *   names a file (has / or \), which the caller resolves from the repo root
 */
function gatePrograms(commands) {
  const out = [];
  const seen = new Set();
  for (const command of commands ?? []) {
    if (typeof command !== 'string') continue;
    for (const segment of segments(command)) {
      // Words with their quotes kept together ("C:\Program Files\x.exe" is one word), then the quotes removed.
      const words = (segment.trim().replace(/^\(+\s*/, '').match(/(?:"[^"]*"|'[^']*'|[^\s"'])+/g) ?? []);
      while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
      const word = (words[0] ?? '').replace(/["']/g, '');
      if (!word || /[$`%*?]/.test(word) || /^[<>]/.test(word)) continue;
      if (BUILTINS.has(word.toLowerCase()) || NOT_LOOKED_UP.has(word.toLowerCase())) continue;
      if (seen.has(word)) continue;
      seen.add(word);
      out.push({ program: word, command: command.trim(), path: /[\\/]/.test(word) });
    }
  }
  return out;
}

/**
 * Is the program found the way a shell finds it? A path (has / or \) is resolved from `root` (an absolute one as is);
 * a bare name is looked for in each folder of `pathValue`. On Windows the PATHEXT endings are tried as well (also the
 * bare name, which Git Bash runs). Pure apart from the injected `isFile`.
 * @param {{ program: string, path: boolean }} p  from gatePrograms
 * @param {{ pathValue?: string, pathExt?: string, platform?: string, root: string, isFile: (file: string) => boolean,
 *   join: (...parts: string[]) => string, resolve: (...parts: string[]) => string, delimiter: string }} o
 */
function programFound(p, { pathValue = '', pathExt = '', platform = process.platform, root, isFile, join, resolve, delimiter }) {
  const endings = platform === 'win32' ? ['', ...String(pathExt || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)] : [''];
  const tryAll = (base) => endings.some((e) => isFile(base + e) || isFile(base + e.toLowerCase()));
  if (p.path) return tryAll(resolve(root, p.program));
  return String(pathValue)
    .split(delimiter)
    .filter(Boolean)
    .some((dir) => tryAll(join(dir.replace(/^"|"$/g, ''), p.program)));
}

const NEVER_PUSH ='Never push, deploy or change settings on the git host. Report what the owner must do by hand.';

/** The files a first-check task may touch, for the stack that was found (the merge guard protects these otherwise). */
function firstCheckFiles(stacks) {
  if (stacks.some((s) => s.startsWith('Node'))) return ['package.json', 'package-lock.json', 'tests/'];
  if (stacks.includes('Python')) return ['pyproject.toml', 'tests/'];
  return [];
}

/** The tasks a step can become. Each is proposed: nothing starts before the owner approves it. */
const TASKS = {
  'first-check': (facts) => ({
    id: 'KS-CHECK',
    title: 'Add a first automatic check',
    content_min: 60,
    owned_files: firstCheckFiles(facts.stacks),
    mission:
      'The project has no automatic checks yet. Add the smallest useful one: a test runner that fits the stack, and one ' +
      'test of the most important behavior you can find, plus a project script that runs it (for Node: "test" in ' +
      'package.json). Do not add more tools than that, and do not edit queue.config.json. In track-result.md, say in plain ' +
      `words what the test protects and which command runs it. ${NEVER_PUSH}`,
    acceptance: [
      'One command runs the test and passes on the current code',
      'track-result.md shows that same command failing on a deliberate bug, which is then removed',
    ],
  }),
  secrets: () => ({
    id: 'KS-SECRETS',
    title: 'Keep secret files out of git',
    content_min: 30,
    owned_files: ['.gitignore', '.env.example'],
    mission:
      'Run `ravenseat doctor` and read its `secrets` lines. Add the local secret files to .gitignore (for example .env and .env.* ' +
      'with !.env.example), and add a .env.example with the variable names only, never the values. A secret that is ' +
      'already tracked in git must be changed by the owner, because removing the file does not clean the history: say ' +
      `so in track-result.md, with the file name and never the value. ${NEVER_PUSH}`,
    acceptance: ['No secret file shows as untracked and not ignored', 'track-result.md lists any key the owner must change'],
  }),
  ci: () => ({
    id: 'KS-CI',
    title: 'Run the checks on GitHub on every push',
    content_min: 45,
    owned_files: ['.github/workflows/ravenseat-gates.yml'],
    mission:
      'Write .github/workflows/ravenseat-gates.yml. It runs exactly the commands in gates.quick from queue.config.json on a push ' +
      'to the base branch and on pull requests, not a list of its own. Add the runtime setup and install step for this ' +
      'stack. Read the versions from the project (for example .nvmrc or engines). Set `permissions: contents: read`, ' +
      'cancel superseded runs with `concurrency`, skip docs-only pushes with `paths-ignore`, and pin actions to a major ' +
      `version. The first run can only be checked after the owner pushes: say so in track-result.md. ${NEVER_PUSH}`,
    acceptance: [
      'The workflow runs the same commands as gates.quick',
      'The commands pass locally, and track-result.md says that the first CI run is still unverified',
    ],
  }),
};

/** A task for a step, ready for `ravenseat add`. added_by makes it proposed (logic/questions.js isAgentSource). */
function taskFor(key, facts) {
  return {
    ...TASKS[key](facts),
    class: 'K',
    domain: 'ci',
    feature: 'CI setup',
    value: 8,
    labels: ['kickstart'],
    added_by: 'kickstart agent',
    own_track: 'a setup step the owner chose',
  };
}

/** The state of a step that can become a task: from the queue when the task exists, otherwise `open`. */
function taskState(id, tasks, open) {
  const task = (tasks ?? []).find((o) => o.id === id);
  if (!task) return open;
  if (task.status === 'cancelled') return 'declined';
  return task.status === 'done' ? 'done' : 'queued';
}

/**
 * The steps in order. `facts` is what the caller read: { git, remote: 'github'|'other'|null, stacks, checks, hasGates,
 * ciHosts, secretsOk }. Each step: { key, state, title, why, how, task? (the key for `ravenseat kickstart add`), taskId? }.
 */
function steps({ facts, tasks = [] }) {
  const list = [];
  list.push({
    key: 'git',
    state: facts.git ? 'done' : 'next',
    title: 'Put the project under git',
    why: 'Git keeps every version, so a bad change can be undone. The agents also need it to work side by side.',
    how: 'Ask Claude to run "git init" and make a first commit. A .gitignore should keep secrets and build output out.',
  });
  const gatesReady = !!facts.hasGates;
  if (gatesReady || facts.checks.length || !facts.git) {
    list.push({
      key: 'gates',
      state: gatesReady ? 'done' : facts.git ? 'next' : 'later',
      title: 'Use the checks your project already has',
      why: 'Checks are commands that fail when the code is broken. With them set as gates, every agent has to pass them before it delivers.',
      how: facts.checks.length
        ? `ravenseat kickstart gates --apply sets ${facts.checks.map((c) => c.command).join(', ')} as gates. It writes queue.config.json only.`
        : 'Set your check commands in gates.quick and gates.full in queue.config.json.',
    });
  } else {
    list.push({
      key: 'gates',
      state: taskState('KS-CHECK', tasks, 'next'),
      title: 'Add a first automatic check',
      why: 'Nothing can tell yet whether a change broke something. One small test is enough to start, and it can grow later.',
      how: 'ravenseat kickstart add gates proposes a task for an agent. It starts only when you approve it.',
      task: 'first-check',
      taskId: 'KS-CHECK',
    });
  }
  list.push({
    key: 'secrets',
    state: !facts.git ? 'later' : facts.secretsOk ? 'done' : taskState('KS-SECRETS', tasks, 'next'),
    title: 'Keep secret files out of git',
    why: 'A password or key in git can be read by anyone with the repo, also in old commits.',
    how: 'ravenseat kickstart add secrets proposes a task for an agent. It starts only when you approve it.',
    task: 'secrets',
    taskId: 'KS-SECRETS',
  });
  if (facts.ciHosts.length) {
    list.push({
      key: 'ci',
      state: 'done',
      // ravenseat only sees that the config exists. It does not read what the config runs, so it must not claim that.
      title: `CI config found (${facts.ciHosts.join(', ')}); ravenseat does not check that it runs your checks`,
      why: `CI config found: ${facts.ciHosts.join(', ')}.`,
      how: '',
    });
  } else if (facts.remote === 'github') {
    list.push({
      key: 'ci',
      state: gatesReady ? taskState('KS-CI', tasks, 'next') : 'later',
      title: 'Run the checks on GitHub on every push (CI)',
      why: 'CI runs your checks on a clean machine, so "it works on my computer" is not the only proof. It is optional, and it uses your CI minutes.',
      how: 'ravenseat kickstart add ci proposes a task for an agent. It starts only when you approve it.',
      task: 'ci',
      taskId: 'KS-CI',
    });
  } else {
    list.push({
      key: 'ci',
      state: 'later',
      title: 'Run the checks on every push (CI)',
      why: facts.remote
        ? 'CI runs your checks on a clean machine. Your git host is not GitHub, so ravenseat has no task for it: run your gates in that host\'s CI.'
        : 'CI runs your checks on a clean machine, but it needs a host such as GitHub. Your code is only on this computer, so there is nothing to do now.',
      how: '',
    });
  }
  return list;
}

/** The first step the owner can act on now, or null when nothing waits. */
const nextStep = (list) => list.find((s) => s.state === 'next') ?? null;

module.exports = { STATES, detectChecks, gateLists, missingScripts, noOpCommands, gatePrograms, programFound, steps, nextStep, taskFor };
