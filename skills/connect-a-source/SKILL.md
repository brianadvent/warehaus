---
name: connect-a-source
description: Connect a new source system to a warehaus project. Walks through wrapping an API as a CLI tool (auth, rate limits, pagination) and recording its quirks as claims while testing. Use when the user wants to add, wrap, or integrate a new API, data source, or business system.
---

# Connect a source

The goal is never just a working wrapper. A source counts as connected when
the tool exists, the source is registered in the config, and everything you
learned while testing is recorded as claims. A folder of scripts without
claims is the failure mode this system exists to prevent.

## 1. Read the API documentation and classify the auth

- Static token (bearer or basic): store it in `.env`, load it with
  `requireEnv`, never print it.
- OAuth client credentials: token endpoint and data endpoint can live on
  different hosts; note both.
- Short-lived tokens from an exchange: cache the token on disk with its
  expiry and refresh on demand.
- Rotating refresh tokens: persist the new refresh token BEFORE using it,
  and keep exactly one holder per machine. A copied refresh chain kills
  both copies.

## 2. Find the rate limit and throttle below it

Find the documented limit for the actual plan, then configure a limiter
from `@warehaus/lib` (see `lib/rate-limiter.ts`) below it. Two rules:

- 5-10% under the documented maximum leaves room for retries.
- A key shared with other consumers (an accounting integration, coworkers)
  gets a much larger share left free. Ask the user who else uses the key.

Record the result as an `access` claim, including the plan and the date you
verified the limit.

## 3. Identify the pagination

Page-based, cursor-based, or offset-based; the helpers in
`lib/paginator.ts` cover the first two. Note the maximum page size. If the
API paginates via a Link header, `parseLinkHeaderCursor` extracts the
cursor.

## 4. Build the wrapper from the template

Start from `templates/source-tool.ts`. Conventions the wrapper must keep:

- `--help` is the authoritative documentation, with every subcommand and
  flag.
- `--limit` and `--format=json|table|csv` on every listing command.
- Read-only by default. If a write operation is genuinely needed, it gets
  its own explicit subcommand and says so in `--help`.
- Error classes stay distinguishable: authentication, permission, wrong
  path, wrong parameters. Collapsing them into one message costs the next
  debugging session an hour.

## 5. Test against the real API and record every quirk as a claim

This is the step that separates a connected source from a script. Before
the first claim, add the source's identifier under `[schema] sots` in
`warehaus.toml`. Then, while testing:

- Units and formats (cents vs. decimals, timezone of timestamps) become
  `structure` claims.
- Granted scopes and their limits become an `access` claim whose
  `verify_cmd` separates the error classes.
- A filter parameter that silently ignores its value, a date field that
  means something else than its name says, an endpoint the docs promise
  but the plan lacks: each one is a claim, with `expected_exit: non-zero`
  when the claim states that something does not work.
- Everything a colleague told you that the data cannot show becomes an
  `experience` claim with `source` and `confirmed_on`.

Run `warehaus lint` after writing the claims.

## 6. Definition of done

- The wrapper runs, `--help` is complete, secrets stay out of output.
- The source is listed under `[schema] sots`.
- At least one `access` claim with a working `verify_cmd` and a `budget`.
- The quirks found while testing exist as claims, not as memories.
- If this tool replaces an older one, the old tool moves to an archive
  document that names its successor. Deleted documentation is how the next
  agent rebuilds the refuted version.
