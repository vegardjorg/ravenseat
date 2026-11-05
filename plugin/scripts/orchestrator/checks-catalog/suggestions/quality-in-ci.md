---
title: Run lint and type check in CI
category: ci
priority: medium
when: has-ci, not-in-ci:types|lint
content_min: 30
why: These are fast and catch many mistakes, but cq cannot see them in your CI. Someone pushing outside the queue skips them.
---

## Investigate

- Which of them is missing from CI, and do they pass today? Many old warnings change the plan.

## Plan and build

- A step with the same commands as the gates, usually the cheapest job in CI.
- If they fail today: a plan for the existing faults first, so CI does not start red.
