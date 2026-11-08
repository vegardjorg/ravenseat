// =============================================================
// redteam/rt14-missing-tool.test.ts: scenario 14 "a tool the queue needs is missing" (plans/redteam-plan.md).
//
// Why: the queue runs git for everything, the hooks start `node` from PATH without a shell, the CI watch runs gh and a
// cloud session runs claude. A tool that is not there must be named as the cause, with what to do, and must not leave
// a task half started. Each case runs the real CLI with a PATH that lacks that one tool (node itself is started by its
// full path). Where the machine keeps the tool in the same folder as one that is needed (a Linux /usr/bin, say), the case
// cannot strip it and is skipped; it says so. A node that is too old is a fake one first on PATH (it prints v18.0.0),
// and a gate whose program is not installed is a `pytest -q` and a `cargo test` with neither on PATH. An old git (no git merge-tree --write-tree) is in conflictPredict.test.ts.
// =============================================================
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expectUserThingsIntact, snapshot } from './lab';
import { project, SCRIPTS, tmp } from './project';

const NODE_DIR = path.dirname(process.execPath);
/** The folder git keeps its own binary in (git --exec-path): git without the rest of the folder git lives in. */
const GIT_DIR = (() => {
  const dir = spawnSync('git', ['--exec-path'], { encoding: 'utf8' }).stdout.trim();
  return fs.existsSync(path.join(dir, process.platform === 'win32' ? 'git.exe' : 'git')) ? dir : null;
})();
/** The system folder Windows programs expect on PATH. */
const SYSTEM = process.env.SystemRoot ? [path.join(process.env.SystemRoot, 'System32')] : [];

/** The env with PATH set to exactly these folders (every case variant of the key goes, Windows has "Path"). */
function withPath(env: NodeJS.ProcessEnv, dirs: (string | null)[]) {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const k of Object.keys(out)) if (k.toLowerCase() === 'path') delete out[k];
  out.PATH = [...dirs.filter(Boolean), ...SYSTEM].join(path.delimiter);
  return out;
}
/** Is the tool found with this env? When it is, the PATH could not be stripped of it here. */
const finds = (tool: string, env: NodeJS.ProcessEnv) => !spawnSync(tool, ['--version'], { env, stdio: 'ignore' }).error;

/**
 * A folder with a fake `node` that prints v18.0.0 for --version, or null when it cannot be made here. Elsewhere a shell
 * script; on Windows a node.exe compiled with the csc of .NET Framework (the hooks spawn "node" without a shell, and
 * that finds .exe and .com only). Built once per run.
 */
let oldNode: string | null | undefined;
function fakeOldNode(): string | null {
  if (oldNode !== undefined) return oldNode;
  const dir = tmp('rt14-old-node-');
  if (process.platform !== 'win32') {
    fs.writeFileSync(path.join(dir, 'node'), '#!/bin/sh\necho v18.0.0\n', { mode: 0o755 });
    return (oldNode = dir);
  }
  const root = process.env.SystemRoot ?? 'C:\\Windows';
  const csc = ['Framework64', 'Framework']
    .map((f) => path.join(root, 'Microsoft.NET', f, 'v4.0.30319', 'csc.exe'))
    .find((f) => fs.existsSync(f));
  if (!csc) return (oldNode = null);
  const source = path.join(dir, 'node.cs');
  fs.writeFileSync(source, 'class P { static int Main() { System.Console.WriteLine("v18.0.0"); return 0; } }\n');
  const r = spawnSync(csc, ['/nologo', `/out:${path.join(dir, 'node.exe')}`, source], { cwd: dir, encoding: 'utf8' });
  return (oldNode = r.status === 0 && fs.existsSync(path.join(dir, 'node.exe')) ? dir : null);
}

const runIn = (env: NodeJS.ProcessEnv, cwd: string, script: string, ...args: string[]) => {
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], { encoding: 'utf8', env, cwd, timeout: 120_000 });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};

describe('scenario 14: a tool the queue needs is missing', () => {
  it('git is not on PATH: doctor fails on it by name, and changes nothing', (ctx) => {
    const p = project();
    const env = withPath(p.env, [NODE_DIR]);
    if (finds('git', env)) ctx.skip();
    const before = snapshot(p.repo, p.folder);
    const d = runIn(env, p.repo, 'queue.mjs', 'doctor');
    expect(d.code, d.out).toBe(1);
    expect(d.out).toMatch(/^FAIL {2}git {8}`git` is not found on PATH/m);
    expect(d.out).toMatch(/fix: install git and put it on PATH/);
    expectUserThingsIntact(before);
  }, 120_000);

  it('node is not on PATH for the hooks: doctor fails on it by name', (ctx) => {
    const p = project();
    const env = withPath(p.env, [GIT_DIR]);
    if (!GIT_DIR || finds('node', env) || !finds('git', env)) ctx.skip();
    const d = runIn(env, p.repo, 'queue.mjs', 'doctor');
    expect(d.code, d.out).toBe(1);
    expect(d.out).toMatch(/^FAIL {2}node {7}`node` is not found on PATH; the hooks start it as "node" without a shell$/m);
    expect(d.out).toMatch(/fix: put the Node folder on PATH/);
  }, 120_000);

  it('a node that is too old comes first on PATH for the hooks: doctor fails on its version', (ctx) => {
    // The fake is a real program that prints v18.0.0 for --version, found the way the hooks find node (no shell, so a
    // .cmd would not count on Windows): a shell script elsewhere, a tiny node.exe built with the .NET csc on Windows.
    const dir = fakeOldNode();
    if (!dir || !GIT_DIR) ctx.skip();
    const p = project();
    const env = withPath(p.env, [dir, NODE_DIR, GIT_DIR]);
    expect(spawnSync('node', ['--version'], { env, encoding: 'utf8' }).stdout.trim()).toBe('v18.0.0');
    const before = snapshot(p.repo, p.folder);
    const d = runIn(env, p.repo, 'queue.mjs', 'doctor');
    expect(d.code, d.out).toBe(1);
    // This command itself runs a new Node (by its full path): only the hooks' node is too old.
    expect(d.out).toMatch(new RegExp(`^OK {4}node {7}Node ${process.versions.node.replace(/\./g, '\\.')}$`, 'm'));
    expect(d.out).toMatch(/^FAIL {2}node {7}the hooks get v18\.0\.0 from PATH, older than 20$/m);
    expect(d.out).toMatch(/fix: put a newer Node first on PATH/);
    expectUserThingsIntact(before);
  }, 120_000);

  it('a gate whose program is not installed (pytest, cargo): doctor warns by name, and runs no gate', (ctx) => {
    const marker = path.join(tmp('rt14-gate-'), 'ran');
    const p = project({ gates: ['pytest -q', 'cargo test', `node -e "require('fs').writeFileSync(process.argv[1], 'x')" "${marker}"`] });
    const env = withPath(p.env, [NODE_DIR, GIT_DIR]);
    if (!GIT_DIR || finds('pytest', env) || finds('cargo', env)) ctx.skip();
    const before = snapshot(p.repo, p.folder);
    const d = runIn(env, p.repo, 'queue.mjs', 'doctor');
    expect(d.out).toMatch(/^WARN {2}gates {6}gate program\(s\) not found on PATH: pytest \(in "pytest -q"\), cargo \(in "cargo test"\)\. Such a gate is red on every run$/m);
    expect(d.out).toMatch(/fix: install the program and put its folder on PATH for Claude Code/);
    // A warning, not a stop (the agents' PATH may differ), and node, which is there, is not named.
    expect(d.out).not.toMatch(/^FAIL {2}gates/m);
    expect(d.out).not.toMatch(/not found on PATH: [^\n]*\bnode \(/);
    expect(fs.existsSync(marker)).toBe(false);
    expectUserThingsIntact(before);
  }, 120_000);

  it('gh is not on PATH with the CI watch on: it says so and watches nothing', (ctx) => {
    const p = project({ config: { push: { ciWatch: 'github' } } });
    const env = withPath(p.env, [NODE_DIR, GIT_DIR]);
    if (!GIT_DIR || finds('gh', env) || !finds('git', env)) ctx.skip();
    const before = snapshot(p.repo, p.folder);
    const r = runIn(env, p.repo, 'push-check.mjs', '--watch-ci', p.g(['rev-parse', 'main']));
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain('CI WATCH: gh (the GitHub CLI) was not found; install it and run gh auth login. Nothing watched.');
    expectUserThingsIntact(before);
  }, 120_000);

  it('claude is not installed at cloud-start: it says so, and the task goes back to waiting', () => {
    // project() points QUEUE_CLOUD_FAKE_CLAUDE at a file that does not exist: claude counts as not installed.
    const p = project();
    const before = snapshot(p.repo, p.folder);
    const r = runIn(p.env, p.repo, 'cloud-start.mjs', 'A', '--allow-upload');
    expect(r.code, r.out).not.toBe(0);
    expect(r.out).toMatch(/Could not start claude \(ENOENT\)\. Is Claude Code installed and on PATH\? No session started\./);
    expect(p.taskOf('A')?.status).toBe('waiting');
    expectUserThingsIntact(before);
  }, 120_000);
});
