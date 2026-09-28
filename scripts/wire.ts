#!/usr/bin/env bun
/**
 * The pre-amc wiring command, kept so `task wire*` and old muscle memory still
 * work from a checkout. It translates to `amc wire` / `amc unwire` (see
 * apps/cli): without --write it is a dry run, --unwire removes. From a checkout
 * the MCP server is wired as `bun <checkout>/apps/cli/src/main.ts mcp`; the amc
 * binary wires itself instead.
 *
 *   bun scripts/wire.ts [dir] [--write] [--local] [--gate | --gate-questions-only] [--telemetry] [--force]
 *   bun scripts/wire.ts [dir] --unwire
 *   bun scripts/wire.ts --global --write [--gate | --gate-questions-only] [--snippet] [--telemetry]
 *   bun scripts/wire.ts --global --unwire
 */
import { main } from "../apps/cli/src/main";

export function translate(argv: string[]): string[] {
  const rest = argv.filter((a) => a !== "--write" && a !== "--unwire");
  if (argv.includes("--unwire")) {
    // unwire takes no mode flags (it removes whatever wire added), only --global and --home.
    const out = ["unwire"];
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i] as string;
      if (a === "--home") out.push(a, rest[++i] ?? "");
      else if (a === "--port" || a === "--gate-matcher") i++;
      else if (a === "--global" || a.startsWith("--home=") || !a.startsWith("--")) out.push(a);
    }
    return out;
  }
  return ["wire", ...rest, ...(argv.includes("--write") ? [] : ["--dry-run"])];
}

if (import.meta.main) process.exit(await main(translate(process.argv.slice(2))));
