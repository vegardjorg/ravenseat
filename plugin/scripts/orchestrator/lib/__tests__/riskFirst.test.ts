// The riskiest assumption first (DR-2, lib/riskFirst.js): a task's optional `risk_first` puts a block in the mission
// that tells the track to test that assumption first and stop with PARTIAL and one owner question when it fails. A task
// in an accepted sensitive zone without a value gets a default text. Off (mission.riskFirst false): no block.
// The mission without the field (and without a zone) is byte-identical to before.
import { describe, expect, it } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const RF = require('../riskFirst.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const L = require('../queueLogic.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const D = require('../doneCheck.js');

const task = (extra = {}) => ({ id: 'R1', title: 'Swap the session store', class: 'D', owned_files: ['src/a.ts'], ...extra });
const zone = { id: 'D-0001', title: 'Sign-in', reason: 'hard to undo', why: 'files', detail: 'src/a.ts' };
const block = (o: object, rf: object | undefined) =>
  L.trackBlock(o, { tasks: [] }, { text: 'Do the thing.', catalog: [], ...(rf === undefined ? {} : { riskFirst: rf }) });

describe('riskFirst block in the mission', () => {
  it('a task with risk_first gets the block: test it first, PARTIAL and one owner question when it fails', () => {
    const t = block(task({ risk_first: 'the old sessions still validate after the swap' }), { on: true, zones: [] });
    expect(t).toContain(`**${RF.TITLE}:** the old sessions still validate after the swap`);
    expect(t).toMatch(/test it first/i);
    expect(t).toContain('PARTIAL');
    expect(t).toMatch(/one owner question/i);
    expect(t).toContain('RISK held');
    // Before the mission text, so the track reads it before it starts building.
    expect(t.indexOf(RF.TITLE)).toBeLessThan(t.indexOf('Do the thing.'));
  });

  it('without the field and without a zone the mission is byte-identical to the block without the setting', () => {
    const before = block(task(), { on: false, zones: [] });
    expect(block(task(), { on: true, zones: [] })).toBe(before);
    expect(before).not.toContain(RF.TITLE);
  });

  it('a zone task without a value gets the default text, naming the zone', () => {
    const t = block(task(), { on: true, zones: [zone] });
    expect(t).toContain(RF.ZONE_DEFAULT);
    expect(t).toContain('D-0001');
  });

  it('an own value beats the zone default', () => {
    const t = block(task({ risk_first: 'my own' }), { on: true, zones: [zone] });
    expect(t).toContain('my own');
    expect(t).not.toContain(RF.ZONE_DEFAULT);
  });

  it('mission.riskFirst off removes the block, value or zone', () => {
    expect(block(task({ risk_first: 'x y' }), { on: false, zones: [zone] })).not.toContain(RF.TITLE);
  });

  it('left out, the setting is read from the config (on by default) and the zones from disk (none here)', () => {
    const t = block(task({ risk_first: 'the swap is reversible' }), undefined);
    expect(t).toContain('the swap is reversible');
    expect(block(task(), undefined)).not.toContain(RF.TITLE);
  });
});

describe('risk_first as a field', () => {
  it('one line of text, at most the max; null or missing is fine', () => {
    expect(RF.riskFirstErrors({})).toEqual([]);
    expect(RF.riskFirstErrors({ risk_first: null })).toEqual([]);
    expect(RF.riskFirstErrors({ risk_first: 'fine' })).toEqual([]);
    expect(RF.riskFirstErrors({ risk_first: '' })[0]).toMatch(/risk_first/);
    expect(RF.riskFirstErrors({ risk_first: 3 })[0]).toMatch(/risk_first/);
    expect(RF.riskFirstErrors({ risk_first: 'a\nb' })[0]).toMatch(/one line/);
    expect(RF.riskFirstErrors({ risk_first: 'x'.repeat(RF.TEXT_MAX + 1) })[0]).toMatch(/at most/);
  });

  it('the queue validation checks it', () => {
    expect(D.doneWhenErrors({ risk_first: 'a\nb' }).join(' ')).toMatch(/risk_first/);
  });

  it('is locked after the start (only the owner changes it)', () => {
    expect(D.LOCKED_FIELDS).toContain('risk_first');
    const running = { status: 'running', started: '2026-11-21T00:00:00Z', risk_first: 'a' };
    expect(D.doneLockError(running, { risk_first: 'b' })).toMatch(/risk_first is locked/);
    expect(D.doneLockError(running, { risk_first: 'b' }, { by: 'owner' })).toBeNull();
    expect(D.doneLockError({ status: 'waiting', risk_first: 'a' }, { risk_first: 'b' })).toBeNull();
  });
});
