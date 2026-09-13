/**
 * Output channel for every subcommand.
 *
 * All printing goes through `out` and `err` so tests can capture it and
 * `stand --format=json` can route its progress lines to stderr while stdout
 * carries exclusively the JSON document.
 */

export interface Output {
  out(line: string): void;
  err(line: string): void;
}

let current: Output = {
  out: (line) => process.stdout.write(line + "\n"),
  err: (line) => process.stderr.write(line + "\n"),
};

export function setOutput(output: Output): void {
  current = output;
}

export function out(line = ""): void {
  current.out(line);
}

export function err(line = ""): void {
  current.err(line);
}
