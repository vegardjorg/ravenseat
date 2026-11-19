// =============================================================
// taskLinks.test.ts: the documents behind a task (lib/taskLinks.js, roadmap 0p2 step B1).
//
// Why: a task links to its reading material through its plan entry (`plan`, whose sources carry path, anchor and role)
// and the optional task `sources`; `source` only says where the task came from. Later steps build on one pure lookup:
// the add/edit warning and the doctor row (B2), the mission's read-first list (B3) and the anchor check in plan check
// (V3). These lock the rules they share: which roles are reading material, how anchors are found (the mission's own
// sectionArea), dead files, gitignored files (absolute main-tree path), private files (privatePaths read: false), the
// cap of 12, and a stable order without duplicates.
// =============================================================
import { describe, expect, it } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const TL = require('../taskLinks.js');

/** A plan document with numbered sections and one heading without a number. */
const PLAN_DOC = [
  '# Auth plan',
  '',
  '## 1. Today',
  'text',
  '',
  '## 2. The rule',
  'text',
  '### 2.1 Details',
  'more',
  '',
  '## Sync',
  'sync text',
].join('\n');

const DOCS: Record<string, string> = {
  'docs/auth-plan.md': PLAN_DOC,
  'docs/spec.md': '# Spec\n\n## 3.2 Anchors\nbody\n',
  'docs/history.md': '# Old\n',
  'docs/ref.md': '# Reference\n',
  'docs/internal/study.md': '# Study\n\n## 4 Guards\nx\n',
  'docs/secret/owner.md': '# Owner notes\n\n## 1 Money\nx\n',
};

/** The injected helpers: a file reader over DOCS, git check-ignore for docs/internal/ and docs/secret/. */
function ctx(extra: Record<string, unknown> = {}) {
  return {
    readFile: (p: string) => DOCS[p] ?? null,
    isIgnored: (p: string) => p.startsWith('docs/internal/') || p.startsWith('docs/secret/'),
    mainRoot: 'C:/work/project',
    config: { privatePaths: [{ path: 'docs/secret/', read: false }] },
    register: {
      entries: [
        {
          id: 'PL-AUTH',
          sources: [
            { path: 'docs/auth-plan.md', anchor: '§ 2', role: 'plan' },
            { path: 'docs/history.md', role: 'history' },
            { path: 'docs/spec.md', anchor: '3.2', role: 'spec' },
            { path: 'docs/ref.md', role: 'reference' },
            { path: 'docs/internal/study.md', anchor: '§ 4', role: 'investigation' },
          ],
        },
        { id: 'PL-NOROLE', sources: [{ path: 'docs/auth-plan.md' }] },
      ],
      archive: { 'PL-OLD': { merged_to: 'PL-AUTH' } },
    },
    ...extra,
  };
}

const paths = (links: { path: string }[]) => links.map((l) => l.path);

describe('taskLinks: the plan entry', () => {
  it('takes the sources with a readable role (plan, investigation, spec) and leaves history and reference out', () => {
    const r = TL.taskLinks({ id: 'A', plan: 'PL-AUTH' }, ctx());
    expect(r.plan).toEqual({ id: 'PL-AUTH', state: 'found' });
    expect(paths(r.links)).toEqual(['docs/auth-plan.md', 'docs/spec.md', 'docs/internal/study.md']);
    expect(r.links.every((l: { from: string; planId: string }) => l.from === 'plan' && l.planId === 'PL-AUTH')).toBe(true);
    expect(TL.READABLE_ROLES).toEqual(['plan', 'investigation', 'spec']);
  });

  it('counts a source without a role as the plan itself (plan check reads it for status too)', () => {
    const r = TL.taskLinks({ id: 'A', plan: 'PL-NOROLE' }, ctx());
    expect(r.links).toHaveLength(1);
    expect(r.links[0]).toMatchObject({ path: 'docs/auth-plan.md', role: null, readable: true });
  });

  it('names an unknown and a merged plan id as a problem, and links nothing from it', () => {
    const u = TL.taskLinks({ id: 'A', plan: 'PL-NONE' }, ctx());
    expect(u.plan).toEqual({ id: 'PL-NONE', state: 'unknown' });
    expect(u.problems).toEqual([{ kind: 'plan', id: 'PL-NONE' }]);
    const m = TL.taskLinks({ id: 'A', plan: 'PL-OLD' }, ctx());
    expect(m.plan).toEqual({ id: 'PL-OLD', state: 'merged', mergedTo: 'PL-AUTH' });
    expect(m.problems[0]).toMatchObject({ kind: 'plan', id: 'PL-OLD' });
    expect(TL.taskLinks({ id: 'A' }, ctx()).plan).toEqual({ id: null, state: 'none' });
  });
});

describe('taskLinks: the task sources', () => {
  it('reads the task sources, and they narrow the plan: the plan sources are then left out', () => {
    const r = TL.taskLinks(
      { id: 'A', plan: 'PL-AUTH', sources: [{ path: 'docs/spec.md', anchor: '§ 3.2' }] },
      ctx(),
    );
    expect(r.narrowed).toBe(true);
    expect(r.links).toHaveLength(1);
    expect(r.links[0]).toMatchObject({ path: 'docs/spec.md', from: 'sources', readable: true, anchorHit: true });
  });

  it('leaves a task source with a non-readable role out of the read list but still checks it', () => {
    const r = TL.taskLinks({ id: 'A', sources: [{ path: 'docs/gone.md', role: 'history' }] }, ctx());
    expect(r.links[0]).toMatchObject({ path: 'docs/gone.md', readable: false, exists: false });
    expect(r.read).toEqual([]);
    expect(r.problems).toEqual([{ kind: 'dead', path: 'docs/gone.md', anchor: null, from: 'sources' }]);
  });
});

describe('taskLinks: source is origin only', () => {
  it('finds a path in source and checks it, but never puts it in the read list', () => {
    const r = TL.taskLinks({ id: 'A', source: 'review of AUTH-2, finding M1 (docs/auth-plan.md § 2)' }, ctx());
    expect(r.links).toHaveLength(1);
    expect(r.links[0]).toMatchObject({
      path: 'docs/auth-plan.md',
      anchor: '§ 2',
      from: 'source',
      readable: false,
      exists: true,
      anchorHit: true,
    });
    expect(r.read).toEqual([]);
    expect(r.counts.nothingToRead).toBe(true);
  });

  it('takes a #anchor and a backticked path, and skips URLs, absolute paths and plain text', () => {
    expect(TL.sourcePaths('see `docs/auth-plan.md#sync` and https://x.org/a.md')).toEqual([
      { path: 'docs/auth-plan.md', anchor: '#sync' },
    ]);
    expect(TL.sourcePaths('owner 18.11, C:/x/y.md and ../up.md')).toEqual([]);
    expect(TL.sourcePaths(undefined)).toEqual([]);
  });
});

describe('taskLinks: the checks', () => {
  it('a missing file is dead: no anchor check, no read entry, one problem', () => {
    const r = TL.taskLinks({ id: 'A', sources: [{ path: 'docs/moved.md', anchor: '§ 1' }] }, ctx());
    expect(r.links[0]).toMatchObject({ exists: false, anchorHit: null, lines: null, readPath: null });
    expect(r.problems).toEqual([{ kind: 'dead', path: 'docs/moved.md', anchor: '§ 1', from: 'sources' }]);
    expect(r.counts).toMatchObject({ dead: 1, anchorMiss: 0 });
  });

  it('an anchor that hits gives the line range; one that misses is a problem and reads the whole file', () => {
    const r = TL.taskLinks(
      {
        id: 'A',
        sources: [
          { path: 'docs/auth-plan.md', anchor: '#sync' },
          { path: 'docs/auth-plan.md', anchor: '§ 9' },
        ],
      },
      ctx(),
    );
    expect(r.links[0]).toMatchObject({ anchorHit: true, lines: { from: 11, to: 12 }, entry: 'docs/auth-plan.md:11-12' });
    expect(r.links[1]).toMatchObject({ anchorHit: false, lines: null, entry: 'docs/auth-plan.md' });
    expect(r.problems).toEqual([{ kind: 'anchor', path: 'docs/auth-plan.md', anchor: '§ 9', from: 'sources' }]);
    expect(r.counts.anchorMiss).toBe(1);
  });

  it('a numbered § anchor finds its section with the subsections, and not a longer number', () => {
    const r = TL.taskLinks({ id: 'A', sources: [{ path: 'docs/auth-plan.md', anchor: '§ 2' }] }, ctx());
    expect(r.links[0].lines).toEqual({ from: 6, to: 9 });
    expect(TL.anchorQuery('§ 2.1')).toEqual({ section: '2.1' });
    expect(TL.anchorQuery('3.2')).toEqual({ section: '3.2' });
    expect(TL.anchorQuery('#Sync')).toEqual({ anchor: 'sync' });
    expect(TL.anchorQuery('  ')).toBeNull();
    const two = TL.taskLinks({ id: 'A', sources: [{ path: 'docs/auth-plan.md', anchor: '§ 2.1' }] }, ctx());
    expect(two.links[0].lines).toEqual({ from: 8, to: 9 });
  });

  it('a gitignored file gets the absolute main-tree path, and is counted', () => {
    const r = TL.taskLinks({ id: 'A', plan: 'PL-AUTH' }, ctx());
    const study = r.links.find((l: { path: string }) => l.path === 'docs/internal/study.md');
    expect(study).toMatchObject({
      ignored: true,
      private: false,
      readPath: 'C:/work/project/docs/internal/study.md',
      entry: 'C:/work/project/docs/internal/study.md:3-4',
    });
    expect(r.counts.ignored).toBe(1);
    expect(r.problems).toContainEqual({ kind: 'ignored', path: 'docs/internal/study.md', anchor: '§ 4', from: 'plan' });
    // A tracked file keeps its repo-relative path.
    expect(r.links[0].readPath).toBe('docs/auth-plan.md');
  });

  it('a private file (privatePaths read: false) gets no path for the agent, only the private flag', () => {
    const r = TL.taskLinks({ id: 'A', sources: [{ path: 'docs/secret/owner.md', anchor: '§ 1' }] }, ctx());
    expect(r.links[0]).toMatchObject({ exists: true, ignored: true, private: true, readPath: null, entry: null });
    expect(r.read).toEqual([]);
    expect(r.private.map((l: { path: string }) => l.path)).toEqual(['docs/secret/owner.md']);
    expect(r.counts).toMatchObject({ private: 1, ignored: 0, nothingToRead: false });
    // A private path with read: true is only gitignored: the agent may read it.
    const open = TL.taskLinks(
      { id: 'A', sources: [{ path: 'docs/secret/owner.md' }] },
      ctx({ config: { privatePaths: ['docs/secret/'] } }),
    );
    expect(open.links[0]).toMatchObject({ private: false, readPath: 'C:/work/project/docs/secret/owner.md' });
  });

  it('never throws when a helper throws: the file is then dead and not ignored', () => {
    const r = TL.taskLinks(
      { id: 'A', sources: [{ path: 'docs/spec.md' }] },
      ctx({
        readFile: () => {
          throw new Error('boom');
        },
        isIgnored: () => {
          throw new Error('boom');
        },
      }),
    );
    expect(r.links[0]).toMatchObject({ exists: false, ignored: false });
  });
});

describe('taskLinks: the cap and the order', () => {
  it('caps the readable links at 12 (or max) and counts the rest', () => {
    const many = Array.from({ length: 15 }, (_, i) => ({ path: 'docs/auth-plan.md', anchor: `#n${i}` }));
    const r = TL.taskLinks({ id: 'A', sources: many }, ctx());
    expect(TL.LINKS_MAX).toBe(12);
    expect(r.read).toHaveLength(12);
    expect(r.overCap).toBe(3);
    expect(r.read[0].anchor).toBe('#n0');
    expect(TL.taskLinks({ id: 'A', sources: many }, ctx({ max: 2 })).read).toHaveLength(2);
  });

  it('dedupes on path and anchor, first one wins, so the readable link beats the origin copy', () => {
    const r = TL.taskLinks(
      {
        id: 'A',
        source: 'docs/spec.md § 3.2',
        sources: [
          { path: 'docs/spec.md', anchor: '§ 3.2' },
          { path: './docs/spec.md', anchor: '3.2' },
          { path: 'docs/spec.md' },
        ],
      },
      ctx(),
    );
    expect(r.links.map((l: { path: string; anchor: string | null; from: string }) => [l.path, l.anchor, l.from])).toEqual([
      ['docs/spec.md', '§ 3.2', 'sources'],
      ['docs/spec.md', null, 'sources'],
    ]);
  });

  it('gives the same result for the same input (stable order)', () => {
    const t = { id: 'A', plan: 'PL-AUTH', source: 'docs/ref.md' };
    expect(TL.taskLinks(t, ctx())).toEqual(TL.taskLinks(t, ctx()));
    expect(paths(TL.taskLinks(t, ctx()).links)).toEqual([
      'docs/auth-plan.md',
      'docs/spec.md',
      'docs/internal/study.md',
      'docs/ref.md',
    ]);
  });
});
