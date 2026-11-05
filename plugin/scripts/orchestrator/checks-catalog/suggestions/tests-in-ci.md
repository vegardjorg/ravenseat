---
title: Run your tests in CI
category: ci
priority: high
when: has-ci, not-in-ci:test
content_min: 30
why: You have tests and you have CI, but cq cannot see that CI runs the tests. A push can then be green with broken behavior.
---

## Investigate

- Read the CI files: is there really no test step, or is it hidden in a script cq did not recognize? If it is there, say so and stop.
- Do the tests need anything a clean machine lacks? How long do they take?

## Plan and build

- One test step in the existing workflow, using the same command as gates.quick.
- The cost in CI minutes per month, and a cheaper split if it is high (for example full tests on the base branch only).
