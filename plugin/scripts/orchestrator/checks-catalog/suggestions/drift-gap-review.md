---
title: Add the gap review when a change drifts far
category: quality
priority: low
when: off:scopeNotes.driftGap, not-lite
important_when: ledger-recent:scope-drift
content_min: 5
action: setting
setting: scopeNotes.driftGap
why: Receive already says how many changed files lie outside the task's files and reads (NOTE drift), but nobody checks what the extra change does against the mission. With this on, the gap reviewer is added at receive when at least 4 changed files, and over 40 % of them, lie outside the task's files (scopeNotes.driftGapFiles and driftGapShare), with one reason line. It costs one reviewer run each time it fires, so it is off by default; a task that names no files never fires it. It turns important only when the finding log shows scope drift three times in one area within 30 days.
---
