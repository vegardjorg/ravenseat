---
title: Check the environment before a long test run
category: tests
priority: low
when: has-gates, found:test
content_min: 20
why: When a gate needs a server, a container or a test account that is not there, every test fails one by one, sometimes for an hour, and the red looks like broken code.
---

## Investigate

- Which gate commands need something outside the code to answer: a local server or port, a container, a database, a test account, a key in the environment?
- How does a run look today when one of them is down: how long until it is red, and how many tests fail?

## Plan and build

- A short precheck at the start of those gate commands (or as the first command of the gate) that checks each need and stops with one line saying what is missing and how to start it.
- The precheck takes seconds, never changes anything, and reads no secret values into its output.
- Show on one real run that a stopped service gives that one line in seconds, instead of a long list of red tests.
