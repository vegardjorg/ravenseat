---
title: Check the project's own .gitignore
category: security
priority: low
when: off:gitignoreCheck.enabled
important_when: gitignore-gap
content_min: 1
action: setting
setting: gitignoreCheck.enabled
why: Your global gitignore only exists on your machine. Turned on, doctor checks that the project's own .gitignore keeps your personal settings and the queue's data out of git for a teammate's clone and CI too, and that git tracks none of it. High when a quiet look found the personal settings not ignored by the project, or a tracked file in the queue's data.
---
