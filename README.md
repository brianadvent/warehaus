# warehaus

```
                          _
 __      ____ _ _ __ ___ | |__   __ _ _   _ ___
 \ \ /\ / / _` | '__/ _ \| '_ \ / _` | | | / __|
  \ V  V / (_| | | |  __/| | | | (_| | |_| \__ \
   \_/\_/ \__,_|_|  \___||_| |_|\__,_|\__,_|___/
```

**An intelligent data warehouse for AI agents.** No ETL, no copies: your
agent queries the source systems directly, guided by curated, verifiable
knowledge.

A classic data warehouse copies every source system into a central database
overnight and lets BI tools chart the copy. The copy is always one sync old,
the pipelines break on every API change, and the transformation knowledge
("amounts are in cents", "cancelled invoices carry a `cancel_id`") is buried
in pipeline code where nobody can read it.

Warehaus inverts this. An AI agent (Claude Code, Codex, OpenClaw, Hermes)
talks to the live APIs through thin CLI tools, and the transformation
knowledge lives next to the code as **claims**: plain-Markdown statements
with provenance, an as-of date and a command that checks each one against
its source. The warehouse holds no data. It holds what an agent must know
to get the data right, in a form the agent reads, obeys and maintains.

## A claim

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
before displaying them or adding them to figures from other systems.
<!-- /claim -->
```

Every claim names its source of truth (`sot`), how it is maintained, when it
was last checked and how to check it again. The full schema, with seven claim
types from `structure` to `experience`, is in
[docs/claim-schema.md](docs/claim-schema.md).

## The commands

```
warehaus init             scaffold a project: config, knowledge area, agent instructions
warehaus lint             form, required fields, value ranges, ID uniqueness, references
warehaus verify           run each claim's verify_cmd against the live source
warehaus contradictions   the same number in two claims, dead references, duplicates
warehaus stand            generated counts: collect, check for drift, write
```

All five share one exit convention (0 green, 1 red, 2 not runnable), so they
drop into any CI or release gate.

`verify` is the honest one. Most verify commands fetch rather than assert, so
it reports four verdicts instead of pretending exit 0 means true:

| Verdict | Meaning |
|---|---|
| `confirmed` | a real assertion passed, or the generated value matches |
| `refuted` | an assertion failed, or a search no longer finds the spot the claim cites |
| `executed` | the fetch ran clean; whether the claim text is right still needs a semantic cross-check |
| `unverifiable` | placeholder in the command, timeout, suspected write access |

Only `confirmed` advances the as-of date. A checker that counted every clean
fetch as a confirmation would report every claim green and guard nothing.

## Install

Python 3.11 or newer, no dependencies.

```bash
pip install git+https://github.com/brianadvent/warehaus.git
```

A PyPI release (`pip install warehaus`) comes with the first public version.

## Quickstart

```bash
mkdir my-warehaus && cd my-warehaus
warehaus init
```

This writes `warehaus.toml`, a `knowledge/` area with a claim template, and
the agent instruction files. Then:

1. List your source systems under `[schema] sots` in `warehaus.toml`.
2. Write your first claim in `knowledge/sources.md` (copy the template).
3. Run `warehaus lint`, then `warehaus verify`.

Or try the bundled example project, a fictional toy shop that runs entirely
offline:

```bash
git clone https://github.com/brianadvent/warehaus.git && cd warehaus
python3 -m warehaus --config example/warehaus.toml lint
python3 -m warehaus --config example/warehaus.toml verify
python3 -m warehaus --config example/warehaus.toml stand --check
```

## Use it with your agent

Warehaus is built to be operated by an agent, not by hand. You ask business
questions in a Claude Code (or Codex, OpenClaw, Hermes) session; the agent
queries the source APIs through your CLI tools, answers from the claims, and
maintains them as it learns. The commands above are the guardrails around
that loop, and the same commands gate your CI.

Two pieces wire the agent in:

**Project instructions.** `warehaus init` writes an `AGENTS.md` with the
working rules (answer from claims, update the claim on correction, lint
before committing, `executed` is not `confirmed`) and a `CLAUDE.md` that
points to it. Codex, Cursor and OpenClaw read `AGENTS.md` natively; Claude
Code follows the pointer. An agent that opens a scaffolded project knows the
rules without being told.

**The skills.** Three skills in [skills/](skills/) teach an agent the
workflows, in the [agentskills](https://agentskills.io) format that Claude
Code, Hermes and OpenClaw all load:

- `warehaus`: the daily loop. When to write which claim type, how to handle
  a user correction, how to read verify verdicts.
- `connect-a-source`: wrapping a new API as a CLI tool (auth patterns, rate
  limits, pagination) and recording its quirks as claims while testing,
  with a definition of done that ends in claims, not just a script.
- `nightly-loop`: an unattended maintenance pass (lint, drift check,
  budgeted verify, contradictions) that ends in at most one pull request
  for a human to review. The loop never merges.

Install them with

```bash
npx skills add brianadvent/warehaus
```

or copy the directories into your agent's skill directory (for Claude Code:
`~/.claude/skills/`).

A session then looks like this: you say "our billing API returns cents, I
keep seeing inflated numbers", the agent writes a `structure` claim with a
verify command, runs `warehaus lint`, and every later revenue question in
any session starts from that recorded, checkable fact.

## Building your source tools

The agent needs CLI access to your systems. [lib/](lib/) has the shared
pieces every wrapper needs, as dependency-free TypeScript run with `npx
tsx`: two rate limiters with the tuning rule (throttle below the documented
maximum, leave shared keys extra headroom), page- and cursor-based
pagination, `--format=json|table|csv` output, and `.env` loading.
[templates/source-tool.ts](templates/source-tool.ts) shows all of it in one
working wrapper, and the `connect-a-source` skill turns the two into a
repeatable procedure your agent executes against a real API.

## Numbers never live in prose

A retrievable number never goes into documentation text, because text ages
silently. This rule keeps a warehaus project honest. A count belongs in a
`count` claim with a generated range:

```markdown
The product catalog currently lists
<!--gen:product-catalog-size-->1366<!--/gen--> SKUs.
```

`warehaus stand` owns the value between the markers, `--check` reports drift
(including hand edits), and `warehaus contradictions` flags the same number
appearing in a second claim or in loose prose.

## What ships today, what is planned

Today: the five commands, the claim schema, the three skills, the tool
library and template, the offline example project, tests and CI. Planned
next: the PyPI release, and an inbox workflow that collects corrections
from many agent sessions for a human to review before they become claims.

## License

MIT, see [LICENSE](LICENSE).
