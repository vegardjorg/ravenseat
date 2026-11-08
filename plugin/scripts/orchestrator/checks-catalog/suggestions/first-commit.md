---
title: Put the project under git with a first commit
category: setup
priority: high
when: no-commit
content_min: 5
action: ask
why: Git keeps every version, so a bad change can be undone. Each agent works in its own copy of the project, made from your latest commit, so the queue cannot start work before there is one.
---

## Ask Claude

Put this project under git. Run git init if it is not a git repo yet. Add a .gitignore for this project that keeps secrets (.env files, keys), installed dependencies and build output out. Show me the list of files that will be committed, and make a first commit after I say yes. Do not push anything.
