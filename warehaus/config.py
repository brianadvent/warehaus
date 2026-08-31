"""Configuration loading for warehaus.

A warehaus project is any directory tree with a `warehaus.toml` at its root.
All paths in the config are relative to the directory containing that file.
TOML because `tomllib` ships with the standard library (Python 3.11+); the
whole tool runs without a single third-party dependency.
"""

from __future__ import annotations

import sys
import tomllib
from dataclasses import dataclass, field
from pathlib import Path

CONFIG_NAME = "warehaus.toml"

# Review intervals in days, per claim type. A claim whose `as_of` is older
# than its interval lands on the gap list (non-blocking). Overridable via
# the [intervals] table.
DEFAULT_INTERVALS: dict[str, int] = {
    "structure": 120,
    "access": 90,
    "rule": 365,
    "metric": 90,
    "count": 30,
    "snapshot": 90,
    "experience": 365,
}


class ConfigError(Exception):
    """Raised when the config file is missing or invalid."""


@dataclass
class Area:
    """One place where claim-bearing files live: a root plus file globs."""

    name: str
    root: Path
    files: list[str]


@dataclass
class Config:
    path: Path  # the warehaus.toml file itself
    root: Path  # its directory; working directory for verify commands
    areas: list[Area]
    sots: list[str]
    example_files: set[str] = field(default_factory=set)
    adr_dirs: list[Path] = field(default_factory=list)
    intervals: dict[str, int] = field(default_factory=lambda: dict(DEFAULT_INTERVALS))
    env_file: Path | None = None
    assert_patterns: list[str] = field(default_factory=list)
    verify_timeout: int = 300
    protected_file: Path | None = None
    generator_command: str | None = None
    stand_values: list[dict] = field(default_factory=list)

    # SoT prefix forms that are always allowed in addition to the fixed list.
    SOT_PREFIXES: tuple[str, ...] = ("code:", "adr:", "person:")

    def sot_valid(self, value: str) -> bool:
        if value in self.sots:
            return True
        return any(value.startswith(p) and len(value) > len(p) for p in self.SOT_PREFIXES)


def find_config(start: Path | None = None) -> Path | None:
    """Walk up from `start` (default: cwd) to the filesystem root."""
    here = (start or Path.cwd()).resolve()
    for candidate in [here, *here.parents]:
        p = candidate / CONFIG_NAME
        if p.is_file():
            return p
    return None


def load_config(explicit: str | None = None) -> Config:
    if explicit:
        path = Path(explicit).resolve()
        if path.is_dir():
            path = path / CONFIG_NAME
        if not path.is_file():
            raise ConfigError(f"config file not found: {path}")
    else:
        found = find_config()
        if found is None:
            raise ConfigError(
                f"no {CONFIG_NAME} found in this directory or any parent; "
                "run from inside a warehaus project or pass --config"
            )
        path = found

    try:
        with path.open("rb") as fh:
            raw = tomllib.load(fh)
    except tomllib.TOMLDecodeError as exc:
        raise ConfigError(f"{path}: {exc}") from exc

    root = path.parent

    areas_raw = raw.get("areas")
    if not areas_raw or not isinstance(areas_raw, list):
        raise ConfigError(
            f"{path}: at least one [[areas]] table is required "
            "(name, root, files)"
        )
    areas: list[Area] = []
    for i, a in enumerate(areas_raw):
        try:
            areas.append(
                Area(
                    name=str(a["name"]),
                    root=(root / a["root"]).resolve(),
                    files=[str(g) for g in a["files"]],
                )
            )
        except KeyError as exc:
            raise ConfigError(f"{path}: [[areas]] entry {i + 1} is missing {exc}") from exc

    schema = raw.get("schema", {})
    sots = [str(s) for s in schema.get("sots", [])]
    if not sots:
        raise ConfigError(
            f"{path}: [schema] sots is required; list the source-of-truth "
            "identifiers your claims may reference"
        )

    intervals = dict(DEFAULT_INTERVALS)
    for key, value in raw.get("intervals", {}).items():
        if key not in DEFAULT_INTERVALS:
            raise ConfigError(f"{path}: [intervals] has unknown claim type {key!r}")
        intervals[key] = int(value)

    verify = raw.get("verify", {})
    env_file = verify.get("env_file")
    protected = raw.get("protected", {})
    generator = raw.get("generator", {})
    generator_command = generator.get("command") or None

    # [[stand.values]]: the collectors behind the gen ranges. Kept as plain
    # dicts; `warehaus stand` owns their semantics. The budget vocabulary
    # mirrors claims.BUDGETS (not imported here to avoid a config<->claims
    # cycle).
    stand_values: list[dict] = []
    for i, entry in enumerate(raw.get("stand", {}).get("values", [])):
        if "id" not in entry or "command" not in entry:
            raise ConfigError(
                f"{path}: [[stand.values]] entry {i + 1} needs both id and command"
            )
        budget = str(entry.get("budget", "free"))
        if budget not in {"free", "single_call", "bulk"}:
            raise ConfigError(
                f"{path}: [[stand.values]] {entry['id']!r} has unknown budget {budget!r}"
            )
        stand_values.append(
            {"id": str(entry["id"]), "command": str(entry["command"]), "budget": budget}
        )

    return Config(
        path=path,
        root=root,
        areas=areas,
        sots=sots,
        example_files=set(schema.get("example_files", [])),
        adr_dirs=[(root / d).resolve() for d in raw.get("adr", {}).get("dirs", [])],
        intervals=intervals,
        env_file=(root / env_file).resolve() if env_file else None,
        assert_patterns=[str(p) for p in verify.get("assert_patterns", [])],
        verify_timeout=int(verify.get("timeout", 300)),
        protected_file=(root / protected["file"]).resolve() if protected.get("file") else None,
        generator_command=generator_command,
        stand_values=stand_values,
    )


def die(message: str) -> int:
    print(f"NOT RUNNABLE: {message}", file=sys.stderr)
    return 2
