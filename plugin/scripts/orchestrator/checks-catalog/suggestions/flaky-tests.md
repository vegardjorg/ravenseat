---
title: Find flaky tests
category: tests
priority: low
when: has-gates, found:test
medium_when: flaky-observed
content_min: 45
why: A flaky test is red now and green on the next run with no change in between. In a queue it costs a rerun each time, can block a track, and can send an agent looking for a bug that is not there. Medium once the time log shows a gate command red and then green on the same commit.
---

## Investigate

- Which gate commands were red and then green on the same commit (`ravenseat gates --health` shows the flaky ones per command)?
- For each: which test, and why: timing, order, shared state, the network, the machine's load?

## Plan and build

- A fix per flaky test, or a quarantine with a task to fix it, never a silent retry.
- A way to run a suspect test many times in a row, so a fix can be shown to hold.
