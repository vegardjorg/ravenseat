---
title: Make Claude's instructions smaller
category: instructions
priority: medium
when: instructions-large
content_min: 5
action: ask
why: Claude Code loads your CLAUDE.md files, the rules without paths: and their imports in every session, track and subagent. A large set costs tokens on every turn and takes attention from the task, and long files are followed less well. Rules for one area can load only when Claude works there.
---

## Ask Claude

Run `ravenseat instructions` and show me the table and the suggestion for each section. Then propose how to split my instructions: keep the rules that apply everywhere in the root CLAUDE.md, move the rules for one area to `.claude/rules/<topic>.md` with `paths:` for that area, move step-by-step procedures to a skill, and remove what Claude can read from the code itself. A rule that is written in several files should live in one place, with a short pointer from the others. Moving text into an `@` import does not help: an import is loaded anyway. Add one line to the root: before the first Write in a folder, Read an existing file there, so its rules load. Show me the plan and the diff before you change any file, and change nothing until I say yes. Run `ravenseat instructions` again afterwards and show me the numbers before and after.
