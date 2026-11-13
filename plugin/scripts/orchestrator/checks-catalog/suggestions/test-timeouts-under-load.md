---
title: Keep tests stable when several runs share the machine
category: tests
priority: low
when: has-gates, found:test
content_min: 30
why: Tests that pass alone and fail with timeouts when several runs share the machine cost a fix round each time, with nothing wrong in the code.
---

## Investigate

- Which gate commands were red with a timeout while `min_free_memory_pct` was low, or flaky (the `gate` and `flakyGate` rows, `ravenseat gates --health`)? Does the load factor there say the machine was busy (high now, low on a calm machine)?
- Which of those tests share state between runs: a fixed port, a fixed temp path, one database, a file in the repo?
- Which tests take locks, change a schema or need a whole service? Do they run next to other tests today?

## Plan and build

- Give each run its own temp folder, port and database name, or roll back each test's changes.
- Move tests that need to run alone, or that run for minutes, into their own command in the full gate, so they take their turn in the gate queue.
- Keep the time budgets. Raise one only when the test is slow alone too, on a calm machine; compare a red run's load factor against a calm run before changing anything.
- Show the result on the same commands: fewer flaky or timed-out rows over the next runs, with the same tests.
