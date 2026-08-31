"""Collect the generated values and keep the gen ranges honest.

Claims with `maintenance: generated` carry a machine-owned range in their
body:

    <!--gen:product-catalog-size-->6<!--/gen-->

A value inside a gen range is NEVER typed by hand. Whoever does creates
drift, and `--check` reports it. This module is the only legitimate writer,
and it only ever touches the text between the markers; everything around
them stays handwritten.

The collectors are declared in warehaus.toml:

    [[stand.values]]
    id = "product-catalog-size"
    command = 'grep -c "^- SKU " docs/catalog.md'
    budget = "free"          # free | single_call | bulk (default free)

`id` names the gen range, `command` is a shell command whose stripped stdout
is the value, `budget` gates the cost like everywhere else (--only bypasses
the gate, entries above the level are skipped otherwise).

Modes:

    warehaus stand              preview: collect and show, write nothing
    warehaus stand --write      rewrite the gen ranges in place
    warehaus stand --check      compare only; drift, a missing range or a
                                failed command exits 1
    warehaus stand --format=json

The JSON output is exactly the generator contract that `warehaus verify`
expects ({"values": ..., "errors": ..., "skipped": ...}), so a project with
the CLI installed can close the loop with:

    [generator]
    command = "warehaus stand"

Exit: 0 collected (and, with --check, no drift), 1 at least one value failed
or drifted, 2 not runnable.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from .claims import BUDGET_LEVELS, GEN_RE, area_files
from .config import Config, ConfigError, die, load_config
from .verify import environment

COMMAND_TIMEOUT = 120


def gen_ranges(config: Config) -> dict[str, list[tuple[Path, str, str]]]:
    """id -> [(path, display, current value)] for every gen range on file.

    One id may legitimately appear in more than one file (a summary document
    and the claim itself); all occurrences are compared and written.
    """
    ranges: dict[str, list[tuple[Path, str, str]]] = {}
    for _area, path, display in area_files(config):
        content = path.read_text(encoding="utf-8")
        for m in GEN_RE.finditer(content):
            ranges.setdefault(m.group(1), []).append((path, display, m.group(2)))
    return ranges


def collect(config: Config, only: set[str], level: int) -> tuple[dict[str, str], list[str], list[str]]:
    """Run the configured collectors. Returns (values, errors, skipped).

    Error and skip entries are prefixed with the id, because `warehaus
    verify` looks them up by that prefix when a generated claim cannot be
    served.
    """
    env = environment(config)
    values: dict[str, str] = {}
    errors: list[str] = []
    skipped: list[str] = []
    for entry in config.stand_values:
        gen_id = entry["id"]
        if only and gen_id not in only:
            continue
        if not only and BUDGET_LEVELS[entry["budget"]] > level:
            skipped.append(f"{gen_id}: needs budget={entry['budget']}")
            continue
        try:
            res = subprocess.run(
                entry["command"], shell=True, cwd=config.root,
                capture_output=True, text=True, timeout=COMMAND_TIMEOUT, env=env,
            )
        except subprocess.TimeoutExpired:
            errors.append(f"{gen_id}: timeout after {COMMAND_TIMEOUT} s")
            continue
        if res.returncode != 0:
            errors.append(
                f"{gen_id}: exit {res.returncode}: "
                f"{(res.stderr or res.stdout).strip()[:160]}"
            )
            continue
        values[gen_id] = res.stdout.strip()
    return values, errors, skipped


def normalized(text: str) -> str:
    return " ".join(text.split())


def find_drift(values: dict[str, str], ranges: dict[str, list[tuple[Path, str, str]]],
               configured: set[str], only: set[str]) -> tuple[list[str], list[str]]:
    """Returns (drift, missing): value/range mismatches and configured ids
    without any gen range to land in."""
    drift: list[str] = []
    for gen_id, value in values.items():
        for _path, display, current in ranges.get(gen_id, []):
            if normalized(current) != normalized(value):
                drift.append(
                    f"{gen_id}: {display} carries {normalized(current)!r}, "
                    f"the command yields {normalized(value)!r}"
                )
    relevant = {i for i in configured if not only or i in only}
    missing = [
        f"{gen_id}: no gen range found in any knowledge file"
        for gen_id in sorted(relevant - set(ranges))
    ]
    return drift, missing


def write_ranges(config: Config, values: dict[str, str]) -> int:
    """Rewrite the gen ranges in place. Only the text between the markers is
    touched; a range whose content already matches is left alone."""
    written = 0
    for _area, path, _display in area_files(config):
        content = path.read_text(encoding="utf-8")

        def replace(m):
            nonlocal written
            gen_id = m.group(1)
            if gen_id not in values or normalized(m.group(2)) == normalized(values[gen_id]):
                return m.group(0)
            written += 1
            return f"<!--gen:{gen_id}-->{values[gen_id]}<!--/gen-->"

        new = GEN_RE.sub(replace, content)
        if new != content:
            path.write_text(new, encoding="utf-8")
    return written


def register(subparsers) -> None:
    p = subparsers.add_parser(
        "stand",
        help="collect generated values and keep the gen ranges honest",
        description="Runs the [[stand.values]] collectors from warehaus.toml "
                    "and previews, checks or rewrites the <!--gen:id--> "
                    "ranges they own. --format=json speaks the generator "
                    "contract used by `warehaus verify`.",
    )
    p.add_argument("--only", default="", help="comma-separated list of gen ids")
    p.add_argument("--budget", choices=list(BUDGET_LEVELS), default="free")
    mode = p.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true",
                      help="compare only; drift, a missing range or a failed "
                           "command exits 1")
    mode.add_argument("--write", action="store_true",
                      help="rewrite the gen ranges in place")
    p.add_argument("--format", choices=["text", "json"], default="text")
    p.set_defaults(func=run)


def run(args) -> int:
    try:
        config = load_config(args.config)
    except ConfigError as exc:
        return die(str(exc))
    if not config.stand_values:
        return die(f"no [[stand.values]] configured in {config.path.name}")

    only = {t.strip() for t in args.only.split(",") if t.strip()}
    level = BUDGET_LEVELS[args.budget]
    configured = {e["id"] for e in config.stand_values}

    ranges = gen_ranges(config)
    values, errors, skipped = collect(config, only, level)
    drift, missing = find_drift(values, ranges, configured, only)
    orphans = sorted(set(ranges) - configured)

    # In JSON mode stdout carries exclusively the JSON document; any progress
    # line before it would make it unreadable for the caller (verify).
    info = sys.stderr if args.format == "json" else sys.stdout

    print(
        f"Configured values: {len(config.stand_values)}, "
        f"gen ranges on file: {sum(len(v) for v in ranges.values())}, "
        f"budget: {args.budget}",
        file=info,
    )
    if orphans:
        print(
            f"\nGen ranges without a configured collector ({len(orphans)}): "
            "their value cannot be renewed and ages unnoticed.",
            file=info,
        )
        for gen_id in orphans:
            print(f"  {gen_id}", file=info)

    if args.format == "json":
        print(json.dumps(
            {"values": values, "errors": errors, "skipped": skipped},
            ensure_ascii=False, indent=1,
        ))
        return 1 if errors else 0

    if values:
        print(f"\nCollected ({len(values)}):")
        for gen_id, value in values.items():
            shown = normalized(value)
            print(f"  {gen_id:38} {shown if len(shown) <= 60 else shown[:57] + '...'}")
    if errors:
        print(f"\nFailed ({len(errors)}):")
        for e in errors:
            print(f"  {e}")
    if skipped:
        print(f"\nSkipped ({len(skipped)}):")
        for s in skipped:
            print(f"  {s}")

    if args.check:
        problems = drift + missing
        if problems:
            print(f"\nDrift ({len(problems)}):")
            for p in problems:
                print(f"  {p}")
        else:
            print("\nNo drift: every gen range matches its collector.")
        print("Check mode, nothing written.")
        return 1 if (problems or errors) else 0

    if args.write:
        written = write_ranges(config, values)
        print(f"\n{written} range(s) updated." if written
              else "\nNothing to update: every range already matches.")
        return 1 if errors else 0

    if drift or missing:
        print(f"\nOut of date ({len(drift) + len(missing)}):")
        for p in drift + missing:
            print(f"  {p}")
    print("\nPreview. --write updates the ranges, --check only compares.")
    return 1 if errors else 0
