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

  it('the eleven categories, each with a title and at least one row', () => {
    expect(R.CATEGORIES).toHaveLength(11);
    for (const c of R.CATEGORIES) {
      expect(c.title, c.id).toMatch(/\S/);
      expect(ROWS.some((r) => r.category === c.id), c.id).toBe(true);
    }
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
    for (const r of ROWS.filter((x) => !x.weakens)) {
      expect([r.protects, r.whyNot, r.changes], r.key).toEqual([null, null, null]);
    }
  });

  it('no en or em dashes in any text', () => {
    for (const r of ROWS) {
      for (const t of [r.title, r.explanation, r.fullWhy, r.protects, r.whyNot, r.changes]) {
        expect(String(t ?? ''), r.key).not.toMatch(/[\u2013\u2014]/);
      }
    }
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
    ['gates.fromKnownBugs', 'auto'],
    ['gateEvidence.mode', 'external'],
    ['gateEvidence.mode', 'off'],
    ['usageLimit.pause', false],
    ['proposals.autoAccept.enabled', true],
    ['reviewers', { K: [], U: [], D: [], 'D+': ['reviewer'] }],
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

  it('the eleven categories, each its own table, in the registry order', () => {
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
