---
title: Look for keys in the commands Claude Code approved and in .mcp.json
category: security
priority: low
when: off:secretScan.allowlist
important_when: allowlist-tracked-hit
content_min: 1
action: setting
setting: secretScan.allowlist
why: Claude Code's "Yes, and don't ask again" stores the whole command, so a key typed in it sits in clear text in .claude/settings.local.json, or in the tracked .claude/settings.json. A key pasted into .mcp.json for an MCP server is usually tracked too, while ${NAME} there reads it from the environment instead. Turned on, doctor names such a place by file and path, never the key. High when a quiet look found one in a tracked file.
---
