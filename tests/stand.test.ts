/** Tests for `warehaus stand` over the bundled example project. */

import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { EXAMPLE, ROOT, runCli } from "./helpers.js";

test("stand --check: the pristine example has no drift", () => {
  const { code, out } = runCli("--config", EXAMPLE, "stand", "--check");
  assert.equal(code, 0, out);
  assert.ok(out.includes("No drift"), out);
});

test("stand --format=json speaks the generator contract", () => {
  const { code, out } = runCli("--config", EXAMPLE, "stand", "--format=json");
  assert.equal(code, 0, out);
  const report = JSON.parse(out);
  assert.deepEqual(Object.keys(report).sort(), ["errors", "skipped", "values"]);
  assert.equal(report.values["product-catalog-size"], "6", out);
  assert.deepEqual(report.errors, []);
});

let tmp: string;
let config: string;
let claims: string;

beforeEach(() => {
  tmp = mkdtempSync(resolve(tmpdir(), "warehaus-stand-"));
  cpSync(resolve(ROOT, "example"), resolve(tmp, "example"), { recursive: true });
  config = resolve(tmp, "example", "warehaus.toml");
  claims = resolve(tmp, "example", "knowledge", "sources.md");
});

afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function tamper(): void {
  const content = readFileSync(claims, "utf-8");
  writeFileSync(
    claims,
    content.replace("<!--gen:product-catalog-size-->6<!--/gen-->", "<!--gen:product-catalog-size-->999<!--/gen-->"),
  );
}

test("stand --check: a hand-edited range is drift", () => {
  tamper();
  const { code, out } = runCli("--config", config, "stand", "--check");
  assert.equal(code, 1, out);
  assert.ok(out.includes("Drift"), out);
  assert.ok(out.includes("'999'"), out);
});

test("stand --write repairs the range and --check goes green", () => {
  tamper();
  const first = runCli("--config", config, "stand", "--write");
  assert.equal(first.code, 0, first.out);
  assert.ok(first.out.includes("1 range(s) updated"), first.out);
  assert.ok(readFileSync(claims, "utf-8").includes("<!--gen:product-catalog-size-->6<!--/gen-->"));
  const second = runCli("--config", config, "stand", "--check");
  assert.equal(second.code, 0, second.out);
});
