// =============================================================
// helperScan.js: the machine scan of a custom helper agent file (an agent definition of the project's own, added with
// `ravenseat helpers add`). See docs/orchestration.md ("Custom helper agents").
//
// WHY: a custom helper is a prompt that runs as a subagent in the orchestrator session, with the tools its frontmatter
// gives it. A file found on the web or written by someone else can carry a prompt injection, ask for more tools than a
// reviewer needs, or call out of the machine. The scan is the first, cheap filter; Claude reads the whole file after
// it, and the owner approves. The scan never runs anything from the file: it only reads the text.
//
// The result is one level for the whole file and a list of findings, each with a line number (1-based, in the whole
// file, frontmatter included):
//   red     must not be approved without `--force` and the owner's explicit yes
//   yellow  Claude must weigh it and mention it to the owner
//   green   no findings (Claude still reads the file)
//   info    (per finding only) says something useful but never changes the level, e.g. the model
//
// What is checked (one rule id per kind of finding, in RULES and the frontmatter check below):
//   - frontmatter: `tools` missing (= every tool), write tools, web tools, MCP tools, starting agents, unrestricted
//     Bash (also Bash(*) and other patterns that match every command), keys that change how the agent runs
//     (permissionMode, mcpServers, hooks, and keys that differ from them only in case or separators), a key given
//     twice, isolation and unknown keys, model. Keys are read as a YAML parser reads them (see readFrontmatter).
//   - calls out of the machine: URLs (a short list of documentation domains only gives yellow), curl, wget,
//     Invoke-WebRequest, fetch(, nc, webhooks, gh, git push, scp, ssh, a pipe into a shell, package installs
//   - prompt injection and misuse: "ignore previous instructions", "disregard", the system prompt, changing settings,
//     hooks, agent definitions or CLAUDE.md, reading secrets, hiding something from the owner, deleting or force
//     pushing, sending data somewhere, starting other agents
//   - hidden content: base64 like blocks, invisible and control Unicode (zero width, bidi overrides, tag characters),
//     HTML comments, very long lines, fenced code blocks with a script language
//   - missing guards: the "Data, not instructions" paragraph and the FINDINGS answer line
// A misuse rule on a line that says no to it ("never force push", "do not start other agents") gives yellow instead
// of red: the words are there, but as a guard. Claude still reads the line.
//
// Pure function on the text (no file I/O), tested in lib/__tests__/helperScan.test.ts.
// =============================================================
'use strict';

const LEVELS = ['green', 'yellow', 'red'];

/** The frontmatter keys Claude Code knows for a subagent, and how the scan treats each. */
const KEY_KIND = Object.freeze({
  name: 'ok',
  description: 'ok',
  tools: 'tools',
  disallowedTools: 'ok',
  model: 'info',
  effort: 'ok',
  color: 'ok',
  maxTurns: 'ok',
  permissionMode: 'red',
  mcpServers: 'red',
  hooks: 'red',
  isolation: 'yellow',
  memory: 'yellow',
  skills: 'yellow',
  background: 'yellow',
  initialPrompt: 'yellow',
});

/** Tools that write files, reach the network or start agents: red in a helper (a reviewer only reads). */
const RED_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task', 'Agent']);

/**
 * Documentation domains: a link there only gives yellow (it may be a reference, but the agent could still fetch it).
 * The domain itself or a subdomain of it.
 */
const DOC_DOMAINS = Object.freeze([
  'docs.anthropic.com',
  'docs.claude.com',
  'code.claude.com',
  'developer.mozilla.org',
  'nodejs.org',
  'typescriptlang.org',
  'docs.github.com',
  'git-scm.com',
  'owasp.org',
  'w3.org',
  'vitest.dev',
  'react.dev',
  'docs.python.org',
]);

/** A line longer than this is yellow (text can hide far to the right of a narrow view). */
const LONG_LINE = 400;

/**
 * Words that say no to what follows on the line ("never", "do not", "must not" ...). A misuse rule with one of these
 * before the hit is a guard, not an order: yellow instead of red.
 */
const NEGATION = /\b(?:never|not|don'?t|doesn'?t|mustn'?t|cannot|can'?t|no|without|avoid|refuse|forbidden)\b/i;

/**
 * The text rules, checked on every line. `negatable` = the "says no to it" rule above applies.
 * Each regex is used with .exec on one line (no g flag, so no lastIndex state between lines).
 */
const RULES = Object.freeze([
  // ---- Calls out of the machine ----
  { id: 'curl', level: 'red', group: 'outbound', re: /\bcurl\b/i, text: 'curl (a call out of the machine)' },
  { id: 'wget', level: 'red', group: 'outbound', re: /\bwget\b/i, text: 'wget (a call out of the machine)' },
  {
    id: 'invoke-webrequest',
    level: 'red',
    group: 'outbound',
    re: /\b(?:iwr|irm|Invoke-WebRequest|Invoke-RestMethod|Start-BitsTransfer)\b/i,
    text: 'Invoke-WebRequest / iwr (a call out of the machine)',
  },
  { id: 'fetch', level: 'red', group: 'outbound', re: /\bfetch\s*\(/i, text: 'fetch( (a network call in code)' },
  {
    id: 'netcat',
    level: 'red',
    group: 'outbound',
    re: /\b(?:nc|ncat|netcat)\s+(?:-\w|\S+\s+\d{2,5}\b)/i,
    text: 'nc / netcat (a raw network connection)',
  },
  { id: 'webhook', level: 'red', group: 'outbound', re: /\bweb-?hooks?\b/i, text: 'a webhook (sends data out)' },
  { id: 'gh', level: 'red', group: 'outbound', re: /(?:^|[\s`'"(])gh\s+[a-z]/i, text: 'gh (the GitHub CLI acts on the remote)' },
  { id: 'git-push', level: 'red', group: 'outbound', re: /\bgit\s+push\b/i, text: 'git push', negatable: true },
  { id: 'scp', level: 'red', group: 'outbound', re: /\bscp\s+\S/i, text: 'scp (copies files to another machine)' },
  { id: 'ssh', level: 'red', group: 'outbound', re: /\bssh\s+[-\w@]/i, text: 'ssh (a shell on another machine)' },
  {
    id: 'pipe-shell',
    level: 'red',
    group: 'outbound',
    re: /\|\s*(?:sudo\s+)?(?:sh|bash|zsh|dash|iex|Invoke-Expression|pwsh|powershell|cmd|python3?|node)\b/i,
    text: 'a pipe into a shell (runs what comes in)',
  },
  {
    id: 'package-install',
    level: 'red',
    group: 'outbound',
    re: /\b(?:npx\s+\S|npm\s+(?:i|install|add)\b|pnpm\s+(?:add|dlx|i|install)\b|yarn\s+(?:add|dlx)\b|pip3?\s+install\b|uvx\s+\S|bunx\s+\S)/i,
    text: 'a package install or npx (downloads and runs code)',
  },
  // ---- Prompt injection and misuse ----
  {
    id: 'ignore-instructions',
    level: 'red',
    group: 'injection',
    re: /\bignore\s+(?:(?:all|the|any|your|every|of|these|those)\s+)*(?:(?:previous|prior|above|earlier|preceding|other|system|original)\s+)?(?:instructions|rules|guidelines|prompts?|directions)\b/i,
    text: '"ignore ... instructions" (a classic prompt injection)',
    negatable: true,
  },
  { id: 'disregard', level: 'red', group: 'injection', re: /\bdisregard\b/i, text: '"disregard"', negatable: true },
  {
    id: 'system-prompt-leak',
    level: 'red',
    group: 'injection',
    re: /\b(?:reveal|print|show|repeat|output|leak|dump|copy|send)\b[^.\n]{0,40}\bsystem\s+prompt\b/i,
    text: 'asks for the system prompt',
    negatable: true,
  },
  { id: 'system-prompt', level: 'yellow', group: 'injection', re: /\bsystem\s+prompt\b/i, text: 'mentions the system prompt' },
  {
    id: 'change-config',
    level: 'red',
    group: 'injection',
    re: /\b(?:edit|change|modify|update|write|overwrite|append|add|create|delete|remove|disable|replace|patch)\b[^.\n]{0,60}(?:settings(?:\.local)?\.json|\.claude\/|\bhooks?\b|agent\s+(?:definitions?|files?)|CLAUDE(?:\.queue)?\.md|\.mcp\.json|queue\.config\.json|\.github\/workflows|permissions?)/i,
    text: 'asks to change settings, hooks, agent definitions or CLAUDE.md',
    negatable: true,
  },
  {
    id: 'read-secrets',
    level: 'red',
    group: 'injection',
    re: /\b(?:read|cat|type|print|open|dump|show|list|copy|collect|gather|grab|include|extract|look\s+(?:in|at))\b[^.\n]{0,60}(?:\.env\b|\bsecrets?\b|\btokens?\b|api[_ -]?keys?|\.ssh\b|id_rsa|id_ed25519|credentials?|\.npmrc|\.netrc|\bpasswords?\b|private\s+keys?)/i,
    text: 'asks to read secrets (.env, tokens, keys, ~/.ssh, credentials)',
    negatable: true,
  },
  {
    id: 'secret-path',
    level: 'yellow',
    group: 'injection',
    re: /(?:~\/\.ssh|\.ssh\/|id_rsa|id_ed25519|(?:^|[\s`'"/])\.env(?:\.\w+)?\b|\.npmrc|\.netrc|credentials\.json|\.aws\/)/i,
    text: 'mentions a secret file (.env, ~/.ssh, credentials)',
  },
  {
    id: 'hide',
    level: 'red',
    group: 'injection',
    re: /\b(?:secretly|covertly)\b|\b(?:hide|hiding|conceal|concealing|keep\s+(?:it|this|that)\s+secret)\b[^.\n]{0,40}\b(?:from|owner|user|human|orchestrator)\b|\b(?:don'?t|do\s+not|never|without)\s+(?:tell|telling|inform|informing|mention|mentioning|notify|notifying|show|showing|report|reporting|asking)\b[^.\n]{0,40}\b(?:owner|user|human|orchestrator|anyone|them)\b/i,
    text: 'hides something from the owner or the user',
  },
  {
    id: 'destructive',
    level: 'red',
    group: 'injection',
    re: /\brm\s+-[a-z]*[rf]|\bRemove-Item\b[^\n]*-Recurse|\bgit\s+push\b[^\n]*(?:--force|\s-f\b)|--force-with-lease|\bgit\s+reset\s+--hard|\bgit\s+clean\s+-[a-z]*f|\bdel\s+\/[sq]|\brmdir\s+\/s|\bforce[- ]push|\b(?:delete|erase|wipe|destroy)\b[^.\n]{0,40}\b(?:files?|branch(?:es)?|repo(?:sitory)?|folders?|director(?:y|ies)|history|database|tables?)\b/i,
    text: 'deletes or force pushes',
    negatable: true,
  },
  {
    id: 'send-data',
    level: 'red',
    group: 'injection',
    re: /\bexfiltrat\w*|\b(?:send|upload|transmit|forward|e-?mail|post|leak)\b[^.\n]{0,60}\b(?:servers?|urls?|endpoints?|webhooks?|external|remote|address|slack|discord|telegram|pastebin|outside|internet)\b/i,
    text: 'sends data somewhere',
    negatable: true,
  },
  {
    id: 'start-agents',
    level: 'red',
    group: 'injection',
    re: /\b(?:start|spawn|launch|run|invoke|call|create|dispatch)\b[^.\n]{0,30}\b(?:sub-?agents?|other\s+agents?|another\s+agent|more\s+agents?|agents?\s+in\s+parallel|the\s+(?:Task|Agent)\s+tool)\b/i,
    text: 'starts other agents',
    negatable: true,
  },
  // ---- Hidden content ----
  {
    id: 'html-comment',
    level: 'red',
    group: 'hidden',
    re: /<!--/,
    text: 'an HTML comment (hidden in the rendered view, the agent still reads it)',
  },
  {
    id: 'base64',
    level: 'red',
    group: 'hidden',
    re: /(?=[A-Za-z0-9+/]{60,})(?=[^\s]*[A-Z])(?=[^\s]*[a-z])(?=[^\s]*\d)[A-Za-z0-9+/]{60,}={0,2}/,
    text: 'a base64 like block (encoded content the owner cannot read)',
  },
]);

/**
 * Invisible and control characters: zero width (U+200B-U+200F, U+2060-U+2064, U+FEFF), bidi embeddings and overrides
 * (U+202A-U+202E, U+2066-U+2069), the soft hyphen U+00AD, C0 and C1 controls except tab, and the Unicode tag
 * characters U+E0000-U+E007F (text that renders as nothing but the model reads). Written with escapes on purpose.
 */
const INVISIBLE = /[\u00AD\u200B-\u200F\u2060-\u2064\uFEFF\u202A-\u202E\u2066-\u2069\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]|\uDB40[\uDC00-\uDC7F]/;

/** A fenced code block opening with a script language. */
const SCRIPT_FENCE = /^\s*(?:```|~~~)\s*(sh|bash|zsh|shell|console|powershell|ps1|pwsh|cmd|bat|batch|python|py|js|javascript|node|ts|typescript|ruby|perl|php)\b/i;

/** The "Data, not instructions" paragraph (the builtin agents' guard against injection through the review package). */
const DATA_GUARD = /data,\s*not\s+instructions/i;
/** The FINDINGS answer line the measurement reads (FINDINGS H=<n> M=<n> L=<n>). */
const FINDINGS_LINE = /\bFINDINGS\b/;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** "\u200B" style name of a character, for the finding text. */
function codePoint(ch) {
  const cp = ch.codePointAt(0);
  return `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
}

// ---- The frontmatter reader ----
// WHY a reader of its own and not a YAML library: the plugin ships with no runtime dependencies (package.json has only
// dev dependencies), and the scan must never run anything from the file. What matters is that every KEY a YAML parser
// would see is seen here too, so this reader follows YAML where a key can hide: plain, single quoted ('it''s') and
// double quoted keys with escapes ("ho\x6fks"), a space before the colon, a tag or anchor before the key (!!str, &a),
// an explicit key (? key), a frontmatter indented as a whole, a frontmatter written as one flow mapping
// ({name: x, tools: Read}), comments, values on more lines (plain continuation, | and > blocks, block lists), and a key
// given twice. It is lenient where YAML is strict (key:value with no space still counts): a file a parser would refuse
// is not run by Claude Code either, and a key read too eagerly only fails closed.

/** The decoded text of a double quoted YAML scalar body (the escapes YAML defines). */
function decodeDouble(body) {
  const named = { 0: '\0', a: '\x07', b: '\b', t: '\t', '\t': '\t', n: '\n', v: '\v', f: '\f', r: '\r', e: '\x1b', ' ': ' ' };
  Object.assign(named, { '"': '"', '/': '/', '\\': '\\', N: '\x85', _: '\xa0', L: '\u2028', P: '\u2029' });
  return body.replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|[\s\S])/g, (all, e) => {
    if (e.length > 1) {
      const cp = parseInt(e.slice(1), 16);
      return cp <= 0x10ffff ? String.fromCodePoint(cp) : all;
    }
    return Object.hasOwn(named, e) ? named[e] : all;
  });
}

/** A scalar as YAML reads it: quotes removed and escapes decoded, a trailing comment off a plain one. */
function scalar(raw) {
  const s = String(raw ?? '').trim();
  let m = /^"((?:[^"\\]|\\[\s\S])*)"/.exec(s);
  if (m) return decodeDouble(m[1]);
  m = /^'((?:[^']|'')*)'/.exec(s);
  if (m) return m[1].replace(/''/g, "'");
  return s.replace(/(?:^|\s+)#.*$/, '').trim();
}

/** Split a flow collection body ("a, 'b, c', [d, e]") on its top-level commas, outside quotes and brackets. */
function splitFlow(body) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let cur = '';
  for (let j = 0; j < body.length; j++) {
    const c = body[j];
    if (quote) {
      cur += c;
      if (quote === '"' && c === '\\') cur += body[++j] ?? '';
      else if (c === quote) {
        if (quote === "'" && body[j + 1] === "'") cur += body[++j];
        else quote = null;
      }
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** The items of a flow sequence value ("[Read, 'Grep']"), or null when the value is not one. */
function flowList(value) {
  const m = /^\[([\s\S]*)\]$/.exec(String(value).trim());
  return m ? splitFlow(m[1]).map(scalar).filter(Boolean) : null;
}

/**
 * The key at the start of `s` (the line with its indentation removed), as YAML reads it.
 * @returns {{ key: string, raw: string, rest: string }|null} rest = the text after the colon
 */
function splitKey(s) {
  let t = s;
  // A tag (!x, !!str, !<...>) or an anchor (&a) in front of the key does not change the key.
  for (let p = /^(?:![^\s]*|&[^\s]+)\s+/.exec(t); p; p = /^(?:![^\s]*|&[^\s]+)\s+/.exec(t)) t = t.slice(p[0].length);
  let m = /^("(?:[^"\\]|\\.)*")\s*:(.*)$/.exec(t);
  if (m) return { key: decodeDouble(m[1].slice(1, -1)), raw: m[1], rest: m[2] };
  m = /^('(?:[^']|'')*')\s*:(.*)$/.exec(t);
  if (m) return { key: m[1].slice(1, -1).replace(/''/g, "'"), raw: m[1], rest: m[2] };
  // A plain key: up to the first colon followed by a space or the end of the line, never a comment.
  m = /^((?:[^\s#'"{}[\],&*!|>%@`?:-]|[?:-](?=\S))(?:[^:#]|:(?=\S)|(?<=\S)#)*?)\s*:(?:\s+(.*)|$)/.exec(t);
  if (m) return { key: m[1].trim(), raw: m[1].trim(), rest: m[2] ?? '' };
  // Lenient: key:value with no space (YAML reads it as one scalar, a reader may not). Fails closed.
  m = /^([A-Za-z_][\w-]*)\s*:(.*)$/.exec(t);
  if (m) return { key: m[1], raw: m[1], rest: m[2] };
  return null;
}

/**
 * Read a frontmatter written as one flow mapping ({a: 1, "b": [x, y]}), from line `start` to `end` (exclusive).
 * Each entry gets its place as [line, column] (0-based, in `lines`): `start` and `end` of its text (end exclusive),
 * `sep` the "," or "}" after it (null when the mapping is not closed) and `prev` the "{" or "," before it, so a caller
 * can replace or cut one entry (queueHelpers.withAgentName).
 */
function readFlowMap(lines, start, end, push) {
  let depth = 0;
  let quote = null;
  let cur = '';
  let curStart = null;
  let curEnd = null;
  let prev = null;
  const take = (text, i, j0, j1) => {
    if (!cur.trim() && text.trim()) curStart = [i, j0];
    cur += text;
    if (text.trim()) curEnd = [i, j1];
  };
  const flush = (sep) => {
    const text = cur.replace(/\s*\n\s*/g, ' ').trim();
    if (text) {
      const pos = { start: curStart, end: curEnd, sep, prev };
      const k = splitKey(text);
      if (k) push(k.key, k.raw, curStart[0], k.rest.trim(), pos);
      else push(scalar(text), text, curStart[0], '', pos);
    }
    cur = '';
    curStart = null;
    curEnd = null;
    prev = sep;
  };
  for (let i = start; i < end; i++) {
    const l = lines[i];
    for (let j = 0; j < l.length; j++) {
      const c = l[j];
      if (!quote && c === '#' && (j === 0 || /\s/.test(l[j - 1]))) break;
      if (quote) {
        const j0 = j;
        let t = c;
        if (quote === '"' && c === '\\') t += l[++j] ?? '';
        else if (c === quote) {
          if (quote === "'" && l[j + 1] === "'") t += l[++j];
          else quote = null;
        }
        take(t, i, j0, j + 1);
        continue;
      }
      if (depth === 0) {
        if (c === '{') {
          depth = 1;
          prev = [i, j];
        }
        continue;
      }
      if (c === '"' || c === "'") quote = c;
      else if (c === '[' || c === '{') depth++;
      else if (c === ']' || c === '}') {
        depth--;
        if (depth === 0) {
          flush([i, j]);
          return;
        }
      } else if (c === ',' && depth === 1) {
        flush([i, j]);
        continue;
      }
      take(c, i, j, j + 1);
    }
    cur += '\n';
  }
  flush(null);
}

/**
 * The frontmatter between the first two "---" lines: the top-level keys with their values and line numbers, read as
 * a YAML parser reads keys (see above). Nested maps (hooks, mcpServers) are only recorded as present.
 * @returns {{ found: boolean, end: number, indent: number, flow: [number, number]|null,
 *   keys: Record<string, { line: number, value: string, list: string[]|null, raw: string }>,
 *   entries: { key: string, raw: string, line: number, value: string, list: string[]|null, col: number, last: number,
 *     pos?: object }[] }}
 *   end = the line index (0-based) of the closing "---", or -1; keys holds the last of a key given twice, entries every
 *   key in file order (also the ones given twice). Where each key is, so a caller can replace one: indent = the
 *   column of the top-level keys; per entry col = its column and last = the 0-based index of its last line (its value
 *   on more lines included). For a flow mapping, flow = [line, column] of its "{" and each entry has pos (readFlowMap).
 */
function readFrontmatter(lines) {
  const out = { found: false, end: -1, indent: 0, flow: null, keys: Object.create(null), entries: [] };
  if (!lines.length || lines[0].replace(/^\uFEFF/, '').trim() !== '---') return out;
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end < 0) return out;
  out.found = true;
  out.end = end;

  let current = null;
  const push = (key, raw, i, rest, pos = null, col = 0) => {
    const value = rest.trim();
    current = { key, raw, line: i + 1, value: scalar(value), list: flowList(value), col, last: i, mode: null };
    if (pos) current.pos = pos;
    if (/^[|>][-+0-9]*\s*(?:#.*)?$/.test(value)) {
      current.mode = 'block';
      current.value = '';
    } else if (!value || value.startsWith('#')) {
      current.mode = 'empty';
      current.value = '';
    } else if (/^["'[{]/.test(value)) current.mode = 'done';
    else current.mode = 'plain';
    out.entries.push(current);
    out.keys[key] = current;
  };

  let topIndent = null;
  let explicit = null; // a "? key" waiting for its ": value" line
  for (let i = 1; i < end; i++) {
    const l = lines[i];
    const body = l.trimStart();
    const indent = l.length - body.length;
    if (!body) {
      if (current?.mode === 'block' && current.value) current.value += '\n';
      continue;
    }
    // A frontmatter written as one flow mapping.
    if (topIndent === null && body.startsWith('{')) {
      out.flow = [i, indent];
      readFlowMap(lines, i, end, (key, raw, li, rest, pos) => push(key, raw, li, rest, pos, pos.start[1]));
      break;
    }
    const nested = topIndent !== null && indent > topIndent;
    if (nested && current) {
      // A line under the current key: a block list item, a block scalar line, a plain continuation, or a nested map.
      current.last = i;
      const item = /^-(?:\s+(.*)|$)/.exec(body);
      if (current.mode === 'block') current.value += (current.value && !current.value.endsWith('\n') ? '\n' : '') + body;
      else if (item && current.mode === 'empty') current.list = [...(current.list ?? []), scalar(item[1] ?? '')];
      else if (current.mode === 'plain' && !body.startsWith('#')) current.value = `${current.value} ${scalar(body)}`.trim();
      continue;
    }
    if (body.startsWith('#')) continue;
    // A block list item at the key's own indentation (YAML allows "tools:" then "- Read" on the same column).
    const item = /^-(?:\s+(.*)|$)/.exec(body);
    if (item && current && current.mode === 'empty' && indent === topIndent) {
      current.last = i;
      current.list = [...(current.list ?? []), scalar(item[1] ?? '')];
      continue;
    }
    // An explicit key: "? key" with the value on the next ": value" line.
    const q = /^\?(?:\s+(.*)|$)/.exec(body);
    if (q) {
      topIndent ??= indent;
      explicit = { key: scalar(q[1] ?? ''), raw: (q[1] ?? '').trim(), i };
      push(explicit.key, explicit.raw, i, '', null, indent);
      continue;
    }
    const v = /^:(?:\s+(.*)|$)/.exec(body);
    if (v && explicit && current) {
      const { key, raw, i: at } = explicit;
      const col = current.col;
      out.entries.pop();
      push(key, raw, at, v[1] ?? '', null, col);
      current.last = i;
      explicit = null;
      continue;
    }
    const k = splitKey(body);
    if (k) {
      topIndent ??= indent;
      explicit = null;
      push(k.key, k.raw, i, k.rest, null, indent);
    }
  }
  out.indent = topIndent ?? 0;
  for (const e of out.entries) delete e.mode;
  return out;
}

/** The tools in the frontmatter value: a comma list ("Read, Grep, Bash"), a YAML list, or a block on more lines. */
function toolList(entry) {
  if (!entry) return null;
  if (entry.list) return entry.list;
  return entry.value
    .split(/[,\n]/)
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

/** Keys folded for the look alike check: case and separators do not count ("Permission_Mode" = "permissionMode"). */
const foldKey = (k) => String(k).toLowerCase().replace(/[\s_-]+/g, '');
const RED_KEY_BY_FOLD = new Map(
  Object.entries(KEY_KIND)
    .filter(([, kind]) => kind === 'red')
    .map(([k]) => [foldKey(k), k]),
);

/**
 * Bash or PowerShell with no pattern, or with a pattern that matches every command. Claude Code's permission docs
 * (code.claude.com/docs/en/permissions): "`Bash(*)` is equivalent to `Bash`", a `*` matches any text including
 * spaces, and `:*` at the end is a trailing wildcard. So `*`, `**`, `:*` and `*:*` match everything. A space inside
 * the pattern is literal (`* *` needs a space in the command), so only spaces at the ends are trimmed (the docs do
 * not say; trimming fails closed).
 */
function unrestrictedShell(t, bare) {
  if (bare !== 'Bash' && bare !== 'PowerShell') return false;
  if (t === bare) return true;
  const m = /^[A-Za-z]+\s*\(([\s\S]*)\)$/.exec(t);
  return !!m && /^(?:\*+|\**:\*)$/.test(m[1].trim());
}

/** Is the host one of the documentation domains (or a subdomain)? */
function docDomain(host) {
  const h = String(host).toLowerCase().replace(/^www\./, '');
  return DOC_DOMAINS.some((d) => h === d || h.endsWith(`.${d}`));
}

/**
 * Scan one agent file.
 * @param {string} text the whole file
 * @returns {{ level: 'green'|'yellow'|'red', findings: { level: string, line: number, rule: string, group: string,
 *   text: string, excerpt: string }[], counts: { red: number, yellow: number, info: number },
 *   frontmatter: Record<string, string> }}
 */
function scanHelper(text) {
  const src = String(text ?? '');
  const lines = src.split(/\r?\n/);
  const findings = [];
  const add = (level, line, rule, group, what, excerpt = '') =>
    findings.push({ level, line, rule, group, text: what, excerpt: String(excerpt).trim().slice(0, 80) });

  // ---- The frontmatter ----
  const fm = readFrontmatter(lines);
  const frontmatter = Object.create(null);
  if (!fm.found) {
    add('red', 1, 'no-frontmatter', 'frontmatter', 'no frontmatter (--- name, description, tools ---): not a valid agent file');
  } else {
    const firstLine = Object.create(null);
    for (const entry of fm.entries) {
      const key = entry.key;
      frontmatter[key] = entry.value;
      // How the key is written, when that is not the key itself ("permissionMode" in quotes, an escape, a tag).
      const written = entry.raw && entry.raw !== key ? ` (written ${entry.raw})` : '';
      if (firstLine[key] !== undefined)
        add(
          'red',
          entry.line,
          'duplicate-key',
          'frontmatter',
          `"${key}" is given twice (lines ${firstLine[key]} and ${entry.line}): a YAML reader takes one of them, maybe not the one you read`,
          key,
        );
      else firstLine[key] = entry.line;
      const kind = Object.hasOwn(KEY_KIND, key) ? KEY_KIND[key] : null;
      const lookalike = kind ? null : RED_KEY_BY_FOLD.get(foldKey(key));
      if (lookalike)
        add(
          'red',
          entry.line,
          `key-${lookalike}`,
          'frontmatter',
          `"${key}" looks like ${lookalike} (red in case a reader takes it as that key: it changes how the agent runs or what it can reach)`,
          key,
        );
      else if (!kind) add('yellow', entry.line, 'unknown-key', 'frontmatter', `unknown frontmatter key "${key}"${written}`, key);
      else if (kind === 'red')
        add('red', entry.line, `key-${key}`, 'frontmatter', `${key} in the frontmatter${written} (changes how the agent runs or what it can reach)`, key);
      else if (kind === 'yellow')
        add('yellow', entry.line, `key-${key}`, 'frontmatter', `${key} in the frontmatter${written}`, `${key}: ${entry.value}`);
      else if (kind === 'info' && key === 'model')
        add('info', entry.line, 'model', 'frontmatter', `model: ${entry.value || '(empty)'}`, entry.value);
    }
    if (!fm.keys.description)
      add('yellow', 1, 'no-description', 'frontmatter', 'no description (Claude Code needs it to know what the agent is for)');
    // Every tools entry is checked (a key given twice is also red above): the reader may take either one.
    const toolEntries = fm.entries.filter((e) => e.key === 'tools');
    if (!toolEntries.some((e) => toolList(e).length)) {
      add('red', fm.keys.tools?.line ?? 1, 'tools-missing', 'frontmatter', 'tools is missing: the agent gets EVERY tool (write, web, MCP, agents)');
    }
    for (const entry of toolEntries) {
      const line = entry.line;
      for (const t of toolList(entry)) {
        const bare = t.replace(/\(.*$/, '').trim();
        if (t === '*' || bare === '*') add('red', line, 'tool-all', 'frontmatter', 'tools: * (every tool)', t);
        else if (RED_TOOLS.has(bare)) add('red', line, `tool-${bare}`, 'frontmatter', `tool ${bare} (writes files, reaches the network or starts agents)`, t);
        else if (/^mcp__/i.test(bare)) add('red', line, 'tool-mcp', 'frontmatter', `MCP tool ${bare} (reaches outside the repo)`, t);
        else if (unrestrictedShell(t, bare))
          add(
            'yellow',
            line,
            'tool-bash',
            'frontmatter',
            `unrestricted ${bare} (${t === bare ? '' : `${t} matches every command; `}it can run any command; the push guard and the read guard apply)`,
            t,
          );
      }
    }
  }

  // ---- Every line: calls out, injection and misuse, hidden content ----
  let fenceOpen = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const n = i + 1;
    // Invisible characters first (one finding per line, naming the first one). A BOM at the very start is harmless.
    const scanLine = i === 0 ? l.replace(/^\uFEFF/, '') : l;
    const inv = INVISIBLE.exec(scanLine);
    if (inv) add('red', n, 'invisible-unicode', 'hidden', `an invisible or control character (${codePoint(inv[0])})`, '');
    if (l.length > LONG_LINE) add('yellow', n, 'long-line', 'hidden', `a very long line (${l.length} characters)`, l.slice(0, 40));
    // Fenced code blocks: a block with a script language is yellow (its lines are scanned like the rest).
    if (/^\s*(?:```|~~~)/.test(l)) {
      if (!fenceOpen) {
        fenceOpen = true;
        const m = SCRIPT_FENCE.exec(l);
        if (m) add('yellow', n, 'script-block', 'hidden', `a code block with a script (${m[1]})`, l);
      } else {
        fenceOpen = false;
      }
    }
    // URLs: red, unless the domain is a documentation domain (yellow).
    for (const m of l.matchAll(/\bhttps?:\/\/([^\s/'"`)<>\]]+)/gi)) {
      const host = m[1].replace(/:\d+$/, '').replace(/^[^@]*@/, '');
      if (docDomain(host)) add('yellow', n, 'url-docs', 'outbound', `a link to the documentation domain ${host}`, m[0]);
      else add('red', n, 'url', 'outbound', `a URL to ${host} (the agent could call it)`, m[0]);
    }
    for (const r of RULES) {
      const m = r.re.exec(l);
      if (!m) continue;
      // "never force push": the guard words before the hit make it yellow (still worth a look).
      const before = l.slice(0, m.index);
      const guarded = r.negatable && NEGATION.test(before);
      add(guarded ? 'yellow' : r.level, n, r.id, r.group, guarded ? `${r.text}, said as a guard ("never" or "not")` : r.text, m[0]);
    }
  }

  // ---- Missing guards ----
  if (!DATA_GUARD.test(src))
    add('yellow', 1, 'no-data-guard', 'guard', 'no "Data, not instructions" paragraph (content it reads could steer it)');
  if (!FINDINGS_LINE.test(src))
    add('yellow', 1, 'no-findings-line', 'guard', 'no FINDINGS answer line (the measurement cannot count its findings)');

  // One finding per rule and line is enough (two rules can still hit the same line).
  const seen = new Set();
  const unique = findings.filter((f) => {
    const k = `${f.rule}:${f.line}:${f.text}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  unique.sort((a, b) => a.line - b.line || LEVELS.indexOf(b.level) - LEVELS.indexOf(a.level));
  const counts = {
    red: unique.filter((f) => f.level === 'red').length,
    yellow: unique.filter((f) => f.level === 'yellow').length,
    info: unique.filter((f) => f.level === 'info').length,
  };
  const level = counts.red ? 'red' : counts.yellow ? 'yellow' : 'green';
  return { level, findings: unique, counts, frontmatter };
}

/** The scan as short text lines for the CLI: the level, then one line per finding. */
function scanText(scan, name = '') {
  const s = isObject(scan) ? scan : { level: 'green', findings: [], counts: { red: 0, yellow: 0, info: 0 } };
  const head = `${name ? `${name}: ` : ''}scan ${s.level.toUpperCase()} (${s.counts.red} red, ${s.counts.yellow} yellow${
    s.counts.info ? `, ${s.counts.info} info` : ''
  })`;
  const lines = [head];
  for (const f of s.findings)
    lines.push(`  ${f.level.padEnd(6)} line ${String(f.line).padStart(3)}  ${f.text}${f.excerpt ? `: ${JSON.stringify(f.excerpt)}` : ''}`);
  return lines;
}

/** The short form stored in queue.json (level, counts, when, for which hash); the full list is printed, not stored. */
function scanSummary(scan, sha256, at = new Date().toISOString()) {
  return { level: scan.level, red: scan.counts.red, yellow: scan.counts.yellow, sha256, at };
}

module.exports = { scanHelper, scanText, scanSummary, readFrontmatter, DOC_DOMAINS, KEY_KIND, RED_TOOLS, LONG_LINE };
