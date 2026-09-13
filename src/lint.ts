/**
 * Deterministic lint over the claim blocks of the knowledge files.
 *
 * This subcommand enforces the rules that are checkable without a model and
 * without network access. No model call, no API call, no database: it runs
 * in seconds and is therefore fit as a release gate. Rules that need to
 * execute something (verify commands, generated values against the
 * generator) belong to `warehaus verify` and are deliberately not here.
 *
 * Exit convention: 0 green, 1 red, 2 not runnable. The gap list is
 * non-blocking and does not affect the exit code.
 */

import { basename } from "node:path";

import { parseArgs, type Spec } from "./args.js";
import {
  ADR_RE,
  ALLOWED_FIELDS,
  type AreaFile,
  BUDGETS,
  CHRONICLE_RE,
  DATE_RE,
  EXPECTED_EXIT_RE,
  ID_RE,
  MAINTENANCE,
  REQUIRED_ALL,
  REQUIRED_BY_TYPE,
  TYPES,
  areaFiles,
  blockRe,
  collectAdrs,
  countsInLine,
  parseHeader,
  readText,
  stripBlocks,
} from "./claims.js";
import { type Config, ConfigError, SOT_PREFIXES, die, loadConfig, sotValid } from "./config.js";
import { out } from "./output.js";
import { countLines, isDir, isFile, isoDate, parseDate, splitList, today } from "./util.js";

export const SPEC: Spec = {
  json: { type: "boolean", help: "machine-readable report" },
  strict_gaps: { type: "boolean", help: "treat the gap list as errors too (exit 1)" },
};

export const DESCRIPTION =
  "Deterministic lint over all claim blocks. No model, no network: " +
  "runs in seconds and works as a release gate.";

interface ProtectedEntity {
  entity: string;
  pattern: RegExp;
  claim: string;
  exceptions: Set<string>;
}

/**
 * Report protected entities that carry a count-like number OUTSIDE their
 * claim. The guard against "three files, three numbers": a number may live
 * in exactly one place, its claim; everywhere else stands a reference. The
 * check only recognizes registered entities, not free text; that is its
 * known limit.
 */
function checkProtected(config: Config, files: AreaFile[]): string[] {
  if (!config.protectedFile || !isFile(config.protectedFile)) return [];
  const conf = JSON.parse(readText(config.protectedFile)) as {
    global_exceptions?: string[];
    entities?: { entity: string; pattern: string; claim: string; exceptions?: string[] }[];
  };
  const globalExceptions = conf.global_exceptions ?? [];
  const entries: ProtectedEntity[] = (conf.entities ?? []).map((e) => ({
    entity: e.entity,
    pattern: new RegExp(e.pattern, "i"),
    claim: e.claim,
    exceptions: new Set(e.exceptions ?? []),
  }));

  const hits: string[] = [];
  for (const { path, display } of files) {
    const name = basename(path);
    if (globalExceptions.some((x) => path.includes(x) || x === name)) continue;
    // The text OUTSIDE the claim blocks: inside, the number is allowed.
    const outside = stripBlocks(readText(path));
    for (const line of outside.split("\n")) {
      for (const { entity, pattern, claim, exceptions } of entries) {
        if (exceptions.has(name) || !pattern.test(line)) continue;
        const numbers = countsInLine(line);
        if (numbers.length) {
          hits.push(`${display}: ${entity} with number ${numbers.join(", ")} outside its designated claim '${claim}'`);
        }
      }
    }
  }
  return hits;
}

interface Seen {
  loc: string;
  fields: Record<string, string>;
  area: string;
}

export function run(argv: string[], configPath?: string): number {
  const args = parseArgs(argv, SPEC);
  let config: Config;
  try {
    config = loadConfig(configPath);
  } catch (exc) {
    if (exc instanceof ConfigError) return die(exc.message);
    throw exc;
  }

  if (!config.areas.some((a) => isDir(a.root))) {
    return die(`none of the configured area roots exists; check [[areas]] in ${config.path}`);
  }

  const now = today();
  const adrs = collectAdrs(config);
  const claims = new Map<string, Seen>();
  const errors: string[] = [];
  const gaps: string[] = [];
  const files = areaFiles(config);
  const byArea: Record<string, number> = {};

  for (const { area, path, display } of files) {
    const content = readText(path);

    // Catch unbalanced blocks before the regex silently swallows them.
    const opened = (content.match(/^[ \t]*<!-- claim$/gm) ?? []).length;
    const closed = (content.match(/^[ \t]*<!-- \/claim -->[ \t]*$/gm) ?? []).length;
    if (opened !== closed) {
      errors.push(`${display}: ${opened} opened vs ${closed} closed claim blocks`);
    }

    const found = [...content.matchAll(blockRe())];
    if (found.length !== opened) {
      errors.push(`${display}: ${opened} block openings, but only ${found.length} parseable blocks`);
    }

    for (const m of found) {
      const line = countLines(content, m.index ?? 0);
      const loc = `${display}:${line}`;
      const [fields, headerErrors] = parseHeader(m.groups!.header);
      for (const e of headerErrors) errors.push(`${loc}: ${e}`);

      const cid = fields.id ?? "";
      const ctype = fields.type ?? "";

      // Unknown fields, missing required fields.
      for (const k of Object.keys(fields)) {
        if (!ALLOWED_FIELDS.has(k)) errors.push(`${loc}: unknown field '${k}'`);
      }
      const missing = new Set<string>();
      for (const f of REQUIRED_ALL) if (!(f in fields)) missing.add(f);
      if (ctype in REQUIRED_BY_TYPE) {
        for (const f of REQUIRED_BY_TYPE[ctype]) if (!(f in fields)) missing.add(f);
      }
      // type=rule is exempt on purpose: a decided calculation or behaviour
      // rule is not checked by comparing data but by whether it shows up in
      // behaviour, i.e. through an eval suite. If the gap list counted it,
      // the list would permanently report non-defects, and a list full of
      // non-defects is one nobody works through any more.
      if (fields.maintenance === "verified" && !("verify_cmd" in fields) && ctype !== "rule") {
        gaps.push(`${loc}: maintenance=verified without verify_cmd`);
      }
      if ("verify_cmd" in fields && !("budget" in fields)) missing.add("budget");
      for (const f of [...missing].sort()) {
        errors.push(`${loc}: required field '${f}' is missing (type=${ctype || "?"})`);
      }

      // id format and global uniqueness.
      if (cid && !ID_RE.test(cid)) errors.push(`${loc}: id '${cid}' violates the kebab-case format`);
      if (cid) {
        const earlier = claims.get(cid);
        if (earlier) {
          errors.push(`${loc}: id '${cid}' already taken in ${earlier.loc}`);
        } else {
          claims.set(cid, { loc, fields, area });
          byArea[area] = (byArea[area] ?? 0) + 1;
        }
      }

      // Value ranges.
      if (ctype && !TYPES.has(ctype)) errors.push(`${loc}: type '${ctype}' unknown`);
      const mnt = fields.maintenance;
      if (mnt && !MAINTENANCE.has(mnt)) errors.push(`${loc}: maintenance '${mnt}' unknown`);
      const b = fields.budget;
      if (b && !BUDGETS.has(b)) errors.push(`${loc}: budget '${b}' unknown`);
      const s = fields.sot;
      if (s && !sotValid(config, s)) {
        errors.push(
          `${loc}: sot '${s}' is not in [schema] sots and matches no allowed prefix (${SOT_PREFIXES.join(", ")})`,
        );
      }
      const ee = fields.expected_exit;
      if (ee && !EXPECTED_EXIT_RE.test(ee)) {
        errors.push(`${loc}: expected_exit '${ee}' unknown (allowed: 'non-zero' or a number)`);
      }
      if (ee && !fields.verify_cmd) errors.push(`${loc}: expected_exit without verify_cmd has no effect`);
      const hit = CHRONICLE_RE.exec(m.groups!.text);
      if (hit) {
        errors.push(
          `${loc}: history prose in the body ('${hit[0]}'): a claim ` +
            "carries only the current state; predecessors belong in git and " +
            "in supersedes/superseded_by, not in the prose",
        );
      }
      if (ctype === "count" && fields.maintenance !== "generated") {
        errors.push(`${loc}: type=count requires maintenance=generated (is ${quoteOrNone(fields.maintenance)})`);
      }
      if (ctype === "experience" && fields.maintenance !== "manual") {
        errors.push(`${loc}: type=experience requires maintenance=manual (is ${quoteOrNone(fields.maintenance)})`);
      }

      // Dates.
      let asOf: number | null = null;
      for (const fname of ["as_of", "valid_until", "confirmed_on"]) {
        if (!(fname in fields)) continue;
        const value = fields[fname];
        if (!DATE_RE.test(value)) {
          errors.push(`${loc}: ${fname} '${value}' is not YYYY-MM-DD`);
          continue;
        }
        const d = parseDate(value);
        if (d === null) {
          errors.push(`${loc}: ${fname} '${value}' is not a valid date`);
        } else if (fname === "as_of") {
          asOf = d;
          if (d > now) errors.push(`${loc}: as_of ${value} lies in the future`);
        }
      }

      const validUntil = fields.valid_until ? parseDate(fields.valid_until) : null;
      if (validUntil !== null && asOf !== null && validUntil <= asOf) {
        errors.push(`${loc}: valid_until ${isoDate(validUntil)} does not lie after as_of ${isoDate(asOf)}`);
      }

      // No heading inside the body: a heading there shifts the file's
      // outline and breaks section-based tooling.
      if (/^#/m.test(m.groups!.text)) errors.push(`${loc}: body contains a heading line`);

      // References: ADRs immediately, claim ids after collection.
      const dec = fields.decided_in;
      if (dec && !ADR_RE.test(dec)) {
        errors.push(`${loc}: decided_in '${dec}' is not an ADR-NNNN reference`);
      } else if (dec && adrs.size && !adrs.has(dec)) {
        errors.push(`${loc}: decided_in ${dec} points to a non-existent ADR`);
      }

      // Gap list.
      if (ctype === "snapshot" && validUntil !== null && validUntil < now) {
        gaps.push(`${loc}: snapshot expired on ${isoDate(validUntil)} (${now - validUntil} days ago)`);
      }
      if (asOf !== null && ctype in config.intervals) {
        const age = now - asOf;
        if (age > config.intervals[ctype]) {
          gaps.push(
            `${loc}: as_of ${isoDate(asOf)} is ${age} days old (interval ${config.intervals[ctype]} for type=${ctype})`,
          );
        }
      }
      if (ctype === "experience") {
        const conf = parseDate(fields.confirmed_on);
        if (conf !== null && now - conf > config.intervals.experience) {
          gaps.push(`${loc}: experience unconfirmed for ${now - conf} days`);
        }
      }
      if ("superseded_by" in fields) {
        gaps.push(`${loc}: marked historical (superseded_by); no longer cite as current knowledge`);
      }
    }
  }

  // Resolve claim references once all ids are known.
  for (const entry of claims.values()) {
    for (const fname of ["supersedes", "superseded_by"]) {
      for (const target of splitList(entry.fields[fname])) {
        if (ADR_RE.test(target)) {
          if (adrs.size && !adrs.has(target)) {
            errors.push(`${entry.loc}: ${fname} points to non-existent ${target}`);
          }
        } else if (!claims.has(target)) {
          errors.push(`${entry.loc}: ${fname} points to unknown claim id '${target}'`);
        }
      }
    }
  }

  const protectedHits = checkProtected(config, files);
  errors.push(...protectedHits);

  const report = {
    files: files.length,
    claims: claims.size,
    claims_by_area: byArea,
    errors,
    protected_hits: protectedHits,
    gaps,
    adrs_known: adrs.size,
  };

  if (args.json) {
    out(JSON.stringify(report, null, 1));
  } else {
    out(`Knowledge files: ${files.length}, claims: ${claims.size}, ADRs known: ${adrs.size}`);
    if (errors.length) {
      out(`\nERRORS (${errors.length}), blocking:`);
      for (const e of errors) out(`  ${e}`);
    } else {
      out("\nNo blocking errors.");
    }
    if (gaps.length) {
      out(`\nGap list (${gaps.length}), non-blocking:`);
      for (const g of gaps) out(`  ${g}`);
    }
  }

  if (errors.length) return 1;
  if (gaps.length && args.strict_gaps) return 1;
  return 0;
}

function quoteOrNone(value: string | undefined): string {
  return value === undefined ? "None" : `'${value}'`;
}
