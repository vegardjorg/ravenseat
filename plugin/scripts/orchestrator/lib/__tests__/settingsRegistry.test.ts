// =============================================================
// settingsRegistry.test.ts: every setting has one row in lib/settingsRegistry.js, and every row is complete.
//
// Why: the settings lived in five places with explanations in three (code comments, the example file, queue.md), and
// those had drifted. The registry is the one list the board, the CLI, the docs and doctor will read (plans/
// innstillinger-vurdering-2026-11-12.md, tasks 3 to 7). This test is the coverage gate: a new key in STANDARD, a new
// limit, a new cloud setting, board switch or module without a row turns it red, and so does a row without an
// explanation, a full-only row without its reason, or a row that weakens a guard without the three warning texts.
// =============================================================
import { describe, it, expect } from 'vitest';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const QC = require('../queueConfig.js') as any;
const GU = require('../logic/guards.js') as any;
const BASE = require('../logic/base.js') as any;
const CS = require('../cloudSetup.js') as any;
const R = require('../settingsRegistry.js') as any;
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

type Row = {
  key: string;
  category: string;
  level: string;
  modes: string[];
  fullWhy: string | null;
  store: string;
  edit: string;
  type: string;
  title: string;
  explanation: string;
  defaultByMode: Record<string, unknown> | null;
  choices: unknown[] | null;
  weakens: ((v: unknown, std: unknown) => boolean) | null;
  protects: string | null;
  whyNot: string | null;
  changes: string | null;
};
const ROWS: Row[] = R.SETTINGS;
const INTERNAL: string[] = R.INTERNAL;

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The leaf keys of STANDARD: an object with keys is walked, anything else (lists, null, {}) is a leaf. */
function leaves(o: Record<string, unknown>, prefix = ''): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(o)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (isObject(v) && Object.keys(v).length) out.push(...leaves(v, key));
    else out.push(key);
  }
  return out;
}

/** A key is covered by a row with that key, or by an `object` row (or internal entry) above it. */
const coveredBy = (key: string, keys: { key: string; object: boolean }[]) =>
  keys.some((r) => r.key === key || (r.object && key.startsWith(`${r.key}.`)));
const ROW_KEYS = () => [
  ...ROWS.map((r) => ({ key: r.key, object: r.type === 'object' })),
  ...INTERNAL.map((key) => ({ key, object: true })),
];

/** The STANDARD value at a dotted key ("features.plans.legal" finds the key "plans.legal" under features). */
function at(o: unknown, key: string): unknown {
  if (!isObject(o)) return undefined;
  if (key in o) return o[key];
  const parts = key.split('.');
  for (let i = 1; i < parts.length; i++) {
    const head = parts.slice(0, i).join('.');
    if (head in o) return at(o[head], parts.slice(i).join('.'));
  }
  return undefined;
}

/** The default of a row: the mode-free STANDARD value, or the limit's default. */
function standardOf(r: Row): unknown {
  if (r.key.startsWith('limits.')) {
    const name = r.key.slice('limits.'.length);
    return name in BASE.DEFAULT_LIMITS ? BASE.DEFAULT_LIMITS[name] : undefined;
  }
  return at(QC.STANDARD, r.key);
}

describe('coverage: every setting has a row', () => {
  it('every leaf key in STANDARD', () => {
    const keys = ROW_KEYS();
    expect(leaves(QC.STANDARD).filter((k) => !coveredBy(k, keys))).toEqual([]);
  });

  it('every limit (LIMIT_NAME and LIMIT_EXTRA) as limits.<name>', () => {
    const keys = ROW_KEYS();
    const names = [...GU.LIMIT_NAME, ...GU.LIMIT_EXTRA].map((n: string) => `limits.${n}`);
    expect(names.filter((k: string) => !coveredBy(k, keys))).toEqual([]);
  });

  it('every cloud setting, board switch and module', () => {
    const keys = ROW_KEYS();
    const wanted = [
      ...CS.CLOUD_SETTINGS.map((s: { key: string }) => `cloud.${s.key}`),
      ...Object.keys(QC.BOARD_SWITCHES).map((k) => `board.${k}`),
      ...Object.keys(QC.FEATURES).map((k) => `features.${k}`),
    ];
    expect(wanted.filter((k) => !coveredBy(k, keys))).toEqual([]);
  });

  it('no row or internal entry points at a key that does not exist', () => {
    const limitKeys = new Set([...GU.LIMIT_NAME, ...GU.LIMIT_EXTRA].map((n: string) => `limits.${n}`));
    const queueOnly = new Set(R.QUEUE_ONLY);
    for (const r of ROWS) {
      if (r.key.startsWith('limits.')) expect(limitKeys.has(r.key), r.key).toBe(true);
      else if (queueOnly.has(r.key)) expect(r.store, r.key).toBe('queue');
      else expect(at(QC.STANDARD, r.key), r.key).not.toBe(undefined);
    }
    for (const k of INTERNAL) expect(at(QC.STANDARD, k), k).not.toBe(undefined);
  });

  it('each key has exactly one row, and none is both a row and internal', () => {
    const keys = ROWS.map((r) => r.key);
    expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([]);
    expect(INTERNAL.filter((k) => keys.includes(k))).toEqual([]);
  });
});

describe('every row is complete', () => {
  const CATEGORY_IDS = R.CATEGORIES.map((c: { id: string }) => c.id);

  it('the sixteen categories, each with a title and at least one row', () => {
    expect(R.CATEGORIES).toHaveLength(16);
    for (const c of R.CATEGORIES) {
      expect(c.title, c.id).toMatch(/\S/);
      expect(ROWS.some((r) => r.category === c.id), c.id).toBe(true);
    }
  });

  // The grouping review of 2026-11-17 (H2, L1, M7): "Gates and checks" held 55 rows and "Review and agents" 32, so the
  // owner split them. No key changed; only the group a row is shown in.
  it('the split groups: gates, tests and evidence, the Checks tab and learning, scope and catalog', () => {
    expect(R.CATEGORIES.map((c: { id: string }) => c.id)).toEqual([
      'project', 'limits', 'load', 'gates', 'tests', 'learning', 'files', 'guards', 'push', 'private', 'review', 'scope',
      'board', 'cloud', 'plans', 'history',
    ]);
    const title = (id: string) => R.CATEGORIES.find((c: { id: string }) => c.id === id).title;
    expect(title('gates')).toBe('Gates');
    expect(title('tests')).toBe('Tests and evidence');
    expect(title('learning')).toBe('Checks tab and learning');
    expect(title('scope')).toBe('Scope and catalog');
    expect(title('files')).toBe('File and read guards');
    expect(title('guards')).toBe('Command and secret guards');
    const cat = (k: string) => (ROWS.find((x) => x.key === k) as Row).category;
    for (const k of ['gates.redOnBase', 'gates.redOnBaseStrict', 'gates.fixWithoutTestWarning', 'testWeakening.enabled', 'qa.autoCommand'])
      expect(cat(k), k).toBe('tests');
    for (const k of ['checksPanel.mode', 'checksPanel.marker', 'gates.fromKnownBugs', 'inspection.mode', 'learning.proposals', 'learning.idleGuardDays'])
      expect(cat(k), k).toBe('learning');
    for (const k of ['scopeNotes.reuse', 'scopeNotes.driftWarn', 'catalog.doctor', 'catalog.planLinks', 'catalog.gateAfter'])
      expect(cat(k), k).toBe('scope');
    for (const k of ['gates.quick', 'baseGate.enabled', 'gateEvidence.mode', 'fixPlateau', 'wait.blockSec']) expect(cat(k), k).toBe('gates');
    for (const k of ['helpers', 'reviewers', 'triage.agentAdded', 'proposals.autoAccept.enabled']) expect(cat(k), k).toBe('review');
    for (const k of ['protectedPaths', 'gitSurface', 'controlFiles.guard', 'readGuard.blockLines', 'reads.mode', 'hotspots'])
      expect(cat(k), k).toBe('files');
    for (const k of ['secretScan.enabled', 'secretScan.atReceive', 'deployCommands', 'approvals.ask', 'agentGuard.enabled', 'agentPushBlock.enabled'])
      expect(cat(k), k).toBe('guards');
    // Every key of these families in its group: nothing left behind.
    for (const r of ROWS) {
      if (r.key.startsWith('learning.') || r.key.startsWith('inspection.')) expect(r.category, r.key).toBe('learning');
      if (r.key.startsWith('scopeNotes.') || r.key.startsWith('catalog.')) expect(r.category, r.key).toBe('scope');
      if (r.key.startsWith('testWeakening.') || r.key.startsWith('qa.')) expect(r.category, r.key).toBe('tests');
      if (r.key.startsWith('readGuard.') || r.key.startsWith('controlFiles.')) expect(r.category, r.key).toBe('files');
      if (r.key.startsWith('secretScan.') || r.key.startsWith('agentGuard.')) expect(r.category, r.key).toBe('guards');
    }
  });

  it('the split groups are not nearly all Advanced: each has a basic row, and none holds more than 25 rows', () => {
    // Agent guards (29 rows, all Advanced) was split too (owner decision 2026-11-18): File and read guards and Command
    // and secret guards, each with its main switch under Basic.
    for (const id of ['gates', 'tests', 'learning', 'review', 'scope', 'files', 'guards']) {
      const mine = ROWS.filter((r) => r.category === id);
      expect(mine.length, id).toBeLessThanOrEqual(25);
      expect(mine.some((r) => r.level === 'basic'), id).toBe(true);
    }
  });

  it('the three sources of guard proposals share one group and one note about the cap of three', () => {
    const learning = R.CATEGORIES.find((c: { id: string }) => c.id === 'learning');
    expect(learning.note).toMatch(/three/);
    for (const k of ['inspection.mode', 'gates.fromKnownBugs', 'learning.proposals']) expect(learning.note, k).toContain(k);
    for (const c of R.CATEGORIES) if (c.note != null) expect(typeof c.note, c.id).toBe('string');
  });

  it('the visible labels are in English', () => {
    expect(R.LABELS).toMatchObject({ advanced: 'Advanced', fullOnly: 'Full mode only' });
  });

  it('known values in each field, and a title and an explanation on every row', () => {
    for (const r of ROWS) {
      expect(CATEGORY_IDS, r.key).toContain(r.category);
      expect(['basic', 'advanced'], r.key).toContain(r.level);
      expect(r.modes.length, r.key).toBeGreaterThan(0);
      for (const m of r.modes) expect(['lite', 'full'], r.key).toContain(m);
      expect(['config', 'queue'], r.key).toContain(r.store);
      expect(['set', 'file', 'read'], r.key).toContain(r.edit);
      expect(['onoff', 'integer', 'number', 'text', 'choice', 'list', 'object'], r.key).toContain(r.type);
      expect(r.title, r.key).toMatch(/\S/);
      expect(r.explanation, r.key).toMatch(/\S{3}/);
      expect(r.explanation, r.key).toMatch(/[.)]$/);
    }
  });

  it('modes ["full"] has fullWhy, and only such rows have it', () => {
    for (const r of ROWS) {
      const fullOnly = r.modes.length === 1 && r.modes[0] === 'full';
      if (fullOnly) expect(r.fullWhy, r.key).toMatch(/\S{3}/);
      else expect(r.fullWhy, r.key).toBe(null);
    }
  });

  it('a choice row lists its choices, and the default is one of them', () => {
    for (const r of ROWS.filter((x) => x.type === 'choice')) {
      expect(Array.isArray(r.choices) && r.choices.length > 1, r.key).toBe(true);
      const std = standardOf(r);
      if (std !== undefined) expect(r.choices, r.key).toContain(std);
      for (const v of Object.values(r.defaultByMode ?? {})) expect(r.choices, r.key).toContain(v);
    }
  });

  it('a row that weakens has protects, whyNot and changes, and its own default never weakens', () => {
    for (const r of ROWS.filter((x) => x.weakens)) {
      expect(typeof r.weakens, r.key).toBe('function');
      expect(r.protects, r.key).toMatch(/\S{3}/);
      expect(r.whyNot, r.key).toMatch(/\S{3}/);
      expect(r.changes, r.key).toMatch(/\S{3}/);
      const std = standardOf(r);
      expect(r.weakens?.(std, std), `${r.key} at its default`).toBe(false);
      for (const v of Object.values(r.defaultByMode ?? {})) expect(r.weakens?.(v, v), `${r.key} ${v}`).toBe(false);
    }
    // A row without weakens has no dialog, so no whyNot or changes; it may still say what it protects against (M1).
    for (const r of ROWS.filter((x) => !x.weakens)) {
      expect([r.whyNot, r.changes], r.key).toEqual([null, null]);
    }
  });

  // M1 (plans/gjennomgang-friksjon-innstillinger-2026-11-17.md, bolk 5b): the board shows "Protects against: ..." under
  // a row and `ravenseat settings <key>` prints it, so the text must be one short sentence.
  it('protects is one short sentence, on every row that weakens and on the guards that do not, never on advice', () => {
    const withProtects = ROWS.filter((x) => x.protects != null);
    for (const r of withProtects) {
      const t = String(r.protects);
      expect(t.length, r.key).toBeLessThanOrEqual(140);
      expect(t, r.key).toMatch(/^[A-Z].*\.$/);
      expect(t.slice(0, -1), `${r.key}: one sentence`).not.toMatch(/[.!?]\s/);
      expect(t, r.key).not.toMatch(/[\u2013\u2014]/);
    }
    for (const r of ROWS.filter((x) => x.weakens)) expect(r.protects, r.key).toMatch(/\S{3}/);
    // Guards without a weakening value (a list or a number that stops, asks or checks) say it too.
    for (const k of ['gates.full', 'gates.quick', 'gates.redOnBase', 'readGuard.blockLines', 'deployCommands', 'migrations.allowedEnvironment'])
      expect(ROWS.find((x) => x.key === k)?.protects, k).toMatch(/\S{3}/);
    // More rows protect than weaken.
    expect(withProtects.length).toBeGreaterThan(ROWS.filter((x) => x.weakens).length);
  });

  it('no en or em dashes in any text', () => {
    for (const r of ROWS) {
      for (const t of [r.title, r.explanation, r.fullWhy, r.protects, r.whyNot, r.changes]) {
        expect(String(t ?? ''), r.key).not.toMatch(/[\u2013\u2014]/);
      }
    }
  });
});

// M3 (plans/gjennomgang-friksjon-innstillinger-2026-11-17.md, owner decision): some rows have an effect only while another
// one is on, and that was hidden. `requires` names the parents ("key" = it must be on, "key=value" = it must have that
// value). Data for the surfaces only: no default and no behavior changes with it.
describe('requires: a row that has an effect only while another one is on (M3)', () => {
  const byKey = new Map(ROWS.map((r) => [r.key, r]));
  /** "key" or "key=value" as { key, value } (value null: the parent must be on). */
  const parse = (entry: string) => {
    const i = entry.indexOf('=');
    return i < 0 ? { key: entry, value: null } : { key: entry.slice(0, i), value: entry.slice(i + 1) };
  };
  const reqOf = (r: Row | undefined): string[] | null => (r as unknown as { requires?: string[] | null })?.requires ?? null;
  const withRequires = () => ROWS.filter((r) => reqOf(r));

  it('is null or a non-empty frozen list on every row', () => {
    for (const r of ROWS) {
      const req = (r as unknown as { requires?: unknown }).requires;
      expect(req === null || Array.isArray(req), `${r.key}: requires is null or a list`).toBe(true);
      if (!Array.isArray(req)) continue;
      expect(req.length, r.key).toBeGreaterThan(0);
      expect(Object.isFrozen(req), r.key).toBe(true);
    }
  });

  it('every requires key is a row, never the row itself, and a value is one the parent can have', () => {
    for (const r of withRequires()) {
      for (const entry of reqOf(r) ?? []) {
        const { key, value } = parse(entry);
        const parent = byKey.get(key);
        expect(parent, `${r.key} requires ${key}, which is no row`).toBeTruthy();
        expect(key, r.key).not.toBe(r.key);
        if (!parent || value === null) continue;
        const options =
          parent.type === 'onoff'
            ? ['on', 'off']
            : (parent.choices ?? []).map((c) => (c === true ? 'on' : c === false ? 'off' : String(c)));
        expect(options, `${r.key} requires ${entry}`).toContain(value);
      }
    }
  });

  it('every entry of the REQUIRES table is a row, so a misspelled key cannot drop out unseen', () => {
    for (const key of Object.keys(R.REQUIRES)) expect(byKey.has(key), `REQUIRES ${key} is no row`).toBe(true);
    expect(withRequires().length).toBe(Object.keys(R.REQUIRES).length);
  });

  it('no cycles: following requires never comes back to the row', () => {
    const walk = (key: string, path: string[]): void => {
      expect(path, `a cycle: ${[...path, key].join(' -> ')}`).not.toContain(key);
      for (const e of reqOf(byKey.get(key)) ?? []) walk(parse(e).key, [...path, key]);
    };
    for (const r of withRequires()) walk(r.key, []);
  });

  it('a parent in another group, or one a mode of the row does not have, is named in the explanation', () => {
    for (const r of withRequires()) {
      for (const entry of reqOf(r) ?? []) {
        const parent = byKey.get(parse(entry).key);
        if (!parent) continue;
        const elsewhere = parent.category !== r.category || r.modes.some((m) => !parent.modes.includes(m));
        if (elsewhere) expect(r.explanation, `${r.key} needs ${parent.key} from ${parent.category}`).toContain(parent.key);
      }
    }
  });

  it('the dependencies of finding M3, read in the code, are data', () => {
    const req = (key: string) => reqOf(byKey.get(key));
    expect(req('gates.fixWithoutTestWarning')).toEqual(['gates.redOnBase']);
    expect(req('catalog.gateAfter')).toEqual(['learning.proposals', 'catalog.checks']);
    expect(req('catalog.checkStop')).toEqual(['catalog.checks']);
    expect(req('scopeNotes.driftGapFiles')).toEqual(['scopeNotes.driftGap']);
    expect(req('scopeNotes.driftGapShare')).toEqual(['scopeNotes.driftGap']);
    expect(req('push.ciWatchIntervalSec')).toEqual(['push.ciWatch=github']);
    expect(req('push.ciWatchTimeoutMin')).toEqual(['push.ciWatch=github']);
    expect(req('learning.dbProbes')).toEqual(['inspection.mode', 'learning.repeats']);
    expect(req('learning.recipeDamping')).toEqual(['inspection.mode', 'learning.repeats']);
    expect(req('learning.recipeMinProposals')).toEqual(['learning.recipeDamping']);
    expect(req('push.ownerAsk')).toEqual(['push.mode=owner']);
    expect(req('features.plans.legal')).toEqual(['features.plans']);
    // Read in the code and left out on purpose: the strict mode stops every fix without red on base (doctor warns),
    // the night window also splits the usage in Statistics, the catalog index reads ignoreNames, and
    // `ravenseat instructions` measures against the limits with the advice off. learning.proposals also feeds the
    // catalog rule gates, so it needs no learning.repeats.
    for (const k of ['gates.redOnBaseStrict', 'limits.nightWindow', 'scopeNotes.ignoreNames', 'instructionSize.maxLines', 'learning.proposals'])
      expect(req(k), k).toBeNull();
  });
});

describe('the weakening rows from the design', () => {
  /** [key, a weaker value] for every setting the design says weakens a guard when changed from its default. */
  const WEAKER: [string, unknown][] = [
    ['protectedPaths', []],
    ['gitSurface', 'warn'],
    ['gitSurface', 'off'],
    ['dependencyFiles', 'warn'],
    ['secretScan.enabled', false],
    ['testWeakening.enabled', false],
    ['testWeakening.focusStop', false],
    ['baseGate.enabled', false],
    ['push.mode', 'threshold'],
    ['push.controlsWarning', false],
    ['claudeFingerprint', false],
    ['controlFiles.guard', false],
    ['controlFiles.fingerprint', false],
    ['guardLog.enabled', false],
    ['approvals.ask', false],
    ['push.ownerAsk', false],
    ['gates.fromKnownBugs', 'auto'],
    ['gateEvidence.mode', 'external'],
    ['gateEvidence.mode', 'off'],
    ['usageLimit.pause', false],
    ['proposals.autoAccept.enabled', true],
    ['reviewers', { K: [], U: [], D: [], 'D+': ['reviewer'] }],
    ['ownership.sharedPatchCollides', false],
    ['mode', 'lite'],
    ['cloud.collect', 'auto'],
  ];

  it.each(WEAKER)('%s = %j weakens', (key, value) => {
    const r = ROWS.find((x) => x.key === key);
    expect(r, key).toBeTruthy();
    expect(r?.weakens?.(value, standardOf(r as Row)), key).toBe(true);
  });

  it('a stronger or equal value never weakens', () => {
    const row = (k: string) => ROWS.find((x) => x.key === k) as Row;
    expect(row('gitSurface').weakens?.('stop', 'warn')).toBe(false);
    const paths = QC.STANDARD.protectedPaths;
    expect(row('protectedPaths').weakens?.([...paths, 'extra/'], paths)).toBe(false);
    const more = { ...QC.STANDARD.reviewers, D: ['reviewer', 'reviewer-security'] };
    expect(row('reviewers').weakens?.(more, QC.STANDARD.reviewers)).toBe(false);
    expect(row('push.mode').weakens?.('owner', 'owner')).toBe(false);
  });

  it('B4: ownership.sharedPatchCollides is an advanced guard row, full mode only, with its reason', () => {
    const r = ROWS.find((x) => x.key === 'ownership.sharedPatchCollides') as Row;
    expect(r).toMatchObject({ category: 'files', level: 'advanced', modes: ['full'], type: 'onoff', edit: 'set', store: 'config' });
    expect(r.fullWhy).toMatch(/shared_patch/);
    expect(r.weakens?.(true, true)).toBe(false);
  });

  it('owner decision 2026-11-12: mode lite and cloud.collect auto weaken; the other choices do not', () => {
    const row = (k: string) => ROWS.find((x) => x.key === k) as Row;
    expect(row('mode').weakens?.('full', 'full')).toBe(false);
    expect(row('mode').weakens?.('lite', 'lite')).toBe(false);
    for (const v of ['off', 'ask']) expect(row('cloud.collect').weakens?.(v, 'ask'), v).toBe(false);
    expect(row('cloud.collect').weakens?.('auto', 'auto')).toBe(false);
  });

  it('owner decision 2026-11-17: the advisory rows are no weakening (a card, an order, an INFO line, a log row), guardLog keeps its mark', () => {
    const row = (k: string) => ROWS.find((x) => x.key === k) as Row;
    // None of these stops, asks or denies anything: off is less advice, not a weaker guard, so no slide, no banner row
    // and no doctor settings line.
    for (const k of ['learning.quickGateCard', 'learning.ciParityLift', 'learning.idleGuardInfo', 'testWeakening.findingLog']) {
      expect(row(k), k).toBeTruthy();
      expect(row(k).weakens, k).toBe(null);
      expect(row(k).protects, k).toBe(null);
    }
    // guardLog.enabled keeps it until the two weeks of measuring the overrides are over (owner decision 2026-11-17).
    expect(row('guardLog.enabled').weakens?.(false, true)).toBe(true);
    // The rows the Checks tab's "a guard did not hold" stands on keep it too.
    expect(row('learning.repeats').weakens?.(false, true)).toBe(true);
    expect(row('learning.guardFailedMarker').weakens?.(false, true)).toBe(true);
  });

  it('instructionSize.mode off is no weakening: the instruction size rows are advice, not a guard', () => {
    const row = (k: string) => ROWS.find((x) => x.key === k) as Row;
    for (const k of ['instructionSize.mode', 'instructionSize.maxLines', 'instructionSize.maxChars']) {
      expect(row(k), k).toBeTruthy();
      expect(row(k).weakens, k).toBe(null);
      // Owner decision 2026-11-12: all three under Advanced, in Board and advice.
      expect(row(k).level, k).toBe('advanced');
      expect(row(k).category, k).toBe('board');
    }
    expect(row('instructionSize.mode').choices).toEqual(['warn', 'off']);
    expect(QC.STANDARD.instructionSize).toEqual({ mode: 'warn', maxLines: 200, maxChars: 40000 });
  });

  it('owner decision 2026-11-12: guidance quiet and kickstart gates are no weakenings', () => {
    const row = (k: string) => ROWS.find((x) => x.key === k) as Row;
    expect(row('guidance').weakens).toBe(null);
    // kickstart gates writes gates.quick and gates.full; neither row weakens, and kickstart never asks for the flags.
    expect(row('gates.quick').weakens).toBe(null);
    expect(row('gates.full').weakens).toBe(null);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('node:path');
    expect(fs.readFileSync(path.resolve(__dirname, '..', '..', 'cli', 'kickstart.mjs'), 'utf8')).not.toContain('guardWeakening');
  });

  it('lite softens gitSurface and dependencyFiles by default (defaultByMode follows config())', () => {
    for (const key of ['gitSurface', 'dependencyFiles']) {
      expect(ROWS.find((x) => x.key === key)?.defaultByMode, key).toEqual({ lite: 'warn', full: 'stop' });
    }
  });
});

describe('lite scope in the registry follows what lite really has (finding 5)', () => {
  it('features.plans and reviewer-light work in lite; maxDPlus and maxPerDomain are full mode only', () => {
    const row = (k: string) => ROWS.find((x) => x.key === k) as Row;
    expect(row('features.plans').modes).toEqual(['lite', 'full']);
    expect(row('helpers').modes).toEqual(['lite', 'full']);
    expect(row('limits.maxDPlus').modes).toEqual(['full']);
    expect(row('limits.maxPerDomain').modes).toEqual(['full']);
  });
});

describe('the config table in queue.md follows the registry (step 11)', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path');
  const docs = path.resolve(__dirname, '..', '..', '..', '..', 'docs');
  const queueMd = fs.readFileSync(path.join(docs, 'queue.md'), 'utf8').replace(/\r\n/g, '\n');
  const section = queueMd.slice(queueMd.indexOf('\n## Configuration\n'));
  // One `### <category title>` table per registry category, in the registry's order.
  const parts = section.split('\n### ').slice(1).map((p: string) => ({ title: p.split('\n')[0].trim(), body: p }));
  const tableRows = (body: string) =>
    body
      .split('\n')
      .filter((l: string) => l.startsWith('| `'))
      .map((l: string) => {
        const cells = l.split(/(?<!\\)\|/).slice(1, -1).map((c: string) => c.trim());
        return { keys: [...cells[0].matchAll(/`([^`]+)`/g)].map((m) => m[1]), marks: cells[cells.length - 1] };
      });

  it('the sixteen categories, each its own table, in the registry order', () => {
    expect(parts.map((p: { title: string }) => p.title)).toEqual(R.CATEGORIES.map((c: { title: string }) => c.title));
  });

  it('every registry key is in the table of its category, once, with its marks: Advanced, Full mode only, queue.json', () => {
    const seen = new Map<string, number>();
    R.CATEGORIES.forEach((c: { id: string }, i: number) => {
      for (const row of tableRows(parts[i]?.body ?? '')) {
        for (const key of row.keys) {
          const r = ROWS.find((x) => x.key === key);
          expect(r, `${key} in the ${c.id} table is no registry key`).toBeTruthy();
          if (!r) continue;
          expect(r.category, key).toBe(c.id);
          seen.set(key, (seen.get(key) ?? 0) + 1);
          expect(row.marks.includes('Advanced'), `${key}: Advanced`).toBe(r.level === 'advanced');
          expect(row.marks.includes('Full mode only'), `${key}: Full mode only`).toBe(r.modes.length === 1 && r.modes[0] === 'full');
          expect(row.marks.includes('queue.json'), `${key}: queue.json`).toBe(r.store === 'queue');
        }
      }
    });
    for (const r of ROWS) expect(seen.get(r.key), `${r.key} in the table`).toBe(1);
  });

  it('guide.md and full-mode.md link the table', () => {
    for (const f of ['guide.md', 'full-mode.md'])
      expect(fs.readFileSync(path.join(docs, f), 'utf8'), f).toMatch(/\]\(queue\.md#configuration\)/);
  });
});
