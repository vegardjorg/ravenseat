---
title: See what the tests do not reach
category: tests
priority: low
when: found:test, missing:coverage
content_min: 30
why: A coverage report shows which code no test touches. It shows where to add tests, not that the tests are good.
---

## Investigate

- Which coverage tool fits the test runner, and how much slower does it make the run?
- Which important code does no test reach today?

## Plan and build

- A command that prints coverage, used when someone asks, not as a gate.
- A short list of the riskiest untested code as test proposals. No percentage target unless the owner wants one.
