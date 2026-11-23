---
title: Scan the repo and its history for keys
category: security
priority: low
when: has-git, keyscan-due
content_min: 5
action: ask
why: The push check reads only what a push is about to send. A key already in a tracked file, or added in an old commit and deleted since, is never seen by it, and every clone still has it. `ravenseat secrets scan --history` reads them in a few seconds, costs no tokens, changes nothing and never shows a value. This card shows when no scan has run yet, or when the last one is older than secretScan.rescanDays (0 turns the reminder off).
---

## Ask Claude

Run `ravenseat secrets scan --history` and tell me what it found: how many findings in the tracked files and how many only in the history, with file, line or commit and rule for each. Never print, quote or repeat a matched value, also not in part. If it found any, go through them with me one by one; change nothing and rewrite no history without asking me.
