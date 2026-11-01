#!/usr/bin/env node
// =============================================================
// bench.mjs: command line for the cq benchmark (token use, cost, savings and system load). See bench/README.md.
//
//   node bench/bench.mjs validate --manifest <file>
//   node bench/bench.mjs assign   --pairs <file> --arms <a,b> [--seed <n>]
//   node bench/bench.mjs sample   --out <load.jsonl> [--interval <s>] [--duration-min <n>] [--queue <file>] [--disk <dir>]
//   node bench/bench.mjs sample   --once [--queue <file>]
//   node bench/bench.mjs sample   --stop --out <load.jsonl>
//   node bench/bench.mjs human    --log <human.jsonl> --task <id> --min <n> [--arm <a>] [--activity <text>]
//   node bench/bench.mjs collect  --manifest <file> [--out <dir>] [--queue <f>] [--time-log <f>] [--transcripts <dir>]
//                                 [--load <f>] [--human <f>] [--git <repo>] [--no-cache]
//   node bench/bench.mjs report   --records <records.json> [--out <report.md>]
//
// Every command only READS the measured project (the queue, the logs, the transcripts, `git log`). Everything it
// writes (load log, human log, records, report) must be outside this repo; bench/lib/paths.js refuses otherwise.
// Exit codes: 0 ok, 1 error, 2 usage.
// =============================================================

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Mf = require('./lib/manifest.js');
const LS = require('./lib/loadSampler.js');
const C = require('./lib/collect.js');
const R = require('./lib/report.js');
const PT = require('./lib/paths.js');

const args = process.argv.slice(2);
const command = args[0];
const val = (name) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
};
const flag = (name) => args.includes(name);
const usage = (msg) => {
  console.error(msg);
  process.exit(2);
};
const fail = (e) => {
  console.error(`bench: ${e?.message ?? e}`);
  process.exit(1);
};

function cmdValidate() {
  const file = val('--manifest') ?? usage('validate --manifest <file>');
  const m = Mf.loadManifest(file);
  console.log(`OK ${m.experiment}: ${m.arms.length} arm(s), ${m.tasks.length} task(s), ` +
    `${new Set(m.tasks.map((t) => t.pair).filter(Boolean)).size} pair(s)`);
}

function cmdAssign() {
  const file = val('--pairs') ?? usage('assign --pairs <file: [{ "pair": "p1", "ids": ["A", "B"] }]> --arms <a,b> [--seed n]');
  const arms = (val('--arms') ?? usage('assign needs --arms a,b')).split(',').map((s) => s.trim()).filter(Boolean);
  const seed = Number(val('--seed') ?? 1);
  console.log(JSON.stringify(Mf.assignPairs(JSON.parse(fs.readFileSync(file, 'utf8')), arms, seed), null, 2));
}

async function cmdSample() {
  const queueFile = val('--queue');
  if (flag('--once')) {
    console.log(JSON.stringify(LS.sampleOnce({ queueFile, diskDir: val('--disk') })));
    return;
  }
  const out = val('--out') ?? usage('sample --out <load.jsonl> [--interval s] [--duration-min n] [--queue f] [--disk dir]');
  const file = PT.safeOutput(out);
  if (flag('--stop')) {
    fs.writeFileSync(`${file}.stop`, new Date().toISOString());
    console.log(`stop file written: ${file}.stop (the sampler stops at its next tick)`);
    return;
  }
  // A stale stop file from an earlier run would stop the new sampler at once.
  try {
    fs.rmSync(`${file}.stop`, { force: true });
  } catch {
    /* none */
  }
  const intervalMs = Math.max(1, Number(val('--interval') ?? 30)) * 1000;
  const dm = val('--duration-min');
  const s = LS.startSampler({
    out: file,
    intervalMs,
    durationMs: dm ? Number(dm) * 60000 : null,
    queueFile,
    diskDir: val('--disk'),
  });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => s.stop());
  console.log(`sampling every ${intervalMs / 1000} s into ${file}; stop with: node bench/bench.mjs sample --stop --out ${out}`);
  const rows = await s.done;
  console.log(`stopped after ${rows} sample(s)`);
}

function cmdHuman() {
  const log = val('--log') ?? usage('human --log <human.jsonl> --task <id> --min <n> [--arm a] [--activity text]');
  const minutes = Number(val('--min'));
  if (!(minutes > 0)) usage('human needs --min <minutes, > 0>');
  const file = PT.safeOutput(log);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const row = { time: new Date().toISOString(), task: val('--task'), arm: val('--arm'), minutes, activity: val('--activity') };
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
  console.log(`logged ${minutes} min${row.task ? ` on ${row.task}` : ''}`);
}

function cmdCollect() {
  const mfile = val('--manifest') ?? usage('collect --manifest <file> [--out dir] [source flags]');
  const m = Mf.loadManifest(mfile);
  const over = {
    queue: val('--queue'),
    timeLog: val('--time-log'),
    transcripts: val('--transcripts'),
    load: val('--load'),
    human: val('--human'),
    gitRepo: val('--git'),
  };
  for (const [k, v] of Object.entries(over)) if (v) m.sources[k] = path.resolve(v);
  const root = PT.safeOutput(val('--out') ?? PT.defaultResultsRoot());
  // The transcript cache sits next to the run folders (outside the repo, like them); --no-cache reads every file.
  const cacheFile = flag('--no-cache') ? null : path.join(root, '.transcript-cache.json');
  const records = C.collectAll(m, { cacheFile });
  const dir = path.join(root, PT.runFolderName(m.experiment));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'records.json');
  fs.writeFileSync(file, JSON.stringify(records, null, 1));
  console.log(`records: ${file}`);
  console.log(`tasks ${records.tasks.length}, sessions ${records.sessions.length}, gate runs ${records.gates.length}, ` +
    `load samples ${records.load.length}, ` +
    `transcripts from cache ${records.transcript_cache_hits ?? 0}, warnings ${records.warnings.length}`);
  for (const w of records.warnings) console.log(`  warning: ${w}`);
}

function cmdReport() {
  const file = val('--records') ?? usage('report --records <records.json> [--out report.md]');
  const records = JSON.parse(fs.readFileSync(file, 'utf8'));
  const out = PT.safeOutput(val('--out') ?? path.join(path.dirname(path.resolve(file)), 'report.md'));
  fs.writeFileSync(out, R.render(records));
  console.log(`report: ${out}`);
}

const commands = { validate: cmdValidate, assign: cmdAssign, sample: cmdSample, human: cmdHuman, collect: cmdCollect, report: cmdReport };
if (!commands[command]) {
  usage('use: node bench/bench.mjs <validate|assign|sample|human|collect|report> ... (see bench/README.md)');
} else {
  try {
    await commands[command]();
  } catch (e) {
    fail(e);
  }
}
