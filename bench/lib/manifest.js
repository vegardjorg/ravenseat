// =============================================================
// manifest.js: the run manifest, one JSON file that describes an experiment.
//
// The manifest is the only place an experiment is defined: which arms exist, which task goes to which arm, which
// tasks are matched pairs, and where the data lives. It never holds measured numbers (those are collected from the
// project's own logs at run time) and it lives OUTSIDE this repo, next to the results, because it names real tasks.
// The full format is documented in bench/README.md; bench/example/manifest.example.json is a synthetic example.
//
//   {
//     "experiment": "short-id",                      required, [A-Za-z0-9._-]
//     "description": "free text",
//     "arms": [{ "name": "cq", "kind": "cq" | "manual-fresh" | "manual-long" | "other",
//                "models": { "<agent type>": "<model>" }, "maxParallel": 4,
//                "window": { "from": ISO, "to": ISO },  optional: unattributed sessions in this window belong to the arm
//                "sessions": ["<session id>"] }],        optional: main sessions (orchestrator or manual chat) of the arm
//     "tasks": [{ "id": "<queue id>", "arm": "<arm name>", "pair": "<pair id>", "stratum": "K-small",
//                 "replay": { "base": "<commit>" } | null, "sessions": ["<session id>"],
//                 "label": "<track label in the logs, default id>", "outcome": "merged"|"failed"|"abandoned" }],
//     "sources": { "queue": path, "timeLog": path, "transcripts": dir, "load": path, "human": path, "gitRepo": path },
//     "settings": { "seed": 1, "bootstrap": 2000, "defectWindowDays": 14, "loadMatchSec": 120,
//                   "prices": { "<model>": { input, output, cache_read, cache_5m, cache_1h } },
//                   "sessionTypes": { "<agent type>": "track"|"reviewer"|"helper"|"planning"|"orchestrator" } }
//   }
//
// Paths in `sources` may be absolute or relative to the manifest file. Command line flags override them.
// Pure apart from `loadManifest`. Tested in bench/__tests__/manifest.test.ts.
// =============================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ARM_KINDS = ['cq', 'manual-fresh', 'manual-long', 'other'];
/** A manual outcome (replays never merge into the real project, manual arms have no queue status). */
const OUTCOMES = ['merged', 'failed', 'abandoned'];
const SOURCE_KEYS = ['queue', 'timeLog', 'transcripts', 'load', 'human', 'gitRepo', 'gates'];
const DEFAULT_SETTINGS = {
  seed: 1,
  bootstrap: 2000,
  defectWindowDays: 14,
  loadMatchSec: 120,
  prices: {},
  sessionTypes: {},
};

/**
 * Checks a manifest object. Returns the list of problems (empty = valid). Never throws.
 * @returns {string[]}
 */
function validate(m) {
  const errors = [];
  if (!m || typeof m !== 'object' || Array.isArray(m)) return ['the manifest must be a JSON object'];
  if (typeof m.experiment !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(m.experiment))
    errors.push('experiment must be 1-64 characters of [A-Za-z0-9._-]');
  if (!Array.isArray(m.arms) || m.arms.length === 0) errors.push('arms must be a non-empty list');
  const armNames = new Set();
  for (const [i, a] of (Array.isArray(m.arms) ? m.arms : []).entries()) {
    if (!a || typeof a.name !== 'string' || !a.name) {
      errors.push(`arms[${i}].name is missing`);
      continue;
    }
    if (armNames.has(a.name)) errors.push(`arm "${a.name}" is defined twice`);
    armNames.add(a.name);
    if (a.kind != null && !ARM_KINDS.includes(a.kind))
      errors.push(`arm "${a.name}": kind must be one of ${ARM_KINDS.join(', ')}`);
    if (a.maxParallel != null && !(Number.isInteger(a.maxParallel) && a.maxParallel > 0))
      errors.push(`arm "${a.name}": maxParallel must be a positive integer`);
    if (a.models != null && (typeof a.models !== 'object' || Array.isArray(a.models)))
      errors.push(`arm "${a.name}": models must be an object { agent type: model }`);
    if (a.window != null) {
      const f = Date.parse(a.window.from);
      const t = Date.parse(a.window.to);
      if (Number.isNaN(f) || Number.isNaN(t) || f >= t)
        errors.push(`arm "${a.name}": window needs ISO from < to`);
    }
  }
  if (!Array.isArray(m.tasks)) errors.push('tasks must be a list (it may be empty while the experiment is planned)');
  const ids = new Set();
  const pairs = new Map();
  const labels = new Map();
  for (const [i, t] of (Array.isArray(m.tasks) ? m.tasks : []).entries()) {
    if (!t || typeof t.id !== 'string' || !t.id) {
      errors.push(`tasks[${i}].id is missing`);
      continue;
    }
    // A replayed task can appear once per arm (same id, built again from its base commit), so the key is id + arm.
    const key = `${t.id}|${t.arm}`;
    if (ids.has(key)) errors.push(`task "${t.id}" is listed twice in arm "${t.arm}"`);
    ids.add(key);
    if (!armNames.has(t.arm)) errors.push(`task "${t.id}": unknown arm "${t.arm}"`);
    if (t.pair != null) {
      const list = pairs.get(t.pair) ?? [];
      list.push(t);
      pairs.set(t.pair, list);
    }
    if (t.outcome != null && !OUTCOMES.includes(t.outcome))
      errors.push(`task "${t.id}": outcome must be one of ${OUTCOMES.join(', ')}`);
    if (t.replay != null && (typeof t.replay !== 'object' || typeof t.replay.base !== 'string'))
      errors.push(`task "${t.id}": replay must be { "base": "<commit>" }`);
    // The logs are joined to a task by its track label. Two entries with the same label could not be told apart,
    // unless each one names its sessions explicitly.
    const label = t.label ?? t.id;
    const hasSessions = Array.isArray(t.sessions) && t.sessions.length > 0;
    const seen = labels.get(label);
    if (seen && !(seen.hasSessions && hasSessions))
      errors.push(`label "${label}" is used by two tasks: give one a distinct label (e.g. "${label}-R") or list sessions for both`);
    labels.set(label, { hasSessions: (seen?.hasSessions ?? true) && hasSessions });
  }
  for (const [p, list] of pairs) {
    const arms = new Set(list.map((t) => t.arm));
    if (arms.size !== list.length) errors.push(`pair "${p}" has two tasks in the same arm`);
    if (list.length < 2) errors.push(`pair "${p}" has only one task`);
  }
  if (m.sources != null) {
    for (const k of Object.keys(m.sources))
      if (!SOURCE_KEYS.includes(k)) errors.push(`sources.${k} is unknown (known: ${SOURCE_KEYS.join(', ')})`);
  }
  return errors;
}

/** Fills defaults and resolves source paths relative to `baseDir`. Assumes `validate` passed. */
function withDefaults(m, baseDir = process.cwd()) {
  const sources = {};
  for (const [k, v] of Object.entries(m.sources ?? {}))
    sources[k] = typeof v === 'string' && v ? path.resolve(baseDir, v) : null;
  return {
    ...m,
    arms: m.arms.map((a) => ({ kind: 'other', models: {}, maxParallel: null, sessions: [], ...a })),
    tasks: (m.tasks ?? []).map((t) => ({
      pair: null,
      stratum: null,
      replay: null,
      sessions: [],
      outcome: null,
      ...t,
      label: t.label ?? t.id,
    })),
    sources,
    settings: { ...DEFAULT_SETTINGS, ...(m.settings ?? {}) },
  };
}

/** Reads, validates and fills a manifest file. Throws with all problems listed. */
function loadManifest(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const errors = validate(raw);
  if (errors.length) throw new Error(`invalid manifest ${file}:\n  - ${errors.join('\n  - ')}`);
  return withDefaults(raw, path.dirname(path.resolve(file)));
}

/**
 * Seeded random assignment of matched pairs to arms: within each pair, the order of the arms is shuffled, so neither
 * arm systematically gets the "first" (often easier or better known) task. Input: [{ pair, ids: [id, id] }] and the arm
 * names. Output: [{ id, arm, pair }].
 */
function assignPairs(pairs, arms, seed = 1) {
  const { rng } = require('./stats.js');
  const r = rng(seed);
  const out = [];
  for (const p of pairs) {
    const order = [...arms];
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    p.ids.forEach((id, i) => out.push({ id, arm: order[i % order.length], pair: p.pair }));
  }
  return out;
}

module.exports = { ARM_KINDS, OUTCOMES, SOURCE_KEYS, DEFAULT_SETTINGS, validate, withDefaults, loadManifest, assignPairs };
