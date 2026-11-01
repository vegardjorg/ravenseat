// =============================================================
// cli/cloud.mjs: the commands that compare with the remote: cloud, cloud-package, cloud-bundles and external.
//
// cloud* say which tasks suit a cloud session (and package them), from <remote>/<baseBranch> and the local changes.
// external scans the base branch for changes made outside the queue (and accept/add/done for them).
//
// Why a module: queue.mjs was one file of about 6,300 lines. It is now a thin entry point (the usage comment and the
// dispatch on the command word) plus the modules in cli/. The code was moved as it was: same output, exit codes and files.
//
// Used by: queue.mjs (dispatch).
// Tested in: lib/__tests__/queueCloud.test.ts, queueFeatures.test.ts, queueExternal.test.ts.
// =============================================================

import fs from 'node:fs';

import {
  a, BASE, branchFor, branchInfo, CQ, cut, die, edit, G, git, gitRead, L, missionFile, positional, PREFIX, read, REMOTE,
  uncommittedPaths, val, values, WIDTH,
} from './context.mjs';
import { logTime, minutes } from './tracks.mjs';

// ---- queue.mjs cloud: suitability with git --------------------------------------------------------------------
/** <remote>/<baseBranch> and the paths changed locally since it (committed and not pushed, plus uncommitted). */
function cloudContext() {
  const pushedHead =
    gitRead(['rev-parse', '-q', '--verify', `refs/remotes/${REMOTE}/${BASE}`])?.trim() || null;
  const changed = new Set();
  if (pushedHead) {
    const diff = gitRead(['diff', '--name-only', `refs/remotes/${REMOTE}/${BASE}...${BASE}`]);
    for (const s of String(diff ?? '').split('\n')) if (s.trim()) changed.add(s.trim());
  }
  for (const s of uncommittedPaths()) changed.add(s);
  return { pushedHead, changed: [...changed] };
}
/** The mission text and the suitability for one task. */
function cloudAssess(queue, o, context = cloudContext()) {
  const file = missionFile(o);
  const text = file ? fs.readFileSync(file, 'utf8') : String(o.mission ?? '');
  const ownPath = file ? String(o.mission) : null;
  const suitability = L.cloudSuitable(queue, o.id, { ...context, missionText: text, ownPath });
  return { text, ownPath, suitability };
}
// ---- queue.mjs external: scanning (read-only) ---------------------------------------------------------------------
function externalWindow(queue) {
  if (a.includes('--all')) {
    const times = queue.tasks
      .filter((o) => !L.isExternalRow(o) && L.COLLISION_STATUSES.includes(o.status))
      .map((o) => Date.parse(o.added_at ?? ''))
      .filter(Number.isFinite);
    const ms = times.length ? Math.min(...times) : Date.now() - 86_400_000;
    return {
      window: { since: new Date(ms).toISOString() },
      text: 'since the oldest task in progress was added',
    };
  }
  const s = val('--since');
  if (s) {
    const m = /^(\d+)\s*([hd])$/i.exec(s);
    if (m) {
      const ms = Number(m[1]) * (m[2].toLowerCase() === 'h' ? 3_600_000 : 86_400_000);
      return { window: { since: new Date(Date.now() - ms).toISOString() }, text: `last ${s}` };
    }
    if (/^\d{4}-\d{2}-\d{2}/.test(s) && Number.isFinite(Date.parse(s)))
      return { window: { since: new Date(Date.parse(s)).toISOString() }, text: `since ${s}` };
    return { window: { from: s }, text: `${s}..${BASE}` };
  }
  if (gitRead(['rev-parse', '-q', '--verify', `refs/remotes/${REMOTE}/${BASE}`]) != null)
    return {
      window: { from: `${REMOTE}/${BASE}` },
      text: `not pushed (${REMOTE}/${BASE}..${BASE})`,
    };
  return {
    window: { since: new Date(Date.now() - 86_400_000).toISOString() },
    text: `last 24 h (could not find ${REMOTE}/${BASE})`,
  };
}
function externalScan() {
  const queue = read();
  // --id <id>: only that one task, with the window from when it was added (the same check start/pick/trackFile do).
  const onlyId = val('--id');
  if (onlyId) {
    const o = queue.tasks.find((x) => x.id === onlyId);
    if (!o) die(`Unknown task ${onlyId}`);
    const v = G.externalForTasks(gitRead, [{ ...o, status: 'waiting' }]).get(onlyId);
    for (const f of v.error) console.log(`WARNING: ${f}`);
    console.log(
      `${onlyId} (${o.status}), added ${o.added_at ?? '?'}: ${v.collisions.length} collision(s), ` +
        `${v.mentioned.length} commit(s) outside the queue that mention the id.`,
    );
    for (const k of v.collisions) console.log(`  ${L.collisionText(k, { withId: false })}`);
    for (const c of v.mentioned)
      console.log(
        `  mentioned in ${c.summary} "${c.subject}"${o.status === 'waiting' ? ` -> completed? cq external accept ${onlyId} ${c.summary}` : ''}`,
      );
    if (!v.collisions.length && !v.mentioned.length)
      console.log('  Nothing outside the queue affects it.');
    return;
  }
  const { window, text } = externalWindow(queue);
  const b = G.externalImage(gitRead, queue, { window });
  if (a.includes('--json')) {
    // Without the message texts (long); subject, files and source are enough.
    const without = (c) => ({
      ...c,
      message: undefined,
      side: (c.side ?? []).map((s) => ({ sha: s.sha, subject: s.subject, source: s.source })),
    });
    console.log(
      JSON.stringify(
        { window: text, ...b, commits: b.commits.map(without), externalOnes: b.externalOnes.map(without) },
        null,
        2,
      ),
    );
    return;
  }
  const max = Number(val('--max') ?? 20) || 20;
  const date = (d) =>
    String(d ?? '')
      .slice(0, 16)
      .replace('T', ' ');
  const fileText = (files, n = 6) =>
    files.length
      ? `${files.slice(0, n).join(', ')}${files.length > n ? ` (+${files.length - n})` : ''}`
      : '(no files)';
  const out = [`Work outside the queue (window: ${text}):`];
  for (const f of b.error) out.push(`WARNING: ${f}`);

  // (a) Commits on baseBranch that do not come from the queue.
  const countOf = (k) => b.commits.filter((c) => c.source === k).length;
  out.push('');
  out.push(
    `(a) Commits on ${BASE} that do not come from the queue: ${b.externalOnes.length} ` +
      `(of ${b.commits.length} on the first-parent line; ${countOf('queue')} from the queue, ${countOf('orchestrator')} from the orchestrator)`,
  );
  const perSha = new Map();
  for (const s of b.consistency) perSha.set(s.sha, [...(perSha.get(s.sha) ?? []), s]);
  for (const c of b.externalOnes.slice(0, max)) {
    out.push(`  ${c.summary}  ${date(c.date)}  ${cut(c.subject, WIDTH - 30)}`);
    out.push(`            files: ${cut(fileText(c.files), WIDTH - 19)}`);
    const side = (c.side ?? []).filter((s) => s.source === 'external');
    if (side.length) out.push(`            merge that brings in ${side.length} commit(s) outside the queue`);
    const mentions = perSha.get(c.sha) ?? [];
    if (mentions.length)
      out.push(`            mentions: ${mentions.map((s) => `${s.id} (${s.status})`).join(', ')}`);
  }
  if (b.externalOnes.length > max) out.push(`  ... and ${b.externalOnes.length - max} older (--max N)`);

  // (b) Branches and worktrees outside the queue branches.
  out.push('');
  out.push(
    `(b) Branches and worktrees outside ${PREFIX}* with commits that are not in ${BASE}: ${b.branches.length}`,
  );
  for (const g of b.branches) {
    out.push(
      `  ${g.name}  ${g.count} commit(s)${g.last ? `, last ${date(g.last)}` : ''}${g.worktree ? `  worktree ${g.worktree}` : ''}`,
    );
    out.push(`            files: ${cut(fileText(g.files), WIDTH - 19)}`);
  }

  // (c) Uncommitted in the main tree.
  const theTrack = b.uncommitted.filter((u) => !u.untracked);
  const untracked = b.uncommitted.filter((u) => u.untracked);
  out.push('');
  out.push(
    `(c) Uncommitted in the main tree: ${theTrack.length} changed, ${untracked.length} untracked${untracked.length && !a.includes('--untracked') ? ' (--untracked shows them)' : ''}`,
  );
  for (const u of [...theTrack, ...(a.includes('--untracked') ? untracked : [])].slice(0, 40))
    out.push(`  ${u.xy.trim().padEnd(2)} ${u.path}`);

  // Registered outside the queue, and tasks without a project or feature.
  out.push('');
  out.push(`Registered outside the queue (external add): ${b.registered.length || 'none'}`);
  for (const o of b.registered)
    out.push(
      cut(
        `  ${o.id}  "${o.external_name}"  ${[...(o.owned_files ?? []), ...(o.owner_db ?? [])].join(', ')}${o.branch ? `  branch ${o.branch}` : ''}`,
        WIDTH,
      ),
    );
  const { withoutProject, withoutFeature } = b.missing;
  // Tasks added without a project or feature (e.g. by another session without /add-to-queue).
  const idText = (ids) => `${ids.slice(0, 8).join(', ')}${ids.length > 8 ? ' ...' : ''}`;
  const missing = [
    withoutProject.length ? `without project ${withoutProject.length} (${idText(withoutProject)})` : null,
    withoutFeature.length ? `without feature ${withoutFeature.length} (${idText(withoutFeature)})` : null,
  ].filter(Boolean);
  if (missing.length) {
    out.push(cut(`Tasks in progress ${missing.join('; ')}.`, WIDTH));
    out.push('  Fix with cq edit-many --file <json> ([{ "id", "project", "feature" }]).');
  }

  // Collisions and consistency.
  out.push('');
  out.push(
    `Collisions with the owned files (running, picked, in review, pending): ${b.collisions.length}`,
  );
  for (const k of b.collisions.slice(0, 30))
    out.push(
      cut(`  ${L.collisionText(k).replace(`${k.id}: `, `${k.id} (${k.status}): `)}`, WIDTH),
    );
  if (b.collisions.length > 30) out.push(`  ... and ${b.collisions.length - 30} more (--json)`);
  const proposed = b.consistency.filter((s) => s.proposed);
  if (proposed.length) {
    out.push('');
    out.push(
      'Consistency: external commits mention pending tasks. Are they completed? Accept only after looking at the commit:',
    );
    for (const s of proposed) out.push(cut(`  ${s.proposed}   "${s.subject}"`, WIDTH));
  }
  console.log(out.join('\n'));
}

/** `cq external` (the usage is at the top of queue.mjs). */
export function cmdExternal() {
  // ---- Work outside the queue ----
  const under = a[1] && !a[1].startsWith('--') ? a[1] : null;
  if (!under) externalScan();
  else if (under === 'add') {
    const name = val('--name');
    const r = edit((queue) => {
      const s = L.externalAdd(queue, {
        name,
        files: values('--files'),
        db: values('--db'),
        branch: val('--branch') ?? null,
      });
      if (s.error) die(s.error);
      return s;
    });
    const owner = [...r.row.owned_files, ...r.row.owner_db].join(', ');
    console.log(
      `${r.new ? 'Registered' : 'Updated'} ${r.row.id} ("${r.row.external_name}"${r.row.branch ? `, branch ${r.row.branch}` : ''}): ` +
        `owns ${owner}. The queue starts nothing that collides until: cq external done "${r.row.external_name}"`,
    );
    for (const x of r.warnings) console.log(`WARNING: ${x}`);
  } else if (under === 'done') {
    const [name] = positional(2);
    const r = edit((queue) => {
      const s = L.externalDone(queue, name);
      if (s.error) die(s.error);
      return s;
    });
    console.log(
      `${r.row.id} ("${r.row.external_name}"): done. The files are free for the queue again. If the work is committed on ${BASE}, ` +
        'cq external shows whether it mentions pending tasks.',
    );
  } else if (under === 'accept') {
    const [id, ref] = positional(2);
    if (!id || !ref) die('external accept <id> <sha>');
    const full = String(gitRead(['rev-parse', '-q', '--verify', `${ref}^{commit}`]) ?? '').trim();
    if (!full) die(`Could not find commit ${ref}.`);
    // Only what is on baseBranch can count as completed (a branch outside the queue is not delivered yet).
    if (gitRead(['merge-base', '--is-ancestor', full, BASE]) == null)
      die(`${ref} is not on ${BASE} (merge it first, or wait).`);
    const message = gitRead(['log', '-1', '--format=%B', full]) ?? '';
    const mentioned = L.mentionedIds(message, [id]).length > 0;
    const r = edit((queue) => {
      const s = L.externalAccept(queue, id, full, { mentioned });
      if (s.error) die(s.error);
      return s;
    });
    console.log(
      `${id}: done (completed outside the queue in ${full.slice(0, 8)})` +
        `${r.qa ? ' · label visual: now in the owner QA list (cq qa)' : ''}` +
        `${mentioned ? '' : ' · NB: the commit message does not mention the id (noted in the remark)'}`,
    );
  } else {
    die(
      'external [--since ...] [--all] | external accept <id> <sha> | external add --name "<session>" --files <...> [--branch <g>] | ' +
        'external done "<name>"',
    );
  }
}

/** `cq cloud-package` (the usage is at the top of queue.mjs). */
export function cmdCloudPackage() {
  // ---- Cloud: the package for the routine "queue-cloud" or to paste into a cloud session ----
  // One id, or a bundle of at most 4 (total estimate <= about 120 min) done one after the other in the same cloud session.
  const ids = positional(1, ['--out']);
  if (!ids.length) die('cloud-package <id> [<id> ...] [--out <file>] [--force]');
  const queue = read();
  const context = cloudContext();
  const parts = ids.map((id) => {
    const o = queue.tasks.find((x) => x.id === id);
    if (!o) die(`Unknown task ${id}`);
    return { o, ...cloudAssess(queue, o, context) };
  });
  const reasons = [
    ...parts.flatMap((d) => d.suitability.reasons.map((g) => `${d.o.id}: ${g}`)),
    ...L.cloudBundleCap(parts.map((d) => d.o)).map((g) => `bundle: ${g}`),
  ];
  if (reasons.length) {
    const text = reasons.join('\n  ');
    if (!a.includes('--force'))
      die(`Not suitable for the cloud:\n  ${text}\n(--force makes the package anyway)`);
    // To stderr, so the package on stdout is clean (the board copies it).
    console.error(`WARNING: not suitable for the cloud (--force):\n  ${text}`);
  }
  const pkg = L.cloudBundlePackage(parts, queue);
  const out = val('--out');
  if (out) {
    fs.writeFileSync(out, `${pkg}\n`);
    console.log(
      `Wrote the cloud package for ${ids.join(', ')} to ${out} (${pkg.length} chars). Start: RemoteTrigger run with ` +
        `{ "text": <the package> }, then cq cloud start ${ids.join(' ')} --run <session-id>.`,
    );
  } else process.stdout.write(`${pkg}\n`);
}

/** `cq cloud-bundles` (the usage is at the top of queue.mjs). */
export function cmdCloudBundles() {
  // Proposals for bundles of cloud-suitable tasks (the same project/feature one after the other), by priority.
  const max = Number(val('--max') ?? L.CLOUD_BUNDLE_MAX);
  const maxMin = Number(val('--max-min') ?? L.CLOUD_BUNDLE_MIN);
  if (!(max >= 1) || !(maxMin > 0)) die('--max and --max-min must be numbers above 0');
  const queue = read();
  const context = cloudContext();
  const register = queue.projects ?? {};
  const candidates = queue.tasks
    .filter((o) => o.status === 'waiting' && cloudAssess(queue, o, context).suitability.suitable)
    .map((o) => ({
      id: o.id,
      project: L.projectFor(o, register),
      feature: o.feature ?? null,
      estimate: L.estimate(o),
      score: L.score(o, queue.tasks, Date.now(), register),
    }));
  const bundles = L.cloudBundles(candidates, { max, maxMin });
  // --json: machine-readable for queueBoard (the "Cloud" view), with a ready command for cloud-start.mjs per bundle.
  if (a.includes('--json')) {
    const titleJ = new Map(queue.tasks.map((o) => [o.id, o.title ?? '']));
    console.log(
      JSON.stringify({
        bundles: bundles.map((b) => ({
          ids: b.ids,
          minutes: b.minutes,
          areas: b.areas,
          titles: Object.fromEntries(b.ids.map((id) => [id, titleJ.get(id)])),
          command: `${CQ} cloud-start ${b.ids.join(' ')}`,
        })),
        sessions: L.cloudSessions(queue),
        max: L.CLOUD_MAX,
        pushed: Boolean(context.pushedHead),
      }),
    );
    process.exit(0);
  }
  if (!bundles.length)
    console.log(
      `No cloud-suitable tasks now${context.pushedHead ? '' : ` (could not find ${REMOTE}/${BASE})`}.`,
    );
  const title = new Map(queue.tasks.map((o) => [o.id, o.title ?? '']));
  bundles.forEach((b, i) => {
    console.log(
      `Bundle ${i + 1}: ${b.ids.length} task(s), ${b.minutes} min · ${b.areas.join(' + ')}`,
    );
    for (const id of b.ids) console.log(cut(`  ${id.padEnd(12)} ${title.get(id)}`, WIDTH));
    console.log(`  → cq cloud-package ${b.ids.join(' ')} --out <file>`);
  });
  const sessions = L.cloudSessions(queue);
  if (bundles.length) console.log(`\n${sessions} cloud session(s) running now (at most ${L.CLOUD_MAX}).`);
}

/** `cq cloud` (the usage is at the top of queue.mjs). */
export function cmdCloud() {
  const [under, id, ...more] = positional(1, ['--run', '--sha', '--branch']);
  const force = a.includes('--force');
  if (!under) {
    // Overview: the cloud sessions running, and the pending ones that are suitable.
    const queue = read();
    const inCloud = queue.tasks.filter(L.isCloud);
    console.log(`Cloud sessions (${inCloud.length} of at most ${L.CLOUD_MAX}):`);
    if (!inCloud.length) console.log('  none');
    for (const o of inCloud)
      console.log(
        cut(
          `  ${o.id.padEnd(12)} started ${L.ageText(Date.now() - Date.parse(o.cloud.started))} ago` +
            `${o.cloud.execution ? ` · ${o.cloud.execution}` : ''}  ${o.title ?? ''}`,
          WIDTH,
        ),
      );
    const k = cloudContext();
    const suitable = queue.tasks
      .filter((o) => o.status === 'waiting')
      .filter((o) => cloudAssess(queue, o, k).suitability.suitable)
      .map((o) => ({ o, score: L.score(o, queue.tasks, Date.now(), queue.projects ?? {}) }))
      .sort((x, y) => y.score - x.score || x.o.id.localeCompare(y.o.id));
    console.log(
      `\nSuitable for the cloud now: ${suitable.length}${k.pushedHead ? '' : ` (could not find ${REMOTE}/${BASE})`}`,
    );
    for (const { o } of suitable.slice(0, 15))
      console.log(
        cut(
          `  ${o.id.padEnd(12)} ${o.class.padEnd(2)} ${`${L.estimate(o)} min`.padEnd(7)} ${o.title ?? ''}`,
          WIDTH,
        ),
      );
    if (suitable.length > 15) console.log(`  ... and ${suitable.length - 15} more`);
    if (suitable.length) console.log('\nPackage: cq cloud-package <id> [--out <file>]');
  } else if (under === 'start') {
    // More ids = a bundle in the same cloud session (the same --run).
    const ids = id ? [id, ...more] : [];
    if (!ids.length) die('cloud start <id> [<id> ...] [--run <session-id|url>] [--force]');
    const execution = val('--run') ?? null;
    if (execution != null && (!execution.trim() || execution.length > 300 || /\s/.test(execution)))
      die('--run must be the session id or link (without whitespace, at most 300 chars)');
    // Suitability needs git (the remote's baseBranch and local changes), so it is computed before the lock.
    const queue0 = read();
    const context = cloudContext();
    const suitability = {};
    for (const x of ids) {
      const o0 = queue0.tasks.find((y) => y.id === x);
      if (!o0) die(`Unknown task ${x}`);
      if (!L.isCloud(o0)) suitability[x] = cloudAssess(queue0, o0, context).suitability;
    }
    const r = edit((queue) => {
      const s = L.cloudStart(queue, ids, { suitability, execution, force });
      if (s.error) die(s.error);
      return s;
    });
    for (const x of r.newOnes) logTime(x, 'cloud-start', execution ? `execution ${execution}` : 'without execution');
    if (r.newOnes.length)
      console.log(
        `Started in the cloud: ${r.newOnes.join(', ')}${execution ? ` (${execution})` : ''}. The cloud creates ${branchFor('<id>')} from ${REMOTE}/${BASE}.`,
      );
    if (r.left.length)
      console.log(
        `Already in the cloud: ${r.left.join(', ')}${execution ? `; the run is set to ${execution}` : ''}.`,
      );
    if (r.overridden.length) console.log(`--force overrode: ${r.overridden.join(' · ')}`);
    console.log(
      'When CLOUD-DONE <id> arrives: cq cloud done <id> [--branch <branch the cloud pushed>] [--sha <sha>]. ' +
        'If it gives up (CLOUD-STOP): cq cloud cancel <id>.',
    );
  } else if (under === 'done') {
    if (!id) die('cloud done <id> [--branch <branch>] [--sha <sha>]');
    const o0 = read().tasks.find((x) => x.id === id);
    if (!o0) die(`Unknown task ${id}`);
    if (!L.isCloud(o0)) die(`${id} is not in a cloud session (status ${o0.status}).`);
    const branch = val('--branch') ?? branchFor(id);
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/.test(branch) || branch.includes('..'))
      die(`Invalid branch name: ${branch}`);
    const sha = val('--sha') ?? null;
    if (sha != null && !/^[0-9a-f]{7,40}$/i.test(sha)) die(`Invalid sha: ${sha}`);
    // Fetch the branch the cloud pushed (and baseBranch, so the count is against what is pushed now).
    const fetched = git([
      'fetch',
      '-q',
      REMOTE,
      `+refs/heads/${branch}:refs/remotes/${REMOTE}/${branch}`,
      `+refs/heads/${BASE}:refs/remotes/${REMOTE}/${BASE}`,
    ]);
    if (fetched == null)
      die(
        `Could not find ${branch} on ${REMOTE} (git fetch failed). Did the cloud push to another branch? Use --branch <name>.`,
      );
    const remove = `refs/remotes/${REMOTE}/${branch}`;
    const count =
      Number(git(['rev-list', '--count', `refs/remotes/${REMOTE}/${BASE}..${remove}`]) ?? 0) || 0;
    if (count < 1)
      die(`${REMOTE}/${branch} has no commits above ${REMOTE}/${BASE}; nothing to merge.`);
    const tips = git(['rev-parse', remove]);
    if (sha && git(['merge-base', '--is-ancestor', sha, remove]) == null)
      die(`${sha} does not exist on ${REMOTE}/${branch} (tip ${tips?.slice(0, 10)}).`);
    // The local queue branch on the cloud's commits, so merge-track and "Merge branch '<queue branch>'" (the external scan) work as
    // for a local track. If a local queue branch has commits that are not included, we stop instead of overwriting them.
    const local = branchFor(id);
    if (branch !== local) {
      const exists = git(['rev-parse', '-q', '--verify', `refs/heads/${local}`]) != null;
      if (exists && git(['merge-base', '--is-ancestor', `refs/heads/${local}`, remove]) == null)
        die(
          `Local ${local} has commits that are not on ${REMOTE}/${branch}; merge by hand (merge-track.mjs ${REMOTE}/${branch}).`,
        );
      if (git(['branch', '-f', local, remove]) == null)
        die(`Could not set ${local} to ${REMOTE}/${branch} (is it checked out in a worktree?).`);
    } else if (git(['rev-parse', '-q', '--verify', `refs/heads/${local}`]) == null) {
      git(['branch', local, remove]);
    } else if (git(['merge-base', '--is-ancestor', `refs/heads/${local}`, remove]) != null) {
      git(['branch', '-f', local, remove]);
    } else {
      die(`Local ${local} has commits that are not on ${REMOTE}/${branch}; merge by hand.`);
    }
    const r = edit((queue) => {
      const s = L.cloudDone(queue, id, { branch, sha: sha ?? tips });
      if (s.error) die(s.error);
      return s;
    });
    logTime(
      id,
      'cloud-done',
      `${count} commit(s) on ${branch}, ${minutes(r.task.cloud.started, r.task.cloud.done)} min in the cloud`,
    );
    console.log(
      [
        `${id}: completed in the cloud, review. ${count} commit(s) on ${REMOTE}/${branch} (tip ${String(tips).slice(0, 10)}).`,
        'The orchestrator merges:',
        `  1. ${CQ} merge-track ${local}   (local branch = ${REMOTE}/${branch})`,
        `  2. git push ${REMOTE} --delete ${branch}   (after the merge; a fixed claude/... branch would otherwise be reused)`,
        `  3. cq set ${id} done`,
      ].join('\n'),
    );
  } else if (under === 'cancel') {
    if (!id) die('cloud cancel <id>');
    const before = read().tasks.find((x) => x.id === id);
    const g = branchInfo(before?.branch ?? branchFor(id));
    const r = edit((queue) => {
      const s = L.cloudCancel(queue, id, { commits: g.commits });
      if (s.error) die(s.error);
      return s;
    });
    logTime(id, 'cloud-aborted', '');
    console.log(`${id}: the cloud session is aborted, the task is waiting again.`);
    if (r.warning) console.log(`WARNING: ${r.warning}`);
  } else {
    die('cloud [start <id> [--run ...] | done <id> [--branch ...] [--sha ...] | cancel <id>]');
  }
}
