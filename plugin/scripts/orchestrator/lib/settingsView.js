// =============================================================
// settingsView.js: what the surfaces read from the settings registry (lib/settingsRegistry.js).
//
// The design is plans/innstillinger-vurdering-2026-11-12.md, steps 4 to 6b:
//   settingsView  every row with its value now, its default for the mode, where it is stored and whether it weakens a
//                 guard, grouped in the eleven categories (basic rows first, advanced after). In lite, a full-only row
//                 is marked `hidden` (one count line per category shows it is there); a category with nothing for lite
//                 is `fullOnlyCategory` (one closed line). The board's /api/settings and `ravenseat settings` both use it.
//   cliLines      `ravenseat settings` as text (--advanced, --all, --changed, a category).
//   parseValue    a value typed in the CLI or chosen on the board, checked against the row (on/off, a choice, a number).
//   needsConfirm  the rule for the owner's confirmation: the new value weakens the guard (against the default) and is
//                 weaker than the value now. Going back to a stronger value never needs it.
//   warningLines  the CLI's warning, built from the row's protects, whyNot and changes.
//   setJsonText   the shared writer for queue.config.json: changes one key and keeps the rest of the file as written
//                 (order, indentation, one-line lists and `_comment` keys). It generalises liteMode.setModeText.
//   pathOf        the segments of a registry key ("features.plans.legal" is the key "plans.legal" under features).
//
// Pure functions (no files). Used by: cli/settings.mjs, lib/queueBoard.js, queue-board.mjs.
// Tested in: lib/__tests__/settingsView.test.ts and __tests__/settingsCli.test.ts.
// =============================================================
'use strict';

const R = require('./settingsRegistry.js');
const KK = require('./queueConfig.js');
const L = require('./queueLogic.js');
const GU = require('./guidance.js');
const PR = require('./queueProposals.js');

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The words for where a row is stored (on the board, in the dialog and in the CLI warning). */
const STORE_TEXT = Object.freeze({
  config: 'Saved for the project (queue.config.json, remember to commit)',
  queue: 'Saved only for you (queue.json)',
});

/**
 * The segments of a key: walked through STANDARD, so a key under features keeps its dot ("features.plans.legal" gives
 * ["features", "plans.legal"]). A key STANDARD does not have (guidance, checksPanel.mode) is split on its dots.
 */
function pathOf(key, standard = KK.STANDARD) {
  const out = [];
  let o = standard;
  let rest = String(key);
  while (rest) {
    if (isObject(o) && Object.hasOwn(o, rest)) {
      out.push(rest);
      return out;
    }
    const parts = rest.split('.');
    let found = false;
    for (let i = 1; i < parts.length && isObject(o); i++) {
      const head = parts.slice(0, i).join('.');
      if (Object.hasOwn(o, head)) {
        out.push(head);
        o = o[head];
        rest = parts.slice(i).join('.');
        found = true;
        break;
      }
    }
    if (!found) return [...out, ...rest.split('.')];
  }
  return out;
}

/** The value at a list of segments, or undefined. */
function getPath(o, segs) {
  let x = o;
  for (const s of segs) {
    if (!isObject(x) || !Object.hasOwn(x, s)) return undefined;
    x = x[s];
  }
  return x;
}

/** A deep copy with the value set at the segments (missing objects are made; the key order of the rest is kept). */
function setPath(o, segs, value) {
  const copy = isObject(o) ? { ...o } : {};
  if (segs.length === 1) {
    copy[segs[0]] = value;
    return copy;
  }
  copy[segs[0]] = setPath(copy[segs[0]], segs.slice(1), value);
  return copy;
}

// ---- Values: now, default, as text ---------------------------------------------------------------

/** The limit's default (the registry's `limits.<name>`): DEFAULT_LIMITS, the project's load limit, or the built-in one. */
function limitStandard(name, config) {
  if (Object.hasOwn(L.DEFAULT_LIMITS, name)) return L.DEFAULT_LIMITS[name];
  if (name === 'minFreeMemoryPct') return config?.loadGuard?.minFreeMemoryPct ?? null;
  if (name === 'parallelThreshold') return require('./queueDiagnose.js').DEFAULT_THRESHOLD;
  if (name === 'silentMin') return L.SILENT_DEFAULT_MIN;
  return undefined;
}

/** The default of a row for the mode (defaultByMode first, then STANDARD or the queue.json default). */
function standardOf(row, { config, mode = 'full' } = {}) {
  if (row.defaultByMode && Object.hasOwn(row.defaultByMode, mode)) return row.defaultByMode[mode];
  if (row.key.startsWith('limits.')) return limitStandard(row.key.slice('limits.'.length), config);
  if (row.key === 'guidance') return 'guided';
  if (row.key === 'checksPanel.mode') return true;
  return getPath(KK.STANDARD, pathOf(row.key));
}

/** The value in force now, read from the store the row names (and for the queue.json switches, as the queue reads it). */
function valueOf(row, { config, queue }) {
  const q = queue ?? {};
  if (row.key.startsWith('limits.')) {
    const name = row.key.slice('limits.'.length);
    const own = isObject(q.limits) && Object.hasOwn(q.limits, name) ? q.limits[name] : undefined;
    return own === undefined ? limitStandard(name, config) : own;
  }
  if (row.key === 'guidance') return GU.modeOf(q);
  if (row.key === 'checksPanel.mode') return GU.checksPanelOn(q);
  if (row.key.startsWith('board.') && Object.hasOwn(KK.BOARD_SWITCHES, row.key.slice('board.'.length)))
    return KK.boardSwitches(config, q)[row.key.slice('board.'.length)];
  if (row.key.startsWith('proposals.autoAccept.'))
    return PR.rulesFor(config?.proposals?.autoAccept, q)[row.key.slice('proposals.autoAccept.'.length)];
  if (row.key === 'helpers') return isObject(q.helpers) ? q.helpers : {};
  return getPath(config, pathOf(row.key));
}

/** A value as short text: on/off, none, a short list, or "(in the file)" for an object. */
function valueText(row, v) {
  if (row.key.startsWith('limits.')) return L.limitText(row.key.slice('limits.'.length), v);
  if (row.key === 'helpers') return '(Helper agents tab)';
  if (v === true) return 'on';
  if (v === false) return 'off';
  if (v == null) return 'none';
  if (Array.isArray(v)) {
    if (!v.length) return 'none';
    const joined = v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(', ');
    return joined.length <= 40 ? joined : `${v.length} entries`;
  }
  if (isObject(v)) return Object.keys(v).length ? '(in the file)' : 'none';
  return String(v);
}

/** The option texts of an on/off or choice row (a true/false choice is "on"/"off"), else null. */
const optionText = (v) => (v === true ? 'on' : v === false ? 'off' : String(v));
function optionsOf(row) {
  if (row.type === 'onoff') return ['on', 'off'];
  if (row.type === 'choice') return (row.choices ?? []).map(optionText);
  return null;
}

/** "a", "a or b", "a, b or c". */
const orList = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} or ${xs.at(-1)}` : String(xs[0] ?? ''));

/**
 * Parses a value for a row. `limits` (the limits now) lets the limit rule check maxDPlus against maxConcurrent.
 * @returns {{ value: unknown } | { error: string }}
 */
function parseValue(row, raw, { limits } = {}) {
  if (!row) return { error: 'unknown setting' };
  const s = String(raw ?? '').trim();
  if (row.edit === 'read') return { error: `${row.key} is read only here (it is set where the project is set up).` };
  if (row.key === 'helpers') return { error: 'helpers: switch one with `ravenseat helpers on|off <agent>`.' };
  if (row.edit === 'file' || row.type === 'list' || row.type === 'object')
    return { error: `${row.key} is a ${row.type}: edit it in ${row.store === 'queue' ? 'queue.json' : 'queue.config.json'}.` };
  if (row.key.startsWith('limits.')) {
    const r = L.parseLimit(row.key.slice('limits.'.length), s, { ...L.DEFAULT_LIMITS, ...(limits ?? {}) });
    return 'error' in r ? { error: r.error } : { value: r.val };
  }
  const std = getPath(KK.STANDARD, pathOf(row.key));
  const none = ['none', 'null', ''].includes(s.toLowerCase());
  if (row.type === 'onoff') {
    const x = s.toLowerCase();
    if (['on', 'true', 'yes'].includes(x)) return { value: true };
    if (['off', 'false', 'no'].includes(x)) return { value: false };
    return { error: `${row.key} takes on or off.` };
  }
  if (row.type === 'choice') {
    const i = optionsOf(row).findIndex((o) => o.toLowerCase() === s.toLowerCase());
    if (i < 0) return { error: `${row.key} takes ${orList(optionsOf(row))}.` };
    return { value: row.choices[i] };
  }
  if (none && std === null) return { value: null };
  if (row.type === 'integer') {
    if (!/^\d+$/.test(s)) return { error: `${row.key} must be a whole number, 0 or more${std === null ? ' (or none)' : ''}.` };
    return { value: Number(s) };
  }
  if (row.type === 'number') {
    const v = Number(s.replace(',', '.'));
    if (!s || !Number.isFinite(v)) return { error: `${row.key} must be a number${std === null ? ' (or none)' : ''}.` };
    return { value: v };
  }
  if (!s || /[\u0000-\u001f\u007f]/.test(s)) return { error: `${row.key}: write a value.` };
  return { value: s };
}

/** Does a change to `value` need the owner's confirmation? Only when it weakens the guard and is weaker than `now`. */
function needsConfirm(row, value, { now, standard }) {
  if (!row?.weakens) return false;
  return row.weakens(value, standard) === true && row.weakens(value, now) === true;
}

// ---- The grouped view -----------------------------------------------------------------------------

/**
 * Every row with its value and marks, grouped in the categories.
 * @param {{ config: object, queue?: object, migrations?: boolean, rows?: object[] }} o
 *   rows defaults to the whole registry (a test can pass fewer); migrations false leaves out limits.maxDb.
 */
function settingsView({ config, queue = {}, migrations = true, rows = R.SETTINGS } = {}) {
  const mode = config?.mode === 'lite' ? 'lite' : 'full';
  const all = (rows ?? R.SETTINGS).filter((r) => r && (migrations || r.key !== 'limits.maxDb'));
  const view = (r) => {
    const value = valueOf(r, { config, queue });
    const standard = standardOf(r, { config, mode });
    const fullOnly = !r.modes.includes('lite');
    const options = optionsOf(r);
    return {
      key: r.key,
      category: r.category,
      title: r.title,
      explanation: r.explanation,
      level: r.level,
      fullOnly,
      fullWhy: r.fullWhy,
      hidden: mode === 'lite' && fullOnly,
      store: r.store,
      storeText: STORE_TEXT[r.store],
      edit: r.edit,
      type: r.type,
      options,
      value,
      valueText: valueText(r, value),
      standard,
      standardText: valueText(r, standard),
      changed: JSON.stringify(value) !== JSON.stringify(standard),
      weakened: !!r.weakens && r.weakens(value, standard) === true,
      canWeaken: !!r.weakens,
      protects: r.protects,
      whyNot: r.whyNot,
      changes: r.changes,
      // The options that would open the warning dialog from the value now (the board asks before it sends anything).
      confirmFor: options
        ? options.filter((o, i) => {
            const v = r.type === 'onoff' ? o === 'on' : r.choices[i];
            return needsConfirm(r, v, { now: value, standard });
          })
        : [],
    };
  };
  const categories = R.CATEGORIES.map((c) => {
    const mine = all.filter((r) => r.category === c.id).map(view);
    const ordered = [...mine.filter((r) => r.level === 'basic'), ...mine.filter((r) => r.level !== 'basic')];
    return {
      id: c.id,
      title: c.title,
      fullOnlyCategory: mode === 'lite' && ordered.length > 0 && ordered.every((r) => r.fullOnly),
      rows: ordered,
    };
  }).filter((c) => c.rows.length);
  const weakened = categories
    .flatMap((c) => c.rows)
    .filter((r) => r.weakened)
    .map((r) => ({ key: r.key, title: r.title, valueText: r.valueText, category: r.category }));
  return { mode, labels: R.LABELS, weakened, categories };
}

/**
 * `ravenseat settings` as lines. Flags: advanced (the advanced rows, marked), all (also the full-only rows in lite;
 * implies advanced), changed (only what differs from the default, from every level), category (an id or the start of
 * a title).
 */
function cliLines(view, { cli = 'ravenseat', advanced = false, all = false, changed = false, category = null } = {}) {
  const adv = advanced || all;
  const lite = view.mode === 'lite';
  const w = view.weakened;
  const out = [
    `Mode: ${view.mode}. Weakened guards: ${w.length ? `${w.length} (${w.map((x) => `${x.key} ${x.valueText}`).join(', ')})` : 'none'}.`,
    '',
  ];
  const wanted = category ? String(category).toLowerCase() : null;
  const cats = view.categories.filter(
    (c) => !wanted || c.id === wanted || c.title.toLowerCase().startsWith(wanted),
  );
  if (wanted && !cats.length)
    return [`No category "${category}". The categories: ${view.categories.map((c) => c.id).join(', ')}.`];
  for (const c of cats) {
    if (c.fullOnlyCategory && !all && !changed) {
      out.push(`${c.title}: full mode only (${cli} mode full).`, '');
      continue;
    }
    const fits = (r) => (changed ? r.changed : r.level === 'basic' || adv) && (!r.hidden || all);
    const shown = c.rows.filter(fits);
    const moreAdvanced = changed ? 0 : c.rows.filter((r) => r.level !== 'basic' && !adv && !r.hidden).length;
    const moreFull = c.rows.filter((r) => r.hidden && !all && (!changed || r.changed)).length;
    if (changed && !shown.length) continue;
    out.push(c.title);
    const kw = Math.max(0, ...shown.map((r) => r.key.length));
    const vw = Math.min(24, Math.max(0, ...shown.map((r) => r.valueText.length)));
    for (const r of shown) {
      const marks = [
        r.level !== 'basic' ? `[${view.labels.advanced.toLowerCase()}]` : null,
        lite && r.fullOnly ? `[${view.labels.fullOnly.toLowerCase()}: ${r.fullWhy}]` : null,
        r.weakened ? '[weakened]' : null,
      ].filter(Boolean);
      out.push(
        `  ${r.key.padEnd(kw)} ${r.valueText.padEnd(vw)} ${r.title} (${r.store === 'queue' ? 'you' : 'project'})` +
          (marks.length ? ` ${marks.join(' ')}` : ''),
      );
    }
    const more = [];
    if (moreAdvanced) more.push(`${moreAdvanced} advanced (--advanced)`);
    if (moreFull) more.push(`${moreFull} full mode only (--all)`);
    if (more.length) out.push(`  + ${more.join(', ')}`);
    out.push('');
  }
  out.push(`Change one: ${cli} settings set <key> <value>. Everything: ${cli} settings --all.`);
  return out;
}

/** The CLI's warning for a weakening change (exit 1, nothing written). */
function warningLines(row, valueTextNew, { cli = 'ravenseat', raw = valueTextNew, confirmWith = null } = {}) {
  // confirmWith: the command that confirms it, without the flags (an older command such as `proposals auto on`).
  const command = confirmWith ?? `${cli} settings set ${row.key} ${raw}`;
  return [
    `STOP: this weakens a guard (${row.key} ${valueTextNew}).`,
    `  Protects against: ${row.protects}`,
    `  Why not: ${row.whyNot}`,
    `  What changes: ${row.changes}`,
    `  ${STORE_TEXT[row.store]}.`,
    `Nothing was changed. Confirm with: ${command} --i-understand --by owner`,
  ];
}

// ---- The doctor row `settings` ----------------------------------------------------------------

/** How a weakened protectedPaths reads: how many default paths it leaves out (the floor is never left out). */
function protectedPathsText(value, standard) {
  const MG = require('./mergeGuard.js');
  const list = Array.isArray(value) ? value : MG.resolveProtectedPaths(value, standard).list;
  const have = new Set(list.map((p) => String(p).toLowerCase()));
  const outside = standard.filter((p) => !MG.inFloor(p));
  const lost = outside.filter((p) => !have.has(String(p).toLowerCase()));
  if (lost.length === outside.length) return 'protectedPaths leaves out every default path (the floor still holds)';
  const shown = lost.slice(0, 6).join(', ') + (lost.length > 6 ? ` and ${lost.length - 6} more` : '');
  return `protectedPaths leaves out ${lost.length} default path(s): ${shown}`;
}

/** The lite line: the rows whose lite default is weaker than the full one, still on that default (the file does not set them). */
function liteLine(config, own) {
  if (config?.mode !== 'lite') return null;
  const soft = R.SETTINGS.filter((r) => {
    if (!r.defaultByMode || !r.weakens || getPath(own ?? {}, pathOf(r.key)) !== undefined) return false;
    const { lite, full } = r.defaultByMode;
    return r.weakens(lite, full) === true && JSON.stringify(valueOf(r, { config, queue: {} })) === JSON.stringify(lite);
  });
  if (!soft.length) return null;
  const same = soft.every((r) => r.defaultByMode.lite === 'warn' && r.defaultByMode.full === 'stop');
  if (soft.length === 1) {
    const r = soft[0];
    const what = same ? 'warns instead of stopping' : `is ${r.defaultByMode.lite} instead of ${r.defaultByMode.full}`;
    return `lite: ${r.key} ${what} (set it in queue.config.json for full strength)`;
  }
  const keys = soft.map((r) => r.key);
  const names = `${keys.slice(0, -1).join(', ')} and ${keys[keys.length - 1]}`;
  return `lite: ${names} ${same ? 'warn instead of stop' : 'are softer than in full'} (set them in queue.config.json for full strength)`;
}

/** The weakened settings doctor names on lines of their own, not in the shared WARN line (doctorRows). */
const OWN_LINES = Object.freeze(['agentGuard.enabled', 'agentGuard.except', 'agentPushBlock.enabled']);

/**
 * The rows of the doctor check `settings` (plans/innstillinger-vurdering-2026-11-12.md, step 7):
 *   - one WARN line naming every guard weaker than its default (the registry's `weakens`, the same list as the banner of
 *     `ravenseat settings`), or one OK line when there is none;
 *   - INFO in lite: the defaults lite softens (gitSurface, dependencyFiles), while the file does not set them;
 *   - INFO per entry of protectedPaths.remove: taken out, kept (the floor), or not a default path;
 *   - the agent guards have lines of their own instead (OWN_LINES): WARN AGENT GUARD OFF and an INFO per agentGuard.except
 *     entry (lib/agentGuard.js doctorLines, owner decision B3), and a WARN when agentPushBlock is off (B1).
 * Doctor shows these with quiet guidance too: a switched-off guard should not be forgotten.
 * @param {{ config: object, queue?: object, own?: object, cli?: string }} o config = config() (resolved), own = the file
 */
function doctorRows({ config, queue = {}, own = {}, cli = 'ravenseat' }) {
  const name = 'settings';
  const view = settingsView({ config, queue });
  const weakened = view.categories.flatMap((c) => c.rows).filter((r) => r.weakened);
  const rows = weakened.filter((r) => !OWN_LINES.includes(r.key));
  const out = [];
  const ownLines = [
    ...require('./agentGuard.js').doctorLines(config, cli),
    ...(config?.agentPushBlock?.enabled === false
      ? [{
          status: 'WARN',
          message:
            'AGENT PUSH BLOCK OFF (agentPushBlock.enabled: false): agents can push from git itself when the text guard does ' +
            'not see the command',
          fix: `turn it back on with ${cli} settings set agentPushBlock.enabled on`,
        }]
      : []),
  ].map((r) => ({ ...r, name }));
  if (rows.length) {
    const parts = rows.map((r) => (r.key === 'protectedPaths' ? protectedPathsText(r.value, r.standard) : `${r.key} ${r.valueText}`));
    out.push({
      status: 'WARN',
      name,
      message: `${rows.length} guard(s) weaker than the default: ${parts.join('; ')}`,
      fix: `fine when you chose it; see them with ${cli} settings --changed, and set one back with ${cli} settings set <key> <default>`,
    });
  } else if (!ownLines.length) out.push({ status: 'OK', name, message: 'no guard is weaker than its default', fix: null });
  out.push(...ownLines);
  const lite = liteLine(config, own);
  if (lite) out.push({ status: 'INFO', name, message: lite, fix: null });
  const pp = own?.protectedPaths;
  if (pp && typeof pp === 'object' && !Array.isArray(pp)) {
    const MG = require('./mergeGuard.js');
    const std = require('./queueConfig.js').STANDARD.protectedPaths;
    const r = MG.resolveProtectedPaths(pp, std);
    if (!r.invalid)
      for (const p of pp.remove ?? []) {
        const text = r.removed.includes(p)
          ? 'is no longer protected'
          : r.floorKept.includes(p)
            ? 'stays protected (it is in the floor, which is never removed)'
            : r.notDefault.includes(p)
              ? 'is not a default path, so nothing was removed'
              : null;
        if (text) out.push({ status: 'INFO', name, message: `protectedPaths.remove: ${p} ${text}`, fix: null });
      }
  }
  return out;
}

// ---- The shared writer --------------------------------------------------------------------------

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SCALAR = '"(?:[^"\\\\]|\\\\.)*"|-?\\d[\\d.eE+-]*|true|false|null';

/** The index of the brace or bracket that closes the one at `at`, skipping strings; -1 when there is none. */
function closeOf(src, at) {
  let depth = 0;
  for (let i = at; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"') {
      for (i++; i < src.length && src[i] !== '"'; i++) if (src[i] === '\\') i++;
      continue;
    }
    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Sets one key in the text of a JSON object file and keeps the rest as written: a scalar is replaced in place; a new key
 * goes last in its object with the indentation of the object's first key; a missing parent object is written as one
 * inline object. Anything unusual is written out again with JSON.stringify (the key order is kept).
 * @param {string|null} text the file's text (null or empty: a new file)
 * @param {string[]} segs the key's segments (pathOf)
 * @returns {string} the new text (the same text when the value is already set)
 */
function setJsonText(text, segs, value) {
  const bom = /^﻿/.test(String(text ?? '')) ? '﻿' : '';
  const src = String(text ?? '').replace(/^﻿/, '');
  if (!src.trim()) return `${JSON.stringify(setPath({}, segs, value), null, 2)}\n`;
  const obj = JSON.parse(src);
  if (!isObject(obj)) throw new Error('the file must be a JSON object');
  const wantedObj = setPath(obj, segs, value);
  const wanted = JSON.stringify(wantedObj);
  if (JSON.stringify(obj) === wanted) return bom + src;
  const ok = (out) => {
    try {
      return JSON.stringify(JSON.parse(out)) === wanted ? bom + out : null;
    } catch {
      return null;
    }
  };
  const now = getPath(obj, segs);
  const scalar = (v) => v === null || ['string', 'number', 'boolean'].includes(typeof v);
  if (now !== undefined && scalar(now) && scalar(value)) {
    const re = new RegExp(`(${escapeRe(JSON.stringify(segs.at(-1)))}\\s*:\\s*)(${SCALAR})`, 'g');
    for (const m of src.matchAll(re)) {
      const out = ok(`${src.slice(0, m.index)}${m[1]}${JSON.stringify(value)}${src.slice(m.index + m[0].length)}`);
      if (out) return out;
    }
  }
  if (now === undefined) {
    // The deepest object on the way that exists; the key below it gets the rest as one inline value.
    let depth = segs.length - 1;
    while (depth > 0 && !isObject(getPath(obj, segs.slice(0, depth)))) depth--;
    const parent = segs.slice(0, depth);
    const entry = `${JSON.stringify(segs[depth])}: ${JSON.stringify(
      segs.length - depth > 1 ? setPath({}, segs.slice(depth + 1), value) : value,
    )}`;
    const opens = parent.length
      ? [...src.matchAll(new RegExp(`${escapeRe(JSON.stringify(parent.at(-1)))}\\s*:\\s*\\{`, 'g'))].map(
          (m) => m.index + m[0].length - 1,
        )
      : [src.indexOf('{')];
    for (const at of opens) {
      const close = closeOf(src, at);
      if (close < 0) continue;
      const inside = src.slice(at + 1, close);
      let out;
      if (!inside.trim()) out = `${src.slice(0, at + 1)}${entry}${src.slice(close)}`;
      else {
        const first = /^\s*/.exec(inside)[0];
        let last = close - 1;
        while (last > at && /\s/.test(src[last])) last--;
        out = `${src.slice(0, last + 1)},${first || ' '}${entry}${src.slice(last + 1)}`;
      }
      const good = ok(out);
      if (good) return good;
    }
  }
  return `${bom}${JSON.stringify(wantedObj, null, 2)}\n`;
}

module.exports = {
  doctorRows,
  STORE_TEXT,
  pathOf,
  getPath,
  setPath,
  standardOf,
  valueOf,
  valueText,
  optionsOf,
  parseValue,
  needsConfirm,
  settingsView,
  cliLines,
  warningLines,
  setJsonText,
};
