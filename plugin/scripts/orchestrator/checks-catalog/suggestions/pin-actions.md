---
title: Pin GitHub Actions to a commit SHA
category: security
priority: medium
when: has-ci, actions-unpinned
content_min: 30
why: A `uses:` line on a tag (actions/checkout@v4) runs whatever the tag points at today, and a tag can be moved. If an action's repo is taken over, the next run executes other code with your workflow's token. A 40-character commit SHA cannot be moved.
---

## Investigate

- Which `uses:` lines in .github/workflows point at a tag or a branch, and which actions are they?
- For each: the commit SHA of the version in use now, read from the action's own repo (for example `git ls-remote --tags`).

## Plan and build

- Each `uses:` pinned to the full SHA, with the version as a comment (`actions/checkout@<sha> # v4.2.2`), so a reader still sees the version.
- Dependabot or Renovate set up for github-actions, so the pins are kept current with a pull request instead of going stale.
- Local steps (`./`) and `docker://` images are left as they are.
