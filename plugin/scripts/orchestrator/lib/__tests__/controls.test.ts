// =============================================================
// controls.test.ts: what lib/controls.js answers, and that a missing control turns on the light review.
// The real flow (hook, receive, merge) is in __tests__/controlsFlow.test.ts.
// =============================================================
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* eslint-disable @typescript-eslint/no-require-imports */
const C = require('../controls.js');
const H = require('../queueHelpers.js');
const KK = require('../queueConfig.js');
const L = require('../queueLogic.js');
/* eslint-enable @typescript-eslint/no-require-imports */

const conf = (own: object = {}) => KK.merge(KK.STANDARD, own);
const made: string[] = [];
const emptyFolder = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-controls-'));
  made.push(d);
  return d;
};
afterAll(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});

describe('what is missing', () => {
  it('names both when there is neither CI nor gates', () => {
    expect(C.missing(conf(), emptyFolder())).toEqual(['no CI config', 'no gates']);
  });
  it('a gate in either list counts, a blank command does not', () => {
    expect(C.hasGates({ gates: { quick: ['npm test'], full: [] } })).toBe(true);
    expect(C.hasGates({ gates: { quick: [], full: ['npm test'] } })).toBe(true);
    expect(C.hasGates({ gates: { quick: ['  '], full: [] } })).toBe(false);
  });
  it('a workflow folder counts only with a yml file in it', () => {
    const root = emptyFolder();
    fs.mkdirSync(path.join(root, '.github', 'workflows'), { recursive: true });
    expect(C.ciHosts(root)).toEqual([]);
    fs.writeFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'on: push\n');
    expect(C.ciHosts(root)).toEqual(['GitHub Actions']);
    expect(C.missing(conf({ gates: { quick: ['npm test'] } }), root)).toEqual([]);
  });
});

describe('the push question', () => {
  it('says what is missing, how many commits, where to fix it and how to turn it off', () => {
    const q = C.question({ missing: ['no CI config', 'no gates'], commits: 12 });
    expect(q).toContain('12 commit(s) with no CI config and no gates');
    expect(q).toContain('/ravenseat:kickstart');
    expect(q).toContain('controlsWarning');
  });
  it('is silent with nothing missing or nothing to push', () => {
    expect(C.question({ missing: [], commits: 12 })).toBeNull();
    expect(C.question({ missing: ['no gates'], commits: 0 })).toBeNull();
  });
});

describe('verification', () => {
  it('a passed check is verified, and a review on top never lowers it', () => {
    expect(C.verification({ quickGates: true, doneCommand: false, reviewed: false }).status).toBe('verified');
    expect(C.verification({ quickGates: false, doneCommand: true, reviewed: true })).toEqual({
      status: 'verified',
      checks: ['done command', 'agent review'],
    });
  });
  it('a review alone is audited, never verified', () => {
    expect(C.verification({ quickGates: false, doneCommand: false, reviewed: true })).toEqual({
      status: 'audited',
      checks: ['agent review'],
    });
  });
  it('nothing is unverified, and the line says so', () => {
    const v = C.verification({ quickGates: false, doneCommand: false, reviewed: false });
    expect(v.status).toBe('unverified');
    expect(C.verificationLine(v)).toContain('MERGED, NOT VERIFIED');
  });
});

describe('the light review as a helper', () => {
  const types = (o: object, x: object = {}, own: object = {}) =>
    H.reviewersForTask(o, { config: conf(own), ...x }).map((r: { type: string }) => r.type);

  it('runs on class K only when a control is missing', () => {
    expect(types({ class: 'K' })).toEqual([]);
    expect(types({ class: 'K' }, { missingControls: ['no gates'] })).toEqual(['reviewer-light']);
  });
  it('says why it runs', () => {
    const [r] = H.reviewersForTask({ class: 'K' }, { config: conf(), missingControls: ['no CI config', 'no gates'] });
    expect(r.reasons).toEqual(['no CI config, no gates']);
  });
  it('does not run on classes with reviewers of their own, or on an investigation', () => {
    expect(types({ class: 'D' }, { missingControls: ['no gates'] })).toEqual(['reviewer']);
    expect(types({ class: 'U' }, { missingControls: ['no gates'] })).toEqual(['reviewer-challenger']);
  });
  it('the switch turns it off, from the queue and from the config', () => {
    const queue = { helpers: { 'reviewer-light': { enabled: false } } };
    expect(types({ class: 'K' }, { missingControls: ['no gates'], queue })).toEqual([]);
    expect(types({ class: 'K' }, { missingControls: ['no gates'] }, { helpers: { 'reviewer-light': { enabled: false } } })).toEqual([]);
  });
  it('asks for a shorter review than the full reviewers', () => {
    const prompt = (type: string) => L.reviewerPrompt({ o: { id: 'A', class: 'K' }, type, folder: '/x' });
    expect(prompt('reviewer-light')).toContain('approx. 15 turns');
    expect(prompt('reviewer')).toContain('approx. 40 turns');
  });
});
