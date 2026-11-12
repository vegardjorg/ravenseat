// =============================================================
// redteam/reviewGaps2.test.ts: four smaller holes the review of 2026-11-11 found (S3, S4, S5 and G4).
//
// Why:
//   S3. The push guard's check that a queue agent does not touch the gate evidence was a plain, case-sensitive text
//       search, so `GATE-EVIDENCE.json` (the same file on Windows) or `gate-"evidence".json` (the same word for the
//       shell) went through. No Bash rule covered writes to queue.json, base-health.json or queue.config.json.
//   S4. The secret scan gave each git or gitleaks step its own time limit (3 s by default, about 15 s in all), while the
//       hook that runs it has 10 s. Claude Code then killed the hook, and the push went without a question.
//   S5. The list of git config keys that run a program missed gpg.program, core.editor, sequence.editor, the textconv
//       drivers and more, so a planted value there was not seen, and `-c` with one of them did not count as unread.
//   G4. `cleanup-worktree --all --execute` deleted every folder under .claude/worktrees/ that git did not list. After a
//       move of the project folder a real worktree with uncommitted work can be one of them.
// S3 and S5 assess strings only (nothing runs). S4 and G4 use temporary repos; git is never mocked, and nothing outside
// the temporary folders is deleted.
// =============================================================
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterAll, describe, expect, it } from 'vitest';

import { cleanupUnregistered } from '../../cleanup-worktree.mjs';

const require = createRequire(import.meta.url);
const GE = require('../../lib/gateEvidence.js');
const GX = require('../../lib/gitExecSurface.js');
const PG = require('../../lib/pushGuard.js');
const SS = require('../../lib/secretScan.js');

const made: string[] = [];
afterAll(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
});

/** A new temporary repo on main with one commit; g runs git in it (or in `cwd`). */
function repo(prefix: string) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  made.push(dir);
  const g = (args: string[], cwd = dir) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  g(['init', '-q', '-b', 'main']);
  g(['config', 'user.name', 'Review Owner']);
  g(['config', 'user.email', 'owner@ravenseat.dev']);
  g(['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(dir, '.gitignore'), '.claude/worktrees/\n');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  g(['add', '.']);
  g(['commit', '-q', '-m', 'first']);
  return { dir, g };
}

const track = { baseBranch: 'main', agentType: 'ravenseat:track', branch: 'queue/A' };

describe('S3: the evidence check reads the command as the shell does', () => {
  it('upper case, quotes and escapes in the name do not hide the gate evidence', () => {
    for (const k of [
      'cat scripts/.queue/GATE-EVIDENCE.json',
      'cat scripts/.queue/gate-"evidence".json',
      "cat scripts/.queue/gate-'evi'dence.json",
      'cat scripts/.queue/gate\\-evidence.json',
      'Get-Content scripts\\.queue\\Gate-Ev`idence.json',
      'rm .queue/GIT-SURFACE.json',
    ])
      expect(GE.tamperReason(k), k).toMatch(/a queue agent may not touch it/);
  });

  it('a Bash write to queue.json, base-health.json or queue.config.json is denied, also when spelled otherwise', () => {
    for (const k of [
      'echo {} > scripts/.queue/queue.json',
      'echo {}>scripts/.queue/QUEUE.json',
      'cp /tmp/x scripts/.queue/Base-Health.json',
      'sed -i s/stop/off/ queue.config.json',
      'node -e "require(\'fs\').writeFileSync(\'queue.json\',\'{}\')"',
      'Set-Content -Path scripts\\.queue\\queue.json -Value x',
      'git checkout -- "queue.config.json"',
    ])
      expect(GE.tamperReason(k), k).toMatch(/queue agent changes it only through/);
  });

  it('reading those files and the ordinary queue commands stay free', () => {
    for (const k of [
      'cat scripts/.queue/queue.json',
      'grep baseBranch queue.config.json',
      'cat scripts/.queue/queue.json 2>/dev/null',
      'node scripts/orchestrator/queue.mjs status',
      'git diff -- src/app.ts > /tmp/out.diff',
      'node scripts/orchestrator/gates.mjs --quick',
    ])
      expect(GE.tamperReason(k), k).toBeNull();
  });
});

describe('S4: the secret scan finishes inside the hook time limit', () => {
  it('one overall deadline, with margin below the push guard hook timeout', () => {
    const hooks = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', '..', '..', 'hooks', 'hooks.json'), 'utf8'));
    const guard = JSON.stringify(hooks);
    const m = /hook-push-guard\.mjs"\],"timeout":(\d+)/.exec(guard);
    expect(m, 'the push guard hook has a timeout').not.toBeNull();
    expect(typeof SS.DEADLINE_MS).toBe('number');
    expect(SS.DEADLINE_MS + 3000).toBeLessThanOrEqual(Number(m![1]) * 1000);
  });

  it('a scan over the deadline is incomplete, which asks; a large timeoutMs cannot push it past the deadline', () => {
    const { dir, g } = repo('rt-secret-deadline-');
    g(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    fs.writeFileSync(path.join(dir, 'b.txt'), 'two\n');
    g(['add', '.']);
    g(['commit', '-q', '-m', 'second']);
    const at = (deadlineMs: number) =>
      SS.scanPush({ cwd: dir, remote: 'origin', branch: 'main', setup: { timeoutMs: 600_000 }, deadlineMs });
    const late = at(0);
    expect(late.incomplete).toMatch(/took too long/);
    expect(SS.question(late)).toMatch(/did not finish/);
    // In time: the same scan completes (and is clean).
    expect(at(SS.DEADLINE_MS)).toEqual({ hits: [], scanner: expect.any(String) });
  });

  it('the hint never tells the owner to raise timeoutMs past the hook limit', () => {
    for (const why of ['the scan took too long', 'what this push sends is too large to scan', 'the scan failed'])
      expect(SS.question({ hits: [], scanner: 'none', incomplete: why }), why).not.toMatch(/timeoutMs/);
  });
});

describe('S5: every well-known program-valued git config key counts', () => {
  const RUN = [
    'gpg.program', 'gpg.openpgp.program', 'gpg.x509.program', 'gpg.ssh.program', 'gpg.ssh.defaultKeyCommand',
    'core.editor', 'sequence.editor', 'core.askPass', 'core.gitProxy', 'core.alternateRefsCommand',
    'diff.Bin.textconv', 'diff.Bin.command', 'pager.log', 'remote.origin.uploadpack', 'remote.origin.receivepack',
    'mergetool.Kd.cmd', 'mergetool.Kd.path', 'difftool.Kd.cmd', 'difftool.Kd.path', 'credential.helper',
    'credential.https://example.invalid.helper', 'interactive.diffFilter', 'sendemail.sendmailCmd', 'sendemail.toCmd',
    'sendemail.ccCmd', 'sendemail.headerCmd', 'sendemail.smtpServer', 'sendemail.work.smtpServer',
    'uploadpack.packObjectsHook', 'trailer.sign.command', 'trailer.sign.cmd', 'submodule.lib.update', 'include.path',
    'includeIf.gitdir:~/w/.path', 'browser.ff.cmd', 'browser.ff.path', 'man.viewer.cmd', 'man.viewer.path',
    'guitool.lint.cmd', 'gui.editor',
  ];

  it('isExecKey knows each of them, in any case, and ordinary keys stay out', () => {
    for (const k of RUN) {
      expect(GX.isExecKey(k), k).toBe(true);
      expect(GX.isExecKey(k.toUpperCase()), k).toBe(true);
    }
    for (const k of ['user.email', 'core.autocrlf', 'pager', 'gpg.format', 'web.browser', 'diff.tool', 'merge.tool', 'remote.origin.url', 'commit.gpgsign'])
      expect(GX.isExecKey(k), k).toBe(false);
  });

  it('the surface reads them (git config --list), so a planted value is seen', () => {
    const list = ['gpg.program\nx', 'core.editor\nx', 'diff.bin.textconv\nx', 'user.name\nx', ''].join('\0');
    expect(Object.keys(GX.parseConfigList(list)).sort()).toEqual(['core.editor', 'diff.bin.textconv', 'gpg.program']);
  });

  it('-c with one of them is unread, so a push in the same line is denied for a queue agent', () => {
    for (const k of ['gpg.program', 'core.editor', 'diff.x.textconv', 'pager.log', 'remote.origin.uploadpack'])
      expect(PG.assess(`git -c ${k}="git push origin HEAD:main" log`, track)?.decision, k).toBe('deny');
  });

  it('a queue agent may read them but not set them with git config; the main session is free', () => {
    for (const k of ['git config core.editor vim', 'git config --global gpg.program gpg2', 'git config --add pager.log less', 'git config set sequence.editor vim'])
      expect(PG.assess(k, track)?.decision, k).toBe('deny');
    for (const k of ['git config --get core.editor', 'git config --list', 'git config get gpg.program', 'git config user.email a@b.c'])
      expect(PG.assess(k, track)?.decision ?? null, k).toBeNull();
    expect(PG.assess('git config core.editor vim', { baseBranch: 'main', branch: 'main' })?.decision ?? null).toBeNull();
  });
});

describe('G4: cleanup-worktree never deletes a folder that may hold a live worktree or a repository', () => {
  /** A main repo with a folder under .claude/worktrees/; `cleanup` runs the unregistered-folder cleanup on it. */
  function project() {
    const { dir, g } = repo('rt-cleanup-unreg-');
    const root = path.join(dir, '.claude', 'worktrees');
    fs.mkdirSync(root, { recursive: true });
    const cleanup = (folder: string, execute = true) => cleanupUnregistered(folder, { minAgeHours: 0, main: dir, execute });
    return { dir, g, root, cleanup };
  }

  it('a folder whose .git is a directory (its own repository) is kept, also in a dry run', () => {
    const { root, g, cleanup } = project();
    const nested = path.join(root, 'nested');
    fs.mkdirSync(nested);
    g(['init', '-q'], nested);
    fs.writeFileSync(path.join(nested, 'work.txt'), 'unsaved\n');
    expect(cleanup(nested, false).status).toBe('skipped');
    const r = cleanup(nested);
    expect(r.status).toBe('skipped');
    expect(r.message).toMatch(/repository of its own/);
    expect(fs.existsSync(path.join(nested, 'work.txt'))).toBe(true);
  });

  it('a folder whose .git file points to an existing gitdir (a real worktree git does not list) is kept, with git worktree repair', () => {
    const { root, g, cleanup } = project();
    const live = path.join(root, 'live');
    g(['worktree', 'add', '-q', '-b', 'queue/live', live]);
    fs.writeFileSync(path.join(live, 'work.txt'), 'unsaved\n');
    const r = cleanup(live);
    expect(r.status).toBe('skipped');
    expect(r.message).toMatch(/git worktree repair/);
    expect(fs.existsSync(path.join(live, 'work.txt'))).toBe(true);
  });

  it('a .git file that points nowhere (the project was moved) is kept, since git status cannot read it', () => {
    const { dir, root, cleanup } = project();
    const moved = path.join(root, 'moved');
    fs.mkdirSync(moved);
    fs.writeFileSync(path.join(moved, '.git'), `gitdir: ${path.join(dir, 'old-place', '.git', 'worktrees', 'moved')}\n`);
    fs.writeFileSync(path.join(moved, 'work.txt'), 'unsaved\n');
    const r = cleanup(moved);
    expect(r.status).toBe('skipped');
    expect(r.message).toMatch(/git status/);
    expect(r.message).toMatch(/git worktree repair/);
    expect(fs.existsSync(path.join(moved, 'work.txt'))).toBe(true);
  });

  it('a real leftover (no .git, nothing git status shows) is still removed', () => {
    const { root, cleanup } = project();
    const left = path.join(root, 'left');
    fs.mkdirSync(path.join(left, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(left, 'sub', 'x.txt'), 'x\n');
    expect(cleanup(left, false).status).toBe('would remove');
    expect(cleanup(left).status).toBe('removed');
    expect(fs.existsSync(left)).toBe(false);
  });
});
