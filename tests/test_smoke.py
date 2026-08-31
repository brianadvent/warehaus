"""End-to-end smoke tests over the bundled example project.

Standard library only, like the tool itself:

    python3 -m unittest discover tests
"""

from __future__ import annotations

import contextlib
import io
import json
import unittest
from pathlib import Path

from warehaus.cli import main

ROOT = Path(__file__).resolve().parents[1]
EXAMPLE = str(ROOT / "example" / "warehaus.toml")
BROKEN = str(ROOT / "tests" / "fixtures" / "broken" / "warehaus.toml")


def run_cli(*argv: str) -> tuple[int, str]:
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        code = main(list(argv))
    return code, out.getvalue()


class LintSmoke(unittest.TestCase):
    def test_example_is_green(self):
        code, out = run_cli("--config", EXAMPLE, "lint")
        self.assertEqual(code, 0, out)

    def test_broken_fixture_is_red(self):
        code, out = run_cli("--config", BROKEN, "lint", "--json")
        self.assertEqual(code, 1, out)
        report = json.loads(out)
        errors = "\n".join(report["errors"])
        for expected in ("Bad_ID", "mystery", "foo", "duplicate-me", "future"):
            self.assertIn(expected, errors, f"missing lint finding: {expected}")


class VerifySmoke(unittest.TestCase):
    def test_example_verify_free_budget(self):
        code, out = run_cli("--config", EXAMPLE, "verify", "--json")
        self.assertEqual(code, 0, out)
        report = json.loads(out)
        # The two grep commands are searches: they prove the referenced spot
        # exists, not that the prose next to it is right. The verdict must be
        # "executed", never "confirmed".
        self.assertEqual(report["summary"].get("executed"), 2, out)
        self.assertNotIn("confirmed", report["summary"], out)


class ContradictionsSmoke(unittest.TestCase):
    def test_example_has_no_conflicts(self):
        code, out = run_cli("--config", EXAMPLE, "contradictions")
        self.assertEqual(code, 0, out)


if __name__ == "__main__":
    unittest.main()
