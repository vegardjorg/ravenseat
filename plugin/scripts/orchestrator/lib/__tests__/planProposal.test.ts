// =============================================================
// planProposal.test.ts: enrichment and confirmation of the Inbox (P7 of plans/plans-tab-ux-review-2026-11-19.md).
//
// What the tests prove:
//   - a proposal is Claude's suggestion stored in the tool-owned `proposal` field: it changes nothing else on the plan,
//     it is only written for an Inbox item (a captured plan or a new finding), a proposal that could not be accepted is
//     refused at once, and nobody sets the field with plan new or plan edit,
//   - nothing applies by itself: plans.inboxAutoApply is off by default; when on, only a captured plan whose proposal
//     keeps the priority later (and names no merge) is applied, the rest waits for the owner,
//   - plans.inboxTriage off refuses new proposals,
//   - Accept (owner only) applies the proposal in one change, with the owner's edits on top, clears the inbox marker
//     and the proposal, and keeps the original text when the summary is rewritten; a finding leaves the Inbox too,
//   - Decline (owner only) drops the plan with a reason; Merge (owner only) moves it into another plan's archive,
//   - a later sort by hand (a new priority or maturity) takes the stale proposal away,
//   - the board's words for a proposal (queuePlanView.proposalText) and what /api/plans sends,
//   - the INBOX line counts the proposals that wait on the owner and asks for sorting when triage is idle,
//   - the CLI: plan propose, accept, decline and merge on a copy in a temporary folder, with plan undo for each.
// =============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const R = require('../planProposal.js') as any;
const I = require('../planInbox.js') as any;
const P = require('../queuePlan.js') as any;
const V = require('../queuePlanView.js') as any;
const K = require('../queueConfig.js') as any;
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

const QUEUE_MJS = join(__dirname, '..', '..', 'queue.mjs');
const NOW = '2026-11-20T08:00:00.000Z';
const PROJECTS = { general: { title: 'General' }, app: { title: 'App', area: 'alpha' } };
const ctx = (o: Record<string, unknown> = {}) => ({ projects: PROJECTS, question: {}, now: NOW, tasks: [], ...o });

/** A register with one captured plan (PL-DARK-MODE-1) and one sorted plan (PL-THEME). */
function register() {
  const reg = P.emptyRegister(NOW);
  I.capturePlan(reg, { title: 'Dark mode', text: 'People read at night and the white page hurts.' }, { projects: PROJECTS, now: NOW });
  P.newEntry(reg, { id: 'PL-THEME', title: 'Themes', project: 'app', priority: 'later', maturity: 'planned' }, { role: 'owner', projects: PROJECTS, now: NOW });
  return reg;
}
const find = (reg: any, id: string) => reg.entries.find((p: any) => p.id === id);
const GOOD = {
  project: 'app',
  priority: 'now',
  now_category: ['important'],
  priority_reason: 'Rule 4: many readers ask for it.',
  maturity: 'investigated',
  size: 'M',
  summary: 'A dark theme for night reading.',
  merge: ['PL-THEME'],
  outline: 'Problem: the white page at night.\nSize: M.\nNot: a theme editor.',
};

describe('the defaults', () => {
  it('proposals on request, auto-apply off', () => {
    expect(K.STANDARD.plans.inboxTriage).toBe('on-request');
    expect(K.STANDARD.plans.inboxAutoApply).toBe(false);
    expect(K.plansView({ plans: {} })).toMatchObject({ inboxTriage: 'on-request', inboxAutoApply: false });
    expect(K.plansView({ plans: { inboxTriage: 'idle', inboxAutoApply: true } })).toMatchObject({ inboxTriage: 'idle', inboxAutoApply: true });
    // a hand-edited wrong value falls back to the safe default
    expect(K.plansView({ plans: { inboxTriage: 'always', inboxAutoApply: 'yes' } })).toMatchObject({ inboxTriage: 'on-request', inboxAutoApply: false });
  });
  it('both have a settings row; auto-apply on counts as weakening (it skips the owner)', () => {
    const S = require('../settingsRegistry.js');
    const triage = S.SETTINGS.find((r: any) => r.key === 'plans.inboxTriage');
    const auto = S.SETTINGS.find((r: any) => r.key === 'plans.inboxAutoApply');
    expect(triage.choices).toEqual(['on-request', 'idle', 'off']);
    expect(auto.type).toBe('onoff');
    expect(auto.weakens(true, false)).toBe(true);
    expect(auto.weakens(false, false)).toBe(false);
  });
});

describe('a proposal is a suggestion, not a change', () => {
  it('stores the suggestion with who and when, and changes no other field', () => {
    const reg = register();
    const before = JSON.parse(JSON.stringify(find(reg, 'PL-DARK-MODE-1')));
    const r = R.writeProposal(reg, 'PL-DARK-MODE-1', GOOD, ctx({ by: 'track-7' }));
    expect(r.error).toEqual([]);
    expect(r.applied).toBe(false);
    const e = find(reg, 'PL-DARK-MODE-1');
    const { proposal, ...rest } = e;
    expect(rest).toEqual(before);
    expect(proposal).toEqual({
      at: NOW,
      by: 'track-7',
      fields: {
        project: 'app',
        priority: 'now',
        now_category: ['important'],
        priority_reason: 'Rule 4: many readers ask for it.',
        maturity: 'investigated',
        size: 'M',
        summary: 'A dark theme for night reading.',
      },
      merge: ['PL-THEME'],
      outline: 'Problem: the white page at night.\nSize: M.\nNot: a theme editor.',
    });
  });
  it('a new proposal replaces the old one', () => {
    const reg = register();
    R.writeProposal(reg, 'PL-DARK-MODE-1', GOOD, ctx());
    R.writeProposal(reg, 'PL-DARK-MODE-1', { maturity: 'planned' }, ctx());
    expect(find(reg, 'PL-DARK-MODE-1').proposal.fields).toEqual({ maturity: 'planned' });
  });
  it('only for an Inbox item: a sorted plan, a dropped one, one with a task and an unknown id are refused', () => {
    const reg = register();
    expect(R.writeProposal(reg, 'PL-THEME', GOOD, ctx()).error[0]).toMatch(/not in the inbox/);
    expect(R.writeProposal(reg, 'PL-NOPE', GOOD, ctx()).error[0]).toMatch(/unknown/);
    expect(R.writeProposal(reg, 'PL-DARK-MODE-1', GOOD, ctx({ tasks: [{ id: 'T-1', plan: 'PL-DARK-MODE-1' }] })).error[0]).toMatch(/not in the inbox/);
    expect(find(reg, 'PL-THEME').proposal).toBeUndefined();
  });
  it('a new finding is an Inbox item too', () => {
    const reg = register();
    P.newEntry(reg, { id: 'PL-LEAK', title: 'Log has a token', project: 'app', priority: 'later', maturity: 'idea', priority_reason: 'Reported by a track.' }, { role: 'agent', projects: PROJECTS, now: NOW });
    find(reg, 'PL-LEAK').finding = { tasks: ['T-1'], files: [], reported: NOW, last: NOW, count: 1 };
    expect(R.writeProposal(reg, 'PL-LEAK', { maturity: 'investigated' }, ctx()).error).toEqual([]);
  });
  it('the input is checked: unknown fields, the title, drop, a priority without reason, long text, bad merge ids', () => {
    const reg = register();
    const err = (x: unknown) => R.writeProposal(reg, 'PL-DARK-MODE-1', x, ctx()).error.join(' | ');
    expect(err({ title: 'Other' })).toMatch(/title/);
    expect(err({ colour: 'red' })).toMatch(/colour/);
    expect(err({ priority: 'drop', priority_reason: 'x' })).toMatch(/drop/);
    expect(err({ priority: 'now', now_category: ['important'] })).toMatch(/reason/);
    expect(err({ summary: 'x'.repeat(V.PROPOSAL.SUMMARY_MAX + 1) })).toMatch(/summary/);
    expect(err({ outline: 'x'.repeat(V.PROPOSAL.OUTLINE_MAX + 1) })).toMatch(/outline/);
    expect(err({ merge: ['PL-DARK-MODE-1'] })).toMatch(/itself/);
    expect(err({ merge: ['PL-GONE'] })).toMatch(/PL-GONE/);
    expect(err({})).toMatch(/nothing/);
    expect(err(null)).toMatch(/object/);
    // a proposal that could not be accepted (an unknown project) is refused now, not at Accept
    expect(err({ project: 'nope' })).toMatch(/unknown project nope/);
    expect(find(reg, 'PL-DARK-MODE-1').proposal).toBeUndefined();
  });
  it('nobody sets or edits the field by hand', () => {
    const reg = register();
    expect(P.editEntry(reg, 'PL-DARK-MODE-1', { proposal: { at: NOW, by: 'x', fields: {} } }, { role: 'owner', projects: PROJECTS }).error[0]).toMatch(/set by the tool/);
    expect(P.newEntry(reg, { id: 'PL-X', title: 'X', project: 'app', priority: 'later', proposal: {} }, { role: 'owner', projects: PROJECTS }).error.join(' ')).toMatch(/proposal is set by the tool/);
    expect(P.editEntry(reg, 'PL-DARK-MODE-1', { original_text: 'x' }, { role: 'owner', projects: PROJECTS }).error[0]).toMatch(/set by the tool/);
  });
  it('plans.inboxTriage off refuses new proposals', () => {
    const reg = register();
    expect(R.writeProposal(reg, 'PL-DARK-MODE-1', GOOD, ctx({ triage: 'off' })).error[0]).toMatch(/plans.inboxTriage/);
  });
});

describe('auto-apply (off by default)', () => {
  it('off: even a later proposal waits for the owner', () => {
    const reg = register();
    const r = R.writeProposal(reg, 'PL-DARK-MODE-1', { project: 'app', maturity: 'investigated' }, ctx());
    expect(r.applied).toBe(false);
    expect(find(reg, 'PL-DARK-MODE-1').inbox).toBeTruthy();
    expect(find(reg, 'PL-DARK-MODE-1').project).toBe('general');
  });
  it('on: a captured plan whose proposal keeps later is applied and leaves the Inbox; the priority is not touched', () => {
    const reg = register();
    const r = R.writeProposal(reg, 'PL-DARK-MODE-1', { project: 'app', priority: 'later', priority_reason: 'Nothing urgent about it.', maturity: 'investigated' }, ctx({ autoApply: true }));
    expect(r.error).toEqual([]);
    expect(r.applied).toBe(true);
    const e = find(reg, 'PL-DARK-MODE-1');
    expect(e).toMatchObject({ project: 'app', maturity: 'investigated', priority: 'later', priority_set_by: 'owner' });
    expect(e.priority_reason).toBeUndefined();
    expect(e.inbox).toBeUndefined();
    expect(e.proposal).toBeUndefined();
  });
  it('on: a new priority, a merge candidate or a finding still waits for the owner', () => {
    const reg = register();
    expect(R.writeProposal(reg, 'PL-DARK-MODE-1', GOOD, ctx({ autoApply: true })).applied).toBe(false);
    expect(R.writeProposal(reg, 'PL-DARK-MODE-1', { maturity: 'investigated', merge: ['PL-THEME'] }, ctx({ autoApply: true })).applied).toBe(false);
    P.newEntry(reg, { id: 'PL-LEAK', title: 'Log has a token', project: 'app', priority: 'later', maturity: 'idea', priority_reason: 'Reported.' }, { role: 'agent', projects: PROJECTS, now: NOW });
    find(reg, 'PL-LEAK').finding = { tasks: ['T-1'], files: [], reported: NOW, last: NOW, count: 1 };
    expect(R.writeProposal(reg, 'PL-LEAK', { maturity: 'investigated' }, ctx({ autoApply: true })).applied).toBe(false);
    expect(find(reg, 'PL-DARK-MODE-1').inbox).toBeTruthy();
  });
});

describe('Accept, Decline and Merge (the owner only)', () => {
  it('an agent cannot accept, decline or merge', () => {
    const reg = register();
    R.writeProposal(reg, 'PL-DARK-MODE-1', GOOD, ctx());
    for (const r of [
      R.acceptProposal(reg, 'PL-DARK-MODE-1', {}, ctx({ role: 'agent' })),
      R.declineProposal(reg, 'PL-DARK-MODE-1', { reason: 'no' }, ctx({ role: 'agent' })),
      R.mergeProposal(reg, 'PL-DARK-MODE-1', 'PL-THEME', ctx({ role: 'agent' })),
    ])
      expect(r.error[0]).toMatch(/owner/);
    expect(find(reg, 'PL-DARK-MODE-1').proposal).toBeTruthy();
  });
  it('Accept applies the proposal, clears the inbox marker and the proposal, and keeps the original text', () => {
    const reg = register();
    R.writeProposal(reg, 'PL-DARK-MODE-1', GOOD, ctx());
    const r = R.acceptProposal(reg, 'PL-DARK-MODE-1', {}, ctx({ role: 'owner' }));
    expect(r.error).toEqual([]);
    const e = find(reg, 'PL-DARK-MODE-1');
    expect(e).toMatchObject({
      project: 'app',
      priority: 'now',
      now_category: ['important'],
      priority_reason: 'Rule 4: many readers ask for it.',
      priority_set_by: 'owner',
      maturity: 'investigated',
      size: 'M',
      summary: 'A dark theme for night reading.',
      original_text: 'People read at night and the white page hurts.',
    });
    expect(e.inbox).toBeUndefined();
    expect(e.proposal).toBeUndefined();
    expect(I.isInInbox(e)).toBe(false);
  });
  it('Edit then accept: the owner\'s edits win, and null keeps the field as it is', () => {
    const reg = register();
    R.writeProposal(reg, 'PL-DARK-MODE-1', GOOD, ctx());
    const r = R.acceptProposal(reg, 'PL-DARK-MODE-1', { priority: 'later', now_category: null, priority_reason: null, size: null, summary: null }, ctx({ role: 'owner' }));
    expect(r.error).toEqual([]);
    const e = find(reg, 'PL-DARK-MODE-1');
    expect(e).toMatchObject({ project: 'app', priority: 'later', maturity: 'investigated', summary: 'People read at night and the white page hurts.' });
    expect(e.size).toBeUndefined();
    expect(e.original_text).toBeUndefined();
    expect(e.inbox).toBeUndefined();
  });
  it('Edit without a proposal sorts the item by hand; edits outside the proposal fields are refused', () => {
    const reg = register();
    expect(R.acceptProposal(reg, 'PL-DARK-MODE-1', { maturity: 'planned' }, ctx({ role: 'owner' })).error).toEqual([]);
    expect(find(reg, 'PL-DARK-MODE-1')).toMatchObject({ maturity: 'planned' });
    expect(find(reg, 'PL-DARK-MODE-1').inbox).toBeUndefined();
    const reg2 = register();
    expect(R.acceptProposal(reg2, 'PL-DARK-MODE-1', { title: 'x' }, ctx({ role: 'owner' })).error[0]).toMatch(/title/);
  });
  it('Accept on a finding takes it out of the Inbox even when the priority stays later', () => {
    const reg = register();
    P.newEntry(reg, { id: 'PL-LEAK', title: 'Log has a token', project: 'app', priority: 'later', maturity: 'idea', priority_reason: 'Reported.' }, { role: 'agent', projects: PROJECTS, now: NOW });
    find(reg, 'PL-LEAK').finding = { tasks: ['T-1'], files: [], reported: NOW, last: NOW, count: 1 };
    R.writeProposal(reg, 'PL-LEAK', { summary: 'A token in a log line.' }, ctx());
    expect(R.acceptProposal(reg, 'PL-LEAK', {}, ctx({ role: 'owner' })).error).toEqual([]);
    expect(R.inInbox(find(reg, 'PL-LEAK'), [])).toBe(false);
  });
  it('Decline drops the plan with the reason (or a plain default)', () => {
    const reg = register();
    R.writeProposal(reg, 'PL-DARK-MODE-1', GOOD, ctx());
    expect(R.declineProposal(reg, 'PL-DARK-MODE-1', { reason: 'Not for this product.' }, ctx({ role: 'owner' })).error).toEqual([]);
    const e = find(reg, 'PL-DARK-MODE-1');
    expect(e).toMatchObject({ priority: 'drop', drop_reason: 'Not for this product.', priority_set_by: 'owner' });
    expect(e.inbox).toBeUndefined();
    expect(e.proposal).toBeUndefined();
    const reg2 = register();
    R.declineProposal(reg2, 'PL-DARK-MODE-1', {}, ctx({ role: 'owner' }));
    expect(find(reg2, 'PL-DARK-MODE-1').drop_reason).toBe('Declined in the inbox.');
  });
  it('Merge moves the item into the other plan (the archive keeps its text), never into itself', () => {
    const reg = register();
    R.writeProposal(reg, 'PL-DARK-MODE-1', GOOD, ctx());
    expect(R.mergeProposal(reg, 'PL-DARK-MODE-1', 'PL-DARK-MODE-1', ctx({ role: 'owner' })).error[0]).toMatch(/itself/);
    expect(R.mergeProposal(reg, 'PL-DARK-MODE-1', 'PL-GONE', ctx({ role: 'owner' })).error[0]).toMatch(/PL-GONE/);
    expect(R.mergeProposal(reg, 'PL-DARK-MODE-1', 'PL-THEME', ctx({ role: 'owner' })).error).toEqual([]);
    expect(find(reg, 'PL-DARK-MODE-1')).toBeUndefined();
    expect(find(reg, 'PL-THEME').merged_from).toEqual(['PL-DARK-MODE-1']);
    const arch = reg.archive['PL-DARK-MODE-1'];
    expect(arch).toMatchObject({ merged_to: 'PL-THEME', summary: 'People read at night and the white page hurts.' });
    expect(arch.proposal).toBeUndefined();
    expect(arch.inbox).toBeUndefined();
  });
  it('items that left the Inbox cannot be accepted, declined or merged from it', () => {
    const reg = register();
    expect(R.acceptProposal(reg, 'PL-THEME', {}, ctx({ role: 'owner' })).error[0]).toMatch(/not in the inbox/);
    expect(R.declineProposal(reg, 'PL-THEME', {}, ctx({ role: 'owner' })).error[0]).toMatch(/not in the inbox/);
    expect(R.mergeProposal(reg, 'PL-THEME', 'PL-DARK-MODE-1', ctx({ role: 'owner' })).error[0]).toMatch(/not in the inbox/);
  });
  it('a sort by hand (a new maturity) takes the stale proposal away', () => {
    const reg = register();
    R.writeProposal(reg, 'PL-DARK-MODE-1', GOOD, ctx());
    expect(P.editEntry(reg, 'PL-DARK-MODE-1', { maturity: 'planned' }, { role: 'owner', projects: PROJECTS }).error).toEqual([]);
    expect(find(reg, 'PL-DARK-MODE-1').proposal).toBeUndefined();
  });
});

describe('the words on the board and what /api/plans sends', () => {
  it('proposalText: project title, priority with category, maturity, size, reason, summary, merge titles', () => {
    const reg = register();
    R.writeProposal(reg, 'PL-DARK-MODE-1', GOOD, ctx());
    const d = V.plansData(reg, { projects: PROJECTS, areas: { alpha: { title: 'Alpha' } }, tasks: [] }, { now: NOW });
    const p = d.entries.find((x: any) => x.id === 'PL-DARK-MODE-1');
    expect(p.proposal.fields.project).toBe('app');
    const t = V.proposalText(p, d);
    expect(t.text).toBe('Claude suggests: App · Now (important) · Investigated · size M');
    expect(t.because).toBe('Rule 4: many readers ask for it.');
    expect(t.summary).toBe('A dark theme for night reading.');
    expect(t.merge).toEqual([{ id: 'PL-THEME', title: 'Themes' }]);
    expect(t.outline).toMatch(/^Problem/);
    expect(V.proposalText({ id: 'x' }, d)).toBe(null);
  });
  it('/api/plans sends the proposal only while the item is in the Inbox, and the kept original text', () => {
    const reg = register();
    R.writeProposal(reg, 'PL-DARK-MODE-1', GOOD, ctx());
    const q = { projects: PROJECTS, areas: {}, tasks: [{ id: 'T-1', plan: 'PL-DARK-MODE-1', status: 'waiting' }] };
    expect(V.plansData(reg, q, { now: NOW }).entries.find((x: any) => x.id === 'PL-DARK-MODE-1').proposal).toBe(null);
    R.acceptProposal(reg, 'PL-DARK-MODE-1', {}, ctx({ role: 'owner' }));
    const p = V.plansData(reg, { projects: PROJECTS, areas: {}, tasks: [] }, { now: NOW }).entries.find((x: any) => x.id === 'PL-DARK-MODE-1');
    expect(p.original_text).toBe('People read at night and the white page hurts.');
  });
});

describe('the INBOX line', () => {
  it('counts the proposals that wait on the owner; idle asks for sorting when a slot is free', () => {
    const reg = register();
    I.capturePlan(reg, { title: 'Offline maps' }, { projects: PROJECTS, now: NOW });
    R.writeProposal(reg, 'PL-DARK-MODE-1', GOOD, ctx());
    const s = I.inboxSummary(reg, []);
    expect(s.proposals).toBe(1);
    expect(I.inboxLine(s)).toMatch(/2 captured plans not sorted yet .*1 with a proposal waiting on the owner \(Accept on the board\)/);
    expect(I.inboxLine(s, 'ravenseat', { triage: 'idle' })).toMatch(/sort them when a slot is free/);
    expect(I.inboxLine(s, 'ravenseat', { triage: 'on-request' })).not.toMatch(/slot/);
    const rows = I.inboxRows(reg, []);
    expect(rows.find((x: any) => x.id === 'PL-DARK-MODE-1').proposal).toBe(true);
  });
});

describe('queue.mjs plan propose, accept, decline and merge (copy in a temporary folder)', () => {
  let folder: string;
  let config: string;
  const run = (args: string[]) => {
    try {
      const out = execFileSync(process.execPath, [QUEUE_MJS, ...args], {
        env: {
          ...process.env,
          QUEUE_FOLDER: folder,
          QUEUE_GIT: folder,
          QUEUE_TIME_LOG: join(folder, 'times.jsonl'),
          QUEUE_PLAN_SOURCE_ROOT: folder,
          QUEUE_CONFIG: config,
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { code: 0, out, data: (() => { try { return JSON.parse(out.trim().split('\n').pop() ?? 'null'); } catch { return null; } })() };
    } catch (e) {
      const x = e as { status: number; stdout: string; stderr: string };
      let data = null;
      try {
        data = JSON.parse(String(x.stdout ?? '').trim().split('\n').pop() ?? 'null');
      } catch {
        data = null;
      }
      return { code: x.status, out: String(x.stdout ?? '') + String(x.stderr ?? ''), data };
    }
  };
  const readReg = () => JSON.parse(readFileSync(join(folder, 'plans.json'), 'utf8'));
  const entry = (id: string) => readReg().entries.find((p: any) => p.id === id);
  const file = (name: string, body: unknown) => {
    const f = join(folder, name);
    writeFileSync(f, JSON.stringify(body));
    return f;
  };

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'queue-proposal-'));
    config = join(folder, 'queue.config.json');
    writeFileSync(config, JSON.stringify({}));
    writeFileSync(
      join(folder, 'queue.json'),
      JSON.stringify({
        changed: '2026-11-19T08:00:00.000Z',
        tasks: [],
        projects: { general: { title: 'General' }, app: { title: 'App', area: 'alpha' } },
        areas: { alpha: { title: 'Alpha' } },
        question: {},
        resolved: [],
      }),
    );
    writeFileSync(join(folder, 'plans.json'), JSON.stringify(P.emptyRegister('2026-11-19T09:00:00.000Z')));
    run(['plan', 'capture', 'Dark mode', '--text', 'People read at night.', '--json']);
    run(['plan', 'new', '--file', file('t.json', { id: 'PL-THEME', title: 'Themes', project: 'app', priority: 'later', maturity: 'planned' }), '--set-by', 'owner', '--json']);
  });
  afterEach(() => rmSync(folder, { recursive: true, force: true }));

  it('plan propose writes the proposal only (one undo), and plan inbox shows it', () => {
    const r = run(['plan', 'propose', 'PL-DARK-MODE-1', '--file', file('p.json', GOOD), '--json']);
    expect(r.code).toBe(0);
    expect(r.data).toMatchObject({ ok: true, applied: false });
    expect(entry('PL-DARK-MODE-1')).toMatchObject({ project: 'general', priority: 'later', inbox: { by: 'owner' } });
    expect(entry('PL-DARK-MODE-1').proposal.fields.project).toBe('app');
    expect(run(['plan', 'inbox']).out).toMatch(/Claude suggests: App · Now/);
    expect(run(['plan', 'undo', '--nr', String(r.data.log), '--json']).code).toBe(0);
    expect(entry('PL-DARK-MODE-1').proposal).toBeUndefined();
  });
  it('accept, decline and merge need --set-by owner; with it each is one change that plan undo takes back', () => {
    run(['plan', 'propose', 'PL-DARK-MODE-1', '--file', file('p.json', GOOD), '--json']);
    const no = run(['plan', 'accept', 'PL-DARK-MODE-1', '--json']);
    expect(no.code).not.toBe(0);
    expect(JSON.stringify(no.data)).toMatch(/owner/);
    expect(entry('PL-DARK-MODE-1').inbox).toBeTruthy();

    const a = run(['plan', 'accept', 'PL-DARK-MODE-1', '--file', file('e.json', { size: 'L' }), '--set-by', 'owner', '--json']);
    expect(a.code).toBe(0);
    expect(entry('PL-DARK-MODE-1')).toMatchObject({ project: 'app', priority: 'now', size: 'L', original_text: 'People read at night.' });
    expect(entry('PL-DARK-MODE-1').inbox).toBeUndefined();
    run(['plan', 'undo', '--nr', String(a.data.log), '--json']);
    expect(entry('PL-DARK-MODE-1')).toMatchObject({ project: 'general', inbox: { by: 'owner' } });
    expect(entry('PL-DARK-MODE-1').proposal).toBeTruthy();

    const d = run(['plan', 'decline', 'PL-DARK-MODE-1', '--reason', 'Not now.', '--set-by', 'owner', '--json']);
    expect(d.code).toBe(0);
    expect(entry('PL-DARK-MODE-1')).toMatchObject({ priority: 'drop', drop_reason: 'Not now.' });
    run(['plan', 'undo', '--nr', String(d.data.log), '--json']);

    const m = run(['plan', 'merge', 'PL-DARK-MODE-1', '--into', 'PL-THEME', '--set-by', 'owner', '--json']);
    expect(m.code).toBe(0);
    expect(entry('PL-DARK-MODE-1')).toBeUndefined();
    expect(readReg().archive['PL-DARK-MODE-1'].merged_to).toBe('PL-THEME');
    run(['plan', 'undo', '--nr', String(m.data.log), '--json']);
    expect(entry('PL-DARK-MODE-1').inbox).toBeTruthy();
  });
  it('--expect-changed: a register that changed since gives exit 6 (the board turns it into 409)', () => {
    const r = run(['plan', 'accept', 'PL-DARK-MODE-1', '--set-by', 'owner', '--expect-changed', '2020-01-01T00:00:00.000Z', '--json']);
    expect(r.code).toBe(6);
    expect(r.data.outdated).toBe(true);
  });
  it('plans.inboxAutoApply on applies a later proposal for a captured plan at once', () => {
    writeFileSync(config, JSON.stringify({ plans: { inboxAutoApply: true } }));
    const r = run(['plan', 'propose', 'PL-DARK-MODE-1', '--file', file('p.json', { project: 'app', maturity: 'investigated' }), '--json']);
    expect(r.data).toMatchObject({ ok: true, applied: true });
    expect(entry('PL-DARK-MODE-1')).toMatchObject({ project: 'app', maturity: 'investigated' });
    expect(entry('PL-DARK-MODE-1').inbox).toBeUndefined();
  });
  it('plans.inboxTriage off refuses plan propose', () => {
    writeFileSync(config, JSON.stringify({ plans: { inboxTriage: 'off' } }));
    const r = run(['plan', 'propose', 'PL-DARK-MODE-1', '--file', file('p.json', GOOD), '--json']);
    expect(r.code).not.toBe(0);
    expect(entry('PL-DARK-MODE-1').proposal).toBeUndefined();
  });
});
