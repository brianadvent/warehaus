# @warehaus/lib

The shared pieces of a warehaus source tool, as TypeScript source files run
directly with [tsx](https://tsx.is) (`npx tsx your-tool.ts`). No build step.

- `rate-limiter.ts`: token bucket and rolling window, with the tuning rule
  in the header comment (throttle below the documented maximum, leave
  shared keys extra headroom).
- `paginator.ts`: page-based and cursor-based pagination, plus a Link-header
  cursor parser.
- `formatter.ts`: `--format=json|table|csv` output and a small argv parser.
- `env.ts`: `.env` loading and `requireEnv`.

Copy the directory into your project (`lib/`) or vendor it however you
like; the files have no dependencies. `templates/source-tool.ts` in the
repository root shows all four in one working wrapper, and the
`connect-a-source` skill walks an agent through building a real one.
