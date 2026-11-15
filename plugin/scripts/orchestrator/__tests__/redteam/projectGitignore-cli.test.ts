// =============================================================
// redteam/projectGitignore-cli.test.ts: what Ravenseat keeps local must be ignored by the PROJECT's .gitignore.
//
// Why: a user whose global gitignore holds .claude/settings.local.json sees nothing wrong, but a teammate's clone or CI
// has no such file, and one `git add .` there commits the personal settings (with any key in an approved command) or
// the queue's data. Doctor checks every required path (setup.mjs requiredIgnores, with the configured dataFolder) with
// the global gitignore switched off, and FAILs a file git already tracks in the data folder. GIT_CONFIG_GLOBAL points at
// a git config of the test's own, so the machine's real global gitignore never counts. The check is opt-in
// (gitignoreCheck.enabled, lib/optInChecks.js), so these tests turn it on.
// =============================================================
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { project, tmp } from './project';

/** A project whose global gitignore (the test's own) holds `globalLines`, and whose .gitignore holds `own`. */
function doctorProject(globalLines: string[], own: string, config: Record<string, unknown> = {}) {
  const p = project({ config: { gitignoreCheck: { enabled: true }, ...config } });
  const dir = tmp('rt-gitconfig-');
  fs.writeFileSync(path.join(dir, 'ignore'), globalLines.join('\n'));
  fs.writeFileSync(path.join(dir, 'gitconfig'), `[core]\n\texcludesFile = ${path.join(dir, 'ignore').split(path.sep).join('/')}\n`);
  (p.env as Record<string, string | undefined>).GIT_CONFIG_GLOBAL = path.join(dir, 'gitconfig');
  fs.writeFileSync(path.join(p.repo, '.gitignore'), own);
  p.g(['add', '--', '.gitignore']);
  p.g(['commit', '-q', '-m', 'ignore']);
  const doctor = () => {
    const r = p.run('doctor', '--json');
    const json = JSON.parse(r.out.slice(r.out.indexOf('{'), r.out.lastIndexOf('}') + 1));
    return { code: r.code, rows: (json.checks as { status: string; name: string; message: string; fix: string }[]).filter((c) => c.name === 'gitignore') };
  };
  return { p, doctor };
}

const SETUP = 'scripts/.queue/\n.claude/worktrees/\n.claude/settings.local.json\n.env\n.env.*\n!.env.example\n';

describe('the project gitignore, not the global one', () => {
  it('settings.local.json ignored only by the global gitignore: WARN machine-only; in the project\'s file: OK', () => {
    let d = doctorProject(['.claude/settings.local.json'], SETUP.replace('.claude/settings.local.json\n', '')).doctor();
    expect(d.rows.map((r) => r.status)).toEqual(['WARN']);
    expect(d.rows[0].message).toMatch(/only ignored on your machine \(global gitignore\): \.claude\/settings\.local\.json/);
    expect(d.rows[0].fix).toMatch(/setup/);
    d = doctorProject(['.claude/settings.local.json'], SETUP).doctor();
    expect(d.rows.map((r) => r.status)).toEqual(['OK']);
  }, 120_000);

  it('a moved dataFolder must be ignored too, and a tracked file in it FAILs with git rm --cached', () => {
    const { p, doctor } = doctorProject([], SETUP, { dataFolder: 'queue-data' });
    let d = doctor();
    expect(d.rows.map((r) => r.status)).toEqual(['WARN']);
    expect(d.rows[0].message).toMatch(/not ignored: queue-data\//);
    fs.mkdirSync(path.join(p.repo, 'queue-data'));
    fs.writeFileSync(path.join(p.repo, 'queue-data', 'queue.json'), '{}');
    p.g(['add', '--', 'queue-data/queue.json']);
    p.g(['commit', '-q', '-m', 'oops']);
    d = doctor();
    expect(d.code).toBe(1);
    expect(d.rows[0]).toMatchObject({ status: 'FAIL' });
    expect(d.rows[0].message).toContain('queue-data/queue.json');
    expect(d.rows[0].fix).toMatch(/git rm --cached -r -- queue-data/);
  }, 120_000);
});
