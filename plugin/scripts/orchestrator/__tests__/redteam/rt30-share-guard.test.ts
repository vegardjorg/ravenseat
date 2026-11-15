// =============================================================
// redteam/rt30-share-guard.test.ts: RT-30 "the queue's own files end up in git without my say".
//
// Why: the data folder (scripts/.queue) holds the time log, missions, reports, the owner's answers and transcript
// extracts. It is ignored by git, but `git add -f` or a commit made where the .gitignore is missing still tracks a file.
// The push guard (hook-push-guard.mjs, as hooks.json wires it) and merge refuse a range that tracks a data folder file
// that is not shared: every file while share is off (the default), and every file outside share.include while it is
// on. queue.json is let through only with share on. The hook reads the cached visibility only, never the network (the
// origin here is a local path, so a network call could not answer anyway).
// =============================================================
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { project, task } from './project';
import { push } from './hooks';

const SHARE_ON = { share: { queueData: true, include: ['queue.json', 'plans.json'] } };

function guarded(config: Record<string, unknown> = {}) {
  const p = project({ config, tasks: [task('A')] });
  const origin = p.g(['remote', 'get-url', 'origin']);
  fs.writeFileSync(path.join(p.folder, 'repo-visibility.json'), JSON.stringify({ visibility: 'private', source: 'test', remote: origin, checkedAt: new Date().toISOString() }));
  /** Commits files on main (forced past any ignore rule, as `git add -f` would). */
  const commit = (files: Record<string, string>) => {
    for (const [f, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(p.repo, f)), { recursive: true });
      fs.writeFileSync(path.join(p.repo, f), text);
    }
    p.g(['add', '-f', '--', ...Object.keys(files)]);
    p.g(['commit', '-q', '-m', 'files']);
  };
  return { p, commit };
}

describe('RT-30: the queue\'s own files end up in git without my say', () => {
  it('share off (the default): a push of a commit that tracks queue.json is denied, naming the file and the way out', () => {
    const { p, commit } = guarded();
    commit({ 'scripts/.queue/queue.json': '{}\n' });
    const d = push(p);
    expect(d.decision).toBe('deny');
    expect(d.reason).toContain('scripts/.queue/queue.json');
    expect(d.reason).toMatch(/git rm --cached/);
  }, 60_000);

  it('a push of ordinary work is not denied by it', () => {
    const { p, commit } = guarded();
    commit({ 'lib/a.ts': 'export {};\n' });
    expect(push(p).decision).not.toBe('deny');
  }, 60_000);

  it('share on: queue.json goes, the time log and a mission never do', () => {
    const { p, commit } = guarded(SHARE_ON);
    commit({ 'scripts/.queue/queue.json': '{}\n' });
    expect(push(p).decision).not.toBe('deny');
    commit({ 'scripts/.queue/times.jsonl': '{}\n', 'scripts/.queue/missions/A.md': 'x\n' });
    const d = push(p);
    expect(d.decision).toBe('deny');
    expect(d.reason).toContain('scripts/.queue/times.jsonl');
    expect(d.reason).toContain('not in share.include');
  }, 60_000);

  it('merge refuses a track that commits a data folder file, and the base branch does not get it', () => {
    const { p } = guarded();
    p.cloudDelivers('A', 'scripts/.queue/answers.json');
    p.run('cloud', 'collect');
    const m = p.merge('A');
    expect(m.code).not.toBe(0);
    expect(m.out).toContain('scripts/.queue/answers.json');
    expect(p.g(['ls-tree', '-r', '--name-only', 'main'])).not.toContain('scripts/.queue/answers.json');
  }, 240_000);
});
