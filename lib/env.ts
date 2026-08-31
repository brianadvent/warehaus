/**
 * Load environment variables from a .env file.
 *
 * Values already present in the process environment win; the file only
 * fills gaps. Tools load their secrets themselves so they work when called
 * directly, from an agent, or from a verify command.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

let loaded = false;

export function loadEnv(envPath?: string): void {
  if (loaded) return;
  loaded = true;

  const path = envPath ?? resolve(process.cwd(), ".env");
  try {
    const content = readFileSync(path, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx <= 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch {
    // A missing .env is fine when the environment is already populated
    // (CI, managed settings). requireEnv reports what is actually missing.
  }
}

export function requireEnv(key: string, envPath?: string): string {
  loadEnv(envPath);
  const value = process.env[key];
  if (!value) {
    console.error(`Error: missing environment variable ${key}. Check your .env file.`);
    process.exit(1);
  }
  return value;
}
