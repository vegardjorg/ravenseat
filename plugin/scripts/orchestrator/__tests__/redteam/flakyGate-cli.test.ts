// =============================================================
// redteam/flakyGate-cli.test.ts: the flaky check on a track's gate (lib/trackFlaky.js, gates.flakyRerun) end to end
// through receive, from the side of scenario 6 ("an agent reports green without passing").
//
// Why: the rerun saves a fix round when a gate command is flaky, but it is also a new way to get green. It must never
// turn a gate that is red for real into green, and never give green about another commit: a rerun that moves HEAD (a
// gate that commits) proves nothing about the delivered tip. A real local track delivers; the gate is a small script
// outside the repo that counts its runs and is red the first time.
// =============================================================
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { project, task, tmp } from './project';

/** The gate, outside the repo: `red` is always red; `flaky` and `commit` are red the first time, then green (`commit` after a commit). */
function gateScript() {
  const dir = tmp('rt-flaky-gate-');
  const file = path.join(dir, 'gate.cjs');
  const marker = path.join(dir, 'marker');
  const count = path.join(dir, 'count.txt');
  fs.writeFileSync(
    file,
    [
      "const fs = require('fs'); const cp = require('child_process');",
      'const mode = process.argv[2];',
      `fs.appendFileSync(${JSON.stringify(count)}, mode + '\\n');`,
      "if (mode === 'red') process.exit(1);",
      `if (!fs.existsSync(${JSON.stringify(marker)})) { fs.writeFileSync(${JSON.stringify(marker)}, '1'); process.exit(1); }`,
      "if (mode === 'commit') cp.execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'moved by the gate']);",
      'process.exit(0);',
      '',
    ].join('\n'),
  );
  const runs = () => (fs.existsSync(count) ? fs.readFileSync(count, 'utf8').split('\n').filter(Boolean).length : 0);
  return { command: (mode: string) => `node "${file.split(path.sep).join('/')}" ${mode}`, runs };
}

type GateCheck = { ok: boolean; tip: string; flaky?: string[] };

describe('a flaky track gate at receive', () => {
  it('red, then green on the rerun on the same commit: green, FLAKY, the evidence bound to the delivered tip', () => {
    const gate = gateScript();
    const p = project({ gates: [gate.command('flaky')], tasks: [task('A')] });
    p.localDelivers('A');
    const tip = p.g(['rev-parse', 'queue/A']);
    const r = p.run('receive', 'A');
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('FLAKY A:');
    expect(gate.runs()).toBe(2);
    const check = (p.taskOf('A') as { gate_check?: GateCheck }).gate_check;
    expect(check).toMatchObject({ ok: true, tip, flaky: [gate.command('flaky')] });
    const entry = JSON.parse(fs.readFileSync(path.join(p.folder, 'gate-evidence.json'), 'utf8')).entries.at(-1);
    expect(entry).toMatchObject({ sha: tip, ok: true, clean: true, writer: 'orchestrator', flaky: [gate.command('flaky')] });
  }, 240_000);

  it('a gate that is red for real stays red after the rerun: a fix round, never FLAKY', () => {
    const gate = gateScript();
    const p = project({ gates: [gate.command('red')], tasks: [task('A')] });
    p.localDelivers('A');
    const r = p.run('receive', 'A');
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain('NOT DONE');
    expect(r.out).not.toContain('FLAKY A');
    expect(gate.runs()).toBe(2);
    expect((p.taskOf('A') as { gate_check?: GateCheck }).gate_check).toMatchObject({ ok: false });
  }, 240_000);

  it('a rerun that moves HEAD is no green: the delivered tip gets no green evidence', () => {
    const gate = gateScript();
    const p = project({ gates: [gate.command('commit')], tasks: [task('A')] });
    p.localDelivers('A');
    const tip = p.g(['rev-parse', 'queue/A']);
    const r = p.run('receive', 'A');
    expect(r.code, r.out).not.toBe(0);
    expect(r.out).not.toContain('FLAKY A');
    expect(p.g(['rev-parse', 'queue/A'])).not.toBe(tip);
    const file = path.join(p.folder, 'gate-evidence.json');
    const entries = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')).entries as { sha: string; ok: boolean }[]) : [];
    expect(entries.some((e) => e.ok && e.sha === tip)).toBe(false);
    expect((p.taskOf('A') as { gate_check?: GateCheck }).gate_check?.ok).not.toBe(true);
  }, 240_000);
});
