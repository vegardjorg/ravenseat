// =============================================================
// report.test.ts: the markdown report (bench/lib/report.js) and the results path guard (bench/lib/paths.js).
// =============================================================
import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import * as FX from './fixtures';

const C = require('../lib/collect.js') as Record<string, any>;
const R = require('../lib/report.js') as Record<string, any>;
const PT = require('../lib/paths.js') as Record<string, any>;

describe('render', () => {
  it('has every section, the main numbers and no NaN or undefined', () => {
    const records = C.build(FX.manifest(), {
      queue: FX.queue(),
      timeRows: C.readJsonl(FX.timeRows().map((r) => JSON.stringify(r)).join('\n')),
      transcripts: FX.transcriptFiles().map((t) => ({ ...t, analysis: C.analyzeSession(t.text) })),
      load: FX.loadRows(),
    });
    const md = R.render(records);
    for (const h of ['# Benchmark report: synthetic', '## Data warnings', '## Arms', '## Usage by session type', '## Gates',
      '## System load', '## Paired comparisons', '## Defects after merge', '## Tasks'])
      expect(md).toContain(h);
    expect(md).toContain('$3.30'); // ravenseat USD per merged change
    expect(md).toContain('| ravenseat | manual | usd | 2 |');
    expect(md).not.toMatch(/NaN|undefined/);
  });

  it('renders an empty experiment without crashing', () => {
    const md = R.render(C.build(FX.manifest({ tasks: [] }), {}));
    expect(md).toContain('No pairs across two arms.');
    expect(md).not.toMatch(/NaN|undefined/);
  });
});

describe('paths', () => {
  it('refuses output inside the repo except bench/results, and allows a folder outside', () => {
    expect(() => PT.safeOutput(path.join(PT.REPO_ROOT, 'plans', 'x.json'))).toThrow(/this repo is public/);
    expect(() => PT.safeOutput(PT.REPO_ROOT)).toThrow(/inside the repo/);
    expect(PT.safeOutput(path.join(PT.REPO_ROOT, 'bench', 'results', 'r.json'))).toContain('results');
    const outside = path.join(os.tmpdir(), 'bench-out');
    expect(PT.safeOutput(outside)).toBe(path.resolve(outside));
  });

  it('isInside is case-insensitive on Windows only', () => {
    expect(PT.isInside('C:\\A\\b', 'c:\\a', 'win32')).toBe(true);
    expect(PT.isInside('/a/bc', '/a/b', 'linux')).toBe(false);
  });

  it('the default results root honours BENCH_RESULTS and otherwise lies in the home folder', () => {
    expect(PT.defaultResultsRoot({ BENCH_RESULTS: os.tmpdir() })).toBe(path.resolve(os.tmpdir()));
    expect(PT.defaultResultsRoot({})).toBe(path.join(os.homedir(), '.ravenseat-bench', 'results'));
    expect(PT.runFolderName('e', new Date(0))).toBe('e-1970-01-01T00-00-00-000Z');
  });
});
