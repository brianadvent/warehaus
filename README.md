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

Company knowledge rarely lives in one place. It is spread across the shop,
the accounting system, the CRM, fulfillment, spreadsheets, and the heads of
individual people. So every new question about your own data becomes a
ticket for an analyst or a developer, and every answer becomes a report
that starts aging the day it ships.

Warehaus makes that knowledge legible to an AI agent instead. Thin CLI
tools give the agent controlled access to the live systems. The business
context that raw APIs cannot carry (which system is the source of truth for
what, how revenue is calculated, which invoices do not count, what a
colleague knows that no database shows) is recorded as **claims**:
plain-Markdown statements with provenance, an as-of date and a command that
checks each one against its source. The agent reads them, obeys them and
maintains them. A classic warehouse copies your data into a central
database and buries the rules in pipeline code; warehaus copies nothing and
keeps the rules where every reader, human or machine, can check them.

## What you can do with it

**Answer cross-system questions in minutes.** "Which wholesale partners
are going quiet?" joins the CRM with the invoices. "Which marketing
channel is actually profitable?" joins ad spend with orders. The agent
queries the live APIs, applies the recorded rules (amounts converted,
cancellations excluded, the right source per sales channel) and can name
the basis of every number: which claims, which derivation, verified when.
Nobody builds a report, and there is no stale copy to distrust.

**Record a rule once, benefit in every session.** You say "our billing API
returns cents, I keep seeing inflated numbers." The agent writes a
`structure` claim with a verify command and runs `warehaus lint`. Every
later session, by any agent on any machine, divides by 100 without being
told. Corrections work the same way: when a human corrects the agent, the
fix lands in the claim, not in one chat that scrolls away.

**Let the agent watch and act within defined bounds.** The `nightly-loop`
skill runs unattended: drift in generated counts, refuted claims, dead
references, contradictions. It triages, fixes one finding on a branch and
opens a pull request with the evidence. It never merges. You wake up to a
reviewable proposal, not to silently changed knowledge.

**Feed your own tools from the same foundation.** The CLI tools and claims
that serve the agent also serve dashboards, internal apps and one-off
scripts. The business logic lives in one place instead of one copy per
tool, so an update to a claim reaches everything built on top.

**Keep humans the judges.** The more runs on this foundation, the more
weight human judgment carries. Claims disclose their data basis,
assumptions and derivation, so people can check them and take
responsibility for decisions built on them. `warehaus verify` reports
honestly (a command that merely ran is `executed`, never `confirmed`), and
unattended runs end in pull requests a person merges or rejects.

## Use it with your agent

Warehaus is built to be operated by an agent, not by hand. You ask business
questions in a Claude Code (or Codex, OpenClaw, Hermes) session; the agent
queries the source APIs through your CLI tools, answers from the claims, and
maintains them as it learns. The warehaus commands are the guardrails
around that loop, and the same commands gate your CI.

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
- `nightly-loop`: the unattended maintenance pass described above.

Install them with

```bash
npx skills add brianadvent/warehaus
```

or copy the directories into your agent's skill directory (for Claude Code:
`~/.claude/skills/`).

## Claims

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

One discipline follows from this and keeps a project honest: a retrievable
number never goes into documentation text, because text ages silently. A
count belongs in a `count` claim with a generated range that `warehaus
stand` owns and checks for drift:

```markdown
The product catalog currently lists
<!--gen:product-catalog-size-->1366<!--/gen--> SKUs.
```

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

## Building your source tools

The agent needs CLI access to your systems. [lib/](lib/) has the shared
pieces every wrapper needs, as dependency-free TypeScript run with `npx
tsx`: two rate limiters with the tuning rule (throttle below the documented
maximum, leave shared keys extra headroom), page- and cursor-based
pagination, `--format=json|table|csv` output, and `.env` loading.
[templates/source-tool.ts](templates/source-tool.ts) shows all of it in one
working wrapper, and the `connect-a-source` skill turns the two into a
repeatable procedure your agent executes against a real API.

## License

MIT, see [LICENSE](LICENSE).
