import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { main } from "../src/cli.js";
import { setOutput } from "../src/output.js";

// dist/tests/helpers.js -> repository root
export const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
export const EXAMPLE = resolve(ROOT, "example", "warehaus.toml");
export const BROKEN = resolve(ROOT, "tests", "fixtures", "broken", "warehaus.toml");

/** Run the CLI in-process and capture stdout. */
export function runCli(...argv: string[]): { code: number; out: string; err: string } {
  const out: string[] = [];
  const err: string[] = [];
  setOutput({ out: (l) => out.push(l), err: (l) => err.push(l) });
  try {
    const code = main(argv);
    return { code, out: out.join("\n") + "\n", err: err.join("\n") };
  } finally {
    setOutput({
      out: (l) => process.stdout.write(l + "\n"),
      err: (l) => process.stderr.write(l + "\n"),
    });
  }
}
