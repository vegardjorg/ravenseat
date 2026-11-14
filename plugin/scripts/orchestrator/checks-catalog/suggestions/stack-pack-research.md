---
title: Research review signals for a stack without a pack
category: security
priority: low
when: stack-unpacked
content_min: 60
why: Your project uses a stack that ravenseat knows but has no pack for yet. Without one, the security reviewer is asked only on the generic signals, so a risky call of that stack can pass without a security review.
---

## Investigate

- Which calls in this stack sign people in, run raw SQL, open access, turn off CORS or CSRF, read untrusted data into objects, run a shell or code from data, take uploads or switch off TLS?
- How the project uses the stack today: which of these calls are in the code already (count them, do not list secrets or data).
- Words that hit those calls and not their safe neighbours. Avoid the lookahead trap `\s*(?!...)`: write `\s*(?!\s*...)`, or the spaces satisfy the lookahead.

## Plan and build

- A pack file for docs/queue/review-packs/<id>.json, written in full in track-result.md (the owner copies it in): id, title, detect (the package names in the manifests), signals with words and paths, and examples: at least two lines that must hit and two that must not.
- Which reviewer each signal asks, and why the words do not fire on ordinary code.
- After the owner adds the file, the Checks tab offers the pack, and `ravenseat checks packs --apply` turns it on.
