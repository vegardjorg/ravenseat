// =============================================================
// settingsView.test.ts: lib/settingsView.js, what `ravenseat settings`, the board's grouped settings and
// `ravenseat settings set` read from the registry (plans/innstillinger-vurdering-2026-11-12.md, steps 4 to 6b).
//
// Why: the registry (lib/settingsRegistry.js) is the one list of settings. This file checks the parts built on it:
//   - the grouping: each category with its basic rows first and the advanced ones marked, in the registry's order;
//   - the lite filter: a full-only row (maxDPlus, maxPerDomain) is not shown in lite but counted on one line, and a
//     category with nothing for lite is one closed line;
//   - the current value, the default for the mode and the weakened guards (the banner and the CLI's first line);
//   - the value parser and the rule for when a change needs the owner's confirmation (only a weaker value);
//   - the shared writer, which keeps the form of queue.config.json (its order, indentation and `_comment` keys).
// =============================================================
import { describe, it, expect } from 'vitest';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const SV = require('../settingsView.js') as any;
const R = require('../settingsRegistry.js') as any;
const KK = require('../queueConfig.js') as any;
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

const configFor = (own: object) => KK.merge(KK.STANDARD, own);
const view = (o: { own?: object; queue?: object; migrations?: boolean; rows?: unknown[] } = {}) =>
  SV.settingsView({ config: configFor(o.own ?? {}), queue: o.queue ?? { tasks: [] }, migrations: o.migrations ?? true, rows: o.rows });
const rowsOf = (v: any, id: string) => v.categories.find((c: any) => c.id === id).rows;
const keysOf = (v: any, id: string) => rowsOf(v, id).map((r: any) => r.key);

describe('the grouping', () => {
  it('all eleven categories in the registry order, basic rows first, every row once', () => {
    const v = view();
    expect(v.categories.map((c: any) => c.id)).toEqual(R.CATEGORIES.map((c: any) => c.id));
    for (const c of v.categories) {
      const levels = c.rows.map((r: any) => r.level);
      expect(levels.indexOf('advanced') < 0 || levels.lastIndexOf('basic') < levels.indexOf('advanced'), c.id).toBe(true);
    }
    expect(v.categories.flatMap((c: any) => c.rows.map((r: any) => r.key)).sort()).toEqual(
      R.SETTINGS.map((r: any) => r.key).sort(),
    );
  });

  it('each row says where it is stored, in words', () => {
    const r = (k: string) => view().categories.flatMap((c: any) => c.rows).find((x: any) => x.key === k);
    expect(r('limits.maxConcurrent').storeText).toBe('Saved only for you (queue.json)');
    expect(r('push.mode').storeText).toBe('Saved for the project (queue.config.json, remember to commit)');
  });

  it('maxDb is left out without a migrations folder', () => {
    expect(keysOf(view({ migrations: false }), 'limits')).not.toContain('limits.maxDb');
    expect(keysOf(view({ migrations: true }), 'limits')).toContain('limits.maxDb');
  });
});

describe('the lite filter', () => {
  it('lite marks maxDPlus and maxPerDomain full only, with the reason; full mode does not', () => {
    const lite = rowsOf(view({ own: { mode: 'lite' } }), 'limits');
    const full = rowsOf(view({ own: { mode: 'full' } }), 'limits');
    const f = (rows: any[], k: string) => rows.find((x) => x.key === k);
    expect(f(lite, 'limits.maxDPlus')).toMatchObject({ hidden: true, fullOnly: true, fullWhy: 'lite has one task type (class K)' });
    expect(f(lite, 'limits.maxPerDomain').hidden).toBe(true);
    expect(f(lite, 'limits.maxConcurrent').hidden).toBe(false);
    expect(f(full, 'limits.maxDPlus').hidden).toBe(false);
  });

  it('the CLI in lite: no full-only row, one count line per category, advanced marked only with --advanced', () => {
    const v = view({ own: { mode: 'lite' } });
    const text = SV.cliLines(v, { cli: 'ravenseat' }).join('\n');
    expect(text).toContain('Mode: lite. Weakened guards: none.');
    expect(text).not.toMatch(/limits\.maxDPlus/);
    expect(text).toMatch(/limits\.maxConcurrent/);
    // Limits and cost: maxDb and the rest are advanced, maxDPlus and maxPerDomain full only.
    expect(text).toMatch(/\+ \d+ advanced \(--advanced\), 2 full mode only \(--all\)/);
    expect(text).not.toContain('[advanced]');
    const adv = SV.cliLines(v, { cli: 'ravenseat', advanced: true }).join('\n');
    expect(adv).toMatch(/limits\.maxDb .*\[advanced\]/);
    expect(adv).not.toMatch(/limits\.maxDPlus/);
    const all = SV.cliLines(v, { cli: 'ravenseat', all: true }).join('\n');
    expect(all).toMatch(/limits\.maxDPlus .*\[full mode only: lite has one task type \(class K\)\]/);
  });

  it('full mode shows the same rows without a full-only line', () => {
    const text = SV.cliLines(view({ own: { mode: 'full' } }), { cli: 'ravenseat', advanced: true }).join('\n');
    expect(text).toMatch(/limits\.maxDPlus/);
    expect(text).not.toContain('full mode only');
  });

  it('a category with nothing for lite is one closed line', () => {
    const rows = [
      R.rowFor('limits.maxConcurrent'),
      ...R.SETTINGS.filter((r: any) => r.category === 'plans' && r.modes.length === 1),
    ];
    const v = view({ own: { mode: 'lite' }, rows });
    const plans = v.categories.find((c: any) => c.id === 'plans');
    expect(plans.fullOnlyCategory).toBe(true);
    const lines = SV.cliLines(v, { cli: 'ravenseat' });
    expect(lines).toContain('Plans and focus: full mode only (ravenseat mode full).');
    expect(lines.join('\n')).not.toContain('features.plans.legal');
  });

  it('--changed shows only what differs from the default, from every level', () => {
    const v = view({ own: { maxFixRounds: 5 }, queue: { tasks: [], limits: { maxConcurrent: 3 } } });
    const text = SV.cliLines(v, { cli: 'ravenseat', changed: true }).join('\n');
    expect(text).toMatch(/limits\.maxConcurrent +3/);
    expect(text).toMatch(/maxFixRounds +5/);
    expect(text).not.toMatch(/limits\.nightRun/);
  });

  it('a category filter keeps one category', () => {
    const text = SV.cliLines(view(), { cli: 'ravenseat', category: 'gates' }).join('\n');
    expect(text).toContain('Gates and checks');
    expect(text).not.toContain('Limits and cost');
  });
});

describe('values, defaults and weakened guards', () => {
  it('reads the value from its store: limits, guidance, board switches and queue.config.json', () => {
    const v = view({
      own: { push: { mode: 'threshold' } },
      queue: { tasks: [], limits: { maxConcurrent: 2, nightRun: false }, guidance: 'quiet', board: { blockedColumn: true } },
    });
    const r = (k: string) => v.categories.flatMap((c: any) => c.rows).find((x: any) => x.key === k);
    expect(r('limits.maxConcurrent')).toMatchObject({ value: 2, valueText: '2', standardText: '5', changed: true });
    expect(r('limits.nightRun')).toMatchObject({ value: false, valueText: 'off' });
    expect(r('guidance').value).toBe('quiet');
    expect(r('board.blockedColumn').value).toBe(true);
    expect(r('push.mode')).toMatchObject({ value: 'threshold', weakened: true });
  });

  it('lite softens gitSurface by default, which is not a weakened guard; off in the file is', () => {
    expect(view({ own: { mode: 'lite' } }).weakened).toEqual([]);
    const off = view({ own: { gitSurface: 'off', secretScan: { enabled: false } } });
    expect(off.weakened.map((w: any) => w.key)).toEqual(['gitSurface', 'secretScan.enabled']);
    expect(off.weakened[1]).toMatchObject({ title: 'Secret scan before push', valueText: 'off' });
    expect(SV.cliLines(off, { cli: 'ravenseat' })[0]).toBe(
      'Mode: full. Weakened guards: 2 (gitSurface off, secretScan.enabled off).',
    );
  });

  it('confirmFor names the options that would weaken from the value now', () => {
    const r = (v: any, k: string) => v.categories.flatMap((c: any) => c.rows).find((x: any) => x.key === k);
    expect(r(view(), 'gitSurface').confirmFor).toEqual(['warn', 'off']);
    expect(r(view({ own: { gitSurface: 'off' } }), 'gitSurface').confirmFor).toEqual([]);
    expect(r(view(), 'secretScan.enabled').confirmFor).toEqual(['off']);
    expect(r(view(), 'maxFixRounds').confirmFor).toEqual([]);
  });
});

describe('parseValue and needsConfirm', () => {
  const row = (k: string) => R.rowFor(k);
  it('parses on/off, choices (also true/false choices), integers and none', () => {
    expect(SV.parseValue(row('secretScan.enabled'), 'off')).toEqual({ value: false });
    expect(SV.parseValue(row('secretScan.enabled'), 'on')).toEqual({ value: true });
    expect(SV.parseValue(row('gitSurface'), 'warn')).toEqual({ value: 'warn' });
    expect(SV.parseValue(row('baseGate.enabled'), 'off')).toEqual({ value: false });
    expect(SV.parseValue(row('baseGate.enabled'), 'auto')).toEqual({ value: 'auto' });
    expect(SV.parseValue(row('maxFixRounds'), '4')).toEqual({ value: 4 });
    expect(SV.parseValue(row('push.maxAgeHours'), 'none')).toEqual({ value: null });
    expect(SV.parseValue(row('gitSurface'), 'sometimes').error).toMatch(/stop, warn or off/);
    expect(SV.parseValue(row('maxFixRounds'), 'x').error).toMatch(/whole number/);
    expect(SV.parseValue(row('protectedPaths'), '[]').error).toMatch(/queue\.config\.json/);
    expect(SV.parseValue(row('baseBranch'), 'dev').error).toMatch(/read only/);
  });

  it('a weaker value needs the confirmation; a stronger or the same value never does', () => {
    const r = row('gitSurface');
    expect(SV.needsConfirm(r, 'warn', { now: 'stop', standard: 'stop' })).toBe(true);
    expect(SV.needsConfirm(r, 'warn', { now: 'off', standard: 'stop' })).toBe(false);
    expect(SV.needsConfirm(r, 'stop', { now: 'off', standard: 'stop' })).toBe(false);
    expect(SV.needsConfirm(r, 'off', { now: 'off', standard: 'stop' })).toBe(false);
    expect(SV.needsConfirm(row('maxFixRounds'), 9, { now: 3, standard: 3 })).toBe(false);
    expect(SV.needsConfirm(row('proposals.autoAccept.enabled'), true, { now: false, standard: false })).toBe(true);
  });
});

describe('setJsonText: the shared writer keeps the form of the file', () => {
  const FILE = [
    '{',
    '    "_comment": "our setup, see the wiki",',
    '    "mode": "full",',
    '    "push": { "mode": "owner", "minTasks": 10 },',
    '    "gates": {',
    '        "quick": ["npm test"]',
    '    }',
    '}',
    '',
  ].join('\n');

  it('replaces a nested scalar in place (not the top-level mode with the same name)', () => {
    const out = SV.setJsonText(FILE, ['push', 'mode'], 'threshold');
    expect(out).toBe(FILE.replace('"mode": "owner"', '"mode": "threshold"'));
  });

  it('adds a missing key at the end of its object with the file\'s own indentation, keeping _comment', () => {
    const out = SV.setJsonText(FILE, ['maxFixRounds'], 5);
    expect(out).toContain('    "_comment": "our setup, see the wiki",');
    expect(out).toContain('    "gates": {\n        "quick": ["npm test"]\n    },\n    "maxFixRounds": 5\n}');
    expect(JSON.parse(out).maxFixRounds).toBe(5);
  });

  it('adds into an existing object, and builds a missing parent object', () => {
    const inGates = SV.setJsonText(FILE, ['gates', 'flakyRerun'], false);
    expect(inGates).toContain('"quick": ["npm test"],\n        "flakyRerun": false\n    }');
    const parent = SV.setJsonText(FILE, ['secretScan', 'enabled'], false);
    expect(JSON.parse(parent).secretScan).toEqual({ enabled: false });
    expect(parent).toContain('"_comment": "our setup, see the wiki"');
    expect(parent.startsWith('{\n    "_comment"')).toBe(true);
  });

  it('a key under features keeps its dot', () => {
    const out = SV.setJsonText('{\n  "features": {}\n}\n', ['features', 'plans.legal'], true);
    expect(JSON.parse(out)).toEqual({ features: { 'plans.legal': true } });
  });

  it('an empty or missing file gives a small object; the same value gives the same text', () => {
    expect(JSON.parse(SV.setJsonText(null, ['maxFixRounds'], 2))).toEqual({ maxFixRounds: 2 });
    expect(SV.setJsonText(FILE, ['push', 'minTasks'], 10)).toBe(FILE);
  });

  it('pathOf finds the segments from STANDARD (features.plans.legal is one key under features)', () => {
    expect(SV.pathOf('push.mode')).toEqual(['push', 'mode']);
    expect(SV.pathOf('features.plans.legal')).toEqual(['features', 'plans.legal']);
    expect(SV.pathOf('guidance')).toEqual(['guidance']);
  });
});

// ---- Step 7: the doctor row `settings` (doctorRows), and step 8: protectedPaths { add, remove } ----

describe('doctorRows: the doctor row settings', () => {
  const rows = (own: object = {}, queue: object = { tasks: [] }) =>
    SV.doctorRows({ config: KK.resolveOwn(configFor(own), own), queue, own, cli: 'ravenseat' });

  it('no weakened guard gives one OK line', () => {
    expect(rows()).toEqual([expect.objectContaining({ status: 'OK', message: 'no guard is weaker than its default' })]);
  });

  it('one WARN line names every guard weaker than its default: protectedPaths [], secretScan off, auto-accept on', () => {
    const r = rows({ protectedPaths: [], secretScan: { enabled: false } }, { tasks: [], proposals: { autoAccept: { enabled: true } } });
    const warn = r.filter((x: any) => x.status === 'WARN');
    expect(warn).toHaveLength(1);
    expect(warn[0].message).toMatch(/^3 guard\(s\) weaker than the default: /);
    expect(warn[0].message).toContain('protectedPaths leaves out every default path');
    expect(warn[0].message).toContain('secretScan.enabled off');
    expect(warn[0].message).toContain('proposals.autoAccept.enabled on');
    expect(warn[0].fix).toContain('ravenseat settings --changed');
    expect(r.some((x: any) => x.status === 'OK')).toBe(false);
  });

  it('a list that leaves out some default paths names how many and which', () => {
    const list = KK.STANDARD.protectedPaths.filter((p: string) => !['.github/', 'Makefile'].includes(p));
    const warn = rows({ protectedPaths: list }).find((x: any) => x.status === 'WARN');
    expect(warn.message).toContain('protectedPaths leaves out 2 default path(s): .github/, Makefile');
  });

  it('lite: the softened defaults are one INFO line, not a weakened guard', () => {
    const r = rows({ mode: 'lite' });
    expect(r.filter((x: any) => x.status === 'WARN')).toEqual([]);
    expect(r).toContainEqual(
      expect.objectContaining({
        status: 'INFO',
        message: 'lite: dependencyFiles and gitSurface warn instead of stop (set them in queue.config.json for full strength)',
      }),
    );
    // Set in the file, the lite line names only what is still softened.
    const one = rows({ mode: 'lite', gitSurface: 'stop' }).find((x: any) => x.status === 'INFO');
    expect(one.message).toBe('lite: dependencyFiles warns instead of stopping (set it in queue.config.json for full strength)');
    expect(rows({ mode: 'lite', gitSurface: 'stop', dependencyFiles: 'stop' })).toEqual([expect.objectContaining({ status: 'OK' })]);
  });

  it('protectedPaths remove: one INFO line per removed path; the floor and an unknown path are named as such', () => {
    const r = rows({ protectedPaths: { add: ['secrets/'], remove: ['.github/', 'queue.config.json', 'nope.txt'] } });
    const info = r.filter((x: any) => x.status === 'INFO').map((x: any) => x.message);
    expect(info).toEqual([
      'protectedPaths.remove: .github/ is no longer protected',
      'protectedPaths.remove: queue.config.json stays protected (it is in the floor, which is never removed)',
      'protectedPaths.remove: nope.txt is not a default path, so nothing was removed',
    ]);
    // Removing a default path is a weakened guard too.
    expect(r.find((x: any) => x.status === 'WARN').message).toContain('protectedPaths leaves out 1 default path(s): .github/');
  });

  it('add alone weakens nothing', () => {
    expect(rows({ protectedPaths: { add: ['secrets/'] } })).toEqual([expect.objectContaining({ status: 'OK' })]);
  });

  it('B4: ownership.sharedPatchCollides off is a weakened guard in the WARN line', () => {
    const warn = rows({ ownership: { sharedPatchCollides: false } }).find((x: any) => x.status === 'WARN');
    expect(warn.message).toBe('1 guard(s) weaker than the default: ownership.sharedPatchCollides off');
  });

  it('cloud.collect auto is a weakened guard; mode lite asks when switched but is reported by the lite line only', () => {
    expect(rows({ cloud: { collect: 'auto' } }).find((x: any) => x.status === 'WARN').message).toContain('cloud.collect auto');
    // A lite project (every new one is) is not told it has a weakened guard: the lite INFO line names what lite softens.
    const lite = view({ own: { mode: 'lite' } });
    expect(lite.weakened).toEqual([]);
    const modeRow = rowsOf(lite, 'project').find((r: any) => r.key === 'mode');
    expect(modeRow).toMatchObject({ weakened: false, canWeaken: true, confirmFor: [] });
    // From full, the lite option opens the warning dialog.
    expect(rowsOf(view({ own: { mode: 'full' } }), 'project').find((r: any) => r.key === 'mode').confirmFor).toEqual(['lite']);
  });
});

describe('protectedPaths: the object form { add, remove } (step 8)', () => {
  const resolved = (own: object) => KK.resolveOwn(configFor(own), own).protectedPaths;

  it('the list form works as before: it replaces the defaults; [] leaves only the floor to mergeGuard', () => {
    expect(resolved({ protectedPaths: ['a/'] })).toEqual(['a/']);
    expect(resolved({ protectedPaths: [] })).toEqual([]);
    expect(resolved({})).toEqual(KK.STANDARD.protectedPaths);
  });

  it('add extends the defaults; remove takes paths out of them, never out of the floor', () => {
    const list = resolved({ protectedPaths: { add: ['secrets/', '.github/'], remove: ['.github/', 'Makefile', 'QUEUE.CONFIG.JSON', '.claude/'] } });
    expect(list).toContain('secrets/');
    expect(list).not.toContain('Makefile');
    // add and remove of the same path: remove wins (the owner asked for it out), and the floor stays whatever remove says.
    expect(list).not.toContain('.github/');
    expect(list).toContain('queue.config.json');
    expect(list).toContain('.claude/');
    expect(list.length).toBe(KK.STANDARD.protectedPaths.length - 2 + 1);
  });

  it('a malformed object keeps the defaults (the stronger reading); doctor names it', () => {
    expect(resolved({ protectedPaths: { remove: '.github/' } })).toEqual(KK.STANDARD.protectedPaths);
    expect(resolved({ protectedPaths: { drop: ['.github/'] } })).toEqual(KK.STANDARD.protectedPaths);
  });

  it('removing a default path weakens the guard (settings, the banner, needsConfirm); add and a floor path do not', () => {
    const r = R.rowFor('protectedPaths');
    const std = KK.STANDARD.protectedPaths;
    expect(r.weakens({ remove: ['.github/'] }, std)).toBe(true);
    expect(r.weakens({ add: ['x/'] }, std)).toBe(false);
    expect(r.weakens({ remove: ['queue.config.json'] }, std)).toBe(false);
    expect(SV.needsConfirm(r, { remove: ['.github/'] }, { now: std, standard: std })).toBe(true);
    // The view reads the object form as well as the resolved list config() makes of it.
    expect(view({ own: { protectedPaths: { remove: ['.github/'] } } }).weakened.map((w: any) => w.key)).toEqual(['protectedPaths']);
    expect(view({ own: { protectedPaths: { remove: ['queue.config.json'] } } }).weakened).toEqual([]);
    // A list that leaves out only floor paths changes nothing, so it weakens nothing.
    expect(r.weakens(std.filter((p: string) => p !== 'queue.config.json'), std)).toBe(false);
  });
});
