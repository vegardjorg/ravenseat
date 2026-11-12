// =============================================================
// instructionNotice.test.ts: the one-time chat message about the size of Claude's instructions (lib/instructionNotice.js,
// carried by hook-context.mjs on UserPromptSubmit in the main session).
//
// Why: the owner should hear once, in plain words, why a large instruction set costs on every turn, track and subagent,
// and again only when it has grown by more than a tenth. It goes to the owner (systemMessage), never into the model's
// context, which would add to the very problem. Quiet guidance and instructionSize.mode off stop it. The hook runs on every
// prompt, so an unchanged set is not read again: a cache of the paths it looked at is compared by stat only.
// =============================================================
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const N = require('../instructionNotice.js') as any;
const IS = require('../instructionSize.js') as any;
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

const temporary: string[] = [];
afterAll(() => {
  for (const d of temporary) fs.rmSync(d, { recursive: true, force: true });
});

/** A project with a CLAUDE.md of `chars` characters, a data folder, and a counting measure. */
function setup(chars: number) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'instr-notice-'));
  temporary.push(base);
  const root = path.join(base, 'repo');
  const folder = path.join(base, 'data');
  fs.mkdirSync(root);
  fs.mkdirSync(folder);
  const claude = path.join(root, 'CLAUDE.md');
  fs.writeFileSync(claude, 'x'.repeat(chars));
  let measured = 0;
  const measure = (r: string) => {
    measured++;
    return IS.measure({ root: r, claudeDir: path.join(base, 'claude'), home: path.join(base, 'home'), managed: null, top: r });
  };
  const check = (o: Record<string, unknown> = {}) =>
    N.check({ folder, root, config: {}, quiet: () => false, cli: 'ravenseat', now: Date.parse('2026-11-12T10:00:00Z'), measure, ...o });
  return { base, root, folder, claude, check, measured: () => measured };
}

describe('the instruction notice', () => {
  it('shows the first time the set is over maxChars, as a text for the owner', () => {
    const s = setup(40001);
    const text = s.check();
    expect(text).toMatch(/^Claude's instructions in this project are about 10,000 tokens \(40,001 chars in 1 file\)/);
    expect(text).toContain('every turn, every track and every subagent');
    expect(text).toContain('@ imports do not help');
    expect(text).toContain('.claude/rules/<topic>.md with paths:');
    expect(text).toContain('ravenseat instructions proposes a split and changes nothing');
    expect(text).toContain('ravenseat settings set instructionSize.mode off');
  });

  it('is not shown again until the set has grown by more than a tenth', () => {
    const s = setup(40001);
    expect(s.check()).toBeTruthy();
    expect(s.check()).toBe(null);
    fs.writeFileSync(s.claude, 'x'.repeat(44000));
    expect(s.check()).toBe(null);
    fs.writeFileSync(s.claude, 'x'.repeat(44002));
    expect(s.check()).toMatch(/44,002 chars/);
  });

  it('is never shown in quiet, with mode off, or under the limit', () => {
    expect(setup(40001).check({ quiet: () => true })).toBe(null);
    expect(setup(40001).check({ config: { instructionSize: { mode: 'off' } } })).toBe(null);
    expect(setup(40000).check()).toBe(null);
    expect(setup(30001).check({ config: { instructionSize: { maxChars: 30000 } } })).toMatch(/30,001 chars/);
  });

  it('quiet does not use up the notice: it shows when guidance turns guided again', () => {
    const s = setup(40001);
    expect(s.check({ quiet: () => true })).toBe(null);
    expect(s.check()).toBeTruthy();
  });

  it('an unchanged set is not read again; a changed or new file is', () => {
    const s = setup(100);
    s.check();
    s.check();
    expect(s.measured()).toBe(1);
    fs.writeFileSync(s.claude, 'y'.repeat(150));
    s.check();
    expect(s.measured()).toBe(2);
    fs.writeFileSync(path.join(s.root, 'CLAUDE.local.md'), 'local\n');
    s.check();
    expect(s.measured()).toBe(3);
    fs.mkdirSync(path.join(s.root, '.claude', 'rules'), { recursive: true });
    s.check();
    expect(s.measured()).toBe(4);
  });

  it('mode off reads nothing at all', () => {
    const s = setup(40001);
    s.check({ config: { instructionSize: { mode: 'off' } } });
    expect(s.measured()).toBe(0);
    expect(fs.readdirSync(s.folder)).toEqual([]);
  });
});
