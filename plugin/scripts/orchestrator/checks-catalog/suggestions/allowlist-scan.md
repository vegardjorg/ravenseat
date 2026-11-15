---
title: Look for keys in the commands Claude Code approved
category: security
priority: medium
when: off:secretScan.allowlist
important_when: allowlist-tracked-hit
content_min: 1
action: setting
setting: secretScan.allowlist
why: Claude Code's "Yes, and don't ask again" stores the whole command, so a key typed in it sits in clear text in .claude/settings.local.json, or in the tracked .claude/settings.json. Turned on, doctor names such a command by file and index, never the key. High when a quiet look found one in a tracked file.
---
