// =============================================================
// fields.test.ts: the English/Norwegian field mapping (bench/lib/fields.js). Synthetic rows only.
// =============================================================
import { describe, it, expect } from 'vitest';

const F = require('../lib/fields.js') as {
  normalize: (v: unknown) => any;
  bareType: (t: unknown) => string | null;
};

describe('normalize', () => {
  it('maps a Norwegian task with its cost and status to the English names', () => {
    const t = F.normalize({
      id: 'Z-1',
      klasse: 'D',
      innhold_min: 40,
      status: 'ferdig',
      startet: 'a',
      levert: 'b',
      t_flett: 'c',
      ferdig: 'd',
      kost: { usd: 3, tokens: { cache_lest: 5, cache_skrevet: 6 }, agenter: [{ type: 'spor-d', kilde: 'transkript' }] },
      funn: { H: 1, M: 0, L: 2 },
      eier_filer: ['x'],
    });
    expect(t).toMatchObject({
      class: 'D',
      content_min: 40,
      status: 'done',
      started: 'a',
      delivered: 'b',
      t_merge: 'c',
      done: 'd',
      cost: { usd: 3, tokens: { cache_read: 5, cache_written: 6 }, agents: [{ type: 'track-d', source: 'transcript' }] },
      findings: { H: 1, M: 0, L: 2 },
      owned_files: ['x'],
    });
  });

  it('maps a Norwegian gate row and its enum values', () => {
    const r = F.normalize({ tid: 't', spor: 'Z-1', hendelse: 'gater', modus: 'rask', omkjoring_nr: 2, ledig_minne_pct: 9 });
    expect(r).toEqual({ time: 't', track: 'Z-1', event: 'gates', mode: 'quick', rerun_nr: 2, free_memory_pct: 9 });
  });

  it('passes English rows through unchanged and lets an English key win over a Norwegian duplicate', () => {
    const row = { time: 't', track: 'A', event: 'done', agent_type: 'track', tokens: { cache_read: 1 } };
    expect(F.normalize(row)).toEqual(row);
    expect(F.normalize({ class: 'K', klasse: 'D' }).class).toBe('K');
  });

  it('strips the plugin prefix from agent types', () => {
    expect(F.bareType('ravenseat:track-d')).toBe('track-d');
    expect(F.bareType('spor')).toBe('track');
    expect(F.bareType(null)).toBeNull();
  });
});
