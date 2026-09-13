/** End-to-end smoke tests over the bundled example project. */

import assert from "node:assert/strict";
import { test } from "node:test";

import { BROKEN, EXAMPLE, runCli } from "./helpers.js";

test("lint: the example project is green", () => {
  const { code, out } = runCli("--config", EXAMPLE, "lint");
  assert.equal(code, 0, out);
});

test("lint: the broken fixture is red with the expected findings", () => {
  const { code, out } = runCli("--config", BROKEN, "lint", "--json");
  assert.equal(code, 1, out);
  const report = JSON.parse(out);
  const errors = report.errors.join("\n");
  for (const expected of ["Bad_ID", "mystery", "foo", "duplicate-me", "future"]) {
    assert.ok(errors.includes(expected), `missing lint finding: ${expected}\n${errors}`);
  }
});

test("verify: grep commands are searches, executed but never confirmed", () => {
  const { code, out } = runCli("--config", EXAMPLE, "verify", "--json");
  assert.equal(code, 0, out);
  const report = JSON.parse(out);
  // The two grep commands prove the referenced spot exists, not that the
  // prose next to it is right. The verdict must be "executed".
  assert.equal(report.summary.executed, 2, out);
  assert.ok(!("confirmed" in report.summary), out);
});

test("contradictions: the example project has no conflicts", () => {
  const { code, out } = runCli("--config", EXAMPLE, "contradictions");
  assert.equal(code, 0, out);
});

test("cli: --version and --help exit 0, a missing command exits 2", () => {
  assert.equal(runCli("--version").code, 0);
  assert.equal(runCli("--help").code, 0);
  assert.equal(runCli("lint", "--help").code, 0);
  assert.equal(runCli().code, 2);
  assert.equal(runCli("lint", "--bogus").code, 2);
});
