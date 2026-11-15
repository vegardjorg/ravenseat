---
title: Protect the main branch on the remote
category: security
priority: medium
when: has-remote, branch-unprotected
content_min: 10
action: ask
why: The queue's guards run on this machine. On the host, anyone with write access, or a session with a token, can still force-push over the base branch or merge without CI. Branch protection or a ruleset closes that, and only you can turn it on. When gh is signed in, ravenseat asks GitHub once a day and hides this card once the branch is protected.
---

## Ask Claude

Check whether the base branch of this repo is protected on the git host. With gh, read the rulesets in force on the branch and the classic branch protection. Tell me in plain words what is missing: CI required before merge, no force-push, no deletion. Then show me the exact settings, or the gh command, that would turn it on, and what it changes for me and for the agents (for example whether I can still push directly). Change nothing on the host until I say yes.
