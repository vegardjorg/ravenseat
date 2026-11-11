// =============================================================
// redteam/claudeFingerprint-cli.test.ts: a track that changes the owner's own Claude setup (lib/claudeFingerprint.js),
// end to end through start and receive.
//
// Why: a track runs as the owner and can write in ~/.claude, which git never sees. start records hashes of a narrow
// list; receive names what changed (CLAUDE SETUP CHANGED). "claudeFingerprint": false turns it off.
// =============================================================
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { project, task, tmp } from './project';

function setup(config: Record<string, unknown> = {}) {
  const p = project({ config, tasks: [task('A')] });
  const claude = tmp('rt-claude-');
  fs.writeFileSync(path.join(claude, 'settings.json'), '{}');
  p.env.RAVENSEAT_CLAUDE_DIR = claude;
  const started = p.run('start', 'A');
  expect(started.code, started.out).toBe(0);
  // What the agent does: one commit on its branch (the harness keeps the task fields start wrote, claude_fp too).
  p.localDelivers('A');
  return { p, claude };
}

describe('the Claude setup fingerprint', () => {
  it('start records only hashes; receive names a settings file the track changed', () => {
    const { p, claude } = setup();
    const fp = (p.taskOf('A') as { claude_fp?: { dir: string; entries: Record<string, string | null> } }).claude_fp;
    expect(fp?.dir).toBe(claude);
    expect(fp?.entries['settings.json']).toMatch(/^[0-9a-f]{64}$/);
    fs.writeFileSync(path.join(claude, 'settings.json'), '{"hooks":{"Stop":[]}}');
    const r = p.run('receive', 'A');
    expect(r.out).toContain(`CLAUDE SETUP CHANGED A: settings.json (changed) in ${claude} since the track started`);
  }, 240_000);

  it('nothing changed: no warning', () => {
    const { p } = setup();
    expect(p.run('receive', 'A').out).not.toContain('CLAUDE SETUP CHANGED');
  }, 240_000);

  it('"claudeFingerprint": false: nothing recorded and nothing said', () => {
    const { p, claude } = setup({ claudeFingerprint: false });
    expect(p.taskOf('A')).not.toHaveProperty('claude_fp');
    fs.writeFileSync(path.join(claude, 'settings.json'), '{"x":1}');
    expect(p.run('receive', 'A').out).not.toContain('CLAUDE SETUP CHANGED');
  }, 240_000);
});
