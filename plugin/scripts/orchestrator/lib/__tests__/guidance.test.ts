// =============================================================
// guidance.test.ts: the one switch for advice (lib/guidance.js), and that it never reaches a guard.
// The command and its reach through real processes: __tests__/queueGuidance.test.ts.
// =============================================================
import { describe, expect, it } from 'vitest';

import { verificationLine, noChecksLine } from '../controls';
import { filterDoctor, isQuiet, modeOf } from '../guidance';
import { assess } from '../pushGuard';
import { helperSetup } from '../queueHelpers';
import { STANDARD } from '../queueConfig';

describe('guidance', () => {
  it('is guided unless the queue says quiet', () => {
    expect(modeOf({})).toBe('guided');
    expect(modeOf(null)).toBe('guided');
    expect(modeOf({ guidance: 'odd' })).toBe('guided');
    expect(isQuiet({ guidance: 'quiet' })).toBe(true);
  });

  it('ci-cost shows only with --all, in guided too, and is not counted as hidden', () => {
    const rows = [
      { name: 'ci-cost', status: 'INFO' },
      { name: 'ci-cost', status: 'FAIL' },
      { name: 'gates', status: 'WARN' },
    ];
    expect(filterDoctor(rows, false)).toEqual({ rows: rows.slice(1), hidden: 0 });
    expect(filterDoctor(rows, false, { all: true })).toEqual({ rows, hidden: 0 });
    expect(filterDoctor(rows, true, { all: true })).toEqual({ rows, hidden: 0 });
  });

  it('drops advice rows from doctor, never a FAIL and never another check', () => {
    const rows = [
      { name: 'ci', status: 'INFO' },
      { name: 'ci-cost', status: 'INFO' },
      { name: 'gates', status: 'WARN' },
      { name: 'gates', status: 'FAIL' },
      { name: 'lockfile', status: 'WARN' },
      { name: 'secrets', status: 'WARN' },
      { name: 'config', status: 'OK' },
    ];
    const r = filterDoctor(rows, true);
    expect(r.hidden).toBe(3);
    expect(r.rows.map((c) => `${c.name} ${c.status}`)).toEqual(['gates FAIL', 'secrets WARN', 'config OK']);
    expect(filterDoctor(rows, false)).toEqual({ rows: rows.filter((c) => c.name !== 'ci-cost'), hidden: 0 });
  });

  it('keeps the fact and drops the pointer in the merge and receive lines', () => {
    const none = { status: 'unverified', checks: [] } as const;
    expect(verificationLine(none)).toContain('/ravenseat:kickstart');
    expect(verificationLine(none, { quiet: true })).toMatch(/^Not verified/);
    expect(verificationLine(none, { quiet: true })).not.toContain('kickstart');
    expect(verificationLine({ status: 'audited', checks: ['agent review'] }, { quiet: true })).not.toContain('kickstart');
    expect(verificationLine({ status: 'verified', checks: ['quick gates'] }, { quiet: true })).toContain('Verified');
    expect(noChecksLine('A', { quiet: true })).toBe('A: no checks ran.');
  });

  it('is not a command a queue agent may run', () => {
    const answer = assess('node scripts/orchestrator/queue.mjs guidance quiet', { agentType: 'track', baseBranch: 'main' });
    expect(answer?.decision).toBe('deny');
  });

  it('turns the light review and triage off, and a helper\'s own switch wins', () => {
    const quiet = helperSetup(STANDARD, { guidance: 'quiet' });
    expect(quiet['reviewer-light'].enabled).toBe(false);
    expect(quiet.triage.enabled).toBe(false);
    expect(helperSetup(STANDARD, {})['reviewer-light'].enabled).toBe(true);
    const own = helperSetup(STANDARD, { guidance: 'quiet', helpers: { 'reviewer-light': { enabled: true } } });
    expect(own['reviewer-light'].enabled).toBe(true);
  });
});
