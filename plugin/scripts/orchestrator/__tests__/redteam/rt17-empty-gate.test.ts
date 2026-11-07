// =============================================================
// redteam/rt17-empty-gate.test.ts: RT-17 "a gate that always says 0 does not pass for a check" (plans/redteam-plan.md, R3).
//
// Why: green gates are only worth something when they check something. `exit 0`, `true`, an echo or an npm script whose
// body is one of them is green whatever the code does. Ravenseat cannot judge whether a real test is good enough (that is
// a known limitation, scenario 7), but it can say when the gates check nothing at all. A warning in doctor, never a stop:
// a project without tests yet may set it on purpose.
// =============================================================
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { project } from './project';

const require = createRequire(import.meta.url);
const K = require('../../lib/kickstart.js') as { noOpCommands: (c: string[], pkg: string | null) => string[] };

describe('RT-17: a gate that always says 0 does not pass for a check', () => {
  it('the forms that check nothing, also behind an npm script; a real command is never one', () => {
    const pkg = JSON.stringify({ scripts: { test: 'exit 0', lint: 'eslint .', fake: 'echo ok && true', chain: 'npm run fake' } });
    const nothing = ['node -e "process.exit(0)"', 'true', 'exit 0', 'npm test', 'npm run chain', 'echo hi', 'node -e ""', 'cmd /c exit 0'];
    const real = ['npm run lint', 'npx vitest run', 'node gate.cjs', 'npm run missing', 'pytest -q', 'exit 1'];
    expect(K.noOpCommands([...nothing, ...real], pkg)).toEqual(nothing);
  });

  it('doctor warns when every gate checks nothing, and only counts them when a real one is there', () => {
    const empty = project({ gates: ['node -e "process.exit(0)"', 'true'] });
    const d1 = empty.run('doctor');
    expect(d1.out).toMatch(/WARN\s+gates\s+every gate command checks nothing \(node -e "process\.exit\(0\)", true\)/);
    expect(d1.out).toMatch(/fix: set a real check in gates\.quick/);

    const mixed = project({ gates: ['true', 'node check.cjs'] });
    fs.writeFileSync(path.join(mixed.repo, 'check.cjs'), 'process.exit(0);\n');
    const d2 = mixed.run('doctor');
    expect(d2.out).toMatch(/OK\s+gates\s+2 gate command\(s\) set, 1 of them check nothing \(true\)/);
  }, 120_000);
});
