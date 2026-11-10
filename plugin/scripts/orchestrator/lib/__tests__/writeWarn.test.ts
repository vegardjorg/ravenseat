// =============================================================
// writeWarn.test.ts: the soft warning a track gets WHILE it writes (lib/writeWarn.js, hook-write-guard.mjs).
//
// Locks: a write to a protected path the task does not own, a new skip or focus marker in a test file, and a test file
// that loses its last assertion each give a warning with what happens at merge or receive; an owned path, an ordinary
// test edit and a moved marker give none. The hook gives the warning as additionalContext (never a denial), once per
// agent, file and kind, and only to track agents.
// Why: before this the track learned it only at merge or receive, after the whole round was spent.
// =============================================================
import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const WW = require('../writeWarn.js');

const task = { id: 'A-1', owned_files: ['src/a.ts', 'src/own/'], shared_patch: [] };
const warn = (o: Record<string, unknown>) => WW.assessTrackWrite({ task, protectedPaths: ['.github/', 'vitest.config.*', 'package.json'], ...o });

describe('what warns', () => {
  it('a protected path the task does not own warns; an owned one does not', () => {
    const w = warn({ rel: 'vitest.config.ts', before: 'x', after: 'y' });
    expect(w).toHaveLength(1);
    expect(w[0].kind).toBe('protected');
    expect(w[0].text).toContain('merge guard');
    expect(warn({ rel: '.github/workflows/ci.yml', before: null, after: 'y' })[0].kind).toBe('protected');
    expect(warn({ rel: 'vitest.config.ts', before: 'x', after: 'y', task: { ...task, owned_files: ['vitest.config.ts'] } })).toEqual([]);
    expect(warn({ rel: 'src/a.ts', before: 'x', after: 'y' })).toEqual([]);
  });

  it('the floor (.claude/) warns even with an empty protected list', () => {
    expect(WW.assessTrackWrite({ task, protectedPaths: [], rel: '.claude/settings.json', before: '{}', after: '{"a":1}' })[0].kind).toBe('protected');
  });

  it('a new skip or focus marker in a test file warns; a moved one does not', () => {
    const before = "it('a', () => { expect(1).toBe(1); });\n";
    const w = warn({ rel: 'src/own/a.test.ts', before, after: before + "it.skip('b', () => { expect(2).toBe(2); });\n" });
    expect(w.map((x: { kind: string }) => x.kind)).toEqual(['marker']);
    expect(w[0].text).toContain('it.skip(');
    expect(w[0].text).toContain('receive');
    // The same skip line already there (a move or re-indent) is not new.
    const old = "it.skip('b', () => {});\nit('a', () => { expect(1).toBe(1); });\n";
    expect(warn({ rel: 'src/own/a.test.ts', before: old, after: "it('a', () => { expect(1).toBe(1); });\n  it.skip('b', () => {});\n" })).toEqual([]);
    // A marker-looking line outside a test file is not a test.
    expect(warn({ rel: 'src/own/a.ts', before: '', after: "x.skip('b')\n" })).toEqual([]);
  });

  it('a test file that loses its last assertion warns; an ordinary edit does not', () => {
    const before = "it('a', () => {\n  expect(f()).toBe(1);\n});\n";
    const w = warn({ rel: 'src/own/a.test.ts', before, after: "it('a', () => {\n  f();\n});\n" });
    expect(w.map((x: { kind: string }) => x.kind)).toEqual(['emptied']);
    expect(warn({ rel: 'src/own/a.test.ts', before, after: before + "it('b', () => { expect(2).toBe(2); });\n" })).toEqual([]);
    // A new test file has no "before".
    expect(warn({ rel: 'src/own/b.test.ts', before: null, after: "it('b', () => {});\n" })).toEqual([]);
  });

  it('without a known task only the test warnings count (ownership cannot be judged)', () => {
    expect(WW.assessTrackWrite({ task: null, protectedPaths: ['vitest.config.*'], rel: 'vitest.config.ts', before: 'x', after: 'y' })).toEqual([]);
  });

  it('the text after an Edit: one replacement, or all with replace_all, and $ patterns stay literal', () => {
    expect(WW.afterEdit('a b a', { old_string: 'a', new_string: '$&x' })).toBe('$&x b a');
    expect(WW.afterEdit('a b a', { old_string: 'a', new_string: 'c', replace_all: true })).toBe('c b c');
    expect(WW.afterEdit('abc', { old_string: 'zz', new_string: 'y' })).toBeNull();
  });

  it('the repo-relative path from the nearest folder with .git', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-writewarn-root-'));
    temporary.push(root);
    fs.mkdirSync(path.join(root, '.git'));
    fs.mkdirSync(path.join(root, 'src'));
    expect(WW.repoRelative(path.join(root, 'src', 'a.ts'))).toBe('src/a.ts');
    expect(WW.repoRelative(path.join(os.tmpdir(), 'no-repo-here-xyz', 'a.ts'))).toBeNull();
  });
});

const temporary: string[] = [];
afterAll(() => {
  for (const f of temporary) fs.rmSync(f, { recursive: true, force: true });
});

describe('the hook', () => {
  const HOOK = path.resolve(__dirname, '..', '..', 'hook-write-guard.mjs');

  function project() {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-writewarn-'));
    temporary.push(folder);
    const repo = path.join(folder, 'wt');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    const data = path.join(folder, 'data');
    fs.mkdirSync(data);
    const configFile = path.join(folder, 'queue.config.json');
    fs.writeFileSync(configFile, JSON.stringify({ baseBranch: 'main' }));
    fs.writeFileSync(path.join(data, 'queue.json'), JSON.stringify({ created: '2026-01-01T00:00:00.000Z', limits: {}, resolved: [],
      tasks: [{ id: 'A-1', title: 'a', status: 'running', class: 'K', domain: 'd', value: 5, content_min: 30, depends_on: [], waiting_on: [], owned_files: ['src/a.ts'], mission: 'x' }] }));
    // The agent's transcript, with the mission at the top (how the hook finds the task).
    const sess = path.join(folder, 'tr', 'sess', 'subagents');
    fs.mkdirSync(sess, { recursive: true });
    fs.writeFileSync(path.join(sess, 'agent-ag1.jsonl'), JSON.stringify({ type: 'user', message: { content: 'You are track A-1. Read prompt-A-1.md.' } }) + '\n');
    const env = { ...process.env, QUEUE_FOLDER: data, QUEUE_CONFIG: configFile, QUEUE_ROOT: folder, WRITE_WARN_STATE: path.join(folder, 'state') } as NodeJS.ProcessEnv;
    const run = (agentType: string, file: string, toolInput: Record<string, unknown> = {}) => {
      const r = spawnSync(process.execPath, [HOOK], {
        input: JSON.stringify({ agent_type: agentType, agent_id: 'ag1', session_id: 'sess', transcript_path: path.join(folder, 'tr', 'sess.jsonl'),
          cwd: repo, tool_name: 'Write', tool_input: { file_path: path.join(repo, file), content: 'x', ...toolInput } }),
        encoding: 'utf8', env, cwd: repo,
      });
      return r.stdout ? JSON.parse(r.stdout) : null;
    };
    return { repo, run };
  }

  it('a track writing a protected path it does not own gets a warning, once; never a denial', () => {
    const p = project();
    const out = p.run('track', 'vitest.config.ts');
    expect(out.hookSpecificOutput.permissionDecision).toBeUndefined();
    expect(out.hookSpecificOutput.additionalContext).toContain('vitest.config.ts');
    expect(p.run('track', 'vitest.config.ts')).toBeNull();
    expect(p.run('track', 'src/a.ts')).toBeNull();
  });

  it('a reviewer or the main session gets no warning', () => {
    const p = project();
    expect(p.run('reviewer', 'vitest.config.ts')).toBeNull();
    expect(p.run('', 'vitest.config.ts')).toBeNull();
  });

  it('the denial for a state file still wins', () => {
    const p = project();
    expect(p.run('track', 'gate-evidence.json').hookSpecificOutput.permissionDecision).toBe('deny');
  });
});
