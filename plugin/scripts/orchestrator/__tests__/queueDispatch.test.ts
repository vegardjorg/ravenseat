// =============================================================
// queueDispatch.test.ts: every command word queue.mjs dispatches on reaches a function that exists.
//
// Why: queue.mjs is a thin entry point; the commands live in cli/*.mjs. A dispatch line that names a function a module
// does not export, or an async command that is not awaited, would only show up when someone runs that one command.
// This test reads the dispatch chain (no spawn, nothing runs): each `command === '<word>'` branch calls
// <namespace>.<function>(), the namespace is imported from ./cli/<module>.mjs, and that module exports the function.
// An async command function must be called with await. The words themselves are kept in step with QUEUE_COMMANDS in
// lib/__tests__/cliHelp.test.ts.
// Also: every cli/*.mjs module is imported by queue.mjs, by another cli/ module, or by another entry script with import()
// (push-check.mjs --watch-ci loads cli/ciWatch.mjs), so none is left behind.
// =============================================================
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.resolve(__dirname, '..');
const SOURCE = fs.readFileSync(path.join(DIR, 'queue.mjs'), 'utf8');
const CLI = path.join(DIR, 'cli');
const MODULES = fs.readdirSync(CLI).filter((f) => f.endsWith('.mjs'));
const text = (f: string) => fs.readFileSync(path.join(CLI, f), 'utf8');

/** namespace -> module file, from `import * as <ns> from './cli/<file>'`. */
const NAMESPACES = new Map(
  [...SOURCE.matchAll(/^import \* as (\w+) from '\.\/cli\/([\w.]+)';$/gm)].map((m) => [m[1], m[2]] as const),
);

/** Each dispatch branch: the command word(s) in its test and the call it makes. */
const BRANCHES = [
  ...SOURCE.matchAll(/(?:^if|^\} else if) \(([\s\S]*?)\) \{\n(?:\s*\/\/[^\n]*\n)*\s*(await )?(\w+)\.(\w+)\(\);\n/gm),
].map((m) => ({
  words: [...m[1].matchAll(/command === '([A-Za-z-]+)'/g)].map((w) => w[1]),
  awaited: Boolean(m[2]),
  ns: m[3],
  fn: m[4],
}));
const H = require('../lib/cliHelp') as { QUEUE_COMMANDS: string[] };

describe('the dispatch in queue.mjs', () => {
  it('every QUEUE_COMMANDS word has a branch that calls a module function', () => {
    const dispatched = new Set(BRANCHES.flatMap((b) => b.words));
    for (const c of H.QUEUE_COMMANDS) expect(dispatched.has(c), c).toBe(true);
    expect(BRANCHES.length).toBeGreaterThanOrEqual(H.QUEUE_COMMANDS.length);
  });

  it('each call names an imported module that exports the function (async ones are awaited)', () => {
    for (const b of BRANCHES) {
      const file = NAMESPACES.get(b.ns);
      expect(file, `${b.words.join('/')}: namespace ${b.ns}`).toBeTruthy();
      const src = text(file!);
      const def = new RegExp(`^export (async )?function ${b.fn}\\(`, 'm').exec(src);
      expect(def, `${b.words.join('/')}: ${file} exports ${b.fn}`).toBeTruthy();
      expect(b.awaited, `${b.words.join('/')}: ${b.fn} is ${def![1] ? 'async' : 'sync'}`).toBe(Boolean(def![1]));
    }
  });

  it('every cli/ module is used', () => {
    const imported = new Set([...NAMESPACES.values()]);
    for (const f of MODULES) for (const m of text(f).matchAll(/from '\.\/([\w.]+\.mjs)'/g)) imported.add(m[1]);
    // The other entry scripts next to queue.mjs that load a cli/ module themselves (push-check.mjs --watch-ci).
    for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.mjs')))
      for (const m of fs.readFileSync(path.join(DIR, f), 'utf8').matchAll(/import\('\.\/cli\/([\w.]+\.mjs)'\)/g)) imported.add(m[1]);
    for (const f of MODULES) expect(imported.has(f), f).toBe(true);
  });
});
