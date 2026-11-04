// =============================================================
// clients/claude/mission.js: the Claude Code addendum to the mission text (plans: client adapters, phase 0).
//
// Why: the mission a track gets is mostly client-neutral (task, ownership, gates, git rules, the RESULT line,
// track-result.md and handover.md). The parts that name Claude Code tools or depend on how Claude Code runs (the Write and
// Read tools with offset/limit, SendMessage, the prompt cache, CLAUDE.md, the hooks behind the push guard) live here,
// so another client adapter can supply its own addendum and the core never asks which client it is.
//
// Source: the Claude Code tool names (Write, Read with offset/limit, Bash, SendMessage) and the queue's own Claude
// hooks (push guard, write guard). Verified 2026-11-03. The text is exactly what the mission had before the split, so
// the Claude output stays byte-identical (locked by lib/__tests__/claudeDispatchCompat.test.ts).
//
//   missionAddendum(ctx) the pieces, as plain strings:
//     template   values for the <CLIENT_*> placeholders in docs/mission-template.md (filled by missionText.js
//                makeQueueCommon; a line holding only a placeholder whose value is '' is dropped)
//     readExcerpts, newWorkWrite   inline pieces of the <READ_ALSO> and <OWNERSHIP> text (missionText.js)
//     reportOutside                the end of the ownership line in the track block (logic/external.js trackBlock);
//                                  ctx.cloud: the cloud session has no SendMessage, so it says "stop" instead
// Line breaks in the pieces are '\n'; makeQueueCommon turns them into the template's own line ending.
// Pure, no I/O; test: lib/__tests__/clientMissionClaude.test.ts.
// =============================================================

/**
 * The Claude Code addendum to the mission text.
 * @param {{ cloud?: boolean }} [ctx] cloud: the track runs as a cloud session (cloud-package), not as a subagent
 * @returns {{ template: Record<string, string>, readExcerpts: string, newWorkWrite: string, reportOutside: string }}
 */
function missionAddendum(ctx = {}) {
  return {
    template: {
      // Setup, after "File lock errors: try again."
      SCRIPTS: ' Write scripts with Write, never with a Bash heredoc or\n  `node -e "…"` containing backticks.',
      // Reading and context: what the client loads by itself.
      AUTOLOAD: '- `CLAUDE.md` and memory files are loaded automatically: never read them.',
      // Reading and context: how to read in excerpts with the client's tools, and the prompt cache.
      READING: [
        "- Documents the mission points to: `grep -n '^#'` on the file first, then only the pointed sections with",
        '  `offset`/`limit`. If `(line A–B)` follows the pointer, read exactly that range.',
        '- Files over about 300 lines: `grep -n` first, then Read with `offset`/`limit`. Never read whole neighbouring files',
        '  "for context", and never the same file in full twice.',
        "- Keep Bash output short: `grep … | head`, `sed -n 'a,bp'`, never `cat` of large files. Read gate logs in excerpts.",
        '- Make independent calls in the same turn. No sleep, poll or wait loops (the prompt cache expires after 5 minutes);',
        '  if a call answers `IN_PROGRESS` (in progress), continue with the command it prints.',
      ].join('\n'),
      // The trigger for the handover (the core says what to do when it is reached).
      CONTEXT_CAP: '**Context cap about 300k** (about 120 tool calls)',
      // The hook-based guards (pushGuard.js runs as a Claude PreToolUse hook).
      GUARDS: [
        '- Network calls (`curl`, `wget`, `Invoke-WebRequest`, `| sh` …) are blocked for tracks, reviewers and helper agents by the push guard, and',
        '  `npm install` or `npx` with a package that is not in `package.json` asks for confirmation: ask the orchestrator to',
        '  fetch it.',
        '- The push guard also denies every `git push` from a track, and every queue command except `prepare-track`, `gates`,',
        '  `show`, `info`, `help`, `blockers`, `finding`, `question`, `block`, `deliver` and `plan show|get` (no `merge`, `set`,',
        '  `edit`, `approve`, `resolve`, `undo`, `--allow-guard`, `--force` or `--by owner`). Your ownership (`owned_files`,',
        '  `shared_patch`) is fixed at the start: a path you need beyond it goes in the report.',
      ].join('\n'),
      // Decide or ask: how a question that blocks the whole track reaches the orchestrator.
      ASK_BLOCKING: '; SendMessage to the orchestrator only when\n  the question blocks the whole track',
      // Gates: what stops a track from writing the gate evidence or the queue files.
      EVIDENCE_GUARD: ' (a hook denies it)',
      // Report: the tool that writes track-result.md.
      REPORT_WITH: ' with Write',
      // Client code: the project instructions file the client loads (Claude Code: CLAUDE.md).
      INSTRUCTIONS_FILE: '`CLAUDE.md` and ',
    },
    readExcerpts: ' with `offset`/`limit`',
    newWorkWrite: ' with\nWrite',
    reportOutside: ctx.cloud
      ? 'if you need to, stop with CLOUD-STOP and say what is needed.'
      : 'if you need to, report it (SendMessage) instead of editing it.',
  };
}

module.exports = { missionAddendum };
