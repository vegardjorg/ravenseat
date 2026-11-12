// =============================================================
// instructionsCli.test.ts: `ravenseat instructions [--json] [--plan]` (cli/instructions.mjs) and its rules of thumb
// (lib/instructionAdvice.js).
//
// Why: the helper proposes a split of Claude's instructions with simple rules a person can check (paths in one folder:
// a rule with paths:, a numbered procedure: a skill, a folder layout: something Claude reads from the code, the same
// line in two files: one copy). It only reads and proposes: it never writes CLAUDE.md or .claude/, and --plan writes one
// file in the queue's data folder. Temporary projects only.
// =============================================================
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const A = require('../instructionAdvice.js') as any;
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

const QUEUE = path.resolve(__dirname, '..', '..', 'queue.mjs');
const temporary: string[] = [];
afterAll(() => {
  for (const d of temporary) fs.rmSync(d, { recursive: true, force: true });
});

const advise = (text: string) => A.sectionsOf(text).map((s: any) => ({ heading: s.heading, ...A.adviseSection(s) }));

describe('instructionAdvice: one suggestion per section', () => {
  it('a section whose paths are under one folder is proposed as a rule with paths: <folder>/**', () => {
    const text = [
      '# Database',
      '',
      'Migrations live in `database/migrations/` and the policies in `database/policies/rls.sql`.',
      'Edge functions are in `database/functions/` and read `database/config.toml`.',
      'Never edit a migration that has been pushed; write a new one with a higher number instead of changing the old one.',
      '',
    ].join('\n');
    const [s] = advise(text);
    expect(s).toMatchObject({ heading: 'Database', action: 'rule', paths: 'database/**', file: '.claude/rules/database.md' });
    expect(s.why).toContain('4 of 4 paths are under database/');
  });

  it('paths from several folders stay in the root', () => {
    const [s] = advise('# Layers\n\nUI in `app/x.tsx` calls `hooks/y.ts`, which calls `services/z.ts`. Keep this order everywhere in the code base.\n'.repeat(3));
    expect(s.action).toBe('keep');
  });

  it('a numbered procedure is proposed as a skill', () => {
    const text = '## Release steps\n\n1. Run the full tests.\n2. Bump the version in the manifest.\n3. Write the changelog entry.\n4. Tag the release and push the tag.\n' + 'More detail on each step follows here. '.repeat(5) + '\n';
    expect(advise(text)[0]).toMatchObject({ heading: 'Release steps', action: 'skill' });
  });

  it('a folder layout is something Claude can read from the code', () => {
    const text = '## Folder structure\n\n```\nsrc/\n├── app/\n└── lib/\n```\n' + 'Each folder has a purpose that is described in more words here. '.repeat(4) + '\n';
    expect(advise(text)[0]).toMatchObject({ action: 'delete' });
  });

  it('the text before the first heading is a section of its own, and a short section is kept as it is', () => {
    const list = A.sectionsOf('Intro line.\n# A\nShort.\n');
    expect(list.map((s: any) => s.heading)).toEqual(['(before the first heading)', 'A']);
    expect(A.adviseSection(list[1]).action).toBe('keep');
  });

  it('a heading inside a code block is not a section', () => {
    expect(A.sectionsOf('# A\n```\n# not a heading\n```\n').map((s: any) => s.heading)).toEqual(['A']);
  });
});

describe('instructionAdvice: duplicates', () => {
  it('the same line in two files is reported once, with both places', () => {
    const d = A.duplicates([
      { rel: 'CLAUDE.md', raw: '# Root\n- Never push straight to the main branch, ever.\nOther.\n' },
      { rel: '.claude/rules/git.md', raw: 'Intro\n\n* never push  straight to the main branch, ever\n' },
    ]);
    expect(d).toEqual([{ line: '- Never push straight to the main branch, ever.', at: ['CLAUDE.md:2', '.claude/rules/git.md:3'] }]);
  });

  it('short lines, headings and lines inside one file are not duplicates', () => {
    expect(A.duplicates([{ rel: 'a', raw: 'Short line.\n# A heading that is long enough to count\n' }, { rel: 'b', raw: 'Short line.\n# A heading that is long enough to count\n' }])).toEqual([]);
    expect(A.duplicates([{ rel: 'a', raw: 'The same long line repeated in one file.\nThe same long line repeated in one file.\n' }])).toEqual([]);
  });
});

/** A temporary project with a queue (data folder outside the repo) and the given files. */
function project(files: Record<string, string>, { queue = true } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'instr-cli-'));
  temporary.push(base);
  const repo = path.join(base, 'repo');
  const data = path.join(base, 'data');
  fs.mkdirSync(repo);
  fs.mkdirSync(data);
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
    fs.writeFileSync(path.join(repo, f), text);
  }
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  const configFile = path.join(data, 'queue.config.json');
  fs.writeFileSync(configFile, JSON.stringify({ baseBranch: 'main', mode: 'lite' }));
  if (queue) fs.writeFileSync(path.join(data, 'queue.json'), JSON.stringify({ tasks: [], projects: {} }));
  const env = {
    ...process.env,
    QUEUE_ROOT: repo,
    QUEUE_GIT: repo,
    QUEUE_FOLDER: data,
    QUEUE_CONFIG: configFile,
    QUEUE_TIME_LOG: path.join(data, 'times.jsonl'),
    RAVENSEAT_CLAUDE_DIR: path.join(base, 'claude'),
    RAVENSEAT_MANAGED_CLAUDE_MD: '',
    RAVENSEAT_INSTRUCTIONS_TOP: repo,
  };
  const run = (...args: string[]) => {
    const r = spawnSync(process.execPath, [QUEUE, 'instructions', ...args], { encoding: 'utf8', env, cwd: repo });
    return { code: r.status, out: r.stdout ?? '', all: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  return { base, repo, data, run };
}

/** Every file under a folder, with its content, as one comparable snapshot. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const it of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, it.name);
      if (it.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = fs.readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return out;
}

const BIG = [
  '# Project',
  '',
  'Rules that apply everywhere: never commit secrets.',
  '',
  '## Database',
  '',
  'Migrations live in `database/migrations/` and policies in `database/policies/a.sql` and `database/policies/b.sql`.',
  'x'.repeat(400),
  '',
  '@CLAUDE.queue.md',
  '',
].join('\n');

describe('ravenseat instructions', () => {
  it('prints the table, the share per scope and a suggestion per section, and changes nothing', () => {
    const p = project({ 'CLAUDE.md': BIG, 'CLAUDE.queue.md': 'Queue rules for Claude.\n', '.claude/rules/db.md': '---\npaths: database/**\n---\nDB\n' });
    const before = snapshot(p.base);
    const r = p.run();
    expect(r.code).toBe(0);
    expect(r.out).toContain('Loaded at the start of every session, track and subagent');
    expect(r.out).toMatch(/CLAUDE\.queue\.md +\(Ravenseat, imported by CLAUDE\.md\)/);
    expect(r.out).toMatch(/your ~\/\.claude +0/);
    expect(r.out).toContain('Loaded when Claude works on matching files');
    expect(r.out).toContain('.claude/rules/db.md (paths: database/**)');
    expect(r.out).toContain('move to .claude/rules/database.md with paths: database/**');
    expect(r.out).toContain('Nothing was changed');
    expect(snapshot(p.base)).toEqual(before);
  });

  it('--json gives the same picture as data', () => {
    const p = project({ 'CLAUDE.md': BIG, 'CLAUDE.queue.md': 'Q\n' });
    const j = JSON.parse(p.run('--json').out);
    expect(j.total.files).toBe(2);
    expect(j.byScope.ravenseat).toBe(2);
    expect(j.sections.find((s: any) => s.heading === 'Database')).toMatchObject({ action: 'rule', paths: 'database/**' });
    expect(j.limits).toEqual({ mode: 'warn', maxLines: 200, maxChars: 40000 });
  });

  it('--plan writes one file in the data folder and never anything outside it', () => {
    const p = project({ 'CLAUDE.md': BIG, 'CLAUDE.queue.md': 'Q\n', '.claude/rules/x.md': 'X\n' });
    const repoBefore = snapshot(p.repo);
    const dataBefore = snapshot(p.data);
    const r = p.run('--plan');
    expect(r.code).toBe(0);
    expect(snapshot(p.repo)).toEqual(repoBefore);
    const dataAfter = snapshot(p.data);
    expect(Object.keys(dataAfter).filter((f) => !(f in dataBefore))).toEqual(['instructions-plan.md']);
    for (const f of Object.keys(dataBefore)) expect(dataAfter[f], f).toBe(dataBefore[f]);
    const plan = dataAfter['instructions-plan.md'];
    expect(plan).toContain('## Text to give Claude in your own session');
    expect(plan).toContain('Read an existing file there');
    expect(r.out).toContain('instructions-plan.md');
  });

  it('--plan before ravenseat init prints the plan instead of saving it', () => {
    const p = project({ 'CLAUDE.md': BIG }, { queue: false });
    const before = snapshot(p.base);
    const r = p.run('--plan');
    expect(r.code).toBe(0);
    expect(r.out).toContain('## Text to give Claude in your own session');
    expect(r.out).toContain('not saved');
    expect(snapshot(p.base)).toEqual(before);
  });
});
