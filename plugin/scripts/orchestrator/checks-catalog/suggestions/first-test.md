---
title: Add a first automatic test
category: tests
priority: high
when: missing:test
content_min: 45
also_task: KS-CHECK
why: Nothing can tell whether a change broke something. One small test of what matters most is enough to start.
---

## Investigate

- Which behavior would hurt most if it broke? Name the top three, with the files.
- Which test runner fits the stack and what the project already uses?
- Can that behavior be tested without a database, network or login? If not, what is the smallest way?

## Plan and build

- One test of the most important behavior, the runner, and one command that runs it.
- Show that the test fails on a deliberate bug, then remove the bug.
- Set the command as a gate once it passes. Say what it does not cover.
