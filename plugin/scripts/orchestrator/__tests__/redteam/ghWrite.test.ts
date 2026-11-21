// =============================================================
// redteam/ghWrite.test.ts: the GitHub writes (GH-3 issue comments, GH-4 the draft pull request, GH-5 the draft
// release) in the wrong hands, or with the wrong text (cli/ghWrite.mjs, lib/ghOutbound.js, lib/approvalAsk.js).
//
// Why: a post on GitHub is outbound, often public and permanent, and it runs on the owner's login. A misled queue agent
// must not be able to trigger one, the orchestrator must not post without the owner's yes, and no secret may leave in
// the text, also not one that came in through a task title (an imported issue's title is written by anyone).
// The checks: (1) a queue agent's `issues report --post`, `pr --post` and `release-notes --github --post`, also in a
// nested shell, are denied by the push guard; (2) the main session's --post of any of them asks with the approval
// dialog, which names the targets and says when the repo is public, and is denied where nobody sees the dialog; the
// previews never ask; (3) on a queue branch the CLI refuses by itself and calls no gh; (4) a task title with a
// secret-looking value blocks that post: gh never sees it, and the output never shows it.
// The pure functions get strings; the CLI runs against a temporary repo with the fake gh (QUEUE_GH). Nothing reaches
// GitHub.
// =============================================================
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { done, setup } from '../ghWriteFixture';

const require = createRequire(import.meta.url);
const PG = require('../../lib/pushGuard.js');
const AA = require('../../lib/approvalAsk.js');

const SECRET = ['ghp', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('_');
const track = { baseBranch: 'main', agentType: 'track', branch: 'queue/A-1', knownPackage: () => false };

const POSTS = [
  'ravenseat issues report --post',
  'ravenseat pr --post',
  'ravenseat release-notes --github --tag v2.0.0 --post',
  'bash -c "ravenseat pr --post"',
  'node plugin/scripts/orchestrator/queue.mjs issues report --post',
];

describe('a queue agent tries to post to GitHub', () => {
  it.each(POSTS)('%s is denied by the push guard', (command) => {
    const a = PG.assess(command, track);
    expect(a?.decision, command).toBe('deny');
  });

  it('the previews are denied too: GitHub writes are not queue agent commands at all', () => {
    for (const k of ['ravenseat issues report', 'ravenseat pr', 'ravenseat release-notes --github --tag v2'])
      expect(PG.assess(k, track)?.decision, k).toBe('deny');
  });

  it('on a queue branch the CLI refuses by itself and calls no gh', () => {
    const p = setup({ issues: { onPush: 'comment' }, push: { allowBranches: ['ravenseat/batch-*'] } });
    const sha = p.merge('A-1');
    p.pushed();
    p.writeQueue([done('A-1', sha, { issue: { repo: 'acme/tool', number: 12 } })]);
    const wt = path.join(p.folder, 'wt-A-2');
    execFileSync('git', ['-C', p.repo, 'worktree', 'add', '-q', '-b', 'queue/A-2', wt], { stdio: 'ignore' });
    for (const args of [['issues', 'report', '--post'], ['pr', '--post'], ['release-notes', '--github', '--tag', 'v2', '--post']]) {
      const r = p.rs(args, { cwd: wt });
      expect(r.code, args.join(' ')).toBe(1);
      expect(r.out, args.join(' ')).toMatch(/queue branch/);
    }
    expect(p.ghCalls()).toEqual([]);
  });
});

describe('the main session posts: the approval dialog asks', () => {
  const preview = { kind: 'issues-report', repo: 'acme/tool', visibility: 'public', items: [{ target: 'acme/tool#12', action: 'comment' }] };

  it.each(POSTS.slice(0, 4))('%s asks with the rule outbound-github', (command) => {
    const f = AA.overrideFinding(command, { outboundPreview: () => preview });
    expect(f?.decision).toBe('ask');
    expect(f?.rule).toBe('outbound-github');
    expect(f?.approval).toBe(true);
  });

  it('the question names the targets and says the repo is public', () => {
    const f = AA.overrideFinding('ravenseat issues report --post', { outboundPreview: () => preview });
    expect(f.reason).toMatch(/acme\/tool#12/);
    expect(f.reason).toMatch(/PUBLIC/);
  });

  it('without a preview it still asks, and says the command will refuse', () => {
    const f = AA.overrideFinding('ravenseat pr --post', { outboundPreview: () => null });
    expect(f?.decision).toBe('ask');
    expect(f.reason).toMatch(/no preview/);
  });

  it('the previews and the local release notes never ask', () => {
    for (const k of ['ravenseat issues report', 'ravenseat pr', 'ravenseat release-notes', 'ravenseat release-notes v1 --save', 'ravenseat release-notes --github --tag v2'])
      expect(AA.overrideFinding(k, {}), k).toBeNull();
  });

  it('is denied in dontAsk, where nobody sees the dialog', () => {
    const f = AA.forMode(AA.overrideFinding('ravenseat pr --post', {}), 'dontAsk');
    expect(f.decision).toBe('deny');
  });

  it('the push guard passes it on for the main session, and never for a subagent', () => {
    const main = PG.assess('ravenseat issues report --post', { baseBranch: 'main', mainSession: true, approvals: { ask: true, outboundPreview: () => preview } });
    expect(main?.decision).toBe('ask');
    expect(main?.rule).toBe('outbound-github');
  });
});

describe('a secret-looking value in a task title', () => {
  it('blocks that issue comment: gh never sees it and the output never shows it', () => {
    const p = setup({ issues: { onPush: 'comment' } });
    const one = p.merge('A-1');
    const two = p.merge('A-2');
    p.pushed();
    p.writeQueue([
      done('A-1', one, { issue: { repo: 'acme/tool', number: 12 }, title: `Rotate the key ${SECRET}` }),
      done('A-2', two, { issue: { repo: 'acme/tool', number: 14 }, title: 'A clean title' }),
    ]);
    const prev = p.rs(['issues', 'report']);
    expect(prev.code).toBe(0);
    expect(prev.out).toMatch(/BLOCKED comment acme\/tool#12/);
    expect(prev.out).toContain('acme/tool#14');
    expect(prev.out).not.toContain(SECRET);
    expect(fs.readFileSync(path.join(p.folder, 'outbound-preview.json'), 'utf8').includes(SECRET)).toBe(false);
    const post = p.rs(['issues', 'report', '--post']);
    expect(post.code).toBe(1);
    expect(post.out).not.toContain(SECRET);
    const w = p.writes();
    expect(w.length).toBe(1);
    expect(w[0][2]).toBe('14');
    expect(JSON.stringify(p.ghCalls())).not.toContain(SECRET);
  });

  it('blocks the draft pull request when a batch task title has one', () => {
    const p = setup({ push: { allowBranches: ['ravenseat/batch-*'] } });
    const one = p.merge('A-1');
    p.writeQueue([done('A-1', one, { title: `token=${SECRET}` })]);
    const branch = `ravenseat/batch-${new Date().toISOString().slice(0, 10)}`;
    p.rs(['pr']);
    p.g(['update-ref', `refs/remotes/origin/${branch}`, `refs/heads/${branch}`]);
    const prev = p.rs(['pr']);
    expect(prev.out).toMatch(/BLOCKED/);
    expect(prev.out).not.toContain(SECRET);
    const post = p.rs(['pr', '--post']);
    expect(post.code).toBe(1);
    expect(p.writes()).toEqual([]);
  });
});
