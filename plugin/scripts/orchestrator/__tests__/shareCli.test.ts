// =============================================================
// shareCli.test.ts: `ravenseat share on|off|status` through the real CLI, in a temporary project (H3).
//
// Why: share on puts the queue's own files in git, which everyone with access to the repo (and every fork) reads. So
// it explains first and changes nothing without --yes, needs --public-ok in a repo that is not known to be private,
// refuses a file that can never be shared, and `settings set` cannot turn it on behind the owner's back.
// The repo's visibility comes from the cache in the queue folder (lib/repoVisibility.js); the test's origin is a local
// bare repo, so nothing here asks the network (a local path is "unknown", and a private answer is written to the cache).
// =============================================================
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { project, tmp } from './redteam/project';

function shareProject(config: Record<string, unknown> = {}) {
  const p = project({ config });
  const global = path.join(tmp('share-gitconfig-'), 'gitconfig');
  fs.writeFileSync(global, '');
  (p.env as Record<string, string | undefined>).GIT_CONFIG_GLOBAL = global;
  const origin = p.g(['remote', 'get-url', 'origin']);
  const visibility = (v: string) =>
    fs.writeFileSync(path.join(p.folder, 'repo-visibility.json'), JSON.stringify({ visibility: v, source: 'test', remote: origin, checkedAt: new Date().toISOString() }));
  const config_ = () => JSON.parse(fs.readFileSync(p.configFile, 'utf8'));
  const gitignore = () => (fs.existsSync(path.join(p.repo, '.gitignore')) ? fs.readFileSync(path.join(p.repo, '.gitignore'), 'utf8') : '');
  const log = () =>
    fs.existsSync(path.join(p.folder, 'times.jsonl'))
      ? fs.readFileSync(path.join(p.folder, 'times.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
      : [];
  const ignored = (f: string) => {
    try {
      p.g(['check-ignore', '-q', '--', f]);
      return true;
    } catch {
      return false;
    }
  };
  return { ...p, visibility, config: config_, gitignore, log, ignored };
}

describe('ravenseat share', () => {
  it('is off by default; status says so and names the visibility', () => {
    const p = shareProject();
    const r = p.run('share', 'status', '--json');
    expect(r.code, r.out).toBe(0);
    const s = JSON.parse(r.out.slice(r.out.indexOf('{')));
    expect(s).toMatchObject({ on: false, include: ['queue.json', 'plans.json'], visibility: 'unknown' });
  }, 60_000);

  it('a repo of unknown visibility: on needs --public-ok as well as --yes, and changes nothing without it', () => {
    const p = shareProject();
    const r = p.run('share', 'on', '--yes');
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/--public-ok/);
    expect(r.out).toMatch(/Nothing was changed/);
    expect(p.config().share).toBeUndefined();
    expect(p.gitignore()).not.toContain('!scripts/.queue/');
  }, 60_000);

  it('a private repo: on without --yes explains and changes nothing; with --yes it writes the config, the .gitignore and a share-on row', () => {
    const p = shareProject();
    p.visibility('private');
    const ask = p.run('share', 'on');
    expect(ask.code).toBe(1);
    expect(ask.out).toMatch(/every fork/);
    expect(ask.out).toMatch(/Nothing was changed/);
    expect(p.config().share).toBeUndefined();

    const r = p.run('share', 'on', '--yes');
    expect(r.code, r.out).toBe(0);
    expect(p.config().share).toMatchObject({ queueData: true, include: ['queue.json', 'plans.json'] });
    const gi = p.gitignore();
    expect(gi).toContain('scripts/.queue/*');
    expect(gi).toContain('!scripts/.queue/queue.json');
    expect(gi).toContain('!scripts/.queue/plans.json');
    expect(p.ignored('scripts/.queue/queue.json')).toBe(false);
    expect(p.ignored('scripts/.queue/times.jsonl')).toBe(true);
    expect(p.ignored('scripts/.queue/missions/A.md')).toBe(true);
    expect(p.log().some((row) => row.event === 'share-on' && row.by === 'owner')).toBe(true);
  }, 60_000);

  it('a file that can never be shared is refused with the reason', () => {
    const p = shareProject();
    p.visibility('private');
    const r = p.run('share', 'on', '--include', 'times.jsonl', '--yes');
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/never/i);
    expect(p.config().share).toBeUndefined();
  }, 60_000);

  it('off takes the exceptions out of the .gitignore, and the data folder is ignored again', () => {
    const p = shareProject();
    p.visibility('private');
    expect(p.run('share', 'on', '--yes').code).toBe(0);
    const r = p.run('share', 'off');
    expect(r.code, r.out).toBe(0);
    expect(p.config().share.queueData).toBe(false);
    expect(p.gitignore()).not.toContain('!scripts/.queue/');
    expect(p.ignored('scripts/.queue/queue.json')).toBe(true);
    expect(p.log().some((row) => row.event === 'share-off')).toBe(true);
  }, 60_000);

  it('doctor: share on names a tracked data folder file outside share.include (FAIL), never queue.json; a public repo WARNs', () => {
    const p = shareProject({ share: { queueData: true, include: ['queue.json', 'plans.json'] } });
    p.visibility('private');
    for (const f of ['scripts/.queue/queue.json', 'scripts/.queue/times.jsonl']) {
      fs.mkdirSync(path.dirname(path.join(p.repo, f)), { recursive: true });
      fs.writeFileSync(path.join(p.repo, f), '{}\n');
    }
    p.g(['add', '-f', '--', 'scripts/.queue/queue.json', 'scripts/.queue/times.jsonl']);
    p.g(['commit', '-q', '-m', 'data']);
    const rows = () => {
      const r = p.run('doctor', '--json');
      return (JSON.parse(r.out.slice(r.out.indexOf('{'), r.out.lastIndexOf('}') + 1)).checks as { name: string; status: string; message: string }[]).filter((c) => c.name === 'share');
    };
    let s = rows();
    expect(s.map((c) => c.status)).toContain('FAIL');
    expect(s.find((c) => c.status === 'FAIL')?.message).toContain('scripts/.queue/times.jsonl');
    expect(s.find((c) => c.status === 'FAIL')?.message).not.toContain('queue.json,');
    p.g(['rm', '-q', '--cached', '--', 'scripts/.queue/times.jsonl']);
    p.g(['commit', '-q', '-m', 'out']);
    p.visibility('public');
    s = rows();
    expect(s.map((c) => c.status)).toEqual(['WARN']);
    expect(s[0].message).toMatch(/public/);
  }, 90_000);

  it('doctor --all: share off in a private repo is one INFO line that offers it; elsewhere, and in plain doctor, no share line', () => {
    const p = shareProject();
    // Off is the safe side and the normal state, so plain doctor never names it (the Checks tab keeps the card).
    const plain = () => {
      const r = p.run('doctor', '--json');
      return (JSON.parse(r.out.slice(r.out.indexOf('{'), r.out.lastIndexOf('}') + 1)).checks as { name: string }[]).filter((c) => c.name === 'share');
    };
    const rows = () => {
      const r = p.run('doctor', '--json', '--all');
      return (JSON.parse(r.out.slice(r.out.indexOf('{'), r.out.lastIndexOf('}') + 1)).checks as { name: string; status: string; message: string; fix?: string }[]).filter((c) => c.name === 'share');
    };
    expect(rows()).toEqual([]);
    p.visibility('private');
    expect(plain()).toEqual([]);
    const s = rows();
    expect(s.map((c) => c.status)).toEqual(['INFO']);
    expect(`${s[0].message} ${s[0].fix}`).toContain('share on --yes');
  }, 90_000);

  it('doctor --fix writes the .gitignore from the settings (share pattern, private paths); plain doctor changes nothing', () => {
    const p = shareProject({ share: { queueData: true, include: ['queue.json'] }, privatePaths: ['docs/notes/'] });
    p.run('doctor');
    expect(p.gitignore()).toBe('');
    const r = p.run('doctor', '--fix');
    expect(r.out).toMatch(/\.gitignore: added/);
    const gi = p.gitignore().split(/\r?\n/);
    expect(gi).toContain('scripts/.queue/*');
    expect(gi).toContain('!scripts/.queue/queue.json');
    expect(gi).toContain('docs/notes/');
    expect(gi).not.toContain('scripts/.queue/');
    expect(p.run('doctor', '--fix').out).toMatch(/\.gitignore: unchanged/);
  }, 90_000);

  it('settings set cannot turn it on (only share on, which explains first)', () => {
    const p = shareProject();
    p.visibility('private');
    const r = p.run('settings', 'set', 'share.queueData', 'on');
    expect(r.code).not.toBe(0);
    expect(p.config().share).toBeUndefined();
  }, 60_000);
});
