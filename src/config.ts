/**
 * Configuration loading.
 *
 * A warehaus project is any directory tree with a `warehaus.toml` at its
 * root. All paths in the config are relative to the directory containing
 * that file.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";

import { err } from "./output.js";
import { isDir, isFile } from "./util.js";

export const CONFIG_NAME = "warehaus.toml";

// Review intervals in days, per claim type. A claim whose `as_of` is older
// than its interval lands on the gap list (non-blocking). Overridable via
// the [intervals] table.
export const DEFAULT_INTERVALS: Record<string, number> = {
  structure: 120,
  access: 90,
  rule: 365,
  metric: 90,
  count: 30,
  snapshot: 90,
  experience: 365,
};

export const SOT_PREFIXES = ["code:", "adr:", "person:"] as const;

export class ConfigError extends Error {}

export interface Area {
  name: string;
  root: string;
  files: string[];
}

export interface StandValue {
  id: string;
  command: string;
  budget: string;
}

export interface Config {
  path: string; // the warehaus.toml file itself
  root: string; // its directory; working directory for verify commands
  areas: Area[];
  sots: string[];
  exampleFiles: Set<string>;
  adrDirs: string[];
  intervals: Record<string, number>;
  envFile: string | null;
  assertPatterns: string[];
  verifyTimeout: number;
  protectedFile: string | null;
  generatorCommand: string | null;
  standValues: StandValue[];
}

export function sotValid(config: Config, value: string): boolean {
  if (config.sots.includes(value)) return true;
  return SOT_PREFIXES.some((p) => value.startsWith(p) && value.length > p.length);
}

/** Walk up from `start` (default: cwd) to the filesystem root. */
export function findConfig(start?: string): string | null {
  let here = resolve(start ?? process.cwd());
  for (;;) {
    const candidate = resolve(here, CONFIG_NAME);
    if (isFile(candidate)) return candidate;
    const parent = dirname(here);
    if (parent === here) return null;
    here = parent;
  }
}

type Table = Record<string, unknown>;

function table(value: unknown): Table {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Table) : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function loadConfig(explicit?: string): Config {
  let path: string;
  if (explicit) {
    path = resolve(explicit);
    if (isDir(path)) path = resolve(path, CONFIG_NAME);
    if (!isFile(path)) throw new ConfigError(`config file not found: ${path}`);
  } else {
    const found = findConfig();
    if (!found) {
      throw new ConfigError(
        `no ${CONFIG_NAME} found in this directory or any parent; ` +
          "run from inside a warehaus project or pass --config",
      );
    }
    path = found;
  }

  let raw: Table;
  try {
    raw = parseToml(readFileSync(path, "utf-8")) as Table;
  } catch (exc) {
    throw new ConfigError(`${path}: ${(exc as Error).message}`);
  }

  const root = dirname(path);

  const areasRaw = list(raw.areas);
  if (areasRaw.length === 0) {
    throw new ConfigError(`${path}: at least one [[areas]] table is required (name, root, files)`);
  }
  const areas: Area[] = areasRaw.map((entry, i) => {
    const a = table(entry);
    for (const key of ["name", "root", "files"]) {
      if (!(key in a)) throw new ConfigError(`${path}: [[areas]] entry ${i + 1} is missing '${key}'`);
    }
    return {
      name: String(a.name),
      root: resolve(root, String(a.root)),
      files: list(a.files).map(String),
    };
  });

  const schema = table(raw.schema);
  const sots = list(schema.sots).map(String);
  if (sots.length === 0) {
    throw new ConfigError(
      `${path}: [schema] sots is required; list the source-of-truth identifiers your claims may reference`,
    );
  }

  const intervals = { ...DEFAULT_INTERVALS };
  for (const [key, value] of Object.entries(table(raw.intervals))) {
    if (!(key in DEFAULT_INTERVALS)) {
      throw new ConfigError(`${path}: [intervals] has unknown claim type '${key}'`);
    }
    intervals[key] = Number(value);
  }

  const verify = table(raw.verify);
  const envFile = verify.env_file ? String(verify.env_file) : null;
  const protectedTable = table(raw.protected);
  const generator = table(raw.generator);
  const generatorCommand = generator.command ? String(generator.command) : null;

  // [[stand.values]]: the collectors behind the gen ranges. `warehaus stand`
  // owns their semantics; the budget vocabulary mirrors claims.BUDGETS.
  const standValues: StandValue[] = [];
  list(table(raw.stand).values).forEach((entry, i) => {
    const e = table(entry);
    if (!("id" in e) || !("command" in e)) {
      throw new ConfigError(`${path}: [[stand.values]] entry ${i + 1} needs both id and command`);
    }
    const budget = String(e.budget ?? "free");
    if (!["free", "single_call", "bulk"].includes(budget)) {
      throw new ConfigError(`${path}: [[stand.values]] '${e.id}' has unknown budget '${budget}'`);
    }
    standValues.push({ id: String(e.id), command: String(e.command), budget });
  });

  return {
    path,
    root,
    areas,
    sots,
    exampleFiles: new Set(list(schema.example_files).map(String)),
    adrDirs: list(table(raw.adr).dirs).map((d) => resolve(root, String(d))),
    intervals,
    envFile: envFile ? resolve(root, envFile) : null,
    assertPatterns: list(verify.assert_patterns).map(String),
    verifyTimeout: Number(verify.timeout ?? 300),
    protectedFile: protectedTable.file ? resolve(root, String(protectedTable.file)) : null,
    generatorCommand,
    standValues,
  };
}

export function die(message: string): number {
  err(`NOT RUNNABLE: ${message}`);
  return 2;
}
