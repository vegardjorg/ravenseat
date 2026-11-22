// =============================================================
// boardSearch.js: the structured search in the board's search box (roadmap 0ø J6, plans/jira-vurdering-2026-11-18.md
// proposal 6). Pure: no DOM, no clock of its own (the caller passes `now`), never throws.
//
// A search is words and fields, split on spaces:
//   plain words        searched in the card's id, title, feature and project as one phrase, exactly as before
//   class:D            the risk class, exact (D is not D+); a comma list is "or": class:d,u
//   status:running     the task status; status:blocked is what the board calls Blocked (a block, or waiting on something)
//   project:auth       the project          block:gate-red   the open block's code
//   label:visual       one of the labels    plan:PL-AUTH     the plan (the rule the plan page already uses)
//   age>2d  age<3h     time since the card last changed (m, h, d, w; a bare number is days)
//   cost>1  cost<=0.5  the measured cost in USD; a card without a measured cost never matches a comparison
//   -class:K           a leading minus leaves out
// Values of one field are "or", different fields are "and". An unknown field or a bad value becomes a hint (shown
// under the box) and is left out of the match, so a typo never empties the board. A field with no value yet ("class:")
// is left out without a hint: you are still typing.
// =============================================================
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.QueueSearch = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** The fields, in the order the suggestions show them. */
  const FIELDS = ['class', 'status', 'project', 'block', 'label', 'plan', 'age', 'cost'];
  /** Fields that compare a number (age, cost) take > < >= <=; the rest take :. */
  const COMPARE = new Set(['age', 'cost']);
  const CLASSES = ['K', 'D', 'D+', 'U'];
  const STATUSES = ['proposed', 'waiting', 'running', 'picked', 'review', 'done', 'cancelled', 'blocked'];
  /** The queue's block codes (lib/logic BLOCK_CODES; boardSearch.test.ts keeps the two lists equal). */
  const BLOCK_CODES = [
    'merge-conflict',
    'merge-guard',
    'merge-stopped',
    'gate-red',
    'context',
    'quota',
    'owner-question',
    'track-question',
    'dependency',
    'no-agent',
    'silent',
    'secret-found',
    'other',
  ];
  const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
  const EXAMPLES = { age: ['1h', '1d', '2d', '1w'], cost: ['0.5', '1', '5'] };

  /** A field-like word: an optional minus, a name of letters, an operator, the rest. "10:30" is not one. */
  const FIELD_WORD = /^(-?)([a-z][a-z_]*)(>=|<=|:|>|<)(.*)$/i;

  function ageMs(value) {
    const m = /^(\d+(?:\.\d+)?)([mhdw]?)$/i.exec(value);
    if (!m) return null;
    return Number(m[1]) * UNIT_MS[(m[2] || 'd').toLowerCase()];
  }

  function costUsd(value) {
    const m = /^\$?(\d+(?:\.\d+)?)$/.exec(value);
    return m ? Number(m[1]) : null;
  }

  /**
   * Splits a search into plain text, terms and hints.
   * @returns {{text: string, terms: {field, op, values?, number?, negate}[], hints: string[]}}
   */
  function parse(search) {
    const words = [];
    const terms = [];
    const hints = [];
    for (const w of String(search ?? '')
      .split(/\s+/)
      .filter(Boolean)) {
      const m = FIELD_WORD.exec(w);
      if (!m) {
        words.push(w.toLowerCase());
        continue;
      }
      const negate = m[1] === '-';
      const field = m[2].toLowerCase();
      const op = m[3];
      const raw = m[4];
      if (!FIELDS.includes(field)) {
        hints.push(`"${field}" is not a search field. Fields: ${FIELDS.join(', ')}.`);
        continue;
      }
      if (!raw) continue; // still typing
      if (COMPARE.has(field)) {
        if (op === ':') {
          hints.push(`${field} compares: write ${field}>${EXAMPLES[field][1]} or ${field}<${EXAMPLES[field][1]}.`);
          continue;
        }
        const number = field === 'age' ? ageMs(raw) : costUsd(raw);
        if (number == null) {
          hints.push(
            field === 'age'
              ? `age takes a time such as 2d, 3h or 1w, not "${raw}".`
              : `cost takes a number of USD such as 0.5, not "${raw}".`,
          );
          continue;
        }
        terms.push({ field, op, number, negate });
        continue;
      }
      if (op !== ':') {
        hints.push(`${field} takes ${field}:value, not ${op}.`);
        continue;
      }
      const values = raw.toLowerCase().split(',').filter(Boolean);
      if (!values.length) continue;
      if (field === 'class') {
        const bad = values.filter((v) => !CLASSES.some((c) => c.toLowerCase() === v));
        if (bad.length) {
          hints.push(`class "${bad.join(', ')}" does not exist. Classes: ${CLASSES.join(', ')}.`);
          continue;
        }
      }
      if (field === 'status') {
        const bad = values.filter((v) => !STATUSES.includes(v));
        if (bad.length) {
          hints.push(`status "${bad.join(', ')}" does not exist. Statuses: ${STATUSES.join(', ')}.`);
          continue;
        }
      }
      if (field === 'block') {
        const bad = values.filter((v) => !BLOCK_CODES.includes(v));
        if (bad.length) {
          hints.push(`block "${bad.join(', ')}" is not a block code. Codes: ${BLOCK_CODES.join(', ')}.`);
          continue;
        }
      }
      terms.push({ field, op, values, negate });
    }
    return { text: words.join(' '), terms, hints };
  }

  /**
   * The card's block: `block` is the Blocked column's stuck block (an object with code on the board, a plain code in
   * the tests); `open_block` is any open block's code.
   */
  function blockCode(k) {
    const b = k?.block;
    if (typeof b === 'string') return b;
    return b?.code ?? k?.open_block ?? null;
  }

  /**
   * status:blocked is what the board calls Blocked: a stuck or open block, or a waiting card that is not ready (it
   * waits on a dependency, an answer, a file owner or a parking; the "Blocked" group under In queue).
   */
  function isBlocked(k) {
    return Boolean(blockCode(k)) || (low0(k?.status) === 'waiting' && k?.ready === false);
  }

  function low0(v) {
    return String(v ?? '').toLowerCase();
  }

  /** Does one term hold for a card? */
  function holds(k, t, now) {
    const low = (v) => String(v ?? '').toLowerCase();
    switch (t.field) {
      case 'class':
        return t.values.includes(low(k?.class));
      case 'status':
        return t.values.some((v) => (v === 'blocked' ? isBlocked(k) : low(k?.status) === v));
      case 'project':
        return t.values.includes(low(k?.project));
      case 'block':
        return t.values.includes(low(blockCode(k)));
      case 'plan':
        return t.values.includes(low(k?.plan));
      case 'label': {
        const labels = (Array.isArray(k?.labels) ? k.labels : []).map(low);
        return t.values.some((v) => labels.includes(v));
      }
      case 'age':
      case 'cost': {
        let have;
        if (t.field === 'age') {
          const at = Date.parse(k?.changed_at ?? '');
          have = Number.isFinite(at) ? now - at : null;
        } else {
          have = typeof k?.cost_usd === 'number' ? k.cost_usd : null;
        }
        if (have == null) return false;
        if (t.op === '>') return have > t.number;
        if (t.op === '<') return have < t.number;
        if (t.op === '>=') return have >= t.number;
        return have <= t.number;
      }
      default:
        return true;
    }
  }

  /**
   * Does a card match a parsed search? Plain text as before; :-terms of the same field are "or"; comparisons and
   * different fields are "and"; a negated term that holds leaves the card out.
   */
  function matches(k, parsed, opts) {
    try {
      const now = opts?.now ?? Date.now();
      const p = parsed && typeof parsed === 'object' ? parsed : parse(parsed);
      const groups = new Map();
      for (const t of p.terms) {
        if (t.negate) {
          if (holds(k, t, now)) return false;
          continue;
        }
        if (COMPARE.has(t.field)) {
          if (!holds(k, t, now)) return false;
          continue;
        }
        const g = groups.get(t.field) ?? [];
        g.push(t);
        groups.set(t.field, g);
      }
      for (const g of groups.values()) if (!g.some((t) => holds(k, t, now))) return false;
      if (!p.text) return true;
      return `${k?.id} ${k?.title} ${k?.feature ?? ''} ${k?.project}`.toLowerCase().includes(p.text);
    } catch {
      return true;
    }
  }

  /** Does the search use a known field? (The board shows the field help only then.) */
  function isStructured(search) {
    return (
      parse(search).terms.length > 0 ||
      String(search ?? '')
        .split(/\s+/)
        .some((w) => {
          const m = FIELD_WORD.exec(w);
          return Boolean(m && FIELDS.includes(m[2].toLowerCase()));
        })
    );
  }

  /**
   * Suggestions for the word at the caret.
   * @param known {class?, project?, label?, plan?}: the values on the board now (class falls back to the four classes)
   * @returns {{from: number, to: number, items: {insert: string, label: string}[]}}
   */
  function suggest(text, caret, known) {
    const s = String(text ?? '');
    const at = Math.max(0, Math.min(Number.isFinite(caret) ? caret : s.length, s.length));
    const from = s.slice(0, at).search(/\S*$/);
    const word = s.slice(from, at);
    const none = { from, to: at, items: [] };
    if (!word) return none;
    const neg = word.startsWith('-') ? '-' : '';
    const body = word.slice(neg.length);
    const m = /^([a-z][a-z_]*)(>=|<=|:|>|<)(.*)$/i.exec(body);
    if (!m) {
      const name = body.toLowerCase();
      if (!name || !/^[a-z_]+$/.test(name)) return none;
      const items = [];
      for (const f of FIELDS) {
        if (!f.startsWith(name)) continue;
        if (COMPARE.has(f)) for (const op of ['>', '<']) items.push({ insert: `${neg}${f}${op}`, label: `${f}${op}` });
        else items.push({ insert: `${neg}${f}:`, label: `${f}:` });
      }
      return { from, to: at, items };
    }
    const field = m[1].toLowerCase();
    const op = m[2];
    if (!FIELDS.includes(field)) return none;
    let values;
    if (COMPARE.has(field)) values = op === ':' ? [] : EXAMPLES[field];
    else if (op !== ':') values = [];
    else if (field === 'class') values = known?.class?.length ? known.class : CLASSES;
    else if (field === 'status') values = STATUSES;
    else if (field === 'block') values = BLOCK_CODES;
    else values = Array.isArray(known?.[field]) ? known[field] : [];
    // After a comma, only the last value is being typed.
    const typed = m[3];
    const cut = typed.lastIndexOf(',') + 1;
    const before = typed.slice(0, cut);
    const part = typed.slice(cut).toLowerCase();
    const head = `${neg}${field}${op}${before}`;
    const items = [...new Set(values.map(String))]
      .filter((v) => v.toLowerCase().startsWith(part))
      .slice(0, 20)
      .map((v) => ({
        insert: `${head}${v}`,
        label: `${field}${op}${before}${v}`,
      }));
    return { from, to: at, items };
  }

  /** Puts a chosen suggestion into the text; the caret goes right after it. */
  function applySuggestion(text, s, item) {
    const t = String(text ?? '');
    const out = t.slice(0, s.from) + item.insert + t.slice(s.to);
    return { text: out, caret: s.from + item.insert.length };
  }

  return {
    FIELDS,
    CLASSES,
    STATUSES,
    BLOCK_CODES,
    parse,
    matches,
    isStructured,
    suggest,
    applySuggestion,
  };
});
