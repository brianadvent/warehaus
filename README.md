# warehaus

```
                          _
 __      ____ _ _ __ ___ | |__   __ _ _   _ ___
 \ \ /\ / / _` | '__/ _ \| '_ \ / _` | | | / __|
  \ V  V / (_| | | |  __/| | | | (_| | |_| \__ \
   \_/\_/ \__,_|_|  \___||_| |_|\__,_|\__,_|___/
```

Warehaus helps an AI agent answer questions about your business from the
systems that hold the data: the shop, the accounting software, the CRM, the
fulfillment provider. It gives the agent two things the raw APIs cannot
provide on their own: a way to reach each system, and the knowledge of how
to read what comes back.

Warehaus is a way of working, a small Python command-line tool that checks
your knowledge files, three skills that teach an agent the workflow, and a
TypeScript library for writing the API wrappers. Your data stays in the
systems that own it.

## Why you would want this

Suppose someone at your company asks: "Which wholesale customers ordered
less this quarter than last?" Today that question becomes a ticket. An
analyst joins the CRM export with the invoice export, remembers that the
billing system counts in cents, filters out the cancelled invoices, and
sends a spreadsheet that is out of date a week later.

An agent with shell access can do the same work in minutes. It can call the
CRM API, call the billing API and join the two. What it lacks is everything
the analyst carries in their head: which system is right when two disagree,
that amounts arrive in cents, that cancelled invoices still show up in the
list, that the biggest customer orders through a subsidiary under a
different name.

Warehaus is where that knowledge lives. You, or the agent while it works,
write it down as short statements in Markdown, each with its source, a date
and a command that checks whether it still holds. The agent reads them
before it answers and updates them when someone corrects it. The next
person who asks, in their own session on their own laptop, gets the same
rules applied.

## What you get

- **Answers with a basis.** The agent can say which rules it applied,
  where they come from and when they were last checked, for every number
  it reports.
- **Corrections that stick.** Someone tells the agent "these numbers are a
  hundred times too high, the API returns cents." The fix lands in a claim,
  not in a chat that scrolls away. Every later session divides by 100.
- **Knowledge that ages visibly.** Every claim carries an as-of date.
  `warehaus verify` runs the check commands and reports which claims still
  hold, which were refuted, and which need a human look.
- **One place for the rules.** Dashboards, scripts and the agent read the
  same claims. A corrected rule reaches everything built on it.
- **The same knowledge for the whole team.** The files live in git. Everyone
  who opens the project works with the same rules, and a correction from one
  person reaches the others on the next pull.
- **Maintenance you can leave running.** The `nightly-loop` skill checks for
  drift and refuted claims, fixes one finding on a branch and opens a pull
  request with the evidence. It never merges.

## How it fits together

```
  your systems            the agent's hands              what the agent knows
  ------------            -----------------              --------------------
  shop API        <---    tools/shop.ts                  knowledge/*.md
  billing API     <---    tools/billing.ts     ------>   one fact per claim, with
  CRM API         <---    tools/crm.ts                   source, date, check command
                          thin CLI wrappers,                      |
                          --format=json                           v
                                                         warehaus lint | verify |
                                                         contradictions | stand
                                                         checks the knowledge,
                                                         gates your CI
```

The agent sits in the middle. It reads the claims, calls the tools, answers,
and writes new claims when it learns something. The `warehaus` commands make
sure the claims stay well-formed and true.

## What a session looks like

```
You    How much did we invoice in August, without cancellations?

Agent  Reading knowledge/sources.md. Two claims apply:
         billing-amounts-in-cents        structure, verified 2026-08-31
         revenue-excludes-cancellations  rule, decided in ADR-0001

       $ npx tsx tools/billing.ts invoices --from=2026-08-01 --to=2026-08-31 --format=json

       312 invoices returned, 14 carry a cancel_id and are excluded.
       Invoiced in August: 48,213.90 EUR (298 invoices, cents divided by 100).
```

The two claims are the only reason the answer is right. Without them the
agent would report a figure a hundred times too high with the cancelled
invoices still in it, and it would sound just as confident.

## Where to start

### 1. Install

Python 3.11 or newer, no dependencies.

```bash
pip install git+https://github.com/brianadvent/warehaus.git
```

A PyPI release (`pip install warehaus`) comes with the first public version.

### 2. Create a project

```bash
mkdir my-warehaus && cd my-warehaus
warehaus init
```

This writes `warehaus.toml` (which systems exist, where the knowledge files
are), a `knowledge/` folder with a claim template, and two instruction
files: `AGENTS.md` with the working rules and a `CLAUDE.md` that points to
it. Codex, Cursor and OpenClaw read `AGENTS.md` on their own; Claude Code
follows the pointer. An agent that opens the folder knows the rules without
being told.

Then install the skills into your agent:

```bash
npx skills add brianadvent/warehaus
```

or copy the three folders from [skills/](skills/) into your agent's skill
directory (for Claude Code: `~/.claude/skills/`).

### 3. Connect your first system

This is where the agent does most of the work. Open the project in Claude
Code (or Codex, OpenClaw, Hermes), put the API credentials in `.env`, and
say something like:

> Connect our billing system. The API docs are at docs/billing-api.md and
> the token is in .env as BILLING_TOKEN.

The `connect-a-source` skill walks the agent through the steps: read the
docs, classify the authentication, find the rate limit and throttle below
it, pick the pagination helper, build the wrapper from
[templates/source-tool.ts](templates/source-tool.ts), and test it against
the real API. While testing, the agent writes down every quirk it finds as a
claim: amounts in cents, timestamps in the account's timezone, a filter that
silently ignores its value, the scopes the token has. A system counts as
connected when the tool works and those claims exist. A folder of scripts
without claims is the failure mode this whole setup exists to prevent.

Then run

```bash
warehaus lint      # are the claims well-formed?
warehaus verify    # do they still hold against the source?
```

Each wrapper is a short TypeScript file the agent writes against your API
and your plan, so it fits your setup rather than a generic one. [lib/](lib/)
has the pieces every wrapper needs (two rate limiters, page- and
cursor-based pagination, `--format=json|table|csv` output, `.env` loading),
with no dependencies.

### 4. Ask, and correct

Ask a question. When the answer is wrong, say so. The agent's job on a
correction is to change the claim, not to apologise; the `warehaus` skill
tells it how. This loop is how the knowledge grows, one correction at a
time, and why the fifth question is easier to answer than the first.

### Try it without an API

The repository contains a fictional toy shop with two systems that runs
entirely offline:

```bash
git clone https://github.com/brianadvent/warehaus.git && cd warehaus
python3 -m warehaus --config example/warehaus.toml lint
python3 -m warehaus --config example/warehaus.toml verify
python3 -m warehaus --config example/warehaus.toml stand --check
```

Read [example/knowledge/sources.md](example/knowledge/sources.md) to see
what a small set of real claims looks like.

## How knowledge is recorded

One fact per block, directly in your Markdown files. The unit is called a
claim: a statement plus the metadata that makes it checkable.

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

`sot` is the source of truth the claim rests on, `maintenance` says how it
is kept current, `as_of` when it was last checked and `verify_cmd` how to
check it again. There are seven claim types, from `structure` (how a system
behaves) to `experience` (what a colleague knows that no database shows).
The full schema is in [docs/claim-schema.md](docs/claim-schema.md).

One rule follows from this and keeps a project honest: a number you could
look up never goes into prose, because prose ages silently. A count belongs
in a `count` claim with a generated range that `warehaus stand` writes and
checks for drift:

```markdown
The product catalog currently lists
<!--gen:product-catalog-size-->1366<!--/gen--> SKUs.
```

## The commands

```
warehaus init             scaffold a project: config, knowledge folder, agent instructions
warehaus lint             form, required fields, value ranges, ID uniqueness, references
warehaus verify           run each claim's verify_cmd against the live source
warehaus contradictions   the same number in two claims, dead references, duplicates
warehaus stand            generated counts: collect, check for drift, write
```

All five share one exit convention (0 green, 1 red, 2 not runnable), so they
drop into any CI or release gate.

`verify` deserves a closer look. Most check commands fetch rather than
assert, so it reports four verdicts instead of treating exit 0 as proof:

| Verdict | Meaning |
|---|---|
| `confirmed` | a real assertion passed, or the generated value matches |
| `refuted` | an assertion failed, or a search no longer finds the spot the claim cites |
| `executed` | the fetch ran clean; whether the claim text is right still needs a human or agent to compare |
| `unverifiable` | placeholder in the command, timeout, suspected write access |

Only `confirmed` advances the as-of date. A checker that counted every clean
fetch as a confirmation would report every claim green and guard nothing.

## License

MIT, see [LICENSE](LICENSE).
