// =============================================================
// liteSofterDefaults.test.ts: wiring.stop, scopeNotes.drift and features.focus are off in lite and on in full.
//
// Why: lite is for a first try. A lite task names no files, so the drift count only says "outside the task" about
// every file; lite has no focus stages, so the Focus tab is empty there; and the wiring stop follows reviewItems.stop,
// which is already off in lite. Same pattern as reviewItems.stop: the registry row carries defaultByMode, and
// queueConfig.resolveOwn sets the lite value unless queue.config.json sets the key. The facts are asserted where they
// are enforced (queueConfig.config, wiringItems.stopOn, scopeNotes.setupOf), on a real queue.config.json in a temp
// folder, and a value the owner wrote is never overwritten, also not by switching mode (liteMode.writeMode).
// =============================================================
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const QC = require('../queueConfig.js') as any;
const W = require('../wiringItems.js') as any;
const SN = require('../scopeNotes.js') as any;
const LM = require('../liteMode.js') as any;
const REG = require('../settingsRegistry.js') as any;
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

const folders: string[] = [];
afterAll(() => folders.forEach((f) => fs.rmSync(f, { recursive: true, force: true })));
/** A project folder with this queue.config.json. */
function project(own: object) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-softer-'));
  folders.push(root);
  fs.writeFileSync(path.join(root, 'queue.config.json'), JSON.stringify(own));
  return root;
}
/** The three values as the queue acts on them. */
function facts(root: string) {
  const k = QC.config({ root });
  return { wiringStop: W.stopOn(k), drift: SN.setupOf(k).drift, focus: QC.features(k).focus };
}

describe('the three lite defaults, read from queue.config.json', () => {
  it('lite: all three are off', () => {
    expect(facts(project({ mode: 'lite' }))).toEqual({ wiringStop: false, drift: false, focus: false });
  });

  it('full (and no mode at all): all three are on, as before', () => {
    expect(facts(project({ mode: 'full' }))).toEqual({ wiringStop: true, drift: true, focus: true });
    expect(facts(project({}))).toEqual({ wiringStop: true, drift: true, focus: true });
  });

  it('a value the owner set wins in lite, true as well as false', () => {
    const own = { mode: 'lite', wiring: { stop: true }, scopeNotes: { drift: true }, features: { focus: true } };
    expect(facts(project(own))).toEqual({ wiringStop: true, drift: true, focus: true });
  });

  it('a value the owner set wins in full too', () => {
    const own = { mode: 'full', wiring: { stop: false }, scopeNotes: { drift: false }, features: { focus: false } };
    expect(facts(project(own))).toEqual({ wiringStop: false, drift: false, focus: false });
  });

  it('a sibling key set by the owner keeps the lite default for the one left out', () => {
    const k = QC.config({ root: project({ mode: 'lite', scopeNotes: { reuse: false }, features: { cloud: false } }) });
    expect(SN.setupOf(k)).toMatchObject({ reuse: false, drift: false, newFolders: true });
    expect(QC.features(k)).toMatchObject({ cloud: false, focus: false });
  });
});

describe('switching mode with ravenseat mode', () => {
  it('lite to full turns all three on, and back to lite turns them off again', () => {
    const root = project({ mode: 'lite' });
    const file = path.join(root, 'queue.config.json');
    expect(facts(root)).toEqual({ wiringStop: false, drift: false, focus: false });
    LM.writeMode(file, 'full');
    expect(facts(root)).toEqual({ wiringStop: true, drift: true, focus: true });
    LM.writeMode(file, 'lite');
    expect(facts(root)).toEqual({ wiringStop: false, drift: false, focus: false });
  });

  it('never overwrites a value the owner wrote: it stays in the file and wins in both modes', () => {
    const own = { mode: 'lite', wiring: { stop: true }, scopeNotes: { drift: false }, features: { focus: true } };
    const root = project(own);
    const file = path.join(root, 'queue.config.json');
    const want = { wiringStop: true, drift: false, focus: true };
    expect(facts(root)).toEqual(want);
    LM.writeMode(file, 'full');
    expect(facts(root)).toEqual(want);
    LM.writeMode(file, 'lite');
    expect(facts(root)).toEqual(want);
    const back = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(back).toMatchObject({ wiring: { stop: true }, scopeNotes: { drift: false }, features: { focus: true } });
  });
});

describe('the registry rows say the same', () => {
  const byKey = (k: string) => REG.SETTINGS.find((r: any) => r.key === k);
  it.each(['wiring.stop', 'scopeNotes.drift', 'features.focus'])('%s: defaultByMode lite false, full true', (key) => {
    const r = byKey(key);
    expect(r.defaultByMode).toEqual({ lite: false, full: true });
    expect(r.explanation).toMatch(/lite/i);
  });
  it('reviewItems.stop keeps the same pattern', () => {
    expect(byKey('reviewItems.stop').defaultByMode).toEqual({ lite: false, full: true });
  });
});
