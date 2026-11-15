// =============================================================
// mcpSecrets.test.ts: keys pasted into .mcp.json (lib/mcpSecrets.js).
//
// Why: .mcp.json is meant to be shared and is usually tracked, so a key pasted into an MCP server's env, headers, args
// or url is in the repo and its history. Claude Code expands ${NAME} there, which is the safe way. A hit must name the
// file and the path in it (mcpServers.<name>.env.<KEY>), never the value, and a ${NAME} reference is never a hit.
// The fake keys are joined at run time, so this file holds none of them literally.
// =============================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { mcpFiles, scanMcp, scanMcpTrees, where } from '../mcpSecrets';

const GH = ['gh', 'p_', 'x'.repeat(36)].join('');
const GENERIC = ['q8Zr2Lm9', 'Xw4Tb7Kd1Vn6'].join('');
const PASSWORD = ['s3cr', 'etPw9', 'xKq'].join('');

const temporary: string[] = [];
afterAll(() => {
  for (const d of temporary) fs.rmSync(d, { recursive: true, force: true });
});

const mcp = (servers: Record<string, unknown>) => JSON.stringify({ mcpServers: servers }, null, 2);

describe('scanMcp', () => {
  it('names a key in env, headers, args and url by its path, never the value', () => {
    const text = mcp({
      github: { command: 'npx', args: ['-y', 'server-github'], env: { GITHUB_PERSONAL_ACCESS_TOKEN: GH } },
      api: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: `Bearer ${GENERIC}` } },
      db: { command: 'npx', args: ['-y', 'server-postgres', `postgresql://app:${PASSWORD}@db.example.com:5432/app`] },
      search: { type: 'sse', url: `https://search.example.com/sse?api_key=${GENERIC}` },
    });
    const hits = scanMcp(text, '.mcp.json');
    expect(hits.map((h) => h.at)).toEqual([
      'mcpServers.github.env.GITHUB_PERSONAL_ACCESS_TOKEN',
      'mcpServers.api.headers.Authorization',
      'mcpServers.db.args[2]',
      'mcpServers.search.url',
    ]);
    expect(hits[0].rule).toBe('github-token');
    const shown = hits.map(where).join('\n');
    for (const secret of [GH, GENERIC, PASSWORD]) expect(shown).not.toContain(secret);
  });

  it('${NAME} references are never a hit, also inside a longer value, and narrow values pass', () => {
    const text = mcp({
      github: { command: 'npx', env: { GITHUB_PERSONAL_ACCESS_TOKEN: '${GITHUB_TOKEN}' } },
      api: { url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer ${API_TOKEN}', 'X-Client': 'ravenseat-test-client-1' } },
      db: { command: 'npx', args: ['-y', 'server-postgres', 'postgresql://app:${DB_PASSWORD}@localhost/app'] },
      local: { command: 'node', args: ['server.js', '--port', '3000'], env: { LOG_LEVEL: 'debug', API_BASE: '${API_BASE:-http://localhost:8080}' } },
    });
    expect(scanMcp(text, '.mcp.json')).toEqual([]);
  });

  it('a file that is not JSON, or has no mcpServers, gives nothing', () => {
    expect(scanMcp('{ not json', '.mcp.json')).toEqual([]);
    expect(scanMcp(JSON.stringify({ servers: { x: { env: { T: GH } } } }), '.mcp.json')).toEqual([]);
  });
});

describe('scanMcpTrees', () => {
  it('reads the main tree and every agent worktree, as the allow-rule scan does', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-secrets-'));
    temporary.push(root);
    fs.writeFileSync(path.join(root, '.mcp.json'), mcp({ github: { env: { GITHUB_TOKEN: GH } } }));
    const wt = path.join(root, '.claude', 'worktrees', 'agent-B');
    fs.mkdirSync(wt, { recursive: true });
    fs.writeFileSync(path.join(wt, '.mcp.json'), mcp({ api: { headers: { 'X-Api-Key': GENERIC } } }));
    fs.mkdirSync(path.join(root, '.claude', 'worktrees', 'agent-C'), { recursive: true }); // no .mcp.json: skipped
    expect(mcpFiles(root).map((f) => f.file)).toEqual(['.mcp.json', '.claude/worktrees/agent-B/.mcp.json', '.claude/worktrees/agent-C/.mcp.json']);
    const hits = scanMcpTrees(root);
    expect(hits.map((h) => [h.file, h.at, h.tree, h.inTree])).toEqual([
      ['.mcp.json', 'mcpServers.github.env.GITHUB_TOKEN', '', '.mcp.json'],
      ['.claude/worktrees/agent-B/.mcp.json', 'mcpServers.api.headers.X-Api-Key', '.claude/worktrees/agent-B', '.mcp.json'],
    ]);
  });
});
