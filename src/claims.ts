/**
 * Claim parsing and schema constants shared by lint, verify and contradictions.
 *
 * A claim is a block of Markdown wrapped in HTML comments:
 *
 *     <!-- claim
 *     id: billing-amounts-in-cents
 *     type: structure
 *     sot: billing-api
 *     maintenance: verified
 *     verify_cmd: "grep -q cents docs/billing-api.md"
 *     budget: free
 *     as_of: 2026-08-31
 *     -->
 *     The billing API returns all amounts as integer cents. Divide by 100
 *     for display.
 *     <!-- /claim -->
 *
 * The header is flat YAML, one field per line. Claims with
 * `maintenance: generated` may carry one generated range in the body:
 *
 *     <!--gen:claim-id-->1366<!--/gen-->
 *
 * Only that range is ever written by the generator; the surrounding text
 * stays hand-written, and a hand edit inside the range counts as drift.
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";

import type { Config } from "./config.js";
import { countLines, glob, isDir } from "./util.js";

// ── Schema value ranges ──────────────────────────────────────────────────────

export const TYPES = new Set(["structure", "access", "rule", "metric", "count", "snapshot", "experience"]);
export const MAINTENANCE = new Set(["generated", "verified", "manual"]);
export const BUDGETS = new Set(["free", "single_call", "bulk"]);
export const BUDGET_LEVELS: Record<string, number> = { free: 0, single_call: 1, bulk: 2 };
export const BUDGET_NAMES = ["free", "single_call", "bulk"] as const;

export const REQUIRED_ALL = new Set(["id", "type", "sot", "maintenance", "as_of"]);
// Additional required fields per claim type.
export const REQUIRED_BY_TYPE: Record<string, Set<string>> = {
  access: new Set(["verify_cmd"]),
  rule: new Set(["decided_in"]),
  metric: new Set(["derivation", "verify_cmd"]),
  count: new Set(["verify_cmd"]),
  snapshot: new Set(["valid_until"]),
  experience: new Set(["source", "confirmed_on"]),
};
export const ALLOWED_FIELDS = new Set([
  ...REQUIRED_ALL,
  "verify_cmd",
  "derivation",
  "tolerance",
  "valid_until",
  "decided_in",
  "source",
  "confirmed_on",
  "evidence",
  "budget",
  "supersedes",
  "superseded_by",
  // Polarity of the verify command. Some claims state that something does
  // NOT work ("the API has no sessions endpoint"); there a failing command
  // is the confirmation. Without this field the verify run would have to
  // guess the intent and would report a correct claim as broken.
  "expected_exit",
]);

export const ID_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const ADR_RE = /^ADR-\d{4}$/;
export const EXPECTED_EXIT_RE = /^(non-zero|\d{1,3})$/;

// Fresh RegExp per use: a global regex carries lastIndex state.
export const blockRe = (): RegExp =>
  /^(?<indent>[ \t]*)<!-- claim\n(?<header>[\s\S]*?)^[ \t]*-->\n(?<text>[\s\S]*?)^[ \t]*<!-- \/claim -->[ \t]*$/gm;
export const genRe = (): RegExp => /<!--gen:([a-z0-9-]+)-->([\s\S]*?)<!--\/gen-->/g;

// History prose in a claim body. A claim carries only the current state of
// knowledge; predecessors live in git and in supersedes/superseded_by, never
// in the prose. Left in, the next writer copies the pattern as house style.
// Deliberately NOT matched: a refuted counter-hypothesis ("the counter-
// hypothesis X is refuted") and mappings for legacy values that still occur
// in persisted data. Both are current knowledge.
export const CHRONICLE_RE = new RegExp(
  "(?:the\\s+)?(?:previous|earlier|old|original|first)\\s+(?:version|revision|wording)\\s+(?:said|stated|read|claimed|had)" +
    "|used\\s+to\\s+(?:say|state|read|claim)" +
    "|formerly\\s+(?:said|stated|read|claimed)" +
    "|was\\s+silently\\s+replaced" +
    "|until\\s+\\d{4}-\\d{2}-\\d{2}\\s+this\\s+(?:claim|section|file)\\s+(?:said|read)",
  "i",
);

export interface Claim {
  area: string;
  path: string;
  display: string; // "area:filename"
  line: number;
  header: Record<string, string>;
  text: string;
  headerErrors: string[];
}

export function claimId(claim: Claim): string {
  return claim.header.id ?? "(no id)";
}

// ── Parsing ──────────────────────────────────────────────────────────────────

/** Flat YAML, one field per line. Returns [fields, errors]. */
export function parseHeader(raw: string): [Record<string, string>, string[]] {
  const fields: Record<string, string> = {};
  const errors: string[] = [];
  raw.split("\n").forEach((line, index) => {
    const no = index + 1;
    if (!line.trim()) return;
    const colon = line.indexOf(":");
    if (colon === -1) {
      errors.push(`header line ${no} has no colon: '${line.trim().slice(0, 60)}'`);
      return;
    }
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      // Double quotes mean YAML escapes must be resolved. Without this, a
      // command like `grep 'a\|b' file` runs as a search for a literal
      // backslash and is guaranteed to find nothing: the verify run would
      // report a correct claim as refuted.
      value = value.slice(1, -1).replace(/\\\\/g, "\\").replace(/\\"/g, '"');
    }
    if (key in fields) errors.push(`field '${key}' appears twice in the header`);
    fields[key] = value;
  });
  return [fields, errors];
}

// ── File and claim collection ────────────────────────────────────────────────

export interface AreaFile {
  area: string;
  path: string;
  display: string;
}

/** Every file that may carry claims, with its area and display name. */
export function areaFiles(config: Config): AreaFile[] {
  const out: AreaFile[] = [];
  for (const area of config.areas) {
    if (!isDir(area.root)) continue;
    for (const pattern of area.files) {
      for (const p of glob(area.root, pattern)) {
        const name = basename(p);
        if (config.exampleFiles.has(name)) continue;
        out.push({ area: area.name, path: p, display: `${area.name}:${name}` });
      }
    }
  }
  return out;
}

export function readText(path: string): string {
  return readFileSync(path, "utf-8");
}

/** Every claim in every area, with file, line, header and body. */
export function readClaims(config: Config): Claim[] {
  const found: Claim[] = [];
  for (const { area, path, display } of areaFiles(config)) {
    const content = readText(path);
    for (const m of content.matchAll(blockRe())) {
      const groups = m.groups!;
      const [header, errors] = parseHeader(groups.header);
      found.push({
        area,
        path,
        display,
        line: countLines(content, m.index ?? 0),
        header,
        text: groups.text,
        headerErrors: errors,
      });
    }
  }
  return found;
}

/** Text outside every claim block. */
export function stripBlocks(content: string): string {
  return content.replace(blockRe(), "");
}

const ADR_FILE = "[0-9][0-9][0-9][0-9]-*.md";

/** ADR identifiers (ADR-NNNN) found in the configured ADR directories. */
export function collectAdrs(config: Config): Set<string> {
  const found = new Set<string>();
  for (const dir of config.adrDirs) {
    if (!isDir(dir)) continue;
    for (const p of glob(dir, ADR_FILE)) found.add(`ADR-${basename(p).slice(0, 4)}`);
  }
  return found;
}

/** ADR identifier -> normalized status (Accepted, Superseded, ...). */
export function adrStatus(config: Config): Record<string, string> {
  const status: Record<string, string> = {};
  const normalize: Record<string, string> = {
    accepted: "Accepted",
    superseded: "Superseded",
    deprecated: "Superseded",
  };
  for (const dir of config.adrDirs) {
    if (!isDir(dir)) continue;
    for (const p of glob(dir, ADR_FILE)) {
      const head = readText(p).slice(0, 600);
      const m = head.match(/\*{0,2}Status\*{0,2}\s*:\s*(\w+)/);
      const raw = (m ? m[1] : "unknown").toLowerCase();
      status[`ADR-${basename(p).slice(0, 4)}`] = normalize[raw] ?? raw;
    }
  }
  return status;
}

// ── Count-like numbers ───────────────────────────────────────────────────────
// Used by the protected-entities check in lint and by the contradiction
// search. One shared filter on purpose: two separate number filters mean every
// insight about identifiers has to be built in twice, and the third time it is
// forgotten once.

const NUMBER_RE = /\b\d{1,3}(?:[.,]\d{3})+\b|\b\d{4,}\b/g;
const YEAR_MIN = 1990;
const YEAR_MAX = 2100;
// From here on a number is an identifier (customer, order, tracking number),
// never a count.
export const IDENTIFIER_MIN = 100_000_000;

// What sits left of a number when it is an identifier rather than a count.
// Without this distinction the protected-entities check reports `group_id=57291`,
// `ADR 0031` and board IDs as counts, and a guard that is wrong most of the
// time gets switched off instead of read.
const IDENTIFIER_LEFT_RE = new RegExp(
  "(?:id|ids|no|nr|number|adr|board|group|group_id|customer_id|order|" +
    "pipeline|portal|port|list_id|project|sku|vat)" +
    "[\\s:=_-]{0,3}[\"'`(\\[]?$",
  "i",
);

// Limits are structure, not quantity. `limit at most 1000` describes the API,
// not the stock; reported as a count it produces noise wherever a page limit
// is documented.
const LIMIT_LEFT_RE = new RegExp(
  "(?:limit|max|maximum|at\\s+most|cap|ceiling|quota|per\\s+page|per\\s+minute|" +
    "per\\s+second|per\\s+day|up\\s+to|max_items)" +
    "[\\s:=_-]{0,4}[\"'`(\\[]?$",
  "i",
);

/**
 * Numbers in one line that plausibly are counts.
 *
 * Filtered out: years, identifiers (too long, leading zero, or an identifier
 * word right before them) and numbers inside backticks, because those are
 * almost always code or a parameter value.
 */
export function countsInLine(line: string): string[] {
  const withoutCode = line.replace(/`[^`]*`/g, " ");
  const hits: string[] = [];
  for (const m of withoutCode.matchAll(NUMBER_RE)) {
    const raw = m[0];
    if (raw.startsWith("0")) continue; // a leading zero is never a count
    const n = countValue(raw);
    if ((n >= YEAR_MIN && n <= YEAR_MAX) || n >= IDENTIFIER_MIN) continue;
    const start = m.index ?? 0;
    const left = withoutCode.slice(Math.max(0, start - 24), start);
    if (IDENTIFIER_LEFT_RE.test(left) || LIMIT_LEFT_RE.test(left)) continue;
    // SKU shape: letters, hyphen, number (US-110010). A prefix directly at
    // the hyphen is always an identifier, never a quantity.
    if (/[A-Za-z]{2,}-$/.test(left)) continue;
    hits.push(raw);
  }
  return hits;
}

export function countValue(raw: string): number {
  return Number(raw.replace(/[.,]/g, ""));
}
