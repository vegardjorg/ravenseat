// =============================================================
// fixRound.test.ts: the fix round as a continuation of the agent that delivered (lib/fixRound.js).
//
// Locks: (1) the setting fixRound.continueWithinMin / continueMaxContextK with its defaults; (2) which agent delivered
// (the newest build agent the time log ties to the task, fix rounds included, never a reviewer); (3) when that agent
// is continued with a message instead of a new agent (stopped, not killed, transcript in the orchestrator's own
// session, worktree still there, last active within the window, context under the cap) and the reason when not;
// (4) the short fix brief and the message that points to it.
// =============================================================
import { describe, it, expect } from 'vitest';
import path from 'node:path';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const FR = require('../fixRound.js') as any;
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

const T0 = Date.parse('2026-11-13T12:00:00Z');
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
const row = (o: Record<string, unknown>) => ({ wave: 'w', ...o });

describe('fixRoundSetup', () => {
  it('defaults to 60 minutes and 200k, and takes numbers >= 0 from the config', () => {
    expect(FR.fixRoundSetup({})).toEqual({ continueWithinMin: 60, continueMaxContextK: 200 });
    expect(FR.fixRoundSetup(null)).toEqual({ continueWithinMin: 60, continueMaxContextK: 200 });
    expect(FR.fixRoundSetup({ fixRound: { continueWithinMin: 0, continueMaxContextK: 150 } })).toEqual({
      continueWithinMin: 0,
      continueMaxContextK: 150,
    });
    // A value that is not a number >= 0 gives the default.
    expect(FR.fixRoundSetup({ fixRound: { continueWithinMin: -5, continueMaxContextK: 'x' } })).toEqual({
      continueWithinMin: 60,
      continueMaxContextK: 200,
    });
  });
});

describe('lastTrackAgent', () => {
  it('is the newest build agent tied to the task (fix rounds too), never a reviewer or another task', () => {
    const rows = [
      row({ time: at(0), event: 'start', agent_id: 'a0', agent_type: 'track', track: 'A' }),
      row({ time: at(30), event: 'done', agent_id: 'a0', agent_type: 'track', track: 'A', context: { end: 120_000 } }),
      row({ time: at(40), event: 'done', agent_id: 'rv', agent_type: 'reviewer-tests', track: 'A' }),
      row({ time: at(50), event: 'done', agent_id: 'b0', agent_type: 'track', track: 'B' }),
      row({ time: at(45), event: 'start', agent_id: 'AB', agent_type: 'track', track: 'AB' }),
    ];
    expect(FR.lastTrackAgent(rows, 'A')).toEqual({
      agent: 'a0',
      track: 'A',
      lastMs: Date.parse(at(30)),
      stopped: true,
      killed: false,
      context: 120_000,
    });
    // A later fix round agent (<id>-r1) is the one that delivered last.
    const more = [
      ...rows,
      row({ time: at(60), event: 'start', agent_id: 'a1', agent_type: 'track-d', track: 'A-r1' }),
      row({ time: at(80), event: 'done', agent_id: 'a1', agent_type: 'track-d', track: 'A-r1', killed: true }),
    ];
    expect(FR.lastTrackAgent(more, 'A')).toMatchObject({ agent: 'a1', track: 'A-r1', stopped: true, killed: true, context: null });
    // Still running (a start after its last stop): not stopped.
    const again = [...rows, row({ time: at(90), event: 'start', agent_id: 'a0', agent_type: 'track', track: 'A' })];
    expect(FR.lastTrackAgent(again, 'A')).toMatchObject({ agent: 'a0', stopped: false });
    expect(FR.lastTrackAgent([], 'A')).toBeNull();
    expect(FR.lastTrackAgent(rows, 'Z')).toBeNull();
  });
});

describe('continuation', () => {
  const transcriptOf = (session: string, agent = 'a0') =>
    path.join('root', session, 'subagents', `agent-${agent}.jsonl`);
  const base = {
    reason: 'fix',
    agent: { agent: 'a0', track: 'A', lastMs: T0 - 20 * 60_000, stopped: true, killed: false, context: 120_000 },
    transcript: { path: transcriptOf('s1'), mtimeMs: T0 - 12 * 60_000 },
    orchestratorSession: 's1',
    worktree: 'wt/queue-A',
    canContinue: true,
    cloud: false,
    newAgent: false,
    setup: { continueWithinMin: 60, continueMaxContextK: 200 },
    now: T0,
  };

  it('continues a stopped agent of this session, last active within the window, with its worktree', () => {
    const c = FR.continuation(base);
    expect(c.mode).toBe('continue');
    expect(c.agent).toBe('a0');
    // The newest of the time log row and the transcript mtime.
    expect(c.ageMin).toBe(12);
    expect(c.contextK).toBe(120);
    expect(c.why).toBe('last active 12 min ago, context about 120k');
    // Without a bound orchestrator session the transcript cannot be checked against it: still a continuation.
    expect(FR.continuation({ ...base, orchestratorSession: null }).mode).toBe('continue');
    // An unknown context does not stop it.
    expect(FR.continuation({ ...base, agent: { ...base.agent, context: null } })).toMatchObject({
      mode: 'continue',
      why: 'last active 12 min ago',
    });
    // 0 = no context cap.
    expect(FR.continuation({ ...base, agent: { ...base.agent, context: 900_000 }, setup: { continueWithinMin: 60, continueMaxContextK: 0 } }).mode).toBe('continue');
  });

  it('gives a new agent, with the reason, in every other case', () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ reason: 'context' }, /not a fix round/],
      [{ newAgent: true }, /--new-agent/],
      [{ setup: { continueWithinMin: 0, continueMaxContextK: 200 } }, /continueWithinMin is 0/],
      [{ canContinue: false }, /client cannot continue/],
      [{ cloud: true }, /cloud/],
      [{ agent: null }, /no track agent/],
      [{ agent: { ...base.agent, stopped: false } }, /has not stopped/],
      [{ agent: { ...base.agent, killed: true } }, /killed/],
      [{ transcript: null }, /transcript/],
      [{ transcript: { path: transcriptOf('s0'), mtimeMs: T0 } }, /another session/],
      [{ worktree: null }, /no worktree/],
      [{ transcript: { path: transcriptOf('s1'), mtimeMs: T0 - 61 * 60_000 }, agent: { ...base.agent, lastMs: T0 - 90 * 60_000 } }, /last active 61 min ago \(over 60\)/],
      [{ agent: { ...base.agent, context: 250_000 } }, /context about 250k \(over 200k\)/],
    ];
    for (const [change, why] of cases) {
      const c = FR.continuation({ ...base, ...change });
      expect(c.mode, JSON.stringify(change)).toBe('new');
      expect(c.why).toMatch(why);
    }
  });
});

describe('continueBrief and continueMessage', () => {
  it('the brief holds the fix list, the files, the gates to rerun and where to report; the message points to it', () => {
    const brief = FR.continueBrief({
      id: 'A',
      round: 1,
      branch: 'queue/A',
      worktree: 'wt/queue-A',
      reportFolder: 'scratch/A',
      findingsFile: 'scratch/findings-A-r1.md',
      reviewFolder: 'scratch/rev-A',
      reviewFiles: ['reviewer-notes.md'],
      work: ['Fix the review findings: HIGH first.'],
      gates: { quick: ['npm test'], done: 'npm run check' },
    });
    expect(brief).toContain('# Fix round 1 for A (continuation of the same agent)');
    expect(brief).toContain('Branch `queue/A`, your worktree `wt/queue-A`');
    expect(brief).toContain('The findings to fix: scratch/findings-A-r1.md');
    expect(brief).toContain("The reviewers' files: scratch/rev-A (reviewer-notes.md)");
    expect(brief).toContain('Fix the review findings: HIGH first.');
    expect(brief).toContain('Rerun before you report: the quick gates (`npm test`) and the done command `npm run check`.');
    expect(brief).toContain('scratch/A');
    expect(brief).not.toMatch(/\r/);
    const none = FR.continueBrief({ id: 'A', round: 2, branch: 'queue/A', worktree: 'w', reportFolder: 'r', work: [], gates: { quick: [], done: null } });
    expect(none).toContain('No quick gates or done command are set: run the tests that cover your change.');
    expect(none).not.toContain('The findings to fix');
    const msg = FR.continueMessage({ id: 'A', round: 1, briefFile: 'scratch/fix-A-r1.md' });
    expect(msg).toContain('Fix round 1 for A');
    expect(msg).toContain('scratch/fix-A-r1.md');
    expect(msg).toContain('track-result.md');
    expect(msg.length).toBeLessThan(500);
  });

  it('gateLines names only what is set', () => {
    expect(FR.gateLines({ quick: ['a', 'b'], done: null })).toBe('Rerun before you report: the quick gates (`a`, `b`).');
    expect(FR.gateLines({ quick: [], done: 'c' })).toBe('Rerun before you report: the done command `c`.');
  });
});
