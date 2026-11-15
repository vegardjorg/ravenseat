---
title: Add a .env.example
category: security
priority: low
when: env-no-example
content_min: 10
why: Your .env is ignored, so a new clone, CI or an agent's worktree has no list of the variables the project needs. A .env.example with the names and no values tells them, and keeps the real values out of git.
---

## Investigate

- Which variable names does .env have (names only, never the values)?
- Which of them are needed to run the tests and the gates?

## Plan and build

- A .env.example in git with every name and an empty or obviously fake value, and a line in the README on how to fill it.
