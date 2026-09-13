/**
 * Run the `verify_cmd` of each claim and judge the result.
 *
 * The lint checks the FORM of a claim. This module checks what can be said
 * mechanically about its CONTENT, and is honest about where that ends.
 *
 * An exit convention of "0 confirmed, 1 refuted, 2 unverifiable" assumes
 * that a verify command tests an ASSERTION. Most verify commands do not;
 * they FETCH:
 *
 *     curl https://api.example.com/orders/count
 *
 * That command exits 0 no matter whether the number in the claim is right.
 * Whoever books exit 0 as "confirmed" and advances the `as_of` date builds a
 * guard that reports every claim green and guards nothing.
 *
 * Hence four verdicts instead of three:
 *
 *     confirmed     The command is a real check (assertion) and was green, OR
 *                   the claim carries a generated range and the generator
 *                   returns the same value within tolerance.
 *     refuted       Assertion red (exit 1), or the generator value deviates
 *                   beyond tolerance, or a search no longer finds its pattern.
 *     executed      The fetch ran clean, but whether the claim text is right
 *                   this module cannot decide. The output is captured for
 *                   the report; the semantic cross-check is model or human
 *                   work. NEVER count this as confirmation.
 *     unverifiable  Placeholder in the command, timeout, suspected write
 *                   access, unexpected exit code.
 *
 * Only `confirmed` advances the `as_of` date with --write.
 *
 * Assertions are not guessed. They are declared: the built-in patterns cover
 * `warehaus lint` and `warehaus contradictions` (both exit 1 on failure), and
 * a project adds its own real checks via `[verify] assert_patterns`.
 *
 * Searches (grep/rg) have a useful asymmetry: if the search does NOT find
 * its pattern (exit 1), the spot the claim relies on is gone and the claim
 * is refuted. If it finds it, only the existence of the spot is proven, not
 * the prose next to it. Absence proves; presence does not.
 *
 * Exit: 0 nothing refuted, 1 at least one claim refuted, 2 not runnable.
 */

import { writeFileSync } from "node:fs";
import { basename } from "node:path";

import { parseArgs, type Spec } from "./args.js";
import { BUDGET_LEVELS, BUDGET_NAMES, type Claim, blockRe, claimId, genRe, parseHeader, readClaims, readText } from "./claims.js";
import { type Config, ConfigError, die, loadConfig } from "./config.js";
import { out } from "./output.js";
import { isFile, isoDate, normalized, repr, runShell, today } from "./util.js";

// Built-in assertion patterns: commands that really test a statement and
// exit 1 on deviation. A project registers its own via [verify] assert_patterns.
const BUILTIN_ASSERT_PATTERNS = [/\bwarehaus\s+(lint|contradictions)\b/];

const SEARCH_PATTERNS = [/^\s*grep\b/, /\|\s*grep\b/, /&&\s*grep\b/, /^\s*rg\b/];

// A verify command is read-only. These markers hint at a write; the module
// refuses to run them instead of trying.
const FORBIDDEN: [RegExp, string][] = [
  [/--commit\b/, "--commit\\b"],
  [/--write\b/, "--write\\b"],
  [/-X\s*(POST|PUT|PATCH|DELETE)\b/i, "-X\\s*(POST|PUT|PATCH|DELETE)\\b"],
  [/\b(rm|mv|dd|truncate)\s/, "\\b(rm|mv|dd|truncate)\\s"],
  [/\.(create|update|delete|cancel|void|commit)\b/, "\\.(create|update|delete|cancel|void|commit)\\b"],
];

const PLACEHOLDER_RE = /<[^>]{2,}>/g;

const VERDICT_ORDER = ["refuted", "unverifiable", "executed", "confirmed"] as const;
type Verdict = (typeof VERDICT_ORDER)[number];

export interface Result {
  id: string;
  type: string | null;
  sot: string | null;
  maintenance: string | null;
  budget: string | null;
  as_of: string | null;
  file: string;
  path: string;
  line: number;
  cmd: string | null;
  verdict: Verdict | null;
  reason: string;
  output: string;
  claim_text: string;
}

/**
 * Process environment plus the configured env file. Without this, every
 * verify command that does not run through a CLI tool fails: a bare `curl`
 * inside a verify command gets the keys from nowhere and strands as
 * "unverifiable" although the claim is fine.
 */
export function environment(config: Config): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (!config.envFile || !isFile(config.envFile)) return env;
  for (const rawLine of readText(config.envFile).split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const eq = line.indexOf("=");
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && value[0] === value[value.length - 1] && (value[0] === '"' || value[0] === "'")) {
      value = value.slice(1, -1);
    }
    if (env[key] === undefined) env[key] = value;
  }
  return env;
}

/** Values that never belong in a report. */
function secretValues(env: NodeJS.ProcessEnv): string[] {
  const hits = new Set<string>();
  for (const [key, value] of Object.entries(env)) {
    if (!value || value.length < 12) continue;
    if (/(KEY|TOKEN|SECRET|PASS|CLIENT_ID|SERVICE_ROLE)/i.test(key)) hits.add(value);
  }
  return [...hits].sort((a, b) => b.length - a.length);
}

function redact(text: string, values: string[]): string {
  for (const value of values) {
    if (value && text.includes(value)) text = text.split(value).join("<redacted>");
  }
  return text;
}

function isAssertion(cmd: string, extra: RegExp[]): boolean {
  return [...BUILTIN_ASSERT_PATTERNS, ...extra].some((p) => p.test(cmd));
}

function isSearch(cmd: string): boolean {
  return SEARCH_PATTERNS.some((p) => p.test(cmd));
}

function writeSuspicion(cmd: string): string | null {
  for (const [re, source] of FORBIDDEN) if (re.test(cmd)) return source;
  return null;
}

/**
 * Fetch the value of a generated claim from the project's generator.
 * Contract: the command must accept --budget/--only/--format=json and print
 * {"values": {...}, "errors": [...], "skipped": [...]}.
 */
function generatorValue(config: Config, genId: string, budget: string): [string | null, string] {
  const cmd = `${config.generatorCommand} --budget=${budget} --only=${genId} --format=json`;
  const res = runShell(cmd, config.root, process.env, 600);
  if (res.timedOut) return [null, "generator timed out after 600 s"];
  let data: { values?: Record<string, string>; errors?: unknown[]; skipped?: unknown[] };
  try {
    data = JSON.parse(res.stdout);
  } catch {
    return [null, `generator output not readable: ${(res.stderr || res.stdout).trim().slice(0, 160)}`];
  }
  if (data.values && genId in data.values) return [String(data.values[genId]), "from generator"];
  const reason = [...(data.errors ?? []), ...(data.skipped ?? [])].map(String).find((f) => f.startsWith(genId));
  return [null, reason ?? "generator returned no value"];
}

function asNumber(value: string | null): number | null {
  const raw = (value ?? "").replace(/[^\d]/g, "");
  return raw ? Number(raw) : null;
}

function check(
  claim: Claim,
  config: Config,
  env: NodeJS.ProcessEnv,
  secrets: string[],
  assertExtra: RegExp[],
  timeout: number,
  outputChars: number,
): Result {
  const header = claim.header;
  const cmd = header.verify_cmd;
  const result: Result = {
    id: claimId(claim),
    type: header.type ?? null,
    sot: header.sot ?? null,
    maintenance: header.maintenance ?? null,
    budget: header.budget ?? null,
    as_of: header.as_of ?? null,
    file: claim.display,
    path: claim.path,
    line: claim.line,
    cmd: cmd ?? null,
    verdict: null,
    reason: "",
    output: "",
    claim_text: normalized(claim.text).slice(0, 600),
  };

  if (!cmd) {
    result.verdict = "unverifiable";
    result.reason = "no verify_cmd";
    return result;
  }

  // Placeholders only OUTSIDE quotes: a search pattern may contain angle
  // brackets (`grep 'Usage: x <a|b>' file`), and those are not a blank to
  // fill in but part of the searched text.
  const withoutStrings = cmd.replace(/'[^']*'|"[^"]*"/g, " ");
  const placeholders = withoutStrings.match(PLACEHOLDER_RE);
  if (placeholders) {
    result.verdict = "unverifiable";
    result.reason = "placeholder in the command, not executable without filling in: " + placeholders.join(", ");
    return result;
  }

  const suspicion = writeSuspicion(cmd);
  if (suspicion) {
    result.verdict = "unverifiable";
    result.reason = `possible write access, not executed (pattern '${suspicion}')`;
    return result;
  }

  // Generated claims are held against the generator, not against an exit
  // code. This is the only place where a fetch becomes a real statement
  // about the claim's content.
  const gen = genRe().exec(claim.text);
  if (header.maintenance === "generated" && gen) {
    const genId = gen[1];
    const inText = normalized(gen[2]);
    if (!config.generatorCommand) {
      result.verdict = "unverifiable";
      result.reason = "no [generator] command configured";
      return result;
    }
    const [value, hint] = generatorValue(config, genId, header.budget ?? "free");
    result.output = `generator: ${repr(value)} | claim: ${repr(inText)} (${hint})`;
    if (value === null) {
      result.verdict = "unverifiable";
      result.reason = hint;
      return result;
    }
    if (normalized(value) === inText) {
      result.verdict = "confirmed";
      result.reason = "generator value identical";
      return result;
    }
    const a = asNumber(inText);
    const b = asNumber(value);
    const tolerance = Number((header.tolerance ?? "0%").replace(/%$/, "") || 0);
    if (a && b && a !== 0 && (Math.abs(b - a) / a) * 100 <= tolerance) {
      result.verdict = "confirmed";
      result.reason = `within tolerance ${Math.round(tolerance)} %`;
      return result;
    }
    result.verdict = "refuted";
    result.reason = `generator returns ${repr(value)}, claim says ${repr(inText)}`;
    return result;
  }

  const res = runShell(cmd, config.root, env, timeout);
  if (res.timedOut) {
    result.verdict = "unverifiable";
    result.reason = `timeout after ${timeout} s`;
    return result;
  }

  const stdout = res.stdout.trim();
  const stderr = res.stderr.trim();
  result.output = redact(stdout || stderr, secrets).slice(0, outputChars);

  // Some claims state that something does NOT work ("the API has no
  // sessions endpoint"). There a failing command is the confirmation. The
  // runner cannot see the polarity in the command, so the claim declares it.
  const expected = header.expected_exit;
  if (expected) {
    const matches = expected === "non-zero" ? res.code !== 0 : String(res.code) === expected;
    result.verdict = matches ? "confirmed" : "refuted";
    result.reason = `expected_exit=${expected}, actual ${res.code}` + (matches ? "" : " - the claim predicts the opposite");
    return result;
  }

  if (res.code === 0) {
    if (isAssertion(cmd, assertExtra)) {
      result.verdict = "confirmed";
      result.reason = "assertion green";
    } else if (isSearch(cmd)) {
      result.verdict = "executed";
      result.reason =
        "The search found its pattern, so the referenced spot exists. " +
        "Whether the prose next to it is right, this does not say; " +
        "semantic cross-check still open.";
    } else {
      result.verdict = "executed";
      result.reason =
        "Fetch command ran clean. Exit 0 says NOTHING about whether " +
        "the claim text is right; semantic cross-check still open.";
    }
  } else if (res.code === 1 && isAssertion(cmd, assertExtra)) {
    result.verdict = "refuted";
    result.reason = "assertion red (exit 1)";
  } else if (res.code === 1 && isSearch(cmd)) {
    result.verdict = "refuted";
    result.reason = "The search NO LONGER finds its pattern. The spot the claim relies on is gone, renamed or moved.";
  } else if (res.code === 2) {
    result.verdict = "unverifiable";
    result.reason = "command reports not runnable (exit 2)";
  } else {
    result.verdict = "unverifiable";
    result.reason = `unexpected exit ${res.code}`;
  }
  return result;
}

/** Advance `as_of` to today, only for confirmed claims. */
function writeAsOf(confirmed: Result[]): number {
  const date = isoDate(today());
  const perFile = new Map<string, Set<string>>();
  for (const r of confirmed) {
    if (!perFile.has(r.path)) perFile.set(r.path, new Set());
    perFile.get(r.path)!.add(r.id);
  }
  let written = 0;
  for (const [path, ids] of perFile) {
    const content = readText(path);
    const updated = content.replace(blockRe(), (block: string, ...rest: unknown[]) => {
      const groups = rest[rest.length - 1] as { header: string };
      const [header] = parseHeader(groups.header);
      if (!ids.has(header.id) || header.as_of === date) return block;
      written++;
      const newHeader = groups.header.replace(/^as_of:.*$/m, `as_of: ${date}`);
      return block.replace(groups.header, newHeader);
    });
    if (updated !== content) writeFileSync(path, updated, "utf-8");
  }
  return written;
}

export const SPEC: Spec = {
  budget: { type: "string", help: "cost level to run", default: "free", choices: BUDGET_NAMES },
  only: { type: "string", help: "comma-separated list of claim ids" },
  file: { type: "string", help: "only claims from this knowledge file" },
  type: { type: "string", help: "only claims of this type" },
  timeout: { type: "int", help: "seconds per command (default: [verify] timeout from warehaus.toml)" },
  output_chars: { type: "int", help: "how much command output goes into the report", default: 1200 },
  write: { type: "boolean", help: "advance as_of of CONFIRMED claims to today" },
  json: { type: "boolean", help: "machine-readable report" },
};

export const DESCRIPTION =
  "Runs verify commands and reports confirmed, refuted, executed or " +
  "unverifiable per claim. Executed is not confirmed.";

export function run(argv: string[], configPath?: string): number {
  const args = parseArgs(argv, SPEC);
  let config: Config;
  try {
    config = loadConfig(configPath);
  } catch (exc) {
    if (exc instanceof ConfigError) return die(exc.message);
    throw exc;
  }

  const only = new Set(String(args.only).split(",").map((t) => t.trim()).filter(Boolean));
  const budget = String(args.budget);
  const level = BUDGET_LEVELS[budget];
  const timeout = Number(args.timeout) || config.verifyTimeout;
  let assertExtra: RegExp[];
  try {
    assertExtra = config.assertPatterns.map((p) => new RegExp(p));
  } catch (exc) {
    return die(`invalid regex in [verify] assert_patterns: ${(exc as Error).message}`);
  }

  const allClaims = readClaims(config);
  const due: Claim[] = [];
  let skipped = 0;
  for (const claim of allClaims) {
    const header = claim.header;
    if (only.size && !only.has(header.id)) continue;
    if (args.file && basename(claim.path) !== args.file) continue;
    if (args.type && header.type !== args.type) continue;
    if (!only.size && (BUDGET_LEVELS[header.budget ?? "free"] ?? 0) > level) {
      skipped++;
      continue;
    }
    due.push(claim);
  }

  if (!args.json) {
    out(`Claims total ${allClaims.length}, checked ${due.length}, skipped for budget ${skipped} (level ${budget})\n`);
  }

  const env = environment(config);
  const secrets = secretValues(env);
  const results: Result[] = [];
  due.forEach((claim, i) => {
    if (!args.json) out(`[${i + 1}/${due.length}] ${claimId(claim)} ...`);
    results.push(check(claim, config, env, secrets, assertExtra, timeout, Number(args.output_chars)));
  });

  const byVerdict = new Map<string, Result[]>();
  for (const r of results) {
    const key = r.verdict ?? "null";
    if (!byVerdict.has(key)) byVerdict.set(key, []);
    byVerdict.get(key)!.push(r);
  }

  const refuted = byVerdict.get("refuted") ?? [];
  const confirmed = byVerdict.get("confirmed") ?? [];
  const written = args.write && confirmed.length ? writeAsOf(confirmed) : 0;
  const summary: Record<string, number> = {};
  for (const [k, v] of byVerdict) summary[k] = v.length;

  if (args.json) {
    out(
      JSON.stringify(
        { budget, checked: due.length, skipped, summary, as_of_written: written, results },
        null,
        1,
      ),
    );
  } else {
    out("\n" + "=".repeat(70));
    for (const verdict of VERDICT_ORDER) {
      const items = byVerdict.get(verdict) ?? [];
      if (!items.length) continue;
      out(`\n${verdict.toUpperCase()} (${items.length}):`);
      for (const r of items) {
        out(`  ${r.file}:${r.line}  ${r.id}`);
        out(`      ${r.reason}`);
      }
    }
    out("\n" + "=".repeat(70));
    out(`Summary: {${Object.entries(summary).map(([k, v]) => `'${k}': ${v}`).join(", ")}}`);
    if (written) out(`as_of advanced for ${written} claims.`);
    const executed = byVerdict.get("executed");
    if (executed?.length) {
      out(
        `\nNOTE: ${executed.length} fetch commands ran clean ` +
          "but say nothing about whether the claim text is right. " +
          "Those need the semantic cross-check " +
          "(--json prints command output and claim text side by side).",
      );
    }
  }

  return refuted.length ? 1 : 0;
}
