// =============================================================
// clientContract.test.ts: the shared contract every client adapter in lib/clients/index.js must keep.
//
// Each adapter has an id, its capabilities as data (the six boolean keys), the interface functions, and dispatches
// its own sample descriptor (lib/clients/<id>/fixtures/descriptor.json) into its format. A new client is done when it
// passes here. The registry gives the default client for a missing id and a clear error for an unknown one.
// =============================================================
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const CL = require('../clients/index.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const MD = require('../logic/missionDescriptor.js');

type Adapter = {
  id: string;
  capabilities: Record<string, unknown>;
  dispatch: (d: object) => Record<string, unknown>;
  fillEntry: (d: object) => Record<string, unknown>;
  agentLabel: (d: object) => string;
  startLine: (d: object) => string;
  resumeLine: (d: object) => string;
  sameTurnBlock: (agents: object[]) => string[];
};

const CLIENTS = path.resolve(__dirname, '..', 'clients');
const CAPABILITIES = ['cloud', 'hooks', 'resume', 'sandbox', 'structuredOutput', 'usage'];
const FUNCTIONS = ['dispatch', 'fillEntry', 'agentLabel', 'startLine', 'resumeLine', 'sameTurnBlock', 'missionAddendum'];
const adapters: Adapter[] = CL.adapters;
const fixture = (id: string) =>
  JSON.parse(fs.readFileSync(path.join(CLIENTS, id, 'fixtures', 'descriptor.json'), 'utf8'));

describe('client adapters: the shared contract', () => {
  it('the registry has at least one adapter, each id once', () => {
    expect(adapters.length).toBeGreaterThan(0);
    expect(new Set(CL.clientIds()).size).toBe(adapters.length);
  });

  describe.each(adapters.map((a) => [a.id, a] as const))('%s', (id, adapter) => {
    it('continueLine, when it has one, names the agent and carries the message as given', () => {
      const line = (adapter as unknown as { continueLine?: (x: object) => string }).continueLine;
      if (!line) return;
      const out = line({ agent: 'agent-x1', message: 'Fix round 1 for A: read brief.md' });
      expect(out).toContain('agent-x1');
      expect(out).toContain('Fix round 1 for A: read brief.md');
      expect(out).not.toMatch(/\n/);
    });

    it('has a lowercase id that matches its folder', () => {
      expect(id).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(fs.existsSync(path.join(CLIENTS, id, 'index.js'))).toBe(true);
    });

    it('has the six capabilities as booleans, and only those', () => {
      expect(Object.keys(adapter.capabilities).sort()).toEqual(CAPABILITIES);
      for (const k of CAPABILITIES) expect(typeof adapter.capabilities[k]).toBe('boolean');
    });

    it('has the interface functions', () => {
      for (const f of FUNCTIONS) expect(typeof (adapter as unknown as Record<string, unknown>)[f]).toBe('function');
    });

    it('its fixture is a descriptor for this client with the neutral fields', () => {
      const d = fixture(id);
      expect(d.client).toBe(id);
      expect(d.expects).toEqual([...MD.EXPECTS]);
      for (const k of ['task_id', 'track_id', 'role', 'branch', 'base_sha', 'prompt_file', 'effort'])
        expect(d).toHaveProperty(k);
    });

    it('dispatches the fixture and derives the lines and the fill entry from it', () => {
      const d = fixture(id);
      const x = adapter.dispatch(d);
      expect(x && typeof x).toBe('object');
      // The fill entry keeps every neutral queue-fill.json field from the descriptor.
      expect(adapter.fillEntry(d)).toMatchObject(MD.fillRecord(d));
      for (const line of [adapter.agentLabel(d), adapter.startLine(d), adapter.resumeLine(d)]) {
        expect(typeof line).toBe('string');
        expect(line.length).toBeGreaterThan(0);
      }
      expect(adapter.resumeLine(d)).toContain(d.track_id);
      expect(adapter.sameTurnBlock([])).toEqual([]);
      expect(adapter.sameTurnBlock([x]).length).toBeGreaterThan(0);
      // The mission addendum fills the template's client placeholders with non-empty text.
      const a = adapter.missionAddendum({});
      expect(Object.keys(a.template).length).toBeGreaterThan(0);
      expect(typeof a.reportOutside).toBe('string');
    });
  });

  it('clientFor: a missing id is the default (first) client, an unknown one throws a clear error', () => {
    for (const none of [undefined, null, '']) expect(CL.clientFor(none)).toBe(adapters[0]);
    for (const a of adapters) expect(CL.clientFor(a.id)).toBe(a);
    expect(() => CL.clientFor('no-such-client')).toThrow(/Unknown client "no-such-client" \(known: /);
  });

  it('sameTurnLines: one block per client, helpers join the default client', () => {
    const d = fixture(adapters[0].id);
    expect(CL.sameTurnLines([], [])).toEqual([]);
    const lines: string[] = CL.sameTurnLines([d], []);
    expect(lines).toEqual(adapters[0].sameTurnBlock([adapters[0].dispatch(d)]));
  });
});

describe('the Claude adapter', () => {
  const claude: Adapter = CL.clientFor('claude');
  it('dispatches by effort: high on track-d, medium on track, with the agent message', () => {
    const d = fixture('claude');
    const x = claude.dispatch(d);
    expect(x.subagent_type).toMatch(/^(ravenseat:)?track-d$/);
    expect(x.message).toContain(`You are track ${d.track_id} in the work queue`);
    expect(x.message).toContain(d.prompt_file);
    expect(claude.dispatch({ ...d, effort: 'medium' }).subagent_type).toMatch(/^(ravenseat:)?track$/);
    expect(claude.startLine(d)).toMatch(/^Agent: subagent_type (ravenseat:)?track-d.* \(thinkingLevel high\)\.$/);
  });

  it('the queue-fill.json entry keeps the field order skills read', () => {
    expect(Object.keys(claude.fillEntry(fixture('claude')))).toEqual([
      'id', 'class', 'subagent_type', 'model', 'prompt', 'message', 'branch', 'migr_block', 'new', 'warning',
    ]);
  });

  it('a descriptor model the Agent tool takes wins, an unknown one is ignored', () => {
    const d = fixture('claude');
    expect(claude.dispatch({ ...d, model: 'sonnet' }).model).toBe('sonnet');
    expect(claude.dispatch({ ...d, model: 'gpt-5' }).model).toBe(claude.dispatch(d).model);
  });
});
