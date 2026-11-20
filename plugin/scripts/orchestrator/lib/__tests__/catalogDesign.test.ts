// =============================================================
// catalogDesign.test.ts: design entries in the catalog (roadmap 0å KD-1,
// plans/katalog-design-stack-avhengigheter-2026-11-18.md § 3).
//
// Locks: (1) a design entry names where its tokens live in `source` (one path or a list, each a path with an optional
// #anchor), never a copy of the tokens; a list source is only for kind design; (2) the excerpt gives the design entries
// that meet the task's files their own "Design language" section, with the status and the source, in the mission and
// in the review package (which reviewer-design reads); a plain choice stays under its old heading; (3) designDraft
// finds a token file (a CSS file with :root and --color-, tailwind.config.*, tokens.json, theme.ts) and proposes one
// design entry with a colour rule whose examples pass, the token file in except; nothing without a token file;
// (4) the colour rule's examples: a hex colour or rgb() in a value hits, an issue number, an anchor, a CSS id selector
// and color-mix(in srgb, ...) do not; (5) Ravenseat's own catalog holds the board's design language as proposed
// entries that read without errors and whose rule hits nothing in the board files today.
// Pure except the temporary folder readCatalog reads and the repo's own catalog folder.
// =============================================================
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-catalog-design-'));
  temporary.push(root);
  for (const [name, text] of Object.entries(files)) {
    const f = path.join(root, ...name.split('/'));
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
  }
  return root;
}

const design = (extra: string[] = [], id = 'D-0001') =>
  [
    '---',
    `id: ${id}`,
    'title: Colours only from tokens',
    'status: proposed',
    'kind: design',
    'source: ["ui/tokens.css", "lib/theme.js#PALETTE"]',
    'paths: ["ui/**"]',
    'except: ["ui/tokens.css"]',
    'invariant: UI code uses only colour tokens; a hex colour stands only in the token file.',
    ...extra,
    '---',
    'Why.',
    '',
  ].join('\n');

describe('source on a design entry', () => {
  it('is a path or a list of paths with an optional #anchor', () => {
    const r = C.parseDecision('D-0001-x.md', design());
    expect(r.errors).toEqual([]);
    expect(r.decision.source).toEqual(['ui/tokens.css', 'lib/theme.js#PALETTE']);
    const one = C.parseDecision('D-0001-x.md', design().replace(/^source: .*$/m, 'source: ui/tokens.css'));
    expect(one.errors).toEqual([]);
    expect(one.decision.source).toBe('ui/tokens.css');
  });

  it('names a bad path in the list, and a list on another kind', () => {
    expect(C.parseDecision('D-0001-x.md', design().replace('"ui/tokens.css", ', '"../tokens.css", ')).errors.join('\n')).toMatch(/source: \.\.\/tokens\.css/);
    const plain = design().replace('kind: design\n', '');
    expect(C.parseDecision('D-0001-x.md', plain).errors.join('\n')).toMatch(/source as a list is for kind design/);
  });
});

describe('the Design language section of the excerpt', () => {
  const cat = () =>
    C.readCatalog(
      folder({
        'decisions/D-0001-colours.md': design(),
        'decisions/D-0002-plain.md': ['---', 'id: D-0002', 'title: Plain', 'status: proposed', 'paths: ["ui/**"]', 'invariant: UI code calls the service layer.', '---', ''].join('\n'),
      }),
    );

  it('gives design entries their own section with status and source, in the mission and the review package', () => {
    for (const form of ['mission', 'review']) {
      const x = CE.excerpt(cat(), { owned_files: ['ui/board.css'] }, { ledger: C.emptyLedger(), form });
      const text = x.lines.join('\n');
      expect(text, form).toMatch(/\*\*Design language\*\*/);
      expect(text).toMatch(/D-0001 \(proposed; tokens in ui\/tokens\.css, lib\/theme\.js#PALETTE\): UI code uses only colour tokens/);
      // The plain choice keeps its own heading.
      expect(text).toMatch(/Proposed design choices[\s\S]*D-0002/);
      expect(text.indexOf('D-0001')).toBeLessThan(text.indexOf('Proposed design choices'));
    }
  });

  it('says when a design entry holds, and the review form tells reviewer-design what to check', () => {
    const c = cat();
    const d = c.decisions[0].decision;
    const accepted = { ...c, decisions: [{ ...c.decisions[0], decision: { ...d, status: 'accepted' } }, c.decisions[1]] };
    const ledger = C.recordAccept(C.emptyLedger(), { ...d, status: 'accepted' }, { by: 'owner' });
    const x = CE.excerpt(accepted, { owned_files: ['ui/board.css'] }, { ledger, form: 'review' });
    const text = x.lines.join('\n');
    expect(text).toMatch(/D-0001 \(holds; tokens in/);
    expect(text).toMatch(/reviewer-design/);
    expect(x.counts.design).toBe(1);
  });

  it('a task outside the paths gets no design section', () => {
    expect(CE.excerpt(cat(), { owned_files: ['lib/x.js'] }, { ledger: C.emptyLedger() })).toBeNull();
  });
});

describe('designDraft', () => {
  it('finds a CSS token file and proposes a colour rule for its folder, the token file excepted', () => {
    const files = ['web/src/tokens.css', 'web/src/app.css', 'README.md'];
    const read = (f: string) => (f === 'web/src/tokens.css' ? ':root {\n  --color-primary: #1a73e8;\n}\n' : '.x { color: var(--color-primary); }\n');
    const d = C.designDraft({ files, readFile: read });
    expect(d).toMatchObject({ kind: 'design', paths: ['web/src/**'], except: ['web/src/tokens.css'], source: ['web/src/tokens.css'] });
    const r = C.proposalFile({ id: 'D-0001', ...d });
    expect(r.errors).toEqual([]);
    expect(r.text).toMatch(/\nkind: design\n/);
    expect(r.text).toMatch(/\ncheck:\n  forbid: /);
    expect(C.parseDecision(r.name, r.text).decision.check.mode).toBe('warn');
  });

  it('knows tailwind.config, tokens.json and theme.ts; nothing without a token file', () => {
    expect(C.designDraft({ files: ['tailwind.config.ts', 'src/a.tsx'], readFile: () => '' })?.source).toEqual(['tailwind.config.ts']);
    expect(C.designDraft({ files: ['app/theme.ts'], readFile: () => '' })?.paths).toEqual(['app/**']);
    expect(C.designDraft({ files: ['design/tokens.json'], readFile: () => '' })?.except).toEqual(['design/tokens.json']);
    expect(C.designDraft({ files: ['src/a.css'], readFile: () => '.a { color: red; }' })).toBeNull();
  });
});

describe('the colour rule', () => {
  it('hits a hex colour or rgb() in a value, not an issue number, an anchor, an id selector or srgb', () => {
    const { rule, errors } = CC.ruleOf(C.COLOUR_RULE);
    expect(errors).toEqual([]);
    for (const l of ['  color: #1a73e8;', '  border: 1px solid #ccc;', "const c = '#ff0000';", 'background: rgba(0,0,0,.4)', 'color: hsl(210 50% 40%)'])
      expect(CC.lineHits(rule, l), l).toBe(true);
    for (const l of ['color: var(--color-primary);', 'see issue #123 in the tracker', '<a href="#add">', '#fed {', 'mix: color-mix(in srgb, var(--a) 8%, transparent);', '&#123456;'])
      expect(CC.lineHits(rule, l), l).toBe(false);
  });
});

describe("Ravenseat's own catalog", () => {
  const repo = path.resolve(__dirname, '..', '..', '..', '..', '..');
  const dir = path.join(repo, ...C.DIR.split('/'));

  // D-0001 (board colours only from the tokens) was accepted by the owner on 2026-11-20; the others stay proposed.
  it('holds the board design language as design entries without errors', () => {
    const cat = C.readCatalog(dir);
    expect(cat.exists).toBe(true);
    expect(cat.errors).toEqual([]);
    const ds = cat.decisions.map((x: any) => x.decision);
    const designs = ds.filter((d: any) => d.kind === 'design');
    expect(designs.length).toBeGreaterThanOrEqual(2);
    for (const d of designs) {
      expect(d.status).toBe(d.id === 'D-0001' ? 'accepted' : 'proposed');
      expect(d.paths.some((p: string) => p.startsWith('plugin/scripts/orchestrator/queue-board/'))).toBe(true);
    }
  });

  it('the colour rule hits nothing in the board files today', () => {
    const files = execFileSync('git', ['-C', repo, 'ls-files', 'plugin/scripts/orchestrator/queue-board'], { encoding: 'utf8' }).split('\n').filter(Boolean);
    const r = C.checkCatalog(C.readCatalog(dir), {
      files,
      readFile: (f: string) => {
        try {
          return fs.readFileSync(path.join(repo, f), 'utf8');
        } catch {
          return null;
        }
      },
      ledger: C.emptyLedger(),
    });
    // The empty ledger has no acceptance record for D-0001, so the check says "did not accept this version". That is
    // the ledger's job, not the colour rule's: this test only asserts that no board file breaks the rule.
    expect(r.errors.filter((e: string) => !/did not accept this version/.test(e))).toEqual([]);
    expect(r.warnings.join('\n')).not.toMatch(/already hits/);
  });
});
