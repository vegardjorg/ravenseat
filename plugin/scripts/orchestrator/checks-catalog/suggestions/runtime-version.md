---
title: Pin the runtime version
category: dependencies
priority: low
when: known-stack, runtime-unpinned
content_min: 15
why: When the Node, Python or other runtime version is not written down, each machine, CI and agent uses whatever it has. A test can pass on one and fail on another for that reason alone.
---

## Investigate

- Which runtime version does the project use now, on your machine and in CI?
- Which file fits: .nvmrc or engines in package.json for Node, .python-version or requires-python for Python, .tool-versions or mise.toml for several.

## Plan and build

- The version written in that file, and CI reading it (for example setup-node with node-version-file).
