#!/usr/bin/env node
/**
 * The warehaus command line: one entry point, one subcommand per check.
 *
 *     warehaus init             scaffold a new project
 *     warehaus lint             form, IDs, required fields, reference chains
 *     warehaus verify           run the verify_cmd of each claim
 *     warehaus contradictions   the same number twice, dead ADR references, duplicates
 *     warehaus stand            generated counts: collect, check for drift, write
 *
 * Exit convention shared by all subcommands: 0 green, 1 red, 2 not runnable.
 */

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { ArgError, type Spec, usage } from "./args.js";
import * as contradictions from "./contradictions.js";
import * as init from "./init.js";
import * as lint from "./lint.js";
import { err, out } from "./output.js";
import * as stand from "./stand.js";
import * as verify from "./verify.js";

interface Command {
  help: string;
  description: string;
  spec: Spec;
  run(argv: string[], configPath?: string): number;
}

const COMMANDS: Record<string, Command> = {
  init: { help: "scaffold a new warehaus project in a directory", description: init.DESCRIPTION, spec: init.SPEC, run: init.run },
  lint: { help: "check the form of every claim: fields, ranges, ids, references", description: lint.DESCRIPTION, spec: lint.SPEC, run: lint.run },
  verify: { help: "run the verify_cmd of every claim and judge the result", description: verify.DESCRIPTION, spec: verify.SPEC, run: verify.run },
  contradictions: { help: "find conflicting numbers, dead ADR references and probable duplicates", description: contradictions.DESCRIPTION, spec: contradictions.SPEC, run: contradictions.run },
  stand: { help: "collect generated values and keep the gen ranges honest", description: stand.DESCRIPTION, spec: stand.SPEC, run: stand.run },
};

export function version(): string {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf-8"));
  return String(pkg.version);
}

function globalUsage(): string {
  const lines = [
    "usage: warehaus [--config PATH] <command> [options]",
    "",
    "Curated, verifiable knowledge for AI agents over live source systems.",
    "",
    "commands:",
  ];
  for (const [name, c] of Object.entries(COMMANDS)) lines.push(`  ${name.padEnd(16)} ${c.help}`);
  lines.push(
    "",
    "options:",
    "  --config PATH    path to warehaus.toml (default: nearest one in this or a parent directory)",
    "  --version        show the version and exit",
    "  --help           show this help",
    "",
    "Every command exits 0 (green), 1 (red) or 2 (not runnable).",
  );
  return lines.join("\n");
}

export function main(argv: string[]): number {
  let configPath: string | undefined;
  let help = false;
  const rest: string[] = [];
  let command: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--version") {
      out(`warehaus ${version()}`);
      return 0;
    }
    if (token === "--help" || token === "-h") {
      help = true;
      continue;
    }
    if (token === "--config") {
      if (i + 1 >= argv.length) {
        err("NOT RUNNABLE: --config needs a value");
        return 2;
      }
      configPath = argv[++i];
      continue;
    }
    if (token.startsWith("--config=")) {
      configPath = token.slice("--config=".length);
      continue;
    }
    if (command === undefined && !token.startsWith("-")) {
      command = token;
      continue;
    }
    rest.push(token);
  }

  if (command === undefined) {
    if (help) {
      out(globalUsage());
      return 0;
    }
    err(globalUsage());
    err("\nNOT RUNNABLE: a command is required");
    return 2;
  }
  const entry = COMMANDS[command];
  if (!entry) {
    err(`NOT RUNNABLE: unknown command '${command}' (choose from ${Object.keys(COMMANDS).join(", ")})`);
    return 2;
  }
  if (help) {
    out(usage(command, entry.description, entry.spec));
    return 0;
  }
  try {
    return entry.run(rest, configPath);
  } catch (exc) {
    if (exc instanceof ArgError) {
      err(usage(command, entry.description, entry.spec));
      err(`\nNOT RUNNABLE: ${exc.message}`);
      return 2;
    }
    throw exc;
  }
}

let invokedDirectly = false;
try {
  invokedDirectly =
    process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
} catch {
  invokedDirectly = false;
}

if (invokedDirectly) {
  process.exitCode = main(process.argv.slice(2));
}
