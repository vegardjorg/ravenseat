---
title: Put the lockfile in git
category: dependencies
priority: medium
when: lockfile-missing
content_min: 20
why: Without a lockfile in git, every install, in each agent's worktree, in CI and on a teammate's machine, can pick newer versions than the ones that were tested. A run can then go red because a library changed overnight. The same rule as the lockfile row in ravenseat doctor.
---

## Investigate

- Which manifest has no lockfile in git (`ravenseat doctor`, the lockfile row), and is there a lockfile on disk that is ignored?
- Is the project an application (commit the lockfile) or a library that is published (often fine to skip, but say so)?

## Plan and build

- Create the lockfile with the project's package manager and commit it; remove it from .gitignore if it is there.
- CI and the gates install from the lockfile (npm ci, pip install from the lock, cargo build --locked).
