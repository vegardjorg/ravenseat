// =============================================================
// waitMode.test.ts: the wait mode's setup and texts (lib/waitMode.js), and that the instructions say how to use it.
//
// Locks: the default budget (280 s, under the 5 minute prompt cache), the cap (590 s), 0 and QUEUE_WAIT=off as off, the
// Bash timeout never over Claude Code's 600 s maximum, which commands use it, the setting in the registry (Advanced), and
// that the common track text and CLAUDE.queue.md tell agents to run these in the foreground and follow the RUNNING line.
// =============================================================
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const W = require('../waitMode.js');
const { STANDARD } = require('../queueConfig.js');
const REG = require('../settingsRegistry.js');
const PLUGIN = path.resolve(__dirname, '..', '..', '..', '..');

describe('wait mode setup', () => {
  it('blocks 280 s by default, at most 590 s; 0 and QUEUE_WAIT=off turn it off', () => {
    expect(STANDARD.wait.blockSec).toBe(280);
    expect(W.setupFrom({}, {}).blockSec).toBe(280);
    expect(W.setupFrom({ wait: { blockSec: 900 } }, {}).blockSec).toBe(590);
    expect(W.setupFrom({ wait: { blockSec: 0 } }, {}).blockSec).toBe(0);
    expect(W.setupFrom({ wait: { blockSec: 'x' } }, {}).blockSec).toBe(280);
    expect(W.setupFrom({}, { QUEUE_WAIT: 'off' }).blockSec).toBe(0);
    expect(W.setupFrom({}, { QUEUE_WAIT_BLOCK_SEC: '2' }).blockSec).toBe(2);
  });

  it('the Bash timeout covers the budget and never passes 600000 ms', () => {
    expect(W.bashTimeoutMs(280)).toBeGreaterThan(280_000);
    expect(W.bashTimeoutMs(280)).toBeLessThanOrEqual(300_000);
    expect(W.bashTimeoutMs(590)).toBe(600_000);
  });

  it('the hard cap is generous over the gate budgets, and the env overrides it', () => {
    expect(W.setupFrom({}, {}).hardSec).toBeGreaterThanOrEqual(2 * 900);
    expect(W.setupFrom({}, { QUEUE_WAIT_HARD_SEC: '5' }).hardSec).toBe(5);
  });

  it('only gates, receive and merge use it, never --health, --help or a terminal', () => {
    const on = { blockSec: 280 };
    expect(W.wanted({ command: 'gates', args: ['--quick'], isTTY: false, setup: on })).toBe(true);
    expect(W.wanted({ command: 'receive', args: ['X-1'], isTTY: false, setup: on })).toBe(true);
    expect(W.wanted({ command: 'merge', args: ['X-1'], isTTY: false, setup: on })).toBe(true);
    expect(W.wanted({ command: 'gates', args: ['--health'], isTTY: false, setup: on })).toBe(false);
    expect(W.wanted({ command: 'gates', args: ['--help'], isTTY: false, setup: on })).toBe(false);
    expect(W.wanted({ command: 'gates', args: ['--quick'], isTTY: true, setup: on })).toBe(false);
    expect(W.wanted({ command: 'gates', args: ['--quick'], isTTY: false, setup: { blockSec: 0 } })).toBe(false);
    expect(W.wanted({ command: 'show', args: [], isTTY: false, setup: on })).toBe(false);
    // --wait <id> is always the wait mode, also from a terminal.
    expect(W.wanted({ command: 'gates', args: ['--wait', 'gates-x'], isTTY: true, setup: { blockSec: 0 } })).toBe(true);
  });

  it('the RUNNING line names the next command and the Bash timeout', () => {
    const line = W.runningLine({ what: 'ravenseat gates --quick', id: 'gates-abc', startedAt: '2026-11-13T10:00:00.000Z', command: 'gates', cli: 'ravenseat', blockSec: 280 });
    expect(line).toMatch(/^RUNNING: ravenseat gates --quick \(run gates-abc\), started .*10:00:00.*\. Next: ravenseat gates --wait gates-abc \(Bash timeout \d+\)$/);
  });

  it('is an Advanced setting under gates', () => {
    const row = REG.rowFor('wait.blockSec');
    expect(row).toMatchObject({ level: 'advanced', category: 'gates', type: 'integer' });
  });
});

describe('the instructions say how to wait', () => {
  it('the common track text and CLAUDE.queue.md: foreground, the named Bash timeout, RUNNING, no run_in_background', () => {
    // The common track text gets it from the Claude addendum (the core template stays client-neutral).
    const template = require('../clients/claude/mission.js').missionAddendum().template.READING;
    const queue = fs.readFileSync(path.join(PLUGIN, 'CLAUDE.queue.md'), 'utf8');
    for (const text of [template, queue]) {
      expect(text).toMatch(/RUNNING/);
      expect(text).toMatch(/run_in_background/);
      expect(text).toMatch(/Bash timeout/);
    }
  });
});
