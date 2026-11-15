// =============================================================
// privateCli.test.ts: `ravenseat private add|remove|list` through the real CLI, in a temporary project (H4).
//
// Why: one list (privatePaths) drives the .gitignore, the push and merge guard, the read guard and the cloud's hidden
// paths. These tests lock the command's own part: the entry in queue.config.json, the .gitignore line, --no-read, the
// warning for a file git already tracks there, and that remove takes it out of the list.
// =============================================================
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { project, tmp } from './redteam/project';

function privateProject() {
  const p = project();
  const global = path.join(tmp('private-gitconfig-'), 'gitconfig');
  fs.writeFileSync(global, '');
  (p.env as Record<string, string | undefined>).GIT_CONFIG_GLOBAL = global;
  const config = () => JSON.parse(fs.readFileSync(p.configFile, 'utf8'));
  const gitignore = () => (fs.existsSync(path.join(p.repo, '.gitignore')) ? fs.readFileSync(path.join(p.repo, '.gitignore'), 'utf8') : '');
  return { ...p, config, gitignore };
}

describe('ravenseat private', () => {
  it('add writes the entry and the .gitignore line; --no-read gives the object form; list shows both', () => {
    const p = privateProject();
    let r = p.run('private', 'add', 'docs/internal/');
    expect(r.code, r.out).toBe(0);
    r = p.run('private', 'add', 'notes/owner.md', '--no-read');
    expect(r.code, r.out).toBe(0);
    expect(p.config().privatePaths).toEqual(['docs/internal/', { path: 'notes/owner.md', read: false }]);
    const gi = p.gitignore().split(/\r?\n/);
    expect(gi).toContain('docs/internal/');
    expect(gi).toContain('notes/owner.md');
    const list = p.run('private', 'list', '--json');
    const json = JSON.parse(list.out.slice(list.out.indexOf('{')));
    expect(json.entries.map((e: { line: string; read: boolean }) => [e.line, e.read])).toEqual([
      ['docs/internal/', true],
      ['notes/owner.md', false],
    ]);
  }, 60_000);

  it('add of a path outside the project is refused and changes nothing', () => {
    const p = privateProject();
    const r = p.run('private', 'add', '../elsewhere/');
    expect(r.code).toBe(1);
    expect(p.config().privatePaths).toBeUndefined();
  }, 60_000);

  it('add warns about a file git already tracks there', () => {
    const p = privateProject();
    fs.mkdirSync(path.join(p.repo, 'docs', 'internal'), { recursive: true });
    fs.writeFileSync(path.join(p.repo, 'docs', 'internal', 'a.md'), 'x\n');
    p.g(['add', '--', 'docs/internal/a.md']);
    p.g(['commit', '-q', '-m', 'a']);
    const r = p.run('private', 'add', 'docs/internal/');
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('docs/internal/a.md');
    expect(r.out).toMatch(/git rm --cached/);
  }, 60_000);

  it('remove takes it out of the list; an unknown path is refused', () => {
    const p = privateProject();
    p.run('private', 'add', 'docs/internal/');
    expect(p.run('private', 'remove', 'docs/internal/').code).toBe(0);
    expect(p.config().privatePaths).toEqual([]);
    expect(p.run('private', 'remove', 'docs/other/').code).toBe(1);
  }, 60_000);
});
