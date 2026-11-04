// =============================================================
// lib/kickstart.js: what `cq kickstart` knows: which checks the project already has, and the next step toward a small
// set of controls. Pure logic: the files, git and the queue are passed in.
//
// The aim is understanding, not a setup to finish. A user who has never heard of CI reads one plain step with why it
// matters, and decides. Nothing here starts work or spends tokens: a step becomes a PROPOSED task the owner approves, and
// a step the owner cancelled stays declined. Ravenseat holds no stack-specific setup code: the track agent writes it in
// the user's own repo, from the mission below.
//
//   detectChecks({ exists, read })     the project's own check commands (Node/TypeScript and Python), each with its source
//   gateLists(checks)                  those commands as gates.quick and gates.full
//   steps({ facts, tasks })            the steps in order, each with a state; see STATES
//   nextStep(list)                     the first step the owner can act on now
//
// Used by: cli/kickstart.mjs. Tested in: lib/__tests__/kickstart.test.ts and __tests__/kickstartFlow.test.ts.
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
 * the /cq:kickstart skill can then read the project itself.
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

const NEVER_PUSH = 'Never push, deploy or change settings on the git host. Report what the owner must do by hand.';

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
      'Run `cq doctor` and read its `secrets` lines. Add the local secret files to .gitignore (for example .env and .env.* ' +
      'with !.env.example), and add a .env.example with the variable names only, never the values. A secret that is ' +
      'already tracked in git must be changed by the owner, because removing the file does not clean the history: say ' +
      `so in track-result.md, with the file name and never the value. ${NEVER_PUSH}`,
    acceptance: ['No secret file shows as untracked and not ignored', 'track-result.md lists any key the owner must change'],
  }),
  ci: () => ({
    id: 'KS-CI',
    title: 'Run the checks on GitHub on every push',
    content_min: 45,
    owned_files: ['.github/workflows/cq-gates.yml'],
    mission:
      'Write .github/workflows/cq-gates.yml. It runs exactly the commands in gates.quick from queue.config.json on a push ' +
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

/** A task for a step, ready for `cq add`. added_by makes it proposed (logic/questions.js isAgentSource). */
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
 * ciHosts, secretsOk }. Each step: { key, state, title, why, how, task? (the key for `cq kickstart add`), taskId? }.
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
        ? `cq kickstart gates --apply sets ${facts.checks.map((c) => c.command).join(', ')} as gates. It writes queue.config.json only.`
        : 'Set your check commands in gates.quick and gates.full in queue.config.json.',
    });
  } else {
    list.push({
      key: 'gates',
      state: taskState('KS-CHECK', tasks, 'next'),
      title: 'Add a first automatic check',
      why: 'Nothing can tell yet whether a change broke something. One small test is enough to start, and it can grow later.',
      how: 'cq kickstart add gates proposes a task for an agent. It starts only when you approve it.',
      task: 'first-check',
      taskId: 'KS-CHECK',
    });
  }
  list.push({
    key: 'secrets',
    state: !facts.git ? 'later' : facts.secretsOk ? 'done' : taskState('KS-SECRETS', tasks, 'next'),
    title: 'Keep secret files out of git',
    why: 'A password or key in git can be read by anyone with the repo, also in old commits.',
    how: 'cq kickstart add secrets proposes a task for an agent. It starts only when you approve it.',
    task: 'secrets',
    taskId: 'KS-SECRETS',
  });
  if (facts.ciHosts.length) {
    list.push({
      key: 'ci',
      state: 'done',
      // cq only sees that the config exists. It does not read what the config runs, so it must not claim that.
      title: `CI config found (${facts.ciHosts.join(', ')}); cq does not check that it runs your checks`,
      why: `CI config found: ${facts.ciHosts.join(', ')}.`,
      how: '',
    });
  } else if (facts.remote === 'github') {
    list.push({
      key: 'ci',
      state: gatesReady ? taskState('KS-CI', tasks, 'next') : 'later',
      title: 'Run the checks on GitHub on every push (CI)',
      why: 'CI runs your checks on a clean machine, so "it works on my computer" is not the only proof. It is optional, and it uses your CI minutes.',
      how: 'cq kickstart add ci proposes a task for an agent. It starts only when you approve it.',
      task: 'ci',
      taskId: 'KS-CI',
    });
  } else {
    list.push({
      key: 'ci',
      state: 'later',
      title: 'Run the checks on every push (CI)',
      why: facts.remote
        ? 'CI runs your checks on a clean machine. Your git host is not GitHub, so cq has no task for it: run your gates in that host\'s CI.'
        : 'CI runs your checks on a clean machine, but it needs a host such as GitHub. Your code is only on this computer, so there is nothing to do now.',
      how: '',
    });
  }
  return list;
}

/** The first step the owner can act on now, or null when nothing waits. */
const nextStep = (list) => list.find((s) => s.state === 'next') ?? null;

module.exports = { STATES, detectChecks, gateLists, missingScripts, steps, nextStep, taskFor };
