// =============================================================
// claudeTranscriptPaths.test.ts: characterization of how the core finds Claude Code transcripts (roadmap 0w W2a).
//
// Written against the code BEFORE the transcript paths moved behind lib/clients/claude/transcript.js, and kept green
// after the move: the move changes where the rule lives, not what it does. Locks:
//   - the folder: QUEUE_TRANSCRIPTS when set (also when empty), else <home>/.claude/projects/<slug>, where slug is the
//     main tree path with every character outside A-Z, a-z and 0-9 replaced by "-" (CLAUDE_CONFIG_DIR is NOT read);
//   - an agent's file: the first session folder (readdir order) with subagents/agent-<id>.jsonl, files at the top and
//     a missing folder give null;
//   - the subagents of a session: the ids of agent-<id>.jsonl only, a session without a subagents folder is empty;
//   - the session of a subagent transcript path, with / and \ separators.
// The .mjs modules read the folder at import, so the default path is checked in a child process with its own home.
// No real transcripts: every file here is an empty or one-line stand-in in a temporary folder.
// =============================================================
import { afterAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ORCH = path.resolve(__dirname, '..', '..');
const TA = require('../trackActivity.js');
const ES = require('../eventStatistics.js');
const FR = require('../fixRound.js');

const temps: string[] = [];
const temp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-tpaths-'));
  temps.push(d);
  return d;
};
afterAll(() => {
  for (const d of temps) fs.rmSync(d, { recursive: true, force: true });
});

/** A transcripts folder: s1 without the agent, s2 with agent-a1 and agent-b2 and a stray file, a top level file. */
function tree() {
  const root = temp();
  fs.mkdirSync(path.join(root, 's1', 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(root, 's1', 'subagents', 'agent-zz.jsonl'), '{}\n');
  fs.mkdirSync(path.join(root, 's2', 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(root, 's2', 'subagents', 'agent-a1.jsonl'), '{}\n');
  fs.writeFileSync(path.join(root, 's2', 'subagents', 'agent-b2.jsonl'), '{}\n');
  fs.writeFileSync(path.join(root, 's2', 'subagents', 'agent-b2.meta.json'), '{}');
  fs.writeFileSync(path.join(root, 's2', 'subagents', 'notes.txt'), '');
  fs.mkdirSync(path.join(root, 's3'));
  fs.writeFileSync(path.join(root, 's2.jsonl'), '{}\n');
  return root;
}

/** Runs an ESM snippet in a child with QUEUE_TRANSCRIPTS unset (or set) and HOME/USERPROFILE at `home`. */
function child(code: string, home: string, extra: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = { ...process.env, HOME: home, USERPROFILE: home, ...extra };
  if (!('QUEUE_TRANSCRIPTS' in extra)) delete env.QUEUE_TRANSCRIPTS;
  delete env.CLAUDE_CONFIG_DIR;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', env, cwd: ORCH });
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout.trim().split('\n').pop() as string);
}
const url = (rel: string) => pathToFileURL(path.join(ORCH, rel)).href;

describe('transcript paths (characterization)', () => {
  it('the folder is QUEUE_TRANSCRIPTS, else <home>/.claude/projects/<slug of the main tree>', () => {
    const before = process.env.QUEUE_TRANSCRIPTS;
    try {
      delete process.env.QUEUE_TRANSCRIPTS;
      expect(TA.transcriptsRoot('/srv/my repo/x.y_z')).toBe(
        path.join(os.homedir(), '.claude', 'projects', '-srv-my-repo-x-y-z'),
      );
      expect(TA.transcriptsRoot('C:\\work\\Æ1')).toBe(path.join(os.homedir(), '.claude', 'projects', 'C--work--1'));
      process.env.QUEUE_TRANSCRIPTS = '/elsewhere';
      expect(TA.transcriptsRoot('/srv/repo')).toBe('/elsewhere');
      process.env.QUEUE_TRANSCRIPTS = '';
      expect(TA.transcriptsRoot('/srv/repo')).toBe('');
    } finally {
      if (before === undefined) delete process.env.QUEUE_TRANSCRIPTS;
      else process.env.QUEUE_TRANSCRIPTS = before;
    }
  });

  it("an agent's file is the first session folder with subagents/agent-<id>.jsonl, else null", () => {
    const root = tree();
    expect(TA.findTranscript(root, 'a1')).toBe(path.join(root, 's2', 'subagents', 'agent-a1.jsonl'));
    expect(TA.findTranscript(root, 'zz')).toBe(path.join(root, 's1', 'subagents', 'agent-zz.jsonl'));
    expect(TA.findTranscript(root, 'nope')).toBeNull();
    expect(TA.findTranscript(path.join(root, 'missing'), 'a1')).toBeNull();
  });

  it('the subagents of a session are the agent-<id>.jsonl ids; no folder gives an empty set', () => {
    const root = tree();
    const m = ES.readAgentsBySession(root, ['s2', 's3', 'none']);
    expect([...m.keys()]).toEqual(['s2', 's3', 'none']);
    expect([...m.get('s2')].sort()).toEqual(['a1', 'b2']);
    expect(m.get('s3').size).toBe(0);
    expect(m.get('none').size).toBe(0);
    expect(ES.readAgentsBySession(root, null).size).toBe(0);
  });

  it('the session of a subagent transcript path is the folder above subagents', () => {
    expect(FR.sessionOfTranscript('/r/projects/x/S1/subagents/agent-a.jsonl')).toBe('S1');
    expect(FR.sessionOfTranscript('C:\\r\\x\\S2\\subagents\\agent-a.jsonl')).toBe('S2');
    expect(FR.sessionOfTranscript('/a/subagents/b/subagents/agent-a.jsonl')).toBe('b');
    expect(FR.sessionOfTranscript('subagents/agent-a.jsonl')).toBeNull();
    expect(FR.sessionOfTranscript('/r/S1/agent-a.jsonl')).toBeNull();
    expect(FR.sessionOfTranscript(null)).toBeNull();
  });

  it('cli/events.mjs and cli/tracks.mjs use the same folder and file rule by default (child with its own home)', () => {
    const home = temp();
    const code = `
      const c = await import(${JSON.stringify(url('cli/context.mjs'))});
      const e = await import(${JSON.stringify(url('cli/events.mjs'))});
      const t = await import(${JSON.stringify(url('cli/tracks.mjs'))});
      const path = await import('node:path');
      const fs = await import('node:fs');
      const slug = c.MAIN_TREE.replace(/[^A-Za-z0-9]/g, '-');
      const dir = path.join(${JSON.stringify(home)}, '.claude', 'projects', slug, 'sx', 'subagents');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'agent-q9.jsonl'), '{}\\n');
      console.log(JSON.stringify({
        events: e.TRANSCRIPTS,
        expected: path.join(${JSON.stringify(home)}, '.claude', 'projects', slug),
        found: t.findTranscript('q9'),
        file: path.join(dir, 'agent-q9.jsonl'),
        missing: t.findTranscript('none'),
        agents: [...(e.agentsBySession(['sx']).get('sx'))],
      }));`;
    const r = child(code, home);
    expect(r.events).toBe(r.expected);
    expect(r.found).toBe(r.file);
    expect(r.missing).toBeNull();
    expect(r.agents).toEqual(['q9']);
  });

  it('QUEUE_TRANSCRIPTS overrides the folder in cli/events.mjs and cli/tracks.mjs', () => {
    const root = tree();
    const code = `
      const e = await import(${JSON.stringify(url('cli/events.mjs'))});
      const t = await import(${JSON.stringify(url('cli/tracks.mjs'))});
      console.log(JSON.stringify({ events: e.TRANSCRIPTS, found: t.findTranscript('b2') }));`;
    const r = child(code, temp(), { QUEUE_TRANSCRIPTS: root });
    expect(r.events).toBe(root);
    expect(r.found).toBe(path.join(root, 's2', 'subagents', 'agent-b2.jsonl'));
  });
});
