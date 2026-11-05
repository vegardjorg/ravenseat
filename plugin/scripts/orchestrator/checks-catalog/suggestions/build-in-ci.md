---
title: Check that the project builds in CI
category: ci
priority: medium
when: has-ci, not-in-ci:build
content_min: 30
why: A build can break even when the tests pass. If the build is what goes live, you want to find out before it does.
---

## Investigate

- Is a build step really missing, or does a deploy step do it?
- How long does the build take, and does it need secrets or environment values?

## Plan and build

- A build step on the base branch or on pull requests, whichever costs less for what it catches.
- Keep it out of the agents' quick gates if it is slow.
