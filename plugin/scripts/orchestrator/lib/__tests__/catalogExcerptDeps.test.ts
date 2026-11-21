// =============================================================
// catalogExcerptDeps.test.ts: the dependency rows in the catalog excerpt (lib/catalogExcerpt.js with
// lib/catalogDeps.js depRows, roadmap 0å KD-3, plans/katalog-design-stack-avhengigheter-2026-11-18.md § 5.2).
//
// Locks: (1) a row says the installed version, how it is known (locked, installed, pinned), the local file to read and
// the docs link, and the section carries the one rule (read the installed types or README, not memory); (2) without
// dependency rows the text is byte for byte what it was; (3) under a tight cap the dependency rows are cut before the
// reuse rows, and the heading counts them; (4) forTask reads the tree (the manifest, the lockfile, node_modules and the
// task's files) and gives the rows while catalog.depsExcerpt is on, none when it is off; (5) catalog.depsExcerpt is on
// by default, in STANDARD, in the settings registry and in the docs' settings table.
// =============================================================
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const C = require('../catalog.js') as any;
const X = require('../catalogExcerpt.js') as any;
const QC = require('../queueConfig.js') as any;
const REG = require('../settingsRegistry.js') as any;
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

const temporary: string[] = [];
afterAll(() => {
  for (const m of temporary) fs.rmSync(m, { recursive: true, force: true });
});

const STACK = ['# Stack', '', '## Prefer', '', '- validation: zod', '', ''].join('\n');
const REUSE = ['| Purpose | Symbol | File |', '|---|---|---|', '| Normalize a repo path | norm | lib/paths.js |', ''].join('\n');
const cat = () => ({ exists: true, dir: 'x', stack: C.parseStack(STACK), reuse: C.parseReuse(REUSE), decisions: [], errors: [], warnings: [] });
const task = { id: 'T1', owned_files: ['lib/a.ts'], reads: ['lib/paths.js'] };
const ZOD = { name: 'zod', ecosystem: 'npm', version: '3.23.8', how: 'locked', path: 'node_modules/zod/index.d.ts', docs: 'https://zod.dev', purpose: 'validation of all input', note: 'v3 API' };
const text = (r: any) => (r ? r.lines.join('\n') : '');

describe('the dependency rows in the excerpt', () => {
  it('a row has the version, how it is known, the file to read and the docs; the section has the rule', () => {
    const r = X.excerpt(cat(), task, { deps: { rows: [ZOD, { ...ZOD, name: 'serde', ecosystem: 'cargo', version: '1.0.195', path: null, docs: null, purpose: '', note: '' }], cut: 0 } });
    const t = text(r);
    expect(t).toContain('- **Dependencies these files import**');
    expect(t).toMatch(/read the installed types or README, not your memory/);
    expect(t).toContain('  - zod 3.23.8 (locked; types in `node_modules/zod/index.d.ts`; docs https://zod.dev): validation of all input; v3 API');
    expect(t).toContain('  - serde 1.0.195 (locked)');
    expect(r.counts.deps).toBe(2);
  });

  it('without dependency rows the text is byte for byte what it was', () => {
    expect(text(X.excerpt(cat(), task, { deps: { rows: [], cut: 0 } }))).toBe(text(X.excerpt(cat(), task)));
  });

  it('a README or a folder is named as such, and a row without a version says so', () => {
    const t = text(
      X.excerpt(cat(), task, {
        deps: {
          rows: [
            { ...ZOD, name: 'vitest', path: 'node_modules/vitest/README.md', docs: null, purpose: '', note: '' },
            { ...ZOD, name: 'requests', how: 'installed', path: '.venv/lib/python3.12/site-packages/requests/', docs: null, purpose: '', note: '' },
            { ...ZOD, name: 'left', version: null, how: null, path: null, docs: 'https://left.dev', purpose: '', note: '' },
          ],
          cut: 0,
        },
      }),
    );
    expect(t).toContain('  - vitest 3.23.8 (locked; README in `node_modules/vitest/README.md`)');
    expect(t).toContain('  - requests 3.23.8 (installed; installed in `.venv/lib/python3.12/site-packages/requests/`)');
    expect(t).toContain('  - left (no locked version; docs https://left.dev)');
  });

  it('under a tight cap the dependency rows go before the reuse rows, and the heading counts them', () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({ ...ZOD, name: `pkg${i}`, purpose: 'a purpose long enough to cost something in the mission text' }));
    const r = X.excerpt(cat(), task, { capTokens: 260, deps: { rows, cut: 3 } });
    expect(r.tokens).toBeLessThanOrEqual(260);
    expect(text(r)).toContain('`norm`');
    expect(r.cut.deps).toBeGreaterThan(3);
    expect(r.lines[0]).toMatch(/\d+ dependency rows/);
  });
});

describe('forTask and catalog.depsExcerpt', () => {
  const project = () => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-deps-excerpt-')));
    temporary.push(root);
    const put = (f: string, t: string) => {
      fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
      fs.writeFileSync(path.join(root, f), t);
    };
    put('docs/queue/catalog/stack.md', [STACK, '## Dependencies', '', '| Package | Purpose | Docs | Note |', '|---|---|---|---|', '| zod | validation of all input | https://zod.dev | v3 API |', ''].join('\n'));
    put('package.json', JSON.stringify({ dependencies: { zod: '^3.23.0' } }));
    put('package-lock.json', JSON.stringify({ packages: { 'node_modules/zod': { version: '3.23.8' } } }));
    put('node_modules/zod/package.json', JSON.stringify({ name: 'zod', version: '3.23.8', types: 'index.d.ts' }));
    put('node_modules/zod/index.d.ts', 'export {}');
    put('lib/a.ts', "import { z } from 'zod';\n");
    fs.mkdirSync(path.join(root, 'data'));
    return root;
  };

  it('reads the tree and gives the rows while the setting is on, none when it is off', () => {
    const root = project();
    const on = text(X.forTask(task, { which: 'mission', root, dataFolder: path.join(root, 'data'), config: {} }));
    expect(on).toContain('  - zod 3.23.8 (locked; types in `node_modules/zod/index.d.ts`; docs https://zod.dev): validation of all input; v3 API');
    const review = text(X.forTask(task, { which: 'review', root, dataFolder: path.join(root, 'data'), config: {} }));
    expect(review).toContain('zod 3.23.8 (locked');
    const off = text(X.forTask(task, { which: 'mission', root, dataFolder: path.join(root, 'data'), config: { catalog: { depsExcerpt: false } } }));
    expect(off).toContain('validation: zod');
    expect(off).not.toContain('zod 3.23.8');
  });

  it('is on by default, in STANDARD, in the registry and in the docs table', () => {
    expect(C.DEFAULTS.depsExcerpt).toBe(true);
    expect(QC.STANDARD.catalog.depsExcerpt).toBe(true);
    expect(C.setupProblems({ depsExcerpt: 'yes' })).toEqual(['catalog.depsExcerpt must be true or false']);
    const row = REG.rowFor('catalog.depsExcerpt');
    expect(row).toMatchObject({ category: 'scope', type: 'onoff' });
    const docs = fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', 'docs', 'queue.md'), 'utf8');
    expect(docs).toMatch(/\| `catalog\.depsExcerpt` \| `true` \|/);
  });
});
