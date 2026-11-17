// =============================================================
// guardLog.test.ts: the guards' own decisions in the time log (lib/guardLog.js), counted per track, and the config
// weakened outside the CLI.
//
// Why: an override or a denial that leaves no row cannot be measured, and the owner's next decision (whether to build
// approval with presence, plans/ekstern-saas-vurdering-2026-11-15.md bolk 10) waits on that number. A row names the
// guard, the rule, the agent type and the task, never the command or a file's content.
// =============================================================
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const GL = require('../guardLog.js') as any;
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

const NOW = new Date('2026-11-17T10:00:00Z');

describe('a guard row', () => {
  it('has the guard, the rule, the decision, the agent type and the task, and nothing of the command', () => {
    const r = GL.row({ guard: 'push', rule: 'network-call', decision: 'deny', agentType: 'ravenseat:track', agentId: 'a1', task: 'A', now: NOW });
    expect(r).toEqual({
      time: NOW.toISOString(),
      wave: 'guard',
      track: 'A',
      event: 'guard-deny',
      guard: 'push',
      rule: 'network-call',
      agent_type: 'track',
      agent_id: 'a1',
    });
  });

  it('the main session is "main" with no task; an unknown rule reads as "other"', () => {
    const r = GL.row({ guard: 'push', rule: '', decision: 'ask', agentType: null, now: NOW });
    expect(r).toMatchObject({ event: 'guard-ask', agent_type: 'main', track: null, rule: 'other' });
    expect(r).not.toHaveProperty('agent_id');
  });

  it('a rule or guard name is cut to a plain word, so no command text can ride along', () => {
    const r = GL.row({ guard: 'write', rule: 'curl https://x.example/?k=secret', decision: 'deny', agentType: 'track', now: NOW });
    expect(JSON.stringify(r)).not.toContain('secret');
    expect(r.rule).toMatch(/^[a-z0-9-]+$/);
  });

  it('record appends one line to the log, and does nothing while guardLog.enabled is false', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gl-'));
    const log = path.join(dir, 'times.jsonl');
    GL.record({ guard: 'read', rule: 'private-path', decision: 'deny', agentType: 'track', task: 'A', now: NOW }, { log, cfg: {} });
    GL.record({ guard: 'read', rule: 'private-path', decision: 'deny', agentType: 'track', task: 'A', now: NOW }, { log, cfg: { guardLog: { enabled: false } } });
    const rows = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event: 'guard-deny', guard: 'read', rule: 'private-path', track: 'A' });
  });
});

describe('the counts per track', () => {
  const rows = [
    { time: '2026-11-17T09:00:00Z', event: 'guard-deny', guard: 'push', rule: 'network-call', track: 'A' },
    { time: '2026-11-17T09:01:00Z', event: 'guard-deny', guard: 'write', rule: 'control-file', track: 'A' },
    { time: '2026-11-17T09:02:00Z', event: 'guard-ask', guard: 'push', rule: 'push-batch', track: null },
    { time: '2026-11-17T09:03:00Z', event: 'guard-deny', guard: 'read', rule: 'auto-loaded', track: 'B' },
    { time: '2026-11-17T09:04:00Z', event: 'force-merged', track: 'C' },
    { time: '2026-11-01T09:00:00Z', event: 'guard-deny', guard: 'push', rule: 'network-call', track: 'OLD' },
    { time: '2026-11-17T09:05:00Z', event: 'done', track: 'A' },
  ];

  it('deny and ask per track, newest window only, with the rules; the main session as "main"', () => {
    const c = GL.counts(rows, { from: Date.parse('2026-11-10T00:00:00Z') });
    expect(c.total).toEqual({ deny: 3, ask: 1 });
    expect(c.byTrack).toEqual([
      { track: 'A', deny: 2, ask: 0, rules: ['control-file', 'network-call'] },
      { track: 'B', deny: 1, ask: 0, rules: ['auto-loaded'] },
      { track: 'main', deny: 0, ask: 1, rules: ['push-batch'] },
    ]);
    expect(c.overrides).toEqual([{ event: 'force-merged', count: 1 }]);
  });

  it('the doctor line says it in one sentence; nothing logged says so too', () => {
    const c = GL.counts(rows, { from: Date.parse('2026-11-10T00:00:00Z') });
    expect(GL.doctorText(c, 7)).toMatch(/3 denied and 1 asked in the last 7 days: A 2, B 1, main 1/);
    expect(GL.doctorText(GL.counts([], {}), 7)).toMatch(/no guard decisions/);
  });
});

describe('a weakened config with no setting-weakened row', () => {
  const weakened = [
    { key: 'secretScan.enabled', value: false },
    { key: 'agentGuard.enabled', value: false },
  ];
  it('names the weakened keys the CLI never logged; one logged through the CLI is fine', () => {
    const rows = [{ event: 'setting-weakened', key: 'secretScan.enabled', to: false }];
    expect(GL.outsideCli(weakened, rows)).toEqual(['agentGuard.enabled']);
  });

  it('one already reported with the same value is not reported again', () => {
    const rows = [{ event: 'config-changed-outside-cli', key: 'agentGuard.enabled', to: false }];
    expect(GL.outsideCli(weakened, rows)).toEqual(['secretScan.enabled']);
  });

  it('a logged weakening to another value does not cover this one', () => {
    const rows = [{ event: 'setting-weakened', key: 'secretScan.enabled', to: 'x' }];
    expect(GL.outsideCli([{ key: 'secretScan.enabled', value: false }], rows)).toEqual(['secretScan.enabled']);
  });
});
