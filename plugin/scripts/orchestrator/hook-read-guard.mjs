#!/usr/bin/env node
// =============================================================
// hook-read-guard.mjs: PreToolUse hook (matcher Read), read guard for the track and review agents.
// See docs/orchestration.md.
//
// Why: files that are loaded automatically (CLAUDE.md, the memory) still get read with Read, and large files are read
// whole instead of in excerpts. Read hygiene is in the mission, but a hook is deterministic.
//
// How it works (the rules live in lib/trackGuard.js, assessReading; the project extends them with config().readGuard):
//   - Only for the agent types in the read guard (track, track-d, the reviewers and helper agents + readGuard.agentTypes). The
//     field agent_type is missing in the main session: no effect there.
//   - Denies Read without offset/limit of files that are loaded automatically (CLAUDE.md, MEMORY.md + readGuard.autoLoaded).
//   - Denies Read without limit of a file in readGuard.largeFiles (and migrations.folder/*.sql) over 300 lines (override
//     with READ_GUARD_MAX_LINES or readGuard.maxLines), and of any text file over readGuard.blockLines (2000).
//     The denial tells the agent what to do instead (Grep, then offset and limit).
//   - For track and track-d a Read that is let through gives a SOFT read hint (additionalContext, never block) when a file
//     over about 300 lines is read whole (READ_HINT_MAX_LINES), or the same file is read whole a second time. The logic lives
//     in readHint.js; the state in <Temp>/queue-read-hint/<agent_id>.json (READ_HINT_STATE overrides).
//   - Denies any Read (offset and limit too) under a privatePaths entry with "read": false (lib/privatePaths.js
//     readDenied, H4), also through an agent worktree's copy of the path, so its content never reaches a mission, a
//     report or a transcript. The main session is never stopped (it has no agent_type).
// Every denial is one row in the time log (lib/guardLog.js, guardLog.enabled): guard, rule, agent type, task, never the path.
// Fails OPEN: any internal error gives no output and exit 0.
// Smoke test: echo '{"agent_type":"track","tool_input":{"file_path":"CLAUDE.md"}}' | node scripts/orchestrator/hook-read-guard.mjs
// =============================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// Not a queue project (no queue.config.json): do nothing. A plugin's hooks run in every project the user opens.
if (!require('./lib/projectRoot.js').queueActive()) process.exit(0);
const V = require('./lib/trackGuard.js');
const H = require('./readHint.js');
// The hook payload in the core's names and the hook answers (lib/clients/claude/hookInput.js).
const HK = require('./lib/clients/index.js').clientFor().hooks;

const guard = setTimeout(() => process.exit(0), 5000);
guard.unref();

const MAX = Number(process.env.READ_GUARD_MAX_LINES) || undefined;
const HINT_LINES = Number(process.env.READ_HINT_MAX_LINES) || H.HINT_LINES;
const HINT_STATE = process.env.READ_HINT_STATE || path.join(os.tmpdir(), 'queue-read-hint');
/** Files larger than this are not counted (the guard lets them through; Read trims them anyway). */
const MAX_BYTES_COUNT = 50 * 1024 * 1024;

async function readIn() {
  let s = '';
  for await (const chunk of process.stdin) s += chunk;
  return JSON.parse(s || '{}');
}

/** Number of lines in the file, or null when it cannot be read (then the guard lets the read through). */
function tallyLines(file) {
  try {
    if (fs.statSync(file).size > MAX_BYTES_COUNT) return null;
    const t = fs.readFileSync(file, 'utf8');
    let n = 1;
    for (let i = 0; i < t.length; i++) if (t.charCodeAt(i) === 10) n++;
    return n;
  } catch {
    return null;
  }
}

const hintFile = (id) => path.join(HINT_STATE, `${String(id).replace(/[^\w.-]/g, '_')}.json`);

/**
 * Soft read hint (never block) for a Read that is let through: whole file over about 300 lines, or the same file whole a
 * second time. The files the agent has read whole are remembered in <Temp>/queue-read-hint/<agent_id>.json.
 */
function readHint(input, agentType, abs, ti, countLines) {
  if (!input.agent.id || !H.TRACK_TYPES.has(agentType)) return;
  let readWhole = [];
  try {
    const o = JSON.parse(fs.readFileSync(hintFile(input.agent.id), 'utf8'));
    if (Array.isArray(o.readWhole)) readWhole = o.readWhole;
  } catch {
    // no state yet
  }
  const r = H.assessReadHint({
    agentType,
    filePath: abs,
    offset: ti.offset,
    limit: ti.limit,
    countLines,
    readWhole,
    maxLines: HINT_LINES,
  });
  if (!r) return;
  if (r.key) {
    // Old state files of earlier agents go (older than 7 days, at most once a day; lib/stateSweep.js, never throws).
    require('./lib/stateSweep.js').sweepState(HINT_STATE);
    fs.mkdirSync(HINT_STATE, { recursive: true });
    fs.writeFileSync(
      hintFile(input.agent.id),
      JSON.stringify({ agent_id: input.agent.id, readWhole: [...readWhole, r.key] }),
    );
  }
  if (!r.hint) return;
  process.stdout.write(JSON.stringify(HK.context('PreToolUse', r.hint)));
}

async function main() {
  const input = HK.read(await readIn());
  const agentType = require('./lib/projectRoot.js').bareAgentType(input.agent.type); // "ravenseat:track" (plugin) -> "track"
  if (!agentType) return; // main session: no effect
  const rules = V.readRules();
  if (!rules.types.has(agentType)) return;
  const ti = input.tool.input || {};
  const filePath = typeof ti.file_path === 'string' ? ti.file_path : '';
  if (!filePath) return;
  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(input.cwd || process.cwd(), filePath);
  // A private path the owner closed to the agents (privatePaths read:false): deny before anything else.
  const cfg = require('./lib/queueConfig.js').config();
  const closed = require('./lib/privatePaths.js').readDenied(abs, { root: cfg.root, cfg });
  if (closed) {
    process.stdout.write(
      JSON.stringify(
        HK.deny(
          'PreToolUse',
          `read-guard: ${closed.line} is private, and the owner has closed it to the queue's agents (privatePaths, "read": false). ` +
            'Do not read it another way either; if the task needs something from it, say so in your report and the owner decides.',
        ),
      ),
    );
    logDeny(input, 'private-path');
    return;
  }
  // The line count is needed when limit is missing (large files, the block limit and the read hint).
  const countLines = ti.limit == null ? tallyLines(abs) : null;
  const answer = V.assessReading({
    agentType,
    filePath: abs,
    offset: ti.offset,
    limit: ti.limit,
    countLines,
    maxLines: MAX,
    rules,
  });
  if (!answer) {
    readHint(input, agentType, abs, ti, countLines);
    return;
  }
  process.stdout.write(JSON.stringify(HK.deny('PreToolUse', answer.reason)));
  logDeny(input, answer.rule ?? 'read-limit');
}

/** One row in the time log for a denial (lib/guardLog.js, guardLog.enabled): the rule, never the path. Never throws. */
function logDeny(input, rule) {
  try {
    require('./lib/guardLog.js').recordHook({ guard: 'read', rule, decision: 'deny', input });
  } catch {
    // error-ignored: measurement only
  }
}

main()
  // No process.exit here: stdout must be flushed before the process exits (the guard timer is unref'd).
  .catch(() => undefined); // error-ignored: the guard fails open and must never stop an agent
