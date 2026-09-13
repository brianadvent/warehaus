/**
 * `warehaus init`: scaffold a new warehaus project.
 *
 * Creates the config, the knowledge area, the ADR directory and the agent
 * instruction files. Never overwrites anything; existing files are reported
 * and skipped, so running it in a half-set-up project is safe.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

import { parseArgs, type Spec } from "./args.js";
import { out } from "./output.js";

const CONFIG_TEMPLATE = `# warehaus project configuration. All paths are relative to this file.

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
# command = "warehaus stand"  # lets \`warehaus verify\` check generated counts

# [[stand.values]]
# id = "product-catalog-size"
# command = "grep -c '^- SKU ' docs/catalog.md"
`;

const SOURCES_TEMPLATE = `# Source knowledge

What an agent must know about this project's source systems, written as
claims. See claim-template.md in this directory for the format, and
https://github.com/brianadvent/warehaus/blob/main/docs/claim-schema.md
for the full schema.
`;

const CLAIM_TEMPLATE = `# Claim template

This file is listed under \`example_files\` in warehaus.toml, so the block
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
`;

const AGENTS_TEMPLATE = `# Working in this project

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
4. Before committing knowledge changes, run \`warehaus lint\`. It blocks on
   form errors and prints a non-blocking gap list.
5. \`warehaus verify\` has four verdicts. \`executed\` means the command ran, not
   that the claim is right. Only \`confirmed\` counts as confirmation.

Commands:

    warehaus lint             form, required fields, value ranges, references
    warehaus verify           run each claim's verify_cmd
    warehaus contradictions   duplicate numbers, prose drift, dead references
    warehaus stand --check    drift of generated counts
`;

const CLAUDE_TEMPLATE = `# Claude Code

Read AGENTS.md. It is the canonical instruction file for this project; this
file only points there.
`;

export const SPEC: Spec = {
  dir: { type: "string", help: "target directory", default: "." },
};

export const DESCRIPTION =
  "Creates warehaus.toml, a knowledge area, an ADR directory and agent " +
  "instruction files. Existing files are never overwritten.";

export function run(argv: string[], _configPath?: string): number {
  const args = parseArgs(argv, SPEC);
  const target = resolve(String(args.dir));
  mkdirSync(target, { recursive: true });

  const files: [string, string][] = [
    [resolve(target, "warehaus.toml"), CONFIG_TEMPLATE],
    [resolve(target, "knowledge", "sources.md"), SOURCES_TEMPLATE],
    [resolve(target, "knowledge", "claim-template.md"), CLAIM_TEMPLATE],
    [resolve(target, "AGENTS.md"), AGENTS_TEMPLATE],
    [resolve(target, "CLAUDE.md"), CLAUDE_TEMPLATE],
    [resolve(target, "docs", "adrs", ".gitkeep"), ""],
  ];

  const created: string[] = [];
  const skipped: string[] = [];
  for (const [path, content] of files) {
    if (existsSync(path)) {
      skipped.push(path);
      continue;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf-8");
    created.push(path);
  }

  for (const path of created) out(`created  ${relative(target, path)}`);
  for (const path of skipped) out(`exists   ${relative(target, path)} (skipped)`);
  if (created.length) {
    out(
      "\nNext: list your source systems under [schema] sots in " +
        "warehaus.toml, write your first claim in knowledge/sources.md, " +
        "then run `warehaus lint`.",
    );
  }
  return 0;
}
