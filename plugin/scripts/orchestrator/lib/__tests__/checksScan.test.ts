// =============================================================
// checksScan.test.ts: reading what a project has for checking its code (lib/checksScan.js). Files come in as values.
//
// Locks: (1) a command line is classified by what it runs; (2) a workflow gives triggers, jobs and commands, also in a block
// and with odd input; (3) `npm run x` counts as what the script does; (4) where a check runs is told apart (CI, gate, script,
// hook); (5) npm's placeholder test is not a check.
// =============================================================
import { describe, expect, it } from 'vitest';

const { classify, parseWorkflow, scan } = require('../checksScan.js');

const fsLike = (files: Record<string, string>) => ({
  exists: (f: string) => f in files,
  read: (f: string) => files[f] ?? null,
  list: (dir: string) => Object.keys(files).filter((f) => f.startsWith(`${dir}/`)).map((f) => f.slice(dir.length + 1)),
});
const placesOf = (r: { kinds: { key: string; places: { where: string }[] }[] }, key: string) =>
  [...new Set(r.kinds.find((k) => k.key === key)?.places.map((p) => p.where))];

const WORKFLOW = `name: ci
on:
  push:
    branches: [main]
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      # npm run lint is a comment here
      - run: npm ci
      - name: checks
        run: |
          npm run check
          npm test
  scan:
    steps:
      - uses: github/codeql-action/analyze@v3
`;

describe('classify', () => {
  it('reads the common tools, and a line can be several kinds', () => {
    expect(classify('npx vitest run --coverage')).toEqual(['test', 'coverage']);
    expect(classify('pnpm run typecheck')).toEqual(['types']);
    expect(classify('ruff check .')).toEqual(['lint']);
    expect(classify('uses: gitleaks/gitleaks-action@v2')).toEqual(['secret-scan']);
    expect(classify('npm audit --production')).toEqual(['audit']);
  });
  it('does not read a check into an install or a word that only looks like one', () => {
    expect(classify('npm ci')).toEqual([]);
    expect(classify('echo contest')).toEqual([]);
  });
});

describe('parseWorkflow', () => {
  it('finds the triggers, the jobs and the commands, without the comment', () => {
    const w = parseWorkflow(WORKFLOW);
    expect(w.triggers).toEqual(['push', 'pull_request']);
    expect(w.jobs.map((j: { name: string }) => j.name)).toEqual(['test', 'scan']);
    expect(w.jobs[0].commands).toEqual(['actions/checkout@v4', 'npm ci', 'npm run check', 'npm test']);
  });
  it('reads the short forms of on, and gives less rather than an error on odd input', () => {
    expect(parseWorkflow('on: [push, pull_request]\n').triggers).toEqual(['push', 'pull_request']);
    expect(parseWorkflow('"on": push\n').triggers).toEqual(['push']);
    expect(parseWorkflow(null)).toEqual({ triggers: [], jobs: [] });
    expect(parseWorkflow('{{{not yaml\n  - : :\n').jobs).toEqual([]);
  });
  it('handles Windows line endings', () => {
    expect(parseWorkflow(WORKFLOW.replace(/\n/g, '\r\n')).jobs[0].commands).toContain('npm test');
  });
});

describe('scan', () => {
  const files = {
    'package.json': JSON.stringify({ scripts: { test: 'vitest run', check: 'tsc --noEmit && eslint .', build: 'vite build' } }),
    '.github/workflows/ci.yml': WORKFLOW,
    '.github/dependabot.yml': 'version: 2\n',
    '.husky': '',
  };
  const r = scan({ ...fsLike(files), gates: { quick: ['npm test'] } });

  it('tells where each check runs', () => {
    expect(placesOf(r, 'test')).toEqual(['ci', 'script', 'gate']);
    expect(placesOf(r, 'build')).toEqual(['script']);
    expect(placesOf(r, 'security')).toEqual(['ci']);
    expect(placesOf(r, 'dep-updates')).toEqual(['config']);
    expect(placesOf(r, 'hooks')).toEqual(['hook']);
  });
  it('counts `npm run check` as what the script does', () => {
    expect(placesOf(r, 'types')).toContain('ci');
    expect(placesOf(r, 'lint')).toContain('ci');
  });
  it('gives one card per CI file, with triggers and jobs', () => {
    expect(r.ci).toEqual([{ host: 'GitHub Actions', file: '.github/workflows/ci.yml', triggers: ['push', 'pull_request'], jobs: ['test', 'scan'] }]);
  });
  it('reads another host by its lines', () => {
    const gitlab = scan(fsLike({ '.gitlab-ci.yml': 'test:\n  script:\n    - pytest\n# - eslint .\n' }));
    expect(gitlab.ci[0].host).toBe('GitLab CI');
    expect(placesOf(gitlab, 'test')).toEqual(['ci']);
    expect(placesOf(gitlab, 'lint')).toEqual([]);
  });
  it('shows a package.json check once, unless the script itself says nothing', () => {
    const rows = (test: string) =>
      scan({
        ...fsLike({ 'package.json': JSON.stringify({ scripts: { test } }) }),
        checks: [{ kind: 'test', command: 'npm test', source: 'package.json' }],
      }).kinds[0].places.map((p: { command: string }) => p.command);
    expect(rows('vitest run')).toEqual(['test: vitest run']);
    expect(rows('node run-tests.js')).toEqual(['npm test']);
  });
  it('does not count the placeholder from npm init, and an empty project has nothing', () => {
    const placeholder = scan(fsLike({ 'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) }));
    expect(placeholder.kinds).toEqual([]);
    expect(scan(fsLike({}))).toEqual({ ci: [], kinds: [] });
  });
});
