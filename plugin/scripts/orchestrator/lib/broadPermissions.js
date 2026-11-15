// =============================================================
// broadPermissions.js: rules in the tracked .claude/settings.json that give every session, on every clone, more than
// it needs.
//
// WHY: .claude/settings.json is shared. A rule in its permissions.allow applies to everyone who opens the repo, and to
// every agent the queue starts. Most rules are narrow (`Bash(npm test:*)`) and fine. A few open whole groups of risky
// actions without a question: any shell command, the network tools (a key can leave the machine in one curl), rm, git
// push, and fetching any web page. permissions.defaultMode can skip the questions altogether: bypassPermissions in a
// tracked file turns them off for everyone who clones the repo, which is the one important gap here. The list is short
// on purpose: a narrow rule (`Bash(curl -s http://localhost:3000/health)`, `Bash(rm -rf dist)`) is never named.
//
// `ravenseat doctor` (cli/doctorBaseline.mjs checkBroadPermissions, opt-in: permissionsCheck.enabled) shows the hits
// when the check is on: WARN for any shell command, bypassPermissions and acceptEdits, INFO for the rest. The Checks
// tab card (broad-permissions) is high only for bypassPermissions in the tracked file.
//
//   findBroad(text)   [{ at, rule, kind, level }] for one settings file's text (`at`: permissions.allow[3] or
//                     permissions.defaultMode; `rule`: the rule as written, safe to show since it matched a short
//                     known shape; `level`: 'warn' or 'info')
//   KINDS             what each kind means, in words
//
// Pure. Used by: cli/doctorBaseline.mjs, cli/checks.mjs. Tested in: lib/__tests__/broadPermissions.test.ts.
// =============================================================
'use strict';

/** The network tools: one allowed call can send a file or a key anywhere. */
const NET = ['curl', 'wget', 'nc', 'ncat', 'netcat', 'socat', 'telnet', 'ssh', 'scp', 'sftp', 'ftp', 'rsync', 'http', 'https', 'Invoke-WebRequest', 'Invoke-RestMethod', 'iwr', 'irm'];

/** A prefix rule: the program (and maybe some words) followed by a wildcard, e.g. `curl:*`, `curl *`, `git push:*`. */
const wildcardAfter = (inner, prefix) => {
  const esc = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');
  return new RegExp(`^${esc}(?:\\s+[^:*]*?)?(?::\\*|\\s\\*|\\*)$`, 'i').test(inner);
};

/** What a kind means, for the doctor line and the card. */
const KINDS = Object.freeze({
  'any-shell': 'any shell command without a question',
  network: 'a network tool with any arguments (a key or a file can leave the machine)',
  rm: 'rm with any arguments',
  'git-push': 'git push with any arguments (or all of git)',
  'web-fetch': 'fetching any web page (WebFetch without a domain)',
  bypass: 'permissions.defaultMode bypassPermissions: no questions at all, for everyone who clones the repo',
  'accept-edits': 'permissions.defaultMode acceptEdits: every file edit without a question, for everyone who clones the repo',
});

/** The kind of one allow rule, or null when it is narrow enough. */
function kindOf(rule) {
  const r = String(rule).trim();
  if (/^Bash(?:\(\s*(?:\*|:\*|\*:\*)?\s*\))?$/i.test(r)) return 'any-shell';
  if (/^WebFetch(?:\(\s*(?:\*|domain:\*?)?\s*\))?$/i.test(r)) return 'web-fetch';
  const m = /^Bash\((.*)\)$/is.exec(r);
  if (!m) return null;
  const inner = m[1].trim();
  if (NET.some((p) => wildcardAfter(inner, p))) return 'network';
  if (wildcardAfter(inner, 'rm')) return 'rm';
  if (wildcardAfter(inner, 'git push') || /^git(?::\*|\s\*|\*)$/i.test(inner)) return 'git-push';
  return null;
}

const LEVEL = { 'any-shell': 'warn', bypass: 'warn', 'accept-edits': 'warn' };

/**
 * The broad rules in one settings file's text. A file that is not JSON gives none (doctor's settings row names it).
 * @param {string} text
 * @returns {{ at: string, rule: string, kind: string, level: 'warn'|'info' }[]}
 */
function findBroad(text) {
  let json;
  try {
    json = JSON.parse(String(text ?? ''));
  } catch {
    return [];
  }
  const p = json && typeof json === 'object' ? json.permissions : null;
  if (!p || typeof p !== 'object') return [];
  const out = [];
  const mode = typeof p.defaultMode === 'string' ? p.defaultMode : '';
  if (mode === 'bypassPermissions') out.push({ at: 'permissions.defaultMode', rule: mode, kind: 'bypass', level: 'warn' });
  if (mode === 'acceptEdits') out.push({ at: 'permissions.defaultMode', rule: mode, kind: 'accept-edits', level: 'warn' });
  if (Array.isArray(p.allow))
    p.allow.forEach((rule, i) => {
      if (typeof rule !== 'string') return;
      const kind = kindOf(rule);
      // The rule matched one of the short shapes above, so it is shown as written (it holds no value of its own).
      if (kind) out.push({ at: `permissions.allow[${i}]`, rule: rule.trim(), kind, level: LEVEL[kind] ?? 'info' });
    });
  return out;
}

/** Is bypassPermissions among the hits (the one important gap)? */
const hasBypass = (hits) => (hits ?? []).some((h) => h.kind === 'bypass');

module.exports = { NET, KINDS, kindOf, findBroad, hasBypass };
