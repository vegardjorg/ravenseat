// =============================================================
// ghWrite.test.ts: the GitHub writes, opt-in and asked (cli/ghWrite.mjs; GH-3 `issues report`, GH-4 `pr`, GH-5
// `release-notes`), against a temporary queue and git repo.
//
// Locks: (1) GH-3 is off by default and then makes no gh call; on, the preview lists the fixed comment for each merged
// and pushed task with an issue link, writes nothing to GitHub, and says when the repo is public; (2) --post needs the
// preview first and posts exactly it (comment, or close with the comment), records it, and never posts it twice; a
// task not yet on the remote is not reported; a gh failure is reported and nothing is recorded; (3) --post refuses when
// the approval dialog is off and no terminal can ask (approvals.ask false, not a TTY); (4) GH-4 needs the batch branch
// in push.allowBranches, makes the local branch, prints the push for the main session (the push guard judges it) and
// after that push opens ONE draft pull request with the fixed body; an open one is not opened again; (5) GH-5 drafts
// the notes grouped by the CHANGELOG's groups since a tag with no gh call, --save writes them under the data folder,
// and --github --post creates a DRAFT release, never a published one, only for pushed work.
// gh is replaced by a module (QUEUE_GH) that answers from a JSON file the test writes and logs every call. Never the
// real gh, the network or GitHub.
// =============================================================
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { done, setup } from './ghWriteFixture';

describe('GH-3: issues report after a push', () => {
  it('is off by default: one line, no gh call', () => {
    const p = setup();
    const r = p.rs(['issues', 'report']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/issues\.onPush is off/);
    expect(p.ghCalls()).toEqual([]);
  });

  it('comment: the preview lists the fixed comment for a merged and pushed linked task, and posts nothing', () => {
    const p = setup({ issues: { onPush: 'comment' } }, { visibility: 'public' });
    const sha = p.merge('A-1');
    const later = p.merge('A-2');
    p.pushed();
    p.merge('A-3'); // merged, not pushed
    p.writeQueue([
      done('A-1', sha, { issue: { repo: 'acme/tool', number: 12 } }),
      done('A-2', later), // no issue link
      done('A-3', 'c'.repeat(40), { issue: { repo: 'acme/tool', number: 13 } }),
    ]);
    const r = p.rs(['issues', 'report']);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('acme/tool#12');
    expect(r.out).not.toContain('acme/tool#13');
    expect(r.out).toContain(sha);
    expect(r.out).toContain('Posted by Ravenseat');
    expect(r.out).toMatch(/PUBLIC repo/);
    expect(r.out).toMatch(/--post/);
    expect(p.writes()).toEqual([]);
    expect(fs.existsSync(path.join(p.folder, 'outbound-preview.json'))).toBe(true);
  });

  it('--post needs the preview first, then posts exactly it once, and records it', () => {
    const p = setup({ issues: { onPush: 'comment' } });
    const sha = p.merge('A-1');
    p.pushed();
    p.writeQueue([done('A-1', sha, { issue: { repo: 'acme/tool', number: 12 } })]);
    const first = p.rs(['issues', 'report', '--post']);
    expect(first.code).toBe(1);
    expect(first.out).toMatch(/no preview/);
    expect(p.writes()).toEqual([]);
    expect(p.rs(['issues', 'report']).code).toBe(0);
    const post = p.rs(['issues', 'report', '--post']);
    expect(post.code, post.out).toBe(0);
    expect(post.out).toMatch(/POSTED comment acme\/tool#12/);
    const w = p.writes();
    expect(w.length).toBe(1);
    expect(w[0].slice(0, 5)).toEqual(['issue', 'comment', '12', '--repo', 'acme/tool']);
    expect(w[0][w[0].indexOf('--body') + 1]).toContain(sha);
    const again = p.rs(['issues', 'report']);
    expect(again.out).toMatch(/nothing to report/i);
    expect(p.rs(['issues', 'report', '--post']).code).toBe(0);
    expect(p.writes().length).toBe(1);
  });

  it('close: closes the issue with the same fixed comment', () => {
    const p = setup({ issues: { onPush: 'close' } });
    const sha = p.merge('A-1');
    p.pushed();
    p.writeQueue([done('A-1', sha, { issue: { repo: 'acme/tool', number: 12 } })]);
    p.rs(['issues', 'report']);
    const r = p.rs(['issues', 'report', '--post']);
    expect(r.code, r.out).toBe(0);
    const w = p.writes();
    expect(w[0].slice(0, 5)).toEqual(['issue', 'close', '12', '--repo', 'acme/tool']);
    expect(w[0][w[0].indexOf('--comment') + 1]).toMatch(/issues\.onPush is close/);
  });

  it('a gh failure is reported, exit 1, nothing recorded, so the next run tries again', () => {
    const p = setup({ issues: { onPush: 'comment' } });
    const sha = p.merge('A-1');
    p.pushed();
    p.writeQueue([done('A-1', sha, { issue: { repo: 'acme/tool', number: 12 } })]);
    p.rs(['issues', 'report']);
    p.setGh({ fail: true });
    const r = p.rs(['issues', 'report', '--post']);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/NOT POSTED/);
    expect(r.out).not.toMatch(/502/); // gh's own output is never shown
    p.setGh({});
    expect(p.rs(['issues', 'report']).out).toContain('acme/tool#12');
  });

  it('--post refuses when the approval dialog is off and no terminal can ask', () => {
    const p = setup({ issues: { onPush: 'comment' }, approvals: { ask: false } });
    const sha = p.merge('A-1');
    p.pushed();
    p.writeQueue([done('A-1', sha, { issue: { repo: 'acme/tool', number: 12 } })]);
    p.rs(['issues', 'report']);
    const r = p.rs(['issues', 'report', '--post']);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/approvals\.ask/);
    expect(p.writes()).toEqual([]);
  });
});

describe('GH-4: one draft pull request per batch', () => {
  const today = () => new Date().toISOString().slice(0, 10);

  it('needs the batch branch in push.allowBranches, and says how', () => {
    const p = setup();
    const sha = p.merge('A-1');
    p.writeQueue([done('A-1', sha)]);
    const r = p.rs(['pr']);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/push\.allowBranches/);
    expect(r.out).toMatch(/ravenseat\/batch-\*/);
  });

  it('makes the local branch, prints the push, and after the push opens one draft pull request', () => {
    const p = setup({ push: { allowBranches: ['ravenseat/batch-*'] } });
    const one = p.merge('A-1');
    const two = p.merge('A-2');
    p.writeQueue([done('A-1', one, { title: 'First thing' }), done('A-2', two, { title: 'Second thing' })]);
    const branch = `ravenseat/batch-${today()}`;
    const r = p.rs(['pr']);
    expect(r.code, r.out).toBe(0);
    expect(p.g(['rev-parse', `refs/heads/${branch}`])).toBe(p.g(['rev-parse', 'refs/heads/main']));
    expect(r.out).toContain(`git push origin ${branch}`);
    expect(r.out).toContain('`A-1`: `First thing`');
    expect(r.out).toContain('`A-2`: `Second thing`');
    // Not pushed yet: --post stops.
    const early = p.rs(['pr', '--post']);
    expect(early.code).toBe(1);
    expect(early.out).toMatch(/push the branch first/);
    // The main session's push (through the push guard), simulated by its remote ref.
    p.g(['update-ref', `refs/remotes/origin/${branch}`, `refs/heads/${branch}`]);
    expect(p.rs(['pr']).code).toBe(0);
    const post = p.rs(['pr', '--post']);
    expect(post.code, post.out).toBe(0);
    expect(post.out).toMatch(/pull\/7/);
    const creates = p.writes().filter((c) => c[0] === 'pr' && c[1] === 'create');
    expect(creates.length).toBe(1);
    const c = creates[0];
    expect(c).toContain('--draft');
    expect(c[c.indexOf('--head') + 1]).toBe(branch);
    expect(c[c.indexOf('--base') + 1]).toBe('main');
    expect(c[c.indexOf('--body') + 1]).toContain('`A-1`: `First thing`');
  });

  it('an open pull request for the branch is not opened again', () => {
    const p = setup({ push: { allowBranches: ['ravenseat/batch-*'] } });
    const one = p.merge('A-1');
    p.writeQueue([done('A-1', one)]);
    const branch = `ravenseat/batch-${today()}`;
    p.rs(['pr']);
    p.g(['update-ref', `refs/remotes/origin/${branch}`, `refs/heads/${branch}`]);
    p.setGh({ prs: [{ number: 5, url: 'https://github.com/acme/tool/pull/5' }] });
    const r = p.rs(['pr']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/already open/);
    expect(p.rs(['pr', '--post']).out).toMatch(/already open/);
    expect(p.writes()).toEqual([]);
  });
});

describe('GH-5: release notes', () => {
  it('drafts the notes since the last tag, grouped, with no gh call; --save writes them under the data folder', () => {
    const p = setup();
    const a = p.merge('A-1');
    const b = p.merge('A-2');
    p.writeQueue([done('A-1', a, { labels: ['feature'], title: 'A new view' }), done('A-2', b, { fixes: ['A-1'], title: 'The view shows dates' })]);
    const r = p.rs(['release-notes']);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/since v1\.0\.0/);
    expect(r.out).toMatch(/### Added\n- \*\*A new view\*\* \(A-1\)/);
    expect(r.out).toMatch(/### Fixed\n- \*\*The view shows dates\*\* \(A-2\)/);
    expect(p.ghCalls()).toEqual([]);
    const s = p.rs(['release-notes', 'v1.0.0', '--save']);
    expect(s.code).toBe(0);
    const dir = path.join(p.folder, 'release-notes');
    const files = fs.readdirSync(dir);
    expect(files.length).toBe(1);
    expect(fs.readFileSync(path.join(dir, files[0]), 'utf8')).toMatch(/### Added/);
  });

  it('an unknown tag stops', () => {
    const p = setup();
    expect(p.rs(['release-notes', 'v9.9.9']).code).toBe(1);
  });

  it('--github needs pushed work and a tag name, previews, and --post makes a DRAFT release', () => {
    const p = setup();
    const a = p.merge('A-1');
    p.writeQueue([done('A-1', a, { labels: ['feature'] })]);
    expect(p.rs(['release-notes', '--github']).out).toMatch(/--tag/);
    const unpushed = p.rs(['release-notes', '--github', '--tag', 'v1.1.0']);
    expect(unpushed.code).toBe(1);
    expect(unpushed.out).toMatch(/push/);
    p.pushed();
    const prev = p.rs(['release-notes', '--github', '--tag', 'v1.1.0']);
    expect(prev.code, prev.out).toBe(0);
    expect(prev.out).toMatch(/GITHUB WRITE PREVIEW/);
    expect(p.writes()).toEqual([]);
    const post = p.rs(['release-notes', '--github', '--tag', 'v1.1.0', '--post']);
    expect(post.code, post.out).toBe(0);
    const w = p.writes();
    expect(w.length).toBe(1);
    expect(w[0].slice(0, 3)).toEqual(['release', 'create', 'v1.1.0']);
    expect(w[0]).toContain('--draft');
    expect(w[0]).not.toContain('--latest');
    expect(w[0][w[0].indexOf('--target') + 1]).toBe(a);
  });
});
