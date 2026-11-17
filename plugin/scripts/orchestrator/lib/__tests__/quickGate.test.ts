// =============================================================
// quickGate.test.ts: CI parity for a built gate guard (0i step 9b, plans/feillogg-til-gater-2026-11-15.md section 3.7
// point 4 and section 3.9), lib/quickGate.js.
//
// Locks: (1) the card's items: an active gate guard in the registry whose command is not in gates.quick, the command
// read from the registry (never from the board); (2) the command check: one plain line, not a deploy command, not a
// push; (3) the write can only ADD one command at the end of gates.quick: every other key and every command already
// there is kept in order, a command already there changes nothing, and a gates.quick that is not a list of commands is
// refused rather than replaced; (4) a gate guard with 0 runs after the set days gives one INFO line; (5) the item key the
// board sends is a guard id or nothing; (6) the kinds the guards' commands are, for lifting the CI cards.
// Plain strings only: no command here is ever run.
// =============================================================
import { describe, expect, it } from 'vitest';

/* eslint-disable @typescript-eslint/no-require-imports */
const QG = require('../quickGate.js');
const GR = require('../guardRegistry.js');
/* eslint-enable @typescript-eslint/no-require-imports */

const NOW = Date.parse('2026-11-17T12:00:00Z');
const registry = (guards: Record<string, unknown>[]) => ({ version: 1, guards });
const guard = (o: Record<string, unknown> = {}) => ({
  id: 'G-1',
  title: 'Lint for unchecked results',
  explain: 'Stops a result used without its error check.',
  kind: 'gate',
  against: { signature: null, lesson: null, class: 'unchecked-error', area: 'src/api' },
  command: 'npm run lint',
  task: 'GATE-1',
  built: '2026-11-01',
  status: 'active',
  measures: { runs: null, redRuns: null, caughtSince: null, lastRed: null },
  ...o,
});

describe('the items of the card "add to gates.quick"', () => {
  it('an active gate guard whose command is not in gates.quick, with the command from the registry', () => {
    const reg = registry([
      guard(),
      guard({ id: 'G-2', command: 'npm test' }),
      guard({ id: 'G-3', command: 'npm run types', status: 'retired' }),
      guard({ id: 'G-4', kind: 'instruction', command: 'npm run x' }),
      guard({ id: 'G-5', command: null }),
      guard({ id: 'G-6', command: 'npm run e2e' }),
    ]);
    const items = QG.items({ registry: reg, gates: { quick: ['npm test'], full: ['npm run e2e'] } });
    expect(items).toEqual([
      { guard: 'G-1', title: 'Lint for unchecked results', command: 'npm run lint', task: 'GATE-1', inFull: false },
      { guard: 'G-6', title: 'Lint for unchecked results', command: 'npm run e2e', task: 'GATE-1', inFull: true },
    ]);
    // A command already in gates.quick (also with other spacing at the ends) is no item.
    expect(QG.items({ registry: reg, gates: { quick: [' npm run lint ', 'npm test', 'npm run e2e'] } })).toEqual([]);
    expect(QG.items({ registry: null, gates: {} })).toEqual([]);
  });

  it('leaves out a guard whose command would be refused (it is never offered)', () => {
    const reg = registry([guard({ command: 'npm run deploy:prod' }), guard({ id: 'G-2', command: 'npm run lint\nnpm run other' })]);
    expect(QG.items({ registry: reg, gates: {}, deployCommands: ['npm run deploy'] })).toEqual([]);
  });
});

describe('the command check', () => {
  it('takes one plain line and refuses a deploy command, a push and anything that is not one line', () => {
    expect(QG.commandProblem('npm run lint')).toBe(null);
    expect(QG.commandProblem('npx vitest run src/api')).toBe(null);
    for (const bad of [null, '', '   ', 42, 'a\nb', 'a\rb', '-x', 'x'.repeat(201)]) expect(QG.commandProblem(bad), String(bad)).toBeTruthy();
    expect(QG.commandProblem('npm run deploy', { deployCommands: ['npm run deploy'] })).toMatch(/deploy/);
    expect(QG.commandProblem('FOO=1 npm run deploy -- --prod', { deployCommands: ['npm run deploy'] })).toMatch(/deploy/);
    expect(QG.commandProblem('git push origin main')).toMatch(/push/);
  });
});

describe('the write: only an addition, never a removal or a replacement', () => {
  const text = `${JSON.stringify({ baseBranch: 'main', gates: { quick: ['npm test'], full: ['npm run build'], timeoutSec: 600 }, mode: 'full' }, null, 2)}\n`;

  it('adds the command at the end of gates.quick and keeps everything else', () => {
    const r = QG.addToQuickText(text, 'npm run lint');
    expect(r.error).toBe(null);
    expect(r.changed).toBe(true);
    const obj = JSON.parse(r.text);
    expect(obj).toEqual({ baseBranch: 'main', gates: { quick: ['npm test', 'npm run lint'], full: ['npm run build'], timeoutSec: 600 }, mode: 'full' });
    expect(r.list).toEqual(['npm test', 'npm run lint']);
  });

  it('a command already there changes nothing', () => {
    const r = QG.addToQuickText(text, 'npm test');
    expect(r).toMatchObject({ error: null, changed: false, text });
  });

  it('no file, or no gates.quick yet: the list is the one command', () => {
    expect(JSON.parse(QG.addToQuickText(null, 'npm run lint').text)).toEqual({ gates: { quick: ['npm run lint'] } });
    expect(JSON.parse(QG.addToQuickText('{ "mode": "lite" }\n', 'npm run lint').text)).toEqual({ mode: 'lite', gates: { quick: ['npm run lint'] } });
  });

  it('refuses a gates.quick that is not a list of commands, a file that is not a JSON object, and a refused command', () => {
    expect(QG.addToQuickText('{ "gates": { "quick": "npm test" } }', 'npm run lint').error).toMatch(/list/);
    expect(QG.addToQuickText('{ "gates": { "quick": ["npm test", 3] } }', 'npm run lint').error).toMatch(/list/);
    expect(QG.addToQuickText('{ "gates": "x" }', 'npm run lint').error).toMatch(/gates/);
    expect(QG.addToQuickText('{ nope', 'npm run lint').error).toMatch(/JSON/);
    expect(QG.addToQuickText('[1]', 'npm run lint').error).toMatch(/object/);
    expect(QG.addToQuickText(text, 'a\nb').error).toBeTruthy();
  });

  it('isAddition holds only for the old list with one command at the end', () => {
    const before = ['npm test', 'npm run build'];
    expect(QG.isAddition(before, ['npm test', 'npm run build', 'npm run lint'], 'npm run lint')).toBe(true);
    expect(QG.isAddition(before, ['npm test', 'npm run lint'], 'npm run lint')).toBe(false); // one removed
    expect(QG.isAddition(before, ['npm run lint', 'npm run build', 'npm run lint'], 'npm run lint')).toBe(false); // one replaced
    expect(QG.isAddition(before, ['npm run build', 'npm test', 'npm run lint'], 'npm run lint')).toBe(false); // reordered
    expect(QG.isAddition(before, ['npm test', 'npm run build', 'npm run lint', 'npm run x'], 'npm run lint')).toBe(false); // two added
    expect(QG.isAddition(before, ['npm test', 'npm run build', 'npm run other'], 'npm run lint')).toBe(false); // another one
  });
});

describe('a gate guard that has not run (INFO)', () => {
  const run = (time: string, gates: string[]) => ({ time, event: 'gate', gates, failed: [] });

  it('0 runs since it was built, at least the set days ago: one INFO line per guard', () => {
    const reg = registry([
      guard(),
      guard({ id: 'G-2', command: 'npm test' }),
      guard({ id: 'G-3', command: 'npm run new', built: '2026-11-15' }),
      guard({ id: 'G-4', command: 'npm run old', status: 'retired' }),
      guard({ id: 'G-5', kind: 'none', command: null }),
    ]);
    const rows = [run('2026-11-10T10:00:00Z', ['npm test']), run('2026-10-01T10:00:00Z', ['npm run lint'])];
    const idle = QG.idle(reg, rows, { now: NOW, days: 7 });
    expect(idle).toEqual([{ id: 'G-1', title: 'Lint for unchecked results', command: 'npm run lint', built: '2026-11-01', days: 16 }]);
    expect(QG.idle(reg, rows, { now: NOW, days: 20 })).toEqual([]);
    const lines = QG.idleLines(idle, { cli: 'ravenseat', quick: [] });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^INFO: G-1 .*0 runs in 16 days/);
    expect(lines[0]).toContain('npm run lint');
    expect(lines[0]).toContain('ravenseat checks quick-add G-1');
    // Already in gates.quick: it says the gate has not run since, not to add it.
    expect(QG.idleLines(idle, { cli: 'ravenseat', quick: ['npm run lint'] })[0]).not.toContain('quick-add');
    expect(GR.measuresFor(reg.guards[0], rows).runs).toBe(0);
  });
});

describe('the board key and the kinds the guards use', () => {
  it('a guard id or nothing', () => {
    expect(QG.itemId('G-1')).toBe('G-1');
    expect(QG.itemId('G-123')).toBe('G-123');
    for (const bad of [null, 1, '', 'G-', 'g-1', 'G-1 ', 'G-1\n', '--json', 'G-1234567', 'INSP-1']) expect(QG.itemId(bad), String(bad)).toBe(null);
  });

  it('the kinds of check each active gate guard\'s command is (lib/checksScan.js classify), through a package.json script', () => {
    const reg = registry([guard(), guard({ id: 'G-2', command: 'npm run check' }), guard({ id: 'G-3', command: 'npx vitest run', status: 'retired' })]);
    expect(QG.guardKinds(reg, { scripts: { check: 'tsc --noEmit' } })).toEqual({ lint: ['G-1'], types: ['G-2'] });
  });
});
