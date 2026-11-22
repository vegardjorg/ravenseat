// =============================================================
// askCatalog.js: the categories an owner question belongs to (ask-catalog/categories.json, table 4.1 of
// plans/autonomi-nivaa-utredning.md; owner decision 2026-11-06, phase 1).
//
// WHY: a question with a category can be counted per kind (how often the owner follows the recommendation on small UI
// choices, say), and later steered per kind (phase 2: levels and per-row overrides, NOT here). The file is data, the same
// idea as checks-catalog/: key, title, what it covers and the enforcement label (how the rule is held: "Stopped" by a
// guard, "Spotted" by receive, or only the agent's judgment). Never code or patterns in the data.
//
//   categories()          the rows, read once from ask-catalog/categories.json
//   parseCategories(text) the rows from a file's text; throws on a broken file (pure)
//   KEYS                  the keys in order
//   categoryError(key)    null for a known key, otherwise a message that lists the keys (for an agent to fix its question)
//   isCategory(key)       is it a known key?
//   titleOf(key)          the title, or "Uncategorized"
//   categoryOf(q)         a question's category key, or "uncategorized" (an old post, or one without the field)
//
// Used by lib/logic/questions.js (setQuestion), lib/queueBoard.js and lib/decisionRows.js. lib/queueDecisions.js keeps
// the titles for the browser (a test keeps them equal). Tested in lib/__tests__/askCatalog.test.ts.
// =============================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** The file next to checks-catalog/. */
const FILE = path.join(__dirname, '..', 'ask-catalog', 'categories.json');
/** The category of an old post, or of a question type that is not asked to have one (condition, lawyer, owner-task). */
const UNCATEGORIZED = 'uncategorized';
const FIELDS = ['key', 'title', 'covers', 'enforcement'];

/** The rows from the text of a categories file. Throws with what is wrong. */
function parseCategories(text) {
  const list = JSON.parse(text);
  if (!Array.isArray(list)) throw new Error('ask-catalog/categories.json must be a list of categories');
  const seen = new Set();
  return list.map((r, i) => {
    for (const f of FIELDS)
      if (typeof r?.[f] !== 'string' || !r[f].trim())
        throw new Error(`ask-catalog/categories.json row ${i + 1}: ${f} is missing (each row has ${FIELDS.join(', ')})`);
    if (!/^[a-z][a-z0-9-]{0,30}$/.test(r.key)) throw new Error(`ask-catalog/categories.json row ${i + 1}: invalid key`);
    if (seen.has(r.key)) throw new Error(`ask-catalog/categories.json: the key ${r.key} is there twice`);
    seen.add(r.key);
    return { key: r.key, title: r.title, covers: r.covers, enforcement: r.enforcement };
  });
}

let cache = null;
/** The rows, read once. */
function categories() {
  cache ??= parseCategories(fs.readFileSync(FILE, 'utf8'));
  return cache;
}

const KEYS = categories().map((r) => r.key);

const isCategory = (key) => typeof key === 'string' && KEYS.includes(key);

/** null for a known key; otherwise what is wrong and the keys to choose from. */
function categoryError(key) {
  if (isCategory(key)) return null;
  const list = `use one of ${KEYS.join(', ')}`;
  if (typeof key !== 'string' || !key.trim()) return `category is missing: ${list}`;
  return `unknown category ${JSON.stringify(key)}: ${list}`;
}

/** The title of a category ("New libraries"), or "Uncategorized". */
function titleOf(key) {
  return categories().find((r) => r.key === key)?.title ?? 'Uncategorized';
}

/** A question's category key, or "uncategorized". */
function categoryOf(q) {
  return isCategory(q?.category) ? q.category : UNCATEGORIZED;
}

module.exports = { FILE, UNCATEGORIZED, KEYS, parseCategories, categories, categoryError, isCategory, titleOf, categoryOf };
