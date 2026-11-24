// =============================================================
// networkTimeLimits.test.ts: the network and evidence calls that could hang a merge or a watch have a time limit
// (ARK-1 T3, architecture review A1b/A2).
//
// (1) Behaviour: cli/ghRun.mjs ghSpawn ends a program that does not answer within its limit and says timedOut.
// (2) Guard test (renameGuard.test.ts pattern): the four call sites go through the bounded helpers: `cloud done`'s
//     fetch through gitRemote (cli/cloud.mjs), the cloud branch delete with a timeout (cli/merge/afterMerge.mjs), gh in
//     gates.mjs and cli/ciWatch.mjs through ghSpawn, and the QA evidence command through lib/treeRun.js (cli/owner.mjs).
// =============================================================
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const ORCH = path.resolve(__dirname, '..', '..');
const src = (f: string) => fs.readFileSync(path.join(ORCH, f), 'utf8');

describe('ghSpawn', () => {
  it('ends a program that does not answer within the limit', async () => {
    const { ghSpawn } = await import(pathToFileURL(path.join(ORCH, 'cli', 'ghRun.mjs')).href);
    const started = Date.now();
    const r = ghSpawn(['-e', 'setInterval(() => {}, 1000)'], { cwd: ORCH, timeoutMs: 500, bin: process.execPath });
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(r.timedOut).toBe(true);
    expect(r.missing).toBe(false);
  });

  it('says missing when the program is not there, and passes the output through', async () => {
    const { ghSpawn } = await import(pathToFileURL(path.join(ORCH, 'cli', 'ghRun.mjs')).href);
    expect(ghSpawn([], { cwd: ORCH, bin: 'no-such-gh-binary-ark' }).missing).toBe(true);
    const ok = ghSpawn(['-e', 'process.stdout.write("hi")'], { cwd: ORCH, bin: process.execPath });
    expect(ok).toMatchObject({ code: 0, out: 'hi', timedOut: false });
  });
});

describe('guard test: the call sites use the bounded helpers', () => {
  it('no spawnSync of gh outside cli/ghRun.mjs in gates.mjs and cli/ciWatch.mjs', () => {
    for (const f of ['gates.mjs', 'cli/ciWatch.mjs']) expect(src(f), f).not.toMatch(/spawnSync\(\s*'gh'/);
  });

  it('cloud done fetches through gitRemote', () => {
    expect(src('cli/cloud.mjs')).not.toMatch(/\bgit\(\[\s*'fetch'/);
  });

  it('the cloud branch delete has a time limit', () => {
    const t = src('cli/merge/afterMerge.mjs');
    expect(t).not.toMatch(/\bgit\(\[\s*'push',[^\]]*'--delete'/);
    expect(t).toMatch(/'--delete'[\s\S]{0,400}timeout:/);
  });

  it('the QA evidence command runs through lib/treeRun.js, not a bare shell', () => {
    const t = src('cli/owner.mjs');
    expect(t).not.toMatch(/shell:\s*true/);
    expect(t).toMatch(/runBounded\(/);
  });
});
