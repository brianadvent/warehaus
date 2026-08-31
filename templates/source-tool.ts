#!/usr/bin/env -S npx tsx
/**
 * Template for a warehaus source tool. Copy it next to a vendored lib/
 * directory, rename it after your source, and replace the fictional
 * billing API with the real one.
 *
 * The conventions this template enforces:
 * - `--help` is the authoritative documentation of the tool.
 * - Common flags on every tool: --limit, --format=json|table|csv.
 * - Read-only by default. A tool that writes says so in its name and help.
 * - The rate limiter sits below the documented maximum (see
 *   lib/rate-limiter.ts for the tuning rule).
 * - Secrets come from .env via requireEnv and are never printed.
 */

import { loadEnv, requireEnv } from "../lib/env.ts";
import { WindowLimiter } from "../lib/rate-limiter.ts";
import { paginatePages } from "../lib/paginator.ts";
import { formatOutput, parseArgs, parseFormat } from "../lib/formatter.ts";

const HELP = `billing.ts - read access to the billing API

Usage:
  npx tsx billing.ts invoices [--limit=N] [--format=json|table|csv]
  npx tsx billing.ts count

Subcommands:
  invoices   list invoices, newest first
  count      total number of invoices

Read-only. Amounts are integer cents (see the structure claim
billing-amounts-in-cents).`;

const BASE = "https://api.example-billing.test/v1";
// Documented: 60 requests per minute. 57 leaves slots for retries.
const limiter = new WindowLimiter(57, 60_000);

loadEnv();
const args = parseArgs(process.argv.slice(2));
const format = parseFormat(args.format);

async function api(path: string): Promise<any> {
  await limiter.acquire();
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${requireEnv("BILLING_API_KEY")}` },
  });
  if (!res.ok) {
    // Keep error classes distinguishable: a 401 is the key, a 403 is the
    // scope, a 404 is the path. Collapsing them costs the next debugging
    // session an hour.
    throw new Error(`${res.status} ${res.statusText} on ${path}`);
  }
  return res.json();
}

async function invoices(limit: number) {
  const { items } = await paginatePages(
    async (page) => {
      const data = await api(`/invoices?page=${page}&limit=100`);
      return { items: data.items, pages: data.pages, total: data.total };
    },
    { maxItems: limit },
  );
  return items.map((inv: any) => ({
    id: inv.id,
    date: inv.document_date,
    gross_cents: inv.total_gross_cents,
    cancelled: Boolean(inv.cancel_id),
  }));
}

async function main() {
  const cmd = args._0;
  if (!cmd || args.help === "true") {
    console.log(HELP);
    return;
  }
  const limit = Number(args.limit ?? 100);

  switch (cmd) {
    case "invoices":
      console.log(formatOutput(await invoices(limit), format));
      break;
    case "count": {
      const data = await api("/invoices?page=1&limit=1");
      console.log(formatOutput([{ total: data.total }], format));
      break;
    }
    default:
      console.error(`Unknown subcommand ${cmd}. See --help.`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
