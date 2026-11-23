// =============================================================
// osv.js: the dependency audit against OSV.dev (roadmap 0å KD-4, plans/katalog-design-stack-avhengigheter-2026-11-18.md
// section 6).
//
// WHY: most code in a project is other people's libraries, and holes in them get published. OSV.dev gathers the GitHub
// advisories, PyPI, RustSec, Go and more behind one free API with no account, so one client covers every ecosystem the
// lockfiles show (lib/lockfiles.js auditPackages), and we control exactly what is sent.
//
// What is sent, and nothing else: per package the ecosystem, the name and the version, to api.osv.dev. Never code, paths,
// the repo's name, a user or a key. Only public packages: anything from workspace:, file:, link:, git, a local path or
// another registry (origin in lib/lockfiles.js), and any name deps.privateScopes lists, is held back, so internal names
// never leave. The network is used only when the owner runs `ravenseat catalog deps --audit` (cli/catalog.mjs): no
// polling, no background job, nothing at receive. Doctor and the Checks card read the cache only.
//
//   plan({ lockfiles, privateScopes })   { send, held, ecosystems, host, lockfiles }: what would be sent (no network)
//   isPrivateName(name, scopes)          a scope entry: the exact name, the name followed by "/", or a prefix ending in *
//   requestBodies(send)                  the querybatch bodies, at most 1000 queries each
//   dryText(plan)                        the lines --dry prints: the count, the ecosystems, what is held back, the host
//                                        and the full request
//   audit({ send, fetch, timeoutMs, now })  async, never throws: { checkedAt, findings, errors }. POST /v1/querybatch,
//                                        then GET /v1/vulns/{id} for each advisory (at most MAX_DETAILS)
//   severityOf(vuln), cvss3Score(vector), fixedFor(vuln, pkg)
//   readCache(folder), writeCache(folder, report)   <dataFolder>/deps-audit.json
//   summarize(cache, { accepted, now })  counts per severity, the worst first (prod before dev), the accepted and lapsed
//                                        risk acceptances (catalog entries kind dependency, lib/catalog.js)
//   doctorLine(summary)                  doctor --all's one line
//   fixTask(summary, { id })             the proposed update task the Checks card offers
//
// Pure apart from the cache file and the default fetch: every test injects fetch (lib/__tests__/osv.test.ts).
// Used by: cli/catalog.mjs (deps --audit), cli/checks.mjs (the card), cli/doctor.mjs (the --all line).
// =============================================================
'use strict';

const fs = require('node:fs');
const { renameWithRetry } = require('./stateFile.js');
const path = require('node:path');
const L = require('./lockfiles.js');

const HOST = 'api.osv.dev';
const BASE = `https://${HOST}/v1`;
const CACHE_FILE = 'deps-audit.json';
const CACHE_VERSION = 1;
const TIMEOUT_MS = 15000;
/** OSV's own cap per querybatch. */
const BATCH = 1000;
/** Advisories whose details are fetched in one run; the rest are listed by id with severity unknown. */
const MAX_DETAILS = 150;
const PARALLEL = 4;
const SUMMARY_MAX = 160;
const WORST = 3;
const TASK_ROWS = 10;
const SEVERITIES = Object.freeze(['critical', 'high', 'moderate', 'low', 'unknown']);
/** lib/lockfiles.js's ecosystem -> OSV's name for it. */
const ECOSYSTEMS = Object.freeze({ npm: 'npm', python: 'PyPI', cargo: 'crates.io', go: 'Go' });
const HELD_REASONS = Object.freeze(['scope', 'other-registry', 'git', 'local', 'unknown']);

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * The settings (lib/queueConfig.js STANDARD.deps holds the same values). audit: manual (only the owner's command asks
 * OSV.dev; KD-5 may add receive) or off (the command refuses, no card and no doctor line). privateScopes: names or
 * prefixes that never leave. auditStop: registered for KD-5, wired to nothing yet (what can stop work is off).
 */
const DEFAULTS = Object.freeze({ audit: 'manual', privateScopes: Object.freeze([]), auditStop: false });
const AUDIT_MODES = Object.freeze(['manual', 'off']);

/** The settings with the defaults filled in; a broken value reads as its default. */
function setupOf(config) {
  const own = isObject(config?.deps) ? config.deps : {};
  return {
    audit: AUDIT_MODES.includes(own.audit) ? own.audit : DEFAULTS.audit,
    privateScopes: Array.isArray(own.privateScopes) ? own.privateScopes.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : [],
    auditStop: typeof own.auditStop === 'boolean' ? own.auditStop : DEFAULTS.auditStop,
  };
}

/** What is wrong in queue.config.json's deps (doctor's config row). */
function setupProblems(own) {
  if (own === undefined) return [];
  if (!isObject(own)) return ['deps must be an object'];
  const out = [];
  for (const [k, v] of Object.entries(own)) {
    if (k === 'audit' && !AUDIT_MODES.includes(v)) out.push(`deps.audit must be ${AUDIT_MODES.join(' or ')}`);
    else if (k === 'privateScopes' && !(Array.isArray(v) && v.every((x) => typeof x === 'string')))
      out.push('deps.privateScopes must be a list of names or prefixes, e.g. ["@acme", "github.com/acme"]');
    else if (k === 'auditStop' && typeof v !== 'boolean') out.push('deps.auditStop must be true or false');
    else if (!Object.hasOwn(DEFAULTS, k)) out.push(`deps.${k} is not a deps setting (${Object.keys(DEFAULTS).join(', ')})`);
  }
  return out;
}

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const cut = (s, n) => (s.length <= n ? s : `${s.slice(0, n - 3).trimEnd()}...`);

/** Is a name held back by deps.privateScopes? "@acme" holds "@acme/ui", "acme-*" holds "acme-core", "x" holds "x". */
function isPrivateName(name, scopes) {
  const n = String(name ?? '');
  for (const raw of Array.isArray(scopes) ? scopes : []) {
    const s = String(raw ?? '').trim();
    if (!s) continue;
    if (s.endsWith('*') ? n.startsWith(s.slice(0, -1)) : n === s || n.startsWith(s.endsWith('/') ? s : `${s}/`)) return true;
  }
  return false;
}

/**
 * What would be sent: the public packages of the lockfiles (once per ecosystem, name and version), and how many were
 * held back and why. Reads only the texts it is given.
 * @param {{ lockfiles: { file: string, text: string }[], privateScopes?: string[] }} o
 */
function plan({ lockfiles = [], privateScopes = [] } = {}) {
  const send = [];
  const seen = new Map();
  const held = Object.fromEntries([['total', 0], ...HELD_REASONS.map((r) => [r, 0])]);
  const files = [];
  for (const lf of lockfiles) {
    const r = L.auditPackages(lf.file, lf.text);
    if (!r) continue;
    files.push(lf.file);
    const eco = ECOSYSTEMS[r.ecosystem];
    for (const p of r.packages) {
      const reason = p.origin !== 'public' ? (HELD_REASONS.includes(p.origin) ? p.origin : 'unknown') : isPrivateName(p.name, privateScopes) ? 'scope' : null;
      if (reason || !eco) {
        held.total += 1;
        held[reason ?? 'unknown'] += 1;
        continue;
      }
      const k = `${eco}\u0000${p.name}\u0000${p.version}`;
      const had = seen.get(k);
      if (had) {
        if (had.dev !== p.dev) had.dev = had.dev === false || p.dev === false ? false : null;
        continue;
      }
      const q = { ecosystem: eco, name: p.name, version: p.version, dev: p.dev };
      seen.set(k, q);
      send.push(q);
    }
  }
  const ecosystems = {};
  for (const q of send) ecosystems[q.ecosystem] = (ecosystems[q.ecosystem] ?? 0) + 1;
  return { send, held, ecosystems, host: HOST, lockfiles: files };
}

/** The querybatch bodies: ecosystem, name and version per package, nothing else. */
function requestBodies(send) {
  const out = [];
  for (let i = 0; i < send.length; i += BATCH)
    out.push({ queries: send.slice(i, i + BATCH).map((q) => ({ package: { ecosystem: q.ecosystem, name: q.name }, version: q.version })) });
  return out;
}

const ecoText = (ecosystems) => Object.entries(ecosystems).map(([e, n]) => `${e} ${n}`).join(', ') || 'none';
const heldText = (held) => {
  const why = HELD_REASONS.filter((r) => held[r]).map((r) => `${held[r]} ${r === 'scope' ? 'by deps.privateScopes' : r}`);
  return `${held.total} held back${why.length ? ` (${why.join(', ')})` : ''}`;
};

/** What --dry prints: the summary line, then each request body as one JSON line per query. */
function dryText(p) {
  const lines = [
    `Would send ${p.send.length} packages to ${p.host} (${ecoText(p.ecosystems)}); ${heldText(p.held)}. From: ${p.lockfiles.join(', ') || 'no lockfile'}.`,
    'Each query is the ecosystem, the name and the version, nothing else. Nothing was sent.',
  ];
  for (const body of requestBodies(p.send)) {
    lines.push(`POST https://${p.host}/v1/querybatch`);
    for (const q of body.queries) lines.push(`  ${JSON.stringify(q)}`);
  }
  return lines;
}

/** A plain message for a failed call. Never the package names: they stay out of logs and messages. */
function failText(e, timeoutMs) {
  const name = e?.name ?? '';
  if (name === 'TimeoutError' || name === 'AbortError') return `${HOST} did not answer within ${Math.round(timeoutMs / 1000)} s. Try again later.`;
  return `Could not reach ${HOST} (no network, or it is blocked here). Nothing was cached.`;
}

/** One call: { ok, body } or { ok: false, error }. Never throws. */
async function call(fetchFn, url, init, timeoutMs) {
  let r;
  try {
    r = await fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    return { ok: false, error: failText(e, timeoutMs) };
  }
  if (!r || r.status !== 200) return { ok: false, error: `${HOST} answered ${r?.status ?? 'nothing'}.`, status: r?.status };
  try {
    return { ok: true, body: await r.json() };
  } catch {
    return { ok: false, error: `The answer from ${HOST} could not be read.` };
  }
}

// ---- severity ----------------------------------------------------------------------------------------------------

const CVSS3 = {
  AV: { N: 0.85, A: 0.62, L: 0.55, P: 0.2 },
  AC: { L: 0.77, H: 0.44 },
  UI: { N: 0.85, R: 0.62 },
  CIA: { H: 0.56, L: 0.22, N: 0 },
};
/** CVSS v3.x "round up" to one decimal, as the specification does it (integer arithmetic). */
const roundUp = (x) => {
  const i = Math.round(x * 100000);
  return i % 10000 === 0 ? i / 100000 : (Math.floor(i / 10000) + 1) / 10;
};

/** The CVSS v3.0/3.1 base score of a vector, or null when it is not one. */
function cvss3Score(vector) {
  const m = /^CVSS:3\.[01]\/(.+)$/.exec(String(vector ?? '').trim());
  if (!m) return null;
  const v = Object.fromEntries(m[1].split('/').map((p) => p.split(':')));
  const changed = v.S === 'C';
  const pr = { N: 0.85, L: changed ? 0.68 : 0.62, H: changed ? 0.5 : 0.27 }[v.PR];
  const [av, ac, ui, c, i, a] = [CVSS3.AV[v.AV], CVSS3.AC[v.AC], CVSS3.UI[v.UI], CVSS3.CIA[v.C], CVSS3.CIA[v.I], CVSS3.CIA[v.A]];
  if ([av, ac, pr, ui, c, i, a].some((x) => x == null) || !['U', 'C'].includes(v.S)) return null;
  const iss = 1 - (1 - c) * (1 - i) * (1 - a);
  const impact = changed ? 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15 : 6.42 * iss;
  if (impact <= 0) return 0;
  const exploit = 8.22 * av * ac * pr * ui;
  return roundUp(Math.min((changed ? 1.08 : 1) * (impact + exploit), 10));
}

const WORDS = { critical: 'critical', high: 'high', moderate: 'moderate', medium: 'moderate', low: 'low' };
/** The severity: the advisory's own word (GitHub's), then a CVSS v3 vector, else unknown. */
function severityOf(vuln) {
  const words = [vuln?.database_specific?.severity, ...(Array.isArray(vuln?.affected) ? vuln.affected.map((x) => x?.ecosystem_specific?.severity) : [])];
  for (const w of words) {
    const s = WORDS[String(w ?? '').toLowerCase()];
    if (s) return s;
  }
  for (const s of Array.isArray(vuln?.severity) ? vuln.severity : []) {
    const score = cvss3Score(s?.score);
    if (score == null) continue;
    return score >= 9 ? 'critical' : score >= 7 ? 'high' : score >= 4 ? 'moderate' : score > 0 ? 'low' : 'unknown';
  }
  return 'unknown';
}

/** The lowest fixed version above the locked one, in the ranges for this package, or null. */
function fixedFor(vuln, pkg) {
  const fixes = [];
  for (const a of Array.isArray(vuln?.affected) ? vuln.affected : []) {
    if (a?.package?.name !== pkg.name || (a.package.ecosystem && a.package.ecosystem !== pkg.ecosystem)) continue;
    for (const r of Array.isArray(a.ranges) ? a.ranges : [])
      for (const e of Array.isArray(r?.events) ? r.events : [])
        if (typeof e?.fixed === 'string' && L.compareVersions(e.fixed, pkg.version) > 0) fixes.push(e.fixed);
  }
  return fixes.sort(L.compareVersions)[0] ?? null;
}

const severityRank = (s) => {
  const i = SEVERITIES.indexOf(s);
  return i < 0 ? SEVERITIES.length : i;
};
/** Worst first; within a severity code that ships (dev false) before unknown before development only. */
const devRank = (d) => (d === false ? 0 : d == null ? 1 : 2);
const worstFirst = (a, b) => severityRank(a.severity) - severityRank(b.severity) || devRank(a.dev) - devRank(b.dev) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

/** Merges the advisories of one package that are aliases of each other (PYSEC and GHSA for one hole). */
function mergeAliases(list) {
  const out = [];
  for (const f of list) {
    const same = out.find((o) => o.aliases.includes(f.id) || f.aliases.includes(o.id) || o.aliases.some((x) => f.aliases.includes(x)));
    if (!same) {
      out.push(f);
      continue;
    }
    const keep = severityRank(f.severity) < severityRank(same.severity) || (same.severity === f.severity && /^GHSA-/.test(f.id) && !/^GHSA-/.test(same.id)) ? f : same;
    const other = keep === f ? same : f;
    const merged = {
      ...keep,
      aliases: [...new Set([...keep.aliases, other.id, ...other.aliases])].filter((x) => x !== keep.id),
      fixed: keep.fixed ?? other.fixed,
      summary: keep.summary || other.summary,
    };
    out[out.indexOf(same)] = merged;
  }
  return out;
}

/**
 * Asks OSV.dev. Never throws: a failure is a plain message in errors, and no findings.
 * @param {{ send: object[], fetch?: Function, timeoutMs?: number, now?: number, maxDetails?: number }} o
 */
async function audit({ send = [], fetch: fetchFn = globalThis.fetch, timeoutMs = TIMEOUT_MS, now = Date.now(), maxDetails = MAX_DETAILS } = {}) {
  const checkedAt = new Date(now).toISOString();
  const errors = [];
  if (!send.length) return { checkedAt, findings: [], errors };
  const headers = { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'ravenseat' };
  const hits = []; // [{ pkg, ids }]
  const bodies = requestBodies(send);
  for (let b = 0; b < bodies.length; b++) {
    const r = await call(fetchFn, `${BASE}/querybatch`, { method: 'POST', headers, body: JSON.stringify(bodies[b]) }, timeoutMs);
    const results = r.ok && isObject(r.body) && Array.isArray(r.body.results) ? r.body.results : null;
    if (!r.ok || !results || results.length !== bodies[b].queries.length) {
      errors.push(r.ok ? `The answer from ${HOST} could not be read.` : r.error);
      return { checkedAt, findings: [], errors };
    }
    results.forEach((res, i) => {
      const ids = (Array.isArray(res?.vulns) ? res.vulns : []).map((v) => v?.id).filter((id) => typeof id === 'string' && /^[A-Za-z0-9._:-]{1,80}$/.test(id));
      if (ids.length) hits.push({ pkg: send[b * BATCH + i], ids });
    });
  }
  const unique = [...new Set(hits.flatMap((h) => h.ids))];
  const details = new Map();
  let failed = 0;
  const wanted = unique.slice(0, maxDetails);
  for (let i = 0; i < wanted.length; i += PARALLEL) {
    const part = wanted.slice(i, i + PARALLEL);
    const answers = await Promise.all(part.map((id) => call(fetchFn, `${BASE}/vulns/${encodeURIComponent(id)}`, { method: 'GET', headers: { accept: headers.accept, 'user-agent': headers['user-agent'] } }, timeoutMs)));
    answers.forEach((r, j) => {
      if (r.ok && isObject(r.body)) details.set(part[j], r.body);
      else failed += 1;
    });
  }
  if (failed) errors.push(`${failed} ${failed === 1 ? 'advisory' : 'advisories'} could not be fetched; listed by id with severity unknown.`);
  if (unique.length > wanted.length) errors.push(`${unique.length - wanted.length} more advisories than the ${maxDetails} fetched in one run; listed by id with severity unknown.`);
  const findings = [];
  for (const h of hits) {
    const list = h.ids.map((id) => {
      const v = details.get(id);
      return {
        id,
        aliases: Array.isArray(v?.aliases) ? v.aliases.filter((x) => typeof x === 'string').slice(0, 10) : [],
        summary: cut(oneLine(v?.summary ?? ''), SUMMARY_MAX),
        severity: v ? severityOf(v) : 'unknown',
        ecosystem: h.pkg.ecosystem,
        name: h.pkg.name,
        version: h.pkg.version,
        fixed: v ? fixedFor(v, h.pkg) : null,
        dev: h.pkg.dev ?? null,
      };
    });
    findings.push(...mergeAliases(list));
  }
  return { checkedAt, findings: findings.sort(worstFirst), errors };
}

// ---- cache -------------------------------------------------------------------------------------------------------

/** The cached report, or null (missing, broken or another version). */
function readCache(folder) {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(folder, CACHE_FILE), 'utf8'));
    return isObject(c) && c.version === CACHE_VERSION && Array.isArray(c.findings) ? c : null;
  } catch {
    return null;
  }
}

/** Writes the report (temp file and rename, so a reader never sees half of it). Errors are the caller's. */
function writeCache(folder, report) {
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, CACHE_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ ...report, version: CACHE_VERSION }, null, 2)}\n`);
  renameWithRetry(tmp, file);
}

// ---- summary -----------------------------------------------------------------------------------------------------

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * The cache as the card and doctor see it. accepted: the owner's accepted risk acceptances ({ id, accepts, reviewBy },
 * lib/catalog.js acceptedAdvisories). One whose review date has passed no longer hides anything and is listed in lapsed.
 */
function summarize(cache, { accepted = [], now = Date.now() } = {}) {
  const today = dayOf(now);
  const live = [];
  const lapsed = [];
  for (const a of Array.isArray(accepted) ? accepted : []) {
    if (typeof a?.reviewBy === 'string' && a.reviewBy < today) lapsed.push({ id: a.id, reviewBy: a.reviewBy });
    else live.push(a);
  }
  const hidden = new Set(live.flatMap((a) => (Array.isArray(a.accepts) ? a.accepts : [])));
  const all = Array.isArray(cache?.findings) ? cache.findings : [];
  const open = [];
  let acceptedCount = 0;
  for (const f of all) {
    if (hidden.has(f.id) || (f.aliases ?? []).some((x) => hidden.has(x))) acceptedCount += 1;
    else open.push(f);
  }
  open.sort(worstFirst);
  const counts = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
  for (const f of open) counts[SEVERITIES.includes(f.severity) ? f.severity : 'unknown'] += 1;
  const at = Date.parse(cache?.checkedAt);
  return {
    checkedAt: cache?.checkedAt ?? null,
    ageDays: Number.isFinite(at) ? Math.max(0, Math.floor((now - at) / 86400000)) : null,
    sent: cache?.sent ?? 0,
    counts,
    open: open.length,
    highProd: open.filter((f) => (f.severity === 'critical' || f.severity === 'high') && f.dev !== true).length,
    worst: open.slice(0, WORST),
    all: open,
    accepted: acceptedCount,
    lapsed,
    errors: Array.isArray(cache?.errors) ? cache.errors : [],
  };
}

/** "1 critical, 2 high" (only the severities that have any), or null. */
function countText(counts) {
  const parts = SEVERITIES.filter((s) => counts?.[s]).map((s) => `${counts[s]} ${s}`);
  return parts.length ? parts.join(', ') : null;
}

const ageText = (d) => (d == null ? 'at an unknown time' : d === 0 ? 'today' : d === 1 ? '1 day ago' : `${d} days ago`);

/** doctor --all's line (the cache only). */
function doctorLine(s) {
  return `last audit ${ageText(s.ageDays)}: ${countText(s.counts) ?? 'no known holes'} (from the cache, no network)`;
}

/** One finding as a line: "lodash 4.17.20 to 4.17.21 or later (GHSA-..., high)". */
function findingText(f) {
  const to = f.fixed ? ` to ${f.fixed} or later` : ' (no fixed version published yet)';
  return `${f.name} ${f.version}${to} (${f.id}, ${f.severity}${f.dev === true ? ', development only' : ''})`;
}

/** The proposed update task the card's button adds: the packages, the versions, and run the gates. */
function fixTask(s, { id }) {
  const rows = s.all.slice(0, TASK_ROWS);
  const more = s.all.length > rows.length ? `\n- And ${s.all.length - rows.length} more: \`ravenseat catalog deps --audit\` lists them.` : '';
  return {
    id,
    title: 'Update libraries with known holes',
    class: 'D',
    domain: 'deps',
    feature: 'Dependencies',
    value: s.highProd ? 8 : 5,
    content_min: 40,
    labels: ['dependencies', 'security'],
    added_by: 'checks agent',
    own_track: 'a dependency update the owner chose on the Checks tab',
    mission: [
      `Update the libraries the last dependency audit (OSV.dev, ${ageText(s.ageDays)}) found with known holes, worst first:`,
      rows.map((f) => `- Update ${findingText(f)}`).join('\n') + more,
      'Use the project\'s own package manager and update the lockfile with it. A package that is only a dependency of another one is updated through that one (or an override, if the project already uses them). ' +
        'Change no other code unless the update needs it. If a fix needs a new major version, or none is published, do not force it: write what you found in track-result.md.',
      'Run the gates. Never push or deploy.',
    ].join('\n\n'),
    acceptance: ['The listed packages are at the fixed version or later in the lockfile, or track-result.md says why not', 'The gates pass'],
  };
}

module.exports = {
  HOST,
  DEFAULTS,
  setupOf,
  setupProblems,
  CACHE_FILE,
  SEVERITIES,
  ECOSYSTEMS,
  isPrivateName,
  plan,
  requestBodies,
  dryText,
  audit,
  severityOf,
  cvss3Score,
  fixedFor,
  readCache,
  writeCache,
  summarize,
  countText,
  doctorLine,
  findingText,
  fixTask,
};
