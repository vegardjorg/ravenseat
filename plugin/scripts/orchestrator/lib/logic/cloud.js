// =============================================================
// logic/cloud.js: queue tasks in cloud sessions on claude.ai.
//
// isCloud, cloudReferences, cloudSuitable (which tasks can run without local resources), the cloud package and bundles
// (cloudPackage, cloudBundleCap, cloudBundlePackage, cloudBundles), and cloudSessions, cloudStart, cloudDone, cloudCancel.
//
// Part of the queueLogic.js split: lib/queueLogic.js re-exports every name, so callers keep requiring queueLogic.js.
// Used by queueLogic.js (the facade) only.
// Tested in lib/__tests__/queueCloud.test.ts and queueRequires.test.ts (through queueLogic.js).
// =============================================================

const { cfg, baseBranch, remoteName, queueBranch, estimate, regexSafe } = require('./base.js');
const { hasLabel } = require('./projects.js');
const { norm, fileOverlap, blockerParts } = require('./conflicts.js');
const { pick, deliver, release } = require('./pick.js');
const { trackBlock } = require('./external.js');

// ---- Cloud: queue tasks in cloud sessions on claude.ai --------------------------------------------------------
// The cloud session only sees what is pushed to the remote and has no database. So only client/tool tasks
// (K, U) without migrations and DB are suitable, and only when the owned files are pushed. The orchestrator (or the owner from the board) sends
// the package; the cloud pushes the queue branch (<branchPrefix><id>, or claude/<id> where only that is allowed), ends it with a finish
// marker (cloudMarker), and the orchestrator receives and merges as usual: the gates run at home and the evidence is recorded there.

/** Who a cloud session appears as in `picked_by`. */
const CLOUD_BY = 'cloud';
/**
 * The default limit on concurrent cloud sessions (they do not count toward maxConcurrent). Not a vendor limit: none is documented,
 * but parallel sessions share the plan's usage limits. cloud.maxSessions in queue.config.json replaces it (cloudMax).
 */
const CLOUD_MAX = 3;
const CLOUD_CLASSES = new Set(['K', 'U']);
const CLOUD_CLOSED = new Map([
  ['db', 'needs the database (test runs against a database)'],
  ['web', 'needs the network (downloads or external sources; the cloud is behind a block)'],
  ['sources', 'needs local source collections or primary sources'],
  ['local-files', 'needs files that only exist locally (gitignored or untracked)'],
  ['unit', "needs the owner's device or a running app"],
]);

/** The limit in effect: cloud.maxSessions when it is a whole number above 0, otherwise CLOUD_MAX. */
function cloudMax() {
  const n = cfg().cloud?.maxSessions;
  return Number.isInteger(n) && n > 0 ? n : CLOUD_MAX;
}

/** Tasks in one session: cloud.bundleMax, otherwise the default. */
function cloudBundleMax() {
  const n = cfg().cloud?.bundleMax;
  return Number.isInteger(n) && n > 0 ? n : CLOUD_BUNDLE_MAX;
}

/** Is the task in a cloud session now? (picked by "cloud", with the cloud field set by `cloud start`) */
function isCloud(o) {
  return o?.status === 'picked' && o.picked_by === CLOUD_BY && !!o.cloud;
}

/**
 * The areas the cloud does not see (gitignored or untracked). The queue's dataFolder (scripts/.queue/) is always included; the folders in
 * config().cloudHidden (list of paths, e.g. 'docs/private/') are added.
 */
function cloudHidden() {
  const extra = Array.isArray(cfg().cloudHidden) ? cfg().cloudHidden : [];
  return [
    ...extra
      .map((s) => String(s).replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''))
      .filter(Boolean)
      .map((s) => ({
        pattern: new RegExp(`(^|/)${regexSafe(s)}(/|$)`),
        area: `${s}/`,
        boostable: true,
      })),
    { pattern: /(^|\/)scripts\/\.queue(\/|$)/, area: 'scripts/.queue/', boostable: false },
  ];
}
// A line that says the binding content is lifted into the mission (the template's "GITIGNORED; everything binding is lifted in here"),
// is a source reference, not something the cloud needs to read.
const BOOSTED_IN = /lifted in|everything binding/i;

/**
 * The references in the mission text to files the cloud does not see. The task's own mission file does not count (it is put
 * into the package). `boosted`: the line says the binding content is lifted in (does not apply to scripts/.queue/, where other
 * tasks' missions live).
 * @returns {{ path: string, area: string, boosted: boolean }[]} unique paths in order
 */
function cloudReferences(text, { id, ownPath } = {}) {
  const own = ownPath ? norm(ownPath).toLowerCase() : null;
  const hiddenOnes = cloudHidden();
  const out = [];
  const set = new Set();
  for (const line of String(text ?? '').split('\n')) {
    const boosted = BOOSTED_IN.test(line);
    for (const raw of line.replace(/\\/g, '/').split(/[\s`'"()<>[\]|,;\u00AB\u00BB*]+/)) {
      const filePath = raw.replace(/[.:]+$/, '');
      if (!filePath) continue;
      const match = hiddenOnes.find((u) => u.pattern.test(filePath));
      if (!match) continue;
      const low = filePath.toLowerCase();
      if (own && (low === own || low.endsWith(`/${own}`))) continue;
      if (id && match.area === 'scripts/.queue/' && low.endsWith(`/mission/${id.toLowerCase()}.md`))
        continue;
      if (set.has(filePath)) continue;
      set.add(filePath);
      out.push({ path: filePath, area: match.area, boosted: match.boostable && boosted });
    }
  }
  return out;
}

/**
 * Can the task run in a cloud session? Suitable when all of this holds:
 *   - class K or U, no migrations (migr_tens 0), empty owner_db and shared_patch
 *   - the mission does not point to folders the cloud does not see (config().cloudHidden, and scripts/.queue/ beyond its own file; a
 *     source reference on a line that says the binding content is lifted in is fine)
 *   - status waiting without open dependencies, owner questions or ownership collision (or already in a cloud session)
 *   - the owned files are not changed locally since <remote>/<baseBranch> (committed and not pushed, or uncommitted):
 *     otherwise the cloud builds on old code
 * @param {{ pushedHead?: string|null, changed?: string[], missionText?: string, ownPath?: string|null }} v
 *   `pushedHead`: the sha of <remote>/<baseBranch> (null: unknown, then it cannot be checked). `changed`: the paths that are
 *   changed locally since then. `missionText`: the mission itself (the file `mission` points to, or the text).
 * @returns {{ suitable: boolean, reasons: string[] }}
 */
function cloudSuitable(queue, id, { pushedHead = null, changed = [], missionText, ownPath = null } = {}) {
  const tasks = queue?.tasks ?? [];
  const o = tasks.find((x) => x.id === id);
  if (!o) return { suitable: false, reasons: [`unknown task ${id}`] };
  const reasons = [];
  if (!CLOUD_CLASSES.has(o.class)) reasons.push(`class ${o.class} (only K and U run in the cloud)`);
  if (Number(o.migr_tens ?? 0) > 0) reasons.push('has migrations (the cloud has no database)');
  // The label "not-cloud": a cloud session has tried and stopped because the task needs something only available locally (sources,
  // downloads, local files). Set by the orchestrator after CLOUD-STOP.
  for (const k of o.requires ?? []) if (CLOUD_CLOSED.has(k)) reasons.push(CLOUD_CLOSED.get(k));
  if (hasLabel(o, 'not-cloud'))
    reasons.push('marked not-cloud (needs something that only exists locally)');
  if ((o.owner_db ?? []).length) reasons.push(`owns DB functions: ${o.owner_db.join(', ')}`);
  if ((o.shared_patch ?? []).length) reasons.push(`shared patch: ${o.shared_patch.join(', ')}`);

  if (isCloud(o)) {
    // Already in a cloud session: the status is correct, and the blockers applied when it was started.
  } else if (o.status !== 'waiting') {
    reasons.push(
      o.status === 'picked' ? `picked by ${o.picked_by ?? '?'}` : `status ${o.status}`,
    );
  } else {
    for (const h of blockerParts(o, tasks, queue.resolved)) {
      if (h.type === 'depends_on') reasons.push(`open dependency: ${h.text}`);
      else if (h.type === 'question') reasons.push(`open owner question: ${h.sp}`);
      else reasons.push(h.text);
    }
  }

  const text = missionText ?? (String(o.mission ?? '').includes('\n') ? o.mission : '');
  // References to other tasks' missions (scripts/.queue/mission/<another>.md) are context, not binding content:
  // the package explains that the file does not exist in the cloud. They do not close.
  const hiddenOnes = cloudReferences(text, { id: o.id, ownPath }).filter(
    (r) => !r.boosted && r.area !== 'scripts/.queue/',
  );
  if (hiddenOnes.length)
    reasons.push(
      `the mission points to files the cloud does not see: ${hiddenOnes.map((r) => r.path).join(', ')}`,
    );

  if (!pushedHead)
    reasons.push(
      `did not find ${remoteName()}/${baseBranch()} (run git fetch ${remoteName()} ${baseBranch()})`,
    );
  else {
    const local = [];
    for (const f of o.owned_files ?? []) {
      const e = (changed ?? []).find((filePath) => fileOverlap(f, filePath));
      if (e) local.push(norm(e));
    }
    if (local.length)
      reasons.push(
        `owned files changed locally and not pushed: ${[...new Set(local)].slice(0, 5).join(', ')}` +
          ` (push ${baseBranch()} first)`,
      );
  }
  return { suitable: reasons.length === 0, reasons };
}

/** The general rules for a K or U track in the cloud, short. The project's own rules are in config().architectureRules. */
const CLOUD_RULES_COMMON = [
  'No migrations and no database: the cloud has no database. If you need it, CLOUD-STOP.',
  "Follow the project's CLAUDE.md; the rules below are the most important ones for the track.",
  'No personal data or secrets in logs, error messages or commits. No dev server or preview.',
  'Commit only the files you own (git add -- <files>); do not touch files outside the ownership list.',
];

/** The rules the cloud package brings along: the general ones and the project's architecture rules (config().architectureRules). */
function cloudRules() {
  const ownOnes = Array.isArray(cfg().architectureRules) ? cfg().architectureRules : [];
  return [...CLOUD_RULES_COMMON, ...ownOnes.map(String).filter((r) => r.trim())];
}

/** Bundle: at most this many tasks, and at most this many minutes of estimate in total, in one cloud session. */
const CLOUD_BUNDLE_MAX = 4;
const CLOUD_BUNDLE_MIN = 120;

/**
 * What the session runs before it pushes. The plugin is not installed in a cloud session, so the package names the
 * project's own commands (config().gates.quick) and never a ravenseat command. These runs help the session; the evidence is
 * the run at home (ravenseat receive), since agents do not grade their own homework.
 */
function cloudGates() {
  const quick = (Array.isArray(cfg().gates?.quick) ? cfg().gates.quick : [])
    .filter((g) => typeof g === 'string' && g.trim())
    .map((g) => `\`${g.trim()}\``);
  return (
    'install what the project needs (npm install in a Node project); the tests for the new/changed files; and at the end, before push, ' +
    `${quick.length ? `the project's quick gates: ${quick.join(', ')}` : 'whatever checks the project has'}. ` +
    'Ravenseat is not installed in this session, so do not look for its commands. These runs are for your own use: the ' +
    'orchestrator runs the gates again on your branch at home, and only that run counts as evidence. If a gate is red, fix it and ' +
    'run it again; if it is red because of something outside the task or an environment issue in the cloud, mention it in the report.'
  );
}
// npm install can rewrite package-lock.json; then the session must reset it itself.
const CLOUD_LOCK =
  'Do not commit package-lock.json unless the mission says so (npm install rewrites it; reset it before commit).';
const commitLine = (id) =>
  `Commit message: "<type>(<area>): <summary> (${id})" + line "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>".`;
/** The branches a cloud session may push to: the queue branch, and one fixed name where access rules only allow claude/. */
const cloudBranches = (id) => [queueBranch(id), `claude/${id}`];
const branchLine = (id, explanation = '') => {
  const r = remoteName();
  const b = baseBranch();
  const [branch, fallback] = cloudBranches(id);
  return (
    `Branch rule${explanation}: start from ${r}/${b} (git fetch ${r} ${b} && git checkout -b ${branch} ${r}/${b}). ` +
    `Push only branch ${branch} to ${r}. If the push to ${branch} is rejected by access rules, push the same commits to ` +
    `${fallback} instead, exactly that name: the orchestrator looks for those two branches. Never ${b}, never PR. ` +
    'The GitHub proxy rejects tags, branch deletions and gh pr or gh issue, so do not try them.'
  );
};
/**
 * The finish marker. Nothing at home can read a session's transcript, and a pushed branch alone does not say the work is
 * finished, so the last commit on the branch says it. `ravenseat cloud check` reads it (cloudMarker).
 */
const finishLine = (id) =>
  `Finish: nobody at home can read this session, so the last thing you do for the task is one more commit on the branch, and push it: ` +
  `git commit --allow-empty -m "CLOUD-DONE ${id}". If you cannot do the task: git commit --allow-empty -m "CLOUD-STOP ${id} <reason>" ` +
  'and push that, even with no other commits. Without this the orchestrator keeps waiting.';

/**
 * The finish marker in a commit message: a line that is exactly CLOUD-DONE <id> (a sha may follow) or CLOUD-STOP <id> <reason>.
 * A stop wins over a done in the same message. The reason comes from outside: control characters go, and it is cut short.
 * @returns {{ kind: 'done'|'stop', reason: string|null } | null}
 */
function cloudMarker(message, id) {
  const lines = String(message ?? '').split(/\r?\n/);
  const stop = new RegExp(`^CLOUD-STOP ${regexSafe(id)}(?:\\s+(.*))?$`);
  const done = new RegExp(`^CLOUD-DONE ${regexSafe(id)}(?:\\s+\\S+)?\\s*$`);
  for (const line of lines) {
    const m = stop.exec(line);
    if (m) {
      // eslint-disable-next-line no-control-regex
      const reason = String(m[1] ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim().slice(0, 200);
      return { kind: 'stop', reason: reason || null };
    }
  }
  return lines.some((line) => done.test(line)) ? { kind: 'done', reason: null } : null;
}

/** "Files the cloud does not see …" for all the parts in the package, or null. */
function hiddenLine(parts) {
  const paths = [
    ...new Set(
      parts.flatMap((d) =>
        cloudReferences(d.text, { id: d.o.id, ownPath: d.ownPath }).map((r) => r.path),
      ),
    ),
  ];
  return paths.length
    ? `Files the cloud does not see (gitignored or untracked): ${paths.join(', ')}. Everything binding is in the mission ` +
        'below; ignore these references.'
    : null;
}

/**
 * The cloud package: one self-contained message for a cloud session (claude --cloud, or a scheduled task's API trigger). A session has
 * no plugin, so everything it needs is in here. Structure: branch rule, gates, commit message, finish marker, files the cloud does not
 * see, rules, report format, and then the mission in full with the track block.
 * @param {{ text: string, ownPath?: string|null }} v the mission text (the file or the text itself)
 */
function cloudPackage(o, queue, { text, ownPath = null } = {}) {
  const id = o.id;
  const hidden = hiddenLine([{ o, text, ownPath }]);
  return [
    `# CLOUD TRACK ${id} (class ${o.class}, approx. ${estimate(o)} min)`,
    '',
    branchLine(id),
    `Gates in the cloud: ${cloudGates()}`,
    CLOUD_LOCK,
    commitLine(id),
    finishLine(id),
    ...(hidden ? [hidden] : []),
    '',
    'Rules (the ones that apply to this track):',
    ...cloudRules().map((r) => `- ${r}`),
    '',
    'Report: at most 20 lines (what, files, test result red first then green, gates, branch), last line ' +
      `"CLOUD-DONE ${id} <sha>" or "CLOUD-STOP ${id} <reason>".`,
    '',
    '## The mission',
    '',
    trackBlock(o, queue, { text, cloud: true }),
  ].join('\n');
}

/**
 * The cap for a bundle: at most CLOUD_BUNDLE_MAX tasks and CLOUD_BUNDLE_MIN minutes of estimate, and no id twice.
 * @param {object[]} tasks
 * @returns {string[]} the reasons (empty = within the cap)
 */
function cloudBundleCap(tasks, { max = cloudBundleMax(), maxMin = CLOUD_BUNDLE_MIN } = {}) {
  const reasons = [];
  const ids = tasks.map((o) => o.id);
  if (new Set(ids).size !== ids.length) reasons.push('the same task twice');
  if (tasks.length > max) reasons.push(`${tasks.length} tasks (at most ${max} in one bundle)`);
  const sum = tasks.reduce((s, o) => s + estimate(o), 0);
  if (sum > maxMin) reasons.push(`${sum} min estimate in total (at most approx. ${maxMin} in one bundle)`);
  return reasons;
}

/**
 * The cloud package for a bundle: several small tasks in one cloud session (the startup, clone + npm install + CLAUDE.md, costs the same
 * regardless of size). The missions are done one after another in the order given. Each gets its own queue branch made from
 * <remote>/<baseBranch> (never from the previous task's branch), its own commit, its own push and its own report line; a stop on one
 * does not hinder the next ones. The last line is CLOUD-BUNDLE-DONE <done>/<count>. One task gives the usual cloudPackage.
 * @param {{ o: object, text: string, ownPath?: string|null }[]} parts
 */
function cloudBundlePackage(parts, queue) {
  if (parts.length === 1) return cloudPackage(parts[0].o, queue, parts[0]);
  const n = parts.length;
  const ids = parts.map((d) => d.o.id);
  const sum = parts.reduce((s, d) => s + estimate(d.o), 0);
  const hidden = hiddenLine(parts);
  return [
    `# CLOUD BUNDLE ${ids.join(', ')} (${n} tasks, approx. ${sum} min)`,
    '',
    `Do the ${n} missions below one after another, in this order: ${ids.join(' → ')}. For EACH task:`,
    `- ${branchLine('<id>', ' (own branch per task)')} Make each branch from ${remoteName()}/${baseBranch()}, ` +
      'never from the previous ' +
      "task's branch, and do not bring along changes from an earlier task.",
    `- Own commit and own push. ${commitLine('<id>')}`,
    `- Gates for the task: ${cloudGates()}`,
    `- ${finishLine('<id>')}`,
    '- Report line right after the push: "CLOUD-DONE <id> <sha>", or "CLOUD-STOP <id> <reason>" when the task cannot ' +
      'be done. A stop does not hinder the next ones: move on to the next task.',
    CLOUD_LOCK,
    ...(hidden ? [hidden] : []),
    '',
    'Rules (the ones that apply to all tasks):',
    ...cloudRules().map((r) => `- ${r}`),
    '',
    'Report: at most 8 lines per task (what, files, test result red first then green, gates, branch), each ending ' +
      'with its report line. Last line of the whole report: ' +
      `"CLOUD-BUNDLE-DONE <count CLOUD-DONE>/${n}".`,
    '',
    ...parts.flatMap((d, i) => [
      '---',
      '',
      `# Task ${i + 1} of ${n}: ${d.o.id} (branch ${queueBranch(d.o.id)})`,
      '',
      trackBlock(d.o, queue, { text: d.text, cloud: true }),
    ]),
  ].join('\n');
}

/**
 * Proposed bundles (`queue.mjs cloud-bundles`): the cloud-suitable candidates grouped by project and feature (same area
 * one after another, so the context is reused), the groups by best priority, and within the group by priority. Then
 * the bundles are filled in that order as long as the cap holds; a task that alone is over the cap stands alone.
 * @param {{ id: string, project: string, feature?: string|null, estimate: number, score: number }[]} candidates
 * @returns {{ ids: string[], minutes: number, areas: string[] }[]}
 */
function cloudBundles(candidates, { max = cloudBundleMax(), maxMin = CLOUD_BUNDLE_MIN } = {}) {
  const groups = new Map();
  for (const k of candidates) {
    const area = `${k.project}${k.feature ? ` / ${k.feature}` : ''}`;
    if (!groups.has(area)) groups.set(area, []);
    groups.get(area).push({ ...k, area });
  }
  const afterScore = (a, b) => b.score - a.score || a.id.localeCompare(b.id);
  const sorted = [...groups.values()]
    .map((g) => g.sort(afterScore))
    .sort((a, b) => afterScore(a[0], b[0]))
    .flat();
  const bundles = [];
  let now = null;
  for (const k of sorted) {
    if (!now || now.ids.length >= max || now.minutes + k.estimate > maxMin) {
      now = { ids: [], minutes: 0, areas: [] };
      bundles.push(now);
    }
    now.ids.push(k.id);
    now.minutes += k.estimate;
    if (!now.areas.includes(k.area)) now.areas.push(k.area);
  }
  return bundles;
}

/** Number of cloud sessions running: tasks in the same session (same execution, or same bundle) count once. */
function cloudSessions(queue) {
  return new Set((queue.tasks ?? []).filter(isCloud).map((o) => o.cloud.execution ?? o.cloud.bundle ?? o.id))
    .size;
}

/**
 * `queue.mjs cloud start <id> [<id> …]`: picks tasks for one cloud session (picked_by "cloud", branch queue/<id>) and sets
 * `cloud: { started, execution?, bundle? }` (bundle = the ids when several run in the same session). All or nothing. Refuses when a
 * task is not suitable (`suitability` per id, computed by the caller with git), when the bundle is over the cap, or when cloudMax()
 * cloud sessions are already running; `force` overrides those three, and the pick's blockers. If a task is already in the cloud, only
 * the execution is set (the orchestrator got the session id after the owner pressed start).
 * @param {string|string[]} ids
 * @param {{ suitability?: Record<string, { suitable: boolean, reasons: string[] }>, execution?: string|null, force?: boolean,
 *   now?: string }} v
 * @returns {{ error: string } | { tasks: object[], newOnes: string[], left: string[], overridden: string[] }}
 */
function cloudStart(
  queue,
  ids,
  { suitability = {}, execution = null, force = false, now = new Date().toISOString() } = {},
) {
  const list = [].concat(ids);
  const tasks = [];
  for (const id of list) {
    const o = (queue.tasks ?? []).find((x) => x.id === id);
    if (!o) return { error: `unknown task ${id}` };
    tasks.push(o);
  }
  const newOnes = tasks.filter((o) => !isCloud(o));
  const left = tasks.filter((o) => isCloud(o));
  const overridden = [];
  const stop = (text) => {
    if (!force) return `${text} (--force overrides)`;
    overridden.push(text);
    return null;
  };
  for (const o of newOnes) {
    const e = suitability[o.id];
    if (e && !e.suitable) {
      const f = stop(`${o.id} is not suitable for the cloud: ${e.reasons.join(' · ')}`);
      if (f) return { error: f };
    }
  }
  const cap = cloudBundleCap(tasks);
  if (cap.length) {
    const f = stop(`the bundle is over the cap: ${cap.join(' · ')}`);
    if (f) return { error: f };
  }
  if (newOnes.length) {
    const sessions = cloudSessions(queue);
    const most = cloudMax();
    if (sessions >= most) {
      const f = stop(`${sessions} cloud sessions are already running (at most ${most})`);
      if (f) return { error: f };
    }
  }
  // pick changes the queue; check all before any is changed (the caller does not write the file on error, but keep it clean).
  for (const o of newOnes) {
    if (o.status !== 'waiting')
      return { error: `${o.id} cannot be started in the cloud: status ${o.status}` };
  }
  const bundle = list.length > 1 ? list.join(',') : null;
  for (const o of newOnes) {
    const p = pick(queue, o.id, { by: CLOUD_BY, force, now });
    if (p.error) return p;
    overridden.push(...p.overridden);
    o.cloud = { started: now, ...(execution ? { execution } : {}), ...(bundle ? { bundle } : {}) };
  }
  for (const o of left) if (execution) o.cloud.execution = execution;
  return {
    tasks,
    newOnes: newOnes.map((o) => o.id),
    left: left.map((o) => o.id),
    overridden,
  };
}

/**
 * `queue.mjs cloud done`: the cloud has pushed the branch (the caller has checked it with git). The task goes to review as with
 * `deliver`, with `cloud.done`, branch and the sha. The orchestrator merges.
 */
function cloudDone(queue, id, { branch, sha = null, now = new Date().toISOString() } = {}) {
  const o = (queue.tasks ?? []).find((x) => x.id === id);
  if (!o) return { error: `unknown task ${id}` };
  if (!isCloud(o))
    return {
      error: `${id} is not in a cloud session (status ${o.status}${o.picked_by ? `, picked by ${o.picked_by}` : ''})`,
    };
  const l = deliver(queue, id, now);
  if (l.error) return l;
  o.cloud = { ...o.cloud, done: now, branch: branch ?? queueBranch(id), ...(sha ? { sha } : {}) };
  return { task: o };
}

/** `queue.mjs cloud cancel` = release for a cloud session (branch and migration block kept, the cloud field is removed). */
function cloudCancel(queue, id, { commits = 0, now = new Date().toISOString() } = {}) {
  const o = (queue.tasks ?? []).find((x) => x.id === id);
  if (!o) return { error: `unknown task ${id}` };
  if (!isCloud(o)) return { error: `${id} is not in a cloud session (status ${o.status})` };
  const execution = o.cloud?.execution ?? null;
  const s = release(queue, id, { commits, now });
  if (s.error) return s;
  o.remarks = [...(o.remarks ?? []), `${now} cloud session aborted${execution ? ` (${execution})` : ''}`];
  return s;
}

module.exports = {
  CLOUD_BY,
  CLOUD_MAX,
  cloudMax,
  cloudMarker,
  cloudBranches,
  isCloud,
  cloudReferences,
  cloudSuitable,
  CLOUD_BUNDLE_MAX,
  CLOUD_BUNDLE_MIN,
  cloudPackage,
  cloudBundleCap,
  cloudBundleMax,
  cloudBundlePackage,
  cloudBundles,
  cloudSessions,
  cloudStart,
  cloudDone,
  cloudCancel,
};
