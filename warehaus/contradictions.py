"""Contradiction search across the claim inventory.

This command REPORTS conflicts, it does not resolve them. A knowledge system
that corrects itself without anyone looking is exactly the problem this whole
tool is built against.

What it looks for:

1. The same notable number in more than one claim. A distinctive number that
   hangs on several claims with different meanings is a contradiction waiting
   to happen; the canonical failure mode is "three files, three numbers" for
   the same quantity.
2. A number from a claim that also sits in the prose outside every claim
   block. The prose then ages unnoticed next to the maintained claim.
3. Rule claims whose ADR is no longer Accepted. When an ADR moves to
   Superseded, the rules hanging off it must follow; before this check that
   connection existed only in people's heads.
4. Contradicting dates: valid_until before as_of, confirmed_on or as_of in
   the future, superseded_by pointing at a claim that was itself superseded.
5. Two claims with the same core statement, detected via high word overlap
   at equal type. That is a heuristic and is reported as a notice, not an
   error.

Exit: 0 no conflicts, 1 at least one conflict found, 2 not runnable.
"""

from __future__ import annotations

import json
import re
from collections import defaultdict
from datetime import date

from .claims import (
    BLOCK_RE,
    IDENTIFIER_MIN,
    adr_status,
    area_files,
    count_value,
    counts_in_line,
    parse_date,
    read_claims,
    split_list,
)
from .config import ConfigError, die, load_config

# Numbers below this are too common to mean anything (years, percentages,
# enumerations). Only from here on is a number distinctive enough that its
# double appearance is a statement.
NOTABLE_MIN = 1000
# From IDENTIFIER_MIN on, a number is an identifier (board, customer,
# order id), not a count. Two claims naming the same identifier mean the
# same thing; that is correct and not a contradiction.

DATE_IN_TEXT_RE = re.compile(r"\d{4}-\d{2}-\d{2}")

WORD_RE = re.compile(r"[a-z]{5,}")

# Words that appear in almost every claim and fake a similarity.
FILLER_WORDS = {
    "about", "after", "always", "because", "before", "claim", "claims",
    "command", "could", "every", "example", "field", "fields", "instead",
    "never", "number", "numbers", "other", "should", "their", "there",
    "these", "those", "value", "values", "verify", "where", "which",
    "would",
}


def notable_numbers(text: str) -> set[int]:
    """Counts from a text, without years, dates and identifiers.

    Deliberately uses the same count filter as the protected-entities check
    in lint (`counts_in_line`) instead of a second one. Two separate number
    filters mean every insight about identifiers has to be built in twice,
    and the third time it is forgotten once.
    """
    hits: set[int] = set()
    for line in DATE_IN_TEXT_RE.sub(" ", text).split("\n"):
        for raw in counts_in_line(line):
            n = count_value(raw)
            if NOTABLE_MIN <= n < IDENTIFIER_MIN:
                hits.add(n)
    return hits


def register(subparsers) -> None:
    p = subparsers.add_parser(
        "contradictions",
        help="find conflicting numbers, dead ADR references and probable duplicates",
        description="Deterministic contradiction search over all claims. "
        "Reports only; resolution is manual work.",
    )
    p.add_argument("--json", action="store_true", help="machine-readable report")
    p.set_defaults(func=run)


def run(args) -> int:
    try:
        config = load_config(args.config)
    except ConfigError as exc:
        return die(str(exc))

    claims = read_claims(config)
    # The prose OUTSIDE all claim blocks, per knowledge file.
    prose = {
        display: BLOCK_RE.sub("", path.read_text(encoding="utf-8"))
        for _area, path, display in area_files(config)
    }
    adrs = adr_status(config)
    today = date.today()
    findings: list[dict] = []

    # -- 1. The same notable number in more than one claim -------------------
    by_number: dict[int, list] = defaultdict(list)
    for c in claims:
        for n in notable_numbers(c.text):
            by_number[n].append(c)
    for n, involved in sorted(by_number.items()):
        ids = sorted({c.id for c in involved})
        if len(ids) > 1:
            findings.append({
                "kind": "number-in-multiple-claims",
                "severity": "notice",
                "detail": f"The number {n:,} appears in {len(ids)} claims: "
                          + ", ".join(ids),
                "hint": "If both mean the same quantity, it belongs in ONE "
                        "claim and the others reference it.",
                "claims": ids,
            })

    # -- 2. A claim's number also sits in the prose --------------------------
    prose_numbers = {name: notable_numbers(text) for name, text in prose.items()}
    for c in claims:
        numbers = notable_numbers(c.text)
        if not numbers:
            continue
        for name, in_prose in prose_numbers.items():
            shared = sorted(numbers & in_prose)
            if shared:
                findings.append({
                    "kind": "number-also-in-prose",
                    "severity": "conflict",
                    "detail": f"Claim {c.id} carries "
                              + ", ".join(f"{n:,}" for n in shared)
                              + f"; the same number sits unmaintained in the prose of {name}",
                    "hint": "The prose ages next to the maintained claim. "
                            "Reference the claim id there instead of repeating the number.",
                    "claims": [c.id],
                })

    # -- 3. Rule claim hanging off an ADR that is no longer Accepted ---------
    # Missing entries default to Accepted so projects without ADR directories
    # stay quiet.
    for c in claims:
        adr = c.header.get("decided_in")
        if adr and adrs.get(adr, "Accepted") != "Accepted":
            findings.append({
                "kind": "adr-no-longer-accepted",
                "severity": "conflict",
                "detail": f"Claim {c.id} relies on {adr}, whose status is "
                          f"{adrs.get(adr)!r}",
                "hint": "Update the rule, or mark the claim with superseded_by.",
                "claims": [c.id],
            })

    # -- 4. Contradicting dates ----------------------------------------------
    known = {c.id for c in claims}
    superseded_by = {c.id: c.header.get("superseded_by") for c in claims}
    for c in claims:
        as_of = parse_date(c.header.get("as_of", ""))
        until = parse_date(c.header.get("valid_until", ""))
        confirmed = parse_date(c.header.get("confirmed_on", ""))
        if as_of and until and until < as_of:
            findings.append({
                "kind": "valid-until-before-as-of",
                "severity": "conflict",
                "detail": f"Claim {c.id}: valid_until {until} lies before as_of {as_of}",
                "hint": "The measurement would have expired at the moment it was taken.",
                "claims": [c.id],
            })
        for field_name, value in (("as_of", as_of), ("confirmed_on", confirmed)):
            if value and value > today:
                findings.append({
                    "kind": "date-in-the-future",
                    "severity": "conflict",
                    "detail": f"Claim {c.id}: {field_name} {value} lies in the future",
                    "hint": "A typo, or carried over from another time zone.",
                    "claims": [c.id],
                })
        for successor in split_list(c.header.get("superseded_by", "")):
            if successor in known and superseded_by.get(successor):
                findings.append({
                    "kind": "supersede-chain-points-to-superseded",
                    "severity": "conflict",
                    "detail": f"Claim {c.id} points at {successor}, "
                              "which was itself superseded",
                    "hint": "Repoint the chain at the living claim at its end.",
                    "claims": [c.id, successor],
                })

    # -- 5. Two claims with very similar text --------------------------------
    words = {
        c.id: {w for w in WORD_RE.findall(c.text.lower()) if w not in FILLER_WORDS}
        for c in claims
    }
    by_type: dict[str, list] = defaultdict(list)
    for c in claims:
        by_type[c.header.get("type", "?")].append(c)
    for claim_type, group in by_type.items():
        for i, a in enumerate(group):
            for b in group[i + 1:]:
                wa, wb = words[a.id], words[b.id]
                if len(wa) < 12 or len(wb) < 12:
                    continue
                overlap = len(wa & wb) / min(len(wa), len(wb))
                if overlap >= 0.6:
                    findings.append({
                        "kind": "possible-duplicate",
                        "severity": "notice",
                        "detail": f"{a.id} and {b.id} (type={claim_type}) share "
                                  f"{overlap * 100:.0f} percent of their distinctive words",
                        "hint": "If both say the same thing, one stays and the "
                                "other references it. Heuristic, please read.",
                        "claims": [a.id, b.id],
                    })

    conflicts = sum(1 for f in findings if f["severity"] == "conflict")
    notices = len(findings) - conflicts

    if args.json:
        print(json.dumps({
            "claims": len(claims),
            "conflicts": conflicts,
            "notices": notices,
            "findings": findings,
        }, indent=1))
    else:
        print(f"Claims: {len(claims)}, conflicts: {conflicts}, notices: {notices}\n")
        for severity in ("conflict", "notice"):
            items = [f for f in findings if f["severity"] == severity]
            if not items:
                continue
            print(f"{severity.upper()} ({len(items)}):")
            for f in items:
                print(f"  [{f['kind']}] {f['detail']}")
                print(f"      {f['hint']}")
            print()
        if not findings:
            print("No contradictions found.")
        print("This script only reports. Resolution is manual work.")

    return 1 if conflicts else 0
