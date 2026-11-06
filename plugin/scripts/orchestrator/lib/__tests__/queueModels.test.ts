// Model per agent (config `models`, queueLogic.modelFor / modelPart / concurrentBlock).
// The config is read once per process, so each case runs in its own node process with QUEUE_CONFIG.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const LOGIC = join(__dirname, '..', 'queueLogic.js');

describe('models: model per agent', () => {
  let folder: string;
  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'queue-models-'));
  });
  afterEach(() => rmSync(folder, { recursive: true, force: true }));

  /** Runs `code` with L = queueLogic and the given config; returns what it prints. */
  function withConfig(config: object, code: string): string {
    const file = join(folder, 'queue.config.json');
    writeFileSync(file, JSON.stringify(config));
    const r = spawnSync(process.execPath, ['-e', `const L = require(${JSON.stringify(LOGIC)}); ${code}`], {
      env: { ...process.env, QUEUE_CONFIG: file },
      encoding: 'utf8',
    });
    expect(r.stderr).toBe('');
    return r.stdout;
  }

  it('default: no model, the start lines are as before', () => {
    const out = withConfig(
      {},
      `console.log(JSON.stringify([L.modelFor('track'), L.modelPart('reviewer')]));
       console.log(L.concurrentBlock([{ subagent_type: 'reviewer', prompt: 'p.md' }]).join('\\n'));`,
    );
    expect(out).toContain('[null,""]');
    expect(out).not.toContain('model=');
  });

  it('a set model is printed on the start line; the plugin prefix and case do not matter', () => {
    const out = withConfig(
      { models: { 'reviewer-docs': 'Sonnet', track: 'opus' } },
      `console.log(L.modelFor('ravenseat:reviewer-docs'), L.modelFor('track'), L.modelFor('reviewer'));
       console.log(L.concurrentBlock([{ subagent_type: 'reviewer-docs', prompt: 'p.md' }, { subagent_type: 'reviewer', prompt: 'q.md' }]).join('\\n'));`,
    );
    expect(out).toContain('sonnet opus null');
    expect(out).toMatch(/reviewer-docs · model=sonnet · message: the content of p\.md/);
    expect(out).toMatch(/reviewer · message: the content of q\.md/);
  });

  it('an unknown model is ignored (never a value the Agent tool refuses)', () => {
    const out = withConfig({ models: { track: 'gpt-5', reviewer: 42 } }, `console.log(L.modelFor('track'), L.modelFor('reviewer'));`);
    expect(out.trim()).toBe('null null');
  });
});
