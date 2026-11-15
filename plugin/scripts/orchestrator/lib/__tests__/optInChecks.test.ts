// =============================================================
// optInChecks.test.ts: the opt-in checks (lib/optInChecks.js) and how the Checks tab offers them (lib/checksCatalog.js).
//
// Why: the owner decided (2026-11-15) that every new check is off by default, offered once in setup, as a card with
// "Turn on" on the Checks tab, and as one INFO line in doctor. These lock: the defaults are off, a check counts as on only
// when its setting is exactly true, setup tips about each only once, and an important gap raises its card to high (the
// red marker) while a card set aside stays aside.
// =============================================================
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const OI = require('../optInChecks.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const KK = require('../queueConfig.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const CATALOG = require('../checksCatalog.js');

const BUILTIN = path.resolve(__dirname, '..', '..', 'checks-catalog');

describe('the opt-in checks', () => {
  it('are all off in the standard configuration, and each has a setting row and a card', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const R = require('../settingsRegistry.js');
    const categories = JSON.parse(fs.readFileSync(path.join(BUILTIN, 'categories.json'), 'utf8')).map((c: { key: string }) => c.key);
    for (const c of OI.OPT_IN) {
      expect(OI.valueAt(KK.STANDARD, c.key), c.key).toBe(false);
      expect(OI.isOn(KK.STANDARD, c.key)).toBe(false);
      expect(R.rowFor(c.key)?.type, c.key).toBe('onoff');
      const file = path.join(BUILTIN, 'suggestions', `${c.suggestion}.md`);
      const t = CATALOG.parseTemplate(fs.readFileSync(file, 'utf8'), c.suggestion);
      expect(t.errors).toEqual([]);
      expect(t).toMatchObject({ action: 'setting', setting: c.key });
      // security for the secret and permission checks, database for the probe guard: a category the catalog has.
      expect(categories, c.key).toContain(t.category);
      // The card applies while the check is off; an entry with offer() adds the fact it needs (share: repo-private).
      expect(t.when.split(',')[0], c.key).toBe(`off:${c.key}`);
    }
  });

  it('a check is on only when its setting is exactly true', () => {
    expect(OI.isOn({ secretScan: { atReceive: true } }, 'secretScan.atReceive')).toBe(true);
    for (const v of [false, 'true', 1, null, undefined]) expect(OI.isOn({ secretScan: { atReceive: v } }, 'secretScan.atReceive')).toBe(false);
    expect(OI.isOn({}, 'gitignoreCheck.enabled')).toBe(false);
  });

  it('setup tips about each check that is off, once: the ones already asked are not tipped again', () => {
    const all = OI.tipsToGive({}, [], { visibility: 'private', hasDatabase: true, sharedSettings: true });
    expect(all.map((c: { key: string }) => c.key)).toEqual(OI.OPT_IN.map((c: { key: string }) => c.key));
    // The probe guard only in a project with a database, the permissions check only where a shared settings file is.
    const bare = OI.tipsToGive({}, [], {}).map((c: { key: string }) => c.key);
    expect(bare).not.toContain('dbGuard.localOnly');
    expect(bare).not.toContain('permissionsCheck.enabled');
    // The share tip only in a repo known to be private: unknown and public get none.
    for (const visibility of [null, 'unknown', 'public'])
      expect(OI.tipsToGive({}, [], { visibility }).map((c: { key: string }) => c.key)).not.toContain('share.queueData');
    expect(OI.tipLine(OI.byKey('share.queueData'))).toMatch(/On: ravenseat share on --yes\. No: ravenseat checks dismiss share-backup$/);
    expect(OI.tipsToGive({}, ['secretScan.allowlist']).map((c: { key: string }) => c.key)).not.toContain('secretScan.allowlist');
    expect(OI.tipsToGive({ gitignoreCheck: { enabled: true } }, []).map((c: { key: string }) => c.key)).not.toContain('gitignoreCheck.enabled');
    expect(OI.tipLine(all[0])).toMatch(/^TIP: turn on .*settings set secretScan\.allowlist on\. No: ravenseat checks dismiss allowlist-scan$/);
  });

  it('doctor\'s off line names the setting, and says a gap is there without saying what', () => {
    const c = OI.byKey('gitignoreCheck.enabled');
    expect(OI.offLine(c)).toContain('settings set gitignoreCheck.enabled on');
    expect(OI.offLine(c)).not.toMatch(/found something/);
    expect(OI.offLine(c, { gap: true })).toMatch(/found something to look at/);
  });
});

describe('the cards on the Checks tab', () => {
  const report = (facts: object, dismissed: string[] = []) =>
    CATALOG.buildReport({ facts: { git: true, ...facts }, catalog: CATALOG.loadCatalog({ builtin: BUILTIN, own: path.join(BUILTIN, 'none') }), dismissed, now: 'x' });
  const card = (r: { suggestions: { key: string }[] }, key: string) => r.suggestions.find((s) => s.key === key);
  const OFF = { optInOff: OI.OPT_IN.map((c: { key: string }) => c.key) };

  it('a check that is off has a medium card; one that is on has none', () => {
    const r = report(OFF);
    for (const c of OI.OPT_IN.filter((x: { offer?: unknown }) => !x.offer))
      expect(card(r, c.suggestion), c.suggestion).toMatchObject({ priority: 'medium', action: 'setting', setting: c.key, state: 'open' });
    // The probe guard: medium, only with a database. Broad permissions: low, only with a tracked settings file.
    expect(card(r, 'db-shared-guard')).toBeUndefined();
    expect(card(report({ ...OFF, hasDatabase: true }), 'db-shared-guard')).toMatchObject({ priority: 'medium', category: 'database', setting: 'dbGuard.localOnly' });
    expect(card(r, 'broad-permissions')).toBeUndefined();
    expect(card(report({ ...OFF, sharedSettings: true }), 'broad-permissions')).toMatchObject({ priority: 'low', setting: 'permissionsCheck.enabled' });
    // share-backup: low (off is the safe side), and only in a repo known to be private.
    expect(card(r, 'share-backup')).toBeUndefined();
    expect(card(report({ ...OFF, repoPrivate: true }), 'share-backup')).toMatchObject({ priority: 'low', action: 'setting', setting: 'share.queueData', state: 'open' });
    expect(card(report({ optInOff: [] }), 'allowlist-scan')).toBeUndefined();
  });

  it('an important gap makes the card high, so the red marker counts it, until the card is set aside', () => {
    const before = report(OFF).important;
    let r = report({ ...OFF, allowlistTrackedHit: true, gitignoreGap: true });
    expect(card(r, 'allowlist-scan')).toMatchObject({ priority: 'high' });
    expect(card(r, 'gitignore-own-rules')).toMatchObject({ priority: 'high' });
    expect(card(r, 'secret-scan-receive')).toMatchObject({ priority: 'medium' });
    expect(r.important).toBe(before + 2);
    r = report({ ...OFF, allowlistTrackedHit: true, gitignoreGap: true }, ['allowlist-scan', 'gitignore-own-rules']);
    expect(card(r, 'allowlist-scan')).toMatchObject({ state: 'dismissed' });
    expect(r.important).toBe(before);
  });

  it('bypassPermissions in the tracked settings is the one important permissions gap', () => {
    const base = { ...OFF, sharedSettings: true };
    expect(card(report(base), 'broad-permissions')).toMatchObject({ priority: 'low' });
    const r = report({ ...base, bypassTracked: true });
    expect(card(r, 'broad-permissions')).toMatchObject({ priority: 'high' });
    expect(r.important).toBe(report(base).important + 1);
  });

  it('a setting card without its setting, or an unknown important_when, is a catalog error', () => {
    const t = CATALOG.parseTemplate('---\ntitle: T\ncategory: security\npriority: low\naction: setting\nimportant_when: nope\nwhy: w\n---\n', 'x');
    expect(t.errors.join(' ')).toMatch(/needs "setting: <key>"/);
    expect(t.errors.join(' ')).toMatch(/unknown condition "nope" in important_when/);
  });
});
