---
title: Test your database rules
category: database
priority: medium
when: has-database, missing:db
content_min: 60
why: The rules that keep one user out of another's data, the constraints and the functions that must refuse live in the database, so only a test against a real database shows that they hold.
---

## Investigate

- Which rules does the database enforce today: access rules (row level security, grants, a user who must not see another user's rows), constraints and checks, and functions or triggers that must refuse a call?
- Can a local database be started from the migrations in one command (for example `supabase start`, `docker compose up db`, a test container), and how long does it take?
- Which probe tool fits the stack: pgTAP with `pg_prove` or `supabase test db` for Postgres, `sqlx test` for Rust, or the project's own test runner against a test database?

## Plan and build

- A first set of probes for the most important rules: a user sees only their own rows, a forbidden write is refused, a constraint stops bad data, a function refuses a caller without the right.
- Every probe that writes runs in a transaction that is rolled back at the end (`BEGIN; ... ROLLBACK;`), and only against a local database, never a shared or remote one. The card "Never run probes against a shared database" turns on a guard for that.
- Probes are heavy: run them as their own gate command, so the gate queue (gateQueue) gives them a slot and they do not compete with every track's quick tests. Say how long a run takes.
- The probes live in a usual folder (supabase/tests/, db/tests/ or tests/sql/), so ravenseat finds them.
