// =============================================================
// queueDispatch.test.ts: every command word queue.mjs dispatches on reaches a function that exists, and a command
// starts one node process and loads only the cli/ module it needs (review 2026-11-11, E2).
//
// Why: queue.mjs is a thin entry point; the commands live in cli/*.mjs. A dispatch line that names a function a module
// does not export, or an async command that is not awaited, would only show up when someone runs that one command.
// This test reads the dispatch chain (no spawn, nothing runs): each `command === '<word>'` branch loads its module with
// `(await import('./cli/<module>.mjs')).<function>()`, and that module exports the function. An async command function
// must be called with await. The words themselves are kept in step with QUEUE_COMMANDS in lib/__tests__/cliHelp.test.ts.
// The modules are loaded per branch (not at the top), so `ravenseat mode` does not load all ~28 of them. Since a module
// is then the first cli/ module to load, each one dispatched is loaded on its own in a fresh process: an import cycle
// that only worked in the old fixed order would fail here, not when someone runs that command.
// Also: every cli/*.mjs module is loaded by queue.mjs, by another cli/ module, or by another entry script with import()
// (push-check.mjs --watch-ci loads cli/ciWatch.mjs), so none is left behind.
// And: `ravenseat <queue command>` runs queue.mjs in its own process (no second node), with the same output and exit code.
// =============================================================
import { afterAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DIR = path.resolve(__dirname, '..');
const SOURCE = fs.readFileSync(path.join(DIR, 'queue.mjs'), 'utf8');
const CLI = path.join(DIR, 'cli');
const MODULES = fs.readdirSync(CLI).filter((f) => f.endsWith('.mjs'));
const text = (f: string) => fs.readFileSync(path.join(CLI, f), 'utf8');

/** Each dispatch branch: the command word(s) in its test, the module it loads and the function it calls. */
const BRANCHES = [
  ...SOURCE.matchAll(
    /(?:^if|^\} else if) \(([\s\S]*?)\) \{\n(?:\s*\/\/[^\n]*\n)*\s*(await )?\(await import\('\.\/cli\/([\w.]+\.mjs)'\)\)\.(\w+)\(\);\n/gm,
  ),
].map((m) => ({
  words: [...m[1].matchAll(/command === '([A-Za-z-]+)'/g)].map((w) => w[1]),
  awaited: Boolean(m[2]),
  file: m[3],
  fn: m[4],
}));
const H = require('../lib/cliHelp') as { QUEUE_COMMANDS: string[] };

describe('the dispatch in queue.mjs', () => {
  it('every QUEUE_COMMANDS word has a branch that calls a module function', () => {
    const dispatched = new Set(BRANCHES.flatMap((b) => b.words));
    for (const c of H.QUEUE_COMMANDS) expect(dispatched.has(c), c).toBe(true);
    expect(BRANCHES.length).toBeGreaterThanOrEqual(H.QUEUE_COMMANDS.length);
  });

  it('each call names a cli/ module that exports the function (async ones are awaited)', () => {
    for (const b of BRANCHES) {
      expect(MODULES, `${b.words.join('/')}: ${b.file}`).toContain(b.file);
      const src = text(b.file);
      const def = new RegExp(`^export (async )?function ${b.fn}\\(`, 'm').exec(src);
      expect(def, `${b.words.join('/')}: ${b.file} exports ${b.fn}`).toBeTruthy();
      expect(b.awaited, `${b.words.join('/')}: ${b.fn} is ${def![1] ? 'async' : 'sync'}`).toBe(Boolean(def![1]));
    }
  });

  it('loads a command module only in its branch: the only cli/ module imported at the top is context.mjs', () => {
    const top = [...SOURCE.matchAll(/^import [^\n]* from '\.\/cli\/([\w.]+\.mjs)';$/gm)].map((m) => m[1]);
    expect(top).toEqual(['context.mjs']);
    // Every dynamic import of a cli/ module in queue.mjs is a dispatch branch the regex above understood.
    const dynamic = [...SOURCE.matchAll(/import\('\.\/cli\/([\w.]+\.mjs)'\)/g)].length;
    expect(dynamic).toBe(BRANCHES.length);
  });

  it('every cli/ module is used', () => {
    const imported = new Set(['context.mjs', ...BRANCHES.map((b) => b.file)]);
    for (const f of MODULES) for (const m of text(f).matchAll(/from '\.\/([\w.]+\.mjs)'/g)) imported.add(m[1]);
    // The other entry scripts next to queue.mjs that load a cli/ module themselves (push-check.mjs --watch-ci).
    for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.mjs') && x !== 'queue.mjs'))
      for (const m of fs.readFileSync(path.join(DIR, f), 'utf8').matchAll(/import\('\.\/cli\/([\w.]+\.mjs)'\)/g)) imported.add(m[1]);
    for (const f of MODULES) expect(imported.has(f), f).toBe(true);
  });

  it('each dispatched module loads on its own, as the first cli/ module of a fresh process (no import cycle trap)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ravenseat-dispatch-'));
    try {
      const env = { ...process.env, QUEUE_ROOT: root, QUEUE_FOLDER: path.join(root, 'q'), QUEUE_GIT: root, QUEUE_TIME_LOG: path.join(root, 'times.jsonl') };
      const files = [...new Set(BRANCHES.map((b) => b.file))];
      expect(files.length).toBeGreaterThan(20);
      // Async (not spawnSync), so the small processes run side by side.
      const results = await Promise.all(
        files.map(
          (f) =>
            new Promise<{ f: string; code: number | null; err: string }>((resolve) => {
              const url = pathToFileURL(path.join(CLI, f)).href;
              // argv[2] is a command word that is not doctor or help, as when queue.mjs runs a command.
              const p = spawn(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(url)});`, 'load-check'], { cwd: root, env });
              let err = '';
              p.stderr.on('data', (d) => (err += d));
              p.on('close', (code) => resolve({ f, code, err }));
            }),
        ),
      );
      for (const r of results) expect({ f: r.f, code: r.code, err: r.err.split('\n').slice(0, 3).join('\n') }).toEqual({ f: r.f, code: 0, err: '' });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('ravenseat.mjs runs a queue command in its own process', () => {
  // A preload (NODE_OPTIONS --require, which every node child inherits) writes one line per node process that starts.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ravenseat-oneproc-'));
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
  const pids = path.join(root, 'pids.txt');
  const preload = path.join(root, 'preload.cjs');
  fs.writeFileSync(preload, `require('fs').appendFileSync(${JSON.stringify(pids)}, process.pid + '\\n');\n`);
  const env = {
    ...process.env,
    QUEUE_ROOT: root,
    QUEUE_FOLDER: path.join(root, 'q'),
    QUEUE_GIT: root,
    QUEUE_TIME_LOG: path.join(root, 'times.jsonl'),
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require "${preload.replace(/\\/g, '/')}"`.trim(),
  };
  const spawnIt = (file: string, args: string[]) => {
    fs.rmSync(pids, { force: true });
    const r = spawnSync(process.execPath, [path.join(DIR, file), ...args], { cwd: root, env, encoding: 'utf8' });
    return { ...r, started: fs.readFileSync(pids, 'utf8').trim().split('\n') };
  };

  it('`ravenseat mode` is one node process, with the output queue.mjs gives on its own', () => {
    const r = spawnIt('ravenseat.mjs', ['mode']);
    const direct = spawnIt('queue.mjs', ['mode']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^Mode: /);
    expect(r.started).toHaveLength(1);
    expect(r.stdout).toBe(direct.stdout);
    expect(r.stderr).toBe(direct.stderr);
  });

  it('`ravenseat queue mode` (written out) is the same, and an unknown command keeps its message and exit code', () => {
    const q = spawnIt('ravenseat.mjs', ['queue', 'mode']);
    expect(q.status).toBe(0);
    expect(q.started).toHaveLength(1);
    expect(q.stdout).toMatch(/^Mode: /);
    const bad = spawnIt('ravenseat.mjs', ['stats-typo']);
    const direct = spawnIt('queue.mjs', ['stats-typo']);
    expect(bad.status).toBe(1);
    expect(bad.started).toHaveLength(1);
    expect(bad.stdout).toBe(direct.stdout);
    expect(bad.stderr).toBe(direct.stderr);
    expect(bad.stderr).toMatch(/Unknown command "stats-typo"/);
  });
});
