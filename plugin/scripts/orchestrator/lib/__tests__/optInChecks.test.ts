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
    for (const c of OI.OPT_IN) {
      expect(OI.valueAt(KK.STANDARD, c.key), c.key).toBe(false);
      expect(OI.isOn(KK.STANDARD, c.key)).toBe(false);
      expect(R.rowFor(c.key)?.type, c.key).toBe('onoff');
      const file = path.join(BUILTIN, 'suggestions', `${c.suggestion}.md`);
      const t = CATALOG.parseTemplate(fs.readFileSync(file, 'utf8'), c.suggestion);
      expect(t.errors).toEqual([]);
      expect(t).toMatchObject({ action: 'setting', setting: c.key, category: 'security', when: `off:${c.key}` });
    }
  });

  it('a check is on only when its setting is exactly true', () => {
    expect(OI.isOn({ secretScan: { atReceive: true } }, 'secretScan.atReceive')).toBe(true);
    for (const v of [false, 'true', 1, null, undefined]) expect(OI.isOn({ secretScan: { atReceive: v } }, 'secretScan.atReceive')).toBe(false);
    expect(OI.isOn({}, 'gitignoreCheck.enabled')).toBe(false);
  });

  it('setup tips about each check that is off, once: the ones already asked are not tipped again', () => {
    const all = OI.tipsToGive({}, []);
    expect(all.map((c: { key: string }) => c.key)).toEqual(OI.OPT_IN.map((c: { key: string }) => c.key));
    expect(OI.tipsToGive({}, ['secretScan.allowlist']).map((c: { key: string }) => c.key)).not.toContain('secretScan.allowlist');
    expect(OI.tipsToGive({ gitignoreCheck: { enabled: true } }, []).map((c: { key: string }) => c.key)).not.toContain('gitignoreCheck.enabled');
    expect(OI.tipLine(all[0])).toMatch(/^TIP: turn on .*settings set secretScan\.allowlist on$/);
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
    for (const c of OI.OPT_IN) expect(card(r, c.suggestion), c.suggestion).toMatchObject({ priority: 'medium', action: 'setting', setting: c.key, state: 'open' });
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

  it('a setting card without its setting, or an unknown important_when, is a catalog error', () => {
    const t = CATALOG.parseTemplate('---\ntitle: T\ncategory: security\npriority: low\naction: setting\nimportant_when: nope\nwhy: w\n---\n', 'x');
    expect(t.errors.join(' ')).toMatch(/needs "setting: <key>"/);
    expect(t.errors.join(' ')).toMatch(/unknown condition "nope" in important_when/);
  });
});
