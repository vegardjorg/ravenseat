// =============================================================
// claudeTranscript.test.ts: the transcript paths of the Claude Code adapter (lib/clients/claude/transcript.js,
// roadmap 0w W2a), reached through the registry as the core reaches them (clientFor().transcripts).
//
// Locks: the one slug rule and the folder (QUEUE_TRANSCRIPTS, else <home>/.claude/projects/<slug>); the agent file
// and its text with the size cap; the subagents of a session and the whole listing (main sessions and subagents) in
// readdir order; the session of a subagent path; the slice and the tail of a file (UTF-8, fromStart, size).
// The same behaviour the core had before the move is locked in claudeTranscriptPaths.test.ts.
// No real transcripts: every file is a stand-in in a temporary folder.
// =============================================================
import { afterAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const T = require('../clients/index.js').clientFor().transcripts;

const temps: string[] = [];
const temp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-tr-'));
  temps.push(d);
  return d;
};
afterAll(() => {
  for (const d of temps) fs.rmSync(d, { recursive: true, force: true });
});

function tree() {
  const root = temp();
  fs.mkdirSync(path.join(root, 's1', 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(root, 's1', 'subagents', 'agent-a1.jsonl'), 'one\n');
  fs.writeFileSync(path.join(root, 's1', 'subagents', 'agent-a1.meta.json'), '{}');
  fs.writeFileSync(path.join(root, 's1', 'subagents', 'agent-b2.jsonl'), 'two\n');
  fs.mkdirSync(path.join(root, 's2'));
  fs.writeFileSync(path.join(root, 's1.jsonl'), 'main\n');
  fs.writeFileSync(path.join(root, 'notes.txt'), '');
  return root;
}

describe('lib/clients/claude/transcript.js', () => {
  it('is the adapter member the registry hands the core', () => {
    expect(require('../clients/claude/index.js').transcripts).toBe(T);
    for (const f of [
      'slug',
      'transcriptsDir',
      'agentTranscriptPath',
      'findAgentTranscript',
      'readAgentTranscript',
      'listSubagents',
      'listTranscripts',
      'sessionOfTranscript',
      'readSlice',
      'readTail',
    ])
      expect(typeof T[f], f).toBe('function');
  });

  it('slug replaces every character outside A-Z, a-z and 0-9 with -', () => {
    expect(T.slug('/srv/my repo/x.y_z')).toBe('-srv-my-repo-x-y-z');
    expect(T.slug('C:\\work\\Æ1')).toBe('C--work--1');
  });

  it('transcriptsDir is QUEUE_TRANSCRIPTS when set (also empty), else <home>/.claude/projects/<slug>', () => {
    expect(T.transcriptsDir('/srv/r', { env: {}, home: '/h' })).toBe(path.join('/h', '.claude', 'projects', '-srv-r'));
    expect(T.transcriptsDir('/srv/r', { env: { QUEUE_TRANSCRIPTS: '/x' }, home: '/h' })).toBe('/x');
    expect(T.transcriptsDir('/srv/r', { env: { QUEUE_TRANSCRIPTS: '' }, home: '/h' })).toBe('');
    expect(T.transcriptsDir('/srv/r', { env: { CLAUDE_CONFIG_DIR: '/cfg' }, home: '/h' })).toBe(
      path.join('/h', '.claude', 'projects', '-srv-r'),
    );
  });

  it('finds and reads an agent transcript, null when missing or over the cap', () => {
    const root = tree();
    const p = path.join(root, 's1', 'subagents', 'agent-a1.jsonl');
    expect(T.agentTranscriptPath(root, 's1', 'a1')).toBe(p);
    expect(T.findAgentTranscript(root, 'a1')).toBe(p);
    expect(T.findAgentTranscript(root, 'zz')).toBeNull();
    expect(T.findAgentTranscript(path.join(root, 'none'), 'a1')).toBeNull();
    expect(T.readAgentTranscript(root, 'a1', { maxBytes: 100 })).toBe('one\n');
    expect(T.readAgentTranscript(root, 'a1', { maxBytes: 2 })).toBeNull();
    expect(T.readAgentTranscript(root, 'zz', { maxBytes: 100 })).toBeNull();
  });

  it('lists the subagents of a session and every transcript in the folder', () => {
    const root = tree();
    expect(T.listSubagents(root, 's1').map((x: { agent: string }) => x.agent).sort()).toEqual(['a1', 'b2']);
    expect(T.listSubagents(root, 's2')).toEqual([]);
    expect(T.listSubagents(root, 'none')).toEqual([]);
    const all = T.listTranscripts(root).map((x: { file: string }) => ({ ...x, file: path.relative(root, x.file) }));
    expect(all).toContainEqual({ file: 's1.jsonl', session: 's1', main: true });
    expect(all).toContainEqual({ file: path.join('s1', 'subagents', 'agent-a1.jsonl'), session: 's1', agent: 'a1', main: false });
    expect(all).toContainEqual({ file: path.join('s1', 'subagents', 'agent-b2.jsonl'), session: 's1', agent: 'b2', main: false });
    expect(all).toHaveLength(3);
    expect(T.listTranscripts(path.join(root, 'none'))).toEqual([]);
  });

  it('the session of a subagent path', () => {
    expect(T.sessionOfTranscript('/p/S1/subagents/agent-a.jsonl')).toBe('S1');
    expect(T.sessionOfTranscript('C:\\p\\S2\\subagents\\agent-a.jsonl')).toBe('S2');
    expect(T.sessionOfTranscript('subagents/agent-a.jsonl')).toBeNull();
    expect(T.sessionOfTranscript(undefined)).toBeNull();
  });

  it('reads a slice and the tail of a file', () => {
    const f = path.join(temp(), 't.jsonl');
    fs.writeFileSync(f, 'abcdefghij');
    expect(T.readSlice(f, 2, 3)).toBe('cde');
    expect(T.readSlice(f, 8, 10)).toBe('ij');
    expect(T.readSlice(f + '.none', 0, 3)).toBeNull();
    expect(T.readTail(f, 4)).toEqual({ text: 'ghij', fromStart: false, size: 10 });
    expect(T.readTail(f, 100)).toEqual({ text: 'abcdefghij', fromStart: true, size: 10 });
    expect(T.readTail(f + '.none', 4)).toBeNull();
  });
});
