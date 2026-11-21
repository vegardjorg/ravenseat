# Decision section for a large plan

| | |
|---|---|
| Applies to | A plan of size L or XL, or one that touches a sensitive zone (catalog kind `zone`) |
| Where it goes | A section in the plan's own investigation document. No new document type |
| Linked as | A source with role `decision` on the plan entry, with the section as anchor |
| Checked by | `ravenseat plan get` (Decision: missing, incomplete, skipped or done) and `plan edit … maturity=ready` |
| Settings | `plans.decisionNote` (on), `plans.readyCheck` (`advisory`; `block` refuses the edit, `off` says nothing) |

One page of thinking before a large build, not a ceremony. It asks the questions people skip when they are keen to
build: is this a real need, what does done look like, what is out, what else could we do, what will it cost, when do we
stop, and what is the strongest case against it. Write it in plain words; a line or two per heading is often enough.

## How to use it

1. `/plans <id>` writes the section for an L, XL or zone plan, as part of the investigation document (copy the
   headings below; the check looks for them by name, as markdown headings or bold labels).
2. Link it: `ravenseat plan edit <id> --set '{"sources":[…, {"path":"docs/plan.md","anchor":"§ 9","role":"decision"}]}'`
   (the whole list, the old sources included).
3. `plan get <id>` says `Decision: done` when every heading is there. Setting the plan to `ready` without them prints
   one WARNING with what is missing (or is refused in `block` mode).
4. Not worth it for this plan? Record why: `ravenseat plan edit <id> --skip-decision "<one sentence>"`. The skip is
   shown on the plan, so it stays a visible choice.

## The headings

Copy these under one heading of your own (for example `## 9. Decision`).

```markdown
### Need and evidence
Who has the problem, and how do we know? An idea is not a need: name the request, the incident or the measurement.

### Success measure
What will be true when it works, and how will we see it? One or two measurable lines.

### Non-goals
What this plan will not do, even though someone might expect it.

### Alternatives
At least: do not build it, buy or integrate something, and the smallest version that would help.

### Cost
Tracks and hours (the plan's size), and what gets pushed back while this is built.

### Stop criteria
A state plus a date: "if <this> is not true by <date>, we stop or rethink".

### Strongest case against
Assume the plan failed three months from now. Why did it fail? (A premortem: write the honest reasons.)

### Cheapest test
The smallest experiment that would show we are wrong before most of the work is done.

### Reversibility
Only when the plan touches a sensitive zone. What will be built on this; what would going back cost in three months;
can it sit behind an interface, a flag, a versioned contract or an expand-and-contract step; what is the cheapest
experiment; which invariants must hold.
```
