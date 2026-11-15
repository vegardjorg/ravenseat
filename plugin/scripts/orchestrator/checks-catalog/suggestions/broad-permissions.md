---
title: Look for broad permissions in the shared settings
category: security
priority: low
when: off:permissionsCheck.enabled, shared-settings
important_when: bypass-tracked
content_min: 1
action: setting
setting: permissionsCheck.enabled
why: A rule in the tracked .claude/settings.json applies to everyone who opens the repo and to every agent. Turned on, doctor names the broad ones: any shell command, network tools such as curl and wget, rm, git push, WebFetch without a domain, and defaultMode bypassPermissions or acceptEdits. Narrow rules such as Bash(npm test:*) are never named. High when a quiet look found bypassPermissions in the tracked file, which turns off the questions for everyone who clones it.
---
