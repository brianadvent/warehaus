/**
 * Collect the generated values and keep the gen ranges honest.
 *
 * Claims with `maintenance: generated` carry a machine-owned range in their
 * body:
 *
 *     <!--gen:product-catalog-size-->6<!--/gen-->
 *
 * A value inside a gen range is NEVER typed by hand. Whoever does creates
 * drift, and `--check` reports it. This module is the only legitimate
 * writer, and it only ever touches the text between the markers.
 *
 * The collectors are declared in warehaus.toml:
 *
 *     [[stand.values]]
 *     id = "product-catalog-size"
 *     command = 'grep -c "^- SKU " docs/catalog.md'
 *     budget = "free"          # free | single_call | bulk (default free)
 *
 * Modes:
 *
 *     warehaus stand              preview: collect and show, write nothing
 *     warehaus stand --write      rewrite the gen ranges in place
 *     warehaus stand --check      compare only; drift, a missing range or a
 *                                 failed command exits 1
 *     warehaus stand --format=json
 *
 * The JSON output is exactly the generator contract that `warehaus verify`
 * expects ({"values": ..., "errors": ..., "skipped": ...}), so a project
 * with the CLI installed can close the loop with:
 *
 *     [generator]
 *     command = "warehaus stand"
 *
 * Exit: 0 collected (and, with --check, no drift), 1 at least one value
 * failed or drifted, 2 not runnable.
 */

import { writeFileSync } from "node:fs";

import { ArgError, parseArgs, type Spec } from "./args.js";
import { BUDGET_LEVELS, BUDGET_NAMES, areaFiles, genRe, readText } from "./claims.js";
import { type Config, ConfigError, die, loadConfig } from "./config.js";
import { err, out } from "./output.js";
import { normalized, runShell } from "./util.js";
import { environment } from "./verify.js";

const COMMAND_TIMEOUT = 120;

interface Range {
  path: string;
  display: string;
  current: string;
}

/**
 * id -> ranges for every gen range on file. One id may legitimately appear
 * in more than one file (a summary document and the claim itself); all
 * occurrences are compared and written.
 */
function genRanges(config: Config): Map<string, Range[]> {
  const ranges = new Map<string, Range[]>();
  for (const { path, display } of areaFiles(config)) {
    const content = readText(path);
    for (const m of content.matchAll(genRe())) {
      if (!ranges.has(m[1])) ranges.set(m[1], []);
      ranges.get(m[1])!.push({ path, display, current: m[2] });
    }
  }
  return ranges;
}

/**
 * Run the configured collectors. Error and skip entries are prefixed with
 * the id, because `warehaus verify` looks them up by that prefix when a
 * generated claim cannot be served.
 */
function collect(config: Config, only: Set<string>, level: number): [Record<string, string>, string[], string[]] {
  const env = environment(config);
  const values: Record<string, string> = {};
  const errors: string[] = [];
  const skipped: string[] = [];
  for (const entry of config.standValues) {
    const genId = entry.id;
    if (only.size && !only.has(genId)) continue;
    if (!only.size && BUDGET_LEVELS[entry.budget] > level) {
      skipped.push(`${genId}: needs budget=${entry.budget}`);
      continue;
    }
    const res = runShell(entry.command, config.root, env, COMMAND_TIMEOUT);
    if (res.timedOut) {
      errors.push(`${genId}: timeout after ${COMMAND_TIMEOUT} s`);
      continue;
    }
    if (res.code !== 0) {
      errors.push(`${genId}: exit ${res.code}: ${(res.stderr || res.stdout).trim().slice(0, 160)}`);
      continue;
    }
    values[genId] = res.stdout.trim();
  }
  return [values, errors, skipped];
}

/** Value/range mismatches, and configured ids without any gen range. */
function findDrift(
  values: Record<string, string>,
  ranges: Map<string, Range[]>,
  configured: Set<string>,
  only: Set<string>,
): [string[], string[]] {
  const drift: string[] = [];
  for (const [genId, value] of Object.entries(values)) {
    for (const { display, current } of ranges.get(genId) ?? []) {
      if (normalized(current) !== normalized(value)) {
        drift.push(`${genId}: ${display} carries '${normalized(current)}', the command yields '${normalized(value)}'`);
      }
    }
  }
  const relevant = [...configured].filter((i) => !only.size || only.has(i));
  const missing = relevant
    .filter((i) => !ranges.has(i))
    .sort()
    .map((genId) => `${genId}: no gen range found in any knowledge file`);
  return [drift, missing];
}

/** Rewrite the gen ranges in place; a range that already matches is left alone. */
function writeRanges(config: Config, values: Record<string, string>): number {
  let written = 0;
  for (const { path } of areaFiles(config)) {
    const content = readText(path);
    const updated = content.replace(genRe(), (whole: string, genId: string, current: string) => {
      if (!(genId in values) || normalized(current) === normalized(values[genId])) return whole;
      written++;
      return `<!--gen:${genId}-->${values[genId]}<!--/gen-->`;
    });
    if (updated !== content) writeFileSync(path, updated, "utf-8");
  }
  return written;
}

export const SPEC: Spec = {
  only: { type: "string", help: "comma-separated list of gen ids" },
  budget: { type: "string", help: "cost level to run", default: "free", choices: BUDGET_NAMES },
  check: { type: "boolean", help: "compare only; drift, a missing range or a failed command exits 1" },
  write: { type: "boolean", help: "rewrite the gen ranges in place" },
  format: { type: "string", help: "output format", default: "text", choices: ["text", "json"] },
};

export const DESCRIPTION =
  "Runs the [[stand.values]] collectors from warehaus.toml and previews, " +
  "checks or rewrites the <!--gen:id--> ranges they own. --format=json " +
  "speaks the generator contract used by `warehaus verify`.";

export function run(argv: string[], configPath?: string): number {
  const args = parseArgs(argv, SPEC);
  if (args.check && args.write) throw new ArgError("--check and --write exclude each other");
  let config: Config;
  try {
    config = loadConfig(configPath);
  } catch (exc) {
    if (exc instanceof ConfigError) return die(exc.message);
    throw exc;
  }
  if (!config.standValues.length) return die(`no [[stand.values]] configured in warehaus.toml`);

  const only = new Set(String(args.only).split(",").map((t) => t.trim()).filter(Boolean));
  const budget = String(args.budget);
  const level = BUDGET_LEVELS[budget];
  const configured = new Set(config.standValues.map((e) => e.id));

  const ranges = genRanges(config);
  const [values, errors, skipped] = collect(config, only, level);
  const [drift, missing] = findDrift(values, ranges, configured, only);
  const orphans = [...ranges.keys()].filter((id) => !configured.has(id)).sort();

  // In JSON mode stdout carries exclusively the JSON document; any progress
  // line before it would make it unreadable for the caller (verify).
  const info = args.format === "json" ? err : out;
  const rangeCount = [...ranges.values()].reduce((n, list) => n + list.length, 0);

  info(`Configured values: ${config.standValues.length}, gen ranges on file: ${rangeCount}, budget: ${budget}`);
  if (orphans.length) {
    info(`\nGen ranges without a configured collector (${orphans.length}): their value cannot be renewed and ages unnoticed.`);
    for (const genId of orphans) info(`  ${genId}`);
  }

  if (args.format === "json") {
    out(JSON.stringify({ values, errors, skipped }, null, 1));
    return errors.length ? 1 : 0;
  }

  const entries = Object.entries(values);
  if (entries.length) {
    out(`\nCollected (${entries.length}):`);
    for (const [genId, value] of entries) {
      const shown = normalized(value);
      out(`  ${genId.padEnd(38)} ${shown.length <= 60 ? shown : shown.slice(0, 57) + "..."}`);
    }
  }
  if (errors.length) {
    out(`\nFailed (${errors.length}):`);
    for (const e of errors) out(`  ${e}`);
  }
  if (skipped.length) {
    out(`\nSkipped (${skipped.length}):`);
    for (const s of skipped) out(`  ${s}`);
  }

  if (args.check) {
    const problems = [...drift, ...missing];
    if (problems.length) {
      out(`\nDrift (${problems.length}):`);
      for (const p of problems) out(`  ${p}`);
    } else {
      out("\nNo drift: every gen range matches its collector.");
    }
    out("Check mode, nothing written.");
    return problems.length || errors.length ? 1 : 0;
  }

  if (args.write) {
    const written = writeRanges(config, values);
    out(written ? `\n${written} range(s) updated.` : "\nNothing to update: every range already matches.");
    return errors.length ? 1 : 0;
  }

  if (drift.length || missing.length) {
    out(`\nOut of date (${drift.length + missing.length}):`);
    for (const p of [...drift, ...missing]) out(`  ${p}`);
  }
  out("\nPreview. --write updates the ranges, --check only compares.");
  return errors.length ? 1 : 0;
}
