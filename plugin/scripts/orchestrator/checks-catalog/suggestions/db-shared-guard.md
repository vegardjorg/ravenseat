---
title: Never run probes against a shared database
category: database
priority: medium
when: off:dbGuard.localOnly, has-database
content_min: 1
action: setting
setting: dbGuard.localOnly
why: Probes write rows and test refusals, which is fine on a local database and harmful on a shared one. A DATABASE_URL still pointing at staging, or a command with --linked, is enough. Turned on, ravenseat refuses a probe gate (pg_prove, supabase test db, sqlx test) whose database is not localhost, 127.0.0.1, ::1 or a Docker service name, before it runs. A short single-word host counts as a Docker service name, and a URL inside a file is not read. Probes are heavy, so they also wait their turn in the gate queue.
---
