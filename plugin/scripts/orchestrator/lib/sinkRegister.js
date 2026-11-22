// =============================================================
// sinkRegister.js: the register of write sites for agent text (roadmap 0æ N2).
//
// Why: agent text (a transcript, a track's report or last answer, a gate or done command's output, a remark any agent
// can pass to the time log) can hold a secret the agent printed. Redaction existed in several places, but nothing
// listed where agent text is stored, so a new module could store it raw and nobody would notice. This register is
// that list, and the guard test (lib/__tests__/sinkRegister.test.ts) keeps it true:
//   - a module that writes files AND reads agent text (AGENT_TEXT below) must have a row here;
//   - a row's `route` must be one of ROUTES, and its `token` must appear in the module (the call that redacts);
//   - a row for a module that does not store agent text (route `metadata`) must say why.
// A new write site is added here with the route it takes; the default route is lib/storeText.js (redact first, cut
// after, withheld when the redaction fails).
//
// Data only, no I/O. Paths are relative to scripts/orchestrator/.
// =============================================================
'use strict';

/** The routes: how a write site keeps secrets out. */
const ROUTES = Object.freeze({
  storeText: 'lib/storeText.js: the shared redaction (lib/askBundle.js redact), cut after it, withheld on failure',
  tailOf: 'lib/doneCheck.js tailOf: only the tail is kept, redacted first through lib/storeText.js',
  redact: 'lib/askBundle.js redact directly (the same patterns), with its own size cap',
  own: 'its own stricter redaction (named in `token`), documented in the module header',
  metadata: 'stores no agent text: ids, counts, times or state only (`why` says what)',
});

/** What marks a module as reading agent text. */
const AGENT_TEXT = /\b(tailOf|transcriptTail|lastTrackReply|trackReport|readTail)\(|track-result\.md|handover\.md|val\('--remark'\)/;
/** What marks a module as writing files. */
const WRITES = /\b(writeFileSync|appendFileSync|writeFile|appendFile|createWriteStream|appendText)\(/;

const row = (file, route, token, what) => Object.freeze({ file, route, token, what });

const SINKS = Object.freeze([
  // Stores agent text, through a redaction.
  row('lib/doneCheck.js', 'storeText', 'storeText(', 'the tail of a done command or gate run (done-<id>.md, gates-<id>.md, the fix brief)'),
  row('cli/merge.mjs', 'storeText', 'storeText(', "the track's last answer (trackReply.md); gate and done tails through tailOf"),
  row('cli/run.mjs', 'tailOf', 'tailOf(', 'the done and gate tails in the fix brief'),
  row('log-time.mjs', 'storeText', 'storeText(', "the time log's remark (any agent can pass one)"),
  row('lib/askBundle.js', 'redact', 'redact(', 'the ask bundle: mission, report, handover, transcript tail'),
  row('cli/ask.mjs', 'redact', 'buildBundle(', 'writes the bundle lib/askBundle.js built and redacted'),
  row('lib/findingLog.js', 'redact', 'redact(', 'the finding excerpt (redact plus the secret scan per word; withheld on a hit)'),
  row('lib/failureSignature.js', 'redact', 'redact(', 'the short first error line per red command and CI job'),
  row('lib/ciWatch.js', 'redact', 'redact(', 'the failed CI jobs\' log tail'),
  row('lib/silentSnapshot.js', 'own', 'redactText(', 'the SILENT snapshot: transcript tail, jobs, process command lines (Y4)'),
  // Reads agent text, but what it writes is metadata.
  row('lib/approvalWait.js', 'metadata', null, 'agent id, tool name and time of a permission wait'),
  row('lib/trackGuard.js', 'metadata', null, 'the compaction count cache: transcript positions and counts'),
  row('lib/usageLimit.js', 'metadata', null, 'the usage-limit pause: times only'),
  // Names track-result.md only in the update task's mission text; it reads no agent text.
  row('lib/osv.js', 'metadata', null, 'the dependency audit cache: package names, versions and OSV.dev advisories, no agent text'),
  row('cli/orchestrator.mjs', 'metadata', null, "the orchestrator's own handover note and follow reports, no track text"),
  row('hook-context.mjs', 'metadata', null, 'the pulse cursor and the cost guard state'),
  row('hook-track-context.mjs', 'metadata', null, 'per-agent state: which notices fired, compaction counts'),
  row('hook-track-end.mjs', 'metadata', null, 'per-agent state: the track id and the time of a block'),
]);

module.exports = { ROUTES, AGENT_TEXT, WRITES, SINKS };
