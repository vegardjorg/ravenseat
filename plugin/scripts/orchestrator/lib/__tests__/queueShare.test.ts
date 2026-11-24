// =============================================================
// queueShare.test.ts: sharing the queue's files in git (lib/queueShare.js, H3) and the private paths (lib/privatePaths.js, H4).
//
// Why: the data folder holds harmless data (queue.json, the plan register) next to sensitive data (the time log,
// missions, transcript extracts, the owner's answers). Sharing is off by default and an allow list when on; a list of
// files can never be shared whatever the setting says. The project's own private folders are one list that feeds the
// .gitignore, the push and merge guard, the read guard and the cloud's hidden paths. These lock the pure rules the CLI,
// the hooks and merge share.
// =============================================================
import { describe, expect, it } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const QS = require('../queueShare.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const PP = require('../privatePaths.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const KK = require('../queueConfig.js');

const on = (extra: Record<string, unknown> = {}) => ({ ...KK.STANDARD, share: { ...KK.STANDARD.share, queueData: true, ...extra } });

describe('share: the defaults', () => {
  it('off, with queue.json and the plan register as the list, and no private paths', () => {
    expect(KK.STANDARD.share).toEqual({ queueData: false, include: ['queue.json', 'plans.json'], publicOk: false });
    expect(KK.STANDARD.privatePaths).toEqual([]);
    expect(QS.shareOf(KK.STANDARD)).toMatchObject({ on: false, include: ['queue.json', 'plans.json'] });
    expect(QS.ignoreLines(KK.STANDARD)).toEqual([]);
  });

  it('on only when queueData is exactly true', () => {
    for (const v of ['true', 1, null]) expect(QS.shareOf({ ...KK.STANDARD, share: { queueData: v } }).on).toBe(false);
    expect(QS.shareOf(on()).on).toBe(true);
  });
});

describe('share: never shareable', () => {
  const NEVER = [
    'times.jsonl',
    'times-2026-10.jsonl',
    'missions',
    'mission.md',
    'handover.md',
    'queue-track-fill.md',
    'track-result.md',
    'checks-report.json',
    'transcript-excerpt.txt',
    'owner-log.json',
    'owner-questions.json',
    'merge.lock',
    'wait.lock',
    '.mergeLock',
    '.waitLock',
    'times.jsonl.starts.idx',
    'findings.jsonl.lastid.idx',
    'gate-evidence.json',
    'board-key.txt',
    'setup-tips.json',
  ];
  it('each is refused with a reason', () => {
    for (const f of NEVER) expect(QS.includeProblem(f, KK.STANDARD), f).toMatch(/never/);
  });

  it('a configured time log is refused by its own name too', () => {
    expect(QS.includeProblem('work-hours.jsonl', { ...KK.STANDARD, timeLog: 'scripts/.queue/work-hours.jsonl' })).toMatch(/time log/);
  });

  it('only a plain file name in the data folder; the defaults and the archive are fine', () => {
    for (const f of ['queue.json', 'plans.json', 'queue-archive.json']) expect(QS.includeProblem(f, KK.STANDARD), f).toBeNull();
    for (const f of ['../x.json', 'sub/queue.json', '*.json', '', 7]) expect(QS.includeProblem(f, KK.STANDARD), String(f)).toMatch(/name/);
  });

  it('shareOf keeps the valid names and reports the rest; a never-file in the config is never shared', () => {
    const s = QS.shareOf(on({ include: ['queue.json', 'times.jsonl'] }));
    expect(s.include).toEqual(['queue.json']);
    expect(s.problems.join(' ')).toMatch(/times\.jsonl/);
  });
});

describe('share: the .gitignore lines', () => {
  it('on: <dataFolder>/* and one exception per file', () => {
    expect(QS.ignoreLines(on())).toEqual(['scripts/.queue/*', '!scripts/.queue/queue.json', '!scripts/.queue/plans.json']);
    expect(QS.ignoreLines(on({ include: ['queue.json'] }))).toEqual(['scripts/.queue/*', '!scripts/.queue/queue.json']);
  });

  it('editGitignore: on swaps the folder line for the pattern; off removes the exceptions', () => {
    const before = '# mine\nnode_modules/\nscripts/.queue/\n.env\n';
    const required = ['scripts/.queue/*', '!scripts/.queue/queue.json', '.env'];
    const opened = QS.editGitignore(before, { required, remove: ['scripts/.queue/', 'scripts/.queue'], keepExceptions: ['queue.json'], dataFolder: 'scripts/.queue' });
    expect(opened.text.split('\n')).toEqual(expect.arrayContaining(['# mine', 'node_modules/', '.env', 'scripts/.queue/*', '!scripts/.queue/queue.json']));
    expect(opened.text.split('\n')).not.toContain('scripts/.queue/');
    expect(opened.removed).toEqual(['scripts/.queue/']);
    const closed = QS.editGitignore(opened.text, { required: ['scripts/.queue/*', '.env'], remove: [], keepExceptions: [], dataFolder: 'scripts/.queue' });
    expect(closed.text).not.toContain('!scripts/.queue/');
    expect(closed.removed).toEqual(['!scripts/.queue/queue.json']);
    // Nothing to do: the same text.
    expect(QS.editGitignore(closed.text, { required: ['.env'], remove: [], keepExceptions: [], dataFolder: 'scripts/.queue' }).text).toBe(closed.text);
  });

  it('keeps CRLF when the file has it', () => {
    const r = QS.editGitignore('a\r\nscripts/.queue/\r\n', { required: ['scripts/.queue/*'], remove: ['scripts/.queue/'], keepExceptions: [], dataFolder: 'scripts/.queue' });
    expect(r.text).toBe('a\r\n\r\n# Ravenseat (the queue\'s data, the agents\' worktrees and local secrets)\r\nscripts/.queue/*\r\n');
  });
});

describe('the guard: what a commit may not track', () => {
  const files = ['lib/a.ts', 'scripts/.queue/queue.json', 'scripts/.queue/times.jsonl', 'docs/notes/plan.md'];

  it('share off: any file in the data folder; on: only what include lists', () => {
    expect(QS.breaches(files, KK.STANDARD).map((b: { file: string }) => b.file)).toEqual(['scripts/.queue/queue.json', 'scripts/.queue/times.jsonl']);
    expect(QS.breaches(files, on()).map((b: { file: string }) => b.file)).toEqual(['scripts/.queue/times.jsonl']);
  });

  it('a private path is a breach whatever share says', () => {
    const cfg = { ...on(), privatePaths: ['docs/notes/'] };
    expect(QS.breaches(files, cfg)).toEqual([
      { file: 'scripts/.queue/times.jsonl', kind: 'data' },
      { file: 'docs/notes/plan.md', kind: 'private' },
    ]);
  });

  it('public or unknown since share on: a reason until --public-ok; private: none', () => {
    expect(QS.publicReason(on(), { visibility: 'private' })).toBeNull();
    expect(QS.publicReason(on(), { visibility: 'public' })).toMatch(/public/);
    expect(QS.publicReason(on(), null)).toMatch(/not known/);
    expect(QS.publicReason(on({ publicOk: true }), { visibility: 'public' })).toBeNull();
    expect(QS.publicReason(KK.STANDARD, { visibility: 'public' })).toBeNull();
  });

  it('denyReason names the files and the way out, never their content', () => {
    const r = QS.denyReason({ files, cfg: { ...KK.STANDARD, privatePaths: ['docs/notes/'] }, cache: null, cli: 'ravenseat' });
    expect(r).toMatch(/scripts\/\.queue\/queue\.json/);
    expect(r).toMatch(/docs\/notes\/plan\.md/);
    expect(r).toMatch(/git rm --cached/);
    expect(QS.denyReason({ files: ['lib/a.ts'], cfg: KK.STANDARD, cache: null, cli: 'ravenseat' })).toBeNull();
    // The visibility rule refuses a push that carries a shared file; other work goes out as before.
    expect(QS.denyReason({ files: ['lib/a.ts'], cfg: on(), cache: { visibility: 'public' }, cli: 'ravenseat' })).toBeNull();
    expect(QS.denyReason({ files: ['scripts/.queue/queue.json'], cfg: on(), cache: { visibility: 'public' }, cli: 'ravenseat' })).toMatch(/public/);
    expect(QS.denyReason({ files: ['scripts/.queue/queue.json'], cfg: on(), cache: { visibility: 'private' }, cli: 'ravenseat' })).toBeNull();
  });
});

describe('privatePaths', () => {
  it('both forms, normalised; the bad ones reported', () => {
    const cfg = { privatePaths: ['docs/notes/', { path: 'ops\\secret', read: false }, '../out', { path: '' }, 5] };
    expect(PP.entries(cfg)).toEqual([
      { path: 'docs/notes', line: 'docs/notes/', read: true },
      { path: 'ops/secret', line: 'ops/secret', read: false },
    ]);
    expect(PP.problems(cfg)).toHaveLength(3);
  });

  it('matches a path and what is under it, not a sibling with the same start', () => {
    const cfg = { privatePaths: ['docs/notes/'] };
    expect(PP.matching('docs/notes/a.md', cfg)?.path).toBe('docs/notes');
    expect(PP.matching('docs/notes', cfg)?.path).toBe('docs/notes');
    expect(PP.matching('docs/notesbook.md', cfg)).toBeNull();
  });

  it('read: false is denied in the main tree and in an agent worktree, the rest is not', () => {
    const cfg = { privatePaths: ['docs/notes/', { path: 'ops/keys/', read: false }] };
    const root = '/p/proj';
    expect(PP.readDenied('/p/proj/ops/keys/x.md', { root, cfg })?.path).toBe('ops/keys');
    expect(PP.readDenied('/p/proj/.claude/worktrees/queue-A/ops/keys/x.md', { root, cfg })?.path).toBe('ops/keys');
    expect(PP.readDenied('/p/proj/docs/notes/x.md', { root, cfg })).toBeNull();
    expect(PP.readDenied('/elsewhere/ops/keys/x.md', { root, cfg })).toBeNull();
  });

  it('the cloud hides them too, as one list', () => {
    expect(PP.cloudHiddenOf({ cloudHidden: ['docs/private/'], privatePaths: ['docs/notes/', 'docs/private/'] })).toEqual(['docs/private/', 'docs/notes/']);
  });

  it('add and remove keep the other entries and their form', () => {
    let list = PP.addEntry([], 'docs/notes/', { read: true });
    list = PP.addEntry(list, 'ops/keys', { read: false });
    expect(list).toEqual(['docs/notes/', { path: 'ops/keys', read: false }]);
    // Adding again replaces the entry (here: read back on).
    expect(PP.addEntry(list, 'ops/keys/', { read: true })).toEqual(['docs/notes/', 'ops/keys/']);
    expect(PP.removeEntry(list, 'docs/notes')).toEqual([{ path: 'ops/keys', read: false }]);
  });
});
