// =============================================================
// kickstart.test.ts: which checks lib/kickstart.js finds, and which step it says comes next.
// The real commands are in __tests__/kickstartFlow.test.ts.
// =============================================================
import { describe, expect, it } from 'vitest';

/* eslint-disable-next-line @typescript-eslint/no-require-imports */
const K = require('../kickstart.js');

const repo = (files: Record<string, string>) => ({
  exists: (f: string) => f in files,
  read: (f: string) => files[f] ?? null,
});
const commands = (files: Record<string, string>) =>
  K.detectChecks(repo(files)).checks.map((c: { command: string }) => c.command);
const pkg = (scripts: object) => JSON.stringify({ scripts });

describe('detectChecks', () => {
  it('reads package.json scripts, and uses the package manager the lockfile shows', () => {
    const scripts = pkg({ test: 'vitest run', lint: 'eslint .', typecheck: 'tsc', build: 'vite build' });
    expect(commands({ 'package.json': scripts })).toEqual(['npm run typecheck', 'npm run lint', 'npm test', 'npm run build']);
    expect(commands({ 'package.json': scripts, 'pnpm-lock.yaml': '' })).toContain('pnpm test');
  });
  it('does not count the test placeholder from npm init as a check', () => {
    expect(commands({ 'package.json': pkg({ test: 'echo "Error: no test specified" && exit 1' }) })).toEqual([]);
  });
  it('a tsconfig without a script still gives a type check', () => {
    expect(commands({ 'package.json': pkg({}), 'tsconfig.json': '{}' })).toEqual(['npx tsc --noEmit']);
  });
  it('survives a broken package.json', () => {
    expect(commands({ 'package.json': '{ not json' })).toEqual([]);
  });
  it('reads Python tools, run through uv or poetry when the lockfile shows it', () => {
    const toml = '[tool.ruff]\nline-length = 100\n[tool.mypy]\nstrict = true\n';
    expect(commands({ 'pyproject.toml': toml, tests: '' })).toEqual(['mypy .', 'ruff check .', 'pytest']);
    expect(commands({ 'pyproject.toml': toml, 'uv.lock': '' })).toEqual(['uv run mypy .', 'uv run ruff check .']);
  });
  it('an unknown stack gives nothing, not a guess', () => {
    expect(K.detectChecks(repo({ 'go.mod': '' }))).toEqual({ stacks: [], checks: [] });
  });
});

describe('gateLists', () => {
  it('quick leaves out the build, full has it', () => {
    const lists = K.gateLists([
      { kind: 'test', command: 't' },
      { kind: 'build', command: 'b' },
    ]);
    expect(lists).toEqual({ quick: ['t'], full: ['t', 'b'] });
  });
});

describe('the steps', () => {
  const facts = (own: object = {}) => ({
    git: true, remote: 'github', stacks: ['Node'], checks: [], hasGates: false, ciHosts: [], secretsOk: true, ...own,
  });
  const next = (f: object, tasks: object[] = []) => K.nextStep(K.steps({ facts: facts(f), tasks }));
  const state = (key: string, f: object, tasks: object[] = []) =>
    K.steps({ facts: facts(f), tasks }).find((s: { key: string }) => s.key === key).state;

  it('no git comes first, and everything else waits', () => {
    expect(next({ git: false, remote: null }).key).toBe('git');
    expect(state('gates', { git: false, remote: null })).toBe('later');
    expect(state('secrets', { git: false, remote: null })).toBe('later');
  });
  it('checks that exist are used before anything is built, without a task', () => {
    const n = next({ checks: [{ kind: 'test', command: 'npm test', source: 'package.json' }] });
    expect(n.key).toBe('gates');
    expect(n.task).toBeUndefined();
    expect(n.how).toContain('npm test');
  });
  it('no checks at all becomes a task', () => {
    expect(next({}).task).toBe('first-check');
  });
  it('CI waits for gates, then is a task on GitHub', () => {
    expect(state('ci', {})).toBe('later');
    expect(next({ hasGates: true }).task).toBe('ci');
  });
  it('without a host CI is not asked of the user, and the text says why', () => {
    const f = { hasGates: true, remote: null };
    expect(next(f)).toBeNull();
    const ci = K.steps({ facts: facts(f) }).find((s: { key: string }) => s.key === 'ci');
    expect(ci.why).toContain('only on this computer');
  });
  it('a task in the queue is queued, a cancelled one stays declined and is not asked again', () => {
    expect(state('ci', { hasGates: true }, [{ id: 'KS-CI', status: 'proposed' }])).toBe('queued');
    expect(state('ci', { hasGates: true }, [{ id: 'KS-CI', status: 'cancelled' }])).toBe('declined');
    expect(next({ hasGates: true }, [{ id: 'KS-CI', status: 'cancelled' }])).toBeNull();
  });
  it('every task is an agent proposal, so it never starts by itself', () => {
    for (const key of ['first-check', 'secrets', 'ci']) {
      const t = K.taskFor(key, facts());
      expect(t.added_by).toContain('agent');
      expect(t.mission).toContain('Never push');
      expect(t.acceptance.length).toBeGreaterThan(0);
    }
  });
});
