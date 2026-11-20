# Design choices

One file per choice: `D-0001-<slug>.md` (lower-case letters, digits and hyphens), with this frontmatter:

```markdown
---
id: D-0001
title: Client code goes through the service layer
status: proposed
paths: ["app/**", "components/**"]
invariant: Files under app/ and components/ never import the database client directly.
supersedes: null
plan: null
---
Context, the choice and what follows from it, in at most 30 lines.
```

When the invariant can be checked line by line, add a rule under `check:` (receive tries it on the added lines):

```markdown
check:
  forbid: "from ['\"]@db/client['\"]"
  hit: ["import { db } from '@db/client'"]
  miss: ["import { save } from '@/services/factory'"]
  mode: warn
```

- `forbid` is a regular expression (case matters); `hit` and `miss` are example lines it must and must not hit.
  `mode` is `warn` (the default) or `stop` (stops the merge only with `catalog.checkStop` on). Only an accepted
  choice enforces; a proposed one gives a note.

- `status`: `proposed`, `accepted` or `superseded`. Anyone may propose. Only the owner accepts:
  `ravenseat catalog accept D-0001 --by owner`. A status set to accepted by hand is unconfirmed: `catalog check`
  names it as an error, and it counts as proposed until the owner accepts it.
- `invariant`: one sentence that can be checked. It is the only text a track gets.
- `paths`: the files the choice applies to. `except` (optional): files inside them it does not apply to.
- `kind` (optional): `decision` (the default), `design`, `stack`, `dependency` or `not-building`.
- `source` on a `design` entry: where its tokens live, a path or a list (`["ui/tokens.css", "lib/theme.js#PALETTE"]`).
- To change an accepted choice, write a new one with `supersedes: D-0001`; its accept sets the old one to `superseded`.
- `plan`: the plan entry with the long version, if there is one. A plan entry links back with `decisions`.
