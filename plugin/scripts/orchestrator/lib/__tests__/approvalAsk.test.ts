// =============================================================
// approvalAsk.test.ts: the pure parts of lib/approvalAsk.js and the owner-mode push question in lib/pushBatch.js.
//
// Why: the main session's overrides ask (approvals.ask) and, in push mode owner, every push of the base asks
// (push.ownerAsk). The red team file (__tests__/redteam/approvalAsk.test.ts) holds the forms an override can take and
// the hooks end to end; this file holds the settings, the control file set for the main session, the doctor reading of
// a PermissionRequest hook and the pushBatch question.
// =============================================================
import { describe, it, expect } from 'vitest';
import path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const AA = require('../approvalAsk.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const PB = require('../pushBatch.js');

const ROOT = path.resolve('/work/repo');

describe('setupOf', () => {
  it('on unless approvals.ask is exactly false', () => {
    expect(AA.setupOf({}).ask).toBe(true);
    expect(AA.setupOf({ approvals: { ask: 'no' } }).ask).toBe(true);
    expect(AA.setupOf({ approvals: { ask: false } }).ask).toBe(false);
  });
});

describe('controlWriteFinding (the main session)', () => {
  const at = (file: string, scriptsDir: string | null = path.resolve('/plugins/cache/ravenseat/scripts/orchestrator')) =>
    AA.controlWriteFinding({ filePath: file, mainTree: ROOT, scriptsDir, configFile: path.join(ROOT, 'queue.config.json') });

  it.each([
    ['queue.config.json', path.join(ROOT, 'queue.config.json')],
    ['.claude/settings.json', path.join(ROOT, '.claude', 'settings.json')],
    ['CLAUDE.md', path.join(ROOT, 'CLAUDE.md')],
    ['a nested CLAUDE.local.md', path.join(ROOT, 'docs', 'CLAUDE.local.md')],
    ['.git/hooks/pre-push', path.join(ROOT, '.git', 'hooks', 'pre-push')],
    ['.git/config', path.join(ROOT, '.git', 'config')],
    ['the installed plugin scripts', path.resolve('/plugins/cache/ravenseat/scripts/orchestrator/hook-push-guard.mjs')],
  ])('%s: ask, an approval, with the path in the reason', (_name, file) => {
    const f = at(file);
    expect(f).toMatchObject({ decision: 'ask', rule: 'override-control-file', approval: true });
    expect(f.reason).toMatch(/^Approval: the main session writes /);
  });

  it('ordinary files, the worktrees folder and the project\'s own copy of the scripts do not ask', () => {
    expect(at(path.join(ROOT, 'lib', 'a.ts'))).toBeNull();
    expect(at(path.join(ROOT, '.claude', 'worktrees', 'agent-A', 'CLAUDE.md'))).toBeNull();
    // Developing the plugin in its own repo: the scripts are the project's source, not an installed guard.
    const own = path.join(ROOT, 'plugin', 'scripts', 'orchestrator');
    expect(at(path.join(own, 'lib', 'pushGuard.js'), own)).toBeNull();
  });
});

describe('permissionHookFindings (doctor)', () => {
  const hook = (matcher?: string) => ({ hooks: { PermissionRequest: [{ ...(matcher === undefined ? {} : { matcher }), hooks: [] }] } });
  it.each([[undefined], [''], ['*'], ['Bash'], ['Bash|Read'], ['.*'], ['Write|Edit'], ['Power.*']])('matcher %j is broad', (m) => {
    expect(AA.permissionHookFindings([{ file: 's.json', settings: hook(m) }])).toHaveLength(1);
  });
  it('a narrow matcher, no hooks, a broken file: nothing', () => {
    expect(AA.permissionHookFindings([{ file: 's.json', settings: hook('WebFetch') }])).toEqual([]);
    expect(AA.permissionHookFindings([{ file: 's.json', settings: { hooks: { PreToolUse: [] } } }])).toEqual([]);
    expect(AA.permissionHookFindings([{ file: 's.json', settings: null }])).toEqual([]);
  });
});

describe('boardApi', () => {
  it('the key header anywhere, or the board port on loopback with /api/', () => {
    expect(AA.boardApi('curl -H "x-queue-key: k" http://example.invalid/', 2000)).toBe(true);
    expect(AA.boardApi('curl http://127.0.0.1:2000/api/state', 2000)).toBe(true);
    expect(AA.boardApi('curl http://127.0.0.1:2111/api/state', 2111)).toBe(true);
    expect(AA.boardApi('curl http://127.0.0.1:3000/api/state', 2000)).toBe(false);
    expect(AA.boardApi('curl http://127.0.0.1:2000/', 2000)).toBe(false);
  });
});

describe('overrideFinding behind a package runner', () => {
  it('npm exec, pnpx and bunx are looked through like npx', () => {
    for (const c of [
      'npm exec ravenseat merge Q-1 --allow-guard',
      'npm exec -- ravenseat merge Q-1 --allow-guard',
      'pnpx ravenseat merge Q-1 --allow-guard',
      'bunx ravenseat merge Q-1 --allow-guard',
    ]) {
      expect(AA.overrideFinding(c, { boardPort: 2000 })?.rule, c).toBe('override-flag');
    }
    expect(AA.overrideFinding('npx -y ravenseat merge Q-1 --allow-guard', { boardPort: 2000 })?.rule).toBe('override-flag');
    expect(AA.overrideFinding('npx -p ravenseat ravenseat merge Q-1 --force', { boardPort: 2000 })?.rule).toBe('override-flag');
    // -c / --call take a command string: read as unread text, like eval.
    expect(AA.overrideFinding('npm exec -c "ravenseat merge Q-1 --allow-guard"', { boardPort: 2000 })?.rule).toBe('override-unread');
    expect(AA.overrideFinding('npx --call "ravenseat merge Q-1 --force"', { boardPort: 2000 })?.rule).toBe('override-unread');
    expect(AA.overrideFinding('npm exec ravenseat merge Q-1', { boardPort: 2000 }), 'a plain merge').toBeNull();
    expect(AA.overrideFinding('npm exec -c "ravenseat merge Q-1"', { boardPort: 2000 }), 'a plain merge in -c').toBeNull();
  });
});

describe('pushBatch ownerQuestion (push.ownerAsk)', () => {
  const batch = { tasks: ['A', 'B'], taskCount: 2, commits: 5, firstParent: 3, tip: 'abcdef1234', oldestAt: null };
  it('owner mode (the default): asks with the base, the tip and the tasks', () => {
    const q = PB.ownerQuestion({ cfg: {}, batch, base: 'main' });
    expect(q).toMatch(/^push\.mode is owner: main at abcdef1 /);
    expect(q).toContain('2 merged task(s) (A, B)');
    expect(PB.ownerAskOn({})).toBe(true);
  });
  it('a batch that could not be read still asks; an empty one does not', () => {
    expect(PB.ownerQuestion({ cfg: {}, batch: null, base: 'main', tip: '1234567890' })).toMatch(/main at 1234567 .*could not count/);
    expect(PB.ownerQuestion({ cfg: {}, batch: { ...batch, firstParent: 0, taskCount: 0, tasks: [] }, base: 'main' })).toBeNull();
  });
  it('threshold mode and ownerAsk false: no question', () => {
    expect(PB.ownerQuestion({ cfg: { push: { mode: 'threshold' } }, batch, base: 'main' })).toBeNull();
    expect(PB.ownerQuestion({ cfg: { push: { ownerAsk: false } }, batch, base: 'main' })).toBeNull();
  });
  it('setupProblems names a wrong ownerAsk', () => {
    expect(PB.setupProblems({ ownerAsk: 'yes' })).toContain('push.ownerAsk must be true or false');
    expect(PB.setupProblems({ ownerAsk: false })).toEqual([]);
  });
});
