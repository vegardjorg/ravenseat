// =============================================================
// queuePlanRoadmap.test.ts: the pure rules behind the Roadmap, the start page of the Plans room (P1 and P3 of
// plans/plans-tab-ux-review-2026-11-19.md, concept B with a column layout on wide screens).
//
// What the tests prove:
//   - every plan lands in exactly one horizon (Inbox, Waiting on you, Now, Next, Later, Done, Dropped), first match wins,
//     and a built plan is Done whatever its priority, so a finished plan never sits in Next or Later,
//   - the status in words and the next step are plain sentences derived from the data, with no new stored field,
//   - warnings (deadline, stale check, legal points) are words, never only an icon,
//   - the sentence under the title is the person's summary, else the lead from the plan document (marked as such),
//     clipped at a word boundary near 200 characters,
//   - the lead follows the task panel's rule (a purpose heading first, then a bold label, then the first prose
//     paragraph), starts at the source's anchor, and skips code, tables and KEY: value lines,
//   - the sections hold 300+ plans: counts per section, long sections folded past N, Done folded, nothing folded
//     while a search or filter is active,
//   - the layout follows the width (columns from 1200 px, always a list below 700 px), a remembered choice wins between,
//   - plansData sends the lead only for an entry without a summary, and marks a finding nobody has sorted as Inbox,
//   - the url knows the roadmap surface and the start view.
// =============================================================
import { describe, it, expect } from 'vitest';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const V = require('../queuePlanView.js') as any;
const P = require('../queuePlan.js') as any;
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

type Post = Record<string, unknown>;
const NOW = new Date('2026-11-19T12:00:00Z');

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
    verified: null,
    ...extra,
  };
}

describe('horizonFor: one horizon per plan, first match wins', () => {
  it('maps the register onto the horizons', () => {
    expect(V.horizonFor(entry('PL-A', { priority: 'drop' }))).toBe('dropped');
    expect(V.horizonFor(entry('PL-A', { inbox: { by: 'track', at: '2026-11-18' } }))).toBe('inbox');
    expect(V.horizonFor(entry('PL-A', { priority: 'now', maturity: 'built' }))).toBe('done');
    expect(V.horizonFor(entry('PL-A', { priority: 'later', maturity: 'verified' }))).toBe('done');
    expect(V.horizonFor(entry('PL-A', { priority: 'owner' }))).toBe('waiting');
    expect(
      V.horizonFor(entry('PL-A', { priority: 'now', ownerQuestions: [{ id: 'Q-1', resolved: false }] })),
    ).toBe('waiting');
    expect(
      V.horizonFor(entry('PL-A', { priority: 'now', ownerQuestions: [{ id: 'Q-1', resolved: true }] })),
    ).toBe('next');
    expect(V.horizonFor(entry('PL-A', { priority: 'now', maturity: 'in-queue' }))).toBe('now');
    expect(V.horizonFor(entry('PL-A', { priority: 'later', maturity: 'partial' }))).toBe('now');
    expect(V.horizonFor(entry('PL-A', { priority: 'later', active: { at: 'x', by: 's' } }))).toBe('now');
    expect(V.horizonFor(entry('PL-A', { priority: 'now', maturity: 'ready' }))).toBe('next');
    expect(V.horizonFor(entry('PL-A', { priority: 'later', maturity: 'planned' }))).toBe('later');
  });

  it('the horizons have plain names in roadmap order', () => {
    expect(V.HORIZONS.map((h: { id: string }) => h.id)).toEqual([
      'inbox',
      'waiting',
      'now',
      'next',
      'later',
      'done',
      'dropped',
    ]);
    expect(V.HORIZONS.find((h: { id: string }) => h.id === 'waiting').text).toBe('Waiting on you');
  });
});

describe('planStatus: status in words and the next step', () => {
  const st = (x: Post) => V.planStatus(entry('PL-A', x));

  it('says what is going on, in plain words', () => {
    expect(st({ priority: 'now', maturity: 'partial', finished: 3, total: 7 }).text).toBe(
      'Being built: 3 of 7 tasks done',
    );
    expect(st({ priority: 'now', maturity: 'ready' }).text).toBe('Ready to become tasks');
    expect(st({ priority: 'now', maturity: 'planned' }).text).toBe('Planned, not ready yet');
    expect(st({ priority: 'later', maturity: 'idea' }).text).toBe('Idea, needs shaping');
    expect(st({ priority: 'owner', ownerQuestions: [{ id: 'Q-SSO', resolved: false }] }).text).toBe(
      'Waiting on your answer to Q-SSO',
    );
    expect(st({ priority: 'owner' }).text).toBe('Waiting on your decision');
    expect(st({ maturity: 'built' }).text).toBe('Built, not checked against the code');
    expect(st({ maturity: 'verified' }).text).toBe('Built and checked against the code');
    expect(st({ maturity: 'verified', stale: true }).text).toBe('Built; the check against the code is stale');
    expect(st({ inbox: { by: 'track' } }).text).toBe('Reported by a track, not sorted yet');
    expect(st({ priority: 'drop' }).text).toBe('Dropped');
  });

  it('names the next step when one is due', () => {
    expect(st({ priority: 'owner', ownerQuestions: [{ id: 'Q-SSO', resolved: false }] }).next).toBe('Answer Q-SSO');
    expect(st({ priority: 'now', maturity: 'ready' }).next).toBe('Turn into queue tasks');
    expect(st({ priority: 'now', maturity: 'idea' }).next).toBe('Shape it with Claude');
    expect(
      st({
        priority: 'now',
        maturity: 'partial',
        finished: 1,
        total: 3,
        queue: [{ id: 'AUTH-3', column: 'inProgress' }],
      }).next,
    ).toBe('AUTH-3 is running');
    expect(st({ maturity: 'built' }).next).toBe('Verify against the code');
    expect(st({ maturity: 'verified' }).next).toBe(null);
    expect(st({ inbox: { by: 'track' } }).next).toBe('Sort it');
  });

  it('in the queue but nothing done yet', () => {
    expect(st({ priority: 'now', maturity: 'in-queue', total: 2 }).text).toBe('In the queue: 2 tasks, none done yet');
    expect(st({ priority: 'now', active: { at: 'x', by: 's' }, maturity: 'ready' }).text).toBe(
      'Being worked on in Claude Code now',
    );
  });
});

describe('planNotes: warnings as words', () => {
  it('deadline, stale and legal points as words', () => {
    expect(V.planNotes(entry('PL-A', { deadline: '2026-12-01' }), NOW)).toEqual(['deadline in 12 days']);
    expect(V.planNotes(entry('PL-A', { deadline: '2026-11-19' }), NOW)).toEqual(['deadline today']);
    expect(V.planNotes(entry('PL-A', { deadline: '2026-11-10' }), NOW)).toEqual(['deadline passed 9 days ago']);
    expect(V.planNotes(entry('PL-A', { legal_open: 2 }), NOW)).toEqual(['2 open legal points']);
    expect(V.planNotes(entry('PL-A', { legal_open: 1, stale: true, maturity: 'ready' }), NOW)).toEqual([
      'the check is stale',
      '1 open legal point',
    ]);
  });
});

describe('planSentence: the one plain sentence under the title', () => {
  it('the summary first, clipped near 200 characters at a word boundary', () => {
    const long = `${'word '.repeat(60)}end`;
    const s = V.planSentence(entry('PL-A', { summary: long }));
    expect(s.from).toBe('summary');
    expect(s.text.length).toBeLessThanOrEqual(201);
    expect(s.text.endsWith('…')).toBe(true);
    expect(s.text).not.toMatch(/wor…$/);
  });

  it('else the lead from the plan document, marked as such', () => {
    const s = V.planSentence(entry('PL-A', { lead: { text: 'Users keep streaks.', path: 'docs/a.md' } }));
    expect(s).toEqual({ text: 'Users keep streaks.', from: 'document' });
  });

  it('else nothing, so the view can say "No summary yet"', () => {
    expect(V.planSentence(entry('PL-A'))).toEqual({ text: null, from: null });
  });
});

describe('documentLead: the task panel rule on a plan document', () => {
  const DOC = [
    '# Accounts',
    '',
    'Plan entry PL-AUTH. The roadmap tells the story.',
    '',
    '## 1. Scope and rules',
    '',
    'Pebble gets accounts so a user keeps their streaks when they change phones.',
    '',
    '## 2. Design',
    '',
    '```',
    'code here',
    '```',
    '',
    '| a | b |',
    '|---|---|',
    '| 1 | 2 |',
    '',
    'Passwords are hashed with **argon2id**.',
    '',
    '## Why',
    '',
    'Because people change phones.',
  ].join('\n');

  it('a heading that names the purpose wins', () => {
    expect(V.documentLead(DOC)).toBe('Because people change phones.');
  });

  it('starts at the anchor and stays inside its section', () => {
    expect(V.documentLead(DOC, '§ 1')).toBe(
      'Pebble gets accounts so a user keeps their streaks when they change phones.',
    );
    // code and tables are skipped, the inline markup becomes plain text
    expect(V.documentLead(DOC, '§ 2')).toBe('Passwords are hashed with argon2id.');
  });

  it('a bold label that names the purpose, and KEY: value lines are skipped', () => {
    expect(V.documentLead('TITLE: x\n\n**Goal:** Make sync calm.\n\nOther text.')).toBe('Make sync calm.');
    expect(V.documentLead('BRANCH: x\n\nFirst plain words.')).toBe('First plain words.');
  });

  it('a last sentence that only leads into a list ("... these rules:") is left out when one comes before it', () => {
    expect(V.documentLead('Users keep their streaks. Every task follows these rules:\n\n- one\n- two')).toBe(
      'Users keep their streaks.',
    );
    // a single sentence ending in a colon is all there is, so it stays
    expect(V.documentLead('The rules:\n\n- one')).toBe('The rules:');
  });

  it('clips near 320 characters at a word boundary; no text gives null', () => {
    const lead = V.documentLead(`${'many words '.repeat(60)}`);
    expect(lead.length).toBeLessThanOrEqual(321);
    expect(lead.endsWith('…')).toBe(true);
    expect(V.documentLead('')).toBe(null);
    expect(V.documentLead('# Only a heading')).toBe(null);
  });

  it('an anchor that is not found falls back to the whole document', () => {
    expect(V.documentLead(DOC, '§ 9')).toBe('Because people change phones.');
  });
});

describe('planSource: the document the plan page reads first', () => {
  it('role plan first, then a source without a role, then the first readable one', () => {
    const p = entry('PL-A', {
      sources: [
        { path: 'docs/spec.md', anchor: null, role: 'spec' },
        { path: 'docs/plan.md', anchor: '§ 1', role: 'plan' },
      ],
    });
    expect(V.planSource(p).path).toBe('docs/plan.md');
    expect(V.planSource(entry('PL-B', { sources: [{ path: 'docs/x.md', role: null }] })).path).toBe('docs/x.md');
    expect(V.planSource(entry('PL-C', { sources: [{ path: 'docs/x.md', role: 'spec' }] })).path).toBe('docs/x.md');
    expect(V.planSource(entry('PL-D', { sources: [{ path: '../secret.md', role: 'plan' }] }))).toBe(null);
    expect(V.planSource(entry('PL-E'))).toBe(null);
  });
});

describe('roadmapSections: the horizons with counts, and the area grouping', () => {
  const list = [
    entry('PL-1', { priority: 'now', maturity: 'ready' }),
    entry('PL-2', { priority: 'owner' }),
    entry('PL-3', { priority: 'later', module: 'data' }),
    entry('PL-4', { maturity: 'built' }),
    entry('PL-5', { priority: 'now', maturity: 'partial', finished: 1, total: 2 }),
  ];
  const modules = [
    { oid: 'account', title: 'Account' },
    { oid: 'data', title: 'Data and sync' },
  ];

  it('by horizon: every non-empty horizon in order, with its count', () => {
    const s = V.roadmapSections(list, { group: 'horizon', modules });
    expect(s.map((x: { id: string; count: number }) => [x.id, x.count])).toEqual([
      ['waiting', 1],
      ['now', 1],
      ['next', 1],
      ['later', 1],
      ['done', 1],
    ]);
    expect(s[0].title).toBe('Waiting on you');
  });

  it('by horizon with empty ones kept (the columns stay in place)', () => {
    const s = V.roadmapSections([entry('PL-1', { priority: 'now', maturity: 'ready' })], {
      group: 'horizon',
      keepEmpty: true,
    });
    expect(s.map((x: { id: string }) => x.id)).toEqual(['waiting', 'now', 'next', 'later', 'done']);
  });

  it('by area: one section per area, plans in roadmap order, built share in words', () => {
    const s = V.roadmapSections(list, { group: 'area', modules });
    expect(s.map((x: { id: string }) => x.id)).toEqual(['account', 'data']);
    expect(s[0].entries.map((p: Post) => p.id)).toEqual(['PL-2', 'PL-5', 'PL-1', 'PL-4']);
    expect(s[0].note).toBe('1 of 4 built');
  });
});

describe('sectionShown: how many rows a section shows (300+ plans)', () => {
  it('folds long sections past N, Done folded, nothing folded while searching', () => {
    expect(V.sectionShown('later', 30, { foldAfter: 8 })).toBe(8);
    expect(V.sectionShown('later', 30, { foldAfter: 8, expanded: true })).toBe(30);
    expect(V.sectionShown('done', 30, { foldAfter: 8 })).toBe(0);
    // Dropped plans are folded like Done: kept for the record, out of the way.
    expect(V.sectionShown('dropped', 4, { foldAfter: 8 })).toBe(0);
    expect(V.sectionShown('done', 30, { foldAfter: 8, expanded: true })).toBe(30);
    expect(V.sectionShown('waiting', 30, { foldAfter: 8 })).toBe(30);
    expect(V.sectionShown('inbox', 30, { foldAfter: 8 })).toBe(30);
    expect(V.sectionShown('later', 30, { foldAfter: 8, active: true })).toBe(30);
    expect(V.sectionShown('done', 3, { foldAfter: 8, active: true })).toBe(3);
    expect(V.sectionShown('later', 30, { foldAfter: 0 })).toBe(30);
  });
});

describe('roadmapLayout: the default follows the width, the remembered choice wins', () => {
  it('auto: columns from 1200 px, a list below', () => {
    expect(V.roadmapLayout({ width: 1440 })).toBe('columns');
    expect(V.roadmapLayout({ width: 1000 })).toBe('list');
    expect(V.roadmapLayout({ width: 1440, setting: 'list' })).toBe('list');
    expect(V.roadmapLayout({ width: 1000, setting: 'columns' })).toBe('columns');
    expect(V.roadmapLayout({ width: 1000, choice: 'columns' })).toBe('columns');
    expect(V.roadmapLayout({ width: 1440, choice: 'list', setting: 'columns' })).toBe('list');
  });

  it('always a list on a phone, and an unknown value falls back to auto', () => {
    expect(V.roadmapLayout({ width: 390, choice: 'columns' })).toBe('list');
    expect(V.roadmapLayout({ width: 1440, choice: 'tiles', setting: 'nope' })).toBe('columns');
  });
});

describe('the plan page lines', () => {
  it('the Details row says the key facts in one line', () => {
    expect(
      V.detailsLine(entry('PL-AUTH', { priority: 'now', maturity: 'ready', size: 'M' })),
    ).toBe('Now · Ready · M · PL-AUTH');
    expect(V.detailsLine(entry('PL-X', { priority: 'later', maturity: 'idea', size: null }))).toBe(
      'Later · Idea · PL-X',
    );
  });

  it('the tasks in one sentence', () => {
    expect(V.tasksSentence(entry('PL-A'))).toBe('No tasks yet.');
    expect(
      V.tasksSentence(
        entry('PL-A', {
          queue: [
            { id: 'A-1', column: 'built' },
            { id: 'A-2', column: 'inProgress' },
            { id: 'A-3', column: 'queue' },
            { id: 'A-4', column: 'review' },
          ],
        }),
      ),
    ).toBe('4 tasks: 1 done, 2 running, 1 waiting.');
    expect(V.tasksSentence(entry('PL-A', { queue: [{ id: 'A-1', column: 'built' }] }))).toBe('1 task: 1 done.');
  });
});

describe('the url: the roadmap surface and the start view', () => {
  it('roadmap is a surface that survives the url, also with an open plan page', () => {
    const t = V.readUrl('?room=plans&surface=roadmap&entry=PL-AUTH');
    expect(t.surface).toBe('roadmap');
    expect(t.entry).toBe('PL-AUTH');
    expect(V.writeUrl(t)).toBe('?room=plans&entry=PL-AUTH&surface=roadmap');
  });

  it('the start view setting picks the page Plans opens on', () => {
    expect(V.startSearch('roadmap')).toBe('?room=plans&surface=roadmap');
    expect(V.startSearch('overview')).toBe('?room=plans&surface=overview');
    expect(V.startSearch('list')).toBe('?room=plans');
    expect(V.startSearch('nonsense')).toBe('?room=plans&surface=roadmap');
  });

  it('Overview is no longer a tab: it sits under More views with the maps', () => {
    expect(V.SURFACES.filter((f: { more?: boolean }) => !f.more).map((f: { id: string }) => f.id)).toEqual([
      'roadmap',
      'entries',
      'doc',
      'jur',
      'decision',
      'launch',
    ]);
    expect(V.MORE_VIEWS.map((x: { id: string }) => x.id)).toEqual(['overview', 'map', 'treeMap', 'dep']);
  });

  it('the search also finds words in the lead from the document', () => {
    expect(V.searchMatch(entry('PL-A', { lead: { text: 'Streaks survive a new phone' } }), 'new phone')).toBe(true);
  });
});

describe('the settings: plans.* in queue.config.json (queueConfig.plansView)', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const KK = require('../queueConfig.js');

  it('the defaults: roadmap first, layout by width, fold after 8, the lead on', () => {
    expect(KK.STANDARD.plans).toEqual({
      startView: 'roadmap',
      roadmapLayout: 'auto',
      roadmapFoldAfter: 8,
      leadFromDocument: true,
      searchDocuments: true,
      // P7: proposals only on request, and never applied without the owner
      inboxTriage: 'on-request',
      inboxAutoApply: false,
      // PG-1/PG-3: the decision section expected for large plans, an advisory check at ready
      decisionNote: true,
      readyCheck: 'advisory',
    });
    expect(KK.plansView({})).toEqual(KK.STANDARD.plans);
  });

  it('a valid value is kept, an unknown one falls back to the default', () => {
    expect(
      KK.plansView({ plans: { startView: 'overview', roadmapLayout: 'list', roadmapFoldAfter: 0, leadFromDocument: false } }),
    ).toEqual({
      startView: 'overview',
      roadmapLayout: 'list',
      roadmapFoldAfter: 0,
      leadFromDocument: false,
      searchDocuments: true,
      inboxTriage: 'on-request',
      inboxAutoApply: false,
      decisionNote: true,
      readyCheck: 'advisory',
    });
    expect(
      KK.plansView({ plans: { startView: 'x', roadmapLayout: 'tiles', roadmapFoldAfter: -3, leadFromDocument: 'yes' } }),
    ).toEqual(KK.STANDARD.plans);
    expect(KK.plansView({ plans: { roadmapFoldAfter: 5000 } }).roadmapFoldAfter).toBe(500);
  });
});

describe('plansData: the lead and the inbox marker', () => {
  const reg = {
    ...P.emptyRegister(),
    entries: [
      {
        id: 'PL-DOC',
        title: 'From the document',
        project: 'general',
        priority: 'now',
        now_category: ['important'],
        priority_reason: 'x',
        priority_set_by: 'owner',
        maturity: 'ready',
        sources: [{ path: 'docs/plan.md', role: 'plan' }],
      },
      {
        id: 'PL-OWN',
        title: 'Has a summary',
        summary: 'Written by a person.',
        project: 'general',
        priority: 'later',
        priority_set_by: 'owner',
        maturity: 'idea',
        sources: [{ path: 'docs/plan.md', role: 'plan' }],
      },
      {
        id: 'PL-FINDING-1',
        title: 'A finding',
        project: 'general',
        priority: 'later',
        priority_set_by: 'agent',
        priority_reason: 'Finding reported by T-1 outside its scope; not triaged yet.',
        maturity: 'idea',
        finding: { tasks: ['T-1'], files: [], reported: '2026-11-18T10:00:00Z' },
      },
    ],
  };
  const calls: string[] = [];
  const d = V.plansData(reg, { tasks: [] }, {
    now: NOW,
    leadFor: (p: Post) => {
      calls.push(String(p.id));
      return { text: 'Lead words.', path: 'docs/plan.md', anchor: null };
    },
  });
  const byId = (id: string) => d.entries.find((p: Post) => p.id === id);

  it('the lead only where the summary is missing', () => {
    expect(byId('PL-DOC').lead).toEqual({ text: 'Lead words.', path: 'docs/plan.md', anchor: null });
    expect(byId('PL-OWN').lead).toBe(null);
    expect(calls).not.toContain('PL-OWN');
  });

  it('a finding nobody has sorted is in the inbox, reported by a track', () => {
    expect(byId('PL-FINDING-1').inbox).toEqual({ by: 'track', at: '2026-11-18T10:00:00Z' });
    expect(V.horizonFor(byId('PL-FINDING-1'))).toBe('inbox');
    expect(byId('PL-DOC').inbox).toBe(null);
  });

  it('without leadFor nothing is read and the lead is null', () => {
    const plain = V.plansData(reg, { tasks: [] }, { now: NOW });
    expect(plain.entries.every((p: Post) => p.lead === null)).toBe(true);
  });
});

describe('the breadcrumb on the Roadmap', () => {
  const d = { entries: [entry('PL-AUTH', { title: 'Accounts' })] };
  it('Plans › Roadmap, and on the plan page › the title with Roadmap as the way back', () => {
    const bare = V.breadcrumbs({ surface: 'roadmap', entry: null, filter: V.emptyFilter() }, d);
    expect(bare.map((b: Post) => b.text)).toEqual(['Plans', 'Roadmap']);
    const onPage = V.breadcrumbs({ surface: 'roadmap', entry: 'PL-AUTH', filter: V.emptyFilter() }, d);
    expect(onPage.map((b: Post) => b.text)).toEqual(['Plans', 'Roadmap', 'Accounts']);
    expect(onPage[1].state).toEqual({ entry: null });
  });

  it('the Roadmap tab counts the plans that are not dropped', () => {
    const n = V.surfaceCount({ entries: [entry('PL-A'), entry('PL-B', { priority: 'drop' })] });
    expect(n.roadmap).toBe(1);
  });
});
