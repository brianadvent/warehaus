# warehaus

An intelligent data warehouse for AI agents. No ETL, no copies: your agent
queries the source systems directly, guided by curated, verifiable knowledge.

Status: early extraction in progress, not released. This repository currently
contains the knowledge core:

- `warehaus lint` checks the form of every claim: required fields, value
  ranges, ID uniqueness, reference chains, history prose.
- `warehaus verify` runs the `verify_cmd` of each claim against the live
  source and reports one of four verdicts: confirmed, refuted, executed,
  unverifiable. "Executed" is deliberately not "confirmed".
- `warehaus contradictions` finds the same number in two claims, claims whose
  ADR is no longer accepted, and probable duplicates.

Try it on the bundled example project:

```bash
python3 -m warehaus --config example/warehaus.toml lint
```

Requires Python 3.11+ and nothing else.
