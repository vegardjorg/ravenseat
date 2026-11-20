// =============================================================
// queuePlanFilterSort.test.ts: the pure rules behind P4 of plans/plans-tab-ux-review-2026-11-19.md (Filter, Sort and
// the toolbar in the Plans room, like the Tasks room), plus two small fixes seen after P1 to P3.
//
// What the tests prove:
//   - the facets have the sections the plan names, in its order (Horizon first, Has tasks before Set by), and the two
//     new ones (Horizon, Has tasks) round-trip through the url and filter,
//   - the Quick filters are valid filters, each with a one-line explanation, and the old ready-made views keep their ids,
//   - the Filter button says what is in use ("Filter", "Filter · 2", "Filter · Inbox"),
//   - every sort orders as its name says, and Roadmap order keeps the register's order,
//   - a saved view keeps a valid sort and drops an invalid one,
//   - the next step reads on its own ("AUTH-3 is running", not "Next step: Running now: AUTH-3"),
//   - the progress of a plan is a percent with words ("43% done, 3 of 7 tasks"), none without tasks.
// =============================================================
import { describe, it, expect } from 'vitest';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const V = require('../queuePlanView.js') as any;
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

type Post = Record<string, unknown>;
function entry(id: string, extra: Post = {}): Post {
  return {
    id,
    title: `Title ${id}`,
    summary: null,
    project: 'auth',
    module: 'account',
    priority: 'later',
    now_category: [],
    priority_set_by: 'owner',
    maturity: 'idea',
    size: 'M',
    deadline: null,
    sources: [],
    ownerQuestions: [],
    legal_open: 0,
    stale: false,
    finished: 0,
    total: 0,
    queue: [],
    active: null,
    inbox: null,
    lead: null,
    history: [],
    depends_on: [],
    blocks: [],
    created: null,
    ...extra,
  };
}

describe('the filter sections', () => {
  it('come in the order the plan names: Horizon, Area, Project, Priority, ..., Has tasks, Set by, Verification', () => {
    expect(V.FACETS.map((f: Post) => f.title)).toEqual([
      'Horizon',
      'Area',
      'Project',
      'Priority',
      'Now category',
      'Maturity',
      'Waiting on',
      'Deadline',
      'Has tasks',
      'Priority set by',
      'Verification',
    ]);
  });

  it('Horizon and Has tasks round-trip through the url', () => {
    const t = V.readUrl('?room=plans&hz=inbox,now&tasks=yes');
    expect(t.filter.horizon).toEqual(['inbox', 'now']);
    expect(t.filter.tasks).toEqual(['yes']);
    expect(V.writeUrl(t)).toBe('?room=plans&hz=inbox%2Cnow&tasks=yes');
    expect(V.readUrl('?room=plans&hz=nowhere').filter.horizon).toEqual([]);
  });

  it('Horizon filters on the roadmap horizon; Dropped shows the dropped ones', () => {
    const list = [
      entry('PL-A', { priority: 'now', maturity: 'partial', total: 2, finished: 1 }),
      entry('PL-B', { priority: 'drop' }),
      entry('PL-C'),
    ];
    const ids = (filter: Post) => V.filter(list, { ...V.emptyFilter(), ...filter }, '').map((p: Post) => p.id);
    expect(ids({ horizon: ['now'] })).toEqual(['PL-A']);
    expect(ids({ horizon: ['dropped'] })).toEqual(['PL-B']);
    expect(ids({})).toEqual(['PL-A', 'PL-C']);
  });

  it('Has tasks counts the tasks that are not cancelled', () => {
    const list = [
      entry('PL-A', { queue: [{ id: 'A-1', status: 'done' }] }),
      entry('PL-B', { queue: [{ id: 'B-1', status: 'cancelled' }] }),
      entry('PL-C'),
    ];
    const ids = (v: string) => V.filter(list, { ...V.emptyFilter(), tasks: [v] }, '').map((p: Post) => p.id);
    expect(ids('yes')).toEqual(['PL-A']);
    expect(ids('no')).toEqual(['PL-B', 'PL-C']);
  });

  it('the counts of the Horizon section include Dropped, so it can be chosen', () => {
    const list = [entry('PL-A'), entry('PL-B', { priority: 'drop' })];
    const hz = V.facetNumber(list, V.emptyFilter(), '').find((f: Post) => f.id === 'horizon');
    expect(hz.option.map((o: Post) => `${o.text} ${o.count}`)).toEqual(['Later 1', 'Dropped 1']);
  });
});

describe('Quick filters', () => {
  it('the plan\'s list, in order, each a valid filter with a one-line explanation', () => {
    expect(V.QUICK_FILTERS.map((v: Post) => v.name)).toEqual([
      'Waiting on you',
      'Inbox',
      'Being built',
      'Ready to become tasks',
      'Before prod',
      'Security',
      'Stale',
      'Dropped by Claude',
    ]);
    for (const v of V.QUICK_FILTERS) {
      expect(V.countFilters(V.readUrl(v.search).filter)).toBeGreaterThan(0);
      expect(typeof v.explain).toBe('string');
      expect(v.explain.length).toBeGreaterThan(10);
      expect(v.explain).not.toMatch(/—/);
    }
  });

  it('the old ready-made views keep their ids (and DONE_VIEWS still names the list)', () => {
    const ids = V.QUICK_FILTERS.map((v: Post) => v.id);
    for (const id of ['for-prod', 'security', 'waiting', 'stale', 'drop-agent']) expect(ids).toContain(id);
    expect(V.DONE_VIEWS).toBe(V.QUICK_FILTERS);
  });
});

describe('the Filter button says what is in use', () => {
  const state = (search: string) => V.readUrl(search);

  it('nothing, a count, or the name of the quick or saved filter in use', () => {
    expect(V.filterButtonText(state('?room=plans'), []).text).toBe('Filter');
    expect(V.filterButtonText(state('?room=plans&pri=now&mod=idea'), []).text).toBe('Filter · 2');
    expect(V.filterButtonText(state('?room=plans&hz=inbox'), []).text).toBe('Filter · Inbox');
    const own = [{ name: 'My auth', search: '?room=plans&module=account&q=sync' }];
    expect(V.filterButtonText(state('?room=plans&module=account&q=sync'), own).text).toBe('Filter · My auth');
    // a saved view is only "in use" with its own search
    expect(V.filterButtonText(state('?room=plans&module=account'), own).text).toBe('Filter · 1');
  });

  it('the label for a screen reader names the filter and the count', () => {
    const b = V.filterButtonText(state('?room=plans&hz=inbox'), []);
    expect(b.label).toBe('Filter, Inbox in use, 1 active');
    expect(b.active).toBe(true);
    expect(V.filterButtonText(state('?room=plans'), []).active).toBe(false);
  });
});

describe('Sort', () => {
  it('the plan\'s sorts, Roadmap order first and the default', () => {
    expect(V.PLAN_SORTS.map((x: Post) => x.text)).toEqual([
      'Roadmap order',
      'Recently changed',
      'Recently added',
      'Deadline',
      'Title',
      'Most blocked',
    ]);
    expect(V.cleanSort('nonsense')).toBe('roadmap');
    expect(V.cleanSort('title')).toBe('title');
    for (const x of V.PLAN_SORTS) expect(x.explain.length).toBeGreaterThan(5);
  });

  const list = [
    entry('PL-B', {
      title: 'Bravo',
      created: '2026-11-01',
      deadline: '2026-12-24',
      history: [{ nr: 3, at: '2026-11-18T10:00:00Z' }],
    }),
    entry('PL-A', { title: 'alpha', created: '2026-11-10', history: [{ nr: 2, at: '2026-11-05T10:00:00Z' }] }),
    entry('PL-C', {
      title: 'Charlie',
      created: null,
      deadline: '2026-12-01',
      blocks: ['PL-A', 'PL-B'],
      ownerQuestions: [{ id: 'Q-1', resolved: false }],
    }),
    entry('PL-D', { title: 'delta', created: '2026-10-01', blocks: ['PL-A'] }),
  ];
  const ids = (sort: string) => V.sortPlans(list, sort).map((p: Post) => p.id);

  it('Roadmap order keeps the register order (it is already sorted by the priority rules)', () => {
    expect(ids('roadmap')).toEqual(['PL-B', 'PL-A', 'PL-C', 'PL-D']);
  });
  it('Recently changed: the latest change first, never changed last', () => {
    expect(ids('changed')).toEqual(['PL-B', 'PL-A', 'PL-C', 'PL-D']);
  });
  it('Recently added: the newest first, unknown last', () => {
    expect(ids('added')).toEqual(['PL-A', 'PL-B', 'PL-D', 'PL-C']);
  });
  it('Deadline: the nearest first, none last', () => {
    expect(ids('deadline')).toEqual(['PL-C', 'PL-B', 'PL-A', 'PL-D']);
  });
  it('Title: A to Z, ignoring case', () => {
    expect(ids('title')).toEqual(['PL-A', 'PL-B', 'PL-C', 'PL-D']);
  });
  it('Most blocked: held by an open question first, then by how many plans wait on it', () => {
    expect(ids('blocked')).toEqual(['PL-C', 'PL-D', 'PL-B', 'PL-A']);
  });
  it('does not change the list it is given', () => {
    const before = list.map((p) => p.id);
    V.sortPlans(list, 'title');
    expect(list.map((p) => p.id)).toEqual(before);
  });

  it('group by area keeps the chosen order when the sort is not Roadmap order', () => {
    const area = V.roadmapSections(
      [entry('PL-1', { maturity: 'built' }), entry('PL-2')],
      { group: 'area', modules: [{ oid: 'account', title: 'Account' }], order: 'given' },
    );
    expect(area[0].entries.map((p: Post) => p.id)).toEqual(['PL-1', 'PL-2']);
    const rank = V.roadmapSections(
      [entry('PL-1', { maturity: 'built' }), entry('PL-2')],
      { group: 'area', modules: [{ oid: 'account', title: 'Account' }] },
    );
    expect(rank[0].entries.map((p: Post) => p.id)).toEqual(['PL-2', 'PL-1']);
  });
});

describe('saved views carry over', () => {
  it('an old saved view (name and search) still cleans to the same', () => {
    expect(V.cleanOwnView({ name: 'Mine', search: '?room=plans&pri=now' })).toEqual({
      name: 'Mine',
      search: '?room=plans&pri=now',
    });
  });
  it('a valid sort is kept, an invalid one dropped', () => {
    expect(V.cleanOwnView({ name: 'Mine', search: '?room=plans&pri=now', sort: 'deadline' }).sort).toBe('deadline');
    expect(V.cleanOwnView({ name: 'Mine', search: '?room=plans&pri=now', sort: 'x' })).not.toHaveProperty('sort');
  });
});

describe('the next step reads on its own (fix 1)', () => {
  it('a running task and a waiting task', () => {
    const running = V.planStatus(
      entry('PL-A', { priority: 'now', maturity: 'partial', finished: 3, total: 7, queue: [{ id: 'AUTH-3', column: 'inProgress' }] }),
    );
    expect(running.next).toBe('AUTH-3 is running');
    const waiting = V.planStatus(
      entry('PL-A', { priority: 'now', maturity: 'in-queue', total: 2, queue: [{ id: 'AUTH-4', column: 'queue' }] }),
    );
    expect(waiting.next).toBe('AUTH-4 is next in the queue');
  });
});

describe('the progress of a plan (fix 3)', () => {
  it('tasks done of the total, as a percent and in words', () => {
    expect(V.planProgress(entry('PL-A', { finished: 3, total: 7 }))).toEqual({
      done: 3,
      total: 7,
      percent: 43,
      text: '43% done, 3 of 7 tasks',
    });
    expect(V.planProgress(entry('PL-A', { finished: 1, total: 1 })).text).toBe('100% done, 1 of 1 task');
  });
  it('none without tasks', () => {
    expect(V.planProgress(entry('PL-A'))).toBe(null);
    expect(V.planProgress(entry('PL-A', { finished: 0, total: 0 }))).toBe(null);
  });
});
