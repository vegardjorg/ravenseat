// =============================================================
// lib/checksScan.js: what the project already has for checking its code, read from its files.
//
// Trust boundary: this only READS. It never runs a check, a script or a workflow, so it is safe in a repo someone else
// wrote, and a finding means "the file says so", never "it works". The Checks tab and `ravenseat checks` say that in words.
//
//   classify(command)         the kinds of check a command line is (a line can be several: vitest --coverage)
//   parseWorkflow(text)       triggers, jobs and commands of a GitHub Actions file (by lines, no YAML dependency)
//   scan(input)               { ci: [one per CI file], kinds: [one per kind of check found, with where it runs], and the
//                             project facts below }
//   withScriptBody(c, scripts) a command plus the package.json script it runs (also used by lib/dbGuard.js)
//
// The facts scan() adds besides the kinds (each read from files only, for the Checks cards):
//   hasDatabase      the project has a database: migrations.folder is set, or supabase/, prisma/ or migrations/ exists
//   hasMigrations    migrations are set up: the configured folder, or supabase/migrations, prisma/migrations,
//                    migrations/ or db/migrations exists
//   unpinnedActions  `uses:` lines in .github/workflows that point at a tag or branch instead of a 40-character commit
//                    SHA (a moved tag runs other code with the workflow's token); local and docker:// steps do not count
//   runtimePinned    the runtime version is written down: .nvmrc, .node-version, .tool-versions, .python-version,
//                    mise.toml, rust-toolchain(.toml), .ruby-version, .java-version, package.json engines,
//                    pyproject requires-python, or the go line in go.mod
//   envFile, envExample  a .env is on disk, and an .env.example, .env.sample or .env.template is
//
// Used by: cli/checks.mjs. Tested in: lib/__tests__/checksScan.test.ts.
// =============================================================
'use strict';

const { CI_FILES } = require('./controls.js');

const RUN = '(?:npm|pnpm|yarn|bun)(?:\\s+run)?\\s+';

/** The kinds of check, in the order the board shows them. `sees` is what marks a command line as that kind. */
const KINDS = [
  {
    key: 'test',
    title: 'Tests',
    sees: new RegExp(`\\b(?:vitest|jest|mocha|ava|pytest|tox|nox|rspec|phpunit|playwright test|cypress run|node --test|go test|cargo test|dotnet test|mvn test|gradlew? test|make test|${RUN}test)\\b`, 'i'),
  },
  {
    key: 'types',
    title: 'Type check',
    sees: new RegExp(`\\b(?:tsc|mypy|pyright|make typecheck|${RUN}(?:typecheck|type-check|check-types))\\b`, 'i'),
  },
  {
    key: 'lint',
    title: 'Lint',
    sees: new RegExp(`\\b(?:eslint|biome|ruff|flake8|pylint|golangci-lint|clippy|rubocop|stylelint|shellcheck|make lint|${RUN}lint)\\b|prettier\\s+--check`, 'i'),
  },
  {
    key: 'build',
    title: 'Build',
    sees: new RegExp(`\\b(?:cargo build|go build|docker build|mvn (?:package|verify)|gradlew? build|next build|vite build|expo export|make build|${RUN}build)\\b|python -m build`, 'i'),
  },
  { key: 'coverage', title: 'Test coverage', sees: /--coverage\b|--cov\b|--cov=|\bcodecov\b|\bcoverage run\b|\bnyc\b|\bc8\b/i },
  { key: 'secret-scan', title: 'Secret scan', sees: /\b(?:gitleaks|trufflehog|detect-secrets)\b/i },
  {
    key: 'audit',
    title: 'Dependency audit',
    sees: /\b(?:(?:npm|pnpm|yarn) audit|pip-audit|cargo audit|cargo deny|govulncheck|osv-scanner|dependency-review-action|snyk)\b/i,
  },
  { key: 'security', title: 'Code scanning', sees: /\b(?:codeql|semgrep|bandit|trivy|sonar\w*)\b/i },
  // Database probes: tests that run SQL against a real database (access rules, constraints, functions that must refuse).
  { key: 'db', title: 'Database probes', sees: /\b(?:pg_prove|pgtap|supabase\s+test\s+db|sqlx\s+test)\b/i },
  // Migrations run from an empty database (the CI card checks that one runs in CI).
  {
    key: 'migrate',
    title: 'Migrations from empty',
    sees: /\b(?:supabase\s+db\s+(?:reset|start)|supabase\s+start|prisma\s+migrate\s+(?:deploy|reset)|alembic\s+upgrade|knex\s+migrate|sqlx\s+migrate\s+run|flyway\s+migrate|dbmate\s+up|goose\s+up|rails\s+db:(?:create|migrate|setup|prepare)|manage\.py\s+migrate)\b/i,
  },
  {
    key: 'format',
    title: 'Formatter',
    sees: /\b(?:prettier|biome\s+(?:format|check)|black|gofmt|go\s+fmt|rustfmt|cargo\s+fmt|ruff\s+format|dprint|clang-format|ktlint|spotless|php-cs-fixer)\b/i,
  },
  { key: 'unused', title: 'Unused code', sees: /\b(?:knip|vulture|ts-prune|depcheck|unimported|cargo[-\s]udeps|cargo[-\s]machete|deadcode)\b/i },
  { key: 'dep-updates', title: 'Dependency updates', sees: null },
  { key: 'hooks', title: 'Git hooks', sees: null },
];

/** Files that show a kind by being there. */
const MARKER_FILES = [
  ['dep-updates', '.github/dependabot.yml'],
  ['dep-updates', '.github/dependabot.yaml'],
  ['dep-updates', 'renovate.json'],
  ['dep-updates', '.renovaterc'],
  ['dep-updates', '.github/renovate.json'],
  ['hooks', '.pre-commit-config.yaml'],
  ['hooks', '.husky'],
  ['hooks', 'lefthook.yml'],
  // A probe folder in one of the usual places counts as database probes being there.
  ['db', 'supabase/tests'],
  ['db', 'db/tests'],
  ['db', 'tests/sql'],
  ['format', '.prettierrc'],
  ['format', '.prettierrc.json'],
  ['format', '.prettierrc.js'],
  ['format', '.prettierrc.cjs'],
  ['format', '.prettierrc.mjs'],
  ['format', '.prettierrc.yaml'],
  ['format', '.prettierrc.yml'],
  ['format', 'prettier.config.js'],
  ['format', 'prettier.config.mjs'],
  ['format', 'prettier.config.cjs'],
  ['format', 'biome.json'],
  ['format', 'biome.jsonc'],
  ['format', 'rustfmt.toml'],
  ['format', '.rustfmt.toml'],
  ['format', 'dprint.json'],
  ['unused', 'knip.json'],
  ['unused', '.knip.json'],
  ['unused', 'knip.config.ts'],
  ['unused', 'knip.config.js'],
];

/** Where the facts below look (see the header). */
const DATABASE_DIRS = ['supabase', 'prisma', 'migrations'];
const MIGRATION_DIRS = ['supabase/migrations', 'prisma/migrations', 'migrations', 'db/migrations'];
const RUNTIME_FILES = ['.nvmrc', '.node-version', '.tool-versions', '.python-version', 'mise.toml', '.mise.toml', 'rust-toolchain', 'rust-toolchain.toml', '.ruby-version', '.java-version', '.sdkmanrc'];
const ENV_EXAMPLES = ['.env.example', '.env.sample', '.env.template'];
/** Dependencies that are a formatter or an unused-code finder, counted as the marker files are. */
const PACKAGE_MARKERS = [
  ['format', 'prettier'],
  ['format', '@biomejs/biome'],
  ['format', 'dprint'],
  ['unused', 'knip'],
  ['unused', 'ts-prune'],
  ['unused', 'depcheck'],
];

/** A `uses:` value that is not pinned to a commit SHA (local steps and docker images are not actions from a repo). */
function unpinnedUse(uses) {
  const u = String(uses ?? '').trim().replace(/^["']|["']$/g, '');
  if (!u || u.startsWith('./') || u.startsWith('docker://')) return false;
  const at = u.lastIndexOf('@');
  if (at < 0) return true;
  return !/^[0-9a-f]{40}$/i.test(u.slice(at + 1));
}

const classify = (command) => KINDS.filter((k) => k.sees?.test(String(command))).map((k) => k.key);

/** Keeps a long line readable on a card. */
const short = (command) => {
  const c = String(command).trim().replace(/\s+/g, ' ');
  return c.length > 120 ? `${c.slice(0, 117)}...` : c;
};

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const indentOf = (line) => line.length - line.trimStart().length;

/**
 * The triggers, jobs and commands of a GitHub Actions file. Read line by line, so an unusual file gives less, never an error.
 * @returns {{ triggers: string[], jobs: { name: string, commands: string[] }[] }}
 */
function parseWorkflow(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const triggers = [];
  const jobs = [];
  let area = null;
  let jobIndent = null;
  let triggerIndent = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (indentOf(line) === 0) {
      const on = /^["']?on["']?\s*:\s*(.*)$/.exec(line);
      area = on ? 'on' : /^jobs\s*:/.test(line) ? 'jobs' : null;
      triggerIndent = null;
      jobIndent = null;
      if (on?.[1]) triggers.push(...on[1].replace(/[[\]]/g, '').split(',').map((x) => x.trim()).filter(Boolean));
      continue;
    }
    if (area === 'on') {
      triggerIndent ??= indentOf(line);
      const key = /^\s*([\w-]+)\s*:/.exec(line);
      if (key && indentOf(line) === triggerIndent) triggers.push(key[1]);
    }
    if (area !== 'jobs') continue;
    jobIndent ??= indentOf(line);
    if (indentOf(line) === jobIndent) {
      const key = /^\s*["']?([\w-]+)["']?\s*:/.exec(line);
      if (key) jobs.push({ name: key[1], commands: [] });
      continue;
    }
    const job = jobs[jobs.length - 1];
    if (!job) continue;
    const uses = /^\s*(?:-\s*)?uses\s*:\s*(\S+)/.exec(line);
    if (uses) job.commands.push(uses[1]);
    const run = /^\s*(?:-\s*)?run\s*:\s*(.*)$/.exec(line);
    if (!run) continue;
    if (/^[|>][-+]?\s*$/.test(run[1])) {
      // A block: every following line further in than `run:` belongs to it.
      const own = indentOf(line) + (line.trimStart().startsWith('-') ? 2 : 0);
      while (i + 1 < lines.length && (!lines[i + 1].trim() || indentOf(lines[i + 1]) > own)) {
        i++;
        if (lines[i].trim() && !lines[i].trim().startsWith('#')) job.commands.push(lines[i].trim());
      }
    } else if (run[1]) job.commands.push(run[1].trim());
  }
  return { triggers: [...new Set(triggers)], jobs };
}

/** The lines of another host's CI file that look like commands. */
const plainLines = (text) =>
  String(text ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/^-\s+/, '').replace(/^(?:script|sh|bat|powershell|command|run)\s*:\s*/, '').trim())
    .filter((l) => l && !l.startsWith('#'));

/** A command that runs a package.json script also counts as what that script does (`npm run check` -> tsc && eslint). */
function withScriptBody(command, scripts) {
  const m = /\b(?:(?:npm|pnpm|bun)\s+run|yarn(?:\s+run)?)\s+([\w:.-]+)/.exec(command) ?? /\b(?:npm|pnpm|bun)\s+(test)\b/.exec(command);
  return m && typeof scripts[m[1]] === 'string' ? `${command} ${scripts[m[1]]}` : command;
}

/**
 * What the project has. Everything comes in as a value, so the rules can be tested without a disk.
 * @param {{ exists: (f: string) => boolean, read: (f: string) => string|null, list: (dir: string) => string[],
 *   gates?: { quick?: string[], full?: string[] }, checks?: { kind: string, command: string, source: string }[] }} input
 *   `checks` is what lib/kickstart.js detectChecks found (the project's own commands).
 * @returns {{ ci: object[], kinds: { key: string, title: string, places: object[] }[] }}
 */
function scan({ exists, read, list, gates = {}, checks = [], migrationsFolder = null }) {
  const pkg = parseJson(read('package.json') ?? '');
  const scripts = pkg && typeof pkg.scripts === 'object' && pkg.scripts ? pkg.scripts : {};
  const places = new Map();
  const add = (kind, place) => {
    const list2 = places.get(kind) ?? [];
    if (!list2.some((p) => p.where === place.where && p.command === place.command && p.file === place.file)) list2.push(place);
    places.set(kind, list2);
  };
  const ci = [];
  let unpinnedActions = 0;
  const addCommand = (command, file, job) => {
    for (const kind of classify(withScriptBody(command, scripts))) add(kind, { where: 'ci', file, job, command: short(command) });
  };
  for (const [host, p, dir] of CI_FILES) {
    if (dir) {
      for (const name of list(p).filter((f) => /\.ya?ml$/i.test(f)).sort()) {
        const file = `${p}/${name}`;
        const w = parseWorkflow(read(file));
        for (const job of w.jobs) for (const c of job.commands) addCommand(c, file, job.name);
        // parseWorkflow keeps a `uses:` value as a command; one with owner/repo@ref is an action from a repo.
        if (p === '.github/workflows') for (const job of w.jobs) for (const c of job.commands) if (/^[\w.-]+\/[\w./-]+@/.test(c) && unpinnedUse(c)) unpinnedActions++;
        ci.push({ host, file, triggers: w.triggers, jobs: w.jobs.map((j) => j.name) });
      }
    } else if (exists(p)) {
      for (const c of plainLines(read(p))) addCommand(c, p, null);
      ci.push({ host, file: p, triggers: [], jobs: [] });
    }
  }
  for (const [name, body] of Object.entries(scripts)) {
    if (typeof body !== 'string' || /no test specified/i.test(body)) continue;
    for (const kind of classify(body)) add(kind, { where: 'script', file: 'package.json', job: null, command: `${name}: ${short(body)}` });
  }
  // A check found in package.json is usually the script above in other words (`npm test` and `test: vitest run`): one row.
  // It still counts when the script itself says nothing (`test: node run-tests.js`).
  const hasScriptRow = (kind) => (places.get(kind) ?? []).some((p) => p.where === 'script' && p.file === 'package.json');
  for (const c of checks) {
    if (c.source === 'package.json' && hasScriptRow(c.kind)) continue;
    add(c.kind, { where: 'script', file: c.source, job: null, command: short(c.command) });
  }
  const gateList = [...(Array.isArray(gates.quick) ? gates.quick : []), ...(Array.isArray(gates.full) ? gates.full : [])];
  for (const c of new Set(gateList.map((g) => String(g ?? '').trim()).filter(Boolean)))
    for (const kind of classify(withScriptBody(c, scripts))) add(kind, { where: 'gate', file: 'queue.config.json', job: null, command: short(c) });
  for (const [kind, file] of MARKER_FILES) if (exists(file) || list(file).length > 0) add(kind, { where: kind === 'hooks' ? 'hook' : 'config', file, job: null, command: null });
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  for (const [kind, name] of PACKAGE_MARKERS) if (Object.hasOwn(deps, name)) add(kind, { where: 'config', file: 'package.json', job: null, command: name });
  const pyproject = read('pyproject.toml') ?? '';
  if (/^\[tool\.(?:black|ruff\.format)\]/m.test(pyproject)) add('format', { where: 'config', file: 'pyproject.toml', job: null, command: null });
  if (/^\[tool\.vulture\]/m.test(pyproject)) add('unused', { where: 'config', file: 'pyproject.toml', job: null, command: null });
  // A folder counts when it exists or has files in it (an injected file list knows files only, the disk knows both).
  const hasDir = (d) => exists(d) || list(d).length > 0;
  const folder = typeof migrationsFolder === 'string' && migrationsFolder.trim() ? migrationsFolder.trim().replace(/\\/g, '/').replace(/\/+$/, '') : null;
  return {
    ci,
    kinds: KINDS.filter((k) => places.has(k.key)).map((k) => ({ key: k.key, title: k.title, places: places.get(k.key) })),
    hasDatabase: !!folder || DATABASE_DIRS.some(hasDir),
    hasMigrations: (!!folder && hasDir(folder)) || MIGRATION_DIRS.some(hasDir),
    unpinnedActions,
    runtimePinned:
      RUNTIME_FILES.some((f) => exists(f)) ||
      !!(pkg && pkg.engines && typeof pkg.engines === 'object' && Object.keys(pkg.engines).length) ||
      /^\s*requires-python\s*=/m.test(pyproject) ||
      /^go\s+\d/m.test(read('go.mod') ?? ''),
    envFile: exists('.env'),
    envExample: ENV_EXAMPLES.some((f) => exists(f)),
  };
}

module.exports = { KINDS, classify, parseWorkflow, scan, withScriptBody, unpinnedUse };
