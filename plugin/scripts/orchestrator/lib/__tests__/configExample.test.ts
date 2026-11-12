// =============================================================
// configExample.test.ts: plugin/queue.config.example.json says the same as STANDARD in lib/queueConfig.js.
//
// Why: setup copies the example file into a new project as its queue.config.json, so a value in the example IS the
// project's value. The two had drifted (board.showCloud false and indexFile null in the example, true and
// docs/INDEX.md in STANDARD), so a set-up project ran on other defaults than the code and the docs describe. Every
// setting in the example must equal STANDARD, or be on EXAMPLE_VALUES below with the reason it differs on purpose.
// =============================================================
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const QC = require('../queueConfig.js') as any;
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

const EXAMPLE = path.resolve(__dirname, '..', '..', '..', '..', 'queue.config.example.json');
const example = JSON.parse(fs.readFileSync(EXAMPLE, 'utf8'));

/**
 * The deliberate example values: the key and why it differs from STANDARD. A key here is compared as a whole (its
 * subtree is not walked), and it must really differ, so a stale entry is caught too.
 */
const EXAMPLE_VALUES: Record<string, string> = {
  projectName: 'a sample name; setup and the owner replace it',
  'gates.quick': 'shows the form of a gate list; setup fills in the project\'s own checks',
  'gates.full': 'shows the form of a gate list; setup fills in the project\'s own checks',
  architectureRules: 'one sample rule to show the form',
  modules: 'the sample areas, worded for a new user',
  projectModuleSuggestion: 'one sample link to show the form',
  'loadGuard.minFreeMemoryPct': 'the default outside macOS (STANDARD is null on macOS, see queueConfig.js)',
  'loadGuard.allSlotsFreeMemoryPct': 'the default outside macOS (STANDARD is null on macOS, see queueConfig.js)',
};

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const ON_MAC = process.platform === 'darwin';
const NOT_MAC_DEFAULT: Record<string, unknown> = {
  'loadGuard.minFreeMemoryPct': 10,
  'loadGuard.allSlotsFreeMemoryPct': 40,
};

/** Every setting in the example (the `_` comment keys skipped) as [dotted key, example value, STANDARD value, known]. */
function settings(own: Record<string, unknown>, std: Record<string, unknown>, prefix = '') {
  const out: [string, unknown, unknown, boolean][] = [];
  for (const [k, v] of Object.entries(own)) {
    if (k.startsWith('_') || k.startsWith('$')) continue;
    const key = prefix ? `${prefix}.${k}` : k;
    const known = isObject(std) && k in std;
    if (known && !(key in EXAMPLE_VALUES) && isObject(v) && isObject(std[k])) {
      out.push(...settings(v, std[k] as Record<string, unknown>, key));
    } else out.push([key, v, known ? std[k] : undefined, known]);
  }
  return out;
}

describe('queue.config.example.json against STANDARD', () => {
  const rows = settings(example, QC.STANDARD);

  it('names only keys STANDARD knows', () => {
    expect(rows.filter(([, , , known]) => !known).map(([k]) => k)).toEqual([]);
  });

  it('every value equals STANDARD unless it is a deliberate example value', () => {
    const drift = rows
      .filter(([k, , , known]) => known && !(k in EXAMPLE_VALUES))
      .filter(([, mine, std]) => JSON.stringify(mine) !== JSON.stringify(std))
      .map(([k, mine, std]) => `${k}: example ${JSON.stringify(mine)}, STANDARD ${JSON.stringify(std)}`);
    expect(drift).toEqual([]);
  });

  it('board.showCloud and indexFile follow STANDARD (the drift found in the settings review)', () => {
    expect(example.board.showCloud).toBe(QC.STANDARD.board.showCloud);
    expect(example.indexFile).toBe(QC.STANDARD.indexFile);
  });

  it('each deliberate example value is in the example, really differs, and has a reason', () => {
    const byKey = new Map(rows.map(([k, mine, std]) => [k, { mine, std }]));
    for (const [key, why] of Object.entries(EXAMPLE_VALUES)) {
      expect(why.trim().length, key).toBeGreaterThan(0);
      const r = byKey.get(key);
      expect(r, `${key} in the example`).toBeTruthy();
      if (key in NOT_MAC_DEFAULT) {
        // A platform default: the example holds the value STANDARD has outside macOS.
        expect(r?.mine, key).toBe(NOT_MAC_DEFAULT[key]);
        if (!ON_MAC) expect(r?.std, key).toBe(NOT_MAC_DEFAULT[key]);
        continue;
      }
      expect(JSON.stringify(r?.mine), `${key} differs from STANDARD`).not.toBe(JSON.stringify(r?.std));
    }
  });
});
