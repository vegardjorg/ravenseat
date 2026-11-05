---
title: Scan the code for known security mistakes
category: security
priority: low
when: has-ci, missing:security
content_min: 45
why: A scanner finds common holes such as injection. It is most useful when the code handles logins, money or personal data.
---

## Investigate

- Does this project handle logins, payments or personal data? If not, this may not be worth it: say so.
- Which scanner fits, what does it cost on the owner's plan, and how much noise does it give?

## Plan and build

- One scanner on the base branch, on a schedule if that costs less.
- Decide what a finding does: a note first, a stop only when the noise is low.
