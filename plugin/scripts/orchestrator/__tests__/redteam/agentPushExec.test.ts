// =============================================================
// redteam/agentPushExec.test.ts: a queue agent cannot push through a git command that runs a command itself (review
// 2026-11-11, S2).
//
// Why: the push guard reads the command text. `git push …` alone was denied, but git has many ways to run another
// command: `rebase -x`, a program-valued config key given with `-c` (core.pager, core.sshCommand …), `submodule
// foreach`, `bisect run`, `filter-branch` filters, `difftool -x`, the `--upload-pack`/`--receive-pack` program options
// and environment variables such as GIT_EDITOR or GIT_SSH_COMMAND. Each of these with `git push` inside was let through.
// They now count as a part the reading cannot see into, so a line that also looks like a push is denied for a queue
// agent and asked about for the main session. Ordinary uses without a push stay free.
// Only strings are assessed here (assess() runs nothing).
// =============================================================
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PG = require('../../lib/pushGuard.js');

const track = { baseBranch: 'main', agentType: 'ravenseat:track', branch: 'queue/A' };
const main = { baseBranch: 'main', branch: 'main' };
const decision = (k: string, context: Record<string, unknown> = track) => PG.assess(k, context)?.decision ?? null;

const HIDDEN_PUSHES = [
  'git rebase -x "git push origin HEAD:main" HEAD~1',
  'git rebase --exec "git push origin HEAD:main" HEAD~1',
  'git rebase --exec="git push origin HEAD:main" HEAD~1',
  'git -c core.pager="git push origin HEAD:main" log',
  'git -c core.sshCommand="sh -c \'git push origin HEAD:main\'" fetch',
  'git submodule foreach "git push origin HEAD:main"',
  'git submodule --quiet foreach "git push origin HEAD:main"',
  'git bisect run git push origin HEAD:main',
  'git filter-branch --tree-filter "git push origin HEAD:main" HEAD',
  'git difftool -x "git push origin HEAD:main" HEAD~1',
  'git fetch --upload-pack="git push origin HEAD:main" origin',
  'GIT_EDITOR="git push origin HEAD:main" git commit --amend',
  'GIT_SEQUENCE_EDITOR="git push origin HEAD:main" git rebase -i HEAD~2',
  'GIT_SSH_COMMAND="git push origin HEAD:main" git fetch',
  'env GIT_PAGER="git push origin HEAD:main" git log',
  'export GIT_EDITOR="git push origin HEAD:main"; git commit --amend',
  '$env:GIT_EDITOR = "git push origin HEAD:main"; git commit --amend',
];

describe('a git command that runs a command itself does not hide a push', () => {
  it('each form with a push inside is denied for a queue agent, with the reason', () => {
    for (const k of HIDDEN_PUSHES) expect(decision(k), k).toBe('deny');
    expect(PG.assess(HIDDEN_PUSHES[0], track)?.reason).toMatch(/cannot read this command.*looks like a push/);
  });

  it('the main session is asked, not stopped', () => {
    for (const k of HIDDEN_PUSHES) expect(decision(k, main), k).toBe('ask');
  });

  it('the same commands without a push stay free, for agents and the main session', () => {
    for (const k of [
      'git rebase -x "npm test" HEAD~3',
      'git -c core.pager=cat log --oneline -3',
      'git submodule foreach "git status"',
      'git bisect run npm test',
      'GIT_EDITOR=true git commit --amend',
      'git -c core.quotepath=off diff --name-only',
      'git log --oneline -3',
    ]) {
      expect(decision(k), k).toBeNull();
      expect(decision(k, main), k).toBeNull();
    }
  });
});
