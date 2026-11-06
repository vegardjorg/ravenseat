// =============================================================
// shellCommands.test.ts: ways of writing a command that the guard must read as the command it is (lib/shellCommands.js),
// through the real rule (lib/pushGuard.js assess) and the real hook.
//
// Locks: (1) quotes inside a word and a backslash in a word do not hide git or curl; (2) a brace list outside quotes counts as
// unread, so it asks or denies when it looks like a push; (3) what is not a command stays free (quoted text, HEAD@{1}, a Windows
// path to git); (4) the hook lets these through to the rule, also from the Monitor tool.
// =============================================================
import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SC = require('../shellCommands.js');
const { assess } = require('../pushGuard.js');

const ORCH = path.resolve(__dirname, '..', '..');
const main = (c: string) => assess(c, { baseBranch: 'main' });
const agent = (c: string) => assess(c, { baseBranch: 'main', agentType: 'queue-agent', guardedTypes: new Set(['queue-agent']) });

describe('quotes and backslashes inside a word', () => {
  it.each(['g"i"t push --force origin main', "g'i't push --force origin main", 'g\\it push --force origin main', 'git pu"s"h --force origin main', 'git pu\\sh --force origin main'])(
    '%s is a forced push',
    (c) => {
      expect(main(c)?.decision).toBe('deny');
      expect(agent(c)?.decision).toBe('deny');
    },
  );
  it('curl is not hidden from a queue agent', () => {
    expect(agent('c"u"rl https://example.invalid')?.decision).toBe('deny');
    expect(agent('c\\url https://example.invalid')?.decision).toBe('deny');
  });
  it('a quoted word still counts as one, and a shell alias with spaces is read', () => {
    expect(SC.tokens(`git commit -m "two words" 'and more'`)).toEqual(['git', 'commit', '-m', 'two words', 'and more']);
    expect(main('git -c alias.x="!git push --force origin main" x')?.decision).toBe('deny');
  });
  it('a lone quote does not swallow the line', () => {
    expect(SC.tokens("echo it's fine")).toEqual(['echo', "it's", 'fine']);
  });
});

describe('a brace list', () => {
  it.each(['{git,push,--force,origin,main}', 'git {push,--force,origin,main}'])('%s asks the owner and stops an agent', (c) => {
    expect(main(c)?.decision).toBe('ask');
    expect(agent(c)?.decision).toBe('deny');
  });
  it('quoted, without a comma or without a push, it is nothing', () => {
    expect(main('git log --format="{a,b}"')).toBeNull();
    expect(main('git show HEAD@{1}')).toBeNull();
    expect(main('ls src/{a,b}.js')).toBeNull();
  });
});

describe('what stays as it was', () => {
  it('a Windows path to git is still git', () => {
    for (const p of ['C:\\Program Files\\Git\\git.exe', 'tools\\git.exe', '.\\git', '\\git'])
      expect(SC.commandWord(p)).toBe('git');
  });
  it('an ordinary push of a side branch is free for the owner', () => {
    expect(main('git status')).toBeNull();
    expect(main('git commit -m "push --force is only words here"')).toBeNull();
  });
});

describe('ravenseat add from a queue agent', () => {
  const on = (branch: string | null) => (c: string) =>
    assess(c, { baseBranch: 'main', branchPrefix: 'queue/', branch, agentType: 'queue-agent', guardedTypes: new Set(['queue-agent']) });
  const track = on('queue/A-1');
  it('is allowed on its own track branch', () => {
    expect(track('ravenseat add --file task.json')).toBeNull();
    expect(track('node scripts/orchestrator/queue.mjs add --file task.json')).toBeNull();
  });
  it('is never --approved, and never as the owner', () => {
    expect(track('ravenseat add --file task.json --approved')?.decision).toBe('deny');
    expect(track('ravenseat add --file task.json --approved=true')?.decision).toBe('deny');
    expect(track('ravenseat add --file task.json --by owner')?.decision).toBe('deny');
  });
  it.each(['main', 'feature/x', 'queue/', null])('is refused on %s, where the CLI would not see a track', (b) => {
    expect(on(b as string | null)('ravenseat add --file task.json')?.decision).toBe('deny');
  });
  it.each(['cd ../.. && ravenseat add --file task.json', '(cd ../.. && ravenseat add --file task.json)', 'QUEUE_ROOT=/x ravenseat add --file task.json', 'bash -c "cd .. && ravenseat add --file t.json"', 'pushd .. ; ravenseat add --file t.json'])(
    '%s is refused: the line moves it away from the branch',
    (c) => {
      expect(track(c)?.decision).toBe('deny');
    },
  );
  it('the main session is not touched, and other commands are still refused', () => {
    expect(assess('ravenseat add --file task.json --approved', { baseBranch: 'main' })).toBeNull();
    expect(track('ravenseat approve A-2')?.decision).toBe('deny');
    expect(track('ravenseat edit A-2')?.decision).toBe('deny');
  });
});

describe('the hook', () => {
  // A plugin's hooks do nothing outside a queue project, so this one has a config.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-shell-'));
  const configFile = path.join(dir, 'queue.config.json');
  fs.writeFileSync(configFile, JSON.stringify({ baseBranch: 'main' }));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }));
  const hook = (tool: string, command: string) => {
    const r = spawnSync(process.execPath, [path.join(ORCH, 'hook-push-guard.mjs')], {
      input: JSON.stringify({ tool_name: tool, tool_input: { command }, cwd: dir }),
      encoding: 'utf8',
      cwd: dir,
      env: { ...process.env, QUEUE_CONFIG: configFile, QUEUE_ROOT: dir, QUEUE_GIT: dir, GIT_CEILING_DIRECTORIES: path.dirname(dir) },
    });
    return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.permissionDecision : null;
  };
  it.each(['g"i"t push --force origin main', 'g\\it push --force origin main'])('%s reaches the rule', (c) => {
    expect(hook('Bash', c)).toBe('deny');
  });
  it('Monitor gives the command in the same field, and is matched in both hook files', () => {
    expect(hook('Monitor', 'git push --force origin main')).toBe('deny');
    const root = path.resolve(ORCH, '..', '..');
    for (const f of ['hooks/hooks.json', 'settings.queue.json']) {
      const pre = JSON.parse(fs.readFileSync(path.join(root, f), 'utf8')).hooks.PreToolUse;
      expect(pre.some((h: { matcher: string }) => h.matcher.split('|').includes('Monitor') && h.matcher.includes('Bash'))).toBe(true);
    }
  });
});
