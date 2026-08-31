"""Deterministic lint over the claim blocks of the knowledge files.

This subcommand enforces the rules that are checkable without a model and
without network access. No model call, no API call, no database: it runs in
seconds and is therefore fit as a release gate. Rules that need to execute
something (verify commands, generated values against the generator) belong
to `warehaus verify` and are deliberately not here.

Exit convention: 0 green, 1 red, 2 not runnable. The gap list is
non-blocking and does not affect the exit code.
"""

from __future__ import annotations

import argparse
import json
import re
from datetime import date

from .claims import (
    ADR_RE,
    ALLOWED_FIELDS,
    BLOCK_RE,
    BUDGETS,
    CHRONICLE_RE,
    DATE_RE,
    EXPECTED_EXIT_RE,
    ID_RE,
    MAINTENANCE,
    REQUIRED_ALL,
    REQUIRED_BY_TYPE,
    TYPES,
    area_files,
    collect_adrs,
    counts_in_line,
    parse_date,
    parse_header,
    split_list,
)
from .config import Config, ConfigError, die, load_config


def register(subparsers) -> None:
    p = subparsers.add_parser(
        "lint",
        help="check the form of every claim: fields, ranges, ids, references",
        description=(
            "Deterministic lint over all claim blocks. No model, no network: "
            "runs in seconds and works as a release gate."
        ),
    )
    p.add_argument("--json", action="store_true", help="machine-readable report")
    p.add_argument(
        "--strict-gaps",
        action="store_true",
        help="treat the gap list as errors too (exit 1)",
    )
    p.set_defaults(func=run)


def check_protected(config: Config, files) -> list[str]:
    """Report protected entities that carry a count-like number OUTSIDE their claim.

    The guard against "three files, three numbers": a number may live in
    exactly one place, its claim; everywhere else stands a reference. The
    check only recognizes registered entities, not free text; that is its
    known limit.
    """
    if not config.protected_file or not config.protected_file.exists():
        return []
    conf = json.loads(config.protected_file.read_text(encoding="utf-8"))
    global_exceptions = conf.get("global_exceptions", [])
    entries = [
        (
            e["entity"],
            re.compile(e["pattern"], re.I),
            e["claim"],
            set(e.get("exceptions", [])),
        )
        for e in conf.get("entities", [])
    ]

    hits: list[str] = []
    for _area, path, display in files:
        if any(x in str(path) or x == path.name for x in global_exceptions):
            continue
        content = path.read_text(encoding="utf-8")
        # The text OUTSIDE the claim blocks: inside, the number is allowed.
        outside = BLOCK_RE.sub("", content)
        for line in outside.split("\n"):
            for entity, pattern, claim_id, exceptions in entries:
                if path.name in exceptions or not pattern.search(line):
                    continue
                numbers = counts_in_line(line)
                if numbers:
                    hits.append(
                        f"{display}: {entity} with number {', '.join(numbers)} "
                        f"outside its designated claim {claim_id!r}"
                    )
    return hits


def run(args: argparse.Namespace) -> int:
    try:
        config = load_config(args.config)
    except ConfigError as exc:
        return die(str(exc))

    if not any(a.root.exists() for a in config.areas):
        return die(
            f"none of the configured area roots exists; check [[areas]] in {config.path}"
        )

    today = date.today()
    adrs = collect_adrs(config)
    claims: dict[str, dict] = {}
    errors: list[str] = []
    gaps: list[str] = []
    files = area_files(config)
    by_area: dict[str, int] = {}

    for area, _path, display in files:
        content = _path.read_text(encoding="utf-8")

        # Catch unbalanced blocks before the regex silently swallows them.
        opened = len(re.findall(r"^[ \t]*<!-- claim$", content, re.M))
        closed = len(re.findall(r"^[ \t]*<!-- /claim -->[ \t]*$", content, re.M))
        if opened != closed:
            errors.append(f"{display}: {opened} opened vs {closed} closed claim blocks")

        found = list(BLOCK_RE.finditer(content))
        if len(found) != opened:
            errors.append(
                f"{display}: {opened} block openings, but only {len(found)} parseable blocks"
            )

        for m in found:
            line = content[: m.start()].count("\n") + 1
            loc = f"{display}:{line}"
            fields, header_errors = parse_header(m.group("header"))
            for e in header_errors:
                errors.append(f"{loc}: {e}")

            cid = fields.get("id", "")
            ctype = fields.get("type", "")

            # Unknown fields, missing required fields.
            for k in fields:
                if k not in ALLOWED_FIELDS:
                    errors.append(f"{loc}: unknown field {k!r}")
            missing = REQUIRED_ALL - fields.keys()
            if ctype in REQUIRED_BY_TYPE:
                missing |= REQUIRED_BY_TYPE[ctype] - fields.keys()
            # type=rule is exempt on purpose: a decided calculation or
            # behaviour rule is not checked by comparing data but by whether
            # it shows up in behaviour, i.e. through an eval suite. If the
            # gap list counted it, the list would permanently report
            # non-defects, and a list full of non-defects is one nobody
            # works through any more.
            if (
                fields.get("maintenance") == "verified"
                and "verify_cmd" not in fields
                and ctype != "rule"
            ):
                gaps.append(f"{loc}: maintenance=verified without verify_cmd")
            if "verify_cmd" in fields and "budget" not in fields:
                missing.add("budget")
            for f in sorted(missing):
                errors.append(f"{loc}: required field {f!r} is missing (type={ctype or '?'})")

            # id format and global uniqueness.
            if cid and not ID_RE.match(cid):
                errors.append(f"{loc}: id {cid!r} violates the kebab-case format")
            if cid:
                if cid in claims:
                    errors.append(f"{loc}: id {cid!r} already taken in {claims[cid]['loc']}")
                else:
                    claims[cid] = {"loc": loc, "fields": fields, "area": area}
                    by_area[area] = by_area.get(area, 0) + 1

            # Value ranges.
            if ctype and ctype not in TYPES:
                errors.append(f"{loc}: type {ctype!r} unknown")
            if (mnt := fields.get("maintenance")) and mnt not in MAINTENANCE:
                errors.append(f"{loc}: maintenance {mnt!r} unknown")
            if (b := fields.get("budget")) and b not in BUDGETS:
                errors.append(f"{loc}: budget {b!r} unknown")
            if (s := fields.get("sot")) and not config.sot_valid(s):
                errors.append(
                    f"{loc}: sot {s!r} is not in [schema] sots and matches no "
                    f"allowed prefix ({', '.join(config.SOT_PREFIXES)})"
                )
            if (ee := fields.get("expected_exit")) and not EXPECTED_EXIT_RE.match(ee):
                errors.append(
                    f"{loc}: expected_exit {ee!r} unknown (allowed: 'non-zero' or a number)"
                )
            if fields.get("expected_exit") and not fields.get("verify_cmd"):
                errors.append(f"{loc}: expected_exit without verify_cmd has no effect")
            if hit := CHRONICLE_RE.search(m.group("text")):
                errors.append(
                    f"{loc}: history prose in the body ({hit.group(0)!r}): a claim "
                    "carries only the current state; predecessors belong in git and "
                    "in supersedes/superseded_by, not in the prose"
                )
            if ctype == "count" and fields.get("maintenance") != "generated":
                errors.append(
                    f"{loc}: type=count requires maintenance=generated "
                    f"(is {fields.get('maintenance')!r})"
                )
            if ctype == "experience" and fields.get("maintenance") != "manual":
                errors.append(
                    f"{loc}: type=experience requires maintenance=manual "
                    f"(is {fields.get('maintenance')!r})"
                )

            # Dates.
            as_of = None
            for fname in ("as_of", "valid_until", "confirmed_on"):
                if fname in fields:
                    if not DATE_RE.match(fields[fname]):
                        errors.append(f"{loc}: {fname} {fields[fname]!r} is not YYYY-MM-DD")
                    elif (d := parse_date(fields[fname])) is None:
                        errors.append(f"{loc}: {fname} {fields[fname]!r} is not a valid date")
                    elif fname == "as_of":
                        as_of = d
                        if d > today:
                            errors.append(f"{loc}: as_of {fields[fname]} lies in the future")

            valid_until = (
                parse_date(fields.get("valid_until", "")) if fields.get("valid_until") else None
            )
            if valid_until and as_of and valid_until <= as_of:
                errors.append(
                    f"{loc}: valid_until {valid_until} does not lie after as_of {as_of}"
                )

            # No heading inside the body: a heading there shifts the file's
            # outline and breaks section-based tooling.
            if re.search(r"^#", m.group("text"), re.M):
                errors.append(f"{loc}: body contains a heading line")

            # References: ADRs immediately, claim ids after collection.
            if (dec := fields.get("decided_in")) and not ADR_RE.match(dec):
                errors.append(f"{loc}: decided_in {dec!r} is not an ADR-NNNN reference")
            elif dec and adrs and dec not in adrs:
                errors.append(f"{loc}: decided_in {dec} points to a non-existent ADR")

            # Gap list.
            if ctype == "snapshot" and valid_until and valid_until < today:
                gaps.append(
                    f"{loc}: snapshot expired on {valid_until} "
                    f"({(today - valid_until).days} days ago)"
                )
            if (
                as_of
                and ctype in config.intervals
                and (age := (today - as_of).days) > config.intervals[ctype]
            ):
                gaps.append(
                    f"{loc}: as_of {as_of} is {age} days old "
                    f"(interval {config.intervals[ctype]} for type={ctype})"
                )
            if ctype == "experience" and (conf := parse_date(fields.get("confirmed_on", ""))):
                if (age := (today - conf).days) > config.intervals["experience"]:
                    gaps.append(f"{loc}: experience unconfirmed for {age} days")
            if "superseded_by" in fields:
                gaps.append(
                    f"{loc}: marked historical (superseded_by); "
                    "no longer cite as current knowledge"
                )

    # Resolve claim references once all ids are known.
    for cid, entry in claims.items():
        for fname in ("supersedes", "superseded_by"):
            for target in split_list(entry["fields"].get(fname, "")):
                if ADR_RE.match(target):
                    if adrs and target not in adrs:
                        errors.append(f"{entry['loc']}: {fname} points to non-existent {target}")
                elif target not in claims:
                    errors.append(f"{entry['loc']}: {fname} points to unknown claim id {target!r}")

    protected_hits = check_protected(config, files)
    errors.extend(protected_hits)

    report = {
        "files": len(files),
        "claims": len(claims),
        "claims_by_area": by_area,
        "errors": errors,
        "protected_hits": protected_hits,
        "gaps": gaps,
        "adrs_known": len(adrs),
    }

    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=1))
    else:
        print(f"Knowledge files: {len(files)}, claims: {len(claims)}, ADRs known: {len(adrs)}")
        if errors:
            print(f"\nERRORS ({len(errors)}), blocking:")
            for e in errors:
                print(f"  {e}")
        else:
            print("\nNo blocking errors.")
        if gaps:
            print(f"\nGap list ({len(gaps)}), non-blocking:")
            for g in gaps:
                print(f"  {g}")

    if errors:
        return 1
    if gaps and args.strict_gaps:
        return 1
    return 0
