---
title: Run the migrations from an empty database in CI
category: database
priority: medium
when: has-migrations, has-ci, none-in-ci:migrate
content_min: 45
why: A migration that only works on a database that already has yesterday's data fails on a new machine, a new environment or a teammate's clone. Running every migration from empty in CI catches that on the push, before anyone deploys it.
---

## Investigate

- How is a database built from the migrations today (supabase db reset, prisma migrate deploy, alembic upgrade head, rails db:prepare, a script)? Does it work from an empty database on a clean machine?
- What does CI need for it: a database service container, the CLI, and how long it takes.

## Plan and build

- One CI step that starts an empty database and runs every migration from the first, failing the run on any error.
- When database probes exist, run them right after, against that same fresh database.
- Keep it to pushes that change migrations or database code if the minutes matter (a paths filter).
