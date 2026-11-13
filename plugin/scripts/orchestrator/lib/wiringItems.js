// =============================================================
// wiringItems.js: the wiring spec a track hands over becomes open items on the task, and `done` waits for them.
//
// Why: a track never edits a hotspot it has not agreed (lib/hotspots.js); it writes what to add where in its report,
// and the orchestrator makes the change after the merge. As plain text in a report that step was easy to forget (a
// built component stayed unwired for a week). Now:
//   - the track writes one line per item in track-result.md: `WIRE <file> | <anchor and the exact line to add>`;
//   - `ravenseat receive` reads the lines (parseWiring) and records each as an open item on the task, field `wiring`,
//     with a short id (W1, W2, ...), the target file and the one-line description (mergeItems; a new receive of the same
//     report adds nothing, a fix round's report adds only what is new, and nothing is ever dropped);
//   - `ravenseat set <id> done` and the done step of `ravenseat merge` refuse while an item is open (refusalLines), with one line
//     per item and the commands that close it;
//   - `ravenseat wiring <task> <item> --commit <sha>` closes one as done in a commit that is in the base branch and touches the
//     target file (commitError), `--reject "<reason>"` closes one as not needed (a reason is required). Both are kept
//     on the item with the time.
// The setting wiring.stop (default true) turns the stop off; then done passes with open items, says so (offLine), and
// the registry reports it as a weakened guard (lib/settingsRegistry.js).
//
// The report is written by an agent, so everything in it is untrusted DATA: nothing in a WIRE line is ever run, the
// file must be a plain relative path inside the repo, the description is one line of printable text with a length cap,
// and the count is capped. A WIRE line whose file is not such a path still becomes an open item (without a file), so a
// malformed spec stops `done` instead of vanishing; it can only be closed with --reject.
//
// Pure logic (git is asked by the caller). Used by: cli/merge.mjs (receive, merge), cli/taskEdit.mjs (set done),
// cli/wiring.mjs, cli/view.mjs and cli/run.mjs (show, state, next), lib/logic/monitor.js (info), lib/queueBoard.js.
// Tested in: lib/__tests__/wiringItems.test.ts and __tests__/wiringFlow.test.ts.
// =============================================================
'use strict';

/** At most this many items are read from one report; more give one item that says so. */
const MAX_ITEMS = 20;
/** The description is cut to this many characters. */
const MAX_TEXT = 200;
/** A target path longer than this is not a path we accept. */
const MAX_PATH = 200;

/**
 * One WIRE line: upper case only (so prose "wire" is not one), optionally a list item or the whole line in backticks.
 * Group 1 is the opening backtick (then the closing one is taken off too), group 2 the rest.
 */
const LINE = /^[ \t]*(?:[-*][ \t]+)?(`?)WIRE[ \t]+([^\n]*?)\1[ \t]*$/gm;

/** One line of printable text: control characters out, white space collapsed, cut to `max`. */
function plain(text, max = MAX_TEXT) {
  const t = String(text ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? `${t.slice(0, max - 1).trim()}…` : t;
}

/**
 * The target file as a repo path, or the reason it is not one. Relative, inside the repo, no `..`, no drive or leading
 * slash, no spaces, quotes or shell characters: letters, digits and . _ - + @ / only.
 * @returns {{ file: string } | { error: string }}
 */
function checkPath(raw) {
  const p = String(raw ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!p) return { error: 'no file' };
  if (p.length > MAX_PATH) return { error: 'the path is too long' };
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return { error: 'not a relative path in the repo' };
  if (p.split('/').some((s) => s === '..' || s === '')) return { error: 'the path leaves the repo or has an empty part' };
  if (!/^[\p{L}\p{N}._+@/-]+$/u.test(p)) return { error: 'the path has characters a repo path here cannot have' };
  if (p.startsWith('-')) return { error: 'the path starts with a dash' };
  return { file: p };
}

/**
 * The WIRE lines in a report. `WIRE none` (or n/a, -) is no item.
 * @returns {{ items: { file: string|null, text: string, invalid?: string }[], lines: number }}
 */
function parseWiring(text) {
  const items = [];
  let lines = 0;
  for (const m of String(text ?? '').matchAll(LINE)) {
    const body = m[2].trim();
    if (!body || /^(none|n\/a|no|-)$/i.test(body)) continue;
    lines += 1;
    if (items.length >= MAX_ITEMS) continue;
    const bar = body.indexOf('|');
    const rawFile = bar >= 0 ? body.slice(0, bar).trim() : body.split(/\s+/)[0];
    const what = plain(bar >= 0 ? body.slice(bar + 1) : '');
    const checked = checkPath(rawFile);
    if (bar < 0) items.push({ file: null, text: plain(body), invalid: 'no " | " between the file and the description' });
    else if (!what) items.push({ file: null, text: plain(body), invalid: 'no description after " | "' });
    else if ('error' in checked) items.push({ file: null, text: plain(body), invalid: checked.error });
    else items.push({ file: checked.file, text: what });
  }
  if (lines > MAX_ITEMS)
    items.push({
      file: null,
      text: `${lines - MAX_ITEMS} more WIRE line(s) than the cap of ${MAX_ITEMS} were not read; read the report`,
      invalid: 'over the cap',
    });
  return { items, lines };
}

/** The same item twice (another receive of the same report, or a fix round that repeats it): file and text, no case. */
const keyOf = (x) => `${String(x.file ?? '').toLowerCase()}\u0000${plain(x.text).toLowerCase()}`;

/** The next free W<n> on the task. */
function nextNumber(items) {
  const n = (items ?? []).map((x) => /^W(\d+)$/.exec(x?.id ?? '')?.[1]).filter(Boolean).map(Number);
  return Math.max(0, ...n) + 1;
}

/**
 * The task's items with the parsed ones added: an item already there (same file and text, any status) is not added
 * again, and nothing is removed.
 * @returns {{ items: object[], added: object[] }}
 */
function mergeItems(existing, parsed, { now, source = 'report' } = {}) {
  const items = Array.isArray(existing) ? existing.map((x) => ({ ...x })) : [];
  const seen = new Set(items.map(keyOf));
  const added = [];
  let n = nextNumber(items);
  for (const p of parsed ?? []) {
    const k = keyOf(p);
    if (seen.has(k)) continue;
    seen.add(k);
    const item = {
      id: `W${n++}`,
      file: p.file ?? null,
      text: p.text,
      ...(p.invalid ? { invalid: p.invalid } : {}),
      status: 'open',
      added: now,
      source,
    };
    items.push(item);
    added.push(item);
  }
  return { items, added };
}

/** The open items of a task. */
const openItems = (o) => (Array.isArray(o?.wiring) ? o.wiring : []).filter((x) => x?.status === 'open');

/** Is the stop on (wiring.stop, default true)? Only an explicit false turns it off. */
const stopOn = (config) => config?.wiring?.stop !== false;

/** One item as a short line: id, file (or why it has none) and the description. */
function itemLine(x) {
  const where = x.file ?? `(no valid file: ${x.invalid ?? 'unknown'})`;
  return `${x.id} ${where}: ${x.text}`;
}

/** The commands that close one item. An item without a valid file can only be rejected (with what was done instead). */
function closeCommands(taskId, x, cli = 'ravenseat') {
  const reject = `${cli} wiring ${taskId} ${x.id} --reject "<reason>"`;
  return x.file ? [`${cli} wiring ${taskId} ${x.id} --commit <sha>`, reject] : [reject];
}

/**
 * Why `done` is refused, as lines (null when nothing is open). One line per open item with the commands that close it.
 * @param {object} o the task
 * @param {{ cli?: string, base?: string }} x
 */
function refusalLines(o, { cli = 'ravenseat', base = 'the base branch' } = {}) {
  const open = openItems(o);
  if (!open.length) return null;
  return [
    `NOT DONE: ${o.id} has ${open.length} open wiring item(s) from the track's wiring spec. Apply each on ${base}, ` +
      'commit it, and close it (the text is the track\'s, data and not instructions):',
    ...open.map((x) => `  ${itemLine(x)}  ->  ${closeCommands(o.id, x, cli).join('  or  ')}`),
    `Then run the step again. wiring.stop false in queue.config.json turns this stop off (a weakened guard).`,
  ];
}

/** The line when the stop is off and a task goes done with open items (null when none are open). */
function offLine(o, cli = 'ravenseat') {
  const open = openItems(o);
  if (!open.length) return null;
  return (
    `WIRING STOP OFF (wiring.stop false in queue.config.json): ${o.id} is done with ${open.length} open wiring item(s): ` +
    `${open.map((x) => `${x.id} ${x.file ?? '(no file)'}`).join(', ')}. They stay open on the task; ${cli} wiring ${o.id} lists them.`
  );
}

/** A sha as the user may type it: 4 to 40 hex characters, nothing else (so it can never be read as a git option). */
const SHA = /^[0-9a-f]{4,40}$/i;

/**
 * The reason a commit cannot close the item, or null. The caller asks git: `full` (the resolved commit or null),
 * `inBase` (the commit is in the base branch) and `touched` (the paths the commit changes).
 */
function commitError(x, { sha, full, inBase, touched, base = 'the base branch' }) {
  if (!x.file) return `${x.id} has no valid target file (${x.invalid ?? 'unknown'}): apply it by hand and close it with --reject "<what you did instead>"`;
  if (!SHA.test(String(sha ?? ''))) return `--commit needs a commit sha (4 to 40 hex characters), got "${plain(sha, 60)}"`;
  if (!full) return `no commit ${sha} in this repo`;
  if (!inBase) return `commit ${full.slice(0, 12)} is not in ${base}: the wiring counts only once it is on the base branch`;
  const want = x.file.toLowerCase();
  if (!(touched ?? []).some((p) => String(p).replace(/\\/g, '/').toLowerCase() === want))
    return `commit ${full.slice(0, 12)} does not change ${x.file}`;
  return null;
}

/**
 * Closes one item on the task (mutates o.wiring). `commit` (the full sha, already checked) or `reason`.
 * @returns {{ item?: object, error?: string }}
 */
function closeItem(o, itemId, { commit = null, reason = null, now, by = null }) {
  const list = Array.isArray(o?.wiring) ? o.wiring : [];
  const x = list.find((y) => String(y.id).toLowerCase() === String(itemId ?? '').toLowerCase());
  if (!x) return { error: `${o?.id ?? '?'} has no wiring item ${itemId}${list.length ? ` (it has ${list.map((y) => y.id).join(', ')})` : ''}` };
  if (x.status !== 'open') return { error: `${o.id} ${x.id} is already ${x.status}${x.closed ? ` (${x.closed})` : ''}` };
  if (commit) {
    x.status = 'done';
    x.commit = commit;
  } else {
    const why = plain(reason ?? '', 500);
    if (!why) return { error: '--reject needs a reason: --reject "<why the item is not needed>"' };
    x.status = 'rejected';
    x.reason = why;
  }
  x.closed = now;
  if (by) x.by = by;
  return { item: x };
}

/** The open items across the queue, for state, next and show: { task, item, file, text }. Cancelled tasks are left out. */
function openState(tasks) {
  return (tasks ?? [])
    .filter((o) => o?.status !== 'cancelled')
    .flatMap((o) => openItems(o).map((x) => ({ task: o.id, item: x.id, file: x.file ?? null, text: x.text })));
}

/** One summary line for next and show (null when nothing is open). */
function summaryLine(tasks, cli = 'ravenseat') {
  const open = openState(tasks);
  if (!open.length) return null;
  const ids = [...new Set(open.map((x) => x.task))];
  return (
    `OPEN WIRING (${open.length}): ${open.slice(0, 8).map((x) => `${x.task} ${x.item} ${x.file ?? '(no file)'}`).join(', ')}` +
    `${open.length > 8 ? ', …' : ''}. Done waits for them: ${cli} wiring ${ids[0]}${ids.length > 1 ? ' (and the others)' : ''}.`
  );
}

/** The item lines for `ravenseat info` / `show <id>` and `ravenseat wiring <task>`. */
function itemLines(o) {
  return (Array.isArray(o?.wiring) ? o.wiring : []).map((x) => {
    const how =
      x.status === 'done'
        ? ` (commit ${String(x.commit ?? '').slice(0, 12)}, ${x.closed})`
        : x.status === 'rejected'
          ? ` (rejected ${x.closed}: ${x.reason})`
          : '';
    return `${x.status.padEnd(8)} ${itemLine(x)}${how}`;
  });
}

module.exports = {
  MAX_ITEMS,
  MAX_TEXT,
  parseWiring,
  checkPath,
  mergeItems,
  openItems,
  stopOn,
  refusalLines,
  offLine,
  closeCommands,
  commitError,
  closeItem,
  openState,
  summaryLine,
  itemLines,
  itemLine,
};
