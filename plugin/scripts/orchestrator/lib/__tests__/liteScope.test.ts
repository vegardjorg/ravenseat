// =============================================================
// liteScope.test.ts: what lite mode really has, pinned against the code AND the docs that describe it.
//
// Why: the side-by-side table in plugin/docs/full-mode.md said "Plan register: No" and "Helper agents: No" for lite,
// while the code keeps features.plans on by default and runs reviewer-light on class K tasks when the project has no CI
// config or no gates (owner decision 2026-11-12: keep the behaviour, fix the docs). The facts are asserted where they are
// enforced (queueConfig.features, queueHelpers.reviewersForTask, queueTriage.triageSetup), and the doc rows are read
// and checked against those same facts, so a change on either side turns this red.
// =============================================================
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const QC = require('../queueConfig.js') as any;
const HELP = require('../queueHelpers.js') as any;
const TRI = require('../queueTriage.js') as any;
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

const DOCS = path.resolve(__dirname, '..', '..', '..', '..', 'docs');
const read = (name: string) => fs.readFileSync(path.join(DOCS, name), 'utf8').replace(/\r\n/g, '\n');

const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-scope-'));
afterAll(() => fs.rmSync(folder, { recursive: true, force: true }));
/** The config a fresh `ravenseat init` gives: only `"mode": "lite"` in queue.config.json. */
const lite = (() => {
  fs.writeFileSync(path.join(folder, 'queue.config.json'), JSON.stringify({ mode: 'lite' }));
  return QC.config({ root: folder });
})();
const kTask = { id: 'T-001', class: 'K', title: 'Fix the login bug' };
const reviewerTypes = (missingControls: string[]) =>
  HELP.reviewersForTask(kTask, { config: lite, missingControls }).map((r: { type: string }) => r.type);

/** The Lite cell of a row in the "Lite and full side by side" table of full-mode.md. */
function liteCell(label: string) {
  const row = read('full-mode.md')
    .split('\n')
    .find((l) => l.startsWith(`| ${label} |`));
  expect(row, `row "${label}" in full-mode.md`).toBeTruthy();
  return String(row).split('|')[2].trim();
}

describe('what lite has (the code)', () => {
  it('the plan register (the Plans room) is on by default', () => {
    expect(QC.features(lite).plans).toBe(true);
  });

  it('reviewer-light reviews a class K task when CI or gates are missing, and nothing reviews it otherwise', () => {
    expect(reviewerTypes(['no CI config'])).toEqual(['reviewer-light']);
    expect(reviewerTypes(['no gates'])).toEqual(['reviewer-light']);
    expect(reviewerTypes([])).toEqual([]);
  });

  it('there are no fixed reviewers for K and the intake triage is off', () => {
    expect(HELP.fixedFor(lite, 'K')).toEqual([]);
    expect(TRI.triageSetup(lite).on).toBe(false);
  });
});

describe('what the docs say lite has', () => {
  it('full-mode.md: the Plan register row says it is on by default in lite (features.plans)', () => {
    const cell = liteCell('Plan register');
    expect(QC.features(lite).plans).toBe(true);
    expect(cell).not.toBe('No');
    expect(cell).toMatch(/on by default/i);
    expect(cell).toContain('`features.plans`');
  });

  it('full-mode.md: the Helper agents row names reviewer-light for class K without CI or gates', () => {
    const cell = liteCell('Helper agents and deeper review');
    expect(cell).not.toBe('No');
    expect(cell).toContain('`reviewer-light`');
    expect(cell).toMatch(/class K/);
    expect(cell).toMatch(/CI/);
    expect(cell).toMatch(/gates/);
  });

  it('guide.md: "Lite mode in more detail" names the plan register switch and reviewer-light', () => {
    const text = read('guide.md');
    const start = text.indexOf('## Lite mode in more detail');
    expect(start).toBeGreaterThanOrEqual(0);
    const section = text.slice(start, text.indexOf('\n## ', start + 1));
    expect(section).toContain('`features.plans`');
    expect(section).toContain('`reviewer-light`');
    expect(section).toMatch(/class K/);
  });
});

describe('focus and value-based priority in lite (the full-mode.md row said No)', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const LM = require('../liteMode.js');
  it('the code: the Focus tab is on by default, a task gets value 5, and add --priority sets its value', () => {
    expect(QC.features(lite).focus).toBe(true);
    expect(LM.LITE_DEFAULTS.value).toBe(5);
    expect(LM.quickTask({ title: 'x', priority: 8 }).task.value).toBe(8);
    expect(LM.quickTask({ title: 'x', priority: 11 }).error.length).toBe(1);
  });
  it('the doc row says the same', () => {
    const cell = liteCell('Focus and value-based priority');
    expect(cell).not.toBe('No');
    expect(cell).toContain('`features.focus`');
    expect(cell).toMatch(/value 5/);
    expect(cell).toContain('`--priority 1-10`');
  });
});
