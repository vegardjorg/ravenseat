// =============================================================
// secretsCleanCli.test.ts: `ravenseat secrets clean` through the real CLI, in a temporary project (H1, S5).
//
// Why: an approved command with a key in it keeps the key in clear text in .claude/settings*.json. The command removes
// those rules, after a copy in the data folder, and never prints or logs the rule or the key. The fake key is joined
// at run time, so no key-shaped text is in this file.
// =============================================================
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { project } from './redteam/project';

const KEY = ['gh', 'p_', 'y'.repeat(36)].join('');

function secretsProject() {
  const p = project();
  const file = path.join(p.repo, '.claude', 'settings.local.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = JSON.stringify({ permissions: { allow: ['Bash(npm test)', `Bash(gh api -H "token ${KEY}")`, 'Bash(git status)'] } }, null, 4) + '\n';
  fs.writeFileSync(file, text);
  const read = () => fs.readFileSync(file, 'utf8');
  const log = () => (fs.existsSync(path.join(p.folder, 'times.jsonl')) ? fs.readFileSync(path.join(p.folder, 'times.jsonl'), 'utf8') : '');
  return { ...p, file, text, read, log };
}

describe('ravenseat secrets clean', () => {
  it('--dry-run names the file and index and changes nothing', () => {
    const p = secretsProject();
    const r = p.run('secrets', 'clean', '--dry-run');
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('.claude/settings.local.json: permissions.allow[1]');
    expect(r.out).not.toContain(KEY);
    expect(p.read()).toBe(p.text);
  }, 60_000);

  it('without --yes: the list, exit 1, nothing changed', () => {
    const p = secretsProject();
    const r = p.run('secrets', 'clean');
    expect(r.code).toBe(1);
    expect(r.out).toContain('--yes');
    expect(r.out).not.toContain(KEY);
    expect(p.read()).toBe(p.text);
  }, 60_000);

  it('--yes removes the rule, keeps the others and the indentation, copies the file first, and never shows or logs the key', () => {
    const p = secretsProject();
    const r = p.run('secrets', 'clean', '--yes');
    expect(r.code, r.out).toBe(0);
    expect(r.out).not.toContain(KEY);
    const after = p.read();
    expect(after).not.toContain(KEY);
    expect(JSON.parse(after).permissions.allow).toEqual(['Bash(npm test)', 'Bash(git status)']);
    expect(after).toMatch(/\n {4}"permissions"/);
    const backups = path.join(p.folder, 'secrets-backup');
    const stamp = fs.readdirSync(backups);
    expect(stamp).toHaveLength(1);
    const copy = fs.readdirSync(path.join(backups, stamp[0]));
    expect(copy).toEqual(['.claude__settings.local.json']);
    expect(fs.readFileSync(path.join(backups, stamp[0], copy[0]), 'utf8')).toBe(p.text);
    expect(p.log()).toContain('secrets-clean');
    expect(p.log()).not.toContain(KEY);
    // Nothing left: a second run says so.
    const again = p.run('secrets', 'clean', '--yes');
    expect(again.code).toBe(0);
    expect(again.out).toMatch(/Nothing to do/);
  }, 60_000);
});
