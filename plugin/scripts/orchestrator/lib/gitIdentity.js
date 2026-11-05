// =============================================================
// gitIdentity.js: is this git identity fit for merge commits? One rule for merge-track.mjs (the guard that stops the
// merge), cq doctor and cq fill (which say so before hours of work reach that stop).
//
// Why: a test identity left in a repo's config would end up in every merge commit, so the merge refuses it. The
// advice is the repo-local command, so it never changes the owner's other projects.
// Used by: merge-track.mjs, cli/doctorBaseline.mjs, cli/run.mjs. Tested in: lib/__tests__/doctorBaseline.test.ts.
// =============================================================
const { spawnSync } = require('node:child_process');

/** The one-line advice: repo-local, not --global. */
const IDENTITY_FIX =
  'git config user.name "Your Name" && git config user.email you@yourdomain.com (for this repo only). If the address is meant, add it to identity.allow in queue.config.json';

/** The address in `Name <address>`, lower case; '' when there is none. */
const addressOf = (text) => (text.match(/<([^>]*)>/)?.[1] ?? '').trim().toLowerCase();

/**
 * Does `git var GIT_COMMITTER_IDENT` text look like a test identity, or is it missing? `allow` (identity.allow) lists the
 * addresses the owner accepts anyway. A missing identity cannot be allowed.
 */
function identityRefused(ident, allow = []) {
  const text = String(ident ?? '').trim();
  if (!text) return true;
  const address = addressOf(text);
  if (address && (Array.isArray(allow) ? allow : []).some((a) => String(a).trim().toLowerCase() === address)) return false;
  return /@(example\.(com|org|net|invalid)|[^>\s]*\.invalid)>/i.test(text);
}

/** The identity git would commit with here: { ident, refused }. */
function readIdentity(cwd) {
  const r = spawnSync('git', ['var', 'GIT_COMMITTER_IDENT'], { encoding: 'utf8', ...(cwd ? { cwd } : {}) });
  const ident = r.status === 0 ? String(r.stdout ?? '').trim().replace(/\s+\d+\s+[+-]\d{4}$/, '') : '';
  let allow = [];
  try {
    allow = require('./queueConfig.js').config().identity?.allow ?? [];
  } catch {
    // An unreadable config allows nothing extra.
  }
  return { ident, refused: identityRefused(ident, allow) };
}

module.exports = { IDENTITY_FIX, identityRefused, readIdentity };
