---
name: nightly-loop
description: Run an unattended maintenance pass over a warehaus project that ends in at most one pull request for a human to review. Use for scheduled or overnight runs that check claims for drift, refutations and contradictions, or when the user asks for a maintenance run, nightly job, or knowledge triage.
---

# Nightly loop

An unattended run may find problems and propose fixes. It never merges
them. A knowledge system that corrects itself without a human looking is
the failure mode this system exists to prevent, so the loop's output is
one reviewable pull request, or nothing.

## Preconditions

- A dedicated checkout with a clean working tree. Abort if it is dirty.
- A protocol file (for example `.warehaus/nightly.jsonl`, one JSON object
  per handled finding with id and date). Read it first; a finding already
  raised in an open pull request is skipped, not raised again.

## The run

Execute in this order, all with `--json`, and collect the reports:

1. `warehaus lint`: form errors block everything else; a red lint means
   the last human edit broke the files, and that is the only finding
   worth raising tonight.
2. `warehaus stand --check`: drift in generated counts.
3. `warehaus verify --budget=single_call`: refutations first. Respect the
   budget; `bulk` commands never run unattended.
4. `warehaus contradictions`: conflicts, then notices.

## Triage

Rank what came back: refuted claims, then drift, then conflicts, then the
gap list. Pick **one** finding, or one tight cluster with a single cause,
and leave the rest for the next night. Ten fixes in one pull request get
skimmed; one fix with evidence gets reviewed.

## The fix

- Work on a branch, never on the default branch.
- Edit claims by the standing rules: replace the statement text with the
  current state, move predecessors into `supersedes`/`superseded_by`, no
  history prose. For drift, run `warehaus stand --write` instead of
  editing gen ranges by hand.
- A refuted claim whose correct value you cannot establish tonight gets
  reported in the pull request, not guessed.
- Run `warehaus lint` again before committing.

## The pull request

Open one pull request with the verify or check output quoted in the body
as evidence, and append the finding to the protocol file in the same
branch. Then stop. A human merges, or closes with a comment that becomes
the next night's context.
