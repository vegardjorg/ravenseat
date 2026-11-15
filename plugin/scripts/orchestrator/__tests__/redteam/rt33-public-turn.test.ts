// =============================================================
// redteam/rt33-public-turn.test.ts: RT-33 "share was on for a private repo, and the repo turned public".
//
// Why: share on was confirmed for a private repo: queue.json and the plan register are readable by everyone with
// access. If the repo is made public later (or its visibility becomes unknown), the next push of those files makes them
// readable by anyone. The push guard reads the cached visibility (lib/repoVisibility.js, never the network in the
// hook's 10 s) and denies a push that carries a shared file unless the owner confirmed a public repo (share.publicOk).
// No answer at all counts as public. Ordinary work still goes.
// =============================================================
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { project } from './project';
import { push } from './hooks';

function shared(publicOk = false) {
  const p = project({ config: { share: { queueData: true, include: ['queue.json', 'plans.json'], publicOk } } });
  const origin = p.g(['remote', 'get-url', 'origin']);
  const cache = path.join(p.folder, 'repo-visibility.json');
  const visibility = (v: string | null) =>
    v === null ? fs.rmSync(cache, { force: true }) : fs.writeFileSync(cache, JSON.stringify({ visibility: v, source: 'test', remote: origin, checkedAt: new Date().toISOString() }));
  const commit = (f: string) => {
    fs.mkdirSync(path.dirname(path.join(p.repo, f)), { recursive: true });
    fs.writeFileSync(path.join(p.repo, f), `${Date.now()}\n`);
    p.g(['add', '-f', '--', f]);
    p.g(['commit', '-q', '-m', f]);
  };
  return { p, visibility, commit };
}

describe('RT-33: share was on for a private repo, and the repo turned public', () => {
  it('private: the shared file goes; public: the same push is denied with the way out; unknown (no answer) too', () => {
    const { p, visibility, commit } = shared();
    visibility('private');
    commit('scripts/.queue/queue.json');
    expect(push(p).decision).not.toBe('deny');
    visibility('public');
    let d = push(p);
    expect(d.decision).toBe('deny');
    expect(d.reason).toMatch(/public/);
    expect(d.reason).toMatch(/share off/);
    visibility(null);
    d = push(p);
    expect(d.decision).toBe('deny');
    expect(d.reason).toMatch(/not known/);
  }, 60_000);

  it('a push without a shared file still goes when the repo is public', () => {
    const { p, visibility, commit } = shared();
    visibility('public');
    commit('lib/a.ts');
    expect(push(p).decision).not.toBe('deny');
  }, 60_000);

  it('the owner confirmed a public repo (share.publicOk): the push goes', () => {
    const { p, visibility, commit } = shared(true);
    visibility('public');
    commit('scripts/.queue/queue.json');
    expect(push(p).decision).not.toBe('deny');
  }, 60_000);
});
