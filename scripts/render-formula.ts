#!/usr/bin/env bun
/**
 * Renders the Homebrew formula for a release from packaging/homebrew/amc.rb.tmpl and the
 * release's SHA256SUMS (the `sha256sum` output the release workflow writes next to the
 * tarballs).
 *
 *   bun scripts/render-formula.ts --version 0.1.0 --sums dist/release/SHA256SUMS [--out amc.rb]
 *
 * Fails if any of the four platform tarballs is missing from SHA256SUMS, so a formula can
 * never point one platform at a stale or absent asset.
 */
import fs from "node:fs";
import path from "node:path";

export const PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"] as const;

export const DEFAULT_REPO = "dannyhawkins/agent-mission-control";
export const TEMPLATE = path.resolve(import.meta.dir, "../packaging/homebrew/amc.rb.tmpl");

export function tarballName(version: string, platform: string): string {
  return `amc-${version}-${platform}.tar.gz`;
}

/** Parses `sha256sum` output ("<hex>  <file>", or "<hex> *<file>" in binary mode) into file -> hash. */
export function parseSums(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const [, sha, file] = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line) ?? [];
    if (!sha || !file) throw new Error(`unreadable SHA256SUMS line: ${line}`);
    out[path.basename(file)] = sha.toLowerCase();
  }
  return out;
}

export function renderFormula(
  template: string,
  opts: { version: string; sums: Record<string, string>; repo?: string },
): string {
  const version = opts.version.replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`not a semver version: ${opts.version}`);
  }
  const vars: Record<string, string> = { VERSION: version, REPO: opts.repo ?? DEFAULT_REPO };
  for (const p of PLATFORMS) {
    const file = tarballName(version, p);
    const sha = opts.sums[file];
    if (!sha) throw new Error(`SHA256SUMS has no entry for ${file}`);
    vars[`SHA256_${p.replace("-", "_").toUpperCase()}`] = sha;
  }
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (whole, key: string) => {
    const value = vars[key];
    if (value === undefined) throw new Error(`template placeholder with no value: ${whole}`);
    return value;
  });
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const val = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const version = val("--version");
  const sumsFile = val("--sums");
  if (!version || !sumsFile) {
    console.error(
      "usage: bun scripts/render-formula.ts --version X.Y.Z --sums SHA256SUMS [--repo owner/name] [--out file]",
    );
    process.exit(2);
  }
  const formula = renderFormula(fs.readFileSync(TEMPLATE, "utf8"), {
    version,
    sums: parseSums(fs.readFileSync(sumsFile, "utf8")),
    repo: val("--repo"),
  });
  const out = val("--out");
  if (out) fs.writeFileSync(out, formula);
  else process.stdout.write(formula);
}
