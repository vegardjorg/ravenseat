// =============================================================
// knownBugGate.test.ts: the rules for when a known bug becomes a gate task. The real commands are in
// __tests__/gateFlow.test.ts.
// =============================================================
import { describe, expect, it } from 'vitest';

/* eslint-disable-next-line @typescript-eslint/no-require-imports */
const G = require('../knownBugGate.js');

const gate = (id: string, title: string, status: string) => ({ id, title, status, labels: ['gate'] });

describe('parseGateLine', () => {
  it('reads the line, also as a list item or in backticks', () => {
    expect(G.parseGateLine('Done.\nGATE a fetch result used without its error\nMore')).toBe('a fetch result used without its error');
    expect(G.parseGateLine('- `GATE: unescaped value`')).toBe('unescaped value');
  });
  it('a heading, prose and "none" are not a line', () => {
    expect(G.parseGateLine('Gate: a heading\nThe gate passed')).toBeNull();
    expect(G.parseGateLine('GATE none')).toBeNull();
    expect(G.parseGateLine(null)).toBeNull();
  });
  it('cuts a long class to one short line', () => {
    expect(G.parseGateLine(`GATE ${'x'.repeat(300)}`).length).toBe(100);
  });
});

describe('modeOf', () => {
  it('proposes unless the setting says otherwise, also for a value it does not know', () => {
    expect(G.modeOf({})).toBe('propose');
    expect(G.modeOf({ gates: { fromKnownBugs: 'auto' } })).toBe('auto');
    expect(G.modeOf({ gates: { fromKnownBugs: 'yes please' } })).toBe('propose');
  });
});

describe('decide', () => {
  const title = 'A missing check';
  it('off does nothing', () => {
    expect(G.decide({ title, mode: 'off' }).action).toBe('off');
  });
  it('a new class is added', () => {
    expect(G.decide({ title }).action).toBe('add');
  });
  it('the same class is matched across case and punctuation', () => {
    const tasks = [gate('GATE-1', 'Gate: a missing check.', 'proposed')];
    expect(G.decide({ title, tasks })).toMatchObject({ action: 'extend', task: { id: 'GATE-1' } });
  });
  it('a done class exists, and a cancelled class stays declined', () => {
    expect(G.decide({ title, tasks: [gate('GATE-1', `Gate: ${title}`, 'done')] }).action).toBe('exists');
    expect(G.decide({ title, tasks: [gate('GATE-1', `Gate: ${title}`, 'cancelled')] }).action).toBe('declined');
  });
  it('an open task wins over an old cancelled one of the same class', () => {
    const tasks = [gate('GATE-1', `Gate: ${title}`, 'cancelled'), gate('GATE-2', `Gate: ${title}`, 'waiting')];
    expect(G.decide({ title, tasks }).action).toBe('extend');
  });
  it('stops at the cap, and closed tasks do not count toward it', () => {
    const open = ['a', 'b', 'c'].map((x, i) => gate(`GATE-${i}`, `Gate: ${x}`, 'proposed'));
    expect(G.decide({ title, tasks: open }).action).toBe('full');
    expect(G.decide({ title, tasks: open.map((o) => ({ ...o, status: 'done' })) }).action).toBe('add');
  });
  it('a task without the gate label is not counted, even with the same title', () => {
    expect(G.decide({ title, tasks: [{ id: 'X', title: `Gate: ${title}`, status: 'waiting' }] }).action).toBe('add');
  });
});

describe('the task', () => {
  it('takes the next free id', () => {
    expect(G.nextId([])).toBe('GATE-1');
    expect(G.nextId([{ id: 'GATE-4' }, { id: 'T-9' }])).toBe('GATE-5');
  });
  it('is an agent proposal, red first, naming where the bug was seen', () => {
    const t = G.gateTask({ id: 'GATE-1', title: 'x', from: 'T-1', where: 'a.js:3' });
    expect(t.added_by).toContain('agent');
    expect(t.labels).toEqual(['gate']);
    expect(t.acceptance[0]).toContain('fails on the original bug');
    expect(t.mission).toContain('task T-1: a.js:3');
    expect(t.mission).toContain('Never push');
  });
  it('a new place extends the mission once', () => {
    const mission = G.extendedMission({ mission: 'M' }, { from: 'T-2' });
    expect(mission).toContain('Also seen in: task T-2');
    expect(G.extendedMission({ mission }, { from: 'T-2' })).toBeNull();
    expect(G.extendedMission({ mission: 'M' }, {})).toBeNull();
  });
});
