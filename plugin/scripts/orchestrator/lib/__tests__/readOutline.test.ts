// =============================================================
// readOutline.test.ts: the outline the read guard adds to its denial of a large file (roadmap 0y Y1, lib/readOutline.js).
//
// Why: a denied whole-file Read used to send the agent off on an extra Grep round to find where to read. The outline
// (headings and top-level declarations with their line numbers) lets it go straight to Read with offset and limit.
// The outline only adds text, so the test also proves every edge case (binary, unknown type, unreadable, nothing
// found, too large, too slow, the setting off) gives the old denial text byte for byte, and that nothing throws.
// =============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const O = require('../readOutline.js') as any;
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

const REASON = 'readGuard: the file has 2500 lines (over 2000). Read in excerpts: Grep -n for what you need, then Read with offset and limit around the match.';

let folder: string;
beforeEach(() => {
  folder = fs.mkdtempSync(path.join(os.tmpdir(), 'read-outline-'));
});
afterEach(() => fs.rmSync(folder, { recursive: true, force: true }));

/** Writes a file in the temporary folder and returns its path. */
function file(name: string, content: string | Buffer) {
  const p = path.join(folder, name);
  fs.writeFileSync(p, content);
  return p;
}

describe('the outline of a Markdown file', () => {
  it('lists the # headings with their line numbers and skips headings inside fenced code', () => {
    const p = file(
      'guide.md',
      ['# Guide', '', 'Text.', '## Install', '```sh', '# not a heading', '```', '### Details', 'More.', '#no space'].join('\n'),
    );
    const text = O.withOutline(REASON, p);
    expect(text.startsWith(`${REASON}\n`)).toBe(true);
    expect(text).toContain('Markdown headings');
    expect(text).toContain('\n  1: # Guide');
    expect(text).toContain('\n  4: ## Install');
    expect(text).toContain('\n  8: ### Details');
    expect(text).not.toContain('not a heading');
    expect(text).not.toContain('#no space');
  });
});

describe('the outline of a JS or TS file', () => {
  it('lists top-level functions, classes and exports with their line numbers, not indented ones', () => {
    const p = file(
      'tool.ts',
      [
        "import fs from 'node:fs';",
        'const local = 1;',
        'export const LIMIT = 60;',
        'function helper() {',
        '  function inner() {}',
        '}',
        'export async function run(a: string) {',
        '  return a;',
        '}',
        'export default class Runner {}',
        'export interface Shape { a: number }',
        'module.exports = { helper };',
      ].join('\n'),
    );
    const text = O.withOutline(REASON, p);
    expect(text).toContain('JS/TS');
    expect(text).toContain('\n  3: export const LIMIT = 60;');
    expect(text).toContain('\n  4: function helper() {');
    expect(text).toContain('\n  7: export async function run(a: string) {');
    expect(text).toContain('\n  10: export default class Runner {}');
    expect(text).toContain('\n  11: export interface Shape { a: number }');
    expect(text).toContain('\n  12: module.exports = { helper };');
    expect(text).not.toContain('inner');
    expect(text).not.toContain('const local');
    expect(text).not.toContain('import fs');
  });

  it('covers .js, .mjs and .cjs too, and SQL create statements', () => {
    for (const ext of ['js', 'mjs', 'cjs', 'jsx', 'tsx'])
      expect(O.withOutline(REASON, file(`a.${ext}`, 'x\nfunction go() {}\n')), ext).toContain('\n  2: function go() {}');
    const sql = O.withOutline(REASON, file('m.sql', '-- note\ncreate or replace function public.f() returns int\nselect 1;\nCREATE TABLE t (id int);\n'));
    expect(sql).toContain('SQL');
    expect(sql).toContain('\n  2: create or replace function public.f() returns int');
    expect(sql).toContain('\n  4: CREATE TABLE t (id int);');
  });

  it('cuts a very long line so one entry cannot fill the message', () => {
    const text = O.withOutline(REASON, file('long.ts', `export const X = '${'a'.repeat(500)}';\n`));
    const entry = text.split('\n').find((l: string) => l.startsWith('  1: '));
    expect(entry.length).toBeLessThanOrEqual(O.ENTRY_CHARS + 10);
    expect(entry.endsWith('…')).toBe(true);
  });
});

describe('the cap on entries', () => {
  it('shows at most OUTLINE_MAX entries and then a "… more" marker with the count', () => {
    expect(O.OUTLINE_MAX).toBe(60);
    const lines = Array.from({ length: 85 }, (_, i) => `## Part ${i + 1}`);
    const text = O.withOutline(REASON, file('many.md', lines.join('\n')));
    const entries = text.split('\n').filter((l: string) => /^ {2}\d+: /.test(l));
    expect(entries).toHaveLength(60);
    expect(entries[59]).toBe('  60: ## Part 60');
    expect(text).not.toContain('Part 61');
    expect(text.split('\n').at(-1)).toBe('  … 25 more (Grep -n for the rest)');
  });

  it('has no marker when everything fits', () => {
    const text = O.withOutline(REASON, file('few.md', '# A\n## B\n'));
    expect(text).not.toContain('more (Grep');
  });
});

describe('fails open: the old text, byte for byte', () => {
  it('a binary file (a NUL byte in the scanned part)', () => {
    expect(O.withOutline(REASON, file('bin.ts', Buffer.from([0x65, 0x78, 0x70, 0x00, 0x0a, 0x66])))).toBe(REASON);
  });

  it('an unknown file type', () => {
    expect(O.withOutline(REASON, file('data.csv', '# looks like a heading\nfunction x() {}\n'))).toBe(REASON);
    expect(O.withOutline(REASON, file('Makefile', 'export X = 1\n'))).toBe(REASON);
  });

  it('a file that cannot be read: missing, a folder, or a read that throws', () => {
    expect(O.withOutline(REASON, path.join(folder, 'gone.md'))).toBe(REASON);
    const dir = path.join(folder, 'dir.md');
    fs.mkdirSync(dir);
    expect(O.withOutline(REASON, dir)).toBe(REASON);
    const broken = { statSync: () => ({ size: 10, isFile: () => true }), openSync: () => { throw new Error('EACCES'); } };
    expect(O.withOutline(REASON, file('ok.md', '# A\n'), { fs: broken })).toBe(REASON);
  });

  it('nothing found', () => {
    expect(O.withOutline(REASON, file('plain.ts', 'x\n'.repeat(50)))).toBe(REASON);
  });

  it('the setting off gives the old text even for a file with headings', () => {
    const p = file('guide.md', '# Guide\n## Part\n');
    expect(O.withOutline(REASON, p, { enabled: false })).toBe(REASON);
    expect(O.withOutline(REASON, p, { enabled: true })).not.toBe(REASON);
  });

  it('a time budget that runs out', () => {
    const p = file('slow.md', Array.from({ length: 2000 }, (_, i) => `# H${i}`).join('\n'));
    let t = 0;
    // Every call to the clock moves it on by 100 ms, so the first check is already over the budget.
    expect(O.withOutline(REASON, p, { now: () => (t += 100), timeMs: 50 })).toBe(REASON);
  });

  it('never throws, whatever it is given', () => {
    expect(O.withOutline(REASON, undefined)).toBe(REASON);
    expect(O.withOutline(REASON, 42 as unknown as string)).toBe(REASON);
    expect(O.withOutline(REASON, file('x.md', '# A\n'), { fs: null })).toBe(REASON);
  });
});

describe('through the hook (hook-read-guard.mjs)', () => {
  const ORCH = path.resolve(__dirname, '..', '..');
  /** Runs the read guard with a temporary queue and config, and returns the denial text ('' when nothing is written). */
  function deny(target: string, readGuard: Record<string, unknown> | undefined) {
    fs.writeFileSync(path.join(folder, 'queue.json'), JSON.stringify({ tasks: [] }));
    fs.writeFileSync(path.join(folder, 'queue.config.json'), JSON.stringify({ baseBranch: 'trunk', ...(readGuard ? { readGuard } : {}) }));
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { spawnSync } = require('node:child_process');
    const r = spawnSync(process.execPath, [path.join(ORCH, 'hook-read-guard.mjs')], {
      input: JSON.stringify({ agent_type: 'track', agent_id: 'o1', tool_name: 'Read', tool_input: { file_path: target } }),
      encoding: 'utf8',
      cwd: folder,
      env: {
        ...process.env,
        QUEUE_ROOT: folder,
        QUEUE_FOLDER: folder,
        QUEUE_GIT: folder,
        QUEUE_CONFIG: path.join(folder, 'queue.config.json'),
        QUEUE_TIME_LOG: path.join(folder, 'times.jsonl'),
        READ_HINT_STATE: path.join(folder, 'hint'),
      },
    });
    expect(r.status).toBe(0);
    return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason : '';
  }
  const OLD = 'readGuard: the file has 2501 lines (over 2000). Read in excerpts: Grep -n for what you need, then Read with offset and limit around the match.';

  it('on by default: the denial of a long Markdown file carries its outline', () => {
    const p = file('long.md', `# Title\n${'text\n'.repeat(2498)}## End\n`);
    const reason = deny(p, undefined);
    expect(reason.startsWith(`${OLD}\nOutline (Markdown headings`)).toBe(true);
    expect(reason).toContain('\n  1: # Title');
    expect(reason).toContain('\n  2500: ## End');
  });

  it('readGuard.outline false gives the old denial byte for byte', () => {
    const p = file('long.md', `# Title\n${'text\n'.repeat(2498)}## End\n`);
    expect(deny(p, { outline: false })).toBe(OLD);
  });

  it('a long file of an unknown type keeps the old denial', () => {
    expect(deny(file('long.txt', `# Title\n${'text\n'.repeat(2499)}`), undefined)).toBe(OLD);
  });
});

describe('the cap on scan size', () => {
  it('scans at most SCAN_BYTES: a larger file gives the old text, a file at the cap gets its outline', () => {
    expect(O.SCAN_BYTES).toBe(1024 * 1024);
    const head = '# Top\n';
    const big = file('big.md', head + 'x'.repeat(O.SCAN_BYTES)); // one byte per char, so over the cap
    expect(O.withOutline(REASON, big)).toBe(REASON);
    const small = file('small.md', head + 'x'.repeat(200));
    expect(O.withOutline(REASON, small, { scanBytes: 300 })).toContain('  1: # Top');
    expect(O.withOutline(REASON, small, { scanBytes: 100 })).toBe(REASON);
  });

  it('reads no more than the cap even when the file grew after stat', () => {
    const p = file('grow.md', '# A\n' + 'y'.repeat(500));
    let asked = 0;
    const spy = {
      ...fs,
      statSync: () => ({ size: 10, isFile: () => true }), // claims a small file
      readSync: (fd: number, buf: Buffer, off: number, len: number, pos: number) => {
        asked = Math.max(asked, len);
        return fs.readSync(fd, buf, off, len, pos);
      },
    };
    expect(O.withOutline(REASON, p, { fs: spy, scanBytes: 100 })).toBe(REASON);
    expect(asked).toBeLessThanOrEqual(101);
  });
});
