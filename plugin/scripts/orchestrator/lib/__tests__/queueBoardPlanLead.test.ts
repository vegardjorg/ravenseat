// =============================================================
// queueBoardPlanLead.test.ts: the server side of P3 (plans/plans-tab-ux-review-2026-11-19.md): the lead of a plan
// without a summary is taken from its plan document, read through the same guard as /api/doc, and cached per file.
//
// What the tests prove:
//   - the lead comes from the plan source at its anchor (queuePlanView.documentLead), with the path and anchor it came
//     from, so the page can say "From the plan document",
//   - a file is read once while its time and size stay the same, and read again when it changes,
//   - a path outside the document folders, a missing file or a file that is too large gives no lead and no error,
//   - an entry without a readable source reads nothing.
// =============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const T = require('../queueBoard.js') as any;
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-lead-'));
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'docs', 'plan.md'),
    '# Sync\n\n## 1. Scope\n\nThe app works on the train and syncs later.\n\n## 2. Design\n\nOther words.\n',
  );
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

/** fs with a counter on readFileSync, so the cache is visible. */
function countingFs() {
  const counter = { reads: 0 };
  const io = {
    fs: {
      ...fs,
      readFileSync: (...a: unknown[]) => {
        counter.reads += 1;
        return (fs.readFileSync as any)(...a);
      },
    },
    path,
  };
  return { io, counter };
}

const entry = (sources: unknown[]) => ({ id: 'PL-SYNC', sources });

describe('planLeadReader', () => {
  it('reads the lead at the anchor of the plan source', () => {
    const { io } = countingFs();
    const leadFor = T.planLeadReader(root, io);
    expect(leadFor(entry([{ path: 'docs/plan.md', anchor: '§ 1', role: 'plan' }]))).toEqual({
      text: 'The app works on the train and syncs later.',
      path: 'docs/plan.md',
      anchor: '§ 1',
    });
  });

  it('reads a file once while it is unchanged, and again after a change', () => {
    const { io, counter } = countingFs();
    const leadFor = T.planLeadReader(root, io);
    const p = entry([{ path: 'docs/plan.md', anchor: '§ 2', role: 'plan' }]);
    expect(leadFor(p)?.text).toBe('Other words.');
    expect(leadFor(p)?.text).toBe('Other words.');
    expect(counter.reads).toBe(1);
    const file = path.join(root, 'docs', 'plan.md');
    fs.writeFileSync(file, '# Sync\n\n## 2. Design\n\nNew words, a bit longer now.\n');
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(file, later, later);
    expect(leadFor(p)?.text).toBe('New words, a bit longer now.');
    expect(counter.reads).toBe(2);
  });

  it('gives no lead (and no error) outside the folders, for a missing file or a large one', () => {
    const { io, counter } = countingFs();
    const leadFor = T.planLeadReader(root, io, { max: 64 });
    expect(leadFor(entry([{ path: '../outside.md', role: 'plan' }]))).toBe(null);
    expect(leadFor(entry([{ path: 'docs/missing.md', role: 'plan' }]))).toBe(null);
    expect(leadFor(entry([{ path: 'docs/plan.md', role: 'plan' }]))).toBe(null); // over 64 bytes
    expect(leadFor(entry([]))).toBe(null);
    expect(counter.reads).toBe(0);
  });
});
