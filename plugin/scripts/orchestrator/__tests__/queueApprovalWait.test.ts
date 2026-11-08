// =============================================================
// queueApprovalWait.test.ts: a track that stands still on a permission prompt (lib/approvalWait.js).
//
// Locks: (1) which agent waits: the subagent transcript whose last tool call has no result; (2) the hook
// (hook-approval-wait.mjs) saves that agent, only for a permission prompt, never the prompt text, and saves nothing
// when the prompt is the main session's own; (3) the board shows the task until the agent's transcript moves, and the
// decision overview gives it its own card.
// The input shape is the one Claude Code sent in the feasibility test of 2026-11-08 (no agent_id in a Notification).
// Runs against a temporary project (QUEUE_FOLDER, QUEUE_ROOT). Never the main repo or the real queue.
// =============================================================
import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const AW = require('../lib/approvalWait.js');
const T = require('../lib/queueBoard.js');
const DEC = require('../lib/queueDecisions.js');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const HOOK = path.join(ROOT, 'scripts', 'orchestrator', 'hook-approval-wait.mjs');

const temporary: string[] = [];
afterAll(() => {
  for (const f of temporary) fs.rmSync(f, { recursive: true, force: true });
});

const line = (o: unknown) => JSON.stringify(o);
const call = (id: string, name: string) => line({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input: {} }] } });
const answer = (id: string) => line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });

describe('which agent waits on a tool call', () => {
  it('the last call without a result counts; an answered call does not', () => {
    expect(AW.pendingToolUse([call('a', 'Read'), answer('a'), call('b', 'Write')].join('\n'))).toEqual({ id: 'b', tool: 'Write' });
    expect(AW.pendingToolUse([call('a', 'Read'), answer('a')].join('\n'))).toBeNull();
    // A first line cut in half by the tail is skipped, not an error.
    expect(AW.pendingToolUse(`{"type":"assis\n${call('c', 'Bash')}`)).toEqual({ id: 'c', tool: 'Bash' });
    expect(AW.pendingToolUse('')).toBeNull();
  });

  it('the subagent folder sits next to the main transcript', () => {
    expect(AW.subagentDir(path.join('x', 'sess.jsonl'))).toBe(path.join('x', 'sess', 'subagents'));
    expect(AW.subagentDir(undefined)).toBeNull();
  });

  it('merge drops waits older than a day and keeps the rest', () => {
    const now = Date.parse('2026-11-08T12:00:00Z');
    const out = AW.merge(
      { old: { at: '2026-11-07T11:00:00Z', tool: 'Bash' }, keep: { at: '2026-11-08T11:00:00Z', tool: 'Read' } },
      [{ agent_id: 'new', tool: 'Write' }],
      now,
    );
    expect(Object.keys(out).sort()).toEqual(['keep', 'new']);
    expect(out.new).toEqual({ at: '2026-11-08T12:00:00.000Z', tool: 'Write' });
  });

  it('a wait counts until the transcript is written after it, and only for an agent of a known task', () => {
    const at = '2026-11-08T12:00:00.000Z';
    const t = Date.parse(at);
    const waits = { ag1: { at, tool: 'Write' }, ag2: { at, tool: 'Bash' }, stray: { at, tool: 'Read' } };
    const agentTask = new Map([
      ['ag1', 'A-1'],
      ['ag2', 'B-1'],
    ]);
    const mtime: Record<string, number> = { ag1: t - 6000, ag2: t + 60_000 };
    const rows = AW.waitingTasks(waits, { agentTask, mtimeOf: (a: string) => mtime[a] ?? null, now: t + 120_000 });
    expect(rows).toEqual([{ id: 'A-1', tool: 'Write', since: at }]);
    // A day later the wait is no longer news.
    expect(AW.waitingTasks(waits, { agentTask, mtimeOf: () => t, now: t + AW.MAX_AGE_MS })).toEqual([]);
  });
});

describe('the hook saves the waiting agent', () => {
  function project() {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-approval-'));
    temporary.push(folder);
    const configFile = path.join(folder, 'queue.config.json');
    fs.writeFileSync(configFile, JSON.stringify({ baseBranch: 'develop' }));
    const env = { ...process.env, QUEUE_FOLDER: folder, QUEUE_CONFIG: configFile, QUEUE_ROOT: folder } as NodeJS.ProcessEnv;
    const transcript = path.join(folder, 'transcripts', 'sess.jsonl');
    const sub = path.join(folder, 'transcripts', 'sess', 'subagents');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(transcript, '');
    const hook = (input: unknown) => spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), encoding: 'utf8', env, cwd: folder });
    const saved = () => {
      try {
        return JSON.parse(fs.readFileSync(path.join(folder, AW.FILE), 'utf8'));
      } catch {
        return null;
      }
    };
    return { folder, transcript, sub, hook, saved };
  }
  const prompt = (transcript: string, type = 'permission_prompt') => ({
    hook_event_name: 'Notification',
    notification_type: type,
    message: 'Claude needs your permission to use Write',
    session_id: 'sess',
    transcript_path: transcript,
  });

  it('a permission prompt saves the agent whose call has no result, with the tool and no prompt text', () => {
    const p = project();
    fs.writeFileSync(path.join(p.sub, 'agent-aaa.jsonl'), [call('1', 'Read'), answer('1'), call('2', 'Write')].join('\n') + '\n');
    fs.writeFileSync(path.join(p.sub, 'agent-bbb.jsonl'), [call('3', 'Read'), answer('3')].join('\n') + '\n');
    const r = p.hook(prompt(p.transcript));
    expect(r.status).toBe(0);
    const s = p.saved();
    expect(Object.keys(s)).toEqual(['aaa']);
    expect(s.aaa.tool).toBe('Write');
    expect(JSON.stringify(s)).not.toContain('permission');
  });

  it('another notification, or a prompt in the main session itself, saves nothing', () => {
    const p = project();
    fs.writeFileSync(path.join(p.sub, 'agent-aaa.jsonl'), call('2', 'Write') + '\n');
    expect(p.hook(prompt(p.transcript, 'idle_prompt')).status).toBe(0);
    expect(p.saved()).toBeNull();
    fs.writeFileSync(path.join(p.sub, 'agent-aaa.jsonl'), [call('2', 'Write'), answer('2')].join('\n') + '\n');
    expect(p.hook(prompt(p.transcript)).status).toBe(0);
    expect(p.saved()).toBeNull();
  });

  it('unreadable input fails open', () => {
    const p = project();
    const r = spawnSync(process.execPath, [HOOK], { input: 'not json', encoding: 'utf8', env: { ...process.env, QUEUE_FOLDER: p.folder, QUEUE_ROOT: p.folder, QUEUE_CONFIG: path.join(p.folder, 'queue.config.json') } });
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

  it('a task whose agent waits on an approval is in "Waiting on you" with its own card', () => {
    const since = new Date().toISOString();
    const b = T.board(queue, { approval: [{ id: 'RUN', tool: 'Write', since }] });
    const h = b.inbox.stuck.find((x: { id: string }) => x.id === 'RUN');
    expect(h?.awaiting_approval).toEqual({ tool: 'Write', since });
    const items = DEC.decisions(b.inbox, queue);
    const item = items.find((x: { id: string }) => x.id === 'RUN');
    expect(item?.kind).toBe('stuck-approval');
    expect(item?.context.join(' ')).toContain('approve a Write call');
  });

  it('without a wait the young running task is not in the list', () => {
    const b = T.board(queue, {});
    expect(b.inbox.stuck.find((x: { id: string }) => x.id === 'RUN')).toBeUndefined();
  });
});
