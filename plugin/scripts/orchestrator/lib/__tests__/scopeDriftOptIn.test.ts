// =============================================================
// scopeDriftOptIn.test.ts: the two opt-in scope drift guards and their Checks cards (bolk B7 of the scope drift plan,
// plans/scope-drift-dry-katalog-2026-11-15.md V6, V7 and important_when).
//
// Locks: (1) both are off by default, with a settings row, a card and a setup tip; (2) V6 lifts reviewer-gap in at
// receive, with one reason line, only when it is on, the task names its files, at least scopeNotes.driftGapFiles files
// lie outside them and their share is over scopeNotes.driftGapShare; never without the diff (outside receive), never
// for a task that names no files (lite); (3) V7 warns once per file while a track writes outside its files and reads,
// only when it is on, never twice for a file another warning already covers, and never as a denial; (4) the cards turn
// important (the red marker) when the finding log shows scope drift three times in one area within 30 days, never in
// lite mode; (5) with both off, the reviewers and the write warnings are exactly as before.
// =============================================================
import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const SN = require('../scopeNotes.js');
const H = require('../queueHelpers.js');
const KK = require('../queueConfig.js');
const WW = require('../writeWarn.js');
const OI = require('../optInChecks.js');
const R = require('../settingsRegistry.js');
const CATALOG = require('../checksCatalog.js');

const BUILTIN = path.resolve(__dirname, '..', '..', 'checks-catalog');
const conf = (own: object = {}) => KK.merge(KK.STANDARD, own);
const task = { id: 'A-1', class: 'D', owned_files: ['src/a.ts'], reads: ['docs/'] };
const outside = ['lib/x.js', 'lib/y.js', 'cli/z.mjs', 'cli/w.mjs'];

describe('the settings: off by default, a row each, the numbers checked', () => {
  it('the defaults', () => {
    expect(SN.setupOf({})).toMatchObject({ driftGap: false, driftGapFiles: 4, driftGapShare: 40, driftWarn: false });
    expect(KK.STANDARD.scopeNotes).toMatchObject({ driftGap: false, driftGapFiles: 4, driftGapShare: 40, driftWarn: false });
    for (const k of ['driftGap', 'driftWarn']) expect(R.rowFor(`scopeNotes.${k}`)?.type, k).toBe('onoff');
    for (const k of ['driftGapFiles', 'driftGapShare']) expect(R.rowFor(`scopeNotes.${k}`)?.type, k).toBe('integer');
  });

  it('a wrong value is the default, and doctor names it', () => {
    const s = SN.setupOf({ scopeNotes: { driftGap: 'yes', driftGapFiles: 0, driftGapShare: 120, driftWarn: 1 } });
    expect(s).toMatchObject({ driftGap: false, driftGapFiles: 4, driftGapShare: 40, driftWarn: false });
    const p = SN.setupProblems({ driftGap: 'yes', driftGapFiles: 0, driftGapShare: 120, driftWarn: 1 });
    expect(p.join('\n')).toMatch(/driftGap must be true or false/);
    expect(p.join('\n')).toMatch(/driftGapFiles must be/);
    expect(p.join('\n')).toMatch(/driftGapShare must be/);
    expect(p.join('\n')).toMatch(/driftWarn must be true or false/);
    expect(SN.setupProblems({ driftGap: true, driftGapFiles: 6, driftGapShare: 50, driftWarn: true })).toEqual([]);
  });

  it('both are opt-in checks with a card, offered in full mode only', () => {
    for (const key of ['scopeNotes.driftGap', 'scopeNotes.driftWarn']) {
      const c = OI.byKey(key);
      expect(c, key).toBeTruthy();
      expect(c.row, key).toBeNull();
      expect(OI.tipsToGive({}, [], { lite: false }).map((x: { key: string }) => x.key)).toContain(key);
      expect(OI.tipsToGive({}, [], { lite: true }).map((x: { key: string }) => x.key)).not.toContain(key);
    }
  });
});

describe('V6: drift lifts reviewer-gap in at receive', () => {
  const on = conf({ scopeNotes: { driftGap: true } });
  const gap = (c: object, x: object) => H.reviewersForTask(task, { config: c, ...x }).find((r: { type: string }) => r.type === 'reviewer-gap');

  it('over the threshold: reviewer-gap with one reason line', () => {
    const r = gap(on, { changedPaths: ['src/a.ts', ...outside], diff: '' });
    expect(r).toMatchObject({ fixed: false, drift: true });
    expect(r.reasons).toEqual(['drift: 4 of 5 changed files outside the task\'s files and reads']);
  });

  it('off (the default), under the file count, under the share, or outside receive: nothing', () => {
    expect(gap(conf(), { changedPaths: ['src/a.ts', ...outside], diff: '' })).toBeUndefined();
    expect(gap(on, { changedPaths: ['src/a.ts', ...outside.slice(0, 3)], diff: '' })).toBeUndefined();
    const owned = Array.from({ length: 7 }, (_, i) => `src/o${i}.ts`);
    // 4 of 11 outside is 36 %, under the 40 % share.
    const wide = { ...task, owned_files: ['src/'] };
    expect(H.reviewersForTask(wide, { config: on, changedPaths: [...owned, ...outside], diff: '' }).map((r: { type: string }) => r.type)).not.toContain('reviewer-gap');
    expect(gap(on, { changedPaths: ['src/a.ts', ...outside] })).toBeUndefined();
  });

  it('a task that names no files (lite) never lifts it: there is no ownership to drift from', () => {
    const bare = { id: 'B-1', class: 'D' };
    expect(H.reviewersForTask(bare, { config: on, changedPaths: outside, diff: '' }).map((r: { type: string }) => r.type)).not.toContain('reviewer-gap');
  });

  it('a gap reviewer the task already has gets the reason added, not a second entry', () => {
    const both = conf({ scopeNotes: { driftGap: true }, helpers: { 'reviewer-gap': { enabled: true, classes: ['D'] } } });
    const list = H.reviewersForTask(task, { config: both, changedPaths: ['src/a.ts', ...outside], diff: '' });
    expect(list.filter((r: { type: string }) => r.type === 'reviewer-gap')).toHaveLength(1);
    expect(list.find((r: { type: string }) => r.type === 'reviewer-gap').reasons).toContain('drift: 4 of 5 changed files outside the task\'s files and reads');
  });

  it('the rule itself: share over the threshold and at least the file count outside', () => {
    const s = SN.setupOf({ scopeNotes: { driftGap: true } });
    expect(SN.driftGapReason({ changed: 10, outside: 4, hasOwnership: true }, s)).toBeNull();
    expect(SN.driftGapReason({ changed: 9, outside: 4, hasOwnership: true }, s)).toMatch(/^drift: 4 of 9/);
    expect(SN.driftGapReason({ changed: 4, outside: 3, hasOwnership: true }, s)).toBeNull();
    expect(SN.driftGapReason({ changed: 4, outside: 4, hasOwnership: false }, s)).toBeNull();
    expect(SN.driftGapReason({ changed: 9, outside: 9, hasOwnership: true }, SN.setupOf({}))).toBeNull();
    expect(SN.driftGapReason(null, s)).toBeNull();
  });
});

describe('V7: a write warning for drift', () => {
  const base = { task, protectedPaths: ['.github/'], before: null, after: 'x' };

  it('on: a file outside the task\'s files and reads warns, kind drift, and tells the track not to stop for it', () => {
    const w = WW.assessTrackWrite({ ...base, rel: 'lib/x.js', driftWarn: true });
    expect(w).toHaveLength(1);
    expect(w[0].kind).toBe('drift');
    expect(w[0].text).toContain('lib/x.js');
    expect(w[0].text).toMatch(/no need to stop/i);
  });

  it('off (the default), an owned file, a read, no task or no ownership: nothing', () => {
    expect(WW.assessTrackWrite({ ...base, rel: 'lib/x.js' })).toEqual([]);
    expect(WW.assessTrackWrite({ ...base, rel: 'src/a.ts', driftWarn: true })).toEqual([]);
    expect(WW.assessTrackWrite({ ...base, rel: 'docs/a.md', driftWarn: true })).toEqual([]);
    expect(WW.assessTrackWrite({ ...base, task: null, rel: 'lib/x.js', driftWarn: true })).toEqual([]);
    expect(WW.assessTrackWrite({ ...base, task: { id: 'B-1' }, rel: 'lib/x.js', driftWarn: true })).toEqual([]);
  });

  it('a file another warning already names (protected, owned by another task) gets that warning only', () => {
    const w = WW.assessTrackWrite({ ...base, rel: '.github/workflows/ci.yml', driftWarn: true });
    expect(w.map((x: { kind: string }) => x.kind)).toEqual(['protected']);
    const other = [{ id: 'C-1', status: 'running', owned_files: ['lib/x.js'] }];
    expect(WW.assessTrackWrite({ ...base, rel: 'lib/x.js', driftWarn: true, tasks: other }).map((x: { kind: string }) => x.kind)).toEqual(['foreign']);
  });
});

const temporary: string[] = [];
afterAll(() => {
  for (const f of temporary) fs.rmSync(f, { recursive: true, force: true });
});

describe('V7 in the hook', () => {
  const HOOK = path.resolve(__dirname, '..', '..', 'hook-write-guard.mjs');
  function project(own: object) {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-driftwarn-'));
    temporary.push(folder);
    const repo = path.join(folder, 'wt');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'lib'), { recursive: true });
    const data = path.join(folder, 'data');
    fs.mkdirSync(data);
    const configFile = path.join(folder, 'queue.config.json');
    fs.writeFileSync(configFile, JSON.stringify({ baseBranch: 'main', ...own }));
    fs.writeFileSync(path.join(data, 'queue.json'), JSON.stringify({ created: '2026-01-01T00:00:00.000Z', limits: {}, resolved: [],
      tasks: [{ id: 'A-1', title: 'a', status: 'running', class: 'K', domain: 'd', value: 5, content_min: 30, depends_on: [], waiting_on: [], owned_files: ['src/a.ts'], mission: 'x' }] }));
    const sess = path.join(folder, 'tr', 'sess', 'subagents');
    fs.mkdirSync(sess, { recursive: true });
    fs.writeFileSync(path.join(sess, 'agent-ag1.jsonl'), JSON.stringify({ type: 'user', message: { content: 'You are track A-1. Read prompt-A-1.md.' } }) + '\n');
    const env = { ...process.env, QUEUE_FOLDER: data, QUEUE_CONFIG: configFile, QUEUE_ROOT: folder, WRITE_WARN_STATE: path.join(folder, 'state') } as NodeJS.ProcessEnv;
    return (file: string) => {
      const r = spawnSync(process.execPath, [HOOK], {
        input: JSON.stringify({ agent_type: 'track', agent_id: 'ag1', session_id: 'sess', transcript_path: path.join(folder, 'tr', 'sess.jsonl'),
          cwd: repo, tool_name: 'Write', tool_input: { file_path: path.join(repo, file), content: 'x' } }),
        encoding: 'utf8', env, cwd: repo,
      });
      return r.stdout ? JSON.parse(r.stdout) : null;
    };
  }

  it('on: one warning per file as additionalContext, never a denial', () => {
    const run = project({ scopeNotes: { driftWarn: true } });
    const out = run('lib/x.js');
    expect(out.hookSpecificOutput.permissionDecision).toBeUndefined();
    expect(out.hookSpecificOutput.additionalContext).toContain('lib/x.js');
    expect(run('lib/x.js')).toBeNull();
    expect(run('src/a.ts')).toBeNull();
  });

  it('off (the default): nothing', () => {
    expect(project({})('lib/x.js')).toBeNull();
  });
});

describe('the cards and the red marker', () => {
  const report = (facts: object) =>
    CATALOG.buildReport({ facts: { git: true, ...facts }, catalog: CATALOG.loadCatalog({ builtin: BUILTIN, own: path.join(BUILTIN, 'none') }), now: 'x' });
  const card = (r: { suggestions: { key: string; priority: string }[] }, key: string) => r.suggestions.find((s) => s.key === key);
  const OFF = { optInOff: ['scopeNotes.driftGap', 'scopeNotes.driftWarn'] };
  const ledger = (n: number) => ({ ledger: { due: [], guardFailed: [], marker: true, recent: { 'scope-drift': n } } });

  it('low while off, high at three scope drift incidents in one area, gone when on', () => {
    for (const key of ['drift-gap-review', 'drift-write-warn']) {
      expect(card(report(OFF), key), key).toMatchObject({ priority: 'low', action: 'setting' });
      expect(card(report({ ...OFF, ...ledger(2) }), key)?.priority, key).toBe('low');
      expect(card(report({ ...OFF, ...ledger(3) }), key)?.priority, key).toBe('high');
      expect(card(report({ optInOff: [], ...ledger(3) }), key), key).toBeUndefined();
    }
    expect(report({ ...OFF, ...ledger(3) }).important).toBe(report(OFF).important + 2);
  });

  it('the card says what the finding log saw', () => {
    expect(card(report({ ...OFF, ...ledger(3) }), 'drift-gap-review')).toMatchObject({ detail: expect.stringMatching(/scope drift 3 time/) });
    expect((card(report(OFF), 'drift-gap-review') as { detail?: string }).detail ?? null).toBeNull();
  });

  it('lite mode: the cards are not offered, and no scope drift card lights the red marker', () => {
    const lite = { ...OFF, ...ledger(5), lite: true };
    expect(card(report(lite), 'drift-gap-review')).toBeUndefined();
    expect(card(report(lite), 'drift-write-warn')).toBeUndefined();
    expect(CATALOG.holds('ledger-recent:scope-drift', lite)).toBe(false);
    expect(CATALOG.holds('ledger-recent:scope-drift', { ...lite, lite: false })).toBe(true);
  });
});
