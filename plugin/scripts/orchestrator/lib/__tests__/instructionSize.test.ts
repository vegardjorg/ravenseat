// =============================================================
// instructionSize.test.ts: what Claude Code loads as instructions, measured the way it loads them (lib/instructionSize.js).
//
// Why: the number that matters is the sum of everything loaded at the start of every session, track and subagent, not
// the root CLAUDE.md alone. Imports are followed (four hops, never from code), HTML block comments cost nothing, a rule
// with `paths:` loads only on demand, AGENTS.md only counts without a CLAUDE.md, ~/.claude counts on its own line and
// Ravenseat's own share is shown apart. Temporary folders only; the upward walk stops at the temporary root (`top`).
// =============================================================
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const IS = require('../instructionSize.js') as any;
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

const temporary: string[] = [];
afterAll(() => {
  for (const d of temporary) fs.rmSync(d, { recursive: true, force: true });
});

/** A project folder and a separate Claude folder, with the given files written. */
function setup(files: Record<string, string> = {}, user: Record<string, string> = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'instr-size-'));
  temporary.push(base);
  const root = path.join(base, 'project');
  const claudeDir = path.join(base, 'claude');
  const write = (dir: string, all: Record<string, string>) => {
    fs.mkdirSync(dir, { recursive: true });
    for (const [f, text] of Object.entries(all)) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), text);
    }
  };
  write(root, files);
  write(claudeDir, user);
  const measure = (o: Record<string, unknown> = {}) =>
    IS.measure({ root, claudeDir, home: path.join(base, 'home'), managed: null, top: root, ...o });
  return { base, root, claudeDir, measure };
}

const names = (r: any) => r.always.map((f: any) => f.rel);

describe('instructionSize: what loads at start', () => {
  it('an import inside a code block or a code span does not count', () => {
    const s = setup({
      'CLAUDE.md': 'Root\n\n```\n@fenced.md\n```\n\nSee `@span.md` too.\n@real.md\n',
      'fenced.md': 'F\n',
      'span.md': 'S\n',
      'real.md': 'R\n',
    });
    expect(names(s.measure())).toEqual(['CLAUDE.md', 'real.md']);
  });

  it('an import chain of five hops stops at four', () => {
    const s = setup({
      'CLAUDE.md': '@a.md\n',
      'a.md': '@b.md\n',
      'b.md': '@c.md\n',
      'c.md': '@d.md\n',
      'd.md': '@e.md\n',
      'e.md': 'too deep\n',
    });
    expect(names(s.measure())).toEqual(['CLAUDE.md', 'a.md', 'b.md', 'c.md', 'd.md']);
  });

  it('a cyclic import counts once', () => {
    const s = setup({ 'CLAUDE.md': '@a.md\n', 'a.md': 'A @CLAUDE.md\n@b.md\n', 'b.md': '@a.md\n' });
    const r = s.measure();
    expect(names(r)).toEqual(['CLAUDE.md', 'a.md', 'b.md']);
    expect(r.total.files).toBe(3);
  });

  it('an import is relative to the file, and ~ is the home folder', () => {
    const s = setup({ 'CLAUDE.md': '@docs/x.md\n', 'docs/x.md': '@../y.md @~/h.md\n', 'y.md': 'Y\n' });
    fs.mkdirSync(path.join(s.base, 'home'), { recursive: true });
    fs.writeFileSync(path.join(s.base, 'home', 'h.md'), 'H\n');
    expect(names(s.measure())).toEqual(['CLAUDE.md', 'docs/x.md', 'y.md', path.join(s.base, 'home', 'h.md').replace(/\\/g, '/')]);
  });

  it('an HTML block comment is taken off the count', () => {
    const s = setup({ 'CLAUDE.md': 'abc<!-- a comment that costs nothing -->def\n' });
    const r = s.measure();
    expect(r.always[0].chars).toBe('abcdef\n'.length);
    expect(r.total.chars).toBe(7);
  });

  it('a comment inside a code block stays (it is shown to Claude as code)', () => {
    const text = '```\n<!-- kept -->\n```\n';
    const s = setup({ 'CLAUDE.md': text });
    expect(s.measure().always[0].chars).toBe(text.length);
  });

  it('AGENTS.md is ignored when a CLAUDE.md exists, and counted when none does', () => {
    const both = setup({ 'CLAUDE.md': 'C\n', 'AGENTS.md': 'A\n' });
    expect(names(both.measure())).toEqual(['CLAUDE.md']);
    const only = setup({ 'AGENTS.md': 'A\n' });
    expect(names(only.measure())).toEqual(['AGENTS.md']);
    expect(only.measure().always[0].kind).toBe('agents-md');
  });

  it('a rule with paths: loads on demand; one without loads at start', () => {
    const s = setup({
      'CLAUDE.md': 'C\n',
      '.claude/rules/always.md': '# Always\nx\n',
      '.claude/rules/db/db.md': '---\npaths:\n  - "database/**"\n---\n# DB\n@../../../docs/db-more.md\n',
      // Outside the rules folder: every .md file there is a rule of its own.
      'docs/db-more.md': 'more\n',
      '.claude/rules/inline.md': '---\npaths: src/**/*.ts\n---\nTS\n',
    });
    const r = s.measure();
    expect(names(r)).toEqual(['CLAUDE.md', '.claude/rules/always.md']);
    const lazy = r.onDemand.map((f: any) => [f.rel, f.paths, f.files]);
    expect(lazy).toEqual([
      ['.claude/rules/db/db.md', ['database/**'], 2],
      ['.claude/rules/inline.md', ['src/**/*.ts'], 1],
    ]);
  });

  it('a subfolder CLAUDE.md is on demand, with its imports', () => {
    const s = setup({ 'CLAUDE.md': 'C\n', 'src/CLAUDE.md': 'S\n@part.md\n', 'src/part.md': 'P\n' });
    const r = s.measure({ nested: [path.join(s.root, 'src', 'CLAUDE.md')] });
    expect(names(r)).toEqual(['CLAUDE.md']);
    expect(r.onDemand.map((f: any) => [f.rel, f.kind, f.files])).toEqual([['src/CLAUDE.md', 'nested', 2]]);
  });

  it('Ravenseat\'s share (CLAUDE.queue.md) is shown apart from the project\'s', () => {
    const queue = 'Q'.repeat(100) + '\n';
    const s = setup({ 'CLAUDE.md': 'Project rules\n@CLAUDE.queue.md\n', 'CLAUDE.queue.md': queue });
    const r = s.measure();
    expect(r.byScope.ravenseat).toBe(queue.length);
    expect(r.byScope.project).toBe('Project rules\n@CLAUDE.queue.md\n'.length);
    expect(r.always.find((f: any) => f.rel === 'CLAUDE.queue.md').scope).toBe('ravenseat');
    expect(r.always.find((f: any) => f.rel === 'CLAUDE.queue.md').via).toBe('CLAUDE.md');
  });

  it('~/.claude/CLAUDE.md and its rules count in the total, as their own scope', () => {
    const s = setup({ 'CLAUDE.md': 'P\n' }, { 'CLAUDE.md': 'User\n', 'rules/style.md': 'Style\n', 'rules/lazy.md': '---\npaths: x/**\n---\nL\n' });
    const r = s.measure();
    expect(r.byScope.user).toBe('User\n'.length + 'Style\n'.length);
    expect(r.total.chars).toBe(2 + 5 + 6);
    expect(r.always[0]).toMatchObject({ rel: '~/.claude/CLAUDE.md', scope: 'user' });
    expect(r.onDemand.map((f: any) => f.rel)).toEqual(['~/.claude/rules/lazy.md']);
  });

  it('CLAUDE.md in the folders above, .claude/CLAUDE.md and CLAUDE.local.md all load', () => {
    const s = setup({ 'CLAUDE.md': 'P\n', '.claude/CLAUDE.md': 'D\n', 'CLAUDE.local.md': 'L\n' });
    fs.writeFileSync(path.join(s.base, 'CLAUDE.md'), 'Parent\n');
    const r = s.measure({ top: s.base });
    expect(names(r)).toEqual([path.join(s.base, 'CLAUDE.md').replace(/\\/g, '/'), 'CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md']);
  });

  it('an organization policy file is counted when it can be read', () => {
    const s = setup({ 'CLAUDE.md': 'P\n' });
    const managed = path.join(s.base, 'managed.md');
    fs.writeFileSync(managed, 'Org\n');
    expect(s.measure({ managed }).byScope.organization).toBe(4);
  });

  it('tokens are an estimate of chars / 4, and characters are counted as letters, not bytes', () => {
    const s = setup({ 'CLAUDE.md': 'æøå\n' });
    const r = s.measure();
    expect(r.total.chars).toBe(4);
    expect(r.total.tokens).toBe(1);
  });

  it('records every path it looked at, so a cache can tell when to measure again', () => {
    const s = setup({ 'CLAUDE.md': '@a.md\n', 'a.md': 'A\n' });
    const r = s.measure();
    const watched = r.watched.map((w: any) => path.relative(s.root, w.path).replace(/\\/g, '/'));
    expect(watched).toEqual(expect.arrayContaining(['CLAUDE.md', 'a.md', 'CLAUDE.local.md', '.claude/rules']));
  });
});

describe('instructionSize: assess against the limits', () => {
  const file = (rel: string, chars: number, lines: number) => ({ rel, chars, lines, scope: 'project' });
  it('a file of 201 lines is over 200; 200 is not', () => {
    const a = IS.assess({ always: [file('a', 10, 201), file('b', 10, 200)], onDemand: [], total: { chars: 20 } }, { maxLines: 200, maxChars: 40000 });
    expect(a.overLines.map((f: any) => f.rel)).toEqual(['a']);
    expect(a.overTotal).toBe(false);
    expect(a.large).toBe(true);
  });

  it('40,001 chars in all is over 40,000; 40,000 is not', () => {
    expect(IS.assess({ always: [], onDemand: [], total: { chars: 40001 } }, {}).overTotal).toBe(true);
    expect(IS.assess({ always: [], onDemand: [], total: { chars: 40000 } }, {}).overTotal).toBe(false);
  });

  it('an on-demand file over 40,000 chars with its imports is cut, whatever maxChars says', () => {
    const a = IS.assess({ always: [], onDemand: [file('r', 40001, 10), file('s', 40000, 10)], total: { chars: 0 } }, { maxChars: 999999 });
    expect(a.cut.map((f: any) => f.rel)).toEqual(['r']);
  });

  it('the limits come from the settings, with the documented defaults', () => {
    expect(IS.limitsOf({})).toEqual({ mode: 'warn', maxLines: 200, maxChars: 40000 });
    expect(IS.limitsOf({ instructionSize: { mode: 'off', maxLines: 150, maxChars: 30000 } })).toEqual({ mode: 'off', maxLines: 150, maxChars: 30000 });
    expect(IS.limitsOf({ instructionSize: { mode: 'odd', maxLines: -1, maxChars: 'x' } })).toEqual({ mode: 'warn', maxLines: 200, maxChars: 40000 });
  });
});
