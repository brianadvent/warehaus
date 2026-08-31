---
name: warehaus
description: Work inside a warehaus project, a knowledge system where facts about business source systems live as verifiable claims. Use when the project has a warehaus.toml, when the user asks about claims or source-system knowledge, when a fact needs to be recorded or corrected, or before committing changes to knowledge files.
---

# warehaus

This project keeps operational knowledge as claims in Markdown files. A
claim states one fact, names its source of truth, carries an as-of date
and, where possible, a command that checks it. Your job is to answer from
claims, keep them current, and never let a number live in prose.

## Answering questions

1. Read the knowledge files listed under `[[areas]]` in `warehaus.toml`
   before answering from memory. When a claim and your prior knowledge
   disagree, the claim wins until a verify run refutes it.
2. Treat a claim with `superseded_by` as historical. Follow the chain to
   the living claim.
3. Check `as_of`. A stale claim is still the best available answer, but say
   so and offer to run `warehaus verify --only=<id>`.

## Writing and changing claims

The schema reference is `docs/claim-schema.md` in the warehaus repository.
The short version:

```markdown
<!-- claim
id: billing-amounts-in-cents
type: structure
sot: billing-api
maintenance: verified
verify_cmd: "grep -q amounts_in_cents docs/billing-api.md"
budget: free
as_of: 2026-08-31
-->
The billing API returns all monetary amounts as integer cents.
<!-- /claim -->
```

- Seven types: `structure`, `access`, `rule`, `metric`, `count`,
  `snapshot`, `experience`. Pick the one whose required fields you can
  fill honestly.
- The `sot` value must be listed under `[schema] sots` in `warehaus.toml`
  (or use the prefix forms `code:`, `adr:`, `person:`). Add a new source to
  the config before the first claim uses it.
- When the user corrects a fact, update the existing claim instead of
  adding a duplicate. Replace the statement text with the current state;
  history lives in git and in `supersedes`/`superseded_by`, never in the
  prose. The lint blocks phrases like "the previous version said".
- A retrievable number never goes into prose. Counts belong in a `count`
  claim with a `<!--gen:id-->...<!--/gen-->` range plus a matching
  `[[stand.values]]` entry; everywhere else, reference the claim id.
- Give every `verify_cmd` a `budget` (`free`, `single_call`, `bulk`) and
  keep it read-only. For a claim that states something does NOT work, set
  `expected_exit: non-zero` so the failing command counts as confirmation.

## Before committing knowledge changes

Run `warehaus lint`. It blocks on form errors (exit 1) and prints a
non-blocking gap list. `warehaus contradictions` finds the same number in
two places and dead references; run it after larger edits.

## Reading verify results

`warehaus verify` has four verdicts, and the distinction is the point of
the whole system:

- `confirmed`: a real assertion passed. Only this advances `as_of`.
- `refuted`: the claim is wrong or the spot it cites is gone. Tell the
  user; fix the claim only when the correct fact is established.
- `executed`: the command ran clean, which says nothing about whether the
  claim text is right. Never report this as confirmation. Offer the
  semantic cross-check: compare the command output in the JSON report
  against the claim text.
- `unverifiable`: placeholder, timeout, or suspected write access. The
  claim needs a better command, not a shrug.

`warehaus stand --check` reports drift in generated counts; `--write`
updates the ranges. Never edit the text between gen markers by hand.
