#!/usr/bin/env node
// =============================================================
// make-demo-snapshot.mjs: builds the board's demo data (plugin/scripts/orchestrator/demo-data/pebble.json) from a
// folder seeded with the Pebble demo project (owner decision 22.11, demo mode on the board).
//
//   node scripts/make-demo-snapshot.mjs <seeded project folder>
//
// The seeded folder is what the screenshot seed builds: a made-up habit tracker ("Pebble") with tasks in every status,
// owner questions, a plan register, a time log and a few plan documents. This script keeps only what the board views
// read (queue.json, plans.json, the time log rows, seen.json, owner-log.json, docs/roadmap.md and docs/plans/*.md) and
// stores every timestamp RELATIVE to the moment the seed ran, as "@rel:<milliseconds>". lib/demoMode.js turns them back
// into dates around "now" when the demo folder is made, so the demo never looks stale.
//
// Made neutral on the way: the changelogs start empty (so Undo in the demo only sees what the viewer did), and the
// person who picked a task is a made-up name. The script refuses to write when the result holds anything that looks
// private: a drive or home path, an email address outside example.com, or the current user's login name.
// Run it again only when the board needs new demo data; commit the JSON it writes.
// =============================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'plugin', 'scripts', 'orchestrator', 'demo-data', 'pebble.json');
const SEED = process.argv[2] ? path.resolve(process.argv[2]) : null;
if (!SEED || !fs.existsSync(path.join(SEED, 'scripts', '.queue', 'queue.json'))) {
  console.error('Usage: node scripts/make-demo-snapshot.mjs <seeded project folder> (it must hold scripts/.queue/queue.json)');
  process.exit(2);
}
const DATA = path.join(SEED, 'scripts', '.queue');
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
// The seed ran when queue.json was last written: every date is stored as an offset from that moment.
const ANCHOR = fs.statSync(path.join(DATA, 'queue.json')).mtimeMs;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/;

/** Every ISO timestamp in a JSON value becomes "@rel:<ms from the seed>"; everything else is kept as it is. */
function relative(v) {
  if (typeof v === 'string' && ISO.test(v)) return `@rel:${Math.round(Date.parse(v) - ANCHOR)}`;
  if (Array.isArray(v)) return v.map(relative);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, relative(x)]));
  return v;
}

const queue = readJson(path.join(DATA, 'queue.json'));
queue.changelog = [];
for (const o of queue.tasks ?? []) if (o.picked_by) o.picked_by = 'Sam';
const plans = readJson(path.join(DATA, 'plans.json'));
plans.changelog = [];
const times = fs
  .readFileSync(path.join(DATA, 'times.jsonl'), 'utf8')
  .split(/\r?\n/)
  .filter(Boolean)
  .map((l) => JSON.parse(l));
const optional = (f) => (fs.existsSync(path.join(DATA, f)) ? readJson(path.join(DATA, f)) : null);

const docs = {};
const docFile = (rel) => {
  docs[rel] = fs.readFileSync(path.join(SEED, ...rel.split('/')), 'utf8').replace(/\r\n/g, '\n');
};
docFile('docs/roadmap.md');
for (const f of fs.readdirSync(path.join(SEED, 'docs', 'plans')).sort()) if (f.endsWith('.md')) docFile(`docs/plans/${f}`);

// The demo project's own settings: only what the views read. The mode is NOT stored: lib/demoMode.js copies the real
// project's mode when it makes the folder, so a lite user sees a lite demo board.
const seedConfig = readJson(path.join(SEED, 'queue.config.json'));
const config = {
  projectName: 'pebble',
  baseBranch: 'main',
  dataFolder: 'data',
  timeLog: 'data/times.jsonl',
  gates: { quick: [], full: [] },
  modules: seedConfig.modules ?? [],
  projectModuleSuggestion: seedConfig.projectModuleSuggestion ?? {},
  documentFolders: seedConfig.documentFolders ?? ['docs/plans'],
  board: { title: 'Pebble queue' },
};

const snapshot = {
  _comment:
    'Demo data for the board (demo mode). Made by scripts/make-demo-snapshot.mjs from the Pebble seed; "@rel:<ms>" is a ' +
    'time relative to when the demo folder is made (lib/demoMode.js). Made-up project, no real data.',
  version: 1,
  name: 'Pebble',
  config,
  data: relative({
    'queue.json': queue,
    'plans.json': plans,
    'seen.json': optional('seen.json'),
    'owner-log.json': optional('owner-log.json'),
  }),
  timeLog: relative(times),
  docs,
};

const text = `${JSON.stringify(snapshot, null, 1)}\n`;
// Nothing private: no drive or home paths, no email outside example.com, not the login name of whoever runs this.
const user = String(os.userInfo().username ?? '').trim();
const problems = [
  // A drive letter on its own ("C:\" or "C:/", escaped as "C:\\" in JSON), not the "s://" of a link.
  [/(?<![A-Za-z])[A-Za-z]:(?:\\|\/(?!\/))/, 'a drive path'],
  [/\/(?:Users|home)\//, 'a home folder path'],
  [/[A-Za-z0-9._%+-]+@(?!example\.com)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, 'an email address outside example.com'],
  ...(user.length >= 3 ? [[new RegExp(user.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), 'the login name']] : []),
].filter(([re]) => re.test(text));
if (problems.length) {
  console.error(`Refused: the snapshot would hold ${problems.map((p) => p[1]).join(', ')}. Nothing was written.`);
  process.exit(1);
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, text);
console.log(`Wrote ${path.relative(process.cwd(), OUT)} (${Math.round(text.length / 1024)} KB, ${queue.tasks.length} tasks).`);
