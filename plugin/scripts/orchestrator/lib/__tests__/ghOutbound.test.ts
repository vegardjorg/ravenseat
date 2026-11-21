// =============================================================
// ghOutbound.test.ts: the shared outbound guard for every GitHub write (lib/ghOutbound.js; GH-3, GH-4, GH-5).
//
// Locks: (1) a body is only ever a fixed template: the task title goes in a code span with its backticks taken out, so
// a title cannot mention people, link or embed an image; (2) a secret-looking string anywhere in the body or the title
// blocks the write and the reason names the rule, never the text; (3) an empty body is refused; (4) a configured
// private path or a home folder path blocks; (5) the setups default to off and an unknown value reads as off; (6) the
// preview lists every target and the exact text, and says when the repo is public or unknown; (7) the preview hash
// changes with any posted character, so a post must match the preview the owner saw.
// Pure: nothing runs gh or the network.
// =============================================================
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const GO = require('../ghOutbound.js');

const SECRET = ['ghp', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('_');
const SHA = 'a'.repeat(40);
const TIP = 'b'.repeat(40);

describe('the fixed templates', () => {
  it('a comment names the task, the merge commit, the checks on the pushed tip and ends with Posted by Ravenseat', () => {
    const body = GO.commentBody({ id: 'GH-12', title: 'Fix the login', mergeCommit: SHA, tip: TIP, fullGate: 'green', action: 'comment' });
    expect(body).toContain('`GH-12`');
    expect(body).toContain('`Fix the login`');
    expect(body).toContain(SHA);
    expect(body).toContain(TIP.slice(0, 7));
    expect(body).toMatch(/full gate green/);
    expect(body.trim().split('\n').pop()).toBe('Posted by Ravenseat');
    expect(body).not.toMatch(/closed/i);
  });

  it('close mode says why the issue is closed', () => {
    const body = GO.commentBody({ id: 'A-1', title: 'x', mergeCommit: SHA, tip: TIP, fullGate: 'off', action: 'close' });
    expect(body).toMatch(/issues\.onPush is close/);
    expect(body).toMatch(/no full gate is set up/);
  });

  it('a title cannot mention, link or embed: backticks go, it sits in a code span, one line, capped', () => {
    const t = GO.safeTitle('@team see ![x](https://evil.example/p.png) `code`\nsecond line ' + 'y'.repeat(400));
    expect(t.startsWith('`')).toBe(true);
    expect(t.endsWith('`')).toBe(true);
    expect(t.slice(1, -1)).not.toContain('`');
    expect(t).not.toContain('\n');
    expect(t.length).toBeLessThanOrEqual(GO.TITLE_MAX + 2);
  });

  it('an id that is not an id shape is shown as unknown, never as given', () => {
    expect(GO.safeId('A-1')).toBe('`A-1`');
    expect(GO.safeId('A-1 @everyone')).toBe('`unknown`');
  });

  it('the pull request body lists the tasks with ids and titles, the checks on the tip, the caveats, and no door line', () => {
    const body = GO.prBody({
      tasks: [
        { id: 'A-1', title: 'One' },
        { id: 'A-2', title: 'Two' },
      ],
      tip: TIP,
      base: 'main',
      fullGate: 'missing',
      health: 'green',
      caveats: ['the full gate has not run on this tip'],
    });
    expect(body).toContain('`A-1`: `One`');
    expect(body).toContain('`A-2`: `Two`');
    expect(body).toMatch(/full gate not run on this commit/);
    expect(body).toMatch(/Caveats/);
    expect(body).toMatch(/the full gate has not run on this tip/);
    expect(body).not.toMatch(/Door|Blast radius/);
    expect(body.trim().split('\n').pop()).toBe('Posted by Ravenseat');
  });

  it('door and blast radius appear only when a task has them', () => {
    const body = GO.prBody({ tasks: [{ id: 'A-1', title: 'One', door: 'two-way', blast: 'small' }], tip: TIP, base: 'main', fullGate: 'green', health: 'green', caveats: [] });
    expect(body).toMatch(/door two-way/);
    expect(body).toMatch(/blast radius small/);
    expect(body).toMatch(/Caveats: none recorded/);
  });
});

describe('the guard', () => {
  it('passes a clean template', () => {
    const body = GO.commentBody({ id: 'A-1', title: 'Fix the login', mergeCommit: SHA, tip: TIP, fullGate: 'green', action: 'comment' });
    expect(GO.check({ body })).toEqual({ ok: true, problems: [] });
  });

  it('blocks a secret in the body and names the rule, never the text', () => {
    const body = GO.commentBody({ id: 'A-1', title: `rotate ${SECRET}`, mergeCommit: SHA, tip: TIP, fullGate: 'green', action: 'comment' });
    const r = GO.check({ body });
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toMatch(/secret/);
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it('blocks a secret in the title of a pull request or a release', () => {
    const r = GO.check({ body: 'fine body\nPosted by Ravenseat', title: `batch ${SECRET}` });
    expect(r.ok).toBe(false);
  });

  it('blocks a JWT and a Bearer value too (the redaction rules)', () => {
    const jwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'abcdefghijklmnop'].join('.');
    expect(GO.check({ body: `x ${jwt}` }).ok).toBe(false);
    expect(GO.check({ body: 'Authorization: Bearer abcdefghijklmnopqrstuvwx' }).ok).toBe(false);
  });

  it('refuses an empty or blank body', () => {
    for (const body of ['', '   \n  ', null, undefined]) {
      const r = GO.check({ body });
      expect(r.ok).toBe(false);
      expect(r.problems.join(' ')).toMatch(/empty/);
    }
  });

  it('blocks a configured private path and a home folder path', () => {
    const cfg = { privatePaths: ['docs/internal/'] };
    expect(GO.check({ body: 'see docs/internal/notes.md', cfg }).ok).toBe(false);
    expect(GO.check({ body: 'see C:\\Users\\someone\\x.txt' }).ok).toBe(false);
    expect(GO.check({ body: 'see /home/someone/x.txt' }).ok).toBe(false);
    expect(GO.check({ body: 'see docs/public.md', cfg }).ok).toBe(true);
  });

  it('fails closed when the scan throws', () => {
    const r = GO.check({ body: 'x', scan: () => { throw new Error('boom'); } });
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toMatch(/could not be scanned/);
  });
});

describe('the setups', () => {
  it('issues.onPush is off by default and on an unknown value', () => {
    expect(GO.onPushOf({})).toBe('off');
    expect(GO.onPushOf({ issues: { onPush: 'shout' } })).toBe('off');
    expect(GO.onPushOf({ issues: { onPush: 'comment' } })).toBe('comment');
    expect(GO.onPushOf({ issues: { onPush: 'close' } })).toBe('close');
  });

  it('push.pr is off by default and on an unknown value', () => {
    expect(GO.prModeOf({})).toBe('off');
    expect(GO.prModeOf({ push: { pr: 'yes' } })).toBe('off');
    expect(GO.prModeOf({ push: { pr: 'draft' } })).toBe('draft');
  });

  it('the batch branch name is ravenseat/batch-<date> in UTC', () => {
    expect(GO.batchBranch(new Date('2026-11-21T23:30:00Z'))).toBe('ravenseat/batch-2026-11-21');
  });

  it('a refusal outside the main session: a queue branch or a linked worktree', () => {
    expect(GO.mainSessionRefusal({ queueBranch: 'A-1', inWorktree: true })).toMatch(/A-1/);
    expect(GO.mainSessionRefusal({ queueBranch: null, inWorktree: true })).toMatch(/main checkout/);
    expect(GO.mainSessionRefusal({ queueBranch: null, inWorktree: false })).toBeNull();
  });
});

describe('the preview', () => {
  const items = [
    { target: 'acme/tool#12', action: 'comment', body: 'Body one\nPosted by Ravenseat' },
    { target: 'acme/tool#14', action: 'close', body: 'Body two\nPosted by Ravenseat' },
  ];

  it('lists each target and the exact text', () => {
    const lines = GO.previewLines({ what: 'issue comments', repo: 'acme/tool', visibility: 'private', items }).join('\n');
    expect(lines).toContain('acme/tool#12');
    expect(lines).toContain('acme/tool#14');
    expect(lines).toContain('Body one');
    expect(lines).toContain('Body two');
    expect(lines).not.toMatch(/public/i);
  });

  it('says so on a public repo, and treats unknown as possibly public', () => {
    expect(GO.previewLines({ what: 'x', repo: 'acme/tool', visibility: 'public', items }).join('\n')).toMatch(/PUBLIC/);
    expect(GO.previewLines({ what: 'x', repo: 'acme/tool', visibility: 'unknown', items }).join('\n')).toMatch(/may be public/);
  });

  it('the hash changes with any character of a body or a target', () => {
    const h = GO.previewHash(items);
    expect(GO.previewHash(items)).toBe(h);
    expect(GO.previewHash([{ ...items[0], body: `${items[0].body} ` }, items[1]])).not.toBe(h);
    expect(GO.previewHash([{ ...items[0], target: 'acme/tool#13' }, items[1]])).not.toBe(h);
  });

  it('the dialog summary names the kind, the targets and the visibility, never a body', () => {
    const s = GO.dialogSummary({ kind: 'issues-report', repo: 'acme/tool', visibility: 'public', items });
    expect(s).toMatch(/acme\/tool#12/);
    expect(s).toMatch(/public/i);
    expect(s).not.toContain('Body one');
  });
});
