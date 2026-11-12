// =============================================================
// lib/checksCatalog.js: the suggestions on the Checks tab, as data. No suggestion is written in code.
//
// One template file per suggestion (checks-catalog/suggestions/<key>.md) and one list of categories
// (checks-catalog/categories.json). A project changes them without touching the plugin, in docs/queue/checks/ (same layout):
//   - a new file adds a suggestion, a file with the same name replaces it, a file with `off: true` removes it;
//   - a category with a new key is added, the same key replaces it, `"off": true` removes it and its suggestions.
//
// A template: a header (title, category, priority, when, why, content_min, also_task, action) and two sections,
// "## Investigate" and "## Plan and build". The sections become the mission of the investigation task.
// Two kinds need no agent: `action: gates` (ravenseat kickstart gates --apply) and `action: ask`, whose one section
// "## Ask Claude" is the text the owner gives Claude in their own session. `ask` is for a step a queue agent cannot take,
// such as the first commit: an agent's worktree is made from a commit.
//
//   parseTemplate(text, key)      one file as an object, with errors in words
//   mergeCatalog(builtin, own)    the project's files over the plugin's
//   loadCatalog({ builtin, own }) reads the two folders
//   holds(when, facts)            does a suggestion apply? Named conditions only, see CONDITIONS
//   buildReport(...)              what `ravenseat checks --json`, the board and checks-report.json read
//   planTask(...)                 the investigation task for `ravenseat add`
//
// Used by: cli/checks.mjs. Tested in: lib/__tests__/checksCatalog.test.ts.
// =============================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PRIORITIES = ['high', 'medium', 'low'];
const ACTIONS = ['gates', 'ask'];
const REPORT_VERSION = 1;

const anyKind = (arg, test) => arg.split('|').some((k) => test(k));
/** Where a kind of check was found: Set of ci, gate, script, hook, config. */
const placesOf = (facts, kind) => new Set((facts.kinds?.find((k) => k.key === kind)?.places ?? []).map((p) => p.where));

/** What a template's `when` may say. Comma = all must hold. `missing:a|b` = at least one of a and b. */
const CONDITIONS = {
  'has-git': (f) => !!f.git,
  // Only when the scan says so (false), never when the fact is unknown.
  'no-git': (f) => f.git === false,
  'no-commit': (f) => f.hasCommit === false,
  'has-remote': (f) => !!f.remote,
  'has-ci': (f) => (f.ci?.length ?? 0) > 0,
  'no-ci': (f) => (f.ci?.length ?? 0) === 0,
  'has-gates': (f) => !!f.hasGates,
  'no-gates': (f) => !f.hasGates,
  'checks-found': (f) => (f.checks?.length ?? 0) > 0,
  'secrets-open': (f) => f.secretsOk === false,
  'known-stack': (f) => (f.stacks?.length ?? 0) > 0,
  // Claude's instructions are over a limit (lib/instructionSize.js assess().large, off with instructionSize.mode off).
  'instructions-large': (f) => f.instructionsLarge === true,
};
const KIND_CONDITIONS = {
  missing: (f, arg) => anyKind(arg, (k) => placesOf(f, k).size === 0),
  found: (f, arg) => anyKind(arg, (k) => placesOf(f, k).size > 0),
  'not-in-ci': (f, arg) => anyKind(arg, (k) => placesOf(f, k).size > 0 && !placesOf(f, k).has('ci')),
};

const conditionsOf = (when) => String(when ?? '').split(',').map((x) => x.trim()).filter(Boolean);

/** A condition's name is known? */
function knownCondition(c) {
  const [name, arg] = c.split(':');
  return arg ? !!KIND_CONDITIONS[name] : !!CONDITIONS[name];
}

/** Does `when` hold? An empty `when` always does; an unknown condition never does (parseTemplate reports it). */
function holds(when, facts) {
  return conditionsOf(when).every((c) => {
    const [name, arg] = c.split(':');
    if (arg) return KIND_CONDITIONS[name] ? KIND_CONDITIONS[name](facts, arg) : false;
    return CONDITIONS[name] ? CONDITIONS[name](facts) : false;
  });
}

/**
 * One template file as an object.
 * @returns {{ key: string, off: boolean, errors: string[], title?: string, category?: string, priority?: string, when?: string,
 *   why?: string, contentMin?: number, alsoTask?: string|null, action?: string|null, investigate?: string, plan?: string }}
 */
function parseTemplate(text, key) {
  const src = String(text ?? '').replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(src);
  if (!m) return { key, off: false, errors: [`${key}: no header between --- lines`] };
  const head = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) head[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  if (head.off === 'true') return { key, off: true, errors: [] };
  const sections = {};
  let current = null;
  for (const line of m[2].split('\n')) {
    const h = /^##\s+(.+)$/.exec(line);
    if (h) current = h[1].trim().toLowerCase();
    else if (current) sections[current] = `${sections[current] ?? ''}${line}\n`;
  }
  const out = {
    key,
    off: false,
    title: head.title,
    category: head.category,
    priority: head.priority,
    when: head.when ?? '',
    why: head.why,
    contentMin: Number(head.content_min) > 0 ? Number(head.content_min) : 60,
    alsoTask: head.also_task || null,
    action: head.action || null,
    ask: (sections['ask claude'] ?? '').trim(),
    investigate: (sections.investigate ?? '').trim(),
    plan: (sections['plan and build'] ?? '').trim(),
    errors: [],
  };
  for (const field of ['title', 'category', 'why']) if (!out[field]) out.errors.push(`${key}: "${field}" is missing`);
  if (!PRIORITIES.includes(out.priority)) out.errors.push(`${key}: priority must be ${PRIORITIES.join(', ')}`);
  for (const c of conditionsOf(out.when)) if (!knownCondition(c)) out.errors.push(`${key}: unknown condition "${c}"`);
  if (out.action && !ACTIONS.includes(out.action)) out.errors.push(`${key}: action must be ${ACTIONS.join(' or ')}`);
  // A suggestion with its own action needs no agent, so it has no mission to fill. `ask` needs the text to give Claude.
  if (out.action === 'ask' && !out.ask) out.errors.push(`${key}: action ask needs the section "## Ask Claude"`);
  if (!out.action && (!out.investigate || !out.plan)) out.errors.push(`${key}: needs the sections "## Investigate" and "## Plan and build"`);
  return out;
}

/** The project's categories and templates over the plugin's. */
function mergeCatalog(builtin, own) {
  const categories = new Map(builtin.categories.map((c) => [c.key, c]));
  for (const c of own.categories) categories.set(c.key, { ...categories.get(c.key), ...c });
  const templates = new Map(builtin.templates.map((x) => [x.key, x]));
  for (const x of own.templates) templates.set(x.key, x);
  const shown = [...categories.values()].filter((c) => !c.off);
  const shownKeys = new Set(shown.map((c) => c.key));
  const valid = [...templates.values()].filter((x) => !x.off);
  return {
    categories: shown,
    // A category switched off takes its suggestions with it. A category nobody listed is not lost: it shows under its key.
    templates: valid.filter((x) => !x.errors.length && (shownKeys.has(x.category) || !categories.has(x.category))),
    errors: [...builtin.errors, ...own.errors, ...valid.flatMap((x) => x.errors)],
  };
}

/** One folder as { categories, templates, errors }. A folder that is not there is simply empty. */
function readFolder(folder, label) {
  const errors = [];
  let categories = [];
  try {
    const list = JSON.parse(fs.readFileSync(path.join(folder, 'categories.json'), 'utf8'));
    if (!Array.isArray(list)) throw new Error('not a list');
    categories = list.filter((c) => {
      const ok = c && typeof c.key === 'string' && (c.off === true || typeof c.title === 'string');
      if (!ok) errors.push(`${label}/categories.json: every category needs "key" and "title"`);
      return ok;
    });
  } catch (e) {
    if (e?.code !== 'ENOENT') errors.push(`${label}/categories.json: ${e.message}`);
  }
  let names = [];
  try {
    names = fs.readdirSync(path.join(folder, 'suggestions')).filter((f) => f.endsWith('.md')).sort();
  } catch {
    /* no templates in this folder */
  }
  const templates = names.map((f) => parseTemplate(fs.readFileSync(path.join(folder, 'suggestions', f), 'utf8'), f.slice(0, -3)));
  return { categories, templates, errors };
}

const loadCatalog = ({ builtin, own }) => mergeCatalog(readFolder(builtin, 'plugin catalog'), readFolder(own, 'docs/queue/checks'));

const planIdBase = (key) => `KS-PLAN-${key.toUpperCase()}`;

/** The investigation tasks of a suggestion, newest last (a declined one can be asked for again: -2, -3). */
function planTasks(key, tasks) {
  const re = new RegExp(`^${planIdBase(key)}(?:-(\\d+))?$`);
  return (tasks ?? []).filter((x) => re.test(x.id));
}

/** Where a suggestion stands: open, queued (a task is on its way), planned (an investigation is delivered), dismissed. */
function suggestionState(t, tasks, dismissed) {
  if (dismissed.includes(t.key)) return { state: 'dismissed', taskId: null };
  const related = [...planTasks(t.key, tasks), ...(tasks ?? []).filter((x) => x.id === t.alsoTask)].filter((x) => x.status !== 'cancelled');
  const task = related[related.length - 1];
  if (!task) return { state: 'open', taskId: null };
  return { state: task.status === 'done' ? 'planned' : 'queued', taskId: task.id };
}

/**
 * The whole picture. It is a plain snapshot: the same object is the file, the --json answer and what the board draws.
 * @param {{ facts: object, catalog: object, tasks: object[], dismissed: string[], knownBugs?: object, now: string }} input
 */
function buildReport({ facts, catalog, tasks = [], dismissed = [], knownBugs = null, now }) {
  const rank = (x) => PRIORITIES.indexOf(x.priority);
  const order = new Map(catalog.categories.map((c, i) => [c.key, i]));
  const suggestions = catalog.templates
    .filter((x) => holds(x.when, facts))
    .sort((a, b) => rank(a) - rank(b) || (order.get(a.category) ?? 99) - (order.get(b.category) ?? 99) || a.key.localeCompare(b.key))
    .map((x) => ({
      key: x.key,
      title: x.title,
      category: x.category,
      priority: x.priority,
      why: x.why,
      contentMin: x.contentMin,
      action: x.action,
      ask: x.ask,
      investigate: x.investigate,
      plan: x.plan,
      ...suggestionState(x, tasks, dismissed),
    }));
  return {
    version: REPORT_VERSION,
    scannedAt: now,
    stacks: facts.stacks ?? [],
    git: !!facts.git,
    hasCommit: facts.hasCommit !== false,
    found: { ci: facts.ci ?? [], kinds: facts.kinds ?? [] },
    categories: catalog.categories.map(({ key, title, text }) => ({ key, title, text: text ?? '' })),
    suggestions,
    knownBugs,
    catalogErrors: catalog.errors,
  };
}

/** One line per kind, so the agent starts from what was found. */
function foundLines(found) {
  const lines = found.kinds.map((k) => `- ${k.title}: ${[...new Set(k.places.map((p) => (p.where === 'ci' ? `CI (${p.file})` : p.where)))].join(', ')}`);
  return lines.length ? lines.join('\n') : '- No checks found.';
}

/** The investigation task a suggestion becomes: the template's sections, what was found, and what the task must deliver. */
function planTask(s, found, tasks) {
  const n = planTasks(s.key, tasks).length;
  return {
    id: `${planIdBase(s.key)}${n ? `-${n + 1}` : ''}`,
    title: `Investigate and plan: ${s.title}`,
    class: 'U',
    domain: 'ci',
    feature: 'Checks and CI',
    value: { high: 8, medium: 6, low: 4 }[s.priority],
    content_min: s.contentMin,
    labels: ['checks-plan'],
    added_by: 'checks agent',
    own_track: 'an investigation the owner chose on the Checks tab',
    mission: [
      `Investigate and plan: ${s.title}. Do not build it in this task.`,
      `Why it was suggested: ${s.why}`,
      `What ravenseat read from the project's files (nothing was run):\n${foundLines(found)}`,
      `## Investigate\n${s.investigate}`,
      `## Plan and build\n${s.plan}`,
      '## Deliver\nWrite track-result.md in plain words for someone who may never have used CI: what you found, your recommendation (saying it is not worth doing is a fine result), what it costs in agent time and CI minutes, and the risks. ' +
        'End track-result.md with the plan: each build step you recommend, as title, why, files and size. The owner decides which become tasks. Do not change the project\'s code, its config or queue.config.json. Never push, deploy or change settings on the git host.',
    ].join('\n\n'),
    acceptance: ['track-result.md has a recommendation and what it costs', 'No project files are changed, and each recommended build step is listed for the owner'],
  };
}

module.exports = { PRIORITIES, ACTIONS, CONDITIONS, holds, parseTemplate, mergeCatalog, loadCatalog, buildReport, planTask, planTasks };
