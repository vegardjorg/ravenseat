// =============================================================
// mergeGuard.js: the guard check merge-track.mjs runs BEFORE a track branch is merged (hardening against prompt
// injection).
//
// WHY: a track can change hooks, settings, agent definitions, orchestrator scripts, the queue config and CI. A hook in
// .claude/settings.json runs with the owner's full rights in the orchestrator session the next time it starts. If the
// track has read hostile text (a PDF, a web page, another agent's report) and followed an instruction in it, that must
// not slip silently through the merge. The guard lives here because Claude Code has no sandbox on Windows.
//
// The rule:
//   - STOP: the diff touches a protected path (config().protectedPaths) that is not in the task's owned_files or
//     shared_patch. `--allow-guard` overrides; merge-track.mjs logs it in the time log (event "guard-overridden").
//   - WARNING: other files outside owned_files + shared_patch (ownership drift). Migrations in the task's migr_block
//     count as owned. If the task has no ownership at all, no drift warning: nothing was promised, so nothing drifted.
//     Those files come back as `unlisted`, so a queue task without owned_files still shows what its merge changes.
//   - Ownership ending with "/" covers the whole folder; otherwise the path must be equal.
//   - Rename and copy count both paths: moving a file INTO .claude/ is as dangerous as writing it there, and moving
//     .claude/settings.json OUT deletes it.
//
// Protected path entries (protectedPaths in queue.config.json, see STANDARD in queueConfig.js):
//   "folder/"      the folder and everything under it (from the root)
//   "dir/file"     exactly that path (from the root)
//   "name"         (no slash) a file with that name in ANY folder, e.g. package.json: npm runs lifecycle scripts
//                  (postinstall …) from every package.json.
//   "glob"         an entry with * or ?: without a slash it is matched against the file name in ANY folder
//                  ("vitest.config.*", "tsconfig*.json"); with a slash against the whole path from the root, where
//                  "**/" is any folders (also none). "*" and "?" never cross a "/".
// Case does NOT matter for the protected check (M3 in plans/review-2026-11-02.md): on Windows and macOS (and with
// core.ignorecase) ".CLAUDE/settings.json" is checked out into the same folder as ".claude/", so a guard that only
// knew the lower-case spelling could be walked around. Over-matching on a case-sensitive system costs one guard stop.
// Paths under node_modules/ are never protected (they are links, not committed).
//
// Pure logic without I/O; merge-track.mjs fetches the diff (git diff --name-status -M) and the task (queue.json).
// Test: lib/__tests__/mergeGuard.test.ts.
// =============================================================

/** Common form of a path: forward slashes, no leading ./ */
function norm(p) {
  return String(p || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^(\.\/)+/, '');
}

// The floor: the files that carry the switches and the rules. Always protected, also when a project replaces or empties
// protectedPaths; otherwise a track could turn the guards off through the config it delivers. --allow-guard still works
// per merge, with the diff in front of the owner.
const CORE_PROTECTED = [
  '.claude/',
  '**/.claude/',
  '.claude-plugin/',
  '.githooks/',
  '.husky/',
  'lefthook.yml',
  '.lefthook.yml',
  'lefthook-local.yml',
  'CLAUDE.md',
  'CLAUDE.local.md',
  'CLAUDE.queue.md',
  'queue.config.json',
  'settings.queue.json',
  'scripts/orchestrator/',
];

/** The default list (STANDARD.protectedPaths), read lazily so this module stays pure for the tests. */
function defaultProtected() {
  return require('./queueConfig.js').STANDARD.protectedPaths;
}

/**
 * The protected paths plus extra exact paths (the custom helpers' agent files, queueHelpers.customPaths). `base`
 * undefined = the defaults. The extra paths are protected even when the project emptied or changed the list.
 * @param {string[]|undefined} base
 * @param {string[]} extra
 */
function withPaths(base, extra = []) {
  const out = [...(Array.isArray(base) ? base : defaultProtected())];
  for (const p of extra ?? []) {
    const n = norm(p);
    if (n && !out.map(norm).includes(n)) out.push(n);
  }
  return out;
}

/**
 * Does a glob pattern match the path? "*" = any characters except "/", "?" = one such character, "**" before a "/" =
 * any folders (also none). A pattern without a slash is matched against the file name only; one ending in "/" covers the folder.
 * @param {string} pattern
 * @param {string} p a normalised path (forward slashes)
 * @param {{ ignoreCase?: boolean }} [o] ignoreCase: compare without regard to case (the protected check does)
 */
function globMatch(pattern, p, o = {}) {
  let g = norm(pattern);
  if (!g) return false;
  const s = norm(p);
  if (g.endsWith('/')) g += '**';
  const subject = g.includes('/') ? s : s.split('/').pop();
  let r = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      i++;
      if (g[i + 1] === '/') {
        r += '(?:.*/)?';
        i++;
      } else r += '.*';
    } else if (c === '*') r += '[^/]*';
    else if (c === '?') r += '[^/]';
    else r += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${r}$`, o.ignoreCase ? 'i' : '').test(subject);
}

/**
 * Is the path protected?
 * @param {string} p
 * @param {string[]} [protectedPaths] default STANDARD.protectedPaths; CORE_PROTECTED always counts on top
 */
function isProtected(p, protectedPaths = defaultProtected()) {
  return inList(p, [...CORE_PROTECTED, ...(protectedPaths || [])]);
}

/**
 * Does a path match an entry in a path list, with the protectedPaths rules ("folder/", "dir/file", a bare name in any
 * folder, a glob)? No floor added. Also used for the hotspots (lib/hotspots.js).
 */
function inList(p, list) {
  // Compared in lower case (see the top of the file): .CLAUDE/ is .claude/ on Windows and macOS.
  const s = norm(p).toLowerCase();
  if (s.startsWith('node_modules/') || s.includes('/node_modules/')) return false;
  const name = s.split('/').pop();
  return (list || []).map((b) => norm(b).toLowerCase()).some((b) => {
    if (!b) return false;
    if (/[*?]/.test(b)) return globMatch(b, s, { ignoreCase: true });
    if (b.endsWith('/')) return s.startsWith(b);
    if (!b.includes('/')) return name === b;
    return s === b;
  });
}

/** Does one ownership entry cover the path? "folder/" covers subfolders, otherwise exactly equal. */
function covers(owner, p) {
  const e = norm(owner);
  if (!e) return false;
  return e.endsWith('/') ? p.startsWith(e) : p === e;
}

/**
 * Does the migration block ("3600–3609", or "20260926002840–2849" with a shortened end) cover the migration file?
 * The file must lie directly in migrations.folder, and its name must match migrations.filePattern (group 1 = the
 * number). A shortened end replaces the last digits of the start.
 * @param {string} p
 * @param {string|null} migrBlock
 * @param {{ folder?: string|null, filePattern?: string }|null} [migrations]
 */
function migrCovered(p, migrBlock, migrations) {
  if (!migrBlock || !migrations?.folder) return false;
  const s = norm(p);
  const folder = norm(migrations.folder).replace(/\/+$/, '');
  if (!s.startsWith(`${folder}/`)) return false;
  const file = s.slice(folder.length + 1);
  if (file.includes('/')) return false;
  let m;
  try {
    m = file.match(new RegExp(migrations.filePattern || '^(\\d+)_'));
  } catch {
    return false;
  }
  if (!m || !/^\d+$/.test(m[1] ?? '')) return false;
  const pieces = String(migrBlock)
    .split(/\s*[–—-]\s*/)
    .map((d) => d.trim())
    .filter(Boolean);
  if (pieces.length === 0 || !pieces.every((d) => /^\d+$/.test(d))) return false;
  const from = pieces[0];
  let to = pieces[1] ?? from;
  if (to.length < from.length) to = from.slice(0, from.length - to.length) + to;
  const n = m[1];
  if (n.length !== from.length) return false;
  return BigInt(n) >= BigInt(from) && BigInt(n) <= BigInt(to);
}

/**
 * Parse the output of `git diff --name-status -M`. Each line: "M\tpath", "R100\told\tnew", "C075\tfrom\tto".
 * Returns [{ status: 'M'|'A'|'D'|'R'|'C'|…, paths: [..] }].
 * @param {string} text
 */
function readDiff(text) {
  return String(text || '')
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => {
      const [code, ...paths] = l.split('\t');
      return { status: code.trim().charAt(0), paths: paths.map(norm).filter(Boolean) };
    })
    .filter((e) => e.paths.length > 0);
}

/**
 * The task id from a queue branch: "queue/A-1" and "origin/queue/A-1" give "A-1"; other branches give null.
 * @param {string} branch
 * @param {string} [branchPrefix] config().branchPrefix, default "queue/"
 */
function taskIdFromBranch(branch, branchPrefix = 'queue/') {
  const prefix = String(branchPrefix || '');
  if (!prefix) return null;
  const esc = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = String(branch || '').match(new RegExp(`(?:^|/)${esc}([^/]+)$`));
  return m ? m[1] : null;
}

/** The migration folders of the usual tools, at any depth: a project with no migration flow configured has them too. */
const MIGRATION_PATH = /(^|\/)(migrations|db\/migrate|alembic\/versions|drizzle)\//i;

/** Is the path a migration file, in a usual folder or in config().migrations.folder? */
function isMigrationPath(p, migrations = null) {
  const path = norm(p);
  if (MIGRATION_PATH.test(path)) return true;
  const folder = migrations?.folder ? norm(migrations.folder).replace(/\/+$/, '') : '';
  return Boolean(folder) && path.toLowerCase().startsWith(`${folder.toLowerCase()}/`);
}

// Dependency files: protected by default, but a task adding a library is ordinary work. dependencyFiles "warn" lets them
// through with a warning. Only these names, and only when the floor does not cover the path.
const DEPENDENCY_FILES = ['package.json', 'package-lock.json', 'pyproject.toml', 'cargo.toml', 'go.mod', 'gemfile', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'composer.json'];
const isDependencyName = (name) => DEPENDENCY_FILES.includes(name) || /^requirements.*\.txt$/.test(name);
const isDependencyFile = (p) => isDependencyName(norm(p).toLowerCase().split('/').pop()) && !isProtected(p, []);

/**
 * Assess a diff against the task's ownership.
 * @param {{ changes: { status: string, paths: string[] }[], ownedFiles?: string[], sharedPatch?: string[],
 *           migrBlock?: string | null, migrations?: { folder?: string|null, filePattern?: string } | null,
 *           protectedPaths?: string[], allowGuard?: boolean, dependencyFiles?: string }} input
 * @returns {{ violations: { path: string, reason: string }[], drift: string[], unlisted: string[], warned: string[], stop: boolean, overridden: boolean }}
 */
function assessGuard({
  changes,
  ownedFiles = [],
  sharedPatch = [],
  migrBlock = null,
  migrations = null,
  protectedPaths = defaultProtected(),
  allowGuard = false,
  dependencyFiles = 'stop',
}) {
  const owned = [...(ownedFiles || []), ...(sharedPatch || [])].map(norm).filter(Boolean);
  const hasOwnership = owned.length > 0 || Boolean(migrBlock);
  const isOwned = (p) => owned.some((e) => covers(e, p)) || migrCovered(p, migrBlock, migrations);

  const violations = [];
  const drift = [];
  const unlisted = [];
  const warned = [];
  const seen = new Set();
  for (const e of changes || []) {
    const move = (e.status === 'R' || e.status === 'C') && e.paths.length === 2;
    e.paths.forEach((raw, i) => {
      const p = norm(raw);
      // On a copy the source is not changed; only the target counts.
      if (e.status === 'C' && i === 0) return;
      if (seen.has(p)) return;
      seen.add(p);
      if (isOwned(p)) return;
      if (dependencyFiles === 'warn' && isProtected(p, protectedPaths) && isDependencyFile(p)) warned.push(p);
      else if (isProtected(p, protectedPaths)) {
        let reason = "protected path, not in the task's owned_files/shared_patch";
        if (move && e.status === 'R')
          reason += i === 1 ? ` (renamed from ${e.paths[0]})` : ` (renamed to ${e.paths[1]})`;
        violations.push({ path: p, reason });
      } else if (!migrBlock && (protectedPaths || []).length > 0 && isMigrationPath(p, migrations)) {
        // A migration changes a database, so it never goes in with an ordinary task. An empty list turns the guard off.
        violations.push({ path: p, reason: 'migration file, and the task has no migration block and does not own it' });
      } else (hasOwnership ? drift : unlisted).push(p);
    });
  }
  return {
    violations,
    drift,
    unlisted,
    warned,
    stop: violations.length > 0 && !allowGuard,
    overridden: violations.length > 0 && Boolean(allowGuard),
  };
}

/**
 * What merge-track.mjs said for the owner, from its output: the warnings and notes with their indented file lines.
 * ravenseat merge shows only these from a green merge step; the rest of the step's output goes to the log.
 */
function ownerNotes(out) {
  const notes = [];
  let inNote = false;
  for (const line of String(out ?? '').split(/\r?\n/)) {
    if (/^(WARNING (ownership drift|dependency file)|NOTE )/.test(line)) {
      notes.push(line);
      inNote = true;
    } else if (inNote && line.startsWith('  ')) notes.push(line);
    else inNote = false;
  }
  return notes;
}

/** The statuses whose owned_files are held right now: the task is being built or waits for its merge. */
const ACTIVE_OWNER_STATUSES = ['running', 'review', 'picked'];

/**
 * The changed paths that ANOTHER active task owns (its owned_files; a shared_patch is shared by design, so it is no
 * ownership here). Before this, such a change merged with only "WARNING ownership drift", and stopped only when git saw
 * a text conflict. Used by merge-track.mjs (a stop), receive and the pulse (early notes).
 * @param {string[]} paths the changed paths
 * @param {{ id: string, owned_files?: string[], shared_patch?: string[] } | null} task the task being checked (null:
 *   a wave track, nothing to compare)
 * @param {object[]} tasks every task in the queue
 * @returns {{ path: string, owner: string }[]}
 */
function foreignOwners(paths, task, tasks) {
  if (!task) return [];
  const mine = [...(task.owned_files ?? []), ...(task.shared_patch ?? [])].map(norm).filter(Boolean);
  const others = (tasks ?? [])
    .filter((o) => o && o.id !== task.id && ACTIVE_OWNER_STATUSES.includes(o.status))
    .map((o) => ({ id: o.id, owned: (o.owned_files ?? []).map(norm).filter(Boolean) }))
    .filter((o) => o.owned.length);
  const out = [];
  const seen = new Set();
  for (const raw of paths ?? []) {
    const p = norm(raw);
    if (!p || seen.has(p)) continue;
    seen.add(p);
    if (mine.some((e) => covers(e, p))) continue;
    const owner = others.find((o) => o.owned.some((e) => covers(e, p)));
    if (owner) out.push({ path: p, owner: owner.id });
  }
  return out;
}

/**
 * The pulse lines for tracks whose branch changes files another active task owns, so it is seen before the merge.
 * @param {{ id: string }[]} tips the track tips (lib/conflictPredict.js tipsFor)
 * @param {object[]} tasks every task in the queue
 * @param {(tip: object) => string[]|null} filesOf the files the tip changed since the base (null: unknown)
 */
function ownershipPulseLines(tips, tasks, filesOf) {
  const byId = new Map((tasks ?? []).map((o) => [o.id, o]));
  const lines = [];
  for (const tip of tips ?? []) {
    const files = filesOf(tip);
    if (!files) continue;
    const foreign = foreignOwners(files, byId.get(tip.id) ?? null, tasks);
    if (!foreign.length) continue;
    const owners = [...new Set(foreign.map((f) => f.owner))].join(', ');
    const shown = foreign.slice(0, 5).map((f) => f.path).join(', ');
    lines.push(
      `OWNERSHIP: ${tip.id} changes ${foreign.length} file(s) owned by ${owners}: ${shown}${foreign.length > 5 ? ', …' : ''}. ` +
        'The merge stops on them; tell the track to leave them, or settle the ownership first.',
    );
  }
  return lines;
}

module.exports = {
  ACTIVE_OWNER_STATUSES,
  foreignOwners,
  ownershipPulseLines,
  inList,
  ownerNotes,
  isProtected,
  isMigrationPath,
  globMatch,
  readDiff,
  migrCovered,
  taskIdFromBranch,
  assessGuard,
  withPaths,
};
