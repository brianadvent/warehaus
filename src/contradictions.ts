/**
 * Contradiction search across the claim inventory.
 *
 * This command REPORTS conflicts, it does not resolve them. A knowledge
 * system that corrects itself without anyone looking is exactly the problem
 * this whole tool is built against.
 *
 * What it looks for:
 *
 * 1. The same notable number in more than one claim. A distinctive number
 *    that hangs on several claims with different meanings is a contradiction
 *    waiting to happen; the canonical failure mode is "three files, three
 *    numbers" for the same quantity.
 * 2. A number from a claim that also sits in the prose outside every claim
 *    block. The prose then ages unnoticed next to the maintained claim.
 * 3. Rule claims whose ADR is no longer Accepted. When an ADR moves to
 *    Superseded, the rules hanging off it must follow.
 * 4. Contradicting dates: valid_until before as_of, confirmed_on or as_of in
 *    the future, superseded_by pointing at a claim that was itself superseded.
 * 5. Two claims with the same core statement, detected via high word overlap
 *    at equal type. That is a heuristic and is reported as a notice.
 *
 * Exit: 0 no conflicts, 1 at least one conflict found, 2 not runnable.
 */

import { parseArgs, type Spec } from "./args.js";
import {
  type Claim,
  IDENTIFIER_MIN,
  adrStatus,
  areaFiles,
  claimId,
  countValue,
  countsInLine,
  readClaims,
  readText,
  stripBlocks,
} from "./claims.js";
import { type Config, ConfigError, die, loadConfig } from "./config.js";
import { out } from "./output.js";
import { isoDate, parseDate, repr, splitList, today, withCommas } from "./util.js";

// Numbers below this are too common to mean anything (years, percentages,
// enumerations). Only from here on is a number distinctive enough that its
// double appearance is a statement. From IDENTIFIER_MIN on, a number is an
// identifier, not a count: two claims naming the same identifier mean the
// same thing, which is correct and not a contradiction.
const NOTABLE_MIN = 1000;

const DATE_IN_TEXT_RE = /\d{4}-\d{2}-\d{2}/g;
const WORD_RE = /[a-z]{5,}/g;

// Words that appear in almost every claim and fake a similarity.
const FILLER_WORDS = new Set([
  "about", "after", "always", "because", "before", "claim", "claims",
  "command", "could", "every", "example", "field", "fields", "instead",
  "never", "number", "numbers", "other", "should", "their", "there",
  "these", "those", "value", "values", "verify", "where", "which",
  "would",
]);

export const SPEC: Spec = {
  json: { type: "boolean", help: "machine-readable report" },
};

export const DESCRIPTION =
  "Deterministic contradiction search over all claims. Reports only; resolution is manual work.";

interface Finding {
  kind: string;
  severity: "conflict" | "notice";
  detail: string;
  hint: string;
  claims: string[];
}

/**
 * Counts from a text, without years, dates and identifiers. Deliberately
 * uses the same count filter as the protected-entities check in lint.
 */
function notableNumbers(text: string): Set<number> {
  const hits = new Set<number>();
  for (const line of text.replace(DATE_IN_TEXT_RE, " ").split("\n")) {
    for (const raw of countsInLine(line)) {
      const n = countValue(raw);
      if (n >= NOTABLE_MIN && n < IDENTIFIER_MIN) hits.add(n);
    }
  }
  return hits;
}

function intersection(a: Set<number>, b: Set<number>): number[] {
  return [...a].filter((n) => b.has(n)).sort((x, y) => x - y);
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

  const claims = readClaims(config);
  // The prose OUTSIDE all claim blocks, per knowledge file.
  const prose = new Map<string, string>();
  for (const { path, display } of areaFiles(config)) prose.set(display, stripBlocks(readText(path)));
  const adrs = adrStatus(config);
  const now = today();
  const findings: Finding[] = [];

  // -- 1. The same notable number in more than one claim -------------------
  const byNumber = new Map<number, Claim[]>();
  for (const c of claims) {
    for (const n of notableNumbers(c.text)) {
      if (!byNumber.has(n)) byNumber.set(n, []);
      byNumber.get(n)!.push(c);
    }
  }
  for (const n of [...byNumber.keys()].sort((a, b) => a - b)) {
    const ids = [...new Set(byNumber.get(n)!.map(claimId))].sort();
    if (ids.length > 1) {
      findings.push({
        kind: "number-in-multiple-claims",
        severity: "notice",
        detail: `The number ${withCommas(n)} appears in ${ids.length} claims: ${ids.join(", ")}`,
        hint: "If both mean the same quantity, it belongs in ONE claim and the others reference it.",
        claims: ids,
      });
    }
  }

  // -- 2. A claim's number also sits in the prose --------------------------
  const proseNumbers = new Map<string, Set<number>>();
  for (const [name, text] of prose) proseNumbers.set(name, notableNumbers(text));
  for (const c of claims) {
    const numbers = notableNumbers(c.text);
    if (!numbers.size) continue;
    for (const [name, inProse] of proseNumbers) {
      const shared = intersection(numbers, inProse);
      if (shared.length) {
        findings.push({
          kind: "number-also-in-prose",
          severity: "conflict",
          detail:
            `Claim ${claimId(c)} carries ${shared.map(withCommas).join(", ")}` +
            `; the same number sits unmaintained in the prose of ${name}`,
          hint: "The prose ages next to the maintained claim. Reference the claim id there instead of repeating the number.",
          claims: [claimId(c)],
        });
      }
    }
  }

  // -- 3. Rule claim hanging off an ADR that is no longer Accepted ---------
  // Missing entries default to Accepted so projects without ADR directories
  // stay quiet.
  for (const c of claims) {
    const adr = c.header.decided_in;
    if (adr && (adrs[adr] ?? "Accepted") !== "Accepted") {
      findings.push({
        kind: "adr-no-longer-accepted",
        severity: "conflict",
        detail: `Claim ${claimId(c)} relies on ${adr}, whose status is ${repr(adrs[adr])}`,
        hint: "Update the rule, or mark the claim with superseded_by.",
        claims: [claimId(c)],
      });
    }
  }

  // -- 4. Contradicting dates ----------------------------------------------
  const known = new Set(claims.map(claimId));
  const supersededBy = new Map(claims.map((c) => [claimId(c), c.header.superseded_by]));
  for (const c of claims) {
    const id = claimId(c);
    const asOf = parseDate(c.header.as_of);
    const until = parseDate(c.header.valid_until);
    const confirmed = parseDate(c.header.confirmed_on);
    if (asOf !== null && until !== null && until < asOf) {
      findings.push({
        kind: "valid-until-before-as-of",
        severity: "conflict",
        detail: `Claim ${id}: valid_until ${isoDate(until)} lies before as_of ${isoDate(asOf)}`,
        hint: "The measurement would have expired at the moment it was taken.",
        claims: [id],
      });
    }
    for (const [fieldName, value] of [["as_of", asOf], ["confirmed_on", confirmed]] as const) {
      if (value !== null && value > now) {
        findings.push({
          kind: "date-in-the-future",
          severity: "conflict",
          detail: `Claim ${id}: ${fieldName} ${isoDate(value)} lies in the future`,
          hint: "A typo, or carried over from another time zone.",
          claims: [id],
        });
      }
    }
    for (const successor of splitList(c.header.superseded_by)) {
      if (known.has(successor) && supersededBy.get(successor)) {
        findings.push({
          kind: "supersede-chain-points-to-superseded",
          severity: "conflict",
          detail: `Claim ${id} points at ${successor}, which was itself superseded`,
          hint: "Repoint the chain at the living claim at its end.",
          claims: [id, successor],
        });
      }
    }
  }

  // -- 5. Two claims with very similar text --------------------------------
  const words = new Map<string, Set<string>>();
  for (const c of claims) {
    const found = c.text.toLowerCase().match(WORD_RE) ?? [];
    words.set(claimId(c), new Set(found.filter((w) => !FILLER_WORDS.has(w))));
  }
  const byType = new Map<string, Claim[]>();
  for (const c of claims) {
    const t = c.header.type ?? "?";
    if (!byType.has(t)) byType.set(t, []);
    byType.get(t)!.push(c);
  }
  for (const [claimType, group] of byType) {
    for (let i = 0; i < group.length; i++) {
      for (const b of group.slice(i + 1)) {
        const a = group[i];
        const wa = words.get(claimId(a))!;
        const wb = words.get(claimId(b))!;
        if (wa.size < 12 || wb.size < 12) continue;
        const shared = [...wa].filter((w) => wb.has(w)).length;
        const overlap = shared / Math.min(wa.size, wb.size);
        if (overlap >= 0.6) {
          findings.push({
            kind: "possible-duplicate",
            severity: "notice",
            detail: `${claimId(a)} and ${claimId(b)} (type=${claimType}) share ${Math.round(overlap * 100)} percent of their distinctive words`,
            hint: "If both say the same thing, one stays and the other references it. Heuristic, please read.",
            claims: [claimId(a), claimId(b)],
          });
        }
      }
    }
  }

  const conflicts = findings.filter((f) => f.severity === "conflict").length;
  const notices = findings.length - conflicts;

  if (args.json) {
    out(JSON.stringify({ claims: claims.length, conflicts, notices, findings }, null, 1));
  } else {
    out(`Claims: ${claims.length}, conflicts: ${conflicts}, notices: ${notices}\n`);
    for (const severity of ["conflict", "notice"] as const) {
      const items = findings.filter((f) => f.severity === severity);
      if (!items.length) continue;
      out(`${severity.toUpperCase()} (${items.length}):`);
      for (const f of items) {
        out(`  [${f.kind}] ${f.detail}`);
        out(`      ${f.hint}`);
      }
      out();
    }
    if (!findings.length) out("No contradictions found.");
    out("This command only reports. Resolution is manual work.");
  }

  return conflicts ? 1 : 0;
}
