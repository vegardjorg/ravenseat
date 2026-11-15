// =============================================================
// broadPermissions.test.ts: the broad rules in the shared .claude/settings.json (lib/broadPermissions.js).
//
// Why: a rule in the tracked settings file applies to every clone and every agent. The check names the few rules that
// open whole groups of risky actions, and must stay quiet on the narrow rules most projects have (Bash(npm test:*)),
// or nobody turns it on twice. bypassPermissions is the one important gap.
// =============================================================
import { describe, expect, it } from 'vitest';

import { findBroad, hasBypass, kindOf } from '../broadPermissions';

const settings = (permissions: Record<string, unknown>) => JSON.stringify({ permissions }, null, 2);

describe('kindOf', () => {
  it('names any shell command, the network tools, rm, git push and WebFetch without a domain', () => {
    const cases: [string, string][] = [
      ['Bash', 'any-shell'],
      ['Bash(*)', 'any-shell'],
      ['Bash(:*)', 'any-shell'],
      ['Bash(curl:*)', 'network'],
      ['Bash(curl *)', 'network'],
      ['Bash(wget:*)', 'network'],
      ['Bash(ssh:*)', 'network'],
      ['Bash(Invoke-WebRequest:*)', 'network'],
      ['Bash(rm:*)', 'rm'],
      ['Bash(rm -rf:*)', 'rm'],
      ['Bash(git push:*)', 'git-push'],
      ['Bash(git push --force:*)', 'git-push'],
      ['Bash(git:*)', 'git-push'],
      ['WebFetch', 'web-fetch'],
      ['WebFetch(*)', 'web-fetch'],
      ['WebFetch(domain:*)', 'web-fetch'],
    ];
    for (const [rule, kind] of cases) expect(kindOf(rule), rule).toBe(kind);
  });

  it('leaves the narrow rules alone', () => {
    for (const rule of [
      'Bash(npm test:*)',
      'Bash(npm run lint)',
      'Bash(git status:*)',
      'Bash(git diff:*)',
      'Bash(git push origin main)',
      'Bash(rm -rf dist)',
      'Bash(curl -s http://localhost:3000/health)',
      'Bash(curly:*)',
      'Bash(npx prettier --check .)',
      'WebFetch(domain:docs.example.com)',
      'Read(**)',
      'Edit',
    ])
      expect(kindOf(rule), rule).toBeNull();
  });
});

describe('findBroad', () => {
  it('gives the place, the rule and the level; bypassPermissions is the important gap', () => {
    const hits = findBroad(
      JSON.stringify({ permissions: { defaultMode: 'bypassPermissions', allow: ['Bash(npm test:*)', 'Bash(*)', 'Bash(curl:*)', 42, 'WebFetch'] } }),
    );
    expect(hits).toEqual([
      { at: 'permissions.defaultMode', rule: 'bypassPermissions', kind: 'bypass', level: 'warn' },
      { at: 'permissions.allow[1]', rule: 'Bash(*)', kind: 'any-shell', level: 'warn' },
      { at: 'permissions.allow[2]', rule: 'Bash(curl:*)', kind: 'network', level: 'info' },
      { at: 'permissions.allow[4]', rule: 'WebFetch', kind: 'web-fetch', level: 'info' },
    ]);
    expect(hasBypass(hits)).toBe(true);
  });

  it('acceptEdits is a warning, not the important gap; deny and ask lists are never read', () => {
    const hits = findBroad(JSON.stringify({ permissions: { defaultMode: 'acceptEdits', deny: ['Bash(rm:*)', 'Bash(curl:*)'], ask: ['Bash(git push:*)'] } }));
    expect(hits.map((h) => h.kind)).toEqual(['accept-edits']);
    expect(hasBypass(hits)).toBe(false);
  });

  it('a narrow file, a broken file and one without permissions give nothing', () => {
    expect(findBroad(settings({ allow: ['Bash(npm test:*)', 'Bash(npm run build)'], defaultMode: 'default' }))).toEqual([]);
    expect(findBroad('{ nope')).toEqual([]);
    expect(findBroad(JSON.stringify({ hooks: {} }))).toEqual([]);
  });
});
