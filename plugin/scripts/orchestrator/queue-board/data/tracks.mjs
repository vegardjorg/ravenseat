// =============================================================
// queue-board/data/tracks.mjs: the board's git reads and the agent helpers (server only, never served).
//
// What the state reads about branches and tracks: the git reader (none in demo mode), the branch a task is built on and
// its commits ahead, git status with <remote>/<baseBranch> (once a minute), the base health and the push batch for the
// status line, the commits reverted on the base (the flow figures), and the track badges and Decisions cards: silent,
// spinning, without an agent, waiting on a permission prompt, tool trouble and the review progress "reviews k/n".
//
// Moved out of queue-board.mjs unchanged (SPLIT-1b). tracksData(ctx) builds the functions once; the caches live in its
// closure and resetTracks() puts them back to their start values (demo mode). The live paths (ctx.FOLDER, ctx.TIME_LOG,
// ctx.BASE_HEALTH_FILE) and ctx.demoOn are getters on ctx, read at the moment of the call.
//
// Used by: queue-board.mjs (builds ctx), queue-board/data/state.mjs and statistics.mjs, and queue-board/api/ (branchFor,
// branchInfo, uncommitted, BRANCH_PATTERN, BRANCH_PREFIX).
// Tested in: lib/__tests__/queueBoardState.test.ts, queueBoardServe.test.ts, __tests__/approvalLive.test.ts and the other
// tests that start the board server (__tests__/queueAttempt.test.ts).
// =============================================================
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const G = require('../../lib/queueGit.js');
const L = require('../../lib/queueLogic.js');
const TK = require('../../lib/timeCost.js');
const ES = require('../../lib/eventStatistics.js');
const BH = require('../../lib/baseHealth.js');
const PB = require('../../lib/pushBatch.js');
const TA = require('../../lib/timeLogArchive.js');

/** tracksData(ctx): the builders bound to the server's context, with their caches in this closure. */
export function tracksData(ctx) {
  const { CONFIG, MAIN_TREE, BASE, REMOTE, REAL } = ctx;

  // ---- Git (uncommitted files in the main tree, the branches <branchPrefix><id>) ----------------------------------
  const realGitRead = G.makeGit(REAL.GIT_ROOT);
  // Demo mode has no git: every read answers "nothing" (null), so branches and diffs are empty in the demo.
  const gitRead = (args) => (ctx.demoOn ? null : realGitRead(args));
  const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,80}$/;
  const BRANCH_PREFIX = String(CONFIG.branchPrefix ?? 'queue/');
  /** The branch a task is built on: `branch` in the queue, otherwise <branchPrefix><id>. */
  const branchFor = (o) => o.branch ?? `${BRANCH_PREFIX}${o.id}`;

  /** Commits ahead of baseBranch on the branch and the time of the last one (the same question queue.mjs asks). */
  function branchInfo(branch) {
    if (!BRANCH_PATTERN.test(branch)) return { exists: false, commits: 0, lastCommit: null };
    if (gitRead(['rev-parse', '-q', '--verify', `refs/heads/${branch}`]) == null)
      return { exists: false, commits: 0, lastCommit: null };
    const commits = Number(String(gitRead(['rev-list', '--count', `${BASE}..${branch}`]) ?? '0').trim());
    const last = commits > 0 ? String(gitRead(['log', '-1', '--format=%cI', branch]) ?? '').trim() : '';
    return { exists: true, commits: commits || 0, lastCommit: last || null };
  }

  // git status in a large repo takes time: read it again at most every minute.
  // At the same time <remote>/<baseBranch> is read, and the paths changed locally since it (for "Suitable for cloud").
  let gitStatus = { time: 0, uncommitted: [], error: false, pushedHead: null, sincePush: [] };
  function uncommitted() {
    if (ctx.demoOn) return gitStatus; // reset to empty when demo mode starts (useDemo), never read from git in the demo
    if (Date.now() - gitStatus.time > 60_000) {
      const u = G.readUncommitted(gitRead);
      const pushedHead =
        String(gitRead(['rev-parse', '-q', '--verify', `refs/remotes/${REMOTE}/${BASE}`]) ?? '').trim() ||
        null;
      const sincePush = pushedHead
        ? String(gitRead(['diff', '--name-only', `refs/remotes/${REMOTE}/${BASE}...${BASE}`]) ?? '')
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
      gitStatus = {
        time: Date.now(),
        uncommitted: u ? u.map((x) => x.path) : [],
        error: u == null,
        pushedHead,
        sincePush,
      };
    }
    return gitStatus;
  }

  // ---- SILENT tracks (the badge on the card): the same rule as queue.mjs show (queueLogic.silentTracks), measured with
  // lib/trackActivity.js. The measurement (git, a capped mtime walk per running track) is cached for 60 s per task set, so a
  // refresh of the board does not walk the worktrees again.
  let silentCache = { time: 0, key: null, list: [] };
  /** Tracks marked running with no agent (the Decisions card). Cached like the silent ones, since it asks git. */
  const noAgentCache = { time: 0, list: [] };
  function withoutAgentNow(queue) {
    if (Date.now() - noAgentCache.time < 60_000) return noAgentCache.list;
    let list = [];
    try {
      list = L.noAgentTracks(queue, {
        worktreeBranches: new Set(G.readWorktrees(gitRead).map((w) => w.branch).filter(Boolean)),
        reportOf: (o) => L.findTrackReport(o.id, o.scratchpad ? [o.scratchpad] : []).report,
        rows: () => {
          try {
            return TK.readRows(TA.readText(ctx.TIME_LOG, { from: TA.activeFrom(queue.tasks) }));
          } catch {
            return [];
          }
        },
        lastCommitMs: (o) => {
          const s = String(gitRead(['log', '-1', '--format=%ct', `refs/heads/${o.branch}`, '--']) ?? '').trim();
          return /^\d+$/.test(s) ? Number(s) * 1000 : null;
        },
      });
    } catch (e) {
      console.error(`the agent check failed: ${e?.message ?? e}`);
    }
    noAgentCache.time = Date.now();
    noAgentCache.list = list;
    return list;
  }

  // ---- Tracks that wait on a permission prompt (hook-approval-wait.mjs saves the agent; lib/approvalWait.js) ---------
  /**
   * The running tasks whose agent waits on an approval. The agent is mapped to its task by the time log, and when the log
   * has only the agent id (its start row was written before the transcript existed), by the mission at the start of the
   * agent's transcript.
   */
  /**
   * How an agent id is tied to its running task: the time log first, then the mission at the start of the agent's
   * transcript. Null when no task is running or in review. Shared by the approval waits and the tool trouble.
   */
  function agentMapping(queue) {
    const running = (queue.tasks ?? []).filter((o) => o.status === 'running' || o.status === 'review').map((o) => o.id);
    if (!running.length) return null;
    const AW = require('../../lib/approvalWait.js');
    const ACT = require('../../lib/trackActivity.js');
    let rows = [];
    try {
      rows = TK.readRows(TA.readText(ctx.TIME_LOG, { from: TA.activeFrom(queue.tasks) }));
    } catch {
      rows = []; // no time log yet: the mission in the transcript can still tie the agent to its task
    }
    const agentTask = new Map();
    for (const [id, x] of ACT.agentsByTask(rows, running)) for (const a of x.agents) agentTask.set(a, id);
    const root = ACT.transcriptsRoot(MAIN_TREE);
    const taskOf = (agentId) => {
      const p = ACT.findTranscript(root, agentId);
      return p ? AW.missionTask(AW.readHead(p), running, TK) : null;
    };
    return { agentTask, taskOf, root, ACT };
  }

  /** The running tasks whose agent auto mode refused, or that fails the same tool again and again (lib/toolTrouble.js). */
  function toolTroubleNow(queue) {
    try {
      const TT = require('../../lib/toolTrouble.js');
      const state = TT.read(ctx.FOLDER);
      if (!Object.keys(state).length) return [];
      const m = agentMapping(queue);
      return m ? TT.troubleTasks(state, { agentTask: m.agentTask, taskOf: m.taskOf }) : [];
    } catch (e) {
      console.error(`the tool trouble check failed: ${e?.message ?? e}`);
      return [];
    }
  }

  function approvalNow(queue) {
    try {
      const AW = require('../../lib/approvalWait.js');
      const waits = AW.read(ctx.FOLDER);
      if (!Object.keys(waits).length) return [];
      const m = agentMapping(queue);
      if (!m) return [];
      const { agentTask, taskOf, root, ACT } = m;
      return AW.waitingTasks(waits, {
        agentTask,
        taskOf,
        mtimeOf: (agentId) => {
          const p = ACT.findTranscript(root, agentId);
          try {
            return p ? fs.statSync(p).mtimeMs : null;
          } catch {
            return null;
          }
        },
      });
    } catch (e) {
      console.error(`the approval check failed: ${e?.message ?? e}`);
      return [];
    }
  }

  // ---- The review progress on a card in Review (0l bolk 4) ---------------------------------------------------------
  // The merge gate (lib/reviewItems.js reviewGate) stops a merge while a reviewer receive chose has not reported, or
  // reports H>0. The card shows the same verdict as "reviews k/n" before anyone runs merge. The reviewer transcripts are
  // read only when the agents or the receive change (the key), and only the reviewer types: a track transcript is never
  // opened here. review.requireFindings false: no badge, like no gate.
  let reviewsCache = { key: null, list: [] };
  /**
   * A transcript, or null when it is missing or over 50 MB (the CLI reads up to 300 MB, cli/tracks.mjs readTranscript;
   * the board must not stall on one, so a reviewer with a larger transcript shows as missing here, never as reported).
   */
  function readSmallTranscript(filePath) {
    try {
      if (!filePath || fs.statSync(filePath).size > 50 * 1024 * 1024) return null;
      return fs.readFileSync(filePath, 'utf8');
    } catch {
      return null;
    }
  }
  function reviewsNow(queue) {
    const RI = require('../../lib/reviewItems.js');
    if (!RI.requireOn(CONFIG)) return [];
    const tasks = (queue.tasks ?? []).filter(
      (o) => o.status === 'review' && Array.isArray(o.review_reviewers) && o.review_reviewers.length,
    );
    if (!tasks.length) return [];
    try {
      const ACT = require('../../lib/trackActivity.js');
      let rows = [];
      try {
        rows = TK.readRows(TA.readText(ctx.TIME_LOG, { from: TA.activeFrom(tasks) }));
      } catch {
        /* no time log: no reviewer has reported */
      }
      const per = tasks.map((o) => {
        const { secure, uncertainOnes } = L.agentsForTask(rows, o.id, { from: o.started ?? o.picked_at ?? o.added_at ?? null });
        const agents = [...secure, ...uncertainOnes.map((x) => ({ ...x, uncertain: true }))].filter(
          (x) => L.REVIEWER_TYPES.includes(x.type) || o.review_reviewers.includes(x.type),
        );
        return { o, agents };
      });
      const key = JSON.stringify(
        per.map(({ o, agents }) => [o.id, o.review_at ?? o.t_receive ?? null, o.review_reviewers, agents.map((x) => [x.agent, x.row?.time])]),
      );
      if (reviewsCache.key === key) return reviewsCache.list;
      const root = ACT.transcriptsRoot(MAIN_TREE);
      const list = [];
      for (const { o, agents } of per) {
        const read = [];
        for (const x of agents) {
          const text = readSmallTranscript(ACT.findTranscript(root, x.agent));
          if (!text || (x.uncertain && !L.missionNamesTask(text, o.id))) continue;
          read.push({ ...x, text });
        }
        const p = RI.progress({
          required: o.review_reviewers,
          since: o.review_at ?? o.t_receive ?? null,
          reports: RI.reportsOf(read, o.review_reviewers, L),
        });
        if (p) list.push({ id: o.id, ...p });
      }
      reviewsCache = { key, list };
      return list;
    } catch (e) {
      console.error(`the review progress failed: ${e?.message ?? e}`);
      return [];
    }
  }

  function silentNow(queue) {
    const limitMin = L.silentMinFor(queue);
    const running = (queue.tasks ?? []).filter((o) => L.silentWatched(o));
    const key = `${limitMin}|${running.map((o) => `${o.id}:${o.started ?? ''}:${o.attempts?.at(-1)?.reserved ?? ''}`).join(',')}`;
    if (silentCache.key === key && Date.now() - silentCache.time < 60_000) return silentCache.list;
    let list = [];
    try {
      if (limitMin > 0 && running.length) {
        const ACT = require('../../lib/trackActivity.js');
        const worktrees = G.readWorktrees(gitRead).filter((w) => w.branch);
        const worktreeBranches = new Set(worktrees.map((w) => w.branch));
        const candidates = L.silentCandidates(queue, worktreeBranches);
        if (candidates.length) {
          const now = Date.now();
          let rows = [];
          try {
            rows = TK.readRows(TA.readText(ctx.TIME_LOG, { from: TA.activeFrom(candidates) }));
          } catch {
            /* no time log: the other sources still count */
          }
          const agents = ACT.agentsByTask(
            rows,
            candidates.map((o) => o.id),
          );
          const root = ACT.transcriptsRoot(MAIN_TREE);
          const lastActivity = {};
          for (const o of candidates)
            lastActivity[o.id] = ACT.lastActivity({
              branch: o.branch,
              worktree: worktrees.find((w) => w.branch === o.branch)?.path ?? null,
              trackDirs: o.scratchpad ? [path.join(o.scratchpad, o.id)] : [],
              agents: agents.get(o.id) ?? null,
              findTranscript: (agentId) => ACT.findTranscript(root, agentId),
              git: gitRead,
              freshMs: now - limitMin * 60_000,
            }).ms;
          list = L.silentTracks(queue, {
            worktreeBranches,
            lastActivity,
            hasReport: (o) => L.reportSinceStart(o, L.findTrackReport(o.id, o.scratchpad ? [o.scratchpad] : []).report),
            now,
            limitMin,
          });
        }
      }
    } catch (e) {
      console.error(`the silence check failed: ${e?.message ?? e}`);
    }
    silentCache = { time: Date.now(), key, list };
    return list;
  }

  // ---- SPINNING tracks (the Decisions card after an hour): the same rule as ravenseat show (lib/trackSpin.js), cached 60 s.
  let spinCache = { time: 0, key: null, list: [] };
  function spinningNow(queue, silent) {
    const SP = require('../../lib/trackSpin.js');
    const limitMin = SP.spinMinFor(queue);
    const running = (queue.tasks ?? []).filter((o) => L.silentWatched(o));
    const key = `${limitMin}|${running.map((o) => `${o.id}:${o.started ?? ''}`).join(',')}|${(silent ?? []).map((x) => x.id).join(',')}`;
    if (spinCache.key === key && Date.now() - spinCache.time < 60_000) return spinCache.list;
    let list = [];
    try {
      const worktreeBranches = new Set(G.readWorktrees(gitRead).map((w) => w.branch).filter(Boolean));
      const candidates = limitMin > 0 ? L.silentCandidates(queue, worktreeBranches) : [];
      if (candidates.length) {
        const ACT = require('../../lib/trackActivity.js');
        let rows = [];
        try {
          rows = TK.readRows(TA.readText(ctx.TIME_LOG, { from: TA.activeFrom(candidates) }));
        } catch {
          /* no time log: no agents to measure */
        }
        const agents = ACT.agentsByTask(rows, candidates.map((o) => o.id));
        const root = ACT.transcriptsRoot(MAIN_TREE);
        const skip = new Set((silent ?? []).map((x) => x.id));
        const measures = {};
        const lastCommit = {};
        for (const o of candidates) {
          if (skip.has(o.id) || L.reportSinceStart(o, L.findTrackReport(o.id, o.scratchpad ? [o.scratchpad] : []).report)) continue;
          const newest = [...(agents.get(o.id)?.agents ?? [])]
            .map((id) => ACT.findTranscript(root, id))
            .filter(Boolean)
            .map((p) => ({ p, ms: fs.statSync(p).mtimeMs }))
            .sort((p, q) => q.ms - p.ms)[0];
          const m = newest ? SP.measure(newest.p) : null;
          if (!m) continue;
          measures[o.id] = m;
          const s = String(gitRead(['log', '-1', '--format=%ct', `refs/heads/${o.branch}`, '--']) ?? '').trim();
          lastCommit[o.id] = /^\d+$/.test(s) ? Number(s) * 1000 : null;
        }
        list = SP.spinningTracks(queue, { candidates, measures, lastCommit, skip, limitMin });
      }
    } catch (e) {
      console.error(`the spinning check failed: ${e?.message ?? e}`);
    }
    spinCache = { time: Date.now(), key, list };
    return list;
  }

  // ---- The base health (the base gate's verdict for the current base tip) ------------------------------------------
  const BASE_SETUP = BH.baseGateSetup(CONFIG);
  let baseTipCache = { time: 0, tip: null };
  /** { status, tip, fixTask, text } or null when the base gate is off. The tip is read at most once a minute. */
  function baseHealthNow() {
    if (!BASE_SETUP.enabled) return null;
    try {
      if (Date.now() - baseTipCache.time > 60_000)
        baseTipCache = { time: Date.now(), tip: String(gitRead(['rev-parse', '-q', '--verify', `refs/heads/${BASE}`]) ?? '').trim() || null };
      return BH.boardHealth({ state: BH.readState(ctx.BASE_HEALTH_FILE), tip: baseTipCache.tip, setup: BASE_SETUP, branch: BASE });
    } catch {
      return null;
    }
  }

  // ---- The push batch (merged tasks not on <remote>/<baseBranch>, lib/pushBatch.js) ------------------------------------
  const PUSH_SETUP = PB.pushSetup(CONFIG);
  let pushBatchCache = { time: 0, batch: null, blocked: [], fullGate: 'off' };
  /** What push-check would stop on besides the base: external commits and a remote ahead of us, and the full gate on the tip. */
  function pushStops(from, to, batch) {
    if (!batch) return { blocked: [], fullGate: 'off' };
    const raw = G.readFirstParents(gitRead, { from, to }) ?? [];
    const plan = L.pushPlan(G.classify(gitRead, raw, { from }).reverse());
    const behind = Number(String(gitRead(['rev-list', '--count', `${to}..${from}`]) ?? '0').trim()) || 0;
    return {
      blocked: PB.blockedTexts({ external: plan.externalOnes.length, behind, from: `${REMOTE}/${BASE}`, to: BASE, mode: PUSH_SETUP.mode }),
      fullGate: require('../../lib/gateEvidence.js').fullGateVerdict({ folder: ctx.FOLDER, sha: batch.tip, cfg: CONFIG }),
    };
  }
  /** { verdict, tasks, minTasks, text } or null (no remote ref yet, or git failed). git is read at most once a minute. */
  function pushBatchNow(baseHealth) {
    try {
      if (Date.now() - pushBatchCache.time > 60_000) {
        const from = `refs/remotes/${REMOTE}/${BASE}`;
        const to = `refs/heads/${BASE}`;
        const batch = PB.readBatch(gitRead, { from, to, prefix: BRANCH_PREFIX, withCommits: false });
        pushBatchCache = { time: Date.now(), batch, ...pushStops(from, to, batch) };
      }
      // The health is the base gate's verdict for the tip (red blocks); unknown when the gate is off.
      return PB.boardBatch({
        batch: pushBatchCache.batch,
        setup: PUSH_SETUP,
        health: baseHealth?.status ?? 'unknown',
        fullGate: pushBatchCache.fullGate,
        blocked: pushBatchCache.blocked,
      });
    } catch {
      return null;
    }
  }

  let revertedCache = { time: 0, commits: new Set() };
  /** The commits reverted on the base. Read at most once a minute, like the base tip. */
  function revertedNow() {
    if (Date.now() - revertedCache.time > 60_000)
      revertedCache = {
        time: Date.now(),
        commits: ES.revertedCommitsIn(gitRead(['log', BASE, '--grep=This reverts commit', '--format=%B'])),
      };
    return revertedCache.commits;
  }

  return {
    BRANCH_PATTERN,
    BRANCH_PREFIX,
    branchFor,
    branchInfo,
    uncommitted,
    withoutAgentNow,
    toolTroubleNow,
    approvalNow,
    reviewsNow,
    silentNow,
    spinningNow,
    baseHealthNow,
    pushBatchNow,
    revertedNow,
    /** Every cache of this module back to its start value (demo mode switched the paths behind them). */
    resetTracks() {
      // noAgentCache is not reset, as before the split.
      gitStatus = { time: 0, uncommitted: [], error: false, pushedHead: null, sincePush: [] };
      silentCache = { time: 0, key: null, list: [] };
      reviewsCache = { key: null, list: [] };
      spinCache = { time: 0, key: null, list: [] };
      baseTipCache = { time: 0, tip: null };
      pushBatchCache = { time: 0, batch: null, blocked: [], fullGate: 'off' };
      revertedCache = { time: 0, commits: new Set() };
    },
  };
}
