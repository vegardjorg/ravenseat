// =============================================================
// flakyObserved.test.ts: red and then green on the same commit, read from the time log's gate rows
// (lib/flakyObserved.js).
//
// Why: the Checks card flaky-tests turns medium once a flaky gate command has been seen. The rule must count a real
// flip (same track, same command, same commit, the next run of it), not a fix (a new commit in between) and not a run
// whose commit is unknown.
// =============================================================
import { describe, expect, it } from 'vitest';

import { flakyFlips, gateRows } from '../flakyObserved';

const row = (o: Record<string, unknown>) => ({ event: 'gate', kind: 'quick', track: 'T-1', gates: ['npm test', 'npm run lint'], failed: [], ...o });

describe('flakyFlips', () => {
  it('red, then green on the same commit is a flip, counted once per command and commit', () => {
    const rows = [
      row({ sha: 'a1', failed: ['npm test'] }),
      row({ sha: 'a1' }),
      row({ sha: 'a1', failed: ['npm test'] }),
      row({ sha: 'a1' }),
    ];
    expect(flakyFlips(rows)).toEqual([{ command: 'npm test', sha: 'a1' }]);
  });

  it('a new commit in between is a change, not a flip; a run without a sha counts for nothing', () => {
    expect(flakyFlips([row({ sha: 'a1', failed: ['npm test'] }), row({ sha: 'b2' })])).toEqual([]);
    expect(flakyFlips([row({ sha: 'a1', failed: ['npm test'] }), row({ sha: 'b2' }), row({ sha: 'a1' })])).toEqual([]);
    expect(flakyFlips([row({ failed: ['npm test'] }), row({})])).toEqual([]);
  });

  it('another track on the same commit does not pair; a row\'s own flaky list counts', () => {
    expect(flakyFlips([row({ sha: 'a1', failed: ['npm test'] }), row({ sha: 'a1', track: 'T-2' })])).toEqual([]);
    expect(flakyFlips([row({ sha: 'c3', flaky: ['npm run lint'] })])).toEqual([{ command: 'npm run lint', sha: 'c3' }]);
  });
});

describe('gateRows', () => {
  it('reads the gate rows of a time log and skips other rows and broken lines', () => {
    const text = [JSON.stringify(row({ sha: 'a1' })), '{"event":"gate", broken', JSON.stringify({ event: 'done' }), ''].join('\n');
    expect(gateRows(text).length).toBe(1);
  });
});
