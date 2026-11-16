---
title: Check that a fix's new test fails without the fix
category: tests
priority: low
when: red-on-base-off, found:test
content_min: 5
action: ask
why: A test that passes with or without a change shows nothing about it, and a fix without such a test lets the same bug come back unseen. With the test command set, receive runs the track's new tests on the code without its change and says when none of them fails. Fix tasks with nothing to show are logged as fixed without test. It is a warning, never a stop, unless you turn on the strict mode.
---

## Ask Claude

Set up Ravenseat's red on base check for this project. Find the command that runs only the test files given to it (for example `npx vitest run {files}`, `pytest {files}`, or `go test {dirs}` for Go, where {dirs} is the folders of the test files), and show me that it runs one test file on its own and fails when that test fails. Then put it in queue.config.json as `"gates": { "redOnBase": "<command>" }` and run `ravenseat doctor`. Leave `gates.redOnBaseStrict` off unless I ask for it: it makes merge stop on a fix without a test that fails without it. Do not change anything else.
