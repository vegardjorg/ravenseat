// =============================================================
// checksKeyScan.test.ts: the Checks cards for the repo key scan (roadmap 6b, lib/checksCatalog.js,
// checks-catalog/suggestions/secret-scan-found.md and secret-scan-due.md). The facts come from the last
// `ravenseat secrets scan` (lib/repoSecretScan.js summary, cli/checks.mjs facts.keyScan), never a scan.
//
// Locks: (1) found shows only while a key is open, high (the red marker); (2) due shows before the first scan and when
// the last one is old, never next to found; (3) both are `action: ask` (a queue agent may not run `secrets`), and
// their detail is counts, never a finding.
// =============================================================
import { describe, expect, it } from 'vitest';
import path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const C = require('../checksCatalog.js');
const BUILTIN = path.resolve(__dirname, '..', '..', 'checks-catalog');
const catalog = C.loadCatalog({ builtin: BUILTIN, own: path.join(BUILTIN, 'does-not-exist') });

const base = { stacks: ['node'], kinds: [], ci: [], git: true };
const report = (facts: Record<string, unknown>) => C.buildReport({ facts: { ...base, ...facts }, catalog, now: 'x' });
const card = (key: string, facts: Record<string, unknown>) => report(facts).suggestions.find((s: { key: string; applies: boolean }) => s.key === key && s.applies);
const scanned = (over: Record<string, unknown> = {}) => ({ ageDays: 2, open: 0, tree: 0, historyOnly: 0, ignored: 0, due: false, history: { depth: 200, commits: 200 }, ...over });

describe('the key scan cards', () => {
  it('parse without errors, both as action ask', () => {
    expect(catalog.errors).toEqual([]);
    expect(catalog.templates.find((t: { key: string }) => t.key === 'secret-scan-found')).toMatchObject({ action: 'ask', priority: 'high' });
    expect(catalog.templates.find((t: { key: string }) => t.key === 'secret-scan-due')).toMatchObject({ action: 'ask', priority: 'low' });
  });

  it('found: only while a key is open, with the counts', () => {
    expect(card('secret-scan-found', {})).toBeUndefined();
    expect(card('secret-scan-found', { keyScan: scanned() })).toBeUndefined();
    const c = card('secret-scan-found', { keyScan: scanned({ open: 3, tree: 1, historyOnly: 2, ignored: 1 }) });
    expect(c).toBeDefined();
    expect(c.detail).toBe('Last key scan 2 days ago (tracked files and the last 200 commits): 1 open in tracked files, 2 only in the history, 1 set aside as false alarms.');
    expect(card('secret-scan-due', { keyScan: scanned({ open: 3, tree: 3, due: true }) })).toBeUndefined();
  });

  it('due: before the first scan and when the last one is old; not when fresh or with the reminder off', () => {
    expect(card('secret-scan-due', { keyScan: { never: true, due: true } }).detail).toBe('No key scan has run in this project yet.');
    expect(card('secret-scan-due', { keyScan: { never: true, due: false } })).toBeUndefined();
    expect(card('secret-scan-due', { keyScan: scanned({ due: true, ageDays: 30 }) })).toBeDefined();
    expect(card('secret-scan-due', { keyScan: scanned() })).toBeUndefined();
    expect(card('secret-scan-due', { git: false, keyScan: { never: true, due: true } })).toBeUndefined();
  });
});
