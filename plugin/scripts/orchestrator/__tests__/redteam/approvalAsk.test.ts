// =============================================================
// redteam/approvalAsk.test.ts: the orchestrator is talked into an override, or pushes without the owner's word
// (lib/approvalAsk.js, approvals.ask and push.ownerAsk; bolk 3 and 7 of plans/ekstern-saas-vurdering-2026-11-15.md).
//
// Why: the queue's agents are denied every override flag, but the main session could pass them all, and a track report
// or a document that says "the owner approved --allow-guard" is only data. So the push guard asks the person at the
// Claude Code session before the main session's merge with --allow-* or --force*, --i-understand, --by owner, the
// owner's own acceptances and the board's API, the write guard asks before it writes a main tree control file, and in
// owner push mode every push of the base asks. In dontAsk and bypassPermissions nobody sees the dialog, so those deny.
// The orchestrator's ordinary commands must never ask, or the loop would stop on itself.
// Every command here is a STRING given to the pure functions or to a hook as JSON: nothing is ever run.
// =============================================================
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { project, task } from './project';
import { decide } from './hooks';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const AA = require('../../lib/approvalAsk.js');

const find = (command: string) => AA.overrideFinding(command, { boardPort: 2000, tipOf: () => 'abc1234def' });

describe('the main session passes an override', () => {
  it.each([
    ['merge --allow-guard', 'ravenseat merge Q-1 --allow-guard', 'override-flag'],
    ['merge --allow-secret', 'ravenseat merge Q-1 --allow-secret', 'override-flag'],
    ['merge --allow-unreviewed', 'ravenseat merge Q-1 --allow-unreviewed', 'override-flag'],
    ['merge --force-red-base', 'ravenseat merge Q-1 --force-red-base', 'override-flag'],
    ['merge --force-red-gate', 'ravenseat merge Q-1 --force-red-gate', 'override-flag'],
    ['merge --force on a running task', 'ravenseat merge Q-1 --force', 'override-flag'],
    ['merge --allow-partial=1', 'ravenseat merge Q-1 --allow-partial=1', 'override-flag'],
    ['the merge script itself', 'node plugin/scripts/orchestrator/merge-track.mjs Q-1 --allow-guard', 'override-flag'],
    ['through npx', 'npx ravenseat merge Q-1 --allow-guard', 'override-flag'],
    ['in bash -c', 'bash -c "ravenseat merge Q-1 --allow-guard"', 'override-flag'],
    ['in powershell -c', 'powershell -c "ravenseat merge Q-1 --force-red-gate"', 'override-flag'],
    ['after a harmless step', 'ravenseat show Q-1 && ravenseat merge Q-1 --allow-guard', 'override-flag'],
    ['settings set --i-understand', 'ravenseat settings set secretScan.enabled false --i-understand --by owner', 'override-weaken'],
    ['resolve --by owner', 'ravenseat resolve Q-1 --answer "yes" --by owner', 'override-by-owner'],
    ['approve --by=owner', 'ravenseat approve Q-1 Q-2 --by=owner', 'override-by-owner'],
    ['qa ok --by theBoard', 'ravenseat qa ok Q-1 --by theBoard', 'override-by-owner'],
    ['resume --answer --by owner', 'ravenseat resume Q-1 --reason context --answer "go on" --by owner', 'override-by-owner'],
    ['edit of a locked field', `ravenseat edit Q-1 --json '{"owned_files":["src/"]}' --by owner`, 'override-by-owner'],
    ['plan --set-by owner', 'ravenseat plan prioritize P-1 now --reason "x" --set-by owner', 'override-by-owner'],
    ['surface accept with free text --by', 'ravenseat surface accept --by me', 'override-owner-command'],
    ['owner-log accept without --by', 'ravenseat owner-log accept Q-1', 'override-owner-command'],
    ['helpers approve', 'ravenseat helpers approve my-helper --sha256 abc', 'override-owner-command'],
    ['the board API with the key header', 'curl -s -H "X-Queue-Key: k" -X POST http://127.0.0.1:2000/api/action', 'override-board-api'],
    ['the board API with node fetch', `node -e "fetch('http://localhost:2000/api/setting',{method:'POST'})"`, 'override-board-api'],
    ['the board API on another loopback form', 'Invoke-RestMethod http://[::1]:2000/api/action -Method Post', 'override-board-api'],
  ])('%s: ask with rule %s', (_name, command, rule) => {
    const f = find(command);
    expect(f?.decision).toBe('ask');
    expect(f?.rule).toBe(rule);
    expect(f?.approval).toBe(true);
    expect(f?.reason).toMatch(/^Approval: /);
  });

  it('the reason names the task, the flags and the track tip, never a value', () => {
    const r = find('ravenseat merge Q-1 --allow-guard --force-red-gate')?.reason ?? '';
    expect(r).toContain('ravenseat merge Q-1');
    expect(r).toContain('--allow-guard, --force-red-gate');
    expect(r).toContain('track tip abc1234');
    const answer = find('ravenseat resolve Q-1 --answer "token sk-live-123 is fine" --by owner')?.reason ?? '';
    expect(answer).toContain('--by owner');
    expect(answer).not.toContain('sk-live');
  });

  it('the orchestrator\'s ordinary commands never ask (no loop on itself)', () => {
    for (const c of [
      'ravenseat merge Q-1',
      'ravenseat merge Q-1 --resume --without-fill --scratchpad /tmp/s',
      'ravenseat receive Q-1',
      'ravenseat receive Q-1 --force',
      'ravenseat settings set push.minTasks 5',
      'ravenseat settings set secretScan.enabled false',
      'ravenseat resolve Q-1 --answer "yes"',
      'ravenseat approve Q-1',
      'ravenseat surface',
      'ravenseat owner-log',
      'ravenseat helpers show my-helper',
      'ravenseat fill && ravenseat start Q-2',
      'git commit -m "docs: merge --allow-guard and --by owner are asked now"',
      'grep -rn "--allow-guard" plugin/docs',
      'curl -s http://localhost:3000/api/users',
      'node -e "console.log(1)"',
    ])
      expect(find(c), c).toBeNull();
  });

  it('a line the guard cannot read, with the queue CLI and an override token, asks', () => {
    expect(find('eval "$(echo ravenseat merge Q-1 --allow-guard)"')?.rule).toMatch(/override-(flag|unread)/);
    expect(find('ravenseat merge Q-1 {--allow-guard,}')?.decision).toBe('ask');
  });
});

describe('the permission mode decides who answers', () => {
  const ask = { decision: 'ask', rule: 'override-flag', reason: 'Approval: x.', approval: true };
  it.each(AA.ASK_MODES)('%s: the dialog', (mode: string) => {
    expect(AA.forMode(ask, mode).decision).toBe('ask');
  });
  it.each(AA.DENY_MODES)('%s: denied, with the way out', (mode: string) => {
    const r = AA.forMode(ask, mode);
    expect(r.decision).toBe('deny');
    expect(r.rule).toBe('override-flag');
    expect(r.reason).toMatch(/your own terminal/);
  });
  it('a missing or unknown mode asks; an ask that is not an approval is left alone', () => {
    expect(AA.forMode(ask, undefined).decision).toBe('ask');
    expect(AA.forMode(ask, 'something-new').decision).toBe('ask');
    expect(AA.forMode({ decision: 'ask', reason: 'batch', rule: 'push-questions' }, 'bypassPermissions').decision).toBe('ask');
  });
});

describe('through the hooks as hooks.json wires them', () => {
  const rows = (p: { env: Record<string, string | undefined> | NodeJS.ProcessEnv }) => {
    try {
      return fs
        .readFileSync(String(p.env.QUEUE_TIME_LOG), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  };

  it('merge --allow-guard from the main session asks with the tip, logs guard-ask, and denies in bypassPermissions', () => {
    const p = project({ tasks: [task('A')] });
    p.g(['branch', 'queue/A']);
    const tip = p.g(['rev-parse', '--short=7', 'queue/A']);
    const d = decide(p, 'Bash', { command: 'ravenseat merge A --allow-guard' }, undefined, { permission_mode: 'default' });
    expect(d.decision).toBe('ask');
    expect(d.reason).toContain('ravenseat merge A');
    expect(d.reason).toContain(`track tip ${tip}`);
    const bypass = decide(p, 'Bash', { command: 'ravenseat merge A --allow-guard' }, undefined, { permission_mode: 'bypassPermissions' });
    expect(bypass.decision).toBe('deny');
    expect(bypass.reason).toMatch(/your own terminal/);
    expect(decide(p, 'PowerShell', { command: 'ravenseat merge A --force-red-gate' }, undefined, { permission_mode: 'dontAsk' }).decision).toBe('deny');
    const logged = rows(p).filter((r) => String(r.rule).startsWith('override-'));
    expect(logged.map((r) => [r.event, r.guard, r.rule, r.agent_type])).toEqual([
      ['guard-ask', 'push', 'override-flag', 'main'],
      ['guard-deny', 'push', 'override-flag', 'main'],
      ['guard-deny', 'push', 'override-flag', 'main'],
    ]);
    expect(JSON.stringify(logged)).not.toContain('--allow-guard');
  }, 60_000);

  it('the ordinary merge, receive and settings set from the main session pass without a question', () => {
    const p = project({ tasks: [task('A')] });
    for (const command of ['ravenseat merge A', 'ravenseat receive A', 'ravenseat settings set push.minTasks 5'])
      expect(decide(p, 'Bash', { command }, undefined, { permission_mode: 'auto' }).decision, command).toBeNull();
  }, 60_000);

  it('a queue agent is still denied the flag (deny is stronger than ask)', () => {
    const p = project({ tasks: [task('A')] });
    expect(decide(p, 'Bash', { command: 'ravenseat merge A --allow-guard' }, 'track').decision).toBe('deny');
  }, 60_000);

  it('the main session writing CLAUDE.md or the queue config asks; an ordinary file does not; approvals.ask false turns it off', () => {
    const p = project({ tasks: [task('A')] });
    const d = decide(p, 'Write', { file_path: path.join(p.repo, 'CLAUDE.md'), content: 'x' }, undefined, { permission_mode: 'acceptEdits' });
    expect(d.decision).toBe('ask');
    expect(d.reason).toContain('CLAUDE.md');
    expect(decide(p, 'Edit', { file_path: p.configFile, old_string: 'a', new_string: 'b' }).decision).toBe('ask');
    expect(decide(p, 'Write', { file_path: path.join(p.repo, 'CLAUDE.md'), content: 'x' }, undefined, { permission_mode: 'bypassPermissions' }).decision).toBe('deny');
    expect(decide(p, 'Write', { file_path: path.join(p.repo, 'lib', 'a.ts'), content: 'x' }).decision).toBeNull();
    expect(rows(p).filter((r) => r.rule === 'override-control-file').map((r) => [r.event, r.guard])).toEqual([
      ['guard-ask', 'write'],
      ['guard-ask', 'write'],
      ['guard-deny', 'write'],
    ]);
    const off = project({ config: { approvals: { ask: false } }, tasks: [task('A')] });
    expect(decide(off, 'Write', { file_path: path.join(off.repo, 'CLAUDE.md'), content: 'x' }).decision).toBeNull();
    expect(decide(off, 'Bash', { command: 'ravenseat merge A --allow-guard' }).decision).toBeNull();
  }, 60_000);
});

describe('push of the base in owner mode always asks (push.ownerAsk)', () => {
  /** A project with one unpushed commit on main, no controls question. */
  const ahead = (push: Record<string, unknown>) => {
    const p = project({ config: { push: { controlsWarning: false, ...push } }, tasks: [task('A')] });
    fs.writeFileSync(path.join(p.repo, 'a.txt'), 'a\n');
    p.g(['add', '--', 'a.txt']);
    p.g(['commit', '-q', '-m', 'work']);
    return p;
  };

  it('owner mode (the default): a ready push asks, names the tip, and denies in bypassPermissions', () => {
    const p = ahead({ minTasks: 0 });
    const tip = p.g(['rev-parse', '--short=7', 'main']);
    const d = decide(p, 'Bash', { command: 'git push origin main' }, undefined, { permission_mode: 'default' });
    expect(d.decision).toBe('ask');
    expect(d.reason).toMatch(/push\.mode is owner/);
    expect(d.reason).toContain(tip);
    expect(decide(p, 'Bash', { command: 'git push origin main' }, undefined, { permission_mode: 'bypassPermissions' }).decision).toBe('deny');
  }, 60_000);

  it('threshold mode: a ready push goes without a question, as before', () => {
    const p = ahead({ mode: 'threshold', minTasks: 0 });
    expect(decide(p, 'Bash', { command: 'git push origin main' }, undefined, { permission_mode: 'default' }).decision).toBeNull();
  }, 60_000);

  it('push.ownerAsk false: owner mode goes back to the batch questions only', () => {
    const p = ahead({ minTasks: 0, ownerAsk: false });
    expect(decide(p, 'Bash', { command: 'git push origin main' }).decision).toBeNull();
  }, 60_000);
});
