"""The warehaus command line: one entry point, one subcommand per check.

    warehaus init             scaffold a new project
    warehaus lint             form, IDs, required fields, reference chains
    warehaus verify           run the verify_cmd of each claim
    warehaus contradictions   the same number twice, dead ADR references, duplicates
    warehaus stand            generated counts: collect, check for drift, write

Exit convention shared by all subcommands: 0 green, 1 red, 2 not runnable.
"""

from __future__ import annotations

import argparse

from . import __version__, contradictions, init, lint, stand, verify


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="warehaus",
        description="Curated, verifiable knowledge for AI agents over live source systems.",
    )
    parser.add_argument("--version", action="version", version=f"warehaus {__version__}")
    parser.add_argument(
        "--config",
        default=None,
        help="path to warehaus.toml (default: nearest one in this or a parent directory)",
    )
    sub = parser.add_subparsers(dest="command", required=True)
    for module in (init, lint, verify, contradictions, stand):
        module.register(sub)
    args = parser.parse_args(argv)
    return args.func(args)
