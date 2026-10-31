// =============================================================
// cli.test.ts: bench.mjs end to end against a synthetic project in a temporary folder (never the repo, never a real
// project): validate, sample --once, human, collect, report, and the refusal to write inside the repo.
// =============================================================
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as FX from './fixtures';

const CLI = path.join(__dirname, '..', 'bench.mjs');
const REPO = path.resolve(__dirname, '..', '..');
const tmp: string[] = [];
afterAll(() => tmp.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const run = (args: string[], env: Record<string, string> = {}) =>
  spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 60000 });

/** A synthetic project: queue, time log, transcripts folder, load log, human log and a manifest pointing at them. */
function project() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-cli-'));
  tmp.push(d);
  fs.writeFileSync(path.join(d, 'queue.json'), JSON.stringify(FX.queue()));
  fs.writeFileSync(path.join(d, 'times.jsonl'), FX.timeRows().map((r) => JSON.stringify(r)).join('\n'));
  fs.writeFileSync(path.join(d, 'load.jsonl'), FX.loadRows().map((r) => JSON.stringify(r)).join('\n'));
  const tr = path.join(d, 'transcripts');
  for (const t of FX.transcriptFiles()) {
    if (t.kind === 'main') {
      fs.mkdirSync(tr, { recursive: true });
      fs.writeFileSync(path.join(tr, `${t.id}.jsonl`), t.text);
    } else {
      const sub = path.join(tr, t.parent as string, 'subagents');
      fs.mkdirSync(sub, { recursive: true });
      fs.writeFileSync(path.join(sub, `agent-${t.id}.jsonl`), t.text);
      fs.writeFileSync(path.join(sub, `agent-${t.id}.meta.json`), JSON.stringify(t.meta));
    }
  }
  const m: any = FX.manifest();
  m.sources = { queue: 'queue.json', timeLog: 'times.jsonl', transcripts: 'transcripts', load: 'load.jsonl', human: 'human.jsonl' };
  fs.writeFileSync(path.join(d, 'manifest.json'), JSON.stringify(m));
  return d;
}

describe('bench.mjs', () => {
  it('validate, human, collect and report work end to end outside the repo', () => {
    const d = project();
    const v = run(['validate', '--manifest', path.join(d, 'manifest.json')]);
    expect(v.status).toBe(0);
    expect(v.stdout).toMatch(/OK synthetic: 2 arm\(s\), 4 task\(s\), 2 pair\(s\)/);

    const h = run(['human', '--log', path.join(d, 'human.jsonl'), '--task', 'Y-1', '--min', '7', '--activity', 'review']);
    expect(h.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(d, 'human.jsonl'), 'utf8').trim())).toMatchObject({ task: 'Y-1', minutes: 7 });

    const c = run(['collect', '--manifest', path.join(d, 'manifest.json'), '--out', path.join(d, 'results')]);
    expect(c.status).toBe(0);
    const recordsFile = c.stdout.match(/records: (.+)/)![1].trim();
    const records = JSON.parse(fs.readFileSync(recordsFile, 'utf8'));
    expect(records.sessions).toHaveLength(7);
    expect(records.human).toHaveLength(1);

    const r = run(['report', '--records', recordsFile]);
    expect(r.status).toBe(0);
    const md = fs.readFileSync(path.join(path.dirname(recordsFile), 'report.md'), 'utf8');
    expect(md).toContain('USD per merged change');
    expect(md).toContain('$3.30');
  });

  it('sample --once prints one row (BENCH_LOAD override)', () => {
    const s = run(['sample', '--once'], { BENCH_LOAD: 'free=33,tracks=4' });
    expect(s.status).toBe(0);
    expect(JSON.parse(s.stdout)).toMatchObject({ free_memory_pct: 33, running_tracks: 4, source: 'override' });
  });

  it('refuses to write results or logs inside the repo, and prints usage without a command', () => {
    const d = project();
    const c = run(['collect', '--manifest', path.join(d, 'manifest.json'), '--out', path.join(REPO, 'plans', 'bench-out')]);
    expect(c.status).toBe(1);
    expect(c.stderr).toMatch(/this repo is public/);
    const s = run(['sample', '--out', path.join(REPO, 'load.jsonl'), '--duration-min', '0.001']);
    expect(s.status).toBe(1);
    expect(fs.existsSync(path.join(REPO, 'load.jsonl'))).toBe(false);
    expect(run([]).status).toBe(2);
  });
});
