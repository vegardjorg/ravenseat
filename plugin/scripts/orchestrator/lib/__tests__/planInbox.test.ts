// =============================================================
// planInbox.test.ts: quick capture into the plan register's Inbox (P6 of plans/plans-tab-ux-review-2026-11-19.md).
//
// What the tests prove:
//   - the input: only a title is required (trimmed, at most 160 characters), the text is optional (at most TEXT_MAX),
//   - a capture is a normal plan entry: an id from the title (collision safe, archive ids never reused), the text as
//     summary, project general, priority later set by the owner, maturity idea, and the tool-owned `inbox` { at, by },
//   - the same title twice while it still waits in the Inbox writes nothing (a double click is not two plans),
//   - the entry is in the Inbox until it is sorted: a new priority or maturity removes the marker, `plan edit --field
//     inbox=null` removes it, a queue task that points to it takes it out, and nobody can set the marker by hand,
//   - the INBOX line for pulse and show, and the rows for `ravenseat plan inbox`,
//   - the CLI: `plan capture` on a copy in a temporary folder (creates the project general on first use, --json gives
//     the changelog number, `plan undo` takes it back), and `plan inbox`.
// =============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const I = require('../planInbox.js') as any;
const P = require('../queuePlan.js') as any;
const V = require('../queuePlanView.js') as any;
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

const QUEUE_MJS = join(__dirname, '..', '..', 'queue.mjs');
const NOW = '2026-11-20T08:00:00.000Z';
const PROJECTS = { general: { title: 'General' } };

describe('the input', () => {
  it('only a title is required; it is trimmed and at most 160 characters', () => {
    expect(I.captureInput({ title: '  Dark mode  ' })).toEqual({ title: 'Dark mode', text: null, error: [] });
    expect(I.captureInput({ title: '' }).error).toEqual(['a title is needed']);
    expect(I.captureInput({}).error).toEqual(['a title is needed']);
    expect(I.captureInput({ title: 'x'.repeat(161) }).error[0]).toMatch(/160/);
    expect(I.captureInput({ title: 'Dark mode', text: '  why  ' }).text).toBe('why');
    expect(I.captureInput({ title: 'Dark mode', text: '   ' }).text).toBe(null);
  });
  it('the text has a hard limit above the soft one the form shows; non-text is refused', () => {
    expect(I.TEXT_SOFT).toBe(2000);
    expect(I.TEXT_MAX).toBeGreaterThan(I.TEXT_SOFT);
    expect(I.captureInput({ title: 'A', text: 'x'.repeat(I.TEXT_MAX) }).error).toEqual([]);
    expect(I.captureInput({ title: 'A', text: 'x'.repeat(I.TEXT_MAX + 1) }).error[0]).toMatch(/characters/);
    expect(I.captureInput({ title: 7 }).error).toEqual(['a title is needed']);
    expect(I.captureInput({ title: 'A', text: { x: 1 } }).error[0]).toMatch(/text/);
    expect(I.captureInput(null).error).toEqual(['a title is needed']);
  });
});

describe('a capture is a normal plan entry', () => {
  it('id from the title, the text as summary, general, later by the owner, idea, and the inbox marker', () => {
    const reg = P.emptyRegister(NOW);
    const r = I.capturePlan(reg, { title: 'Dark mode', text: 'People read at night.' }, { projects: PROJECTS, now: NOW });
    expect(r.error).toEqual([]);
    expect(r.created).toBe(true);
    expect(r.entry).toMatchObject({
      id: 'PL-DARK-MODE-1',
      title: 'Dark mode',
      summary: 'People read at night.',
      project: 'general',
      priority: 'later',
      priority_set_by: 'owner',
      maturity: 'idea',
      inbox: { at: NOW, by: 'owner' },
    });
    expect(reg.entries).toHaveLength(1);
    // the entry passes the register's own validation (the inbox field is known)
    expect(P.validateEntry(r.entry, { projects: PROJECTS }).error).toEqual([]);
  });
  it('no summary when there is no text', () => {
    const reg = P.emptyRegister(NOW);
    const r = I.capturePlan(reg, { title: 'Offline maps' }, { projects: PROJECTS, now: NOW });
    expect(r.entry.summary).toBeUndefined();
  });
  it('the id is collision safe, never reuses an archived id, and falls back to PL-PLAN for a title without letters', () => {
    const reg = P.emptyRegister(NOW);
    reg.archive = { 'PL-DARK-MODE-1': { merged_to: 'PL-X' } };
    expect(I.capturePlan(reg, { title: 'Dark mode' }, { projects: PROJECTS, now: NOW }).entry.id).toBe('PL-DARK-MODE-2');
    const other = I.capturePlan(reg, { title: 'dark   MODE!' }, { projects: PROJECTS, now: NOW });
    // the same title while it waits in the Inbox is not a second plan
    expect(other.duplicate).toBe('PL-DARK-MODE-2');
    expect(other.created).toBeUndefined();
    expect(reg.entries).toHaveLength(1);
    expect(I.capturePlan(reg, { title: '!!!' }, { projects: PROJECTS, now: NOW }).entry.id).toBe('PL-PLAN-1');
  });
  it('a title like a sorted plan is captured anyway, with a warning that names it', () => {
    const reg = P.emptyRegister(NOW);
    I.capturePlan(reg, { title: 'Dark mode' }, { projects: PROJECTS, now: NOW });
    P.editEntry(reg, 'PL-DARK-MODE-1', { priority: 'now', now_category: ['important'] }, { role: 'owner', projects: PROJECTS });
    const r = I.capturePlan(reg, { title: 'Dark mode' }, { projects: PROJECTS, now: NOW });
    expect(r.created).toBe(true);
    expect(r.entry.id).toBe('PL-DARK-MODE-2');
    expect(r.warnings.join(' ')).toMatch(/PL-DARK-MODE-1/);
  });
  it('an invalid input changes nothing', () => {
    const reg = P.emptyRegister(NOW);
    expect(I.capturePlan(reg, { title: '' }, { projects: PROJECTS, now: NOW }).error.length).toBeGreaterThan(0);
    expect(reg.entries).toHaveLength(0);
  });
});

describe('in the Inbox until it is sorted', () => {
  let reg: any;
  beforeEach(() => {
    reg = P.emptyRegister(NOW);
    I.capturePlan(reg, { title: 'Dark mode' }, { projects: PROJECTS, now: NOW });
  });
  const one = () => reg.entries[0];

  it('a new priority or maturity removes the marker (that is sorting it)', () => {
    expect(I.isInInbox(one(), [])).toBe(true);
    const r = P.editEntry(reg, 'PL-DARK-MODE-1', { maturity: 'investigated' }, { role: 'owner', projects: PROJECTS });
    expect(r.error).toEqual([]);
    expect(one().inbox).toBeUndefined();
    expect(r.changed).toContain('inbox');
  });
  it('prioritize removes it too; an edit of another field keeps it', () => {
    P.editEntry(reg, 'PL-DARK-MODE-1', { summary: 'More words' }, { role: 'owner', projects: PROJECTS });
    expect(one().inbox).toBeTruthy();
    const r = P.prioritize(reg, ['PL-DARK-MODE-1'], { priority: 'owner' }, { role: 'owner', projects: PROJECTS });
    expect(r.error).toEqual([]);
    expect(one().inbox).toBeUndefined();
  });
  it('inbox=null removes it; nobody sets it by hand', () => {
    expect(P.editEntry(reg, 'PL-DARK-MODE-1', { inbox: null }, { role: 'owner', projects: PROJECTS }).error).toEqual([]);
    expect(one().inbox).toBeUndefined();
    const set = P.editEntry(reg, 'PL-DARK-MODE-1', { inbox: { at: NOW, by: 'owner' } }, { role: 'owner', projects: PROJECTS });
    expect(set.error.join(' ')).toMatch(/inbox is set by the tool/);
    const made = P.newEntry(
      P.emptyRegister(NOW),
      { id: 'PL-X', title: 'X', project: 'general', priority: 'later', inbox: { at: NOW, by: 'owner' } },
      { role: 'owner', projects: PROJECTS },
    );
    expect(made.error.join(' ')).toMatch(/inbox is set by the tool/);
  });
  it('the shape is checked', () => {
    expect(P.validateEntry({ ...one(), inbox: 'yes' }, { projects: PROJECTS }).error.join(' ')).toMatch(/inbox/);
  });
  it('a queue task that points to it, or a drop, takes it out', () => {
    expect(I.isInInbox(one(), [{ id: 'T-1', plan: 'PL-DARK-MODE-1' }])).toBe(false);
    expect(I.isInInbox({ ...one(), priority: 'drop' }, [])).toBe(false);
    expect(I.isInInbox({ id: 'PL-Y' }, [])).toBe(false);
  });
});

describe('the INBOX line and the rows', () => {
  it('counts the captured plans that wait, oldest first; nothing when empty', () => {
    const reg = P.emptyRegister(NOW);
    I.capturePlan(reg, { title: 'B later' }, { projects: PROJECTS, now: '2026-11-20T09:00:00.000Z' });
    I.capturePlan(reg, { title: 'A first' }, { projects: PROJECTS, now: '2026-11-20T08:00:00.000Z' });
    const s = I.inboxSummary(reg, []);
    expect(s).toEqual({ new: 2, ids: ['PL-A-FIRST-1', 'PL-B-LATER-1'] });
    expect(I.inboxLine(s, 'ravenseat')).toBe(
      'INBOX: 2 captured plans not sorted yet (PL-A-FIRST-1, PL-B-LATER-1): ravenseat plan inbox',
    );
    expect(I.inboxLine({ new: 1, ids: ['PL-A'] })).toBe('INBOX: 1 captured plan not sorted yet (PL-A): ravenseat plan inbox');
    expect(I.inboxLine({ new: 0, ids: [] })).toBe(null);
    const rows = I.inboxRows(reg, []);
    expect(rows.map((r: any) => r.id)).toEqual(['PL-A-FIRST-1', 'PL-B-LATER-1']);
    expect(rows[0]).toMatchObject({ title: 'A first', at: '2026-11-20T08:00:00.000Z', by: 'owner' });
  });
});

describe('the INBOX line is printed by the pulse and show, next to FINDINGS', () => {
  it('both call inboxLineNow right after the findings line', () => {
    const CLI_DIR = join(__dirname, '..', '..', 'cli');
    for (const f of ['orchestrator.mjs', 'view.mjs']) {
      const src = readFileSync(join(CLI_DIR, f), 'utf8');
      expect(src).toMatch(/import \{ inboxLineNow \} from '\.\/planInbox\.mjs'/);
      expect(src).toMatch(/findingsLineNow\(\);\s*if \(fl\) console\.log\(fl\);\s*\/\/[^\n]*\n\s*const il = inboxLineNow\(\);\s*if \(il\) console\.log\(il\);/);
    }
  });
});

describe('the board shows a captured plan in the Inbox', () => {
  it('plansData gives inbox { by: owner } and the horizon is inbox, with the captured text as its sentence', () => {
    const reg = P.emptyRegister(NOW);
    I.capturePlan(reg, { title: 'Dark mode', text: 'People read at night.' }, { projects: PROJECTS, now: NOW });
    const d = V.plansData(reg, { tasks: [], projects: PROJECTS, areas: {} }, { now: new Date(NOW) });
    const p = d.entries[0];
    expect(p.inbox).toEqual({ by: 'owner', at: NOW });
    expect(V.horizonFor(p)).toBe('inbox');
    expect(V.planStatus(p).text).toBe('In the inbox, not sorted yet');
    expect(V.planSentence(p).text).toBe('People read at night.');
    // a queue task that points to it takes it out of the Inbox
    const q = V.plansData(reg, { tasks: [{ id: 'T-1', plan: p.id, status: 'waiting' }], projects: PROJECTS, areas: {} }, { now: new Date(NOW) });
    expect(q.entries[0].inbox).toBe(null);
  });
});

describe('queue.mjs plan capture and plan inbox (copy in a temporary folder)', () => {
  let folder: string;
  const run = (args: string[]) => {
    try {
      const out = execFileSync(process.execPath, [QUEUE_MJS, ...args], {
        env: {
          ...process.env,
          QUEUE_FOLDER: folder,
          QUEUE_GIT: folder,
          QUEUE_TIME_LOG: join(folder, 'times.jsonl'),
          QUEUE_PLAN_SOURCE_ROOT: folder,
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { code: 0, out, data: (() => { try { return JSON.parse(out.trim().split('\n').pop() ?? 'null'); } catch { return null; } })() };
    } catch (e) {
      const x = e as { status: number; stdout: string };
      let data = null;
      try {
        data = JSON.parse(String(x.stdout ?? '').trim().split('\n').pop() ?? 'null');
      } catch {
        data = null;
      }
      return { code: x.status, out: String(x.stdout ?? ''), data };
    }
  };
  const readReg = () => JSON.parse(readFileSync(join(folder, 'plans.json'), 'utf8'));
  const readQueue = () => JSON.parse(readFileSync(join(folder, 'queue.json'), 'utf8'));

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'queue-inbox-'));
    writeFileSync(
      join(folder, 'queue.json'),
      JSON.stringify({
        changed: '2026-11-19T08:00:00.000Z',
        tasks: [],
        projects: { app: { title: 'App', area: 'alpha' } },
        areas: { alpha: { title: 'Alpha' } },
        question: {},
        resolved: [],
      }),
    );
    writeFileSync(join(folder, 'plans.json'), JSON.stringify(P.emptyRegister('2026-11-19T09:00:00.000Z')));
  });
  afterEach(() => rmSync(folder, { recursive: true, force: true }));

  it('captures with a title and text, creates the project general on first use, and plan undo takes it back', () => {
    const r = run(['plan', 'capture', 'Dark mode', '--text', 'People read at night.', '--json']);
    expect(r.code).toBe(0);
    expect(r.data.ok).toBe(true);
    expect(r.data.entry.id).toBe('PL-DARK-MODE-1');
    expect(typeof r.data.log).toBe('number');
    expect(readQueue().projects.general).toMatchObject({ title: 'General' });
    const e = readReg().entries[0];
    expect(e).toMatchObject({ title: 'Dark mode', summary: 'People read at night.', project: 'general', inbox: { by: 'owner' } });
    const u = run(['plan', 'undo', '--nr', String(r.data.log), '--json']);
    expect(u.code).toBe(0);
    expect(readReg().entries).toHaveLength(0);
  });
  it('--file takes { title, text } (the board), the same title again writes nothing, and plan inbox lists it', () => {
    const f = join(folder, 'c.json');
    writeFileSync(f, JSON.stringify({ title: 'Offline maps', text: 'For the cabin.' }));
    expect(run(['plan', 'capture', '--file', f, '--json']).data.entry.id).toBe('PL-OFFLINE-MAPS-1');
    const again = run(['plan', 'capture', '--file', f, '--json']);
    expect(again.code).toBe(0);
    expect(again.data).toMatchObject({ ok: true, duplicate: 'PL-OFFLINE-MAPS-1', log: null });
    expect(readReg().entries).toHaveLength(1);
    const list = run(['plan', 'inbox', '--json']);
    expect(list.data.rows.map((x: any) => x.id)).toEqual(['PL-OFFLINE-MAPS-1']);
    const text = run(['plan', 'inbox']);
    expect(text.out).toMatch(/PL-OFFLINE-MAPS-1/);
  });
  it('without a title it says how to use it and writes nothing', () => {
    const r = run(['plan', 'capture', '--json']);
    expect(r.code).not.toBe(0);
    expect(readReg().entries).toHaveLength(0);
  });
});
