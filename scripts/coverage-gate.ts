// Aggregate coverage gate over coverage/lcov.info (written by `bun test --coverage`).
//
// Why not bunfig's coverageThreshold: Bun applies it to every file separately, so
// one untested file fails the run whatever the overall number is. The target
// is an overall percentage, so this sums LH/LF (and FNH/FNF) across all files.
//
// The defaults are the thresholds CI enforces. test/all-modules.test.ts loads every
// source module, so these are over all product code, not just what tests touch
// (measured 94.9% lines / 91.0% functions on 2026-09-25).
//
// Usage: bun scripts/coverage-gate.ts [--lines 0.8] [--functions 0.85] [--file coverage/lcov.info]

import { readFileSync } from "node:fs";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const file = arg("file", "coverage/lcov.info");
const minLines = Number(arg("lines", "0.8"));
const minFunctions = Number(arg("functions", "0.85"));

const totals = { LF: 0, LH: 0, FNF: 0, FNH: 0 };
for (const line of readFileSync(file, "utf8").split("\n")) {
  const [key, value] = line.split(":");
  if (key in totals) totals[key as keyof typeof totals] += Number(value);
}

const lines = totals.LF ? totals.LH / totals.LF : 1;
const functions = totals.FNF ? totals.FNH / totals.FNF : 1;
const pct = (n: number) => `${(n * 100).toFixed(2)}%`;

console.log(`lines     ${pct(lines)} (${totals.LH}/${totals.LF}), min ${pct(minLines)}`);
console.log(`functions ${pct(functions)} (${totals.FNH}/${totals.FNF}), min ${pct(minFunctions)}`);

if (lines < minLines || functions < minFunctions) {
  console.error("coverage below threshold");
  process.exit(1);
}
