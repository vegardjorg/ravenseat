// =============================================================
// commandSecrets.js: the password-flag rule for one command line, shared by the silent snapshot's redaction and the
// doctor row for approved commands (roadmap 1c SEC-T, item 2).
//
// WHY: the secret scan's generic rule (lib/secretScan.js GENERIC) needs 16+ characters after = or :, which is right for
// code (shorter values there are mostly test data and names). A command line is different: `--password hunter2`,
// `sshpass -p secret` and `PGPASSWORD=short psql` hold a real password of any length, and "Yes, and don't ask again"
// stores the whole line in .claude/settings.local.json. This file is the one place that reads a command line argument
// by argument and says which values are secrets:
//   - a flag named like a password, token, key or secret, with its value (`--password x`, `--token=x`);
//   - an environment assignment with such a name (`PGPASSWORD=x`, `export API_TOKEN=x`, PowerShell `$env:X="x"`);
//   - a quoted header with such a name (`-H "X-Api-Key: x"`);
//   - the short password flags of the tools that take one: `sshpass -p x`, `mysql -px`, `redis-cli -a x`.
// Any length counts. Not a secret: a placeholder or reference ($X, ${X}, %X%, <password>, ***, xxx, a Claude Code
// wildcard `*`, true/false), a path or a URL (a key FILE is not the key), and names that only carry a secret word in
// passing (--password-file, --key-id, --auth-type, --author, SSH_AUTH_SOCK).
//
// Used by: lib/silentSnapshot.js redactCommand (it replaces these values, on top of its own wider rules) and
// lib/allowlistSecrets.js (matchCommand, only for approved commands: on code it would give false hits). Callers get
// the rule id and the token's index, NEVER the value. Pure, no I/O. Tested in lib/__tests__/commandSecrets.test.ts.
// =============================================================
'use strict';

/** A name that marks its value as secret (a flag, an env name, a header). Also used by redactCommand's wider rules. */
const SECRET_NAME = /(pass(word|wd)?|pwd|secret|token|api[-_]?key|apikey|access[-_]?key|private[-_]?key|key|auth|credential|cookie|session|signature|bearer)/i;

/**
 * Names that hold a secret word but no secret value: a file, a path, an id, a type ... (`--password-file`, `--key-id`,
 * `--auth-type`), and `author` (git's --author, GIT_AUTHOR_NAME). Only for the detection here: redactCommand still
 * drops their values (when unsure, it drops).
 */
const NOT_SECRET_NAME = /author(?!i[sz]ation)|(?:file|files|path|dir|type|id|ids|name|format|length|size|env|var|ring|store|prompt|count|mode|helper|command|cmd|url|uri|host|port|user|stdin|timeout|ttl|scope|alg|algorithm|limit|policy|server|sock|socket|agent)$/i;

/** The tools whose short flag takes a password, and how: `next` (the next argument) or `attached` (-pVALUE). */
const SHORT_FLAGS = Object.freeze([
  { programs: ['sshpass'], flag: '-p', form: 'next' },
  { programs: ['redis-cli'], flag: '-a', form: 'next' },
  { programs: ['mysql', 'mysqldump', 'mysqladmin', 'mariadb', 'mariadb-dump'], flag: '-p', form: 'attached' },
]);

/** The tokens of a command line: words, with quoted parts kept whole (the same split as redactCommand always used). */
const tokenize = (cmd) => String(cmd ?? '').match(/(?:[^\s"']+|"[^"]*"?|'[^']*'?)+/g) ?? [];
const unquote = (s) => String(s ?? '').replace(/^(["'])(.*)\1$/s, '$2');

/** A reference or a placeholder, not a secret: $X, ${X}, $(...), %X%, <x>, {{x}}, ***, xxx, a wildcard, true/false. */
function isPlaceholder(v) {
  const s = unquote(v).trim().replace(/[;,)]+$/, '');
  if (!s) return true;
  if (/^[$%]/.test(s) || /\$\{|\$\(/.test(s)) return true;
  if (/^<[^>]*>$/.test(s) || /^\{\{.*\}\}$/.test(s)) return true;
  if (/^[*xX.]+$/.test(s) || s.includes('*')) return true;
  if (/^(true|false|yes|no|on|off|null|none|0|1)$/i.test(s)) return true;
  return /process\.env|os\.environ|getenv|example|changeme|your[_-]|placeholder|redacted/i.test(s);
}

/** A path or a URL: a key file or an endpoint, not the secret itself. */
function isPathOrUrl(v) {
  const s = unquote(v).trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return true;
  if (/^(?:[.~/\\]|[A-Za-z]:[\\/])/.test(s)) return true;
  return /\.(pem|key|crt|cer|p12|pfx|json|txt|env|ya?ml|toml|ini)$/i.test(s);
}

/** Does the value look like a real secret (not a placeholder, a path or a URL)? */
const real = (v) => !isPlaceholder(v) && !isPathOrUrl(v);

/** Is this a name whose value is a secret (a secret word, and not one of NOT_SECRET_NAME)? */
function secretName(name) {
  const n = String(name ?? '').replace(/^-+/, '');
  return SECRET_NAME.test(n) && !NOT_SECRET_NAME.test(n);
}

/** The program name of a token: no path, no .exe, lower case. */
const programOf = (t) => unquote(t).split(/[\\/]/).pop().replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();

/**
 * The secret values in a command line's tokens: [{ index, rule, keep }]. `index` is the token that holds the value,
 * `keep` what of that token stays readable before the value ('--token=', 'PGPASSWORD=', '-p' or ''), `rule` one of
 * password-flag, secret-env, secret-header. Never the value.
 * @param {string[]} tokens  tokenize(command)
 */
function secretValuesOf(tokens) {
  const out = [];
  const programs = tokens.map(programOf);
  const before = (names, i) => programs.slice(0, i).some((p) => names.includes(p));
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    // PowerShell: $env:NAME="value" in one token, or $env:NAME = "value" in three.
    const ps = /^\$env:([A-Za-z_][A-Za-z0-9_]*)(?:=(.*))?$/is.exec(t);
    if (ps) {
      if (ps[2] !== undefined) {
        if (secretName(ps[1]) && real(ps[2])) out.push({ index: i, rule: 'secret-env', keep: `$env:${ps[1]}=` });
      } else if (tokens[i + 1] === '=' && i + 2 < tokens.length && secretName(ps[1]) && real(tokens[i + 2])) {
        out.push({ index: i + 2, rule: 'secret-env', keep: '' });
        i += 2;
      }
      continue;
    }
    // --name=value
    const fv = /^(-{1,2}[A-Za-z0-9][\w.-]*)=(.*)$/s.exec(t);
    if (fv) {
      if (secretName(fv[1]) && real(fv[2])) out.push({ index: i, rule: 'password-flag', keep: `${fv[1]}=` });
      continue;
    }
    // The short password flags of the tools that take one.
    const short = SHORT_FLAGS.find((s) => before(s.programs, i) && (s.form === 'next' ? t === s.flag : t.startsWith(s.flag) && t.length > s.flag.length));
    if (short) {
      if (short.form === 'attached') {
        if (real(t.slice(short.flag.length))) out.push({ index: i, rule: 'password-flag', keep: short.flag });
      } else if (i + 1 < tokens.length && real(tokens[i + 1])) {
        out.push({ index: i + 1, rule: 'password-flag', keep: '' });
        i++;
      }
      continue;
    }
    // --name value
    if (/^-{1,2}[A-Za-z]/.test(t)) {
      const next = tokens[i + 1];
      if (secretName(t) && next !== undefined && !next.startsWith('-') && real(next)) {
        out.push({ index: i + 1, rule: 'password-flag', keep: '' });
        i++;
      }
      continue;
    }
    // NAME=value
    const env = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(t);
    if (env) {
      if (secretName(env[1]) && real(env[2])) out.push({ index: i, rule: 'secret-env', keep: `${env[1]}=` });
      continue;
    }
    // A quoted "Name: value" header with a secret name; the value's last word is what is judged ("Bearer x" -> x).
    const header = /^["']\s*([A-Za-z][\w-]*)\s*:\s*(.+?)["']?$/s.exec(t);
    if (header && secretName(header[1])) {
      const last = header[2].trim().split(/\s+/).pop();
      if (real(last)) out.push({ index: i, rule: 'secret-header', keep: '' });
    }
  }
  return out;
}

/** The secret values in a command line (secretValuesOf on its tokens). */
const secretValues = (cmd) => secretValuesOf(tokenize(cmd));

/**
 * The rule id of the first secret value in a command line, or null. Never the value. For approved commands only
 * (lib/allowlistSecrets.js); code goes through secretScan.matchLine, where any length would give false hits.
 * @param {string} cmd
 * @returns {string|null}
 */
function matchCommand(cmd) {
  return secretValues(cmd)[0]?.rule ?? null;
}

module.exports = { SECRET_NAME, NOT_SECRET_NAME, SHORT_FLAGS, tokenize, isPlaceholder, isPathOrUrl, secretName, secretValuesOf, secretValues, matchCommand };
