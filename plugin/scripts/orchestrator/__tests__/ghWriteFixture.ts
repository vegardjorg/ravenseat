// =============================================================
// ghWriteFixture.ts: the temporary queue, git repo and fake gh (QUEUE_GH) that __tests__/ghWrite.test.ts and
// __tests__/redteam/ghWrite.test.ts share. A repo with a GitHub-looking origin whose remote refs are set by hand (no
// real push), a queue folder, and a gh module that answers from a JSON file and logs every call. Never the real gh.
// =============================================================
import { afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..', '..');
export { ROOT };
const QUEUE = path.join(ROOT, 'scripts', 'orchestrator', 'queue.mjs');
const ID = ['-c', 'user.name=queue-test', '-c', 'user.email=queue-test@example.invalid'];

const temporary: string[] = [];
afterAll(() => {
  for (const m of temporary) {
    try {
      fs.rmSync(m, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    } catch {
      /* left for the OS */
    }
  }
});

export type GhState = { prs?: { number: number; url: string }[]; fail?: boolean; visibility?: string };

export function setup(config: Record<string, unknown> = {}, { visibility = 'private' as string | null } = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-ghwrite-'));
  temporary.push(folder);
  const repo = path.join(folder, 'repo');
  fs.mkdirSync(repo);
  const g = (args: string[]) => execFileSync('git', ['-C', repo, ...ID, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  g(['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(repo, 'README.md'), 'start\n');
  g(['add', '--', 'README.md']);
  g(['commit', '-q', '-m', 'start']);
  g(['tag', 'v1.0.0']);
  g(['remote', 'add', 'origin', 'https://github.com/acme/tool.git']);
  g(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  /** A merged task: a branch queue/<id> with one commit, merged with --no-ff as ravenseat merge does. */
  const merge = (id: string) => {
    g(['checkout', '-q', '-b', `queue/${id}`]);
    fs.writeFileSync(path.join(repo, `${id}.txt`), `${id}\n`);
    g(['add', '--', `${id}.txt`]);
    g(['commit', '-q', '-m', `work ${id}`]);
    g(['checkout', '-q', 'main']);
    g(['merge', '-q', '--no-ff', '--no-edit', `queue/${id}`]);
    return g(['rev-parse', 'HEAD']);
  };
  const pushed = () => g(['update-ref', 'refs/remotes/origin/main', 'refs/heads/main']);
  const configFile = path.join(folder, 'queue.config.json');
  fs.writeFileSync(configFile, JSON.stringify({ baseBranch: 'main', ...config }));
  const writeQueue = (tasks: Record<string, unknown>[]) =>
    fs.writeFileSync(
      path.join(folder, 'queue.json'),
      JSON.stringify({ created: '2026-01-01T00:00:00.000Z', limits: {}, resolved: [], projects: { app: { title: 'App', prefixes: ['A-'] } }, tasks }),
    );
  writeQueue([]);
  if (visibility)
    fs.writeFileSync(
      path.join(folder, 'repo-visibility.json'),
      JSON.stringify({ visibility, source: 'gh', remote: 'https://github.com/acme/tool.git', checkedAt: new Date().toISOString() }),
    );
  const state = path.join(folder, 'gh-state.json');
  const calls = path.join(folder, 'gh-calls.jsonl');
  const gh = path.join(folder, 'gh.mjs');
  fs.writeFileSync(
    gh,
    [
      "import fs from 'node:fs';",
      'export default (args) => {',
      `  fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');`,
      `  const s = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, 'utf8'));`,
      "  if (s.fail && args[0] !== 'repo') return { code: 1, out: '', err: 'HTTP 502: Bad Gateway' };",
      "  if (args[0] === 'repo' && args[1] === 'view') return { code: 0, out: JSON.stringify({ visibility: (s.visibility || 'PRIVATE') }), err: '' };",
      "  if (args[0] === 'pr' && args[1] === 'list') return { code: 0, out: JSON.stringify(s.prs || []), err: '' };",
      "  if (args[0] === 'pr' && args[1] === 'create') return { code: 0, out: 'https://github.com/acme/tool/pull/7\\n', err: '' };",
      "  if (args[0] === 'issue' && (args[1] === 'comment' || args[1] === 'close')) return { code: 0, out: 'https://github.com/acme/tool/issues/' + args[2] + '\\n', err: '' };",
      "  if (args[0] === 'release' && args[1] === 'create') return { code: 0, out: 'https://github.com/acme/tool/releases/tag/untagged-1\\n', err: '' };",
      "  return { code: 1, out: '', err: 'unknown gh call' };",
      '};',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(state, JSON.stringify({}));
  const env = {
    ...process.env,
    QUEUE_FOLDER: folder,
    QUEUE_CONFIG: configFile,
    QUEUE_ROOT: repo,
    QUEUE_GIT: repo,
    QUEUE_TIME_LOG: path.join(folder, 'times.jsonl'),
    QUEUE_GH: gh,
    QUEUE_WAIT: 'off',
  } as NodeJS.ProcessEnv;
  for (const k of ['QUEUE_SCRATCHPAD', 'QUEUE_SESSION', 'GH_TOKEN', 'GITHUB_TOKEN']) delete env[k];
  const setGh = (s: GhState) => fs.writeFileSync(state, JSON.stringify(s));
  const rs = (args: string[], { cwd = repo }: { cwd?: string } = {}) => {
    const r = spawnSync(process.execPath, [QUEUE, ...args], { encoding: 'utf8', env, cwd, timeout: 60_000 });
    return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  const ghCalls = (): string[][] => {
    try {
      return fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  };
  const writes = () => ghCalls().filter((c) => !(c[0] === 'repo' && c[1] === 'view') && !(c[0] === 'pr' && c[1] === 'list'));
  return { folder, repo, g, merge, pushed, writeQueue, setGh, rs, ghCalls, writes, configFile };
}

export const done = (id: string, mergeCommit: string, over: Record<string, unknown> = {}) => ({
  id,
  title: `Task ${id}`,
  status: 'done',
  class: 'K',
  domain: 'app',
  project: 'app',
  feature: 'f',
  mission: 'm',
  merge_commit: mergeCommit,
  ...over,
});

