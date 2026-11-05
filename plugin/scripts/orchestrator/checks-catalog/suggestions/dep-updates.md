---
title: Get proposals when libraries have updates
category: dependencies
priority: low
when: has-remote, known-stack, missing:dep-updates
content_min: 30
why: Small regular updates are easier than one big jump later. It only makes sense when something checks each update.
---

## Investigate

- Which tool fits the host (Dependabot on GitHub, Renovate elsewhere)?
- Is there CI that would check the updates? Without it, this mostly adds work: say so.

## Plan and build

- A config with a weekly schedule, grouped minor updates and a small limit on open proposals.
- It runs on the host, so the owner turns it on: say how.
