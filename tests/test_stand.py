"""Tests for `warehaus stand` over the bundled example project.

Deliberately does not import warehaus.cli: stand.run is called directly, so
these tests stay independent of which sibling subcommands exist.
"""

from __future__ import annotations

import argparse
import contextlib
import io
import json
import shutil
import tempfile
import unittest
from pathlib import Path

from warehaus import stand

ROOT = Path(__file__).resolve().parents[1]
EXAMPLE = ROOT / "example"


def run_stand(config: Path, **kw) -> tuple[int, str]:
    args = argparse.Namespace(
        config=str(config),
        only=kw.get("only", ""),
        budget=kw.get("budget", "free"),
        check=kw.get("check", False),
        write=kw.get("write", False),
        format=kw.get("format", "text"),
    )
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = stand.run(args)
    return code, out.getvalue()


class StandOnExample(unittest.TestCase):
    def test_pristine_example_has_no_drift(self):
        code, out = run_stand(EXAMPLE / "warehaus.toml", check=True)
        self.assertEqual(code, 0, out)
        self.assertIn("No drift", out)

    def test_json_speaks_the_generator_contract(self):
        code, out = run_stand(EXAMPLE / "warehaus.toml", format="json")
        self.assertEqual(code, 0, out)
        report = json.loads(out)
        self.assertEqual(sorted(report), ["errors", "skipped", "values"])
        self.assertEqual(report["values"].get("product-catalog-size"), "6", out)
        self.assertEqual(report["errors"], [])


class StandOnTamperedCopy(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="warehaus-stand-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        shutil.copytree(EXAMPLE, self.tmp / "example")
        self.config = self.tmp / "example" / "warehaus.toml"
        self.claims = self.tmp / "example" / "knowledge" / "sources.md"

    def tamper(self):
        content = self.claims.read_text(encoding="utf-8")
        self.claims.write_text(
            content.replace(
                "<!--gen:product-catalog-size-->6<!--/gen-->",
                "<!--gen:product-catalog-size-->999<!--/gen-->",
            ),
            encoding="utf-8",
        )

    def test_hand_edited_range_is_drift(self):
        self.tamper()
        code, out = run_stand(self.config, check=True)
        self.assertEqual(code, 1, out)
        self.assertIn("Drift", out)
        self.assertIn("'999'", out)

    def test_write_repairs_the_range_and_check_goes_green(self):
        self.tamper()
        code, out = run_stand(self.config, write=True)
        self.assertEqual(code, 0, out)
        self.assertIn("1 range(s) updated", out)
        self.assertIn(
            "<!--gen:product-catalog-size-->6<!--/gen-->",
            self.claims.read_text(encoding="utf-8"),
        )
        code, out = run_stand(self.config, check=True)
        self.assertEqual(code, 0, out)


if __name__ == "__main__":
    unittest.main()
