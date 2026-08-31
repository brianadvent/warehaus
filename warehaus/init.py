"""`warehaus init`: scaffold a new warehaus project.

Creates the config, the knowledge area, the ADR directory and the agent
instruction files. Never overwrites anything; existing files are reported
and skipped, so running it in a half-set-up project is safe.
"""

from __future__ import annotations

import argparse
from pathlib import Path

CONFIG_TEMPLATE = """\
# warehaus project configuration. All paths are relative to this file.

[[areas]]
name = "knowledge"
root = "knowledge"
files = ["*.md"]

[schema]
# Source-of-truth identifiers your claims may reference. Add every source
# system here before the first claim uses it.
sots = ["example-api"]
# Files whose claim blocks are examples, not live claims.
example_files = ["claim-template.md"]

[adr]
dirs = ["docs/adrs"]

# [verify]
# env_file = ".env"          # merged into the environment of verify commands
# assert_patterns = []        # regexes marking commands that exit 1 on failure
# timeout = 300

# [generator]
# command = "warehaus stand"  # lets `warehaus verify` check generated counts

# [[stand.values]]
# id = "product-catalog-size"
# command = "grep -c '^- SKU ' docs/catalog.md"
"""

SOURCES_TEMPLATE = """\
# Source knowledge

What an agent must know about this project's source systems, written as
claims. See claim-template.md in this directory for the format, and
https://github.com/brianadvent/warehaus/blob/main/docs/claim-schema.md
for the full schema.
"""

CLAIM_TEMPLATE = """\
# Claim template

This file is listed under `example_files` in warehaus.toml, so the block
below is documentation, not a live claim. Copy it into a knowledge file and
fill it in.

<!-- claim
id: billing-amounts-in-cents
type: structure
sot: example-api
maintenance: verified
verify_cmd: "grep -q amounts_in_cents docs/billing-api.md"
budget: free
as_of: 2026-01-01
-->
The billing API returns all monetary amounts as integer cents. Divide by 100
before displaying them or adding them to figures from other systems.
<!-- /claim -->

Field reference: https://github.com/brianadvent/warehaus/blob/main/docs/claim-schema.md
"""

AGENTS_TEMPLATE = """\
# Working in this project

This project keeps its operational knowledge as claims: statements with
provenance, a maintenance mode, an as-of date and, where possible, a command
that checks them against the source system. The claims live in the areas
listed in warehaus.toml.

Rules:

1. Answer from claims, not from memory. When a claim and your prior knowledge
   disagree, the claim wins until a verify run refutes it.
2. A retrievable number never goes into prose. Counts belong in claims with a
   generated range; everywhere else, reference the claim id.
3. When the user corrects a fact, update the claim or add one. Replace the
   statement text with the current state; history lives in git and in
   supersedes/superseded_by, never in the prose.
4. Before committing knowledge changes, run `warehaus lint`. It blocks on
   form errors and prints a non-blocking gap list.
5. `warehaus verify` has four verdicts. `executed` means the command ran, not
   that the claim is right. Only `confirmed` counts as confirmation.

Commands:

    warehaus lint             form, required fields, value ranges, references
    warehaus verify           run each claim's verify_cmd
    warehaus contradictions   duplicate numbers, prose drift, dead references
    warehaus stand --check    drift of generated counts
"""

CLAUDE_TEMPLATE = """\
# Claude Code

Read AGENTS.md. It is the canonical instruction file for this project; this
file only points there.
"""


def register(subparsers) -> None:
    p = subparsers.add_parser(
        "init",
        help="scaffold a new warehaus project in a directory",
        description="Creates warehaus.toml, a knowledge area, an ADR directory "
        "and agent instruction files. Existing files are never overwritten.",
    )
    p.add_argument("--dir", default=".", help="target directory (default: current)")
    p.set_defaults(func=run)


def run(args: argparse.Namespace) -> int:
    target = Path(args.dir).resolve()
    target.mkdir(parents=True, exist_ok=True)

    files = {
        target / "warehaus.toml": CONFIG_TEMPLATE,
        target / "knowledge" / "sources.md": SOURCES_TEMPLATE,
        target / "knowledge" / "claim-template.md": CLAIM_TEMPLATE,
        target / "AGENTS.md": AGENTS_TEMPLATE,
        target / "CLAUDE.md": CLAUDE_TEMPLATE,
        target / "docs" / "adrs" / ".gitkeep": "",
    }

    created, skipped = [], []
    for path, content in files.items():
        if path.exists():
            skipped.append(path)
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        created.append(path)

    for path in created:
        print(f"created  {path.relative_to(target)}")
    for path in skipped:
        print(f"exists   {path.relative_to(target)} (skipped)")
    if created:
        print(
            "\nNext: list your source systems under [schema] sots in "
            "warehaus.toml, write your first claim in knowledge/sources.md, "
            "then run `warehaus lint`."
        )
    return 0
