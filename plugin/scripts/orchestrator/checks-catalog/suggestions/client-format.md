---
title: Claude Code writes rows Ravenseat does not know yet
category: client
priority: medium
when: client-format-changed
content_min: 5
action: ask
why: Ravenseat reads Claude Code's transcripts for the time and cost log, the usage limit pause and the end gate. The newest transcript has rows it reads differently than expected: a row type it does not know, an assistant turn without token usage, or an API error of an unknown kind. Nothing is stopped and the queue keeps working on what it can read, but costs or limits may be counted short until Ravenseat knows the new form. The card names the version and the row types, never content. It goes away when the rows read as expected again, usually after an update of Ravenseat; client.canary off hides it.
---

## Ask Claude

Ravenseat's format canary says the newest Claude Code transcript in this project has rows Ravenseat reads differently than expected (the card names the Claude Code version and the row types with counts). Run `ravenseat doctor` and show me its `canary` row. Then check whether a newer Ravenseat is out, and tell me how to update it (`claude plugin update ravenseat@ravenseat`, then `/reload-plugins`). If the row stays after an update, help me write a short issue for Ravenseat with only the Claude Code version, the row types and counts from the card, and, if `client.shapeLog` is on, the shapes in `client-shapes.jsonl` in the data folder. Do not read, quote or paste any transcript text, and do not change queue.config.json without asking me.
