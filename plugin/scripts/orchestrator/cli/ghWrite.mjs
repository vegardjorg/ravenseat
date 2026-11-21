// =============================================================
// cli/ghWrite.mjs: the GitHub writes, each opt-in and asked (GH-3, GH-4, GH-5 of
// plans/trailhead-gsd-skills-vurdering-2026-11-20.md). Every write goes through lib/ghOutbound.js: a fixed template,
// the secret scan with a block on a hit, the empty-body refusal, the main session only, and one preview of exactly what
// will be posted that the post must match.
//
//   ravenseat issues report [--post] [--json]
//        GH-3, after a push: for each done task with an issue link whose merge commit is on <remote>/<baseBranch> and
//        that was not reported before, the fixed comment (task id, title, merge commit, the pushed tip and its checks,
//        "Posted by Ravenseat"). issues.onPush: off (default; one line, no gh call), comment, or close (closes the issue
//        with that comment). Without --post it is the preview and posts nothing. A post is recorded in
//        issue-reports.json in the data folder, so it is never posted twice. A failure to post never touches the push:
//        it is reported (NOT POSTED) and tried again on the next run.
//   ravenseat pr [--post] [--json]
//        GH-4, a draft pull request for the batch instead of a push of the base: the merged tasks not yet on
//        <remote>/<baseBranch> go to ONE branch ravenseat/batch-<date>, which must match push.allowBranches. It makes or
//        moves forward the local branch (never backwards), prints the push for the main session to run (so the push
//        guard and the batch rules judge it as any push), and after that push `--post` opens one draft pull request
//        with the fixed body. An open pull request for the branch is never opened again (the push updated it).
//        push.pr "draft" makes push-check point at this route; the command itself works on request either way.
//   ravenseat release-notes [<from-tag>] [--save] [--json] [--github --tag <name> [--post]]
//        GH-5, a release notes draft from the merged tasks since the tag (default: the newest tag on the base, or all
//        history), grouped Added / Changed / Fixed / Hardened (lib/releaseNotes.js). Local, no network: stdout, or
//        --save writes it to release-notes/ in the data folder. --github previews a DRAFT release for --tag on GitHub
//        (the base must be pushed); with --post it creates it. Never published, never marked latest.
//
// The yes: in the owner's own terminal (stdin a TTY) --post asks y/N here. From Claude Code the push guard asks first,
// with Claude Code's own dialog (lib/approvalAsk.js, rule outbound-github, approvals.ask), and names the targets and
// whether the repo is public; with approvals.ask off and no terminal, --post refuses. In dontAsk and bypassPermissions
// the guard denies instead. Queue agents are denied all of these by the push guard (they may run only the read-only
// queue commands), and the command refuses on a queue branch or in a linked worktree.
//
// Exit codes: 0 done (or nothing to do), 1 an error, a block or a failed post, 2 usage. QUEUE_GH replaces gh in the
// tests (cli/ghRun.mjs). Used by: queue.mjs (dispatch), cli/issues.mjs (issues report). Tested in
// __tests__/ghWrite.test.ts and __tests__/redteam/ghWrite.test.ts.
// =============================================================

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { a, BASE, CLI, CONFIG, die, FOLDER, GIT_ROOT, gitRead, MAIN_TREE, PREFIX, queueBranchId, read, REMOTE, require, ROOT, val } from './context.mjs';
import { ghRunner } from './ghRun.mjs';

const GO = require('./lib/ghOutbound.js');
const RN = require('./lib/releaseNotes.js');
const PB = require('./lib/pushBatch.js');
const GE = require('./lib/gateEvidence.js');
const BH = require('./lib/baseHealth.js');
const IL = require('./lib/issueLink.js');
const RV = require('./lib/repoVisibility.js');
const GI = require('./lib/githubIssues.js');
const QA = require('./lib/queueArchive.js');
const AA = require('./lib/approvalAsk.js');
const PG = require('./lib/pushGuard.js');

const LEDGER = path.join(FOLDER, 'issue-reports.json');
const json = a.includes('--json');
const post = a.includes('--post');

// ---- shared ------------------------------------------------------------------------------------------------------

const norm = (p) => {
  const r = path.resolve(String(p)).replace(/\\/g, '/');
  return process.platform === 'win32' ? r.toLowerCase() : r;
};

/** Stops outside the main session: a queue branch, or a linked worktree. */
function refuseOutside(label) {
  const why = GO.mainSessionRefusal({ queueBranch: queueBranchId(), inWorktree: norm(ROOT) !== norm(MAIN_TREE) });
  if (why) die(`${label}: ${why}`);
}

/** owner/name of the origin remote, or a stop. */
function repoOrStop(label) {
  const repo = IL.originRepo(RV.remoteUrlOf(GIT_ROOT, REMOTE ?? 'origin'));
  if (!repo) die(`${label}: the ${REMOTE ?? 'origin'} remote is not a GitHub repo, so there is nothing to post to. Nothing posted.`);
  return repo;
}

const sha = (ref) => String(gitRead(['rev-parse', '-q', '--verify', `${ref}^{commit}`]) ?? '').trim() || null;

/** The repo's visibility: the cache of any age, else one gh read (then cached), else unknown. Never the plain network. */
function visibilityOf(run) {
  const remoteUrl = RV.remoteUrlOf(GIT_ROOT, REMOTE ?? 'origin');
  const c = RV.readCache(FOLDER, { any: true, remote: remoteUrl });
  if (c) return c.visibility;
  const remote = RV.parseRemote(remoteUrl);
  if (!remote || remote.host !== 'github') return 'unknown';
  const r = run(['repo', 'view', `${remote.owner}/${remote.name}`, '--json', 'visibility']);
  const v = r.code === 0 ? RV.fromGh(r.out) : null;
  if (!v) return 'unknown';
  try {
    RV.writeCache(FOLDER, { visibility: v, source: 'gh', remote: remoteUrl, checkedAt: new Date().toISOString() });
  } catch {
    // error-ignored: the answer is used, only asked again next time
  }
  return v;
}

/** The merged task ids on the first-parent line from..to (from null: the whole line), in merge order. */
function mergedIds(from, to) {
  const RS = String.fromCharCode(0x1e);
  const US = String.fromCharCode(0x1f);
  const range = from ? `${from}..${to}` : to;
  const out = gitRead(['log', '--first-parent', `--format=${RS}%H${US}%P${US}%ct${US}%s`, range, '--']);
  if (out == null) return null;
  return PB.summarize(PB.parseRows(out), { prefix: PREFIX }).tasks;
}

/** The tasks of the queue and its archive. */
function allTasks() {
  return QA.withArchive(read(), FOLDER).tasks ?? [];
}

/**
 * The owner's yes for --post. A terminal asks y/N here; from Claude Code the approval dialog has asked before the
 * command ran (approvals.ask), so with it off nothing can ask and --post refuses.
 */
async function confirmed(label, summary) {
  if (process.stdin.isTTY) {
    const rl = (await import('node:readline/promises')).createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await rl.question(`${label}: ${summary} Post it? [y/N] `);
      return /^y(es)?$/i.test(answer.trim());
    } finally {
      rl.close();
    }
  }
  if (!AA.setupOf(CONFIG).ask)
    die(
      `${label}: --post needs your yes, and approvals.ask is off, so the approval dialog cannot ask. Run it in your own ` +
        'terminal (it asks y/N there), or turn approvals.ask on. Nothing posted.',
    );
  return true;
}

/**
 * The preview and, with --post, the posts. items: [{ target, action, title?, body, args, key? }]. Blocked items are
 * named with their problems and never shown or posted (their text is what the guard stopped).
 * @returns {Promise<{ posted: object[], failed: object[], blocked: object[] }>}
 */
async function previewAndPost({ label, kind, what, repo, visibility, items, run, onPosted = () => {} }) {
  const checked = items.map((x) => ({ ...x, guard: GO.check({ body: x.body, title: x.title ?? null, cfg: CONFIG }) }));
  const ok = checked.filter((x) => x.guard.ok);
  const blocked = checked.filter((x) => !x.guard.ok);
  if (!post) {
    if (json) {
      console.log(JSON.stringify({ ok: true, kind, repo, visibility, posts: ok.map(({ target, action, title, body }) => ({ target, action, title, body })), blocked: blocked.map((x) => ({ target: x.target, problems: x.guard.problems })) }));
    } else {
      if (ok.length) console.log(GO.previewLines({ what, repo, visibility, items: ok }).join('\n'));
      for (const x of blocked) console.log(`BLOCKED ${x.action} ${x.target}: ${x.guard.problems.join('; ')}. Not shown and never posted; fix the task's title.`);
      if (ok.length) console.log(`\nNothing posted. To post exactly this: ${CLI} ${a.filter((x) => x !== '--json').join(' ')} --post (you are asked first).`);
    }
    if (ok.length) GO.writePreview(FOLDER, { kind, repo, visibility, items: ok });
    return { posted: [], failed: [], blocked };
  }
  for (const x of blocked) console.log(`BLOCKED ${x.action} ${x.target}: ${x.guard.problems.join('; ')}. Not posted.`);
  if (!ok.length) return { posted: [], failed: [], blocked };
  const mismatch = GO.previewMismatch(GO.readPreview(FOLDER), { kind, items: ok });
  if (mismatch) die(`${label}: ${mismatch}. Nothing posted.`);
  if (!(await confirmed(label, GO.dialogSummary({ kind, repo, visibility, items: ok })))) die(`${label}: not confirmed. Nothing posted.`);
  const posted = [];
  const failed = [];
  for (const x of ok) {
    const r = run(x.args);
    if (r.code === 0 && !r.missing) {
      const url = (String(r.out).match(/https:\/\/github\.com\/\S+/) ?? [null])[0];
      posted.push({ target: x.target, action: x.action, url });
      onPosted(x, url);
      console.log(`POSTED ${x.action} ${x.target}${url ? ` (${url})` : ''}`);
    } else {
      const f = GI.failure(r);
      failed.push({ target: x.target, action: x.action, reason: f.message });
      console.log(`NOT POSTED ${x.action} ${x.target}: ${f.message}. Fix: ${f.fix}. Tried again on the next run.`);
      if (f.kind === 'auth' || f.kind === 'missing' || f.kind === 'network') break;
    }
  }
  try {
    fs.rmSync(GO.previewFile(FOLDER), { force: true });
  } catch {
    // error-ignored: a used preview no longer matches anything new anyway
  }
  return { posted, failed, blocked };
}

// ---- GH-3: issues report -----------------------------------------------------------------------------------------

function readLedger() {
  try {
    const x = JSON.parse(fs.readFileSync(LEDGER, 'utf8'));
    return x && typeof x.reported === 'object' && x.reported ? x : { reported: {} };
  } catch {
    return { reported: {} };
  }
}

function writeLedger(ledger) {
  fs.mkdirSync(FOLDER, { recursive: true });
  const tmp = `${LEDGER}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`);
  fs.renameSync(tmp, LEDGER);
}

/** `ravenseat issues report [--post]`. */
export async function cmdIssuesReport() {
  const label = 'ISSUES REPORT';
  const mode = GO.onPushOf(CONFIG);
  if (mode === 'off') {
    const line = `${label}: off (issues.onPush is off), so nothing is posted to GitHub. Turn it on with issues.onPush "comment" or "close" in queue.config.json.`;
    console.log(json ? JSON.stringify({ ok: true, off: true }) : line);
    return;
  }
  refuseOutside(label);
  const repo = repoOrStop(label);
  const remoteRef = `refs/remotes/${REMOTE}/${BASE}`;
  const tip = sha(remoteRef);
  if (!tip) {
    console.log(json ? JSON.stringify({ ok: true, posts: [] }) : `${label}: ${REMOTE}/${BASE} is not known here yet (nothing pushed), so there is nothing to report.`);
    return;
  }
  const ledger = readLedger();
  const candidates = allTasks().filter(
    (t) =>
      t?.status === 'done' &&
      IL.issueView(t.issue) &&
      /^[0-9a-f]{40}$/i.test(String(t.merge_commit ?? '')) &&
      !ledger.reported[`${t.id}@${t.merge_commit}`] &&
      gitRead(['merge-base', '--is-ancestor', t.merge_commit, remoteRef]) !== null,
  );
  if (!candidates.length) {
    console.log(json ? JSON.stringify({ ok: true, posts: [] }) : `${label}: nothing to report (no merged and pushed task with an issue link that is not reported yet).`);
    return;
  }
  const run = await ghRunner();
  const others = candidates.some((t) => t.issue.repo.toLowerCase() !== repo.toLowerCase());
  const visibility = others ? 'unknown' : visibilityOf(run);
  const fullGate = GE.fullGateVerdict({ folder: FOLDER, sha: tip, cfg: CONFIG });
  const items = candidates.map((t) => {
    const n = String(t.issue.number);
    const body = GO.commentBody({ id: t.id, title: t.title, mergeCommit: t.merge_commit, tip, fullGate, action: mode });
    return {
      key: `${t.id}@${t.merge_commit}`,
      target: `${t.issue.repo}#${n}`,
      action: mode === 'close' ? 'close' : 'comment',
      body,
      args: mode === 'close' ? ['issue', 'close', n, '--repo', t.issue.repo, '--comment', body] : ['issue', 'comment', n, '--repo', t.issue.repo, '--body', body],
    };
  });
  const r = await previewAndPost({
    label,
    kind: 'issues-report',
    what: mode === 'close' ? 'issue close(s) with a comment' : 'issue comment(s)',
    repo,
    visibility,
    items,
    run,
    onPosted: (x, url) => {
      const l = readLedger();
      l.reported[x.key] = { at: new Date().toISOString(), target: x.target, action: x.action, url };
      writeLedger(l);
    },
  });
  if (post && json) console.log(JSON.stringify({ ok: !r.failed.length && !r.blocked.length, ...r }));
  if (post && (r.failed.length || r.blocked.length)) process.exit(1);
}

// ---- GH-4: the draft pull request --------------------------------------------------------------------------------

function gitWrite(args) {
  execFileSync('git', args, { cwd: GIT_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
}

/** The caveats of a batch, in words (fixed texts). */
function caveatsOf({ fullGate, health, count }) {
  const out = [];
  if (fullGate === 'red') out.push('the full gate is red on this tip');
  if (fullGate === 'missing') out.push('the full gate has not run on this tip');
  if (health === 'red') out.push('the base is red at this tip');
  if (health === 'unknown') out.push('the base gate has not checked this tip');
  const min = PB.pushSetup(CONFIG).minTasks;
  if (min && count < min) out.push(`a small batch (${count} of push.minTasks ${min})`);
  return out;
}

/** `ravenseat pr [--post]`. */
export async function cmdPr() {
  const label = 'PR';
  refuseOutside(label);
  const repo = repoOrStop(label);
  const branch = GO.batchBranch();
  if (!PG.allowedBranch(branch, CONFIG.push?.allowBranches))
    die(
      `${label}: the batch branch ${branch} is not in push.allowBranches, so the push guard would block its push. Add ` +
        `"ravenseat/batch-*" to push.allowBranches in queue.config.json once (a forced push of it still asks, a delete stays ` +
        'denied). Nothing changed.',
    );
  const tip = sha(`refs/heads/${BASE}`);
  if (!tip) die(`${label}: ${BASE} has no commit. Nothing changed.`);
  const remoteBase = sha(`refs/remotes/${REMOTE}/${BASE}`);
  const ids = mergedIds(remoteBase ? `refs/remotes/${REMOTE}/${BASE}` : null, `refs/heads/${BASE}`) ?? [];
  if (!ids.length) die(`${label}: no merged task is waiting that is not on ${REMOTE}/${BASE}, so there is nothing for a pull request.`);

  // The local branch: made at the base tip, or moved forward to it; never backwards, never over its own commits.
  const local = sha(`refs/heads/${branch}`);
  if (!local) {
    gitWrite(['branch', branch, tip]);
    if (!json) console.log(`${label}: made the local branch ${branch} at ${tip.slice(0, 7)} (${BASE}'s tip).`);
  } else if (local !== tip) {
    if (gitRead(['merge-base', '--is-ancestor', local, tip]) === null)
      die(`${label}: ${branch} exists at ${local.slice(0, 7)} with commits that are not on ${BASE}. Nothing changed; look at it by hand.`);
    gitWrite(['branch', '-f', branch, tip]);
    if (!json) console.log(`${label}: moved the local branch ${branch} forward to ${tip.slice(0, 7)}.`);
  }
  const remoteBranch = sha(`refs/remotes/${REMOTE}/${branch}`);
  const pushed = remoteBranch === tip;
  const run = await ghRunner();
  if (remoteBranch) {
    const r = run(['pr', 'list', '--repo', repo, '--head', branch, '--state', 'open', '--json', 'number,url']);
    let open = [];
    try {
      open = r.code === 0 ? JSON.parse(r.out) : [];
    } catch {
      open = [];
    }
    if (Array.isArray(open) && open.length) {
      const url = typeof open[0]?.url === 'string' && open[0].url.startsWith('https://github.com/') ? open[0].url : `#${Number(open[0]?.number) || '?'}`;
      const line = `${label}: a pull request for ${branch} is already open (${url}). ${pushed ? 'It has the batch.' : `Push the branch to update it: git push ${REMOTE} ${branch}`} Nothing posted.`;
      console.log(json ? JSON.stringify({ ok: true, open: url, pushed }) : line);
      return;
    }
  }
  const tasks = allTasks();
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const list = ids.map((id) => ({ id, title: byId.get(id)?.title ?? '(not in the queue)', door: byId.get(id)?.door, blast: byId.get(id)?.blast }));
  const fullGate = GE.fullGateVerdict({ folder: FOLDER, sha: tip, cfg: CONFIG });
  const health = BH.verdict(BH.readState(path.join(FOLDER, 'base-health.json')), tip);
  const body = GO.prBody({ tasks: list, tip, base: BASE, fullGate, health, caveats: caveatsOf({ fullGate, health, count: list.length }) });
  const title = `Ravenseat batch ${branch.slice('ravenseat/batch-'.length)}: ${list.length} task(s)`;
  if (post && !pushed)
    die(`${label}: push the branch first, from the main session (the push guard checks it): git push ${REMOTE} ${branch}. Then run ${CLI} pr, read the preview, and ${CLI} pr --post. Nothing posted.`);
  const visibility = visibilityOf(run);
  const r = await previewAndPost({
    label,
    kind: 'pr',
    what: 'draft pull request',
    repo,
    visibility,
    items: [{ target: `${repo}:${branch}`, action: 'draft pull request', title, body, args: ['pr', 'create', '--repo', repo, '--draft', '--base', BASE, '--head', branch, '--title', title, '--body', body] }],
    run,
  });
  if (!post && !json && !pushed)
    console.log(
      `\nNext: push the branch from the main session, so the push guard checks it as any push: git push ${REMOTE} ${branch}\n` +
        `Then: ${CLI} pr (the preview again) and ${CLI} pr --post (asks you first). ${BASE} itself is not pushed.`,
    );
  if (post && json) console.log(JSON.stringify({ ok: !r.failed.length && !r.blocked.length, ...r }));
  if (r.failed.length || r.blocked.length) process.exit(1);
}

// ---- GH-5: release notes -----------------------------------------------------------------------------------------

/** `ravenseat release-notes [<from-tag>] [--save] [--json] [--github --tag <name> [--post]]`. */
export async function cmdReleaseNotes() {
  const label = 'RELEASE NOTES';
  const WITH_VALUE = new Set(['--tag']);
  let given = null;
  for (let i = 1; i < a.length; i++) {
    if (WITH_VALUE.has(a[i])) {
      i++;
      continue;
    }
    if (!a[i].startsWith('--')) {
      given = a[i];
      break;
    }
  }
  let from = given;
  if (from && !sha(`refs/tags/${from}`)) die(`${label}: there is no tag ${from}. Nothing written.`);
  if (!from) from = String(gitRead(['describe', '--tags', '--abbrev=0', `refs/heads/${BASE}`]) ?? '').trim() || null;
  const ids = mergedIds(from ? `refs/tags/${from}` : null, `refs/heads/${BASE}`);
  if (ids == null) die(`${label}: git could not read ${BASE}. Nothing written.`);
  const notes = RN.build({ ids, tasks: allTasks() });

  if (!a.includes('--github')) {
    const md = RN.markdown(notes, { from });
    if (json) {
      console.log(JSON.stringify({ ok: true, from, groups: notes.groups, leftOut: notes.leftOut }));
      return;
    }
    if (a.includes('--save')) {
      const dir = path.join(FOLDER, 'release-notes');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${new Date().toISOString().slice(0, 10)}-since-${String(from ?? 'start').replace(/[^A-Za-z0-9._-]/g, '_')}.md`);
      fs.writeFileSync(file, md);
      console.log(`${label}: the draft (${notes.count} task(s)) is in ${file}. Nothing was sent anywhere.`);
      return;
    }
    process.stdout.write(md);
    return;
  }

  refuseOutside(label);
  const tag = val('--tag');
  if (!tag || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(tag) || tag.includes('..'))
    die(`${label}: --github needs --tag <name> for the draft release (letters, digits, dot, dash, slash). Nothing posted.`, 2);
  const repo = repoOrStop(label);
  const tip = sha(`refs/heads/${BASE}`);
  if (!tip || sha(`refs/remotes/${REMOTE}/${BASE}`) !== tip)
    die(`${label}: ${BASE} at ${tip ? tip.slice(0, 7) : 'unknown'} is not on ${REMOTE} yet; push the batch first, so the release points at pushed work. Nothing posted.`);
  const body = RN.markdown(notes, { from, github: true });
  const run = await ghRunner();
  const visibility = visibilityOf(run);
  const r = await previewAndPost({
    label,
    kind: 'release',
    what: 'draft release',
    repo,
    visibility,
    items: [{ target: `${repo}@${tag}`, action: 'draft release', title: tag, body, args: ['release', 'create', tag, '--repo', repo, '--draft', '--target', tip, '--title', tag, '--notes', body] }],
    run,
  });
  if (post && json) console.log(JSON.stringify({ ok: !r.failed.length && !r.blocked.length, ...r }));
  if (r.failed.length || r.blocked.length) process.exit(1);
}
