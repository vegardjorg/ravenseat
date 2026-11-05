---
title: Keep secret files out of git
category: security
priority: high
when: has-git, secrets-open
content_min: 30
also_task: KS-SECRETS
why: A password or key in git can be read by anyone with the repo, also in old commits.
---

## Investigate

- Run `cq doctor` and read its `secrets` lines.
- Which secret files are not ignored, and is any key already in the git history? Name files, never values.

## Plan and build

- Ignore rules and an example file with variable names only.
- A key already in the history must be changed by the owner, because removing the file does not clean the history: list which ones.
