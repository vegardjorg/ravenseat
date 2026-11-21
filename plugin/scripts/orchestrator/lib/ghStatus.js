// =============================================================
// ghStatus.js: the `ravenseat doctor` row for the GitHub CLI (TH-1 of
// plans/trailhead-gsd-skills-vurdering-2026-11-20.md, section 7).
//
// Why: the features that read GitHub through `gh` fail soft to "unknown" (the CI watch, external gate evidence, the
// branch-protection card) or stop with a short message (`ravenseat issues`). Without a word on WHY, a missing gh, a
// login that expired, or a GH_TOKEN / GITHUB_TOKEN in the environment that GitHub rejects (gh then prefers it over
// its own working login) all look the same. This row says which one it is, with the fix.
//
// Only when a gh feature is in use (featuresInUse): push.ciWatch github, gateEvidence.mode external, the
// branch-protection card (it has asked gh before: its cache exists), tasks or plans linked to an issue, or
// issues.labelMap, issues.onPush or push.pr. Otherwise there is no row and gh is never run, so a project that uses none of it makes no call.
//
// The steps: `gh --version` (local), then `gh auth status` (asks GitHub, short time limit). When that fails and a
// token variable is set, `gh auth status` once more without the token variables: a pass then means the variable is the
// one GitHub rejects. A network error or a time-out gives no row (nothing to say). Never FAIL: gh is optional.
// gh's output is never shown (it can name accounts and scopes); a token's value never reaches a row.
//
// Pure: the runner is injected (cli/doctor.mjs passes the real one, the tests a fake). Tested in
// lib/__tests__/ghStatus.test.ts.
// =============================================================
'use strict';

const TOKEN_VARS = ['GH_TOKEN', 'GITHUB_TOKEN'];
const NETWORK = /error connecting|could not resolve host|timed? ?out|dial tcp|no such host|network is unreachable|ECONN|ETIMEDOUT/i;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * The gh features in use, as names for the row. `facts`: { branchProtectionCache: boolean, issueLinks: number }.
 * @returns {string[]}
 */
function featuresInUse(cfg = {}, facts = {}) {
  const out = [];
  if (cfg?.push?.ciWatch === 'github') out.push('push.ciWatch github');
  if (cfg?.gateEvidence?.mode === 'external') out.push('gateEvidence external');
  if (facts.branchProtectionCache) out.push('the branch-protection card');
  if (facts.issueLinks) out.push('issue links');
  if (isObject(cfg?.issues?.labelMap) && Object.keys(cfg.issues.labelMap).length) out.push('issues.labelMap');
  // The GitHub writes (cli/ghWrite.mjs): in use only when set away from "off".
  if (['comment', 'close'].includes(cfg?.issues?.onPush)) out.push(`issues.onPush ${cfg.issues.onPush}`);
  if (cfg?.push?.pr === 'draft') out.push('push.pr draft');
  return out;
}

const row = (status, message, fix = null) => ({ status, name: 'gh', message, fix });
const isNetwork = (r) => r?.timedOut === true || NETWORK.test(`${r?.err ?? ''}\n${r?.out ?? ''}`);

/**
 * The rows (zero or one). `run(args, { env })` -> { missing?, code, out, err, timedOut? }.
 * @param {{ features: string[], run: Function, env: Record<string, string|undefined> }} o
 */
function doctorRows({ features, run, env = {} }) {
  if (!features?.length) return [];
  const need = features.join(', ');
  const v = run(['--version'], { env });
  if (v?.missing || (v?.code !== 0 && !v?.timedOut))
    return [row('WARN', `gh (the GitHub CLI) is not installed, and ${need} need${features.length === 1 ? 's' : ''} it`, 'install it from https://cli.github.com, then run gh auth login')];
  const a = run(['auth', 'status'], { env });
  if (a?.code === 0) return [row('OK', `gh is signed in (used by ${need})`)];
  if (isNetwork(a)) return [];
  const set = TOKEN_VARS.filter((k) => typeof env[k] === 'string' && env[k] !== '');
  if (set.length) {
    const without = { ...env };
    for (const k of TOKEN_VARS) delete without[k];
    const b = run(['auth', 'status'], { env: without });
    if (b?.code === 0) {
      const names = set.join(' and ');
      return [
        row(
          'WARN',
          `${names} ${set.length === 1 ? 'is' : 'are'} set and GitHub rejects it, while gh's own login works; gh uses the variable first, so ${need} read nothing`,
          `unset ${names} in the environment that starts Claude Code, or replace it with a valid token`,
        ),
      ];
    }
    if (isNetwork(b)) return [];
  }
  return [row('WARN', `gh is not signed in, so ${need} read nothing from GitHub`, 'run gh auth login')];
}

module.exports = { TOKEN_VARS, featuresInUse, doctorRows };
