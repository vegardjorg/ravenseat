# The suggestions on the Checks tab

Every suggestion on the Checks tab and in `ravenseat checks` is a file here. No suggestion is written in code.

- `categories.json`: the categories, in the order they show (`key`, `title`, `text`).
- `suggestions/<key>.md`: one suggestion. The file name is its key.

To change them for one project, without touching the plugin, use the same layout in `docs/queue/checks/`:

| You want to | Do this |
| --- | --- |
| Add a suggestion | Add `docs/queue/checks/suggestions/<key>.md` |
| Change one | Add a file with the same name; it replaces the plugin's |
| Remove one | Add a file with the same name holding only a header with `off: true` |
| Add or change a category | List it in `docs/queue/checks/categories.json` with the same or a new `key` |
| Remove a category and its suggestions | List its key with `"off": true` |

## A template

```markdown
---
title: What the owner reads on the card
category: ci
priority: high
when: has-ci, not-in-ci:test
content_min: 30
why: One or two sentences, in plain words, on why this is worth doing.
---

## Investigate

What the agent finds out before anyone decides.

## Plan and build

What the plan covers, and what the build steps should and should not do.
```

`priority` is high, medium or low. `content_min` is the investigation's size in minutes. `also_task` names a task that does the
same work, so the card shows it as under way. Three kinds need no agent: `action: gates` sets the checks found as gates,
`action: packs` turns on the stack packs for the review signals (`ravenseat checks packs --apply`), and `action: ask` shows the text in its one section, `## Ask Claude`, for the owner to give Claude in their own session.
Use `ask` for a step a queue agent cannot take, such as the first commit (an agent's worktree is made from a commit).

`when` says when the suggestion applies. Comma means all must hold, and `|` means at least one of those kinds:
`has-git`, `no-git`, `no-commit` (no git, or git with no commit yet), `has-remote`, `has-ci`, `no-ci`, `has-gates`,
`no-gates`, `checks-found`, `secrets-open`, `known-stack`, `instructions-large`,
`packs-missing` (a pack for the stack is not on in `review.packs`), `stack-unpacked` (a known stack has no pack),
`missing:<kinds>`, `found:<kinds>`, `not-in-ci:<kinds>`.

The kinds are test, types, lint, build, coverage, secret-scan, audit, security, dep-updates and hooks.

A file with a mistake is left out, and `ravenseat checks` and the tab say what is wrong with it.
