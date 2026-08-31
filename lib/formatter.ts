/**
 * Output formatting for source tools: one function, three formats, so every
 * tool supports --format=json|table|csv without reinventing it.
 */

export type Format = "json" | "table" | "csv";

export function formatOutput(data: Record<string, unknown>[], format: Format): string {
  if (data.length === 0) return format === "json" ? "[]" : "(no data)";

  switch (format) {
    case "json":
      return JSON.stringify(data, null, 2);
    case "table":
      return formatTable(data);
    case "csv":
      return formatCsv(data);
  }
}

function formatTable(data: Record<string, unknown>[]): string {
  const keys = Object.keys(data[0]);
  const widths = keys.map((k) =>
    Math.max(k.length, ...data.map((r) => String(r[k] ?? "").length)),
  );
  const maxWidth = 40;
  const cappedWidths = widths.map((w) => Math.min(w, maxWidth));

  const header = keys.map((k, i) => k.padEnd(cappedWidths[i])).join(" | ");
  const separator = cappedWidths.map((w) => "-".repeat(w)).join("-+-");
  const rows = data.map((row) =>
    keys
      .map((k, i) => {
        const val = String(row[k] ?? "");
        return val.length > maxWidth ? val.slice(0, maxWidth - 1) + "…" : val.padEnd(cappedWidths[i]);
      })
      .join(" | "),
  );

  return [header, separator, ...rows].join("\n");
}

function formatCsv(data: Record<string, unknown>[]): string {
  const keys = Object.keys(data[0]);
  const escapeCsv = (v: unknown): string => {
    const s = String(v ?? "");
    return s.includes(",") || s.includes('"') || s.includes("\n")
      ? `"${s.replace(/"/g, '""')}"`
      : s;
  };
  const header = keys.map(escapeCsv).join(",");
  const rows = data.map((row) => keys.map((k) => escapeCsv(row[k])).join(","));
  return [header, ...rows].join("\n");
}

export function parseFormat(arg?: string): Format {
  if (arg === "table" || arg === "csv" || arg === "json") return arg;
  return "json";
}

/**
 * Parse CLI arguments into a simple key-value map.
 * Supports: --key=value, --key value, --flag (boolean true)
 */
export function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const eqIdx = arg.indexOf("=");
      if (eqIdx > 0) {
        args[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
      } else {
        const next = argv[i + 1];
        if (next && !next.startsWith("--")) {
          args[arg.slice(2)] = next;
          i++;
        } else {
          args[arg.slice(2)] = "true";
        }
      }
    } else if (!argv[i - 1]?.startsWith("--")) {
      // Positional argument, stored as _0, _1, ...
      const posIdx = Object.keys(args).filter((k) => k.startsWith("_")).length;
      args[`_${posIdx}`] = arg;
    }
  }
  return args;
}
