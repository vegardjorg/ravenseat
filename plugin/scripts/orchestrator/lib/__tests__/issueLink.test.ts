// =============================================================
// issueLink.test.ts: the link from a task or plan entry to its GitHub issue (lib/issueLink.js, GH-2).
//
// Locks: (1) the stored shape is { repo: "owner/name", number } and anything else is refused with a reason; (2) the
// link is built only from that stored repo (which comes from the origin remote), never from text in the issue; (3)
// `--issue 12` takes the repo from the origin remote, `--issue owner/name#12` names it; (4) the Refs trailer is
// "Refs: #12" for the origin repo and "Refs: owner/name#12" for another, and never says Closes; (5) the trailer is
// added once, after a blank line, and not at all with issues.refsTrailer false.
// =============================================================
import { describe, expect, it } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const IL = require('../issueLink.js');

describe('issueErrors', () => {
  it('accepts { repo, number } and nothing else', () => {
    expect(IL.issueErrors({ repo: 'acme/tool', number: 12 })).toEqual([]);
    expect(IL.issueErrors(undefined)).toEqual([]);
    expect(IL.issueErrors(null)).toEqual([]);
    expect(IL.issueErrors(12).length).toBe(1);
    expect(IL.issueErrors({ repo: 'acme/tool', number: 0 }).length).toBe(1);
    expect(IL.issueErrors({ repo: 'acme/tool', number: 1.5 }).length).toBe(1);
    expect(IL.issueErrors({ repo: 'acme', number: 3 }).length).toBe(1);
    expect(IL.issueErrors({ repo: 'acme/tool/x', number: 3 }).length).toBe(1);
    expect(IL.issueErrors({ repo: 'acme/<b>', number: 3 }).length).toBe(1);
    expect(IL.issueErrors({ repo: 'acme/tool', number: 3, url: 'https://elsewhere.example' }).join(' ')).toMatch(/unknown field url/);
  });
});

describe('issueView', () => {
  it('builds the link from the stored repo only', () => {
    expect(IL.issueView({ repo: 'acme/tool', number: 12 })).toEqual({
      repo: 'acme/tool',
      number: 12,
      label: 'Issue #12',
      url: 'https://github.com/acme/tool/issues/12',
    });
  });
  it('gives nothing for a broken value, so no link is drawn', () => {
    expect(IL.issueView({ repo: 'javascript:alert/x', number: 1 })).toBeNull();
    expect(IL.issueView({ repo: 'acme/tool', number: '12' })).toBeNull();
    expect(IL.issueView(null)).toBeNull();
  });
});

describe('parseIssueArg', () => {
  it('takes the repo from the origin remote for a bare number', () => {
    expect(IL.parseIssueArg('12', 'acme/tool')).toEqual({ issue: { repo: 'acme/tool', number: 12 }, error: null });
    expect(IL.parseIssueArg('#7', 'acme/tool')).toEqual({ issue: { repo: 'acme/tool', number: 7 }, error: null });
  });
  it('reads owner/name#n', () => {
    expect(IL.parseIssueArg('other/repo#3', 'acme/tool').issue).toEqual({ repo: 'other/repo', number: 3 });
    expect(IL.parseIssueArg('other/repo#3', null).issue).toEqual({ repo: 'other/repo', number: 3 });
  });
  it('refuses a bare number without a GitHub origin, and junk', () => {
    expect(IL.parseIssueArg('12', null).error).toMatch(/origin/);
    expect(IL.parseIssueArg('twelve', 'acme/tool').error).toBeTruthy();
    expect(IL.parseIssueArg('0', 'acme/tool').error).toBeTruthy();
  });
  it('reads none, null and an empty value as removing the link', () => {
    expect(IL.parseIssueArg('none', 'acme/tool')).toEqual({ issue: null, error: null });
    expect(IL.parseIssueArg('', 'acme/tool')).toEqual({ issue: null, error: null });
  });
});

describe('originRepo', () => {
  it('reads owner/name from a GitHub remote, null otherwise', () => {
    expect(IL.originRepo('git@github.com:acme/tool.git')).toBe('acme/tool');
    expect(IL.originRepo('https://github.com/acme/tool')).toBe('acme/tool');
    expect(IL.originRepo('https://gitlab.com/acme/tool.git')).toBeNull();
    expect(IL.originRepo(null)).toBeNull();
  });
});

describe('the Refs trailer', () => {
  it('is Refs, short for the origin repo, long for another', () => {
    expect(IL.refsLine({ repo: 'acme/tool', number: 12 }, 'acme/tool')).toBe('Refs: #12');
    expect(IL.refsLine({ repo: 'other/repo', number: 3 }, 'acme/tool')).toBe('Refs: other/repo#3');
    expect(IL.refsLine({ repo: 'acme/tool', number: 12 }, null)).toBe('Refs: acme/tool#12');
    expect(IL.refsLine(null, 'acme/tool')).toBeNull();
  });
  it('never closes the issue', () => {
    expect(IL.refsLine({ repo: 'acme/tool', number: 12 }, 'acme/tool')).not.toMatch(/close|fix|resolve/i);
  });
  it('is added once after a blank line, and not with the setting off', () => {
    const msg = 'Merge queue/A-1: title';
    const out = IL.withRefs(msg, { repo: 'acme/tool', number: 12 }, { originRepo: 'acme/tool', config: {} });
    expect(out).toBe('Merge queue/A-1: title\n\nRefs: #12');
    expect(IL.withRefs(out, { repo: 'acme/tool', number: 12 }, { originRepo: 'acme/tool', config: {} })).toBe(out);
    expect(IL.withRefs(msg, { repo: 'acme/tool', number: 12 }, { originRepo: 'acme/tool', config: { issues: { refsTrailer: false } } })).toBe(msg);
    expect(IL.withRefs(msg, null, { originRepo: 'acme/tool', config: {} })).toBe(msg);
  });
  it('joins an existing trailer block', () => {
    const msg = 'Merge queue/A-1: title\n\nQueue: orchestrator';
    expect(IL.withRefs(msg, { repo: 'acme/tool', number: 12 }, { originRepo: 'acme/tool', config: {} })).toBe(
      'Merge queue/A-1: title\n\nQueue: orchestrator\nRefs: #12',
    );
  });
});

describe('sameIssue', () => {
  it('matches repo case-insensitively and the number exactly', () => {
    expect(IL.sameIssue({ repo: 'Acme/Tool', number: 2 }, { repo: 'acme/tool', number: 2 })).toBe(true);
    expect(IL.sameIssue({ repo: 'acme/tool', number: 2 }, { repo: 'acme/tool', number: 3 })).toBe(false);
    expect(IL.sameIssue(null, { repo: 'acme/tool', number: 3 })).toBe(false);
  });
});
