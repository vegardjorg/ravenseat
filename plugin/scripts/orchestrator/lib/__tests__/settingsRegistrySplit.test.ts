// =============================================================
// settingsRegistrySplit.test.ts: the registry assembled from lib/settings/<area>.js is the registry from before the split.
//
// Why: lib/settingsRegistry.js held all rows in one 1890-line file that nearly every task added a row to, so it was the
// main merge-conflict spot (SPLIT-1). The rows now live in one file per settings area and settingsRegistry.js puts them
// back together. A pure move must not lose, duplicate, reorder or change a row. The snapshot
// (__snapshots__/settingsRegistrySplit.json) was taken from the file before the split: one short hash per row, in order.
//
// What it allows, so the snapshot is no new merge spot: a row added after the split (a key not in the snapshot) passes.
// What it does not allow: a snapshot row that is missing, out of order or different. When an existing row is changed on
// purpose, rewrite the snapshot: UPDATE_SETTINGS_SNAPSHOT=1 npx vitest run lib/__tests__/settingsRegistrySplit.test.ts
//
// A row is hashed with every field. A function (weakens) counts by its source text and by its answers on a small grid of
// values, so a rankWeakens with another order is caught although its source text is the same.
// =============================================================
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const R = require('../settingsRegistry.js') as any;
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

const SNAPSHOT = path.join(__dirname, '__snapshots__', 'settingsRegistrySplit.json');

/** The values a weakens function is asked about (as value and as standard), plus the row's own choices. */
const GRID: unknown[] = [true, false, null, 0, 1, 2, 5, 100, '', 'off', 'on', 'none', 'ask', 'owner', [], ['a']];

function answers(fn: (v: unknown, s: unknown) => boolean, choices: unknown[] | null): string {
  const values = [...GRID, ...(choices || [])];
  return values
    .map((v) =>
      values
        .map((s) => {
          try {
            return fn(v, s) ? '1' : '0';
          } catch {
            return 'x';
          }
        })
        .join(''),
    )
    .join('|');
}

/**
 * A function's source as compared: line endings normalized, and a relative require reduced to the module's name, since
 * the split moved the rows one folder down (require('./mergeGuard.js') became require('../mergeGuard.js')). A path that
 * no longer resolves still shows, in the answers.
 */
const source = (fn: unknown) =>
  String(fn)
    .replace(/\r\n/g, '\n')
    .replace(/require\('(?:\.\.?\/)+([^']+)'\)/g, "require('$1')");

/** Every field of a row as one string; functions by source and by their answers. */
function serialize(row: Record<string, unknown>): string {
  return JSON.stringify(row, (k, v) =>
    typeof v === 'function' ? `fn:${source(v)}#${answers(v, (row.choices as unknown[] | null) ?? null)}` : v,
  );
}

const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

type Snapshot = {
  exports: string[];
  labels: unknown;
  categories: unknown;
  internal: string[];
  queueOnly: string[];
  requires: Record<string, string[]>;
  rows: [string, string][];
};

function current(): Snapshot {
  return {
    exports: Object.keys(R).sort(),
    labels: R.LABELS,
    categories: R.CATEGORIES,
    internal: [...R.INTERNAL],
    queueOnly: [...R.QUEUE_ONLY],
    requires: R.REQUIRES,
    rows: R.SETTINGS.map((r: Record<string, unknown>) => [r.key as string, hash(serialize(r))]),
  };
}

if (process.env.UPDATE_SETTINGS_SNAPSHOT === '1') {
  // One line per row, so a diff of the snapshot names the rows that changed.
  const { rows, ...rest } = current();
  const head = JSON.stringify(rest, null, 1).replace(/\n}$/, '');
  fs.writeFileSync(SNAPSHOT, `${head},\n "rows": [\n${rows.map((r) => `  ${JSON.stringify(r)}`).join(',\n')}\n ]\n}\n`);
}

describe('SPLIT-1: the assembled registry equals the snapshot from before the split', () => {
  const snap: Snapshot = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
  const now = current();

  it('has the same exports (more are allowed), labels, categories, INTERNAL and QUEUE_ONLY', () => {
    for (const name of snap.exports) expect(now.exports, name).toContain(name);
    expect(now.labels).toEqual(snap.labels);
    expect(now.categories).toEqual(snap.categories);
    expect(now.internal).toEqual(snap.internal);
    expect(now.queueOnly).toEqual(snap.queueOnly);
  });

  it('keeps every REQUIRES entry of the snapshot unchanged', () => {
    for (const [key, needs] of Object.entries(snap.requires)) expect(now.requires[key], key).toEqual(needs);
  });

  it('has no key twice', () => {
    const keys = now.rows.map(([k]) => k);
    expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([]);
  });

  it('keeps every snapshot row, in the same order, with the same content', () => {
    const at = new Map(now.rows.map(([k, h], i) => [k, { h, i }]));
    const missing = snap.rows.filter(([k]) => !at.has(k)).map(([k]) => k);
    expect(missing, 'rows lost in the split').toEqual([]);
    const changed = snap.rows.filter(([k, h]) => at.get(k)!.h !== h).map(([k]) => k);
    expect(changed, 'rows whose content changed (rewrite the snapshot if on purpose, see the header)').toEqual([]);
    const order = snap.rows.map(([k]) => at.get(k)!.i);
    const outOfOrder = snap.rows.filter((_, j) => j > 0 && order[j] < order[j - 1]).map(([k]) => k);
    expect(outOfOrder, 'rows that moved before an earlier row').toEqual([]);
  });
});
