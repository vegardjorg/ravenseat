// =============================================================
// cli/ask.mjs: `ravenseat ask <id> ["<question>"] [--bundle] [--json] [--max-chars <n>] [--out <file>] [--scratchpad <dir>]`.
//
// Answers a question about an earlier track's work WITHOUT resuming the track agent. It gathers what the track left
// behind, builds one compact, size-capped and secret-redacted bundle (lib/askBundle.js) and either:
//   - prints it with an instruction for the orchestrator chat to answer from it (no flag), or
//   - writes it to a file and prints the path (--bundle), for the /ravenseat:ask skill, which hands the file to the read-only
//     `ask` agent (plugin/agents/ask.md) that answers in one paragraph with file:line or commit references.
// --json prints { ok, id, question, path, chars, cap, redactions, redactionRules, sections, bundle? } instead.
//
// What goes in (each part is redacted, then cut to its share of the cap):
//   - the task's identity and the queue's notes: status and times, result, remarks, blocks, findings, the done check,
//     the owner questions it waited on with their answers, and the changelog entries that touched it;
//   - the mission (the file or the text), track-result.md and handover.md (lib/logic/resume.js findTrackReport, in the
//     orchestrator's scratchpad and the one saved on the task, also fix round folders <id>-r<N>);
//   - git: the branch's commit messages and diffstat against baseBranch; for a merged track the merge commit's two
//     sides; otherwise the commits on baseBranch that name the id;
//   - the tail of the newest build agent's transcript (the agents come from the time log as in `cost` and `receive`:
//     queueLogic.agentsForTask, plus rows whose track label is the task). Only the last TAIL_BYTES are read, so a
//     huge transcript costs nothing; tool output is left out.
//
// Read-only: it never writes the queue, the time log or the track's files (it does NOT call taskAgents, which records
// killed agents). The only file written is the bundle with --bundle (default <scratchpad>/ask-<id>/bundle.md, or
// <dataFolder>/ask/<id>.md without a scratchpad).
//
// Used by: queue.mjs (`ask`), skills/ask/SKILL.md. Tested in: lib/__tests__/askBundle.test.ts.
// =============================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { a, BASE, branchFor, FOLDER, L, MAIN_TREE, positional, read, readMission, TK, val } from './context.mjs';
import { gitLarge, readTimeLog, trackRoots } from './tracks.mjs';
import { createRequire } from 'node:module';

const AB = createRequire(new URL('../queue.mjs', import.meta.url))('./lib/askBundle.js');

// The transcripts folder, as in cli/tracks.mjs (QUEUE_TRANSCRIPTS overrides, tests).
const TRANSCRIPTS =
  process.env.QUEUE_TRANSCRIPTS ??
  path.join(os.homedir(), '.claude', 'projects', MAIN_TREE.replace(/[^A-Za-z0-9]/g, '-'));

/** The flags that take a value (so their value is not read as the question). */
const WITH_VALUE = ['--max-chars', '--out', '--scratchpad', '--session'];

/** The path to an agent's transcript (<projects>/<session>/subagents/agent-<id>.jsonl), or null. */
function findTranscript(agentId) {
  let sessions;
  try {
    sessions = fs.readdirSync(TRANSCRIPTS, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return null;
  }
  for (const d of sessions) {
    const filePath = path.join(TRANSCRIPTS, d.name, 'subagents', `agent-${agentId}.jsonl`);
    if (fs.existsSync(filePath)) return filePath;
  }
  return null;
}

/** `length` bytes of a file from `start` as UTF-8 (a cut multibyte character only spoils one line), or null. */
function readSlice(filePath, start, length) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(length);
    const n = fs.readSync(fd, buf, 0, length, start);
    return buf.subarray(0, n).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd != null) fs.closeSync(fd);
  }
}

/** The tail of a transcript: { text, fromStart, size } or null. */
function readTail(filePath) {
  try {
    const size = fs.statSync(filePath).size;
    const start = Math.max(0, size - AB.TAIL_BYTES);
    const text = readSlice(filePath, start, size - start);
    return text == null ? null : { text, fromStart: start === 0, size };
  } catch {
    return null;
  }
}

/**
 * The agents of the task from the time log, newest first: the certain ones (track label = the task or a fix round),
 * the uncertain ones only when the start of their transcript names the id. Never writes anything.
 */
function agentsOf(o) {
  const rows = readTimeLog();
  const from = o.started ?? o.picked_at ?? o.added_at ?? null;
  const isId = (x) => x === o.id;
  const found = new Map();
  const add = (agent, type, time, uncertain = false) => {
    const prev = found.get(agent);
    if (!prev || Date.parse(time) > Date.parse(prev.time)) found.set(agent, { agent, type, time, uncertain });
  };
  const { secure, uncertainOnes } = L.agentsForTask(rows, o.id, { from });
  for (const x of secure) add(x.agent, x.type, x.row.time);
  for (const x of uncertainOnes) add(x.agent, x.type, x.row.time, true);
  // An agent without a done row (killed, or still running) still has its start row with the track label.
  for (const r of rows) {
    if (r?.agent_id && r.track && TK.taskIdFor(r.track, isId) === o.id) add(r.agent_id, String(r.agent_type ?? 'unknown').replace(/^.*:/, ''), r.time);
  }
  const out = [];
  for (const x of found.values()) {
    const filePath = findTranscript(x.agent);
    if (x.uncertain) {
      const head = filePath ? readSlice(filePath, 0, 64 * 1024) : null;
      if (!head || !L.mentionsTask(head, o.id)) continue;
    }
    out.push({ ...x, path: filePath });
  }
  return out.sort((p, q) => Date.parse(q.time) - Date.parse(p.time));
}

/** The transcript part: the tail of the newest build agent (otherwise the newest agent at all). */
function transcriptPart(o) {
  const agents = agentsOf(o);
  if (!agents.length) return { missing: 'no agent for this task in the time log' };
  const withFile = agents.filter((x) => x.path);
  const pick = withFile.find((x) => TK.isBuildAgent(x.type)) ?? withFile[0];
  const list = agents.map((x) => `${x.agent} (${x.type}, ${x.time ?? '?'}${x.path ? '' : ', no transcript'})`).join('; ');
  if (!pick) return { missing: `no transcript file found for the agents: ${list}` };
  const tail = readTail(pick.path);
  if (!tail) return { missing: `could not read ${pick.path}` };
  const text = AB.transcriptTail(tail.text, { fromStart: tail.fromStart });
  const kb = Math.round(tail.size / 1024);
  return {
    source: `agent ${pick.agent} (${pick.type}), ${kb} KB transcript, last ${Math.min(kb, AB.TAIL_BYTES / 1024)} KB read`,
    text: `Agents of this task: ${list}\n\n${text || '(no assistant text in the tail)'}`,
  };
}

/** The git part: commits (subject and body) and the diffstat. */
function gitPart(o) {
  const branch = o.branch ?? branchFor(o.id);
  const log = (range) =>
    gitLarge(['log', '--no-color', '--date=short', '-n', '60', '--format=%h %ad %s%n%w(0,4,4)%b', range]) ?? '';
  const stat = (range) => gitLarge(['diff', '--no-color', '--stat=120', range]) ?? '';
  let how = null;
  let commits = '';
  let diffstat = '';
  const exists = gitLarge(['rev-parse', '-q', '--verify', `refs/heads/${branch}`]) != null;
  if (exists && Number(String(gitLarge(['rev-list', '--count', `${BASE}..${branch}`]) ?? '0').trim()) > 0) {
    how = `branch ${branch}, ${BASE}..${branch}`;
    commits = log(`${BASE}..${branch}`);
    diffstat = stat(`${BASE}...${branch}`);
  }
  if (!how) {
    const merge = String(
      gitLarge(['log', BASE, '--merges', '-F', `--grep=Merge branch '${branch}'`, '-n', '1', '--format=%H']) ?? '',
    ).trim();
    if (merge) {
      how = `merge commit ${merge.slice(0, 10)} on ${BASE} (${branch} is merged)`;
      commits = log(`${merge}^1..${merge}^2`);
      diffstat = stat(`${merge}^1...${merge}^2`);
    }
  }
  if (!how) {
    const named = gitLarge(['log', BASE, '--no-color', '--date=short', '-F', `--grep=${o.id}`, '-n', '20', '--format=%h %ad %s%n%w(0,4,4)%b']) ?? '';
    if (named.trim()) {
      how = `commits on ${BASE} whose message names ${o.id} (no branch and no merge commit found)`;
      commits = named;
    }
  }
  if (!how) return { missing: `no branch ${branch}, no merge commit and no commit naming ${o.id} on ${BASE}` };
  return {
    source: how,
    text: `### Commits\n\n${commits.trim() || '(none)'}\n\n### Diffstat\n\n${diffstat.trim() || '(not available)'}`,
  };
}

/** A file as a bundle part, or a "missing" reason. */
function filePart(filePath, what) {
  if (!filePath) return { missing: `no ${what} found in the scratchpad folders` };
  try {
    return { source: filePath, text: fs.readFileSync(filePath, 'utf8') };
  } catch {
    return { missing: `could not read ${filePath}` };
  }
}

/** `ravenseat ask` (the usage is at the top of queue.mjs). */
export function cmdAsk() {
  const json = a.includes('--json');
  const fail = (message) => {
    if (json) console.log(JSON.stringify({ ok: false, error: message }));
    else console.error(message);
    process.exit(1);
  };
  const [id, ...words] = positional(1, WITH_VALUE);
  if (!id) fail('ask <id> ["<question>"] [--bundle] [--json] [--max-chars <n>] [--out <file>] [--scratchpad <dir>]');
  const queue = read();
  const o = (queue.tasks ?? []).find((x) => x.id === id);
  if (!o) fail(`Unknown task ${id}`);
  const question = words.join(' ').trim() || null;

  const mission = readMission(o);
  const found = L.findTrackReport(id, trackRoots(o));
  const parts = {
    task: { text: AB.taskHead(o) },
    mission: mission.error ? { missing: mission.error } : { source: mission.path, text: mission.text },
    report: filePart(found.report?.path, 'track-result.md'),
    handover: filePart(found.handover?.path, 'handover.md'),
    log: { text: AB.taskLog(o, queue), missing: 'the queue has no notes on this task' },
    git: gitPart(o),
    transcript: transcriptPart(o),
  };
  const b = AB.buildBundle({ id, question, parts, maxChars: val('--max-chars') });

  let file = null;
  if (a.includes('--bundle')) {
    const scratch = val('--scratchpad') ?? process.env.QUEUE_SCRATCHPAD ?? null;
    file = path.resolve(
      val('--out') ?? (scratch ? path.join(scratch, `ask-${id}`, 'bundle.md') : path.join(FOLDER, 'ask', `${id}.md`)),
    );
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, b.text);
  }
  if (json) {
    console.log(
      JSON.stringify({
        ok: true,
        id,
        question,
        path: file,
        chars: b.chars,
        cap: AB.capFrom(val('--max-chars')),
        redactions: b.redactions,
        redactionRules: b.redactionRules,
        sections: b.sections,
        ...(file ? {} : { bundle: b.text }),
      }),
    );
    return;
  }
  if (file) {
    console.log(file);
    console.log(
      `(${b.chars} characters, ${b.redactions} redacted; missing: ${b.sections.filter((s) => s.missing).map((s) => s.name).join(', ') || 'nothing'}). ` +
        'Hand it to the read-only ask agent (/ravenseat:ask), or read it and answer from it.',
    );
    return;
  }
  console.log(b.text);
  for (const l of AB.answerInstruction(id, question)) console.log(l);
}
