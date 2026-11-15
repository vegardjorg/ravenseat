// =============================================================
// redteam/allowlistSecret-cli.test.ts: a key in a command Claude Code has approved is named by doctor, never shown.
//
// Why: "Yes, and don't ask again" stores the whole command in permissions.allow. A token typed in the command then sits
// in clear text in .claude/settings.local.json, or in the tracked .claude/settings.json where shared approvals go, and
// an agent's approval lands in its own worktree. Doctor reads all of them (lib/allowlistSecrets.js): FAIL when git
// tracks the file, WARN when it is only on disk. The output names `<file>: permissions.allow[N]`, never the rule text.
// GIT_CONFIG_GLOBAL points at an empty file of the test's own, so the machine's global gitignore does not count.
// The check is opt-in (secretScan.allowlist, lib/optInChecks.js), so these tests turn it on. The fake key is joined at
// run time.
// =============================================================
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { project, tmp } from './project';

const GH = ['gh', 'p_', 'x'.repeat(36)].join('');
const rules = (allow: string[]) => JSON.stringify({ permissions: { allow } }, null, 2);

function doctorProject() {
  const p = project({ config: { secretScan: { allowlist: true } } });
  const global = path.join(tmp('rt-gitconfig-'), 'gitconfig');
  fs.writeFileSync(global, '');
  (p.env as Record<string, string | undefined>).GIT_CONFIG_GLOBAL = global;
  fs.writeFileSync(path.join(p.repo, '.gitignore'), 'scripts/.queue/\n.claude/worktrees/\n.claude/settings.local.json\n');
  p.g(['add', '--', '.gitignore']);
  p.g(['commit', '-q', '-m', 'ignore']);
  const doctor = () => {
    const r = p.run('doctor', '--json');
    const json = JSON.parse(r.out.slice(r.out.indexOf('{'), r.out.lastIndexOf('}') + 1));
    return { code: r.code, out: r.out, rows: (json.checks as { status: string; name: string; message: string }[]).filter((c) => c.name === 'allowlist') };
  };
  return { p, doctor };
}

describe('a key in an approved command', () => {
  it('in the tracked settings.json: doctor FAILs (exit 1) by file and index, and never prints the key or the rule', () => {
    const { p, doctor } = doctorProject();
    fs.mkdirSync(path.join(p.repo, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(p.repo, '.claude', 'settings.json'), rules(['Bash(npm test)', `Bash(curl -H "Authorization: token ${GH}" https://api.example.com)`]));
    p.g(['add', '--', '.claude/settings.json']);
    p.g(['commit', '-q', '-m', 'shared approvals']);
    const d = doctor();
    expect(d.code).toBe(1);
    expect(d.rows.map((r) => r.status)).toEqual(['FAIL']);
    expect(d.rows[0].message).toContain('.claude/settings.json: permissions.allow[1]');
    expect(d.out).not.toContain(GH);
    expect(d.out).not.toContain('curl -H');
  }, 120_000);

  it('in an agent worktree\'s ignored settings.local.json: WARN, also found there', () => {
    const { p, doctor } = doctorProject();
    const file = path.join(p.repo, '.claude', 'worktrees', 'agent-A', '.claude', 'settings.local.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, rules([`Bash(gh api -H "token ${GH}")`]));
    const d = doctor();
    expect(d.rows.map((r) => r.status)).toEqual(['WARN']);
    expect(d.rows[0].message).toContain('.claude/worktrees/agent-A/.claude/settings.local.json: permissions.allow[0]');
    expect(d.out).not.toContain(GH);
  }, 120_000);
});
