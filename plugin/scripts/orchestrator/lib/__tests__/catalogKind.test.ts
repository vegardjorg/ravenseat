// =============================================================
// catalogKind.test.ts: the `kind` and `except` fields of a catalog entry (roadmap 0å KD-0,
// plans/katalog-design-stack-avhengigheter-2026-11-18.md § 2 and § 3.2).
//
// Locks: (1) one field `kind` with one set of values: decision (the default when the line is missing), design, stack,
// dependency and not-building (roadmap 0f's kind, the same field); an unknown value is an error, and status
// not-building still needs kind not-building; (2) `except` is a list of path patterns with the same rules as `paths`,
// on every kind; (3) both bind: kind and except are in the fingerprint, so a track cannot turn an accepted stack entry
// into a plain note or widen what a rule skips without a new accept, while an entry without them keeps the fingerprint
// it always had (old records stay valid); (4) except is honoured where paths are read: the check rules at receive, the
// tree hits of `catalog check`, the excerpt for a task's file, and covers(); (5) a proposal can be written with a kind
// and except and reads back the same; (6) boardGroups gives the board's catalog list grouped by kind.
// Pure: no file system except the temporary folder readCatalog reads.
// =============================================================
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const C = require('../catalog.js') as any;
const CC = require('../catalogChecks.js') as any;
const CE = require('../catalogExcerpt.js') as any;
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

const temporary: string[] = [];
afterAll(() => {
  for (const m of temporary) fs.rmSync(m, { recursive: true, force: true });
});

function folder(files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-catalog-kind-'));
  temporary.push(root);
  for (const [name, text] of Object.entries(files)) {
    const f = path.join(root, ...name.split('/'));
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
  }
  return root;
}

const HEX = {
  forbid: '#[0-9a-fA-F]{6}\\b',
  hit: ['  color: #1a73e8;'],
  miss: ['color: var(--color-primary);'],
  mode: 'warn',
};

const entry = (extra: string[] = []) =>
  [
    '---',
    'id: D-0003',
    'title: Colours only from tokens',
    'status: proposed',
    'paths: ["ui/**"]',
    'invariant: UI code uses only colour tokens; a hex colour stands only in the token file.',
    ...extra,
    'supersedes: null',
    'plan: null',
    '---',
    'Why.',
    '',
  ].join('\n');

describe('one kind field', () => {
  it('has one set of values, with decision as the default and not-building from roadmap 0f', () => {
    expect(C.KINDS).toEqual(['decision', 'design', 'stack', 'dependency', 'not-building']);
    expect(C.parseDecision('D-0003-x.md', entry()).decision.kind).toBe('decision');
    for (const k of ['decision', 'design', 'stack', 'dependency']) {
      // A stack entry needs uses or stack (KD-2, lib/__tests__/catalogStack.test.ts).
      const r = C.parseDecision('D-0003-x.md', entry([`kind: ${k}`, ...(k === 'stack' ? ['uses: {"job": "tests", "tool": "vitest"}'] : [])]));
      expect(r.errors, k).toEqual([]);
      expect(r.decision.kind).toBe(k);
    }
  });

  it('names an unknown kind, and status not-building still needs kind not-building', () => {
    expect(C.parseDecision('D-0003-x.md', entry(['kind: theme'])).errors.join('\n')).toMatch(/kind must be one of decision, design, stack, dependency, not-building/);
    const nb = entry(['kind: design']).replace('status: proposed', 'status: not-building');
    expect(C.parseDecision('D-0003-x.md', nb).errors.join('\n')).toMatch(/status not-building needs kind not-building/);
  });
});

describe('except', () => {
  it('is a list of path patterns with the rules of paths, on every kind', () => {
    const ok = C.parseDecision('D-0003-x.md', entry(['except: ["ui/tokens.css"]']));
    expect(ok.errors).toEqual([]);
    expect(ok.decision.except).toEqual(['ui/tokens.css']);
    expect(C.parseDecision('D-0003-x.md', entry()).decision.except).toEqual([]);
    expect(C.parseDecision('D-0003-x.md', entry(['except: "ui/tokens.css"'])).errors.join('\n')).toMatch(/except must be a list of path patterns/);
    expect(C.parseDecision('D-0003-x.md', entry(['except: ["../tokens.css"]'])).errors.join('\n')).toMatch(/except: \.\.\/tokens\.css: \.\. and absolute paths/);
  });

  it('covers: in paths and not in except', () => {
    const d = { paths: ['ui/**'], except: ['ui/tokens.css'] };
    expect(C.covers(d, 'ui/board.css')).toBe(true);
    expect(C.covers(d, 'ui/tokens.css')).toBe(false);
    expect(C.covers(d, 'lib/x.js')).toBe(false);
    expect(C.covers({ paths: ['ui/**'] }, 'ui/tokens.css')).toBe(true);
  });

  it('the check rules at receive skip an excepted file', () => {
    const d = { ...C.parseDecision('D-0003-x.md', entry(['except: ["ui/tokens.css"]'])).decision, check: HEX };
    const diff = [
      'diff --git a/ui/tokens.css b/ui/tokens.css',
      '--- a/ui/tokens.css',
      '+++ b/ui/tokens.css',
      '@@ -1 +1,2 @@',
      ' :root {',
      '+  --color-primary: #1a73e8;',
      'diff --git a/ui/board.css b/ui/board.css',
      '--- a/ui/board.css',
      '+++ b/ui/board.css',
      '@@ -1 +1,2 @@',
      ' .x {',
      '+  color: #1a73e8;',
      '',
    ].join('\n');
    const r = CC.assess({ decisions: [d], ledger: C.emptyLedger(), diff });
    expect(r.rules).toHaveLength(1);
    expect(r.rules[0].hits).toEqual([{ file: 'ui/board.css', line: 2 }]);
  });

  it('catalog check does not count tree hits in an excepted file', () => {
    const root = folder({
      'decisions/D-0003-x.md': entry([
        'except: ["ui/tokens.css"]',
        'check:',
        '  forbid: "#[0-9a-fA-F]{6}\\\\b"',
        '  hit: ["  color: #1a73e8;"]',
        '  miss: ["color: var(--color-primary);"]',
      ]),
    });
    const cat = C.readCatalog(root);
    expect(cat.errors).toEqual([]);
    const r = C.checkCatalog(cat, {
      files: ['ui/tokens.css', 'ui/board.css'],
      readFile: (f: string) => (f === 'ui/tokens.css' ? ':root { --color-primary: #1a73e8; }\n' : '.x { color: var(--color-primary); }\n'),
      ledger: C.emptyLedger(),
    });
    expect(r.warnings.join('\n')).not.toMatch(/already hits/);
  });

  it('the excerpt leaves an entry out for a task that owns only excepted files', () => {
    const cat = C.readCatalog(folder({ 'decisions/D-0003-x.md': entry(['except: ["ui/tokens.css"]']) }));
    expect(CE.excerpt(cat, { owned_files: ['ui/tokens.css'] }, { ledger: C.emptyLedger() })).toBeNull();
    expect(CE.excerpt(cat, { owned_files: ['ui/board.css'] }, { ledger: C.emptyLedger() })?.lines.join('\n')).toMatch(/D-0003/);
  });
});

describe('the fingerprint', () => {
  const accepted = (extra: string[]) => C.parseDecision('D-0003-x.md', C.acceptText(entry(extra), { by: 'owner' }).text).decision;

  it('holds kind and except, so changing either needs a new accept', () => {
    const d = accepted(['kind: design', 'except: ["ui/tokens.css"]']);
    const ledger = C.recordAccept(C.emptyLedger(), d, { by: 'owner', now: '2026-11-20T10:00:00.000Z' });
    expect(C.effectiveStatus(d, ledger)).toBe('accepted');
    expect(C.effectiveStatus({ ...d, kind: 'decision' }, ledger)).toBe('unconfirmed');
    expect(C.effectiveStatus({ ...d, except: ['ui/**'] }, ledger)).toBe('unconfirmed');
    expect(C.effectiveStatus({ ...d, except: [] }, ledger)).toBe('unconfirmed');
  });

  it('is unchanged for an entry without kind and except, so the old records stay valid', () => {
    const d = accepted([]);
    const old = { id: d.id, invariant: d.invariant, paths: d.paths, check: d.check };
    expect(C.fingerprint(d)).toBe(C.fingerprint(old));
    expect(C.fingerprint({ ...d, kind: 'decision', except: [] })).toBe(C.fingerprint(old));
  });
});

describe('a proposal with a kind', () => {
  it('writes kind and except and reads back the same', () => {
    const r = C.proposalFile({ id: 'D-0004', title: 'Colours from tokens', invariant: 'Only tokens.', paths: ['ui/**'], kind: 'design', except: ['ui/tokens.css'] });
    expect(r.errors).toEqual([]);
    expect(r.text).toContain('kind: design\n');
    expect(r.text).toContain('except: ["ui/tokens.css"]\n');
    const d = C.parseDecision(r.name, r.text).decision;
    expect(d).toMatchObject({ kind: 'design', except: ['ui/tokens.css'] });
  });

  it('writes no kind line for a plain decision, as before', () => {
    const r = C.proposalFile({ id: 'D-0004', title: 'A choice', invariant: 'Only this.', paths: ['lib/**'] });
    expect(r.text).not.toMatch(/^kind:/m);
    expect(r.text).not.toMatch(/^except:/m);
  });
});

describe('boardGroups', () => {
  it('groups the entries by kind for the board, without not-building and superseded ones', () => {
    const root = folder({
      'decisions/D-0001-a.md': entry(['kind: design']).replace('D-0003', 'D-0001'),
      'decisions/D-0002-b.md': entry([]).replace('D-0003', 'D-0002'),
      'decisions/D-0003-c.md': entry(['kind: stack', 'uses: {"job": "tests", "tool": "vitest"}']),
      'decisions/D-0004-d.md': entry([]).replace('D-0003', 'D-0004').replace('status: proposed', 'status: superseded'),
      'decisions/D-0005-e.md': ['---', 'id: D-0005', 'title: No keepalive', 'status: proposed', 'kind: not-building', 'keywords: ["keepalive"]', '---', 'Why.', ''].join('\n'),
    });
    const g = C.boardGroups(C.readCatalog(root), C.emptyLedger());
    expect(g.map((x: any) => x.kind)).toEqual(['design', 'stack', 'decision']);
    expect(g[0]).toMatchObject({ title: 'Design language', entries: [{ id: 'D-0001', status: 'proposed' }] });
    expect(g[2].entries.map((e: any) => e.id)).toEqual(['D-0002']);
    // KD-3: the stack card gets the choice; the other kinds get none.
    expect(g[1].entries[0]).toMatchObject({ id: 'D-0003', uses: { job: 'tests', tool: 'vitest' }, alternatives: [] });
    expect(g[0].entries[0]).toMatchObject({ uses: null, alternatives: [] });
  });

  it('a stack entry carries what it was chosen over', () => {
    const root = folder({ 'decisions/D-0003-c.md': entry(['kind: stack', 'uses: {"job": "tests", "tool": "vitest"}', 'alternatives: ["jest", "mocha"]']) });
    expect(C.boardGroups(C.readCatalog(root), C.emptyLedger())[0].entries[0].alternatives).toEqual(['jest', 'mocha']);
  });
});
