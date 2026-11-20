// =============================================================
// allowlistSecrets.test.ts: the approved commands in Claude Code's settings files, run through the secret patterns
// (lib/allowlistSecrets.js and secretScan.matchLine).
//
// Why: "don't ask again" stores the whole command in permissions.allow. A key typed in the command then sits in clear
// text in .claude/settings.local.json (often only ignored by the user's global gitignore) or in the tracked
// .claude/settings.json. A hit must name the file, the list and the index, and NEVER the rule text or the value: the
// doctor output and the transcript would otherwise copy the key around. The fake keys are joined at run time, so this
// file holds none of them literally.
// =============================================================
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { matchLine } from '../secretScan';
import { rulesOf, scanSettings, scanTrees, settingsFiles } from '../allowlistSecrets';

const GH = ['gh', 'p_', 'x'.repeat(36)].join('');
const AWS = ['AK', 'IA', 'QX7TFAKE', 'KEY4ALLO'].join('');
const GENERIC_VALUE = ['q8Zr2Lm9', 'Xw4Tb7Kd1Vn6'].join('');

const temporary: string[] = [];
afterAll(() => {
  for (const d of temporary) fs.rmSync(d, { recursive: true, force: true });
});

const settings = (permissions: Record<string, unknown>) => JSON.stringify({ permissions }, null, 2);

describe('secretScan.matchLine', () => {
  it('gives the rule id of a provider format in any file, and null for a clean line', () => {
    expect(matchLine(`curl -H "Authorization: token ${GH}" https://api.example.com`, '.claude/settings.local.json')).toBe('github-token');
    expect(matchLine(`echo ${AWS}`, 'lib/__tests__/x.test.ts')).toBe('aws-access-key');
    expect(matchLine('Bash(npm test)', '.claude/settings.json')).toBeNull();
  });

  it('the context rules (generic name = value) count outside test and docs files only', () => {
    const line = `Bash(API_KEY=${GENERIC_VALUE} node deploy.js)`;
    expect(matchLine(line, '.claude/settings.local.json')).toBe('generic-secret');
    expect(matchLine(line, 'docs/notes.md')).toBeNull();
    expect(matchLine('Bash(API_KEY=$API_KEY node deploy.js)', '.claude/settings.local.json')).toBeNull();
  });
});

describe('rulesOf and scanSettings', () => {
  it('reads allow, ask and deny with their index; other keys and non-strings are skipped', () => {
    const text = settings({ allow: ['Bash(npm test)', 3, 'Bash(git status)'], ask: ['Bash(rm *)'], deny: [], additionalDirectories: ['x'] });
    expect(rulesOf(text)).toEqual([
      { list: 'allow', index: 0, rule: 'Bash(npm test)' },
      { list: 'allow', index: 2, rule: 'Bash(git status)' },
      { list: 'ask', index: 0, rule: 'Bash(rm *)' },
    ]);
  });

  it('a file that is not JSON, or has no permissions, gives no rules (never a crash)', () => {
    expect(rulesOf('{ not json')).toEqual([]);
    expect(rulesOf('{}')).toEqual([]);
    expect(rulesOf(JSON.stringify({ permissions: { allow: 'Bash(x)' } }))).toEqual([]);
  });

  it('a hit names the file, the list, the index and the rule id, never the rule text or the value', () => {
    const text = settings({
      allow: ['Bash(npm test)', `Bash(curl -H "Authorization: token ${GH}" https://api.example.com)`],
      deny: [`Bash(API_KEY=${GENERIC_VALUE} node x.js)`],
    });
    const hits = scanSettings(text, '.claude/settings.local.json');
    expect(hits).toEqual([
      { file: '.claude/settings.local.json', list: 'allow', index: 1, rule: 'github-token' },
      { file: '.claude/settings.local.json', list: 'deny', index: 0, rule: 'generic-secret' },
    ]);
    const shown = JSON.stringify(hits);
    expect(shown).not.toContain(GH);
    expect(shown).not.toContain(GENERIC_VALUE);
    expect(shown).not.toContain('curl');
  });
});

describe('settingsFiles and scanTrees (a temporary project)', () => {
  /** A main tree with its two settings files and two agent worktrees under .claude/worktrees/. */
  function tree() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ravenseat-allowlist-'));
    temporary.push(root);
    const put = (rel: string, text: string) => {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), text);
    };
    put('.claude/settings.json', settings({ allow: ['Bash(npm test)'] }));
    put('.claude/settings.local.json', settings({ allow: ['Bash(git status)', `Bash(echo ${AWS})`] }));
    put('.claude/worktrees/agent-A/.claude/settings.local.json', settings({ allow: [`Bash(gh api -H "token ${GH}")`] }));
    put('.claude/worktrees/agent-B/.claude/settings.json', settings({ ask: ['Bash(ls)'] }));
    // A loose file in the worktrees folder is not a worktree.
    put('.claude/worktrees/notes.txt', 'x');
    return root;
  }

  it('lists the main tree files and each worktree folder, in a stable order, with forward slashes', () => {
    const root = tree();
    expect(settingsFiles(root).map((f) => f.file)).toEqual([
      '.claude/settings.json',
      '.claude/settings.local.json',
      '.claude/worktrees/agent-A/.claude/settings.json',
      '.claude/worktrees/agent-A/.claude/settings.local.json',
      '.claude/worktrees/agent-B/.claude/settings.json',
      '.claude/worktrees/agent-B/.claude/settings.local.json',
    ]);
    const a = settingsFiles(root).find((f) => f.file.includes('agent-A') && f.file.endsWith('local.json'));
    expect(a).toMatchObject({ tree: '.claude/worktrees/agent-A', inTree: '.claude/settings.local.json' });
  });

  it('finds the hits in the main tree and in the agents\' worktrees; a missing file is skipped', () => {
    const root = tree();
    const hits = scanTrees(root);
    expect(hits.map((h) => [h.file, h.list, h.index, h.rule])).toEqual([
      ['.claude/settings.local.json', 'allow', 1, 'aws-access-key'],
      ['.claude/worktrees/agent-A/.claude/settings.local.json', 'allow', 0, 'github-token'],
    ]);
    expect(hits[1]).toMatchObject({ tree: '.claude/worktrees/agent-A', inTree: '.claude/settings.local.json' });
    expect(JSON.stringify(hits)).not.toContain(AWS);
  });

  it('a tree from io.worktrees outside the main tree is read too, named by its own path; a listed .claude/worktrees folder once', () => {
    const root = tree();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ravenseat-allowlist-outside-'));
    temporary.push(outside);
    fs.mkdirSync(path.join(outside, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(outside, '.claude', 'settings.local.json'), settings({ allow: [`Bash(echo ${GH})`] }));
    const worktrees = () => [root, outside, path.join(root, '.claude', 'worktrees', 'agent-A')];
    const files = settingsFiles(root, { worktrees });
    const outsideTree = outside.replace(/\\/g, '/');
    expect(files.filter((f) => f.tree === '.claude/worktrees/agent-A')).toHaveLength(2);
    expect(files.filter((f) => f.tree === outsideTree).map((f) => f.inTree)).toEqual(['.claude/settings.json', '.claude/settings.local.json']);
    const hits = scanTrees(root, { worktrees });
    const hit = hits.find((h) => h.tree === outsideTree);
    expect(hit).toMatchObject({ file: `${outsideTree}/.claude/settings.local.json`, list: 'allow', index: 0, rule: 'github-token' });
    expect(hit?.abs).toBe(path.join(outside, '.claude', 'settings.local.json'));
  });

  it('a password of any length in an approved command is a hit (password-flag, secret-env), placeholders are not', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ravenseat-allowlist-short-'));
    temporary.push(root);
    const pw = ['fake', 'pw', '7'].join('');
    fs.mkdirSync(path.join(root, '.claude'));
    fs.writeFileSync(
      path.join(root, '.claude', 'settings.local.json'),
      settings({
        allow: [`Bash(psql --password ${pw} -h db)`, `Bash(PGPASSWORD=${pw} psql:*)`, 'Bash(PGPASSWORD=$PGPASSWORD psql)', 'Bash(tool --password ***)', `Bash(sshpass -p ${pw} ssh host)`],
      }),
    );
    const hits = scanTrees(root, { worktrees: () => [] });
    expect(hits.map((h) => [h.index, h.rule])).toEqual([
      [0, 'password-flag'],
      [1, 'secret-env'],
      [4, 'password-flag'],
    ]);
    expect(JSON.stringify(hits)).not.toContain(pw);
  });

  it('reads the worktrees git lists, also outside the main tree (a real repo)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ravenseat-allowlist-git-'));
    temporary.push(root);
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: root, stdio: 'pipe' });
    git('init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(root, 'README.md'), 'x\n');
    git('add', '.');
    git('commit', '-q', '-m', 'start');
    const outside = `${root}-track`;
    temporary.push(outside);
    git('worktree', 'add', '-q', outside, '-b', 'track');
    fs.mkdirSync(path.join(outside, '.claude'));
    fs.writeFileSync(path.join(outside, '.claude', 'settings.local.json'), settings({ allow: [`Bash(echo ${AWS})`] }));
    const hits = scanTrees(root);
    expect(hits.map((h) => [h.tree, h.rule])).toEqual([[outside.replace(/\\/g, '/'), 'aws-access-key']]);
  });

  it('a project without .claude gives nothing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ravenseat-allowlist-empty-'));
    temporary.push(root);
    expect(scanTrees(root)).toEqual([]);
  });
});
