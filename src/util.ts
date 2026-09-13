/**
 * Small helpers shared by the subcommands: Python-style repr for messages,
 * calendar dates without a time zone, a file glob, and a synchronous shell
 * runner with a timeout.
 */

import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// ── repr ─────────────────────────────────────────────────────────────────────

/** `'text'` for strings, `None` for null, the value otherwise. */
export function repr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "string") return `'${value}'`;
  return String(value);
}

/** 1234567 -> "1,234,567" */
export function withCommas(n: number): string {
  return n.toLocaleString("en-US");
}

// ── dates ────────────────────────────────────────────────────────────────────

/** A calendar date as days since the epoch; comparisons are plain integers. */
export type Day = number;

const MS_PER_DAY = 86_400_000;

export function parseDate(value: string | undefined): Day | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [y, m, d] = value.split("-").map(Number);
  const ms = Date.UTC(y, m - 1, d);
  const probe = new Date(ms);
  // Reject 2026-02-30 and friends: Date.UTC silently rolls them over.
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    return null;
  }
  return ms / MS_PER_DAY;
}

export function today(): Day {
  const now = new Date();
  return Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / MS_PER_DAY;
}

export function isoDate(day: Day): string {
  return new Date(day * MS_PER_DAY).toISOString().slice(0, 10);
}

// ── glob ─────────────────────────────────────────────────────────────────────

function segmentToRegex(segment: string): RegExp {
  let re = "^";
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (ch === "*") re += "[^/]*";
    else if (ch === "?") re += "[^/]";
    else if (ch === "[") {
      const close = segment.indexOf("]", i + 1);
      if (close === -1) {
        re += "\\[";
      } else {
        re += "[" + segment.slice(i + 1, close).replace(/\\/g, "\\\\") + "]";
        i = close;
      }
    } else re += ch.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  return new RegExp(re + "$");
}

/**
 * Files under `root` matching a relative glob pattern (`*`, `?`, `[...]`,
 * `**`), sorted by path. Directories are never returned.
 */
export function glob(root: string, pattern: string): string[] {
  const segments = pattern.split("/").filter(Boolean);
  const results: string[] = [];

  function walk(dir: string, index: number): void {
    if (index === segments.length) return;
    const segment = segments[index];
    const last = index === segments.length - 1;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    if (segment === "**") {
      // Zero or more directories.
      walk(dir, index + 1);
      for (const name of entries) {
        const full = join(dir, name);
        if (isDir(full)) walk(full, index);
      }
      return;
    }
    const re = segmentToRegex(segment);
    for (const name of entries) {
      if (!re.test(name)) continue;
      const full = join(dir, name);
      if (last) {
        if (!isDir(full)) results.push(full);
      } else if (isDir(full)) {
        walk(full, index + 1);
      }
    }
  }

  walk(root, 0);
  return results.sort();
}

export function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

// ── shell ────────────────────────────────────────────────────────────────────

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Run a shell command synchronously; `timeoutSeconds` bounds the wall clock. */
export function runShell(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutSeconds: number,
): RunResult {
  const res = spawnSync(command, {
    shell: true,
    cwd,
    env,
    encoding: "utf-8",
    timeout: timeoutSeconds * 1000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const timedOut = res.error !== undefined && (res.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
  return {
    code: res.status ?? (timedOut ? -1 : 1),
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    timedOut,
  };
}

/** Python's `" ".join(text.split())`. */
export function normalized(text: string): string {
  return text.split(/\s+/).filter(Boolean).join(" ");
}

export function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

export function countLines(text: string, upto: number): number {
  let n = 1;
  for (let i = 0; i < upto; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}
