---
id: D-0004
title: Two-way sync with GitHub issues or other trackers
status: proposed
kind: not-building
keywords: ["two-way sync", "issue sync", "issues as source of truth", "webhooks", "GitHub webhook", "Linear", "Jira", "GitLab issues", "tracker integration"]
revisit: a user team asks for shared visibility without the board
source: plans/trailhead-gsd-skills-vurdering-2026-11-20.md
supersedes: null
plan: null
---
The queue is the source of truth. GitHub issues come in on the owner's command (`issues import`) and go out only as
the opt-in, previewed writes (`issues report`, `pr`, `release-notes --github`). Keeping a tracker in sync both ways,
letting issue edits change tasks, listening to webhooks or adding other trackers would let anyone who can write an
issue steer the queue, and would need a server and tokens the plugin does not keep. Not now.
