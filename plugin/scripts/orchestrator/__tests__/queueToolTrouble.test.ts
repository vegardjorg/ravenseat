// =============================================================
// queueToolTrouble.test.ts: a track whose tool calls are refused in auto mode, or that fails the same tool again and
// again (lib/toolTrouble.js, hook-tool-trouble.mjs), gets a card in "Waiting on you".
//
// Locks: the hook keeps only the agent id, the tool name, counts and times (never the reason or the error text), it
// ignores the main session and an interrupt, one failure is no card but three of the same tool in the window are, a
// refusal in auto mode is a card at once, and old events drop off. The hooks are registered for both events in
// hooks.json and in settings.queue.json.
// Why: before this a track that auto mode kept refusing, or that looped on a failing command, looked like a slow track
// on the board until its time ran out.
// =============================================================
import { afterAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const TT = require('../lib/toolTrouble.js');
const T = require('../lib/queueBoard.js');
const DEC = require('../lib/queueDecisions.js');
const HOOK = path.resolve(__dirname, '..', 'hook-tool-trouble.mjs');
const PLUGIN = path.resolve(__dirname, '..', '..', '..');

const temporary: string[] = [];
afterAll(() => {
  for (const d of temporary) fs.rmSync(d, { recursive: true, force: true });
});

const t0 = Date.parse('2026-11-10T12:00:00.000Z');
const denied = (agent: string | undefined, tool = 'Bash') => ({
  hook_event_name: 'PermissionDenied',
  agent_id: agent,
  agent_type: 'track',
  tool_name: tool,
  tool_input: { command: 'rm -rf secret-folder' },
  reason: 'Auto mode refused: deletes outside the worktree',
});
const failed = (agent: string | undefined, tool = 'Bash', extra = {}) => ({
  hook_event_name: 'PostToolUseFailure',
  agent_id: agent,
  agent_type: 'track',
  tool_name: tool,
  tool_input: { command: 'npm test' },
  error: 'Exit code 1: password=hunter2',
  is_interrupt: false,
  ...extra,
});

describe('what is recorded', () => {
  it('a refusal and a failure count per agent; the main session and an interrupt are ignored', () => {
    let s = TT.record({}, denied('ag1'), t0);
    s = TT.record(s, failed('ag1'), t0 + 1000);
    s = TT.record(s, failed(undefined), t0 + 2000);
    s = TT.record(s, failed('ag1', 'Bash', { is_interrupt: true }), t0 + 3000);
    expect(Object.keys(s)).toEqual(['ag1']);
    expect(s.ag1.denied).toEqual([{ at: new Date(t0).toISOString(), tool: 'Bash' }]);
    expect(s.ag1.failed).toEqual([{ at: new Date(t0 + 1000).toISOString(), tool: 'Bash' }]);
    // Never the reason, the command or the error text.
    expect(JSON.stringify(s)).not.toMatch(/hunter2|secret-folder|refused/);
  });

  it('old events drop off, and the list per agent is capped', () => {
    let s = TT.record({}, failed('ag1'), t0);
    s = TT.record(s, failed('ag1'), t0 + TT.WINDOW_MS + 1);
    expect(s.ag1.failed).toHaveLength(1);
    for (let i = 0; i < 50; i++) s = TT.record(s, failed('ag2'), t0 + i);
    expect(s.ag2.failed.length).toBeLessThanOrEqual(TT.MAX_EVENTS);
  });
});

describe('which tasks get a card', () => {
  const agentTask = new Map([['ag1', 'RUN'], ['ag2', 'OTHER']]);
  it('one refusal is enough; failures only from three of the same tool in the window', () => {
    let s = TT.record({}, denied('ag1', 'Write'), t0);
    s = TT.record(s, failed('ag2', 'Bash'), t0);
    s = TT.record(s, failed('ag2', 'Edit'), t0 + 1);
    s = TT.record(s, failed('ag2', 'Bash'), t0 + 2);
    let rows = TT.troubleTasks(s, { agentTask, now: t0 + 10 });
    expect(rows.map((r: { id: string }) => r.id)).toEqual(['RUN']);
    expect(rows[0].denied).toEqual({ count: 1, tool: 'Write', last: new Date(t0).toISOString() });
    s = TT.record(s, failed('ag2', 'Bash'), t0 + 3);
    rows = TT.troubleTasks(s, { agentTask, now: t0 + 10 });
    const other = rows.find((r: { id: string }) => r.id === 'OTHER');
    expect(other.failing).toEqual({ count: 3, tool: 'Bash', last: new Date(t0 + 3).toISOString() });
    expect(other.denied).toBeNull();
  });

  it('an agent with no known task, and events older than the window, give nothing', () => {
    const s = TT.record({}, denied('nobody'), t0);
    expect(TT.troubleTasks(s, { agentTask, now: t0 })).toEqual([]);
    const old = TT.record({}, denied('ag1'), t0);
    expect(TT.troubleTasks(old, { agentTask, now: t0 + TT.WINDOW_MS + 1 })).toEqual([]);
    // The fallback finds the task from the transcript when the time log does not have it.
    expect(TT.troubleTasks(s, { agentTask, taskOf: () => 'RUN', now: t0 }).map((r: { id: string }) => r.id)).toEqual(['RUN']);
  });
});

describe('the hook', () => {
  function project() {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-tool-trouble-'));
    temporary.push(folder);
    const configFile = path.join(folder, 'queue.config.json');
    fs.writeFileSync(configFile, JSON.stringify({ baseBranch: 'develop' }));
    const env = { ...process.env, QUEUE_FOLDER: folder, QUEUE_CONFIG: configFile, QUEUE_ROOT: folder } as NodeJS.ProcessEnv;
    const hook = (input: unknown) => spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), encoding: 'utf8', env, cwd: folder });
    const saved = () => {
      try {
        return JSON.parse(fs.readFileSync(path.join(folder, TT.FILE), 'utf8'));
      } catch {
        return null;
      }
    };
    return { hook, saved };
  }

  it('saves a track agent\'s refusal and failure, prints nothing and exits 0', () => {
    const p = project();
    const a = p.hook(denied('ag1'));
    const b = p.hook(failed('ag1'));
    expect([a.status, b.status]).toEqual([0, 0]);
    expect(a.stdout + b.stdout).toBe('');
    const s = p.saved();
    expect(s.ag1.denied).toHaveLength(1);
    expect(s.ag1.failed).toHaveLength(1);
    expect(JSON.stringify(s)).not.toMatch(/hunter2|secret-folder/);
  });

  it('the main session, and unreadable input, save nothing', () => {
    const p = project();
    expect(p.hook(failed(undefined)).status).toBe(0);
    expect(p.saved()).toBeNull();
    const r = spawnSync(process.execPath, [HOOK], { input: 'not json', encoding: 'utf8' });
    expect(r.status).toBe(0);
  });
});

describe('the board and the decision overview', () => {
  const base = { domain: 'dom', class: 'K', value: 5, content_min: 30, depends_on: [], waiting_on: [] };
  const queue = {
    created: '2026-01-01T00:00:00.000Z',
    limits: {},
    resolved: [],
    tasks: [{ ...base, id: 'RUN', title: 'Running', status: 'running', mission: 'Run it.', owned_files: ['r.txt'], started: new Date().toISOString(), branch: 'queue/RUN' }],
  };

  it('a task with tool trouble is in "Waiting on you" with its own card', () => {
    const last = new Date().toISOString();
    const trouble = [{ id: 'RUN', denied: { count: 2, tool: 'Bash', last }, failing: null }];
    const b = T.board(queue, { toolTrouble: trouble });
    const h = b.inbox.stuck.find((x: { id: string }) => x.id === 'RUN');
    expect(h?.tool_trouble).toEqual({ denied: trouble[0].denied, failing: null });
    const item = DEC.decisions(b.inbox, queue).find((x: { id: string }) => x.id === 'RUN');
    expect(item?.kind).toBe('stuck-tools');
    expect(item?.heading).toBe('TOOL TROUBLE');
    expect(item?.context.join(' ')).toContain('Auto mode refused 2 Bash calls');
  });

  it('an approval wait goes before tool trouble on the same task', () => {
    const now = new Date().toISOString();
    const b = T.board(queue, {
      approval: [{ id: 'RUN', tool: 'Write', since: now }],
      toolTrouble: [{ id: 'RUN', denied: null, failing: { count: 3, tool: 'Bash', last: now } }],
    });
    const item = DEC.decisions(b.inbox, queue).find((x: { id: string }) => x.id === 'RUN');
    expect(item?.kind).toBe('stuck-approval');
  });
});

describe('the hooks are registered', () => {
  const uses = (file: string, event: string) => {
    const j = JSON.parse(fs.readFileSync(path.join(PLUGIN, file), 'utf8'));
    return JSON.stringify(j.hooks?.[event] ?? []).includes('hook-tool-trouble.mjs');
  };
  it('in hooks.json and settings.queue.json, for both events', () => {
    for (const f of ['hooks/hooks.json', 'settings.queue.json'])
      for (const e of ['PermissionDenied', 'PostToolUseFailure']) expect(uses(f, e), `${f} ${e}`).toBe(true);
  });
});
