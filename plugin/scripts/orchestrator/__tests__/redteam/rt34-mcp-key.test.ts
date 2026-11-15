// =============================================================
// redteam/rt34-mcp-key.test.ts: RT-34 "a key I pasted into .mcp.json ends up in git".
//
// Why: an MCP server often needs a token, and the quick way is to paste it into the server's env, headers or args in
// .mcp.json, a file that is meant to be shared and is usually tracked. Claude Code expands ${NAME} there, which keeps
// the key in the environment. With secretScan.allowlist on (the same opt-in setting as the approved-commands scan),
// doctor reads .mcp.json in the main tree and in every agent worktree (lib/mcpSecrets.js): FAIL (exit 1) when git
// tracks the file, WARN when it is only on disk, and the output names the file and the path in it, never the value.
// GIT_CONFIG_GLOBAL points at an empty file of the test's own, so the machine's global gitignore does not count.
// The fake key is joined at run time.
// =============================================================
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { project, tmp } from './project';

const GH = ['gh', 'p_', 'y'.repeat(36)].join('');
const mcp = (servers: Record<string, unknown>) => JSON.stringify({ mcpServers: servers }, null, 2);

function doctorProject(config: Record<string, unknown> = { secretScan: { allowlist: true } }) {
  const p = project({ config });
  const global = path.join(tmp('rt-gitconfig-'), 'gitconfig');
  fs.writeFileSync(global, '');
  (p.env as Record<string, string | undefined>).GIT_CONFIG_GLOBAL = global;
  fs.writeFileSync(path.join(p.repo, '.gitignore'), 'scripts/.queue/\n.claude/worktrees/\n.claude/settings.local.json\n');
  p.g(['add', '--', '.gitignore']);
  p.g(['commit', '-q', '-m', 'ignore']);
  const doctor = () => {
    const r = p.run('doctor', '--json');
    const json = JSON.parse(r.out.slice(r.out.indexOf('{'), r.out.lastIndexOf('}') + 1));
    const checks = json.checks as { status: string; name: string; message: string }[];
    return { code: r.code, out: r.out, rows: checks.filter((c) => c.name === 'mcp'), allowlist: checks.filter((c) => c.name === 'allowlist') };
  };
  return { p, doctor };
}

describe('RT-34: a key in .mcp.json', () => {
  it('in the tracked .mcp.json: doctor FAILs (exit 1) by file and path, never printing the key', () => {
    const { p, doctor } = doctorProject();
    fs.writeFileSync(path.join(p.repo, '.mcp.json'), mcp({ github: { command: 'npx', args: ['-y', 'server-github'], env: { GITHUB_PERSONAL_ACCESS_TOKEN: GH } } }));
    p.g(['add', '--', '.mcp.json']);
    p.g(['commit', '-q', '-m', 'mcp servers']);
    const d = doctor();
    expect(d.code).toBe(1);
    expect(d.rows.map((r) => r.status)).toEqual(['FAIL']);
    expect(d.rows[0].message).toContain('.mcp.json: mcpServers.github.env.GITHUB_PERSONAL_ACCESS_TOKEN');
    expect(d.out).not.toContain(GH);
  }, 120_000);

  it('in an agent worktree\'s untracked .mcp.json: WARN; a ${NAME} reference: nothing', () => {
    const { p, doctor } = doctorProject();
    fs.writeFileSync(path.join(p.repo, '.mcp.json'), mcp({ github: { env: { GITHUB_PERSONAL_ACCESS_TOKEN: '${GITHUB_TOKEN}' } } }));
    p.g(['add', '--', '.mcp.json']);
    p.g(['commit', '-q', '-m', 'mcp servers by reference']);
    const file = path.join(p.repo, '.claude', 'worktrees', 'agent-A', '.mcp.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, mcp({ api: { url: 'https://mcp.example.com', headers: { Authorization: `Bearer ${GH}` } } }));
    const d = doctor();
    expect(d.rows.map((r) => r.status)).toEqual(['WARN']);
    expect(d.rows[0].message).toContain('.claude/worktrees/agent-A/.mcp.json: mcpServers.api.headers.Authorization');
    expect(d.rows[0].message).not.toMatch(/(^|[\s,:])\.mcp\.json: mcpServers\.github/);
    expect(d.out).not.toContain(GH);
  }, 120_000);

  it('off (the default): no mcp row, and the one allowlist INFO line says a gap is there without naming it', () => {
    const { p, doctor } = doctorProject({});
    fs.writeFileSync(path.join(p.repo, '.mcp.json'), mcp({ github: { env: { GITHUB_PERSONAL_ACCESS_TOKEN: GH } } }));
    p.g(['add', '--', '.mcp.json']);
    p.g(['commit', '-q', '-m', 'mcp servers']);
    const d = doctor();
    expect(d.rows).toEqual([]);
    expect(d.allowlist.map((r) => r.status)).toEqual(['INFO']);
    expect(d.allowlist[0].message).toMatch(/found something to look at/);
    expect(d.out).not.toContain(GH);
  }, 120_000);
});
