# Claim schema

This is the normative reference for warehaus claims. `warehaus lint` enforces
what is written here, as far as it can be checked without a model and without
network access.

## 1. Block syntax

A claim is a header in an HTML comment, a statement body, and a closing
comment:

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
The billing API returns all monetary amounts as integer cents. Divide by 100
before displaying them.
<!-- /claim -->
```

Form rules:

- The header starts with the exact line `<!-- claim` and ends with `-->` on
  its own line. The closing marker is `<!-- /claim -->` on its own line.
- The header is flat YAML, one field per line, lowercase keys. Quote a value
  in double quotes when it contains a colon, comma or quotes.
- No line in the header or the body starts with `#`. Headings live outside
  the block; a heading inside it shifts the document outline.
- Claim blocks do not nest.

Placement: the header is an HTML block and ends the current CommonMark
block. A claim therefore wraps one complete block (a paragraph, a whole
list, a whole table, a section body). Placed between two list items it
splits the list; placed between two table rows it breaks the table.

### Generated ranges

Claims with `maintenance: generated` carry one inner marker for the value
that `warehaus stand` writes:

```markdown
<!--gen:product-catalog-size-->1366<!--/gen-->
```

The marker id is the id of the enclosing claim, at most one range per claim.
Only the range is machine-owned; the surrounding text stays handwritten, and
a hand edit inside the range shows up as drift on `warehaus stand --check`.

## 2. Fields

| Field | Required | Value |
|---|---|---|
| `id` | all | kebab-case, `[a-z0-9]([a-z0-9-]*[a-z0-9])?`, unique across all areas |
| `type` | all | one of the seven types in section 3 |
| `sot` | all | a value from `[schema] sots` in warehaus.toml, or a prefix form: `code:<path>`, `adr:<nr>`, `person:<name>` |
| `maintenance` | all | `generated`, `verified`, `manual` |
| `as_of` | all | `YYYY-MM-DD`, date of the last successful check or generation, never in the future |
| `verify_cmd` | `access`, `metric`, `count`; expected with `maintenance: verified` | read-only command, exit convention in section 4 |
| `derivation` | `metric` | filter, formula and exclusions in plain language |
| `tolerance` | optional for `metric`, `count` | `<number>%`, e.g. `5%` |
| `valid_until` | `snapshot` | `YYYY-MM-DD`, after `as_of` |
| `decided_in` | `rule` | `ADR-NNNN`; the ADR must exist when ADR directories are configured |
| `source` | `experience` | person and date of the statement, e.g. `"Alex (operations), 2026-08-01"` |
| `confirmed_on` | `experience` | `YYYY-MM-DD`, last human confirmation |
| `evidence` | optional for `experience` | a supporting, not proving, check |
| `budget` | required once `verify_cmd` is set | `free`, `single_call`, `bulk` |
| `expected_exit` | optional, only with `verify_cmd` | a number, or `non-zero` for claims that state something does NOT work; there the failing command is the confirmation |
| `supersedes` | optional | comma-separated claim ids or `ADR-NNNN` |
| `superseded_by` | optional | like `supersedes`; a claim with this field is historical and no longer cited as current knowledge |

Unknown field names are a schema error, not a tolerated extra. Deliberately
not in the schema: confidence scores, embeddings, derived relation graphs.

## 3. Types

| Type | Holds | Extra required fields | Checked by |
|---|---|---|---|
| `structure` | field names, formats, semantics, API behavior | none | verify_cmd recommended, long interval |
| `access` | scopes, permissions, rate limits | `verify_cmd` | a command that separates the error classes: method missing, permission missing, parameter error (access exists) |
| `rule` | decided calculation and behavior rules | `decided_in` | your eval suite, not data comparison |
| `metric` | canonical reference values | `derivation`, `verify_cmd` | value against `verify_cmd`, optionally within `tolerance` |
| `count` | tallies | `verify_cmd`, `maintenance: generated` | `warehaus stand`; a hand edit is drift |
| `snapshot` | a measurement of one time window | `valid_until` | phrased as a measurement, never as a rule; reported as overdue after expiry, never auto-deleted |
| `experience` | non-derivable knowledge from a person | `source`, `confirmed_on`, `maintenance: manual` | periodic human reconfirmation instead of a command |

There is no type for "pitfall". A pitfall is one of the types above with a
consequence for action in its body.

## 4. Value ranges and verdicts

`maintenance`:

| Value | Meaning | Allowed for |
|---|---|---|
| `generated` | a script writes the value; a hand edit is drift | required for `count`, allowed for `metric` |
| `verified` | handwritten, machine-checkable via `verify_cmd` | every type except `experience` |
| `manual` | only a person can confirm the statement | only `experience` |

`budget` classifies what a verify command costs:

| Value | The command does | When it runs |
|---|---|---|
| `free` | code greps, local files, a local cache | on every `warehaus verify` |
| `single_call` | single API calls, counts, scope probes | batched runs with a request cap |
| `bulk` | full sweeps over a source | never automatically |

Exit convention for verify commands: 0 confirmed, 1 refuted, 2 not
checkable. `warehaus verify` maps command results to four verdicts, not
three, because most verify commands fetch rather than assert. A fetch that
exits 0 says nothing about whether the claim text is right:

| Verdict | When | Advances `as_of` |
|---|---|---|
| `confirmed` | a real assertion was green, `expected_exit` was met, or the generated value matches within tolerance | yes |
| `refuted` | an assertion was red, `expected_exit` was missed, the generated value is off, or a search no longer finds its pattern | no |
| `executed` | a fetch ran clean; whether the claim text is right needs a semantic cross-check | no |
| `unverifiable` | placeholder in the command, timeout, suspected write access, unexpected exit | no |

Two asymmetries carry this. A search (`grep`) that no longer finds its
pattern refutes the claim, because the spot the claim cites is gone; a
search that finds it only proves the spot exists, not that the prose next
to it is right. Absence proves, presence does not. And only commands listed
in `[verify] assert_patterns` count as assertions; guessing would report
every fetch as a confirmation.

## 5. Lint rules

Blocking (exit 1): unparseable header, unknown field, missing required
field, duplicate or malformed id, value outside its range (including `sot`),
dangling `supersedes`/`superseded_by`/`decided_in` references, a heading in
the body, `valid_until` not after `as_of`, `as_of` in the future, history
prose in the body ("the previous version said"; the statement carries only
the current state, predecessors live in git and in the supersede fields),
and a protected entity carrying a number outside its designated claim.

Gap list (non-blocking): expired snapshots, `as_of` older than the type's
interval, experience claims past their reconfirmation interval, claims with
`maintenance: verified` but no `verify_cmd` (except `rule`, which your eval
suite checks), and claims marked `superseded_by`.

The gap list does not block on purpose. If it did, every release would fail
on whichever snapshot happened to expire that week, and the gate would get
bypassed instead of read.
