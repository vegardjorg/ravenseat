---
title: Warn a track when it writes outside its files
category: quality
priority: low
when: off:scopeNotes.driftWarn, not-lite
important_when: ledger-recent:scope-drift
content_min: 5
action: setting
setting: scopeNotes.driftWarn
why: A track learns that it drifted only at receive, after the whole round. With this on, the write guard gives the track one note per file, while it writes, when the file lies outside the task's files and reads. It is never a denial, and the note says not to stop for it alone but to name the file in the report. It is off by default, since a track may still stop and ask when the task's files were only a rough guess; a task that names no files never gets it. It turns important only when the finding log shows scope drift three times in one area within 30 days.
---
