// =============================================================
// controlFiles.test.ts: the main tree's control files (lib/controlFiles.js): what counts as one, the write guard for
// the file tools and for a shell line, and the fingerprint fill records and receive compares.
//
// Why: a track runs as the owner, so it can write the main tree's queue.config.json, .claude/, CLAUDE*.md, .git/hooks,
// .git/config and the plugin's own scripts. Those steer the orchestrator, the guards and every later session, and a
// write there gets around every flag the push guard denies (plans/ekstern-saas-vurdering-2026-11-15.md, F1).
// =============================================================
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const CF = require('../controlFiles.js') as any;
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

const MAIN = path.resolve(os.tmpdir(), 'cf-main');
const SCRIPTS = path.resolve(os.tmpdir(), 'cf-plugin', 'scripts', 'orchestrator');
const WT = path.resolve(os.tmpdir(), 'cf-worktrees', 'A');
const where = { mainTree: MAIN, scriptsDir: SCRIPTS, configFile: path.join(MAIN, 'queue.config.json') };
const m = (...p: string[]) => path.join(MAIN, ...p);

describe('controlKind: what is a control file of the main tree', () => {
  it.each([
    [m('queue.config.json'), 'queue.config.json'],
    [m('.claude', 'settings.json'), '.claude/'],
    [m('.claude', 'settings.local.json'), '.claude/'],
    [m('.claude', 'agents', 'track.md'), '.claude/'],
    [m('CLAUDE.md'), 'CLAUDE*.md'],
    [m('CLAUDE.local.md'), 'CLAUDE*.md'],
    [m('docs', 'CLAUDE.md'), 'CLAUDE*.md'],
    [m('.git', 'hooks', 'pre-commit'), '.git/hooks/'],
    [m('.git', 'config'), '.git/config'],
    [path.join(SCRIPTS, 'lib', 'pushGuard.js'), "the plugin's scripts"],
  ])('%s is %s', (file, kind) => {
    expect(CF.controlKind(file, where)).toBe(kind);
  });

  it.each([
    [m('src', 'app.ts')],
    [m('README.md')],
    [m('.claude', 'worktrees', 'agent-A', '.claude', 'settings.json')],
    [m('.claude', 'worktrees', 'agent-A', 'CLAUDE.md')],
    [m('.git', 'worktrees', 'A', 'HEAD')],
    [path.join(WT, '.claude', 'settings.json')],
    [path.join(WT, 'queue.config.json')],
    [path.join(WT, 'CLAUDE.md')],
  ])('%s is not', (file) => {
    expect(CF.controlKind(file, where)).toBeNull();
  });

  it('a queue.config.json elsewhere (QUEUE_CONFIG) is the config too', () => {
    const other = path.resolve(os.tmpdir(), 'cf-folder', 'queue.config.json');
    expect(CF.controlKind(other, { ...where, configFile: other })).toBe('queue.config.json');
  });
});

describe('assessControlWrite: the file tools', () => {
  const base = { ...where, guardedTypes: new Set<string>() };
  it('a track writing the main tree settings is denied, with the file and the way out', () => {
    const r = CF.assessControlWrite({ ...base, agentType: 'track', filePath: m('.claude', 'settings.json') });
    expect(r?.rule).toBe('control-file');
    expect(r?.reason).toContain('.claude/settings.json');
    expect(r?.reason).toMatch(/main tree/);
    expect(r?.reason).toMatch(/report/);
  });

  it('every subagent is guarded, the plugin prefix too; the main session never', () => {
    for (const t of ['track-d', 'ravenseat:track', 'reviewer', 'general-purpose'])
      expect(CF.assessControlWrite({ ...base, agentType: t, filePath: m('queue.config.json') }), t).not.toBeNull();
    expect(CF.assessControlWrite({ ...base, agentType: null, filePath: m('queue.config.json') })).toBeNull();
  });

  it('the track\'s own worktree copy is free, and so is the rest of the main tree', () => {
    expect(CF.assessControlWrite({ ...base, agentType: 'track', filePath: path.join(WT, '.claude', 'settings.json') })).toBeNull();
    expect(CF.assessControlWrite({ ...base, agentType: 'track', filePath: m('src', 'a.ts') })).toBeNull();
  });

  it('controlFiles.guard false lets it through (a weakened guard)', () => {
    expect(CF.assessControlWrite({ ...base, agentType: 'track', filePath: m('CLAUDE.md'), enabled: false })).toBeNull();
  });
});

describe('controlShellReason: a shell line that writes a control file', () => {
  const ctx = { ...where, cwd: WT };
  const fw = (p: string) => p.replace(/\\/g, '/');
  it.each([
    [`echo {} > ${fw(m('queue.config.json'))}`],
    [`echo x >> "${m('.claude', 'settings.json')}"`],
    [`cp evil.json ${fw(m('.claude', 'settings.local.json'))}`],
    [`node -e "require('fs').writeFileSync('${fw(m('queue.config.json'))}', '{}')"`],
    [`Set-Content -Path ${m('CLAUDE.md')} -Value x`],
    [`cd ${fw(MAIN)} && echo x > queue.config.json`],
    [`git -C ${fw(MAIN)} checkout -- .claude/settings.json`],
    [`sed -i s/a/b/ ${fw(m('.git', 'config'))}`],
    [`printf '#!/bin/sh' > ${fw(m('.git', 'hooks', 'pre-commit'))}`],
    [`bash -c "echo x > ${fw(m('.claude', 'agents', 'x.md'))}"`],
    [`rm ${fw(path.join(SCRIPTS, 'hook-write-guard.mjs'))}`],
    [`python -c "open('${fw(m('queue.config.json'))}', 'w').write('{}')"`],
  ])('denied: %s', (command) => {
    const r = CF.controlShellReason(command, ctx);
    expect(r?.rule, command).toBe('control-file');
  });

  it.each([
    [`cat ${fw(m('queue.config.json'))}`],
    [`cat ${fw(m('queue.config.json'))} > notes.json`],
    ['echo x > .claude/settings.json'],
    ['echo x > CLAUDE.md'],
    [`git -C ${fw(MAIN)} log --oneline -3`],
    ['npm test'],
    [`grep -n push ${fw(path.join(SCRIPTS, 'lib', 'pushGuard.js'))}`],
  ])('free: %s', (command) => {
    expect(CF.controlShellReason(command, ctx), command).toBeNull();
  });

  it('git config and git remote that write the shared config are denied; reading is free', () => {
    for (const c of ['git config remote.origin.url https://x', 'git config --global user.name x', 'git remote set-url origin x', 'git config --unset core.bare'])
      expect(CF.controlShellReason(c, ctx)?.kind, c).toBe('.git/config');
    for (const c of ['git config --get remote.origin.url', 'git config user.name', 'git config --list', 'git remote -v'])
      expect(CF.controlShellReason(c, ctx), c).toBeNull();
  });

  it('a relative write counts when the cwd is the main tree', () => {
    expect(CF.controlShellReason('echo x > queue.config.json', { ...where, cwd: MAIN })?.kind).toBe('queue.config.json');
  });

  it('$CLAUDE_PROJECT_DIR is read as its value', () => {
    const env = { CLAUDE_PROJECT_DIR: MAIN };
    expect(CF.controlShellReason('echo x > "$CLAUDE_PROJECT_DIR/.claude/settings.json"', { ...ctx, env })?.kind).toBe('.claude/');
    expect(CF.controlShellReason('echo x > "$CLAUDE_PROJECT_DIR/.claude/settings.json"', { ...ctx, env: { CLAUDE_PROJECT_DIR: WT } })).toBeNull();
  });
});

describe('the fingerprint', () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cf-fp-'));
  function tree() {
    const root = tmp();
    const scripts = tmp();
    fs.mkdirSync(path.join(root, '.claude', 'worktrees', 'agent-A'), { recursive: true });
    fs.mkdirSync(path.join(root, '.git', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(root, 'queue.config.json'), '{}');
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), 'rules\n');
    fs.writeFileSync(path.join(root, '.claude', 'settings.json'), '{}');
    fs.writeFileSync(path.join(root, '.claude', 'worktrees', 'agent-A', 'x.ts'), 'x');
    fs.writeFileSync(path.join(root, '.git', 'config'), '[core]\n\tbare = false\n[branch "main"]\n\tremote = origin\n');
    fs.writeFileSync(path.join(scripts, 'queue.mjs'), 'x');
    return { root, scripts, at: { mainTree: root, scriptsDir: scripts, configFile: path.join(root, 'queue.config.json') } };
  }

  it('only short hashes, the worktrees left out, and nothing changed reads as nothing', () => {
    const { at } = tree();
    const fp = CF.fingerprint(at);
    expect(Object.keys(fp.files)).toEqual(expect.arrayContaining(['queue.config.json', 'CLAUDE.md', '.claude/settings.json', '.git/config']));
    expect(Object.keys(fp.files).some((k) => k.includes('worktrees'))).toBe(false);
    for (const v of Object.values(fp.files)) expect(v).toMatch(/^[0-9a-f]{16}$/);
    expect(CF.compare(fp, CF.fingerprint(at))).toEqual([]);
  });

  it('a changed setting, a new hook, a new agent and a removed CLAUDE.md are named', () => {
    const { root, scripts, at } = tree();
    const before = CF.fingerprint(at);
    fs.writeFileSync(path.join(root, '.claude', 'settings.json'), '{"disableAllHooks":true}');
    fs.mkdirSync(path.join(root, '.claude', 'agents'));
    fs.writeFileSync(path.join(root, '.claude', 'agents', 'x.md'), 'x');
    fs.writeFileSync(path.join(root, '.git', 'hooks', 'pre-commit'), 'x');
    fs.rmSync(path.join(root, 'CLAUDE.md'));
    fs.writeFileSync(path.join(scripts, 'queue.mjs'), 'changed');
    const changes = CF.compare(before, CF.fingerprint(at));
    expect(changes).toEqual(
      expect.arrayContaining([
        { name: '.claude/settings.json', change: 'changed' },
        { name: '.claude/agents/x.md', change: 'added' },
        { name: '.git/hooks/pre-commit', change: 'added' },
        { name: 'CLAUDE.md', change: 'removed' },
        { name: CF.SCRIPTS_KEY, change: 'changed' },
      ]),
    );
  });

  it('a new branch section in .git/config is not a change; a new remote url is', () => {
    const { root, at } = tree();
    const before = CF.fingerprint(at);
    fs.appendFileSync(path.join(root, '.git', 'config'), '[branch "queue/A"]\n\tmerge = refs/heads/x\n');
    expect(CF.compare(before, CF.fingerprint(at))).toEqual([]);
    fs.appendFileSync(path.join(root, '.git', 'config'), '[remote "origin"]\n\turl = https://elsewhere\n');
    expect(CF.compare(before, CF.fingerprint(at))).toEqual([{ name: '.git/config', change: 'changed' }]);
  });

  it('a fingerprint of another tree compares as nothing', () => {
    const one = tree();
    const two = tree();
    expect(CF.compare(CF.fingerprint(one.at), CF.fingerprint(two.at))).toEqual([]);
  });

  it('the warning names the files, the tracks that ran too, and the changes that came through a commit are left out', () => {
    const changes = [
      { name: '.claude/settings.json', change: 'changed' },
      { name: 'CLAUDE.md', change: 'changed' },
    ];
    const kept = CF.unexplained(changes, { committed: new Set(['CLAUDE.md']) });
    expect(kept).toEqual([{ name: '.claude/settings.json', change: 'changed' }]);
    const lines = CF.warningLines('A', kept, { root: '/r', others: ['B'] });
    expect(lines[0]).toMatch(/^CONTROL FILES CHANGED A: \.claude\/settings\.json \(changed\)/);
    expect(lines.join('\n')).toContain('B');
    expect(CF.warningLines('A', [], { root: '/r' })).toEqual([]);
  });
});
