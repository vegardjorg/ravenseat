// =============================================================
// catalogExcerpt.js: the part of the project catalog (docs/queue/catalog/, lib/catalog.js) a task's mission and its
// review package get. Bolk B4 of the scope drift plan (plans/scope-drift-dry-katalog-2026-11-15.md § 2.5 and V9).
//
// WHY: a track that does not know the project's helpers and design choices writes them again, and a reviewer that
// does not see them cannot tell. The whole catalog in every mission would cost every turn, and putting it in the
// instructions file would load it in every session. So the queue does what a path-scoped rule does, but when the
// mission is made and the same for every client: it picks what meets the task's files and puts only that in the
// mission, under a fixed cap, with the size in its heading so the cost can be measured.
//
// What goes in (choose):
//   - design choices whose `paths` meet the task's owned_files, shared_patch or reads (a file the glob matches, or a
//     folder the glob can reach), at most MAX.decisions, the binding ones first. Only a choice the owner accepted (with
//     the record, catalog.js effectiveStatus) is binding; a proposed one, and one that says accepted without the
//     record (unconfirmed), is a suggestion. A superseded choice never. A task that names no files gets every binding
//     choice and no suggestions: nothing says which proposals concern it.
//   - design entries (kind design, roadmap 0å KD-1) under their own "Design language" heading, holding or proposed,
//     each with its status and where its tokens live (source), at most MAX.design, the ones that hold first. They
//     follow the binding choices in the room order. reviewer-design reads the same lines in the review package.
//   - the prefer lines of stack.md, at most MAX.prefer (they apply to the whole project).
//   - the reuse.md rows in the task's folders (the folder of an owned or read file, or inside an owned folder), at most
//     MAX.reuse; a task that names no files gets the first rows.
//   - with the generated index (lib/catalogIndex.js, bolk B5, catalog.index on): the building blocks tagged `@shared`
//     in the task's folders (the same folder rule as the reuse rows, a reuse row for the same symbol wins), at most
//     MAX.shared; and in the review form only, the near names (V1b): a name the delivery defines that is close to one
//     the code exports elsewhere, at most MAX.near.
// The cap (excerptTokens, default 1500; a token is counted as 4 characters, as lib/instructionSize.js does): the items
// are added in the order binding choices, near names, prefer lines, suggestions, reuse rows, tagged blocks while they
// fit, so the tagged blocks and the reuse rows are cut first. The heading says how many tokens the block used, the cap,
// and how many items of each kind were cut. Without an index the text is byte for byte what it was before B5.
//
// Two forms of the same choice: `mission` (a bold heading in the track block, lib/logic/external.js trackBlock) and
// `review` (a "## From the project catalog" section in 00-package.md, lib/logic/results.js reviewPackageIndex, with the
// sentence that tells the reviewer what to check and which finding classes to use). Both are client-neutral text.
//
// excerpt is pure (the catalog object and the owner record are passed in); forTask reads the folder and the record
// (fs can be swapped) and never throws. Tested in lib/__tests__/catalogExcerpt.test.ts.
// =============================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const C = require('./catalog.js');

/** How many items of each kind at most, before the token cap: the plan's numbers (§ 2.5). */
const MAX = Object.freeze({ decisions: 5, design: 3, prefer: 10, reuse: 15, shared: 15, near: 5 });
/** Characters per token, as lib/instructionSize.js estimates. */
const CHARS_PER_TOKEN = 4;
/** How many of a choice's path patterns are shown (the rest is in the file). */
const SHOWN_PATHS = 2;

const tokensOf = (s) => Math.round(String(s).length / CHARS_PER_TOKEN);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A path from the ownership lists: forward slashes, no leading "./"; '' for anything else. */
function normPath(p) {
  if (typeof p !== 'string') return '';
  return p.trim().replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
}

/** The task's files and folders: owned_files, shared_patch and reads (a folder ends with "/"). */
function scopeOf(task) {
  const out = [];
  for (const k of ['owned_files', 'shared_patch', 'reads'])
    for (const p of Array.isArray(task?.[k]) ? task[k] : []) {
      const n = normPath(p);
      if (n && !out.includes(n)) out.push(n);
    }
  return out;
}

/** The text before the first wildcard of a glob. */
const literalPrefix = (g) => g.split(/[*?[{]/)[0];

/** Can the glob match the entry: a file it matches, or a folder it can reach into (or that holds what it names)? */
function meets(pattern, entry, glob) {
  const g = normPath(pattern);
  if (!g) return false;
  if (!entry.endsWith('/')) return glob(g, entry);
  if (!g.includes('/')) return true; // a bare name or "*.sql" matches in any folder
  const prefix = literalPrefix(g);
  return entry.startsWith(prefix) || prefix.startsWith(entry);
}

const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

/** Is a reuse row in the task's folders? */
function rowInScope(file, scope) {
  const f = normPath(file);
  return scope.some((e) => (e.endsWith('/') ? f.startsWith(e) : f === e || dirOf(f) === dirOf(e)));
}

/**
 * What the excerpt can hold for the task, before the token cap: the items per kind, and what the per-kind maxima cut.
 * index: the generated index (lib/catalogIndex.js) or null; near: the near names (V1b) or [].
 * @returns {{ binding: object[], proposed: object[], prefer: object[], reuse: object[], shared: object[], near: object[],
 *   noFiles: boolean, cut: { binding: number, proposed: number, prefer: number, reuse: number, near: number, shared: number } }}
 */
function choose(cat, task, { ledger = C.emptyLedger(), glob = require('./mergeGuard.js').globMatch, index = null, near = [] } = {}) {
  const scope = scopeOf(task);
  const noFiles = scope.length === 0;
  const binding = [];
  const proposed = [];
  const design = [];
  const ds = (cat?.decisions ?? [])
    .map((x) => x?.decision)
    .filter((d) => d && typeof d.id === 'string' && typeof d.invariant === 'string' && d.invariant.trim())
    .sort((a, b) => a.id.localeCompare(b.id));
  for (const d of ds) {
    // A "Not building" entry (roadmap 0f) binds no code: it is matched against new proposals, never sent to a track.
    if (C.isNotBuilding(d)) continue;
    const status = C.effectiveStatus(d, ledger);
    if (status !== 'accepted' && status !== 'proposed' && status !== 'unconfirmed') continue;
    if (status !== 'accepted' && noFiles) continue;
    // A file the entry's except names does not count (roadmap 0å KD-0); a folder still does, it may hold other files.
    const excepted = (e) => !e.endsWith('/') && (d.except ?? []).some((x) => glob(normPath(x), e));
    if (!noFiles && !d.paths.some((p) => scope.some((e) => !excepted(e) && meets(p, e, glob)))) continue;
    // A design entry (roadmap 0å KD-1) gets its own section, holding or not: the status is on its line.
    if (d.kind === 'design') design.push({ d, status });
    else (status === 'accepted' ? binding : proposed).push({ d, status });
  }
  const cut = { binding: 0, design: 0, proposed: 0, prefer: 0, reuse: 0, near: 0, shared: 0 };
  // At most MAX.design design entries, the ones that hold first.
  design.sort((a, b) => (a.status === 'accepted') === (b.status === 'accepted') ? 0 : a.status === 'accepted' ? -1 : 1);
  const keepDesign = design.slice(0, MAX.design);
  cut.design = design.length - keepDesign.length;
  // At most MAX.decisions choices, the binding ones first.
  const keepBinding = binding.slice(0, MAX.decisions);
  cut.binding = binding.length - keepBinding.length;
  const keepProposed = proposed.slice(0, Math.max(0, MAX.decisions - keepBinding.length));
  cut.proposed = proposed.length - keepProposed.length;
  const prefer = cat?.stack?.prefer ?? [];
  cut.prefer = Math.max(0, prefer.length - MAX.prefer);
  const rows = (cat?.reuse?.rows ?? []).filter((r) => noFiles || rowInScope(r.file, scope));
  cut.reuse = Math.max(0, rows.length - MAX.reuse);
  // The tagged blocks from the generated index, in the same folders; a reuse row for the same symbol and file wins.
  const listed = new Set((cat?.reuse?.rows ?? []).map((r) => `${r.symbol}|${normPath(r.file)}`));
  const shared = index
    ? require('./catalogIndex.js')
        .sharedRows(index)
        .filter((r) => (noFiles || rowInScope(r.file, scope)) && !listed.has(`${r.symbol}|${r.file}`))
    : [];
  cut.shared = Math.max(0, shared.length - MAX.shared);
  const nearList = Array.isArray(near) ? near : [];
  cut.near = Math.max(0, nearList.length - MAX.near);
  return {
    binding: keepBinding,
    design: keepDesign,
    proposed: keepProposed,
    prefer: prefer.slice(0, MAX.prefer),
    reuse: rows.slice(0, MAX.reuse),
    shared: shared.slice(0, MAX.shared),
    near: nearList.slice(0, MAX.near),
    noFiles,
    cut,
  };
}

// ---- the text ---------------------------------------------------------------------------------------------------------

const SECTIONS = Object.freeze({
  binding:
    '- **Design choices that hold** (accepted by the owner, binding: a change that would break one is an owner question, never your call):',
  design:
    "- **Design language** (the project's design rules for these files: take colours, type and spacing from where the " +
    'tokens live, never a value of your own; one that holds binds, a proposed one is a suggestion):',
  proposed:
    '- **Proposed design choices** (suggestions, not binding yet: follow one unless the mission says otherwise, and say so under Assumptions when you do not):',
  prefer: '- **Prefer** (stack.md: a second library for one of these jobs is an owner question):',
  reuse: '- **Building blocks for reuse in these folders** (reuse.md: use them before you write a new helper):',
  shared:
    '- **Tagged for reuse in these folders** (`@shared` in the code, from the generated index: use them before you write a new helper):',
  near:
    '- **Near names** (V1b: a name the delivery defines is close to one the code exports elsewhere. Maybe the same helper ' +
    'written again, maybe a deliberate variant: weigh it with the code, it is no finding by itself):',
});

function decisionLine({ d, status }) {
  const shown = d.paths.slice(0, SHOWN_PATHS).join(', ') + (d.paths.length > SHOWN_PATHS ? ', ...' : '');
  const mark = status === 'unconfirmed' ? '; unconfirmed: it says accepted, but the owner has not accepted this version' : '';
  return `  - ${d.id} (${shown}${mark}): ${d.invariant.trim()}`;
}

/** A design entry's line: its status and where its tokens live, then the rule. */
function designLine({ d, status }) {
  const word = status === 'accepted' ? 'holds' : status === 'unconfirmed' ? 'unconfirmed: it says accepted, but the owner has not accepted this version' : 'proposed';
  const src = Array.isArray(d.source) ? d.source : typeof d.source === 'string' && d.source.trim() ? [d.source.trim()] : [];
  return `  - ${d.id} (${word}${src.length ? `; tokens in ${src.join(', ')}` : ''}): ${d.invariant.trim()}`;
}

const ITEM = {
  binding: decisionLine,
  design: designLine,
  proposed: decisionLine,
  prefer: (p) => `  - ${p.purpose}: ${p.use}`,
  reuse: (r) => `  - ${r.purpose}: \`${r.symbol}\` in \`${r.file}\``,
  shared: (r) => `  - ${r.purpose}: \`${r.symbol}\` in \`${r.file}\``,
  near: (n) => `  - \`${n.name}\` (new in \`${n.file}\`) is close to \`${n.other}\` in \`${n.otherFile}:${n.line}\` (${n.why})`,
};
/** The order the parts are shown in, and the order they get room under the cap (the last ones are cut first). */
const SHOWN = ['binding', 'design', 'near', 'proposed', 'prefer', 'reuse', 'shared'];
const ROOM = ['binding', 'design', 'near', 'prefer', 'proposed', 'reuse', 'shared'];

/** "nothing cut", or "cut: 2 binding choices, 4 reuse rows; `ravenseat catalog show` lists them all". */
function cutText(cut, cli) {
  const parts = [
    cut.binding && plural(cut.binding, 'binding choice'),
    cut.design && plural(cut.design, 'design rule'),
    cut.proposed && plural(cut.proposed, 'proposed choice'),
    cut.prefer && plural(cut.prefer, 'prefer line'),
    cut.reuse && plural(cut.reuse, 'reuse row'),
    cut.near && plural(cut.near, 'near name'),
    cut.shared && plural(cut.shared, 'tagged block'),
  ].filter(Boolean);
  return parts.length ? `cut: ${parts.join(', ')}; \`${cli} catalog show\` lists them all` : 'nothing cut';
}

/** The size and what was cut, the same words in both forms. */
function measure(tokens, cap, cut, cli, noFiles) {
  const what = noFiles ? 'the task names no files, so every choice that holds' : "chosen for this task's files";
  return `${what}; about ${tokens} of at most ${cap} tokens; ${cutText(cut, cli)}`;
}

function render(form, items, { tokens, cap, cut, cli, noFiles }) {
  const m = measure(tokens, cap, cut, cli, noFiles);
  const body = [];
  for (const kind of SHOWN) if (items[kind]?.length) body.push(SECTIONS[kind], ...items[kind].map(ITEM[kind]));
  if (form === 'review')
    return [
      '',
      '## From the project catalog',
      '',
      `What the track's mission had from \`${C.DIR}/\` (${m}). Check the delivery against it: a helper or rule written ` +
        'again where a reuse row, a prefer line or the reuse notes show one is `duplication`; a change that breaks the ' +
        'invariant of a choice that holds is `scope-drift`, MEDIUM at least (it was an owner question). A proposed choice ' +
        'binds nothing: not following it is no finding.' +
        (items.design?.length
          ? ' reviewer-design checks the UI against the Design language lines: a colour, size or font set by hand where ' +
            'a rule that holds says to take it from the tokens is `scope-drift`; against a proposed one it is a note.'
          : ''),
      '',
      ...body,
    ];
  return [
    `**From the project catalog** (\`${C.DIR}/\`, ${m}):`,
    ...body,
    `- Before you write a new helper, look for one: \`${cli} catalog find <word>\` searches the catalog and the code's ` +
      `exports (or \`git grep -n -w <name>\`); \`${cli} catalog show <D-id>\` prints a choice in full.`,
  ];
}

/** Render with the token count the text itself has (the number is part of the text, so settle it in a few rounds). */
function settle(form, items, o) {
  let tokens = 0;
  let lines = render(form, items, { ...o, tokens });
  for (let i = 0; i < 5; i++) {
    const t = tokensOf(lines.join('\n'));
    if (t === tokens) break;
    tokens = t;
    lines = render(form, items, { ...o, tokens });
  }
  return { lines, tokens: tokensOf(lines.join('\n')) };
}

/**
 * The excerpt for a task, or null when the catalog has nothing for it (or there is no catalog).
 * @param {object|null} cat readCatalog's result
 * @param {object} task the queue task (owned_files, shared_patch, reads)
 * @param {{ ledger?: object, capTokens?: number, form?: 'mission'|'review', cli?: string, glob?: Function,
 *   index?: object|null, near?: object[] }} [o] index: the generated index (bolk B5), null = none; near: the near names
 *   (V1b, lib/catalogIndex.js nearNames), shown in the review form only
 * @returns {{ lines: string[], tokens: number, cap: number, cut: { binding: number, proposed: number, prefer: number,
 *   reuse: number, near: number, shared: number }, counts: object } | null}
 */
function excerpt(cat, task, { ledger, capTokens = C.DEFAULTS.excerptTokens, form = 'mission', cli = 'ravenseat', glob, index = null, near = [] } = {}) {
  if (!cat?.exists && !index) return null;
  const chosen = choose(cat, task, { ledger, glob, index, near: form === 'review' ? near : [] });
  const all = {
    binding: chosen.binding,
    design: chosen.design,
    proposed: chosen.proposed,
    prefer: chosen.prefer,
    reuse: chosen.reuse,
    near: chosen.near,
    shared: chosen.shared,
  };
  if (!Object.values(all).some((l) => l.length)) return null;
  const cap = capTokens;
  const cut = { ...chosen.cut };
  const items = { binding: [], design: [], proposed: [], prefer: [], reuse: [], near: [], shared: [] };
  const o = { cap, cut, cli, noFiles: chosen.noFiles };
  // Greedy in priority order: an item goes in when the whole text still fits; one that does not is counted as cut,
  // and a shorter one after it may still fit.
  for (const kind of ROOM)
    for (const item of all[kind]) {
      items[kind].push(item);
      if (settle(form, items, o).tokens > cap) {
        items[kind].pop();
        cut[kind]++;
      }
    }
  const { lines, tokens } = settle(form, items, o);
  const counts = Object.fromEntries(Object.entries(items).map(([k, l]) => [k, l.length]));
  return { lines, tokens, cap, cut, counts };
}

/**
 * The excerpt for a task from the catalog on disk, or null: the setting for the form is off, there is no catalog, it
 * has nothing for the task, or anything fails (a mission is never lost over the excerpt).
 * @param {object} task
 * @param {{ which?: 'mission'|'review', root?: string, dataFolder?: string, config?: object, cli?: string,
 *   fsLike?: typeof import('node:fs'), newNames?: { name: string, file: string }[]|null }} [o] root: the tree whose
 *   docs/queue/catalog/ is read (default the main tree); dataFolder: where catalog-accepted.json and the index cache
 *   are (default the queue's data folder); config: queue.config.json as read; newNames: the names the delivery defines
 *   (lib/scopeNotes.js newNames), for the near names in the review form
 */
function forTask(task, { which = 'mission', root, dataFolder, config, cli, fsLike = fs, newNames = null } = {}) {
  try {
    const QC = require('./queueConfig.js');
    const k = config ?? QC.config();
    const setup = C.setupOf(k);
    if (which === 'review' ? !setup.reviewExcerpt : !setup.missionExcerpt) return null;
    const tree = root ?? k.root ?? QC.config().root;
    const cat = C.readCatalog(path.join(tree, ...C.DIR.split('/')), fsLike);
    // Without a catalog and without the index setting nothing is read or built: the mission stays byte for byte.
    if (!cat.exists && !setup.index) return null;
    const data = dataFolder ?? QC.dataFolder();
    let ledger = C.emptyLedger();
    try {
      ledger = C.parseLedger(fsLike.readFileSync(path.join(data, C.LEDGER_FILE), 'utf8'));
    } catch {
      // error-ignored: no record means nothing is accepted, never everything
    }
    // The generated index (bolk B5), built or refreshed from the cache; null when it is off or cannot be built.
    const CI = require('./catalogIndex.js');
    const index = setup.index ? (CI.refresh(tree, { dataFolder: data, fsLike })?.index ?? null) : null;
    const near = index && which === 'review' && Array.isArray(newNames) ? CI.nearNames(newNames, index) : [];
    return excerpt(cat, task, {
      ledger,
      capTokens: setup.excerptTokens,
      form: which === 'review' ? 'review' : 'mission',
      cli: cli ?? require('./projectRoot.js').cliCommand(),
      index,
      near,
    });
  } catch {
    // error-ignored: the excerpt is guidance; the mission and the package are made without it
    return null;
  }
}

/** The heading's token count in a mission text, or null (make-mission.mjs prints it per track). */
function tokensInMission(text) {
  const m = String(text ?? '').match(/^\*\*From the project catalog\*\* \([^\n]*?about (\d+) of at most (\d+) tokens/m);
  return m ? { tokens: Number(m[1]), cap: Number(m[2]) } : null;
}

module.exports = { MAX, CHARS_PER_TOKEN, scopeOf, choose, excerpt, forTask, tokensInMission };
