// =============================================================
// cli/depsAudit.mjs: `ravenseat catalog deps --audit`, the dependency audit against OSV.dev (roadmap 0å KD-4,
// lib/osv.js, plans/katalog-design-stack-avhengigheter-2026-11-18.md section 6.2).
//
//   ravenseat catalog deps --audit --dry       what would be sent (the count, the ecosystems, what is held back, the host
//                                              and every query); sends nothing
//   ravenseat catalog deps --audit [--yes]     asks api.osv.dev about the public packages in the lockfiles and caches the
//                                              answer in <dataFolder>/deps-audit.json. The first real run needs --yes.
//   ... --anyway                               asks OSV.dev also when the project's own gates or CI already run an audit
//                                              tool (otherwise the command names that tool and stops: it does not
//                                              double the work)
//   ... --json                                 the result as JSON
//
// The network is used only here, only on the owner's command: deps.audit manual (off refuses), never from a track
// worktree (the push guard's list of catalog commands for queue agents is not extended either). Only ecosystem, name and
// version of public packages leave; lib/osv.js plan holds back the rest and deps.privateScopes.
//
// Also the readers of the cache, which never call the network: depAuditSummary (the Checks card, cli/checks.mjs) and
// doctorDepsAudit (doctor --all, cli/doctor.mjs).
//
// Used by: cli/catalog.mjs (catalog deps), cli/checks.mjs, cli/doctor.mjs. Tested in: __tests__/depsAuditFlow.test.ts.
// =============================================================

import fs from 'node:fs';
import path from 'node:path';

import { a, CLI, CONFIG, die, FOLDER, MAIN_TREE, require } from './context.mjs';
import { catalogDir, notFromTrack, readLedger, trackedFiles } from './catalog.mjs';

const OSV = require('./lib/osv.js');
const L = require('./lib/lockfiles.js');
const C = require('./lib/catalog.js');

/** At most this many lockfiles, each at most this big: a monorepo with more is read in part, and says so. */
const LOCK_MAX = 30;
const LOCK_BYTES = 32 * 1024 * 1024;
const SKIP_DIR = /(?:^|\/)(?:node_modules|vendor|\.git|target|dist|build)\//;

/** The lockfiles of a tree: the tracked ones the audit can read (any folder), and one at the root that is only on disk. */
export function lockfilesIn(root) {
  const names = new Set(Object.keys(L.LOCK_FORMATS));
  const tracked = (trackedFiles(root) ?? []).filter((f) => names.has(f.split('/').pop()) && !SKIP_DIR.test(f));
  for (const n of names) if (!tracked.includes(n) && fs.existsSync(path.join(root, n))) tracked.push(n);
  const files = tracked.sort((x, y) => x.split('/').length - y.split('/').length || x.localeCompare(y));
  const out = [];
  let skipped = Math.max(0, files.length - LOCK_MAX);
  for (const file of files.slice(0, LOCK_MAX)) {
    try {
      const full = path.join(root, ...file.split('/'));
      if (fs.statSync(full).size > LOCK_BYTES) {
        skipped += 1;
        continue;
      }
      out.push({ file, text: fs.readFileSync(full, 'utf8') });
    } catch {
      skipped += 1; // error-ignored: a lockfile that cannot be read is counted as skipped
    }
  }
  return { lockfiles: out, skipped };
}

/** The audit tools the project's own gates, CI or scripts already run (lib/checksScan.js kind audit), read only. */
export function ownAuditTools(root = MAIN_TREE) {
  try {
    const SCAN = require('./lib/checksScan.js');
    const K = require('./lib/kickstart.js');
    const exists = (f) => fs.existsSync(path.join(root, f));
    const read = (f) => {
      try {
        return fs.readFileSync(path.join(root, f), 'utf8');
      } catch {
        return null;
      }
    };
    const list = (d) => {
      try {
        return fs.readdirSync(path.join(root, d));
      } catch {
        return [];
      }
    };
    const checks = K.detectChecks({ exists, read }).checks ?? [];
    const found = SCAN.scan({ exists, read, list, gates: CONFIG.gates, checks, migrationsFolder: CONFIG.migrations?.folder ?? null });
    return (found.kinds.find((k) => k.key === 'audit')?.places ?? []).filter((p) => p.command);
  } catch {
    return []; // error-ignored: unknown is "none found", and the command goes on
  }
}

/** The owner-accepted risk acceptances in the main tree's catalog; [] on any trouble. */
export function acceptedNow() {
  try {
    const cat = C.readCatalog(catalogDir(MAIN_TREE));
    return C.acceptedAdvisories(cat, readLedger());
  } catch {
    return [];
  }
}

/** The cache as the Checks card sees it (lib/osv.js summarize), or null: no cache, or deps.audit off. Never the network. */
export function depAuditSummary({ now = Date.now() } = {}) {
  if (OSV.setupOf(CONFIG).audit === 'off') return null;
  const cache = OSV.readCache(FOLDER);
  return cache ? OSV.summarize(cache, { accepted: acceptedNow(), now }) : null;
}

/**
 * doctor's rows (from the cache only, never the network): one INFO line with the last audit (only with --all), and one
 * per risk acceptance whose review date has passed (always). Nothing with deps.audit off or before the first audit.
 */
export function doctorDepsAudit({ now = Date.now() } = {}) {
  const s = depAuditSummary({ now });
  if (!s) return [];
  const row = (message, fix, onRequest) => ({ status: 'INFO', name: 'deps-audit', message, fix, ...(onRequest ? { onRequest: true } : {}) });
  return [
    row(OSV.doctorLine(s), `${CLI} catalog deps --audit (asks OSV.dev again)`, true),
    ...s.lapsed.map((l) => row(`${l.id} accepted its holes until ${l.reviewBy}; that date has passed, so they count again`, `${CLI} catalog show ${l.id}`)),
  ];
}

const USAGE = `${CLI} catalog deps --audit [--dry] [--yes] [--anyway] [--json]`;

/** `ravenseat catalog deps --audit ...` */
export async function cmdDepsAudit({ fetch: fetchFn = globalThis.fetch, now = Date.now() } = {}) {
  if (!a.includes('--audit')) die(`Use: ${USAGE}`);
  const json = a.includes('--json');
  const setup = OSV.setupOf(CONFIG);
  if (setup.audit === 'off')
    die(`The dependency audit is off (deps.audit off in queue.config.json). ${CLI} settings set deps.audit manual turns it on. Nothing was sent.`);
  notFromTrack('deps --audit');
  const dry = a.includes('--dry');
  // The project's own audit tool goes first: the same work twice only costs time and gives two answers.
  const own = ownAuditTools();
  if (own.length && !a.includes('--anyway')) {
    const where = own.slice(0, 3).map((p) => `\`${p.command}\` (${p.where === 'ci' ? `CI, ${p.file}` : p.where === 'gate' ? 'a gate' : p.file})`);
    const text =
      `Your project already runs an audit tool: ${where.join(', ')}. Use that one; its answer is the one your CI and gates act on. ` +
      `Nothing was sent. ${CLI} catalog deps --audit --anyway asks OSV.dev all the same.`;
    if (json) console.log(JSON.stringify({ ok: true, sent: 0, ownTools: own.map((p) => ({ where: p.where, file: p.file, command: p.command })), text }, null, 2));
    else console.log(text);
    return;
  }
  const { lockfiles, skipped } = lockfilesIn(MAIN_TREE);
  const plan = OSV.plan({ lockfiles, privateScopes: setup.privateScopes });
  const skippedLine = skipped ? ` ${skipped} lockfile(s) were too many or too big to read.` : '';
  if (dry) {
    if (json) console.log(JSON.stringify({ ok: true, dry: true, host: plan.host, send: plan.send.length, ecosystems: plan.ecosystems, held: plan.held, lockfiles: plan.lockfiles, bodies: OSV.requestBodies(plan.send) }, null, 2));
    else console.log(`${OSV.dryText(plan).join('\n')}${skippedLine ? `\n${skippedLine.trim()}` : ''}`);
    return;
  }
  if (!plan.send.length) {
    const why = plan.lockfiles.length ? `none of the packages in ${plan.lockfiles.join(', ')} is public` : 'no lockfile was found that the audit reads (npm, pnpm, yarn, bun, uv, poetry, Cargo, go.sum)';
    if (json) console.log(JSON.stringify({ ok: true, sent: 0, held: plan.held, text: `Nothing to ask: ${why}.` }, null, 2));
    else console.log(`Nothing to ask: ${why}. Nothing was sent.`);
    return;
  }
  // The first real run needs --yes: until the owner has seen what goes out once, nothing does.
  const before = OSV.readCache(FOLDER);
  if (!before?.confirmed && !a.includes('--yes'))
    die(
      `This sends ${plan.send.length} package names with their versions to ${plan.host} (${Object.entries(plan.ecosystems).map(([e, n]) => `${e} ${n}`).join(', ')}), and nothing else; ${plan.held.total} are held back as private. ` +
        `${CLI} catalog deps --audit --dry shows every query. Run it again with --yes to send them. Nothing was sent.`,
    );
  if (!json) console.log(`Asking ${plan.host} about ${plan.send.length} public packages (ecosystem, name and version only) ...`);
  const r = await OSV.audit({ send: plan.send, fetch: fetchFn, now });
  if (r.errors.length && !r.findings.length && r.errors.some((e) => !/advisor/.test(e))) {
    if (json) console.log(JSON.stringify({ ok: false, errors: r.errors }, null, 2));
    else console.log(`The audit did not finish: ${r.errors.join(' ')} The last cached result is kept.`);
    process.exitCode = 1;
    return;
  }
  const report = { checkedAt: r.checkedAt, host: plan.host, sent: plan.send.length, held: plan.held, ecosystems: plan.ecosystems, lockfiles: plan.lockfiles, findings: r.findings, errors: r.errors, confirmed: true };
  try {
    OSV.writeCache(FOLDER, report);
  } catch (e) {
    console.log(`The result could not be cached (${e?.message ?? e}); the Checks card and doctor will not see it.`);
  }
  const s = OSV.summarize(report, { accepted: acceptedNow(), now });
  if (json) {
    console.log(JSON.stringify({ ok: true, ...report, summary: { counts: s.counts, open: s.open, accepted: s.accepted, lapsed: s.lapsed } }, null, 2));
    return;
  }
  const counts = OSV.countText(s.counts);
  console.log(counts ? `Known holes: ${counts}${s.accepted ? ` (and ${s.accepted} accepted in the catalog)` : ''}.` : `No known holes${s.accepted ? ` besides ${s.accepted} accepted in the catalog` : ''}.`);
  for (const f of s.all.slice(0, 10)) console.log(`  ${f.severity.padEnd(8)} ${OSV.findingText(f)}${f.summary ? `: ${f.summary}` : ''}`);
  if (s.all.length > 10) console.log(`  and ${s.all.length - 10} more (${CLI} catalog deps --audit --json lists them all).`);
  for (const l of s.lapsed) console.log(`  ${l.id} was due for review on ${l.reviewBy}, so its holes count again.`);
  for (const e of r.errors) console.log(`NOTE  ${e}`);
  if (skippedLine) console.log(`NOTE ${skippedLine.trim()}`);
  console.log(
    `Cached in the data folder (${OSV.CACHE_FILE}). ` +
      (s.open
        ? `The Checks tab shows a card, and its button proposes one update task. A hole that does not apply to you: a catalog entry with kind dependency, accepts and review_by (${CLI} catalog propose --kind dependency --accepts <id> --review-by YYYY-MM-DD ...), which counts once you accept it.`
        : 'Nothing to do.'),
  );
}
