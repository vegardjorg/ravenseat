// =============================================================
// claudeFingerprint.test.ts: the fingerprint of the owner's own Claude setup (lib/claudeFingerprint.js).
//
// Why: a track runs as the owner, so it can write outside its worktree, also in ~/.claude (settings, hooks, agents,
// skills, plugin manifests). git never sees that folder, so no merge guard catches it. start records hashes of a
// narrow list, receive compares and names what changed. Only hashes are stored, never the content.
// =============================================================
import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const FP = require('../claudeFingerprint.js');

const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
function claudeDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-fp-'));
  made.push(d);
  fs.writeFileSync(path.join(d, 'settings.json'), '{"env":{"TOKEN":"tok-value-1"}}');
  fs.mkdirSync(path.join(d, 'agents'));
  fs.writeFileSync(path.join(d, 'agents', 'helper.md'), 'an agent');
  fs.mkdirSync(path.join(d, 'plugins'));
  fs.writeFileSync(path.join(d, 'plugins', 'installed_plugins.json'), '{}');
  // Not on the list: transcripts and the plugin cache change all the time.
  fs.mkdirSync(path.join(d, 'projects', 'x'), { recursive: true });
  fs.writeFileSync(path.join(d, 'projects', 'x', 'a.jsonl'), 'row');
  return d;
}

describe('the fingerprint', () => {
  it('holds only hashes for the listed entries, null for a missing one', () => {
    const d = claudeDir();
    const f = FP.fingerprint({ dir: d });
    expect(f.entries['settings.json']).toMatch(/^[0-9a-f]{64}$/);
    expect(f.entries['agents/']).toMatch(/^[0-9a-f]{64}$/);
    expect(f.entries['settings.local.json']).toBeNull();
    expect(Object.keys(f.entries)).not.toContain('projects/');
    expect(JSON.stringify(f)).not.toContain('tok-value-1');
  });

  it('names a changed, an added and a removed entry, and nothing when all is the same', () => {
    const d = claudeDir();
    const before = FP.fingerprint({ dir: d });
    expect(FP.compare(before, FP.fingerprint({ dir: d }))).toEqual([]);
    fs.writeFileSync(path.join(d, 'settings.json'), '{"hooks":{"PreToolUse":[]}}');
    fs.writeFileSync(path.join(d, 'settings.local.json'), '{}');
    fs.rmSync(path.join(d, 'plugins', 'installed_plugins.json'));
    fs.writeFileSync(path.join(d, 'projects', 'x', 'b.jsonl'), 'row');
    expect(FP.compare(before, FP.fingerprint({ dir: d }))).toEqual([
      { name: 'settings.json', change: 'changed' },
      { name: 'settings.local.json', change: 'added' },
      { name: 'plugins/installed_plugins.json', change: 'removed' },
    ]);
  });

  it('a new or changed file in a listed folder changes the folder', () => {
    const d = claudeDir();
    const before = FP.fingerprint({ dir: d });
    fs.mkdirSync(path.join(d, 'agents', 'sub'));
    fs.writeFileSync(path.join(d, 'agents', 'sub', 'new.md'), 'x');
    expect(FP.compare(before, FP.fingerprint({ dir: d }))).toEqual([{ name: 'agents/', change: 'changed' }]);
  });

  it('a fingerprint from another folder, or none, compares to nothing', () => {
    const a = FP.fingerprint({ dir: claudeDir() });
    const b = FP.fingerprint({ dir: claudeDir() });
    expect(FP.compare(a, { ...b, dir: 'elsewhere' })).toEqual([]);
    expect(FP.compare(null, b)).toEqual([]);
  });

  it('the warning names the entries, the folder and the other tracks that ran', () => {
    const lines = FP.warningLines('A', [{ name: 'settings.json', change: 'changed' }], { dir: '/h/.claude', others: ['B'] });
    expect(lines[0]).toMatch(/^CLAUDE SETUP CHANGED A: settings\.json \(changed\) in \/h\/\.claude since the track started/);
    expect(lines.join('\n')).toMatch(/B ran at the same time/);
    expect(FP.warningLines('A', [], { dir: 'x' })).toEqual([]);
  });

  it('the folder is RAVENSEAT_CLAUDE_DIR, then CLAUDE_CONFIG_DIR, then ~/.claude', () => {
    expect(FP.claudeDir({ RAVENSEAT_CLAUDE_DIR: '/a', CLAUDE_CONFIG_DIR: '/b' })).toBe('/a');
    expect(FP.claudeDir({ CLAUDE_CONFIG_DIR: '/b' })).toBe('/b');
    expect(FP.claudeDir({})).toBe(path.join(os.homedir(), '.claude'));
  });
});
