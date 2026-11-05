---
title: Run the fast checks before each commit
category: quality
priority: low
when: has-git, found:lint|types, missing:hooks
content_min: 30
why: A git hook catches mistakes on your own machine, also in work outside the queue. It adds a small wait to each commit.
---

## Investigate

- Which checks are fast enough to run on every commit (a few seconds)?
- Which tool fits the stack (pre-commit, husky, lefthook)? Does the project use one already?

## Plan and build

- One hook with the fast checks only, and how a developer installs it.
- Note: agents and CI do not rely on it, so it never replaces gates. cq will notice a new hook (gitSurface): say how to accept it.
