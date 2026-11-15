// =============================================================
// redteam/rt32-private-read.test.ts: RT-32 "a queue agent reads my private folder".
//
// Why: an entry { "path": ..., "read": false } in privatePaths means the queue's agents (tracks, reviewers) may not even
// read it, so its content never reaches a mission, a report or a transcript. The read guard (hook-read-guard.mjs, as
// hooks.json wires it for Read) denies such a Read, also through an agent's worktree path and with offset and limit.
// The main session is never stopped, and an entry without read:false only keeps the path out of git.
// =============================================================
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { project } from './project';
import { decide } from './hooks';

function guarded() {
  const p = project({ config: { privatePaths: ['docs/notes/', { path: 'ops/', read: false }] } });
  for (const f of ['ops/plan.md', 'docs/notes/a.md']) {
    fs.mkdirSync(path.dirname(path.join(p.repo, f)), { recursive: true });
    fs.writeFileSync(path.join(p.repo, f), 'x\n');
  }
  return p;
}

const read = (file_path: string, extra: Record<string, unknown> = {}) => ({ file_path, ...extra });

describe('RT-32: a queue agent reads my private folder', () => {
  it('a track and a reviewer are denied a Read under a read:false path, also with offset and limit', () => {
    const p = guarded();
    const file = path.join(p.repo, 'ops', 'plan.md');
    for (const agent of ['track', 'ravenseat:track', 'reviewer-security']) {
      const d = decide(p, 'Read', read(file, { offset: 1, limit: 10 }), agent);
      expect(d.decision, agent).toBe('deny');
      expect(d.reason, agent).toMatch(/private/i);
    }
  }, 60_000);

  it('the same path seen from a track worktree is denied too', () => {
    const p = guarded();
    const wt = path.join(p.repo, '.claude', 'worktrees', 'agent-A', 'ops', 'plan.md');
    expect(decide(p, 'Read', read(wt, { offset: 1, limit: 10 }), 'track').decision).toBe('deny');
  }, 60_000);

  it('the main session reads it, and a private path without read:false is readable by agents', () => {
    const p = guarded();
    expect(decide(p, 'Read', read(path.join(p.repo, 'ops', 'plan.md'), { offset: 1, limit: 10 })).decision).toBeNull();
    expect(decide(p, 'Read', read(path.join(p.repo, 'docs', 'notes', 'a.md'), { offset: 1, limit: 10 }), 'track').decision).not.toBe('deny');
  }, 60_000);
});
