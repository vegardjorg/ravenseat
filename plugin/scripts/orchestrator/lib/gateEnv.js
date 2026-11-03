// =============================================================
// gateEnv.js: the scrubbed environment the gate commands (gates.mjs) run with.
//
// Why: the gate commands run the code a track just wrote (its tests, its lint config, its scripts), with the
// orchestrator's rights. They should not get what they do not need for that: tokens and cloud keys (a test could send
// them anywhere or push with them), and the variables that point to the queue's data folder, where the gate evidence
// store lives (lib/gateEvidence.js). gates.mjs records the evidence itself after the commands have exited; the
// commands never get the store's path from it.
//
// Rules (gateEnv), in this order:
//   1. KEEP always: what node, npm, git and the shell need on Windows and Linux (PATH, HOME, USERPROFILE, TEMP,
//      SystemRoot, ComSpec, PATHEXT, APPDATA, ...). These are never dropped, whatever the other rules say.
//   2. DROP the queue's location variables (every QUEUE_* name except the role marker QUEUE_AGENT_ROLE/QUEUE_ATTEMPT,
//      which only makes the child more restricted) and CLAUDE_PROJECT_DIR (the project root, from which the data
//      folder follows).
//   3. DROP every variable whose value contains one of `storePaths` (the store file, the data folder), compared without
//      case on Windows and with "/" for "\".
//   4. DROP secrets by name: known providers by prefix (AWS_, AZURE_, ANTHROPIC_, OPENAI_, ...), known names
//      (GITHUB_TOKEN, GH_TOKEN, NPM_TOKEN, SSH_AUTH_SOCK, GIT_ASKPASS, ...), and the generic shapes *_TOKEN, *_SECRET,
//      *_PASSWORD, *_API_KEY, *_ACCESS_KEY, *_PRIVATE_KEY, *_CREDENTIALS and npm's *_authToken. A plain *_KEY is kept
//      unless it belongs to a known provider: many projects use *_KEY for harmless settings.
//   Everything else is kept (a gate is a project's own command; an allowlist of everything it might need does not exist).
//
// Limits, said honestly: this is NOT isolation. The gate commands run as the same OS user without a sandbox, so a
// command can still find the data folder from its working directory (a track worktree lies under the project root),
// read the user's credential files, or start a process that outlives the run. The scrub protects against accidents and
// simple cheating (a test that reads QUEUE_FOLDER or GITHUB_TOKEN), not against a targeted attacker. A real boundary
// needs OS isolation (a sandbox around the gate commands), see plans/client-adapter-plan.md, "Tillitsgrense" point 7.
//
// Pure: no I/O. Tested in lib/__tests__/gateEnv.test.ts.
// =============================================================
'use strict';

/** Never dropped (upper case; Windows names are compared without case). */
const KEEP = new Set([
  'PATH', 'PATHEXT', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'USER', 'USERNAME', 'LOGNAME', 'SHELL',
  'TEMP', 'TMP', 'TMPDIR', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'APPDATA', 'LOCALAPPDATA',
  'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TZ', 'CI',
  'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_RUNTIME_DIR', 'FORCE_COLOR', 'NO_COLOR',
]);

/** The role marker for a track (plans/client-adapter-plan.md point 4): kept, it only restricts the child further. */
const QUEUE_KEEP = new Set(['QUEUE_AGENT_ROLE', 'QUEUE_ATTEMPT']);

/** Variables that point to the project root (and so to the data folder). */
const LOCATION_NAMES = new Set(['CLAUDE_PROJECT_DIR']);

/** Known secret names that the generic shapes below do not catch. */
const SECRET_NAMES = new Set([
  'GITHUB_TOKEN', 'GH_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITLAB_TOKEN', 'NPM_TOKEN', 'NODE_AUTH_TOKEN',
  'SSH_AUTH_SOCK', 'SSH_ASKPASS', 'GIT_ASKPASS', 'SUDO_ASKPASS', 'GOOGLE_APPLICATION_CREDENTIALS',
  'HF_TOKEN', 'HUGGING_FACE_HUB_TOKEN', 'DOCKER_AUTH_CONFIG', 'KUBECONFIG',
]);

/** Providers whose every variable is dropped (cloud accounts and model APIs). */
const SECRET_PREFIXES = [
  'AWS_', 'AZURE_', 'ARM_', 'GOOGLE_', 'GCLOUD_', 'GCP_', 'CLOUDSDK_', 'ANTHROPIC_', 'OPENAI_', 'GEMINI_',
  'MISTRAL_', 'COHERE_', 'GROQ_', 'DIGITALOCEAN_', 'HEROKU_', 'VERCEL_', 'NETLIFY_', 'CLOUDFLARE_',
  'SUPABASE_', 'STRIPE_', 'TWILIO_', 'SENTRY_AUTH', 'SLACK_', 'DOPPLER_', 'VAULT_',
];

/** Generic secret shapes in a name (upper case). */
const SECRET_SHAPES = [
  /(^|_)TOKEN$/,
  /(^|_)SECRET($|_)/,
  /(^|_)PASSWORD$/,
  /(^|_)PASSWD$/,
  /(^|_)API_?KEY$/,
  /(^|_)ACCESS_KEY(_ID)?$/,
  /(^|_)PRIVATE_KEY$/,
  /(^|_)CREDENTIALS?$/,
  /AUTHTOKEN/,
  /AUTH_TOKEN/,
];

/** Why `name` (with `value`) is dropped, or null when it is kept. Pure. */
function dropReason(name, value, { storePaths = [], windows = false } = {}) {
  const upper = String(name).toUpperCase();
  if (KEEP.has(upper)) return null;
  if (upper.startsWith('QUEUE_') && !QUEUE_KEEP.has(upper)) return 'queue location';
  if (LOCATION_NAMES.has(upper)) return 'queue location';
  const norm = (s) => {
    const t = String(s ?? '').split('\\').join('/');
    return windows ? t.toLowerCase() : t;
  };
  const v = norm(value);
  if (storePaths.some((p) => p && v.includes(norm(p)))) return 'points to the evidence store';
  if (SECRET_NAMES.has(upper)) return 'secret';
  if (SECRET_PREFIXES.some((p) => upper.startsWith(p))) return 'secret';
  if (SECRET_SHAPES.some((r) => r.test(upper))) return 'secret';
  return null;
}

/**
 * The environment for the gate commands: `env` without the dropped variables, plus FORCE_COLOR=0 (plain output for the
 * first error line). `dropped` lists the dropped NAMES only (never values), sorted.
 * @param {Record<string, string|undefined>} env
 * @param {{ storePaths?: string[], platform?: string }} [o]
 * @returns {{ env: Record<string, string>, dropped: string[] }}
 */
function gateEnv(env, { storePaths = [], platform = process.platform } = {}) {
  const windows = platform === 'win32';
  const out = {};
  const dropped = [];
  for (const [name, value] of Object.entries(env ?? {})) {
    if (value === undefined) continue;
    if (dropReason(name, value, { storePaths, windows })) dropped.push(name);
    else out[name] = value;
  }
  out.FORCE_COLOR = '0';
  return { env: out, dropped: dropped.sort() };
}

module.exports = { KEEP, SECRET_NAMES, SECRET_PREFIXES, dropReason, gateEnv };
