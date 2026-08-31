"""Claim parsing and schema constants shared by lint, verify and contradictions.

A claim is a block of Markdown wrapped in HTML comments:

    <!-- claim
    id: billing-amounts-in-cents
    type: structure
    sot: billing-api
    maintenance: verified
    verify_cmd: "grep -q cents docs/billing-api.md"
    budget: free
    as_of: 2026-08-31
    -->
    The billing API returns all amounts as integer cents. Divide by 100
    for display.
    <!-- /claim -->

The header is flat YAML, one field per line. Claims with
`maintenance: generated` may carry one generated range in the body:

    <!--gen:claim-id-->1366<!--/gen-->

Only that range is ever written by the generator; the surrounding text stays
hand-written, and a hand edit inside the range counts as drift.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date, datetime
from pathlib import Path

from .config import Config

# ── Schema value ranges ──────────────────────────────────────────────────────

TYPES = {"structure", "access", "rule", "metric", "count", "snapshot", "experience"}
MAINTENANCE = {"generated", "verified", "manual"}
BUDGETS = {"free", "single_call", "bulk"}
BUDGET_LEVELS = {"free": 0, "single_call": 1, "bulk": 2}

REQUIRED_ALL = {"id", "type", "sot", "maintenance", "as_of"}
# Additional required fields per claim type.
REQUIRED_BY_TYPE: dict[str, set[str]] = {
    "access": {"verify_cmd"},
    "rule": {"decided_in"},
    "metric": {"derivation", "verify_cmd"},
    "count": {"verify_cmd"},
    "snapshot": {"valid_until"},
    "experience": {"source", "confirmed_on"},
}
ALLOWED_FIELDS = REQUIRED_ALL | {
    "verify_cmd", "derivation", "tolerance", "valid_until", "decided_in",
    "source", "confirmed_on", "evidence", "budget", "supersedes",
    "superseded_by",
    # Polarity of the verify command. Some claims state that something does
    # NOT work ("the API has no sessions endpoint"); there a failing command
    # is the confirmation. Without this field the verify run would have to
    # guess the intent and would report a correct claim as broken.
    "expected_exit",
}

ID_RE = re.compile(r"^[a-z0-9]([a-z0-9-]*[a-z0-9])?$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
ADR_RE = re.compile(r"^ADR-\d{4}$")
EXPECTED_EXIT_RE = re.compile(r"^(non-zero|\d{1,3})$")

BLOCK_RE = re.compile(
    r"^(?P<indent>[ \t]*)<!-- claim\n(?P<header>.*?)^[ \t]*-->\n(?P<text>.*?)^[ \t]*<!-- /claim -->[ \t]*$",
    re.S | re.M,
)
GEN_RE = re.compile(r"<!--gen:([a-z0-9-]+)-->(.*?)<!--/gen-->", re.S)

# History prose in a claim body. A claim carries only the current state of
# knowledge; predecessors live in git and in supersedes/superseded_by, never
# in the prose. Left in, the next writer copies the pattern as house style.
# Deliberately NOT matched: a refuted counter-hypothesis ("the counter-
# hypothesis X is refuted") and mappings for legacy values that still occur
# in persisted data. Both are current knowledge.
CHRONICLE_RE = re.compile(
    r"(?:the\s+)?(?:previous|earlier|old|original|first)\s+(?:version|revision|wording)\s+(?:said|stated|read|claimed|had)"
    r"|used\s+to\s+(?:say|state|read|claim)"
    r"|formerly\s+(?:said|stated|read|claimed)"
    r"|was\s+silently\s+replaced"
    r"|until\s+\d{4}-\d{2}-\d{2}\s+this\s+(?:claim|section|file)\s+(?:said|read)",
    re.I,
)


@dataclass
class Claim:
    area: str
    path: Path
    display: str  # "area:filename"
    line: int
    header: dict[str, str]
    text: str
    header_errors: list[str] = field(default_factory=list)

    @property
    def id(self) -> str:
        return self.header.get("id", "(no id)")

    @property
    def location(self) -> str:
        return f"{self.display}:{self.line}"


# ── Parsing ──────────────────────────────────────────────────────────────────

def parse_header(raw: str) -> tuple[dict[str, str], list[str]]:
    """Flat YAML, one field per line. Returns (fields, errors)."""
    fields: dict[str, str] = {}
    errors: list[str] = []
    for no, line in enumerate(raw.splitlines(), 1):
        if not line.strip():
            continue
        if ":" not in line:
            errors.append(f"header line {no} has no colon: {line.strip()[:60]!r}")
            continue
        key, value = line.split(":", 1)
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] == '"':
            # Double quotes mean YAML escapes must be resolved. Without this,
            # a command like `grep 'a\|b' file` runs as a search for a literal
            # backslash and is guaranteed to find nothing: the verify run
            # would report a correct claim as refuted.
            value = value[1:-1].replace("\\\\", "\\").replace('\\"', '"')
        if key in fields:
            errors.append(f"field {key!r} appears twice in the header")
        fields[key] = value
    return fields, errors


def parse_date(value: str) -> date | None:
    try:
        return datetime.strptime(value, "%Y-%m-%d").date()
    except (ValueError, TypeError):
        return None


def split_list(value: str) -> list[str]:
    return [t.strip() for t in value.split(",") if t.strip()]


# ── File and claim collection ────────────────────────────────────────────────

def area_files(config: Config) -> list[tuple[str, Path, str]]:
    """(area, path, display name) of every file that may carry claims."""
    out: list[tuple[str, Path, str]] = []
    for area in config.areas:
        if not area.root.exists():
            continue
        for pattern in area.files:
            for p in sorted(area.root.glob(pattern)):
                if p.name in config.example_files or not p.is_file():
                    continue
                out.append((area.name, p, f"{area.name}:{p.name}"))
    return out


def read_claims(config: Config) -> list[Claim]:
    """Every claim in every area, with file, line, header and body."""
    found: list[Claim] = []
    for area, path, display in area_files(config):
        content = path.read_text(encoding="utf-8")
        for m in BLOCK_RE.finditer(content):
            header, errors = parse_header(m.group("header"))
            found.append(
                Claim(
                    area=area,
                    path=path,
                    display=display,
                    line=content[: m.start()].count("\n") + 1,
                    header=header,
                    text=m.group("text"),
                    header_errors=errors,
                )
            )
    return found


def collect_adrs(config: Config) -> set[str]:
    """ADR identifiers (ADR-NNNN) found in the configured ADR directories."""
    found: set[str] = set()
    for adr_dir in config.adr_dirs:
        if not adr_dir.is_dir():
            continue
        for p in adr_dir.glob("[0-9][0-9][0-9][0-9]-*.md"):
            found.add(f"ADR-{p.name[:4]}")
    return found


def adr_status(config: Config) -> dict[str, str]:
    """ADR identifier -> normalized status (Accepted, Superseded, ...)."""
    status: dict[str, str] = {}
    for adr_dir in config.adr_dirs:
        if not adr_dir.is_dir():
            continue
        for p in sorted(adr_dir.glob("[0-9][0-9][0-9][0-9]-*.md")):
            head = p.read_text(encoding="utf-8")[:600]
            m = re.search(r"\*{0,2}Status\*{0,2}\s*:\s*(\w+)", head)
            raw = (m.group(1) if m else "unknown").lower()
            status[f"ADR-{p.name[:4]}"] = {
                "accepted": "Accepted",
                "superseded": "Superseded",
                "deprecated": "Superseded",
            }.get(raw, raw)
    return status


# ── Count-like numbers ───────────────────────────────────────────────────────
# Used by the protected-entities check in lint and by the contradiction
# search. One shared filter on purpose: two separate number filters mean every
# insight about identifiers has to be built in twice, and the third time it is
# forgotten once.

NUMBER_RE = re.compile(r"\b\d{1,3}(?:[.,]\d{3})+\b|\b\d{4,}\b")
YEAR_RANGE = range(1990, 2101)
# From here on a number is an identifier (customer, order, tracking number),
# never a count.
IDENTIFIER_MIN = 100_000_000

# What sits left of a number when it is an identifier rather than a count.
# Without this distinction the protected-entities check reports `group_id=57291`,
# `ADR 0031` and board IDs as counts, and a guard that is wrong most of the
# time gets switched off instead of read.
IDENTIFIER_LEFT_RE = re.compile(
    r"(?:id|ids|no|nr|number|adr|board|group|group_id|customer_id|order|"
    r"pipeline|portal|port|list_id|project|sku|vat)"
    r"[\s:=_-]{0,3}[\"'`(\[]?$",
    re.I,
)

# Limits are structure, not quantity. `limit at most 1000` describes the API,
# not the stock; reported as a count it produces noise wherever a page limit
# is documented.
LIMIT_LEFT_RE = re.compile(
    r"(?:limit|max|maximum|at\s+most|cap|ceiling|quota|per\s+page|per\s+minute|"
    r"per\s+second|per\s+day|up\s+to|max_items)"
    r"[\s:=_-]{0,4}[\"'`(\[]?$",
    re.I,
)


def counts_in_line(line: str) -> list[str]:
    """Numbers in one line that plausibly are counts.

    Filtered out: years, identifiers (too long, leading zero, or an
    identifier word right before them) and numbers inside backticks, because
    those are almost always code or a parameter value.
    """
    without_code = re.sub(r"`[^`]*`", " ", line)
    hits: list[str] = []
    for m in NUMBER_RE.finditer(without_code):
        raw = m.group(0)
        if raw.startswith("0"):  # ADR-0031: a leading zero is never a count
            continue
        n = int(re.sub(r"[.,]", "", raw))
        if n in YEAR_RANGE or n >= IDENTIFIER_MIN:
            continue
        left = without_code[max(0, m.start() - 24): m.start()]
        if IDENTIFIER_LEFT_RE.search(left) or LIMIT_LEFT_RE.search(left):
            continue
        # SKU shape: letters, hyphen, number (US-110010). A prefix directly at
        # the hyphen is always an identifier, never a quantity.
        if re.search(r"[A-Za-z]{2,}-$", left):
            continue
        hits.append(raw)
    return hits


def count_value(raw: str) -> int:
    return int(re.sub(r"[.,]", "", raw))
